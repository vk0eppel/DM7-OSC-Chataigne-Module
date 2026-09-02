# Field-Test Runbook — DM7-OSC & Yamaha-RCP Chataigne modules

Hardware available: **CL/QL** and **DM7**. Goal: confirm the "still to verify on real
hardware" items in both modules. Almost every open item is a one-line fix if the
assumption is wrong — the point of the day is to *observe the wire*.

Test mapping:
- **CL/QL → Yamaha-RCP module** (RCP, port 49280) — least-verified surface (sourced
  from the Bitfocus Companion module, not a first-party spec). Do this first.
- **DM7 → DM7-OSC module** (YOSC, port 49900) — confirms the firmware-derived push
  transport and argument encoding.
- **DM7 → RCP module** (49280) — optional, if time.

Record everything into one timestamped notes file next to the packet captures.
Each step is **Do →  Record**.

---

## 0. Prep (before touching a console)

- [ ] Start Wireshark. **Do NOT set a capture filter** — capture everything and filter
      afterward, so you don't discard traffic on a port the console actually uses.
      Filter *after* capture using the display-filter bar (see Wireshark note below).
- [ ] One capture file per session: `cl-rcp.pcapng`, `dm7-yosc.pcapng`, `dm7-rcp.pcapng`.
- [ ] Confirm laptop + console on the same subnet.
      **Record:** laptop IP, CL/QL IP, DM7 IP, subnet.
- [ ] Enable module loggers: RCP module `DEBUG = true`; DM7-OSC module
      **Log Unhandled Incoming = on**.

### Wireshark filter note (capture vs display syntax)

| Where | When | Syntax | Example |
|-------|------|--------|---------|
| Capture filter (interface list / Capture Options) | before capture | BPF, no dots | `port 49280 or port 49900` |
| Display filter (toolbar, turns green when valid) | during/after | dotted | `tcp.port == 49280 \|\| udp.port == 49280` |

Best filter for reverse-engineering — **filter by console IP**, so you catch every
port (replies often come from an unexpected/ephemeral port):

```
ip.addr == <console-ip>
```

Common "shows nothing" causes: filter typed in the wrong box (capture vs display),
wrong interface selected (Wi-Fi vs Ethernet), or filtering by port when the desk
replies from a different one.

---

## Session A — CL/QL over the RCP module (do first)

- [ ] **Connect.** Point RCP module at CL/QL IP : 49280.
      **Record:** connected? errors in the logger?
- [ ] **Sync Now.**
      **Record:** paste the full logger dump. Confirm faders/names/colours/mutes
      populate. Note anything blank or wrong (scale, truncated name, wrong colour).
- [ ] **Device / productname.**
      **Record:** exact reply line, e.g. `OK devinfo productname "CL5"`. Confirm Device
      container populates and **no false model-mismatch warning** fires.
- [ ] **Control from the module:** move a fader, toggle On, rename a channel, change a
      colour, toggle a mute group.
      **Record:** outgoing RCP string per action (Wireshark) + whether the desk
      responded. Verify fader ×100 scaling, `-32768` = −∞.
- [ ] **Control from the desk surface** (same set of changes). *(most valuable step)*
      **Record:** do changes arrive **unsolicited** as `NOTIFY set …` with **no
      subscribe** sent? Paste a couple of raw `NOTIFY` lines. If nothing arrives, note
      it — means CL/QL needs an explicit subscribe.
- [ ] **Scene recall** from the desk, then from the module.
      **Record:** does `sscurrent*` NOTIFY arrive in both cases? When *you* recall from
      the module, does the desk withhold `sscurrent` from you (the recaller)? Confirm
      verb `ssrecall_ex MIXER:Lib/Scene <n>`.
- [ ] **Idle test.** Keep-Alive `0`, leave idle ~2–5 min, then make a desk change.
      **Record:** did NOTIFY still arrive, or did the socket silently drop?

---

## Session B — DM7 over the DM7-OSC module (YOSC 49900)

- [ ] **Connect.** DM7 IP : 49900, correct **Console Model** (DM7 vs Compact), enable
      **Generate Feedback Values**.
      **Record:** connected? errors?
- [ ] **Refresh All Feedback Values** (poll path — the safe one).
      **Record:** paste logger; note which values populate vs stay blank.
- [ ] **Reply prefixes & encoding** *(the single most valuable capture)*. Capture the
      reply to a `get`.
      **Record:** exact address prefix — `/yosc:ok/get/…` or an echoed
      `MIXER:Current/…`? And the **argument shape after the prefix** for each type:
      Level, On, Pan, Name, Color, **HA gain** (confirm HA is scale-1 dB, not ×100).
- [ ] **Change from the desk:** Level / On / Pan / Name / Color / HA.
      **Record:** arrive as `/yosc:notify/set/…` or `/yosc:okm/set/…`? Paste raw lines.
      Note any address the parser flags **unhandled**.
- [ ] **Subscribe / keepalive push.** Enable **Use Subscribe**, set **Keepalive
      Seconds** (~30), reconnect/subscribe.
      **Record:** does the desk push changes without polling? Session stays alive across
      the interval? Capture a `/yosc:ok/keepalive` reply. Are `MIXER:Current/…`
      addresses subscribable, or only `ts:`-prefixed object addresses?
- [ ] **Scene chain.** Recall a scene.
      **Record:** `sscurrentt_ex` reply (number) + auto-chained `ssinfot_ex` reply
      (name), both raw arg shapes. Confirm `Scene > A/B > Number / Name` fills.
- [ ] **Error shape.** Trigger a deliberate error (bad Send Raw Get).
      **Record:** the `/yosc:error/…` shape.

---

## Session C — DM7 over the RCP module (optional, if time)

- [ ] RCP module → DM7 : 49280, Sync Now.
      **Record:** DM7 `devinfo productname` string (for `EXPECTED_PRODUCT` / mock). Test
      scene `ssrecallt_ex scene_a "N.MM"` and inc/dec
      `event MIXER:Lib/Scene/RecallInc scene_a`.

---

## Wrap-up (before leaving the venue)

- [ ] Stop and save all three `.pcapng` files.
- [ ] One-line verdict per open item (works / wrong / didn't arrive).
- [ ] Screenshot the Chataigne value tree in a known desk state for each console.

**Two things that make the day pay off:** actually do the "change from the desk" steps
(Session A push, Session B push) — the only way to see the push format — and keep
Wireshark rolling the whole time so every logger line has a matching packet.
