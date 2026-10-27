# Second display: OLED burn-in protection

The panel is OLED. In display mode it mirrors a desktop that can stay the same for hours, and the
receiver's layer covers HomeUI's own protection (a screensaver clip for 2 s every 5 min). This
feature gives the mirror its own protection. It applies in display mode only; Stats mode keeps
HomeUI's.

Built 2026-10-27. Unit-tested on the PC; **not yet run on the cooler** (see "Unverified").

## What the user sees

One setting, `burnInProtection` in `state.json`, on by default.

| behaviour | when | how |
|---|---|---|
| Shift | every 3 min, always | the picture moves to the next of 8 offsets on a ring within 4 px of the centre: (4,0) (3,3) (0,4) (-3,3) (-4,0) (-3,-3) (0,-4) (3,-3). The uncovered edge is black; the same 4 px at the opposite edge are off the panel. |
| Dim | 3 min without a real change | fades over 1 s to min(0.40 × current, 0.15 × full) brightness, where current is the backlight as a share of full |
| Black | 10 min without a real change | fades over 1 s to black |
| Refresh | every 5 min, counted from the connection | black for 2 s, at once, even while the desktop changes; skipped while dimmed or black; a real change does not end it |
| Wake | the first real change while dimmed or black | full brightness at once |
| Off | setting off | full brightness, centred, no refresh |

The backlight is never changed. The dimming draws the picture darker, so it can only lower the
light.

## Where it runs

```
ryuod ──stdin lines──► ryuo_display.py ──control NAL in the HEVC stream──► RyuoDisplay (cooler)
  ▲                                                                            │
  └────────────── stdout lines (protection state, frame sizes) ◄───────────────┘
```

### Receiver (`receiver/RyuoDisplay.java`)

- **Layers.** A second parentless layer, `ryuo-display-black` (2240×1080, RGBX, opaque), sits at
  z `MAX_VALUE - 2`, under the video layer at `MAX_VALUE - 1`. Its one buffer is filled black once
  with `Surface.lockCanvas()` at start-up. Both layers are shown on the first decoded frame and hidden
  when the PC disconnects. Being opaque and full screen, it hides HomeUI completely, so HomeUI's
  screensaver clip never shows at the shifted edge.
- **Dimming is the video layer's alpha.** A black curtain of alpha `c` above the picture and a picture
  of alpha `1 - c` over opaque black give the same pixels, so the receiver sets
  `Transaction.setAlpha(video, 1 - c)` and needs no third layer. Dimmed alpha =
  `min(0.40 × current, 0.15) / current` (1 when current is 0); black and refresh are alpha 0.
  Shift is `Transaction.setPosition(video, dx, dy)`. Both are public API since Android 10; the
  cooler runs Android 13 (API 33). No new hidden API is used.
- **`Protection`** holds the timers and state as pure logic on millisecond times. It has no Android
  calls, so it runs on a desktop JVM (`ProtectionCheck.java` here).
- **`Panel`** owns the two layers and a `Protection`, and applies what it wants in transactions,
  all under one lock: from the stream thread (each frame, each control message), the decoder output
  thread (the first frame shows the layers) and a timer thread. The timer thread ticks every 250 ms,
  every 33 ms during a fade, so the timers go on when no frame comes: a still desktop, a stalled
  stream, a sleeping PC.
- **Status.** On each state change and every 5 s while the layer is shown it prints
  `ryuo-display: protection state=<active|dimmed|black|refresh|off> idle=<s> [shift=<s>]`
  (`shift` only while on) and, when frames came in those 5 s,
  `ryuo-display: frames n=.. floor=.. small=.. smallMax=.. big=.. bigMin=.. rapid=..`.
  Each control message is echoed as `ryuo-display: control: <text>`.
- **Defaults.** Until a control message arrives the protection is on and the backlight is taken as
  full, which dims to 15 % of full: never brighter than intended.

### Control link (`ryuo_display.py`)

Control messages ride in the HEVC stream itself. `control_unit()` builds a NAL unit of type 48 (HEVC
leaves 48-63 unspecified for applications) with an ASCII payload such as
`ryuo protect=1 backlight=0.392`. ASCII has no zero bytes, so the payload can never contain a start
code. `Relay` sends it between two whole frames, followed by an access unit delimiter, so the
receiver's `AccessUnitReader` cuts it off as an access unit of its own at once; `controlMessage()`
recognises it and it never reaches the decoder.

Why in-band rather than a second socket: no second abstract socket, adb forward or port, and every
connection starts with the current values (the `Relay` sends the unit first, before any frame), so
a reconnect cannot leave the receiver with stale settings.

`ryuo_display.py` takes `--protection on|off` and `--backlight SHARE` (0-1) for the first message and,
with `--control-stdin`, reads `protection on|off` and `backlight SHARE` lines from stdin while it runs.
Run from a terminal without these, the receiver gets protection on and backlight 1.

### Daemon (`ryuod.py`)

- `Display.set_protection(on, backlight)`: passed as arguments to each new child, and written to a
  running child's stdin (non-blocking pipe) when it changes. Nothing is restarted.
- `Daemon.sync_protection()` is called at start-up, by `POST /api/display/protection` and by
  `POST /api/brightness`. The share is `min(255, int(value × 2.5)) / 255`, the backlight HomeUI sets.
- `Display.read()` parses the receiver's lines into `status()["protection"]`; they never become the
  child's `message` and stay out of the error tail. Only state changes are logged without `-v`.
- `black_config()` now sends six empty overlay slots, so HomeUI shows plain black under the mirror.
  `POST /api/overlay` while display mode streams saves without sending (`heldByDisplay: true`);
  `Backdrop.restore()` sends the saved media and overlay when it stops.

API: `docs/002-stats-prototype/spec.md`, sections `POST /api/display` (the `protection` object) and
`POST /api/display/protection`.

## What counts as a real change

### Measured: the encoder's floor

`frame_sizes.py` here encodes synthetic 2240×1080 desktop frames with exactly `gst_cmd()`'s
nvh265enc settings (P1, ultra-low-latency, CBR, no B-frames, no further keyframes) on the
development PC's RTX 5080, and prints the size of every access unit as the receiver sees it.
Results on 2026-10-27, bytes:

| scenario | 5 Mb/s | 10 Mb/s | 20 Mb/s | 40 Mb/s |
|---|---|---|---|---|
| unchanged frame, settled (the floor) | 1,661-1,670 | 4,972-5,003 | 7,376-7,386 | 7,545-7,551 |
| caret blink (2×18 px) | +65 | +80-100 | +90-170 | +90-130 |
| pointer moving 1 px | | +60-470 | | +100-540 |
| pointer moving 3 px | +190-270 | +200-330 | +290-430 | +250-430 |
| pointer moving 15 px | | +400-600 | | +460-700 |
| clock, 5 glyphs | +310-440 | +340-500 | +380-600 | +380-630 |
| tooltip appearing (300×120 px of text) | +14,900 | +19,700 | +23,800 | +23,500 |
| scrolling a text window | up to 220 kB | up to 280 kB | up to 440 kB | up to 470 kB |

The scrolling run also produced one frame of 526 bytes (10 Mb/s), below the floor: the rate control
starving a frame after several huge ones.

Every P-frame costs a fixed floor that depends on the bitrate (and the picture), about 5 kB at the
default 10 Mb/s, and the small changes add only 1-10 % to it. The floor is all slice data
(NAL type 1), not filler. Right after a keyframe the encoder also refines: unchanged frames grow
from about 80 bytes to 20-42 kB over 20-30 frames, then settle at the floor.

So an absolute size threshold cannot work (the floor moves with the bitrate), and even the excess over
the floor cannot tell a short pointer move (+60-700) from a clock tick (+300-630).

### The rule

A frame is a real change when either holds:

1. **Big:** it is at least `REAL_EXCESS_BYTES = 2000` bytes larger than the floor, the smallest of
   the previous `FLOOR_FRAMES = 32` frames. This catches windows, tooltips, menus, scrolling,
   anything that redraws a region of more than a few glyphs. Small changes stay under +700 at every
   bitrate measured; the smallest real redraw measured (the tooltip) is +14,900.
2. **Rapid:** it is the `RAPID_FRAMES = 4`th or later of frames each at most `RAPID_GAP_MS = 400` ms
   after the one before. This catches pointer movement (KWin sends a frame per refresh, about 16 ms
   apart, so it wakes after about 50 ms of motion) and typing at about 3 keys/s or faster. A caret
   blinks every 500 ms (Qt's default; GTK 600 ms), and with a clock ticking once a second the longest
   run is 3 frames, at any phase between the two (`ProtectionCheck.java` tries every 25 ms).

Consequences to know:

- A single short pointer nudge (3 frames or fewer) does not wake the panel. Deliberate movement does.
- Typing slower than about 1 key per 400 ms counts only when it redraws more (autocomplete, a new
  line that scrolls).
- Continuous animation on the panel (a video, a spinner, a terminal printing) keeps it active, so it
  never dims; the shift and the 5-min refresh still run.
- After a keyframe (each capture restart) the refining frames are "big" for up to about 32 frames,
  which at a caret's 2 frames/s keeps the panel active about 16 s longer.

### How to tune

The receiver reports the sizes every 5 s (only while frames come). Without restarting anything:

```sh
watch -n 2 "curl -s 127.0.0.1:8746/api/state | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"display\"][\"protection\"])'"
```

`frames` has `floor` (bytes), `small` (frames under the threshold) and `smallMax` (the largest
excess among them), `big` and `bigMin` (the smallest excess over the threshold), and `rapid` (small
frames counted by their rate). `-1` means none.

1. Leave the desktop still with a caret blinking and a seconds clock on the panel: `big` and `rapid`
   should stay 0, and `smallMax` is the largest periodic change. `REAL_EXCESS_BYTES` must stay well
   above it.
2. Open a menu, a tooltip, a small dialog: `bigMin` shows how small a real redraw gets.
   `REAL_EXCESS_BYTES` must stay below it.
3. Move the pointer slowly: `rapid` should rise. Raise `RAPID_FRAMES` if periodic sources ever count
   as rapid.

The journal shows the same lines with `ryuod -v` (`make run`, with the service stopped), and each
state change always. After changing a constant in `Protection`: `make receiver`, run
`ProtectionCheck.java` (its header has the commands), then turn display mode off and on, which
pushes the new jar.

## Unverified

Nothing here has run on the cooler yet.

- **The black layer.** `lockCanvas()` on a BLAST surface from `app_process` (no zygote) should work,
  but is untested. The receiver logs `black layer ready` or `black layer failed: ...`. If it fails, the
  shifted edge and the dimmed picture show HomeUI instead: its black image with the overlay off, plus
  its 2 s screensaver clip every 5 min.
- **Alpha on the video layer.** Whether the cooler's HWC composes a plane-alpha video layer over a
  solid layer without dropping frames or falling back to slow GPU composition. Watch the receiver's
  fps line (`-v`) while dimmed against active.
- **Fade smoothness.** 30 alpha steps over 1 s from the timer thread; possible visible stepping.
- **Real frame sizes.** The table above is synthetic content; a real desktop's floor and changes
  may differ. KWin 6.7.5's slow capture cycle sends frames in bursts of 3 (see
  `docs/006-second-display-slow-capture/`); if a caret blink comes as such a burst, a caret plus a
  clock could form runs of 4 or more and count as rapid. KWin 6.8 fixes that cycle.
- **PC asleep.** The timers run without frames, but whether the cooler stays powered and HomeUI
  stays out of standby while the PC sleeps was not observed.
- **Decoder rate.** One more opaque layer, which also hides HomeUI from composition; the effect on
  the ~90 fps decode ceiling is unmeasured.

## Live test

1. `make receiver` was run; `receiver/receiver.jar` is rebuilt. Restart ryuod
   (`systemctl --user restart ryuod`) so it runs the new `ryuod.py`; it starts display mode again if the
   switch was on, and `ryuo_display.py` pushes the new jar.
2. `journalctl --user -u ryuod -f | grep display:` should show `ryuo-display: black layer ready`,
   `first frame, layer shown`, `control: protect=1 backlight=0.980` (at brightness 100), then
   `protection state=active idle=0 shift=180`.
3. `adb shell dumpsys SurfaceFlinger --list | grep ryuo-display` lists `ryuo-display` and
   `ryuo-display-black`.
4. On the panel: HomeUI's overlay is gone under the mirror (switch display mode off: the stats come
   back).
5. Shift: after 3 min the picture moves 4 px right, with a black strip at the left edge.
   `/api/state` `display.protection.nextShiftS` counts down to it.
6. Leave the panel's part of the desktop still: dims at `idleS` 180 (state `dimmed`), black at 600.
   Move the pointer across the panel: full brightness at once. A blinking caret alone must not wake it.
7. Refresh: within 5 min of the start, 2 s of black while active.
8. Toggle: `curl -s -X POST -H 'Content-Type: application/json' -d '{"enabled":false}'
   127.0.0.1:8746/api/display/protection`; within about 1 s the picture is full and centred, the
   journal shows `control: protect=0 ...` and `protection state=off`, and no `restarted the capture`
   or `started ryuo_display.py` line appears. `{"enabled":true}` turns it back on.
9. Brightness: change it on the page while dimmed; the dim level follows (at brightness 40, 39 % on
   the page, the backlight share is 0.392 and the picture's alpha 0.15 / 0.392 = 0.38).
10. Tuning data: the `watch` command under "How to tune".
