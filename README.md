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
- Scene: recall (list A/B + number), recall inc/dec
- Advanced: **Send Raw Set** escape hatch for any `MIXER:Current/...` parameter

**Values** (two-way, optional via *Generate Feedback Values*): a channel-strip
tree (Level / On / Pan / Name) for Input, Mix, Matrix, Stereo, DCA and Mute.
Changing a value sends the matching `set`; incoming OSC updates it.

Not yet in scope: EQ/dynamics, monitor, 5.1 surround, cue, channel links.

## Value encoding (from the spec)

| Parameter | Wire value |
|-----------|------------|
| Fader / send level | integer dB × 100 (`0 dB → 0`, `-20 → -2000`, `+10 → 1000`, `-∞ → -32768`) |
| Pan | `-63 … 63` (0 = centre) |
| Name | string, max 8 chars |
| Colour | `Blue/Green/Orange/Pink/Purple/Red/SkyBlue/Yellow/Cyan/Magenta/Off` |

Address grammar: `/yosc:req/set/<ParamID>/<X>[/<Y>] <value>` — e.g.
`/yosc:req/set/MIXER:Current/InCh/Fader/Level/61 -2000`.

## ⚠️ Feedback is experimental

The v1.1.0 spec **does not document the response/feedback format** for
parameters. The incoming parser assumes the console echoes the same
`MIXER:Current/...` address. Enable **Log Unhandled Incoming** and watch the
logger against real hardware to confirm or correct it — then open an issue/PR
with what you see.

**Scenes:** the spec defines no message the console emits when a scene is
recalled. `sscurrentt_ex scene_a` is a *request* to read the current scene
number (reply format also undocumented). So scene awareness would require
polling — not implemented yet.

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
