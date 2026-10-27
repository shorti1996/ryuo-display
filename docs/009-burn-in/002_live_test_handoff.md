# Burn-in protection: live test on the cooler

Status: **built, deployed, not yet run on the cooler.** 2026-10-27. Design and mechanism:
`001_design_and_handoff.md` in this folder. This file is the checklist for the first live run.

- ryuod was restarted on the new code at 19:14:27 CET with display mode off, so no windows moved.
  `/api/state` then showed `config.burnInProtection: true` and
  `display.protection: {enabled: true, state: null, ...}` (null = no mirror running).
- The new `receiver/receiver.jar` is in the checkout. `ryuo_display.py` pushes it to the cooler on the
  next display-mode start; until then the cooler still has the old receiver.
- Suites at commit: pytest 744 passed / 1 skipped, vitest 256 passed, `ProtectionCheck.java` 76 checks.

## The short version

Nothing below has been seen on the panel. Six things only the cooler can answer:

1. The receiver's black layer works from `app_process` (journal: `black layer ready`, not `black layer failed`).
2. The shift, dim, black, refresh and wake timings match the table in `001`, §"What the user sees".
3. A blinking caret or clock alone does not wake a dimmed panel; pointer motion does.
4. Toggling protection takes effect in about 1 s and never restarts the capture.
5. Dimming does not drop the decoder's frame rate (alpha composition on the cooler's HWC is untested).
6. The real desktop's frame sizes fit the `REAL_EXCESS_BYTES = 2000` / `RAPID_FRAMES = 4` rule.

## Who does what

- **The user starts display mode** (page switch or tray). Starting it adds the Virtual-RYUO monitor,
  which can move windows on the host; Claude does not do that unasked.
- **Never restart ryuod while display mode is on.** A restart stops the child, removes the virtual
  monitor and moves windows. Check `display.on` first:
  `curl -s 127.0.0.1:8746/api/state | python3 -c 'import json,sys; print(json.load(sys.stdin)["display"]["on"])'`
- Claude may: read `/api/state`, read the journal, run read-only `adb shell dumpsys`, toggle
  `/api/display/protection`, change brightness and restore it.
- Leave the panel's part of the desktop untouched for 10 min for steps 6-7; the user has to keep
  windows off Virtual-RYUO for that long.

## Checklist

Start display mode, then in a terminal:

```sh
journalctl --user -u ryuod -f | grep display:
```

| # | check | pass when |
|---|---|---|
| 1 | receiver start | journal shows `ryuo-display: black layer ready`, `first frame, layer shown`, `control: protect=1 backlight=0.…`, then `protection state=active idle=0 shift=180` |
| 2 | layers | `adb shell dumpsys SurfaceFlinger --list \| grep ryuo-display` lists `ryuo-display` and `ryuo-display-black` (0 lines while display mode is off; that is expected) |
| 3 | backdrop | the stats overlay is gone from the panel; switch display mode off and the stats come back |
| 4 | page | Desktop mirror tab card reads "Protection: active · next shift in N min"; hero chip shows the same |
| 5 | shift | at about 3 min the picture moves 4 px right with a black strip at the left edge; `nextShiftS` counts down to it |
| 6 | refresh | within 5 min of the start, 2 s of black while the desktop is in use |
| 7 | dim, black | desktop on the panel left still: `state` `dimmed` at `idleS` 180, `black` at 600; the page status follows |
| 8 | wake | while dimmed or black, move the pointer across Virtual-RYUO: full brightness at once. A blinking caret alone must not wake it |
| 9 | toggle | below; within about 1 s the picture is full and centred, journal shows `control: protect=0 …` and `protection state=off`, and **no** `restarted the capture` or `started ryuo_display.py` line |
| 10 | brightness | change brightness on the page while dimmed: the dim level follows. Restore the brightness afterwards |
| 11 | page off-state | turning the switch off on the page asks inline first; while off, a red warning line in the card and a red "Burn-in protection off" chip on the hero |

Toggle commands for step 9:

```sh
curl -s -X POST -H 'Content-Type: application/json' -d '{"enabled":false}' 127.0.0.1:8746/api/display/protection
curl -s -X POST -H 'Content-Type: application/json' -d '{"enabled":true}'  127.0.0.1:8746/api/display/protection
```

Tuning data, while frames arrive (no restart needed):

```sh
watch -n 2 "curl -s 127.0.0.1:8746/api/state | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"display\"][\"protection\"])'"
```

Record `frames.floor`, `smallMax`, `bigMin` and `rapid` for: a still desktop with a caret and a
seconds clock; a tooltip or menu opening; slow pointer motion. What each field means and how to
change the constants: `001`, §"How to tune".

## Traps

- **fps line needs `-v`.** The receiver's fps line (for check 5 of the short version) is only in the
  journal with `ryuod -v`: stop the service, run `make run` in a terminal, compare fps while `active`
  against `dimmed`. The service's own journal only logs state changes.
- **`pgrep -f ryuo_tray.py` matches its own shell.** A `kill $(pgrep -f '[r]yuo_tray.py')` inside a
  command line that also contains the path killed the calling shell on 2026-10-27. Use
  `pgrep -a python3 | grep -F ryuo_tray.py`.
- **The tray runs the code it started with.** After code changes, quit it from its menu and start
  RYUO LCD again.
- **KWin 6.7.5's slow capture cycle** sends frames in bursts of 3. A caret plus a clock arriving as
  such bursts could form runs of 4 and count as "rapid", which keeps the panel awake. If check 8 fails
  that way, see `docs/006-second-display-slow-capture/`.

## Success criteria

1. Checks 1-11 pass.
2. With protection on, journal `restarted the capture` count during the toggles is 0.
3. Receiver fps while `dimmed` is within 10 % of `active` (needs `make run`).
4. `frames.smallMax` on a still desktop with caret and clock stays below 1000 bytes, and `bigMin` for a
   tooltip stays above 3000. Otherwise move `REAL_EXCESS_BYTES` between them, `make receiver`, re-run
   `ProtectionCheck.java` (commands in its header), and switch display mode off and on to push the jar.

## Open questions

- **PC asleep.** Whether the cooler stays powered and HomeUI stays out of standby while the PC sleeps
  with display mode on was never observed; the receiver's timers should keep dimming either way.
- **Fade smoothness.** 30 alpha steps over 1 s from a timer thread; stepping may be visible.
- **Real frame sizes.** The thresholds come from synthetic frames on the RTX 5080 at 10 Mb/s
  (`frame_sizes.py`); a real desktop may differ.
