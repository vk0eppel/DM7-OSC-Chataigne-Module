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

## What's covered (v0.1 — core live-mixing set)

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
- Advanced: **Send Raw Set** / **Send Raw Get** escape hatches for any
  `MIXER:Current/...` parameter

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

## ⚠️ Feedback is experimental

The v1.1.0 spec **does not document the response/feedback format** for
parameters, nor the reply to a `get` / `sscurrentt_ex` query. The incoming
parser assumes the console echoes the same `MIXER:Current/...` address, and the
**Refresh All Feedback Values** command assumes the yosc `get` verb mirrors
`set` (`/yosc:req/get/<ParamID>/<X>`, no value). Enable **Log Unhandled
Incoming** and watch the logger against real hardware to confirm or correct
both — then open an issue/PR with what you see.

**Scenes:** the spec defines no message the console emits when a scene is
recalled, and the reply to `sscurrentt_ex` (read current scene) is also
undocumented. The module still provides scene-state scaffolding: a
`Scene > A/B > Number / Name` value holder, a **Query Current Scene** command,
and an optional **Scene Poll Seconds** parameter that polls both lists on an
interval. The reply parser is a best-effort guess (list token echoed in the
args, followed by number then name) — confirm/correct it via *Log Unhandled
Incoming* against real hardware.

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

## License

See [LICENSE](LICENSE).
