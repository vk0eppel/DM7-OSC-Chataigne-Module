# Yamaha DM7 OSC — Chataigne Module

A [Chataigne](https://benjamin.kuperberg.fr/chataigne) custom module to control a
**Yamaha DM7 / DM7 Compact** digital mixing console over OSC, following the
*DM7 Series OSC Specifications v1.1.0*.

## Install

Copy this folder into `<Documents>/Chataigne/modules/` and add the
**Yamaha DM7 OSC** module in Chataigne.

## Setup

1. On the console: **SETUP → NETWORK → For Mixer Control**, set a static IP.
2. In the module's **OSC Output**, set `remoteHost` to that console IP and
   `remotePort` to **49900** (the port the DM7 listens on).
3. Pick your **Console Model** parameter (DM7 = 120 inputs, DM7 Compact = 72).

Up to 4 OSC controllers can be connected to one DM7.

## What's covered (v0.3 — core live-mixing set + poll feedback, hardware-confirmed)

**Commands** (outgoing control):

- Input: fader level/on, pan, name, colour, head-amp (HA) gain, sends to Mix
  (level/on/pan) and Matrix (level/on), DCA assign
- Mix: fader level/on, name, colour, sends to Matrix (level/on)
- Matrix / Stereo / DCA: fader level/on, name, colour
- Mute groups: on, name
- Scene: recall (list A/B + number), recall inc/dec, query current scene
- Query: **Refresh All Feedback Values** — fires a `get` for every value in the
  feedback tree so the console reports its current state (paced across update
  ticks to avoid flooding the console with UDP)
- Feedback transport: **poll** (Refresh + optional Scene Poll) — confirmed working on
  a real DM7. Push/**subscribe** is a protocol dead-end for channels (see *Feedback*
  below); *Use Subscribe* / *Keepalive Seconds* are retained only for the four
  subscribable `ts:` objects and are off by default
- Advanced: **Send Raw Set / Get / Subscribe / Unsubscribe** escape hatches for any
  `MIXER:Current/...` (or `ts:...`) parameter

**Values** (two-way, optional via *Generate Feedback Values*): a channel-first
tree — each strip is its own container holding its values, e.g.
`Inputs > 66 > Level / On / Pan / Name / Color / HA Gain`, for Input, Mix, Matrix,
Stereo, DCA and Mute (Colour on Input/Mix/Matrix/DCA; HA Gain on Input only;
Stereo & Mute have none). Changing
a value sends the matching `set`; incoming OSC updates it. A read-only
`Scene > A/B > Number / Name` holder tracks the current scene (see below).

Not yet in scope: EQ/dynamics, monitor, 5.1 surround, cue, channel links.

## Value encoding (from the spec)

| Parameter | Wire value |
|-----------|------------|
| Fader / send level | integer dB × 100 (`0 dB → 0`, `-20 → -2000`, `+10 → 1000`, `-∞ → -32768`) |
| HA (head-amp) gain | integer dB, **scale 1** — the wire value *is* the dB (`-6 … 66`) |
| Pan | `-63 … 63` (0 = centre) |
| Name | string, max 8 chars (the module truncates longer names to the first 8) |
| Colour | `Blue/Orange/Yellow/Purple/SkyBlue/Pink/Red/Green/LightGreen/White/Off` (desk may report `Off` as `OFF`) |

Address grammar: `/yosc:req/set/<ParamID>/<X>[/<Y>] <value>` — e.g.
`/yosc:req/set/MIXER:Current/InCh/Fader/Level/61 -2000`.

## Feedback (confirmed on a real DM7, 2026-09-17)

**Poll feedback works.** `Refresh All Feedback Values` returns **0 unhandled** — the
desk answers every `get` and the whole value tree populates: levels, on, pan, names,
colours, HA gain, DCA, mute groups, and scenes all round-trip. Replies arrive under
fixed prefixes (`/yosc:ok/get/...`), which `oscEvent()` dispatches on.

**The reply-port detail (solved).** The DM7 sends each reply back to the UDP *source*
port of the request, not to a fixed port. Chataigne's OSC output uses an ephemeral
source port while its input listens on 49900, so by default replies miss the
listener. The fix is Chataigne's own **feedback** toggle on the OSC input, which
*also* listens on the output's source port — you'll see
`Feedback enabled, listening also on port NNNNN` in the log. With that on, YOSC poll
feedback works; no proxy or RCP is needed just for polling. (An earlier note here
called this a hard blocker — it is not; that toggle resolves it.)

**Push / subscribe does NOT work for channels — a protocol limit, not a bug.**
Confirmed two ways:
- *Hardware:* subscribing the whole `MIXER:Current` tree (1092 requests) drew **zero**
  response — no push, no ack, no error. The desk silently ignores it.
- *Firmware* (V1.75 `app_console_main`): the **entire** subscribe surface is four
  objects — `ts:@LogicalPositionControl`, `ts:3DRev/MasterFader/Level`,
  `ts:Scene/Status/EnableSceneView`, `ts:Show/On`. No input fader, mute, mix, DCA,
  etc. is subscribable.

So **channel feedback over OSC is poll-only** — there is no real-time "fader moved on
the desk → Chataigne updates" path in YOSC. For live channel feedback use the sibling
**Yamaha RCP module (TCP 49280)**, which has a documented `NOTIFY` push. `Use
Subscribe` stays off by default; only `Send Raw Subscribe` with one of the four `ts:`
objects above can ever push anything.

**Scenes (arg layout hardware-confirmed):**
- `sscurrentt_ex` reply → `list, number, modified-flag` (e.g. `scene_a 3.00 modified`).
- `ssinfot_ex` reply → `list, number, number, name, comment, store-type`
  (e.g. `scene_a 3.00 3.00 "Base Main House3" "26-27" user`) — **the name is the 4th arg**.

The module records the number from `sscurrentt_ex`, then chains `ssinfot_ex` for the
name into a read-only `Scene > A/B > Number / Name` holder. `Refresh All Feedback
Values` (which now also queries the current scene), an optional **Scene Poll Seconds**
interval, and the **Query Current Scene** command all drive this. Note: a DM7 that uses
only one scene list replies for `scene_a` and ignores `scene_b`.

> A module *command* is a **template** — it only fires from a Mapping / Sequence /
> State action (or the poll), not by clicking it in the command list. That's why
> "Query Current Scene" appears to "do nothing" when clicked directly.

**`scpmode`:** the desk's per-session `scpmode` options also work over OSC. Note
the Bitfocus Companion module sends `scpmode sstype "text"`, but **`sstype` is not
a DM7 key** and errors on a DM7 — don't copy it.

## Provenance

The transport was originally derived from static reverse-engineering of the DM7
firmware (V1.75 `app_console_main`), documented in the sibling
[Yamaha RCP Chataigne module](https://github.com/vkoeppel/Yamaha-RCP-Chataigne-Module)
(`docs/dm7-rcp-parameters.md`, "YOSC" section). The get/reply transport, scene reply
layout, colour names, and the subscribe limitation are now **confirmed against real
hardware** (2026-09-16/17).

## Development notes

Chataigne runs scripts on JUCE's ES3-era JavaScript engine, which lacks many
modern features. When editing `DM7-OSC.js`, avoid:

- `for...in` — iterate an explicit keys array with a numeric `for` (see
  `SPEC_KEYS` / `CONT_NAMES`)
- chained-bracket assignment (`a[k][i] = x`) — assign the inner object to a
  local var first and use string index keys
- regex literals / `.test()`, and ES5 array/string helpers such as `unshift`,
  `slice`, `join`, `map`, `forEach`, `indexOf` — build/parse with manual loops.
  `indexOf` doesn't throw here; it silently returns a wrong result (confirmed
  on the sibling RCP module: `String.indexOf()` calls that matched under Node
  quietly returned false on real hardware, with no error logged - the harder
  failure mode to catch)
- `String.split(sep)` with a **multi-character** `sep` — this engine splits on the
  separator as a **character set**, not as a substring. `"…Level/5".split("sscurrentt")`
  matched (any of `s/c/u/r/e/n/t`) and returned length > 1, so scene detection ate
  every reply. Single-char separators like `split("/")` are fine; for substring
  tests use the hand-rolled `containsSub()`. **(confirmed on real DM7)**
- **relational operators (`<` / `>`) on strings** — they coerce operands to numbers,
  so `"L" < "0"` is `NaN < 0` (false) and a `ch < "0" || ch > "9"` digit check passes
  for letters. `isIntToken()` used to accept `"Level"` this way and no feedback routed.
  Test characters via a lookup object (`DIGIT_SET[ch]`), not `<`/`>`. `==`/`!=` on
  non-numeric strings are fine. **(confirmed on real DM7)**
- `Number.prototype.toFixed()` — throws `Unknown function 'toFixed'` (confirmed
  on real DM7 hardware via `Recall Scene`/`ssrecallt_ex`, which needs an
  "x.xx" string). Build fixed-point strings by hand instead - see
  `formatSceneNumber`/`intToStr` in `DM7-OSC.js` (digit-by-digit via `charAt`,
  since plain `n + string` concatenation of a `Math.floor`/`round` result also
  isn't trustworthy here - it appended a stray `.0`, e.g. `"1.00"` came out as
  `"1.0.0.0"`)

Safe: `split` **with a single-char separator only**, `charAt`, indexing,
`parseInt`/`parseFloat`, `Math.*`, `==`/`!=` (including on strings).

Also: a module-parameter's `local.parameters.<name>` accessor is derived from its
**display name** in `module.json` — keep names to plain words (e.g. `Use Subscribe`
→ `useSubscribe`). Special characters like parentheses change the derived name and
break the accessor (`Unknown function 'get'`).

**`module.json` edits need a full module remove + re-add — not a reload.** Chataigne
scans a module's command/parameter definitions once, at registration. Editing the
`.js` hot-reloads; editing `module.json` (new/renamed commands or parameters) does
**not** take effect on a script reload *or* a project reload — the running module
keeps its stale command list. Symptom (seen on real hardware, DM7 + CL5): a
new/edited command produces **zero output** when triggered — no send, no script
error, nothing. If that happens, **delete the module from the project and add it
fresh** before suspecting the JS. (Bit us on both modules the same day.)

## License

See [LICENSE](LICENSE).
