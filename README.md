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

## What's covered (v0.3 — core live-mixing set + push feedback)

**Commands** (outgoing control):

- Input: fader level/on, pan, name, colour, sends to Mix (level/on/pan) and
  Matrix (level/on), DCA assign
- Mix: fader level/on, name, colour, sends to Matrix (level/on)
- Matrix / Stereo / DCA: fader level/on, name, colour
- Mute groups: on, name
- Scene: recall (list A/B + number), recall inc/dec, query current scene
- Query: **Refresh All Feedback Values** — fires a `get` for every value in the
  feedback tree so the console reports its current state (paced across update
  ticks to avoid flooding the console with UDP)
- Feedback transport: **poll** (Refresh + optional Scene Poll) *or* firmware-derived
  **push** — set *Use Subscribe* to have the desk push changes, with
  *Keepalive Seconds* holding the session open (see below)
- Advanced: **Send Raw Set / Get / Subscribe / Unsubscribe** escape hatches for any
  `MIXER:Current/...` (or `ts:...`) parameter

**Values** (two-way, optional via *Generate Feedback Values*): a channel-first
tree — each strip is its own container holding its values, e.g.
`Inputs > 66 > Level / On / Pan / Name / Color`, for Input, Mix, Matrix, Stereo,
DCA and Mute (Colour on Input/Mix/Matrix/DCA; Stereo & Mute have none). Changing
a value sends the matching `set`; incoming OSC updates it. A read-only
`Scene > A/B > Number / Name` holder tracks the current scene (see below).

Not yet in scope: EQ/dynamics, monitor, 5.1 surround, cue, channel links.

## Value encoding (from the spec)

| Parameter | Wire value |
|-----------|------------|
| Fader / send level | integer dB × 100 (`0 dB → 0`, `-20 → -2000`, `+10 → 1000`, `-∞ → -32768`) |
| Pan | `-63 … 63` (0 = centre) |
| Name | string, max 8 chars (the module truncates longer names to the first 8) |
| Colour | `Blue/Orange/Yellow/Purple/Cyan/Magenta/Red/Green/LtGreen/White/Off` |

Address grammar: `/yosc:req/set/<ParamID>/<X>[/<Y>] <value>` — e.g.
`/yosc:req/set/MIXER:Current/InCh/Fader/Level/61 -2000`.

## ⚠️ Feedback is experimental (but firmware-informed)

The public v1.1.0 OSC spec **does not document the response/feedback format**.
However, reverse-engineering the DM7 firmware (V1.75 `app_console_main`) settles
the *transport* — see the **YOSC** section of
[`docs/dm7-rcp-parameters.md`](https://github.com/vkoeppel/Yamaha-RCP-Chataigne-Module/blob/main/docs/dm7-rcp-parameters.md)
in the sibling Yamaha-RCP module:

- Replies and pushes arrive under **fixed address prefixes**, not an echoed
  `MIXER:Current/...` address: `/yosc:ok/get/...` (reply to a `get`),
  `/yosc:notify/set/...` and `/yosc:okm/set/...` (pushed updates),
  `/yosc:ok/keepalive`, `/yosc:error/...`. The parser now dispatches on these
  (with the old `MIXER:Current` scan kept only as a last-resort fallback).
- The OSC server has **`subscribe` / `unsubscribe` / `keepalive`** — real push
  feedback, so you don't have to poll. *Use Subscribe* subscribes
  the whole value tree; *Keepalive Seconds* pings the desk so it doesn't drop the
  session (the firmware closes idle sessions, which would kill push).

**Still unverified without a real desk** (this is static firmware extraction, not
a hardware capture): the exact *argument encoding* after each prefix, and whether
`MIXER:Current/...` addresses — rather than the `ts:`-prefixed object addresses
seen in the firmware — are actually subscribable. So push is **off by default**;
poll (Refresh / Scene Poll) remains the safe fallback. Enable **Log Unhandled
Incoming**, watch the logger against real hardware, and open an issue/PR with what
you see.

**Scenes:** the current scene *number* comes from `sscurrentt_ex`; the *name*
comes from a separate `ssinfot_ex` query (firmware `SSCURRENTT_EX` vs
`SSINFOT_EX`), which the module now chains automatically. It provides a
`Scene > A/B > Number / Name` holder, a **Query Current Scene** command, and an
optional **Scene Poll Seconds** interval poll. The reply arg shapes are still
best-effort — confirm/correct via *Log Unhandled Incoming*.

**`scpmode`:** the desk's per-session `scpmode` options also work over OSC. Note
the Bitfocus Companion module sends `scpmode sstype "text"`, but **`sstype` is not
a DM7 key** and errors on a DM7 — don't copy it.

## Provenance

The feedback/transport details above are derived from static reverse-engineering
of the DM7 firmware, documented in the sibling
[Yamaha RCP Chataigne module](https://github.com/vkoeppel/Yamaha-RCP-Chataigne-Module)
(`docs/dm7-rcp-parameters.md`). They are **not** confirmed against real hardware;
treat anything feedback-related as experimental until verified on a desk.

## Development notes

Chataigne runs scripts on JUCE's ES3-era JavaScript engine, which lacks many
modern features. When editing `DM7-OSC.js`, avoid:

- `for...in` — iterate an explicit keys array with a numeric `for` (see
  `SPEC_KEYS` / `CONT_NAMES`)
- chained-bracket assignment (`a[k][i] = x`) — assign the inner object to a
  local var first and use string index keys
- regex literals / `.test()`, and ES5 array/string helpers such as `unshift`,
  `slice`, `join`, `map`, `forEach`, `indexOf` — build/parse with manual loops

Safe: `split`, `charAt`, indexing, `parseInt`/`parseFloat`, `Math.*`, `toFixed`.

Also: a module-parameter's `local.parameters.<name>` accessor is derived from its
**display name** in `module.json` — keep names to plain words (e.g. `Use Subscribe`
→ `useSubscribe`). Special characters like parentheses change the derived name and
break the accessor (`Unknown function 'get'`).

## License

See [LICENSE](LICENSE).
