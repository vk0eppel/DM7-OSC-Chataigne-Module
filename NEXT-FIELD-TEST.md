# Next Field-Test Day — TODO

Covers **both** modules (DM7-OSC over YOSC/49900, Yamaha-RCP over TCP/49280).
Built from the 2026-09-02 CL5 + DM7 session. Most code fixes from that day are
**unverified on hardware** — this day is mostly *confirm the fixes live* plus two
real blockers. Each item is **Do → Record**.

## 0. Prep (do first, every session)

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

---

## Priority 1 — DM7 OSC feedback BLOCKER (the big unlock)

The DM7 replies to the request's **UDP source port** (ephemeral, e.g. 49626), but
Chataigne's OSC input listens on 49900 — so no reply is ever received. Feedback
(values, scene query, push) is fully blocked until this is solved.

- [ ] In the module's **OSC Output** settings, look for any option to bind/reuse the
      **source (local) port** — "Local Port", "Reuse input port", a `local`
      checkbox, etc. Goal: make Chataigne **send from 49900** (the listen port).
      **Record:** exactly what output options exist (screenshot).
- [ ] If found: set source port = 49900, Sync, watch Wireshark for replies now
      arriving at **49900**, and confirm the **value tree populates**.
      **Record:** does the tree fill? (Desk replies arrive as OSC `#bundle` of
      `/yosc:ok/get/…` — confirm Chataigne unpacks bundles into `oscEvent`.)
- [ ] If NOT found: try a newer Chataigne build, or accept that **YOSC feedback is
      impossible** through split in/out sockets → **RCP (49280) is the DM7 feedback
      path** (already works). Document the verdict either way.

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
- [ ] Also test **Scene Inc/Dec** and **Query Current Scene** (the latter only works
      once Priority 1's port issue is solved — its reply is feedback).

---

## Priority 3 — Verify today's RCP fixes on hardware (should "just work")

These were fixed + harness-verified but not seen live on a desk. Quick to confirm.

- [ ] **Scene recall + `Scene > Current`** — CL/QL (integer) and DM7 (`N.MM`).
      **Record:** does Current populate and track desk-side recalls?
- [ ] **DM7 scene number + name** (the re-query fix) — after a desk recall,
      `Scene > Current` should read **`1.00`** (not `0`) and `Scene > Name` should
      show the scene's name.
      **Record:** the `sscurrentt_ex`/`ssinfot_ex` exchange from the logger.
- [ ] **CL/QL scene name** — `Scene > Name` should now fill (module now actually
      sends `ssinfo_ex` post-`indexOf` fix; never sent it before).
      **Record:** the `OK ssinfo_ex … "Name" …` reply (never captured yet).
- [ ] **On-echo gone** — toggle a channel On from the **desk**; the module should NOT
      bounce a `set` back. Grab a short capture to confirm (pre-fix captures still
      showed the echo).
- [ ] **InvalidArgument spam gone** — DM7 sync should no longer flood the logger with
      `ERROR get InvalidArgument` warnings (now DEBUG-only).

---

## Priority 4 — Remaining RCP hardware-confirm items (if time)

- [ ] **Keep-Alive need** — leave at `0`; only relevant if an idle RCP socket drops
      and silently kills NOTIFY feedback. Test by idling a few minutes then making a
      desk change.
- [ ] **DM7 HA gain** — confirm `InCh/Port/HA/Gain` only answers patched (head-amp)
      channels, values sane (scale 1 = dB). (Expected per last session.)
- [ ] Capture the **DM7 `devinfo productname`** string (for `EXPECTED_PRODUCT` /
      the mock) if not already recorded.

---

## Notes / gotchas to remember (from last time)

- `module.json` edits ⇒ **remove + re-add the module** (not reload).
- A **`/` in a command parameter name** silently kills that command.
- Engine quirks: `String.indexOf()` **silently returns wrong** results;
  `.toFixed()` **throws**; `n + "str"` concat of a `Math.*` result can coerce to
  numeric addition. Build strings by hand (`charAt`), compare with `===`.
- If a command produces **zero output** (no send, no error): suspect stale
  `module.json` (re-add) **before** the JS.
