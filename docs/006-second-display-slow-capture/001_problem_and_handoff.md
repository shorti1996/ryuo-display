# Second display: KWin's slow capture cycle

Status: investigated 2026-10-24. Cause found with high confidence; no fix committed. A slow-cycle
detector exists uncommitted on branch `display-startup-restart` (see "Already implemented"). The
proper cure is KWin 6.8.0 or later, which Fedora 43 does not ship.

## The short version

1. Right after display mode starts, with static windows on Virtual-RYUO, KWin's capture runs in a
   fixed cycle of 3 frames every 500 ms: frame gaps of `407, 1, 92, 407, 1, 92, …` ms, 6.2 fps,
   pointer included, even while the user drags a window. Measured on the first trial of both
   harness runs on 2026-10-24.
2. A partial form appears after some restarts: gaps `16, 17, 67, 16, 17, 67, …` ms, 3 frames every
   100 ms, 29.3 fps (mpv run, trial 1, after its first restart).
3. A window that redraws by itself (ffplay or mpv playing a 60 fps pattern) on the output when the
   stream starts prevents the cycle: 58.5–59.5 fps in every stage of trials 2–4 (ffplay) and 2–3
   (mpv), longest gap 33–50 ms.
4. This is the long-standing "starts slow, then somehow gets better" stutter from
   `docs/future-work/todo.md`. The user confirmed on 2026-10-24 that it has always started slow and
   sometimes gets worse later.

## What is NOT wrong (checked, do not re-investigate)

| Hypothesis | Evidence that killed it |
|---|---|
| The cooler can't decode fast enough | Fed a 2240×1080, 10 Mb/s test pattern straight to the receiver, it decodes about 70 fps with HomeUI's video behind and about 90 fps with a still image; paced 60 fps held 59.9–60.1 fps. `docs/005-second-display-receiver/principle_of_operation.md`, "Black background during display mode". |
| adb / USB back-pressure | `ss -tin` on the socket into the adb forward showed Send-Q 0 throughout while the panel stuttered (2026-10-24 15:10). |
| The cooler's CPU | Load average about 1 of 4 cores, CPU at its full 2016 MHz, 59 °C. MediaProvider (14–50 % of a core) and SerialService (10–54 %) look busy, but they don't line up with the stutter. |
| Leftover encoders or krfb instances, GPU load | One `ryuo_display.py`, one krfb, two encoders (active plus spare); GPU 5 %, NVENC 1 %. |
| ryuod.service priority or cgroup | Same nice 0 and TS scheduler as a shell-started run. A shell-started run went slow the same way. |
| The nvh265enc encoder | The 2026-10-23 note: a plain `pipewiresrc ! fakesink` consumer saw the same rate. |
| A KWin or PipeWire timer of 500 ms or 100 ms | None exists in KWin 6.7.5's screencast, render-loop or virtual-output code, or in pipewire 1.4.11's pipewiresrc. `SoftwareVsyncMonitor` defaults to 60 Hz. KWin hardcodes 60000 mHz for virtual outputs (`drm_virtual_output.cpp:28`). |
| A krfb flag or refresh-rate setting | krfb-virtualmonitor 26.04.3 takes only resolution, name, password, scale and port, and the protocol carries no refresh rate. |
| Raising PipeWire's buffer count | KWin offers 2–4 buffers (`screencaststream.cpp:184`), so at best that would give 4 frames per wait. |
| A package update on 2026-10-24 | No update that day; the last one was 2026-10-23 (qt6). KWin is 6.7.5. |

## Why it happens

Read in source on 2026-10-24 (KWin 6.7.5, pipewire 1.4.11, GStreamer 1.26.11). The overall chain
is inferred, at about 75 % confidence; each step is in the code:

1. KWin stamps each frame with the virtual output's last presentation time, not the capture time:
   `src/plugins/screencast/screencaststream.cpp:707` sets `pts = m_source->clock()`, and
   `outputscreencastsource.cpp:105` returns `renderLoop()->lastPresentationTimestamp()`. With
   static windows that time can be hundreds of ms old. When the stream starts,
   `outputscreencastsource.cpp:135` sends the first frame at once, carrying that old timestamp.
2. pipewiresrc copies it into the GStreamer buffer (`src/gst/gstpipewiresrc.c:612-616`). The
   source is live unless `stream.is-live` says otherwise (`:756-768`), and a live source syncs to
   buffer timestamps (`:1302-1316`).
3. GStreamer's basesrc fixes `ts_offset = now − first timestamp` once (`libs/gst/base/gstbasesrc.c:2381-2385`)
   and then waits until each later buffer's timestamp plus that offset (`:2436-2450`). Later frames
   carry fresh timestamps, so each one waits about as long as the first was stale. During the wait
   the GstBuffer still holds the PipeWire buffer.
4. Once all 3 buffers are held, KWin's `record()` returns without sending (`screencaststream.cpp:583-586`),
   and the pending damage is dropped (`:352-356`). That gives 3 frames per wait: 3 per 500 ms, or 3
   per 100 ms when the stale time is shorter.

This explains the other observations:
- **A window that keeps drawing:** its repaints keep the timestamp fresh, so the wait is near 0.
- **A restart:** it starts a new gst process, which recomputes the offset; whether it helps depends
  on how fresh the timestamp is at that moment.
- **A window spanning both screens:** it repaints the output and fires the tool's own
  window-arrival restart.

Upstream fix: KWin commit cf5049251d, "screencast: Timestamp frames at capture time", in v6.8.0
(tagged 2026-10-08) and not on the Plasma/6.7 branch. Related 6.8 work: 3fad2bbcdc, f08169058d,
7db8e19725, b935db35b5. Related bugs, none with this exact symptom:
https://bugs.kde.org/show_bug.cgi?id=525619, https://bugs.kde.org/show_bug.cgi?id=525841,
https://bugs.kde.org/show_bug.cgi?id=524129.

Availability, checked 2026-10-24 on Bodhi: kwin 6.8.1 is pending for F45 and stable for F46 and
ELN. There's nothing for F43 (updates and updates-testing hold only 6.7.5), and no COPR backport
was found. Running 6.8 means upgrading the system to Fedora 45, which brings the whole Plasma 6.8
stack.

## Tried, with results

| Change | Result |
|---|---|
| One capture restart 1 s after streaming starts | Still about 6 fps; a manual restart 2.5 min later fixed it. Reverted. |
| One capture restart 3 s after streaming starts | Still about 6 fps. Reverted. |
| SlowCycle detector restarting on the signature (uncommitted) | Detects the cycle 2.5–3.4 s after the first frame. On its own, 3 restarts at 3, 7 and 13 s all fell back into the 500 ms cycle (15:41). |
| `stream-properties=props,stream.is-live=false` on pipewiresrc | Slow cycle in 1 of 3 starts (20 s in; one detector restart cleared it). But frames are unpaced: up to 102 fps sent, more than the cooler decodes, and the panel lagged. Reverted. PipeWire did report `stream.is-live: FALSE`, so the property reached the stream; the remaining slow start comes from a path not yet identified. |

## Design already agreed

- **Black background during display mode:** done and committed (`2369dfa`, branch
  `display-black-background`, not merged into main).
- **Self-healing on the slow-cycle signature:** the user asked for it; it's implemented as the
  uncommitted SlowCycle detector with a cooldown and a cap.
- **Open, being tried next:** a non-live pipewiresrc with frames capped at 60 fps (caps
  `max-framerate=60/1` after pipewiresrc), so KWin paces itself and nothing waits on stale
  timestamps.

## Recommended order of work

| Step | Ships alone? |
|---|---|
| 1. Try `stream.is-live=false` plus a `max-framerate=60/1` caps filter; measure with the harness (sent fps ≤ 60, no 3-frame cycle) | Yes. If it works, it is the fix until KWin 6.8. |
| 2. Commit the SlowCycle detector as a safety net, whatever step 1 shows | Yes |
| 3. Remove the temporary `RYUO_FRAME_LOG` hook, or turn it into a documented debug option | With step 2 |
| 4. When the system moves to Fedora 45 / KWin ≥ 6.8: re-measure with the harness, then drop whatever workaround step 1 added if the cycle is gone | Later |

## Files

| Path | Why it matters |
|---|---|
| `ryuo_display.py:222` `gst_cmd` | The pipewiresrc pipeline; workaround properties go here |
| `ryuo_display.py:438` `Relay`, `:481` | Sends each encoded frame; the temporary frame-log hook is at :481 (working tree only) |
| `ryuo_display.py:529` | Comment block on the 2026-10-23 slow capture of arriving windows (same bug, first sighting) |
| `ryuo_display.py:869-960` | "KWin's slow capture cycle" comment, `SLOW_*` constants, `SlowCycle`, `SlowRestarts` (uncommitted) |
| `ryuo_display.py:1233` `start_stream`, `:1305` `switch_to`, `:1373` `restart_capture`, `:1393` `watch` | Stream start, what a restart does, and where the detector triggers restarts |
| `tests/test_display.py` | Detector tests, with fixtures cut from the 2026-10-24 recordings (uncommitted) |
| `docs/006-second-display-slow-capture/capture_harness.py` | The measurement harness (copy of the one used on 2026-10-24) |
| `docs/future-work/todo.md` | The stutter entry this doc resolves; update it when a fix ships |

## How to work

- Branch: `display-startup-restart`, based on `display-black-background`. ryuod.service runs the
  repo's code directly (`ExecStart=/usr/bin/python3 -u .../ryuod.py`). ryuod starts a fresh
  `ryuo_display.py` at every display start, so changes to `ryuo_display.py` take effect when display
  mode is toggled, with no daemon restart.
- Tests: `make test` (pytest plus vitest), or
  `uv run --project /home/shared/repos/rog-ryuo-lcd pytest -q tests/test_display.py`. `make lint`:
  `ruff format --check` already fails on 10 hand-wrapped files on main, including `ryuo_display.py`;
  judge only new code.
- Toggle display mode through the API (it moves the user's windows each time, so ask first):
  `curl -s -X POST -H 'Content-Type: application/json' -d '{"on":false}' http://127.0.0.1:8746/api/display`,
  then poll `GET /api/state` until `display.state` is `off`, then send `{"on":true}`.
- The harness toggles display mode and opens a test window titled `ryuo-probe` on the user's
  desktop: ask the user before running it, and ask them to keep off the panel. It needs the
  `RYUO_FRAME_LOG` hook in `Relay._run`. The hook is 3 lines: open the file named by the variable
  at the top of `_run`, then write `f"{time.monotonic():.4f} {len(data)}\n"` after each `sendall`.
- The user judges smoothness by eye; sent fps alone is ambiguous, because a still desktop sends
  about 6 fps too.

## Commands that establish state

All run on 2026-10-24.

```
# per-frame timing, harness (ffplay or mpv probe; mpv waits for frame callbacks like most apps)
python3 -I docs/006-second-display-slow-capture/capture_harness.py <out-dir> 3 mpv
#   writes <out-dir>/frames.log ("<monotonic s> <bytes>" per frame), harness.log, display-N.log, results.json

# restart log lines and slow-cycle detections
journalctl --user -u ryuod --since <HH:MM:SS> --no-pager | grep -E "display: (streaming|.*restarted the capture|warning|error)"

# the PC's sent frame rate, 5 s windows (low on a still desktop, so not proof alone)
curl -s http://127.0.0.1:8746/api/state | python3 -c 'import json,sys; print(json.load(sys.stdin)["display"]["fps"])'

# trigger one capture restart by hand (the window watch's D-Bus method)
busctl --user list | grep -i ryuo        # org.rogryuolcd.Display.pid<ryuo_display pid>
gdbus call --session --dest org.rogryuolcd.Display.pid<PID> --object-path /org/rogryuolcd/Display \
  --method org.rogryuolcd.Display.WindowEvent enter manual-test

# check a pipewiresrc option took effect
pw-dump | python3 -c '
import json,sys
for o in json.load(sys.stdin):
    p=(o.get("info") or {}).get("props") or {}
    if str(p.get("node.name","")).startswith("ryuo-display"): print(o["id"], p.get("node.name"), p.get("stream.is-live"))'

# KWin package availability
curl -s "https://bodhi.fedoraproject.org/updates/?packages=kwin&rows_per_page=6"
```

Traps:
- `print()` from a KWin script doesn't land in `journalctl --user -u plasma-kwin_wayland`.
- A frame-gap list from the API's 5 s averages can't show the cycle; use the frame log.
- Restarting ryuod.service SIGKILLs the adb server if ryuod started it (`KillMode=mixed`). The
  next `adb` command starts a new server in the caller's cgroup. It's harmless, but expect "daemon
  not running; starting now".
- Toggling display mode quickly can make krfb fail with "no PipeWire stream for Virtual-RYUO after
  10 s"; ryuod's retry recovers.

## Success criteria

1. Over 5 consecutive display starts, with only static windows on the panel, the harness's frame
   log shows no 3-frame cycle (the SlowCycle detector logs nothing) within 60 s of each start.
2. While a window is dragged on the panel, sent fps reaches 55–60, and the panel shows no lag.
3. Sent fps never exceeds 60 for a sustained 5 s window, since the cooler decodes about 90 fps at
   most and its latency grows if it is overfed.
4. The detector's unit tests keep passing, and its replay of the 2026-10-24 recordings fires only
   in the slow phases.

## Open questions

- **What still causes a slow start with `stream.is-live=false`** (1 in 3 starts)? Running the
  encoder with `GST_DEBUG=basesrc:6` and `GST_DEBUG_FILE=<path>` would show whether any clock wait
  remains (`live with sync, ts_offset …`, `waiting for clock`).
- **Does KWin honour `max-framerate` from the consumer's caps** to pace a non-live stream? The
  research mentions max_framerate negotiation, but it wasn't verified.
- **Why do more than 60 fps come from a 60 Hz virtual output** once the source isn't live (102 fps
  measured)? Possibly separate cursor and content frames. Unverified.
