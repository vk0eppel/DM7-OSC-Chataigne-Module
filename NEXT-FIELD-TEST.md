# Next Field-Test Day — TODO

Covers **both** modules (DM7-OSC over YOSC/49900, Yamaha-RCP over TCP/49280).
Built from the 2026-09-02 CL5 + DM7 session; current as of 2026-09-13. Most code
fixes from that day are still **unverified on hardware** — this day is mostly
*confirm the fixes live* plus two real blockers. Each item is **Do → Record**.

**One change since last session:** commit `b3bbb3c` (2026-09-03) fixed the OSC
**output default** — it used the flat `oscOutput` key Chataigne ignores, so a fresh
add silently fell back to remote port **9000** and dropped `remoteHost`. It now uses
the `OSC Outputs > OSC Output` nesting, so console IP + **remote port 49900** apply
on re-add. This fixes the *destination* only; the 49900 **source-port** blocker
(Priority 1) is unchanged.

## 0. Prep (do first, every session)

> **Bench first, desk second.** Before the field day, run the mock desk
> (`node tools/dm7-osc-mock.js`) — a dependency-free DM7 YOSC responder built from
> the firmware RE grammar. It answers `get`/scene/keepalive/subscribe with the real
> reply prefixes and `#bundle` wrapping, and by default **replies to the request's
> source port**, reproducing the Priority-1 delivery blocker — so you can validate
> the UDP-proxy fallback on the bench. Flags: `REPLY_TO_FIXED=1` (simulate a
> fixed-port desk), `RES_MEM_PAIR=1` (test the Res/Mem parse), and stdin
> `push <ParamID/X> <value>` to simulate a desk-side change to subscribers.


- [ ] **Load both modules FRESH** — remove from the project and re-add, do NOT
      just reload. `module.json` command/param changes only apply on re-add.
      (This bit us repeatedly last time: a new/edited command sends *nothing* until
      the module is re-added.)
- [ ] Wireshark rolling, **filter by console IP** (`ip.addr == <desk>`) so replies
      on unexpected ports are captured. Save one file per topic.
- [ ] RCP module: open the **`Script : Yam-RCP` console pane** (not just the
      transport logger) — that's where script output/errors show. Keep `DEBUG=false`
      unless chasing something.
- [ ] DM7-OSC module: **Log Unhandled Incoming = on**.
- [ ] DM7-OSC module: after the fresh re-add, **verify the OSC Output pane** shows
      the console IP and **remote port 49900** — NOT the old `9000` fallback. (This
      is the `b3bbb3c` default fix; if it still reads 9000, the module.json edit
      didn't apply → you didn't fully remove+re-add.)

---

## Priority 1 — DM7 OSC feedback BLOCKER (the big unlock)

The DM7 replies to the request's **UDP source port** (ephemeral, e.g. 49626), but
Chataigne's OSC input listens on 49900 — so no reply is ever received. Feedback
(values, scene query, push) is fully blocked until this is solved.

*Narrowed since last session:* `b3bbb3c` fixed the **destination** (remote port is
now 49900, not the 9000 fallback). The remaining blocker is purely the **source
(local) port** of the output socket — Chataigne auto-assigns it, so replies still
land on an ephemeral port the listener never sees.

**Firmware RE verdict — this is a CLIENT-side problem, not a desk-side one. Do NOT
spend field time hunting for a reply-port option on the DM7.** Static RE of firmware
V1.75 (`YamDeskEmu/firmware/`) shows the YOSC grammar carries **no reply-port field**
in any handshake — subscribe/keepalive/identify/devinfo formats hold only a session
token `%s` (`firmware/rcp/dm7_yosc.txt`), and the decomp has no `sockaddr`/`sin_port`/
`sendto` override. Replying to the request's source port is standard UDP behaviour;
there is no hidden "send notifies to port X" mode to enable. The fix must be made on
Chataigne's side.

**Chataigne can't bind one socket for both send+receive — proxy is THE path, not a
fallback.** Confirmed 2026-09-13 by inspecting installed community modules + JUCE:
- The QLab "OSC Advanced" module (the one with the "input port" field) is a plain
  `type:OSC` module — its "input port" is just the standard **OSC Input localPort**,
  the same thing we set to 49900. It gets feedback because **QLab targets a fixed
  reply port (53001)**, not because of that field. Every feedback-capable community
  module works this way: QLab, grandMA3, Reaper, M32, L-ISA all make the **device
  send to a configured local port** (L-ISA literally sends `/ext/device/N/register
  ip port`). The DM7 has no such register/target — it replies to source.
- The `local` checkbox and `listenToFeedback` OSC-Output options are **not** a
  source-port bind (L-ISA uses `local:true` but still registers a port; QLab uses
  `local:false`). Binding send+receive to one socket needs `SO_REUSEADDR`, which
  **JUCE's OSC API does not expose** — so no Chataigne build has this knob.
  → A 2-min sanity check of the OSC Output options is fine, but expect nothing.

- [ ] **UDP relay/proxy (the fix).** One small process (Node/Python) owns a single
      socket bound to `:49900`: it forwards Chataigne's outgoing OSC to `desk:49900`
      **from** 49900 (so the desk replies to 49900), and relays those replies to a
      Chataigne **input on a different local port** (e.g. 49901). Chataigne never
      binds 49900 — the proxy does — so the split-socket problem disappears. Point
      OSC Output at the proxy; set OSC Input = 49901. Bench-test it first against
      `tools/dm7-osc-mock.js` (default mode reproduces the reply-to-source blocker).
      **Record:** does the value tree populate through the proxy?
- [ ] If you skip the proxy: **RCP (49280) is the DM7 feedback path** (already
      works). Document which path this rig will use.

*RE still pays off for feedback content once delivery is fixed:* confirmed reply
prefixes (`/yosc:ok/get`, `/yosc:notify/set`, `/yosc:okm/set`, `/yosc:ok/keepalive`,
`/yosc:error`), `#bundle` wrapping, and the subscribe/keepalive verbs all parse
already — the blocker was only delivery, never parsing.

### Once delivery works — push/subscribe likely needs a DIFFERENT address family

**RE finding (act on this before writing off push):** the module subscribes on
`/yosc:req/subscribe/MIXER:Current/…` (`DM7-OSC.js` `sendSubscribe`), but **every**
`subscribe` format string in firmware V1.75 is **`ts:`-prefixed** — e.g.
`/yosc:%s/subscribe/ts:3DRev/MasterFader/Level`, `ts:Show/On`,
`ts:Scene/Status/EnableSceneView`, `ts:@LogicalPositionControl`
(`YamDeskEmu/firmware/rcp/dm7_yosc.txt`). There is **no** `subscribe/MIXER:Current`
form in the firmware. So SUBSCRIBE probably only works on the **`ts:` editor-object
address family**, not the `MIXER:Current` namespace we get/set on.

- [ ] Once replies are arriving (proxy or source-port bind), test push two ways with
      **Send Raw Subscribe**: (a) a `MIXER:Current/…` address, (b) a `ts:…` address
      from the firmware list. **Record:** which one makes the desk push
      `/yosc:notify/set` (or `/yosc:okm/set`) on a desk-side change?
- [ ] If only `ts:` works, poll (`get`) stays the feedback mechanism for the
      `MIXER:Current` tree, and push would require a second `ts:`-addressed path.
      **Record the verdict** so we either wire up `ts:` subscribe or drop push.

---

## Priority 2 — DM7 OSC scene recall (needs a capture)

Recall *sends* now (`formatSceneNumber` fix), but the desk didn't act on it, and
the arg logged as `1.0`. Suspicion: Chataigne sends the number as an OSC **float**,
not the `"1.00"` **string** the desk wants.

- [ ] Trigger **Recall Scene** with Wireshark on 49900. **Capture the actual packet.**
      **Record:** the OSC **type tag** of the scene-number arg — `s` (string, good)
      or `f`/`i` (number, the bug). And whether the desk **actually recalls**.
- [ ] If it's a float/int: the fix is forcing a **string-typed OSC arg** (see the
      L-ISA module's per-type `sendS`/`sendF` pattern for how Chataigne coerces),
      not JS string-building. Bring that finding back.
- [x] **RCP Scene Inc/Dec CONFIRMED (DM7, 2026-09-14):** `Scene Recall Inc`/`Dec` send
      `event MIXER:Lib/Scene/RecallInc`/`RecallDec scene_a` and the desk steps up/down.
      (Long red herring first: the Inc command looked "dead" for ~20 exchanges — root
      cause was Chataigne running a **cached script**. Editing `Yam-RCP.js` needs the
      module's **Reload Script** action; remove+re-add only reloads `module.json` and
      keeps the old compiled `.js`, so its callbacks can point at functions the stale
      script lacks. See gotchas below.)
- [ ] Also test **Scene Inc/Dec** and **Query Current Scene** (the latter only works
      once Priority 1's port issue is solved — its reply is feedback).

---

## Priority 3 — Verify today's RCP fixes on hardware (should "just work")

These were fixed + harness-verified but not seen live on a desk. Quick to confirm.

- [ ] **Scene recall + `Scene > Current`** — CL/QL (integer) and DM7 (`N.MM`).
      **Record:** does Current populate and track desk-side recalls?
- [x] **DM7 scene number + name** (the re-query fix) — after a desk recall,
      `Scene > Current` should read **`1.00`** (not `0`) and `Scene > Name` should
      show the scene's name.
      **Record:** the `sscurrentt_ex`/`ssinfot_ex` exchange from the logger.
      **CONFIRMED 2026-09-14:** recalling from the desk surface correctly updates
      both `Scene > Current` and `Scene > Name` on real DM7 hardware.
- [ ] **CL/QL scene name** — `Scene > Name` should now fill (module now actually
      sends `ssinfo_ex` post-`indexOf` fix; never sent it before).
      **Record:** the `OK ssinfo_ex … "Name" …` reply (never captured yet).
- [x] **On-echo gone** — toggle a channel On from the **desk**; the module should NOT
      bounce a `set` back. Grab a short capture to confirm (pre-fix captures still
      showed the echo).
      **CONFIRMED 2026-09-14:** Chataigne logger shows `Message received: NOTIFY set …`
      lines only, no matching `Message sent` echo, across several rapid On/Off toggles
      on real DM7 hardware. Also confirms NOTIFY arrives with no subscribe ever sent.
- [ ] **InvalidArgument spam gone** — DM7 sync should no longer flood the logger with
      `ERROR get InvalidArgument` warnings (now DEBUG-only).

---

## Priority 4 — Remaining RCP hardware-confirm items (if time)

- [ ] **Keep-Alive need** — leave at `0`; only relevant if an idle RCP socket drops
      and silently kills NOTIFY feedback. Test by idling a few minutes then making a
      desk change.
- [~] **DM7 HA gain** — `InCh/Port/HA/Gain` answers only patched (head-amp) channels
      (unpatched → `ERROR … InvalidArgument`) — **confirmed** from the 2026-09-14 Sync
      capture. **SCALE CORRECTED:** the desk returns dB×100 (raw −600 = −6.00 dB, raw
      100 = +1.00 dB), i.e. **scale 100** like CL/QL — NOT scale 1 as the prminfo dump
      read. The RCP module's `DM7_HAGAIN` was fixed to `min -600 / max 6600 / scale 100`
      (the old scale 1 also made `Set HA Gain` send ≈1/100th of the requested dB).
      **Still to confirm on desk — the WRITE path:** trigger `Set HA Gain` with a known
      value (e.g. +6 dB), capture the wire (`set …/HA/Gain <ch> 0 600`), and verify the
      desk's channel gain actually reads +6 dB. (Read path already proven by the capture.)
- [ ] Capture the **DM7 `devinfo productname`** string (for `EXPECTED_PRODUCT` /
      the mock) if not already recorded.
- [ ] **DM7 colour palette — capture the full 11 WIRE names.** The 2026-09-14 Sync showed
      `Label/Color` wire values that DON'T match the RCP module's `DM7_COLORS`: the desk
      sends `"SkyBlue"` (module: `Cyan`), `"LightGreen"` (module: `LtGreen`), `"OFF"`
      (module: `Off`). Read is unaffected (colour is a String param), but **`Set Channel
      Color` sends the module's names → a DM7 rejects the mismatched ones.** Only 9 of 11
      wire names seen (Blue, Orange, Yellow, Purple, Red, White, SkyBlue, LightGreen, OFF).
      **Do:** colour channels through ALL 11 desk colours and capture each `Label/Color`
      wire string (esp. the two the module calls `Magenta` and `Green`). **Record** the
      exact 11 strings, then fix `DM7_COLORS` + the `Set Channel Color` enum in module.json.

---

## Notes / gotchas to remember (from last time)

- `module.json` edits ⇒ **remove + re-add the module** (not reload).
- **`.js` (script) edits ⇒ use the module's "Reload Script" action.** Remove+re-add
  reloads `module.json` but keeps a **cached compiled script**, so `.js` changes are
  ignored — and a `module.json` callback can then reference a function the stale script
  doesn't have, giving a **silently dead command** (no send, no error, no packet on the
  wire). Confirmed 2026-09-14 with a `script.log` build-marker that only appeared after
  "Reload Script". If in doubt, add a temp `script.log("build X")` in `init()`/a command
  and confirm it prints. NB remove+re-add also **resets module params to defaults**
  (host reverts to `127.0.0.1`), so re-enter the desk IP:port afterward.
- A **`/` in a command parameter name** silently kills that command.
- Engine quirks: `String.indexOf()` **silently returns wrong** results;
  `.toFixed()` **throws**; `n + "str"` concat of a `Math.*` result can coerce to
  numeric addition. Build strings by hand (`charAt`), compare with `===`.
- If a command produces **zero output** (no send, no error): suspect stale
  `module.json` (re-add) **before** the JS.
