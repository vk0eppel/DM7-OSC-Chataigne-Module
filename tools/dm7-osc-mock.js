#!/usr/bin/env node
/*
 * dm7-osc-mock.js — a bench mock of the Yamaha DM7 YOSC server.
 *
 * Purpose: exercise the DM7-OSC Chataigne module's full feedback / scene / push
 * loop WITHOUT a real desk, and validate the UDP-proxy fallback. It answers like
 * the firmware does, so "Refresh All Feedback Values", scene query, subscribe and
 * keepalive can all be driven on the bench.
 *
 * Provenance — every reply shape here comes from static RE of firmware V1.75
 * (app_console_main), documented in:
 *   - YamDeskEmu/firmware/rcp/dm7_yosc.txt         (command set + address formats)
 *   - Yamaha-RCP-Chataigne-Module/docs/dm7-rcp-parameters.md  ("YOSC" section)
 *   - YamDeskEmu/firmware/rcp/README.md            (reply schema, Res/Mem pair)
 * Confirmed prefixes: /yosc:ok/get, /yosc:notify/set, /yosc:okm/set,
 * /yosc:ok/keepalive, /yosc:error. Replies are wrapped in an OSC #bundle.
 *
 * Dependency-free (Node dgram + a tiny inline OSC codec). Run:
 *   node tools/dm7-osc-mock.js
 *
 * Behaviour flags (env vars):
 *   PORT=49900              listen port (the console's "For Mixer Control" port)
 *   REPLY_TO_FIXED=0        0 (default) = reply to the request's SOURCE port, exactly
 *                           like the desk (reproduces the delivery blocker — replies
 *                           land on Chataigne's ephemeral out-port, not its listener).
 *                           Set 1 to reply to PORT instead (simulate a fixed-port desk)
 *                           so you can A/B the delivery fix.
 *   RES_MEM_PAIR=0          0 (default) = get reply carries ONE value arg (what the
 *                           module parses today). Set 1 to send the firmware's
 *                           Res(live)+Mem(scene-stored) PAIR, to test whether the
 *                           module's parser grabs the right slot (README: replies
 *                           carry a Res+Mem pair per (x,y)).
 *   WRAP_BUNDLE=1           1 (default) = wrap replies in #bundle (faithful; tests the
 *                           module's reliance on bundle-unpacking). 0 = bare messages.
 *
 * Simulate a desk-side change (pushes /yosc:notify/set to current subscribers) —
 * type on stdin:  push MIXER:Current/InCh/Fader/Level/1 -1000
 * List subscribers:  subs        Quit:  Ctrl-C
 */

'use strict';
const dgram = require('dgram');

const PORT = parseInt(process.env.PORT || '49900', 10);
const REPLY_TO_FIXED = process.env.REPLY_TO_FIXED === '1';
const RES_MEM_PAIR = process.env.RES_MEM_PAIR === '1';
const WRAP_BUNDLE = process.env.WRAP_BUNDLE !== '0';

// ---------------------------------------------------------------------------
// Minimal OSC codec (int32 'i', float32 'f', string 's'; bundles on decode).
// ---------------------------------------------------------------------------
function pad4(n) { return (n + 3) & ~3; }

function encStr(s) {
  const raw = Buffer.from(s, 'binary');
  const buf = Buffer.alloc(pad4(raw.length + 1)); // +1 for the null, then pad
  raw.copy(buf);
  return buf;
}

// args: array of {type:'i'|'f'|'s', value}
function encMessage(address, args) {
  const parts = [encStr(address)];
  let tags = ',';
  for (const a of args) tags += a.type;
  parts.push(encStr(tags));
  for (const a of args) {
    if (a.type === 'i') { const b = Buffer.alloc(4); b.writeInt32BE(a.value | 0); parts.push(b); }
    else if (a.type === 'f') { const b = Buffer.alloc(4); b.writeFloatBE(a.value); parts.push(b); }
    else parts.push(encStr(String(a.value)));
  }
  return Buffer.concat(parts);
}

function encBundle(messages) {
  const parts = [encStr('#bundle')];
  const tt = Buffer.alloc(8); tt.writeUInt32BE(0, 0); tt.writeUInt32BE(1, 4); // "immediately"
  parts.push(tt);
  for (const m of messages) {
    const sz = Buffer.alloc(4); sz.writeInt32BE(m.length);
    parts.push(sz, m);
  }
  return Buffer.concat(parts);
}

function readStr(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  const s = buf.toString('binary', off, end);
  return { s, next: pad4(end + 1 - off) + off };
}

// Returns array of {address, args:[values]} (flattening any bundles).
function decode(buf, off, len, out) {
  off = off || 0; len = len == null ? buf.length : len; out = out || [];
  if (buf.toString('binary', off, off + 7) === '#bundle') {
    let p = off + 16; // skip "#bundle\0" (8) + timetag (8)
    const end = off + len;
    while (p + 4 <= end) {
      const sz = buf.readInt32BE(p); p += 4;
      if (sz <= 0 || p + sz > end) break;
      decode(buf, p, sz, out); p += sz;
    }
    return out;
  }
  const a = readStr(buf, off);
  const address = a.s;
  let p = a.next;
  if (p >= off + len || buf.toString('binary', p, p + 1) !== ',') { out.push({ address, args: [] }); return out; }
  const t = readStr(buf, p);
  const tags = t.s.slice(1); p = t.next;
  const args = [];
  for (const tag of tags) {
    if (tag === 'i') { args.push(buf.readInt32BE(p)); p += 4; }
    else if (tag === 'f') { args.push(buf.readFloatBE(p)); p += 4; }
    else if (tag === 's') { const r = readStr(buf, p); args.push(r.s); p = r.next; }
    else if (tag === 'T') { args.push(true); } else if (tag === 'F') { args.push(false); }
    else break; // unknown tag: bail
  }
  out.push({ address, args });
  return out;
}

// ---------------------------------------------------------------------------
// Desk state + type inference (mirrors the module's SPEC, keyed by ParamID tail).
// ---------------------------------------------------------------------------
const store = {}; // "ParamID/X[/Y]" -> raw value
const scenes = { scene_a: { num: '1.00', name: 'Opening' }, scene_b: { num: '1.00', name: 'Opening' } };
const subs = new Map(); // "ip:port" -> {addr, port, patterns:Set}

function inferType(pid) {
  if (pid.indexOf('/Label/Name') >= 0) return 'name';
  if (pid.indexOf('/Label/Color') >= 0) return 'color';
  if (pid.indexOf('/HA/Gain') >= 0) return 'hagain';
  if (pid.indexOf('Pan') >= 0) return 'pan';
  if (pid.indexOf('/On') >= 0) return 'on';
  if (pid.indexOf('Level') >= 0) return 'level';
  return 'name';
}

function defaultRaw(type, xToken) {
  if (type === 'level') return 0;      // 0 dB -> dBx100 = 0
  if (type === 'on') return 1;
  if (type === 'pan') return 0;
  if (type === 'hagain') return 0;
  if (type === 'color') return 'Blue';
  return 'Ch' + xToken;
}

// Split "MIXER:Current/InCh/Fader/Level/61" -> {pid, tail:"61", xToken:"61"}.
function splitPidIndices(rest) {
  const toks = rest.split('/');
  let end = toks.length - 1;
  while (end >= 0 && /^-?\d+$/.test(toks[end])) end--;
  const pid = toks.slice(0, end + 1).join('/');
  const idx = toks.slice(end + 1).join('/');
  return { pid, idx, xToken: toks[end + 1] || '' };
}

function argFor(type, raw) {
  if (type === 'name' || type === 'color') return { type: 's', value: String(raw) };
  return { type: 'i', value: parseInt(raw, 10) || 0 };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const sock = dgram.createSocket('udp4');

function reply(messages, rinfo) {
  if (!messages.length) return;
  const packet = WRAP_BUNDLE ? encBundle(messages) : messages[0];
  const port = REPLY_TO_FIXED ? PORT : rinfo.port;
  sock.send(packet, port, rinfo.address, () => {});
  for (const m of messages) {
    const d = decode(m)[0];
    console.log(`  -> ${rinfo.address}:${port}  ${d.address}  [${d.args.join(', ')}]`);
  }
}

function handleGet(rest, rinfo) {
  const { pid, idx, xToken } = splitPidIndices(rest);
  const type = inferType(pid);
  const key = pid + '/' + idx;
  const raw = (key in store) ? store[key] : defaultRaw(type, xToken);
  const args = [argFor(type, raw)];
  if (RES_MEM_PAIR) args.push(argFor(type, raw)); // Res (live) + Mem (scene-stored)
  return encMessage('/yosc:ok/get/' + rest, args);
}

function handleSet(rest, args) {
  const { pid, idx } = splitPidIndices(rest);
  store[pid + '/' + idx] = args.length ? args[0] : 0;
  // Real desk pushes /yosc:notify/set to OTHER subscribers, not the originator.
  return null;
}

function pushNotify(rest, originKey) {
  const { pid, idx } = splitPidIndices(rest);
  const type = inferType(pid);
  const raw = store[pid + '/' + idx];
  const msg = encMessage('/yosc:notify/set/' + rest, [argFor(type, raw)]);
  for (const [k, s] of subs) {
    if (k === originKey) continue;
    sock.send(WRAP_BUNDLE ? encBundle([msg]) : msg, s.port, s.addr, () => {});
    console.log(`  ~> notify ${s.addr}:${s.port}  /yosc:notify/set/${rest}  [${raw}]`);
  }
}

sock.on('message', (buf, rinfo) => {
  const msgs = decode(buf);
  const key = rinfo.address + ':' + rinfo.port;
  for (const { address, args } of msgs) {
    console.log(`<- ${key}  ${address}  [${args.join(', ')}]`);
    const out = [];

    if (address.indexOf('/yosc:req/keepalive') === 0) {
      out.push(encMessage('/yosc:ok/keepalive', []));
    } else if (address.indexOf('/yosc:req/get/') === 0) {
      out.push(handleGet(address.slice('/yosc:req/get/'.length), rinfo));
    } else if (address.indexOf('/yosc:req/set/') === 0) {
      handleSet(address.slice('/yosc:req/set/'.length), args);
      // (no sender reply; desk applies silently. okm/set is the multi-client echo.)
    } else if (address.indexOf('/yosc:req/subscribe/') === 0) {
      const patt = address.slice('/yosc:req/subscribe/'.length);
      if (!subs.has(key)) subs.set(key, { addr: rinfo.address, port: rinfo.port, patterns: new Set() });
      subs.get(key).patterns.add(patt);
      // NB per firmware RE: real desk only accepts ts:-prefixed subscribe targets.
      if (patt.indexOf('ts:') !== 0 && patt.indexOf('MIXER:') === 0) {
        console.log(`     (!) MIXER: subscribe — a real DM7 likely rejects this; use ts:… )`);
      }
    } else if (address.indexOf('/yosc:req/unsubscribe/') === 0) {
      subs.delete(key);
    } else if (address.indexOf('sscurrentt_ex') >= 0) {
      const list = args[0] || 'scene_a';
      out.push(encMessage('/yosc:ok/sscurrentt_ex', [
        { type: 's', value: list }, { type: 's', value: (scenes[list] || scenes.scene_a).num }]));
    } else if (address.indexOf('ssinfot_ex') >= 0) {
      const list = args[0] || 'scene_a';
      const sc = scenes[list] || scenes.scene_a;
      out.push(encMessage('/yosc:ok/ssinfot_ex', [
        { type: 's', value: list }, { type: 's', value: sc.num }, { type: 's', value: sc.name }]));
    } else if (address.indexOf('ssrecallt_ex') >= 0) {
      const list = args[0] || 'scene_a';
      if (scenes[list] && args[1] != null) scenes[list].num = String(args[1]);
      // desk would then push sscurrent notify; module re-queries, so nothing needed.
    } else if (address.indexOf('/yosc:req/event') === 0) {
      // scene inc/dec: args = [ "MIXER:Lib/Scene/RecallInc", "scene_a" ]
      const list = args[1] || 'scene_a';
      const inc = String(args[0] || '').indexOf('RecallInc') >= 0 ? 1 : -1;
      if (scenes[list]) {
        const n = Math.max(0, Math.round(parseFloat(scenes[list].num) * 100) + inc * 100);
        scenes[list].num = (Math.floor(n / 100)) + '.' + String(n % 100).padStart(2, '0');
      }
    } else {
      out.push(encMessage('/yosc:error/', [{ type: 's', value: 'Unknown ' + address }]));
    }
    reply(out.filter(Boolean), rinfo);
  }
});

sock.on('listening', () => {
  const a = sock.address();
  console.log(`DM7 OSC mock listening on ${a.address}:${a.port}`);
  console.log(`  REPLY_TO_FIXED=${REPLY_TO_FIXED ? 1 : 0}  RES_MEM_PAIR=${RES_MEM_PAIR ? 1 : 0}  WRAP_BUNDLE=${WRAP_BUNDLE ? 1 : 0}`);
  console.log(`  (REPLY_TO_FIXED=0 reproduces the real desk's reply-to-source-port blocker.)`);
  console.log(`  stdin: "push <ParamID/X> <value>" to simulate a desk change; "subs" to list.`);
});

sock.bind(PORT);

// --- stdin: simulate desk-side changes / inspect subscribers ----------------
process.stdin.setEncoding('utf8');
process.stdin.on('data', (line) => {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === 'push' && parts.length >= 3) {
    const rest = parts[1];
    const { pid, idx } = splitPidIndices(rest);
    let val = parts.slice(2).join(' ');
    if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
    store[pid + '/' + idx] = val;
    pushNotify(rest, null);
  } else if (parts[0] === 'subs') {
    if (!subs.size) console.log('  (no subscribers)');
    for (const [k, s] of subs) console.log(`  ${k} -> ${[...s.patterns].join(', ')}`);
  } else if (parts[0]) {
    console.log('  usage: push <ParamID/X> <value>   |   subs');
  }
});
