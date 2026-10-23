# Delete and preview on-device media from the web page

Status: investigated, nothing implemented. Written 2026-10-23 at the end of the session that
added video upload (commit `919cc0f` on branch `video-upload`, worktree
`/home/shared/repos/rog-ryuo-lcd-video`). Measurements below are from that day, on firmware
V1.0.10.

## The short version

Two features for the "Background media" section of `web/index.html`:

1. **Delete files from `/sdcard/pcMedia/`.** Nothing removes anything today, so every upload
   stays on the panel. On 2026-10-23 `pcMedia` held 3 files (102 MB), and one of them
   (`2026-01-26_22-07-49-639.mp4`) is 98 MB.
2. **Preview a file in the browser before playing it on the panel.** Chrome 156 on this machine
   **cannot decode HEVC**, and every transcoded upload is HEVC. `canPlayType('video/mp4;
   codecs="hvc1.1.6.L120.90"')` returns `""` and `mediaCapabilities.decodingInfo` returns
   `supported: false`. A plain `<video src>` of the device file therefore shows nothing for any
   file the upload feature converted. Preview needs a thumbnail or an H.264 proxy made on the PC.

Numbers that size the preview work (2026-10-23, the 98 MB file, 1920×960 H.264, 123 s):

| step | time | output |
|---|---|---|
| `adb exec-out cat` to the PC | 4.4 s (≈ 22 MB/s) | 98 MB |
| thumbnail, `ffmpeg -ss 1 … -frames:v 1 -vf scale=320:-2` | 0.08 s | 7.9 kB JPEG |
| H.264 proxy, 640 wide, `libx264 -preset veryfast -crf 30 -an` | 2.0 s | 3.3 MB |
| HEVC thumbnail through the imageio-ffmpeg binary (7.0.2 static) | 0.06 s | 5.6 kB JPEG |

The last row matters: the bundled fallback ffmpeg decodes HEVC, so thumbnails work without
system ffmpeg.

## What is NOT wrong (checked, do not re-investigate)

- **The panel plays the uploaded files.** A 2240×1080 HEVC upload played on `rk_mpp` at 60 fps:
  355 frames decoded, 355 shown, `grep -c standby.mp4` = 0. A 1920×926 H.264 upload played
  unchanged and is stretched to fill the panel. Preview problems are browser-side only.
- **H.264 plays in this Chrome.** `canPlayType('video/mp4; codecs="avc1.640028"')` =
  `"probably"`. Files Armoury Crate made (H.264) would preview directly. Only HEVC needs a proxy.
- **`adb shell rm` on `pcMedia` works** as the shell user. It was used on 2026-10-23 to remove
  two test uploads, and `ryuo_media.push` already uses it to clean up a failed push
  (`ryuo_media.py:391`).
- **Presets cannot be deleted by `mediaDelete`.** It only ever joins bare names onto
  `sdcard/pcMedia/` (FoxPodZ `PROTOCOL.md`, "mediaDelete" section). The UI should not offer
  delete for the Preset list at all.

## Why it is not just a button

- **Deleting a file the playlist uses.** HomeUI does not fail on a missing file. It logs
  `file not found ,play next` and retries every 3 s (`docs/001-lcd-protocol/…handoff.md`,
  ScreenConfig section). If the deleted file is the only entry in `state.media`, the panel has
  nothing to play. The daemon must drop deleted names from `state["media"]` and re-send
  `waterBlockScreenId` (`select_playlist`, `ryuod.py:903`). If the list ends up empty, fall back
  to the first preset, as `Device.startup` already does at `ryuod.py:739-741`.
- **The media list is cached.** `Device.media` (`ryuod.py:598`) is filled from the `conn` reply
  (`set_media_from_conn`, `ryuod.py:765`) or from `adb_media()` (`ryuod.py:885`), and
  `select_playlist` validates against it. After a delete, update `dev.media["custom"]` the same
  way the upload job appends to it (`ryuod.py:1017`). Otherwise the old name can still be
  selected.
- **`mediaDelete` replies `1 200` whether or not the file existed** (FoxPodZ, confirmed on
  1.0.10). Its reply cannot prove the delete happened. Re-list afterwards (`GET
  /api/media?refresh=1`, which sends `conn`).
- **Never send `{"exclude": [...]}`.** It deletes every file in `pcMedia` *except* the named
  ones. Send `include` only.
- **HID report size.** One report is 1024 bytes. A long `include` list has to be split or
  checked with `P.fits("POST", "mediaDelete", body)` (`ryuo_proto.py:311`), the way
  `select_playlist` checks the playlist.

## Design: proposed, not yet agreed with the user

Open for the user to decide: confirmation style, and whether proxies are worth the disk space.
Everything else follows from the constraints above.

**Delete**
- `POST /api/media/delete` with `{"names": [...]}`, JSON only. `do_DELETE` answers 405 on
  purpose (`ryuod.py:1065`): a non-simple method or a JSON body forces a CORS preflight, which
  `do_OPTIONS` refuses, so other web pages cannot delete files.
- Validate every name against `dev.media["custom"]`, and refuse path separators and preset names.
- Delete through the device worker with HID `POST mediaDelete {"include": names}`, so no adb is
  needed. If the worker is busy or disconnected, fall back to `adb shell rm -f`. Either way,
  re-list, update `dev.media`, and fix the playlist as above.
- UI: a delete button per Custom row. The viewer refuses `confirm()` dialogs, so use a
  two-step button ("Delete" → "Really delete?"). Show the file size from `ls -la` so the
  98 MB file is visible.

**Preview**
- `GET /api/media/thumb?name=…` returns a JPEG made by ffmpeg from the file pulled to
  `~/.cache/ryuo/preview/`. Cache it by name plus size, since names carry a millisecond
  timestamp and are not reused. Use the `ryuo_media.tools()` resolution (`ryuo_media.py:104`)
  so the imageio-ffmpeg fallback applies.
- `GET /api/media/preview?name=…` returns a playable file:
  - if `canPlayType` would accept the original (H.264), serve the pulled file;
  - otherwise make a 640-wide H.264 proxy (≈ 2 s per 2 minutes of video, numbers above).
  - Serve it with `Range` support, or `<video>` cannot seek. `Handler` (`ryuod.py:1031`) has no
    file-serving helper yet; `do_GET` at `:1071` only serves `index.html`.
- Show thumbnails in the media list; play the preview in a `<video muted loop>` on click.
- PNG files exist in `pcMedia` (`2026-01-26_20-04-35-774.png`, from Armoury Crate). Serve them
  directly as `image/png`. Whether HomeUI plays a PNG on the panel is unknown.

## Recommended order of work

| # | step | ships alone? |
|---|---|---|
| 0 | Rebase or merge `video-upload` onto `main`. Commit main's working tree first (see "How to work"). | yes, required before anything else |
| 1 | Delete: endpoint, playlist fix-up, media-list update, UI button. This stops uploads piling up. | yes; ship it before preview |
| 2 | Thumbnails in the media list. | yes |
| 3 | Playable preview with the H.264 proxy and Range serving. | yes; the riskiest step, keep it separate |

## Files

Line numbers are for `919cc0f` on `video-upload` and will move after step 0.

| path | why |
|---|---|
| `ryuod.py:885` `adb_media()` | adb fallback for the media list; extend to `ls -la` if sizes are wanted |
| `ryuod.py:598`, `:765` | `Device.media` and `set_media_from_conn`: the cached list that validation uses |
| `ryuod.py:618` `Device.submit` | how to send `mediaDelete` through the worker without blocking the heartbeat |
| `ryuod.py:739-741` (in `Device.startup`, `:732`) | existing "playlist empty → first preset" fallback to reuse |
| `ryuod.py:903` `select_playlist` | playlist validation and `P.fits` check; re-run after a delete |
| `ryuod.py:1017` | upload job updating `dev.media["custom"]`; delete mirrors it |
| `ryuod.py:1031-1125` | `Handler`: `host_ok`, the 405 for DELETE/OPTIONS, GET and POST route dicts |
| `ryuo_media.py:104` `tools()`, `:139` `run()`, `:385` `push()` | ffmpeg resolution and the subprocess runner with cancel; reuse both for thumbnails and proxies |
| `ryuo_proto.py:19` `MEDIA_DIR`, `:311` `fits()` | device path and HID size check |
| `web/index.html:342` `renderMedia()`, `:356` `loadMedia()` | the Preset/Custom list the delete buttons and thumbnails go into |
| `docs/001-lcd-protocol/001_problem_and_handoff.md` | `mediaDelete` row in the command table; ScreenConfig and missing-file behaviour |
| FoxPodZ `PROTOCOL.md`, section "mediaDelete" | `include`/`exclude` semantics. GPL-3.0: read it, don't copy code. A clone was at `/tmp/claude-1000/-home-shared-repos-rog-ryuo-lcd/cdaa121f-9c13-4432-99d1-8b14f028e532/scratchpad/foxpodz/ryuo-iv-screen`; re-clone from https://github.com/FoxPodZ/ryuo-iv-screen if it is gone |

## How to work

- **Branch.** `video-upload` in `/home/shared/repos/rog-ryuo-lcd-video`.
- **Main has moved.** By 2026-10-23 it had 4 commits that `video-upload` lacks: `43f3a11`
  (pytest suite with `tests/conftest.py`, `tests/fakes.py`, `tests/test_safety.py`), `ca4614b`
  (vitest suite under `web/tests/`), `cac5cdf` (Makefile and packaging) and `75fb2a3` (README).
  It also had uncommitted edits in `ryuo.py`, `ryuo_proto.py`, `ryuo_tray.py`, `ryuod.py`,
  `web/index.html` and several tests. Ask the user to commit or discard those before step 0.
- **Expected conflicts.** Both branches fixed the same ruff findings in `ryuo.py`,
  `ryuo_proto.py`, `ryuo_tray.py` and `ryuod.py`, and both added `pythonpath = ["."]` to
  `pyproject.toml`. `tests/test_upload.py` has its own `FakeDevice`; fold it into
  `tests/fakes.py` after the merge.
- **Tests.** Run `uv run --directory /home/shared/repos/rog-ryuo-lcd-video pytest -q` (53 passed
  at `919cc0f`) and `uv run --directory /home/shared/repos/rog-ryuo-lcd-video ruff check`. After
  the merge, `make test` runs pytest plus `cd web && npm ci && npm test`. Add delete and preview
  tests to `web/tests/media.test.js`.
- **Hardware safety.** Main's `tests/conftest.py` blocks adb, hidraw and port 8746 in tests,
  per the upload subagent's report, which ran its tests under it. Keep device calls stubbed.
- **On-device testing needs the panel to itself.** `ryuod` refuses to share it. Claude may
  stop the service when the user says the panel is free, and must restore everything
  afterwards (sequence below).
- **Prose style.** Docs, comments and UI copy follow
  `/home/shared/repos/claude-skills/rules/prose-style.md`.

## Commands that establish state

All run on 2026-10-23.

```sh
# what is on the panel (sizes included)
adb shell ls -la /sdcard/pcMediaPreset /sdcard/pcMedia

# pull speed and codec of a device file
/usr/bin/time -f 'pull %e s' adb exec-out cat /sdcard/pcMedia/2026-01-26_22-07-49-639.mp4 > big.mp4
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,codec_tag_string,width,height,avg_frame_rate,bit_rate:format=duration -of compact big.mp4

# thumbnail and proxy timings
ffmpeg -v error -y -ss 1 -i big.mp4 -frames:v 1 -vf scale=320:-2 thumb.jpg
ffmpeg -v error -y -i big.mp4 -an -vf scale=640:-2 -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -movflags +faststart proxy.mp4
```

Browser codec check, run in the page's devtools console:

```js
const v = document.createElement('video');
v.canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"')   // "" in Chrome 156 here
v.canPlayType('video/mp4; codecs="avc1.640028"')        // "probably"
```

On-device test sequence used for the upload feature. Reuse it for delete:

```sh
curl -s http://127.0.0.1:8746/api/state | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["config"]))'  # save media + playMode first
systemctl --user stop ryuod
python3 -u /home/shared/repos/rog-ryuo-lcd-video/ryuod.py -v      # background
# … test …
curl -s -X POST -H 'Content-Type: application/json' -d '{"media":[…saved…],"playMode":"Cycle"}' http://127.0.0.1:8746/api/media/select
pkill -INT -f '^python3 -u /home/shared/repos/rog-ryuo-lcd-video/ryuod.py'
systemctl --user start ryuod
```

**Traps:**
- `ryuod` needs about 2 s after `systemctl --user start` before port 8746 answers. A `curl`
  sent right after the start gets an empty body, and `json.load` fails on it.
- `pgrep -f ryuo` also matches the Bash tool's own `zsh -c` wrapper. Anchor the pattern with
  `^python3`.
- In zsh, a bare `=====` as an `echo` argument is an error (`==== not found`). Quote separators.

## Success criteria

1. A test, failing without the fix, shows that deleting the only playlist entry leaves
   `state.media` non-empty and re-sends `waterBlockScreenId`.
2. A test shows that `POST /api/media/delete` refuses a preset name, a name with `/`, and a name
   not in `dev.media["custom"]`, and that `DELETE` and `OPTIONS` still answer 405.
3. On the device: delete one test upload from the page. `adb shell ls /sdcard/pcMedia` no longer
   lists it, `GET /api/media` no longer returns it, and the panel keeps playing:
   `adb shell dumpsys media.player | grep -c standby.mp4` = 0.
4. Thumbnails appear for an HEVC upload, the 98 MB H.264 file and the PNG, using both system
   ffmpeg and the imageio-ffmpeg fallback (mock `shutil.which` as `tests/test_media.py` does).
5. The HEVC upload's preview plays in this Chrome and can be seeked: the request shows
   `206 Partial Content`.
6. The heartbeat keeps running during a 98 MB pull plus proxy encode, with no
   `standby.mp4` on the panel.

## Open questions

- **Delete confirmation:** a two-step button or an undo window? The user hasn't said. Undo would
  mean deferring the actual delete.
- **Proxy cache limit:** at ≈ 3 MB per 2 minutes it is small, but unbounded. Pick a cap, or clear
  it at startup like `default_upload_dir()` is cleared.
- **Does `conn` re-list `pcMedia` live after a delete?** Not tested. If it returns a stale list,
  use `adb_media()` for the post-delete refresh.
- **Does HomeUI play PNG files?** Not tested. It decides whether the PNG gets a "play" checkbox
  or only a preview.
