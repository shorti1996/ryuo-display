# ROG RYUO IV pump LCD on Linux: protocol and handoff

Status: protocol reverse-engineered and a working CLI driver written (`ryuo.py`), verified on the
hardware on 2026-10-23. Nothing beyond the CLI exists: no daemon, no autostart, no GUI. The next
planned step is a background tray app; `docs/gui-research-brief.md` is the brief for that research.

## The short version

1. The pump LCD is an Android 13 computer (Rockchip, `ro.product.version=ROG_RYUO_IV_Standard`,
   firmware V1.0.10, hardware V1.1) on internal USB `0b05:1c76`, port `1-12`. Panel 2240×1080.
2. It exposes two interfaces: `1-12:1.0` HID (host side `/dev/hidraw4` on 2026-10-23; the number
   can change, and `ryuo.py` finds it by VID/PID) and `1-12:1.1` ADB. The adb shell is **root**.
3. Media goes over **adb** into `/sdcard/pcMedia/`. Commands go over **HID**. The HID file-transfer
   command (`transport`) only counts bytes and saves nothing, so adb is the only working upload path.
4. Playback is selected with `POST waterBlockScreenId` and a `ScreenConfig` JSON. Verified on
   2026-10-23: a 98 MB MP4 played full-screen.
5. The cooler drops to the standby logo **5 s** after the last HID message, so a heartbeat
   (`STATE all`, every 1 s in `ryuo.py`) must keep running.
6. On reconnect the cooler restores the brightness it saved while in standby, 50/255, so the
   screen is dim. Sending `POST brightness {"value":100}` gives 250/255 (`settings get system
   screen_brightness`). `ryuo.py play` now does this itself.
7. **After `POST disconn`, the device only leaves standby after a 5 s silence.** A new config
   sent within 5 s plays behind the standby video (checked 2026-10-23: `standby.mp4` stayed open
   in `dumpsys media.player`, no `hindStandby` in logcat). `POST power {"event":"resume"}` hides
   standby unconditionally, so `ryuo.py play` sends it after the config.

## What is NOT wrong (checked, do not re-investigate)

- **No Windows driver or executable analysis is needed.** All the protocol logic lives on the
  device side in two system APKs, which decompile cleanly with jadx. The Windows app was never
  inspected; the APKs were enough.
- **The display hardware works.** The "no picture" symptom was HomeUI showing
  `/system/media/video/standby.mp4` because no PC was talking to it.
- **The logs in `/sdcard/catchlog/log/*.txt` are useless for the protocol.** They date from the
  factory (2025-12-29) and contain no PC traffic. Use live `adb logcat` instead.
- **The logcat noise is harmless:** a `HidPort read timeout` line every 50 ms and
  `sendStrTask: hidHandle == null` every ~110 ms are normal idle output.
- **The 1024-byte report size is fixed** by the gadget descriptor
  (`/config/usb_gadget/g1/functions/hid.gs0/report_length`; no report ID, 512 × 16-bit fields in
  and out).
- **Replies are not lost, only slow.** The `conn` reply takes ~400 ms (a 200 ms sleep in the
  handler plus a 100 ms send delay). With a 0.3 s read window `info` printed nothing; 1.5 s works.

## Protocol

### Frame (both directions)

```
0x5A | escape( len_be16 | payload | crc8 ) | 0x5A
  len    = len(payload) + 5, big-endian (counts itself, crc and both 0x5A)
  crc8   = low byte of the SIGNED-byte sum over len_be16 + payload
  escape = 0x5A -> 5B 01, 0x5B -> 5B 02
```

On the host, write `b"\x00" + frame` padded with zeros to 1 + 1024 bytes (the leading 0 is the
hidraw report-ID byte). The device strips trailing zeros.

Device-side parser traps (`DataConvert.getSerDataByBytes`):
- It counts raw `0x5A` bytes in the report. Exactly 2 means one message, 4 means two messages
  stuck together, and **any other count is silently dropped**. Escaping guarantees 2.
- A message split across two reports is not reassembled ("可能被拆分成两条数据，未做处理"), so one
  command must fit in one 1024-byte report after escaping.
- The CRC is never checked on receive, but the encoder computes it anyway.

### Payload

```
POST waterBlockScreenId 1\r\n
SeqNumber=7\r\n
ContentLength=209\r\n
ContentType=json\r\n
\r\n
{"id":"Customization",...}
```

- The first line is `<METHOD> <cmdType> <version>`. METHOD is `GET`, `POST`, `STATE` or `DELETE`.
- Header lines are `Key=Value`, mapped by Gson onto `DataHeader` field names (`SeqNumber`,
  `AckNumber`, `ContentLength`, `ContentType`, …).
- **At least two header lines are required.** With fewer, `getHeadByMsgs` returns null and the
  handler NPEs on `getDataHeader().getSeqNumber()`.
- Replies come back as `1 200\r\nAckNumber=<seq+1>\r\n...\r\n\r\n<json>`.

### Commands (all verified ones are marked)

| method + cmdType | body | effect |
|---|---|---|
| `POST conn` ✔ | anything | reply lists attributes, firmware, `media.preset[]`, `media.custom[]` (file names on the device), `sn` |
| `POST waterBlockScreenId` ✔ | `ScreenConfig` (below) | selects what plays |
| `POST waterBlockScreen` ✔ | `{"enable":true}` | screen on; `false` sets brightness 0 |
| `POST brightness` ✔ | `{"value":0-100}` | backlight = value × 2.5 (0–250) |
| `STATE all` ✔ | `PcInfo` JSON; `{"timestamp":<ms>}` is enough | heartbeat; feeds the sysinfo overlay |
| `POST displayInSleep` | `{"enable":bool}` | standby video vs black on disconnect |
| `POST power` (`resume` ✔) | `{"event":"suspend"\|"shutdown"\|"lock-screen"\|"resume"\|"unlock-screen"}` | PC power-state hints; `resume` hides standby, restores brightness and re-applies the config |
| `POST preset` | `ScreenConfig` | changes only the overlay and settings of the current config |
| `POST sysinfoDisplay` | `{"items":[...]}` | overlay fields |
| `POST temperature` | `{"value":"Celsius"\|"Fahrenheit"}` | unit |
| `POST spec` | `{"cpu":"…","gpu":"…"}` | names shown in the overlay |
| `POST rotate` | `{"degree":N}` | writes `persist.vendor.orientation` — persistent, untested |
| `POST fanLCD` / `fanLCDSet`, `POST turboPump` | see `MsgReceiverManager` / `SerialMsgReceiverHandler` | pump fan and turbo; untested |
| `POST mediaDelete` | `{"include":[names]}` or `{"exclude":[names]}` | deletes from `/sdcard/pcMedia/` |
| `POST disconn` ✔ | — | standby video starts within ~0.1 s; see the re-entry trap in §short version, item 7 |
| `POST upgrade`, `transport`/`transported` with `"type":"firmware"` | — | **OTA firmware update. Never send.** |

### ScreenConfig for full-screen playback

```json
{"id":"Customization","screenMode":"Full Screen","ratio":"2:1","playMode":"Single",
 "media":["2026-01-26_22-07-49-639.mp4"],"sysinfoDisplay":[],"settings":null,
 "timeZone":"Europe/Warsaw"}
```

- `media` holds bare file names. `getMediaFilePath` looks in `/sdcard/pcMediaPreset/` for names
  starting with `RYUO`, otherwise in `/sdcard/pcMedia/`, and falls back to the other directory.
- `playMode`: `Single`, `Cycle` or `Random`. `Single` still loops: on completion the handler
  re-plays `media[0]`. The lowercase `"single"` checks in `setLayout1Path` never match.
- **Burn-in screensaver**: `screenConfigChange` (`home-bad/.../MainActivity.java:1625`) arms a
  300 s timer (msg 118). Once it has fired, the next end of a video plays
  `/system/media/video/Screensaver.mp4` instead (`_left`/`_right` in split mode), with the sysinfo
  overlay hidden. Then the user's media resumes and the timer re-arms (handler case 102, `:218`).
  A short looping clip therefore gets interrupted every ~5 min. From the code; not yet observed on
  the panel. Avoiding it would mean re-sending `waterBlockScreenId` before 300 s, which resets the
  timer and restarts the video.
- `ratio` sets the layout box: `2:1` = full 2240×1080, `16:9` = 1920, `3:2` = 1620, `4:3` = 1440,
  `1:1` = 1120 wide (all 1080 high).
- `screenMode` other than `"Full Screen"` is split screen: `playMode` and `media` then become
  two-element arrays (left/right) and `settings` an array.
- `id` other than `"Customization"` plays `/sdcard/pcMedia/<text after ":" with spaces→_>.mp4`
  (the old preset scheme).
- `timeZone` is applied to the Android system clock. Send a real zone; the code never checks
  it for null.
- A missing file is not an error: HomeUI logs `file not found ,play next` and retries every 3 s.

## Why it behaves this way (mechanism)

- `SerialService.apk` (`com.baiyi.service.serialservice.serialdataservice`, persistent priv-app)
  opens `/dev/hidg0` (`HidManage.java:50`) and polls it every 50 ms (`HidHandle.ReadThread`).
- Each report goes `SerialMsgReceiverHandler.distributeBleData` (`:533`) →
  `DataConvert.getSerDataByBytes` (`:18`) / `analy` (`:55`) → the handler at `:127`. The handler
  answers `conn`, `transport`, `mediaDelete`, `turboPump` and `upgrade` itself and acks
  everything else (`sendAck` → `SerialMsgManager.sendRequestMsg` `:113`, which is also the encoder
  to copy). It forwards the rest over AIDL (`IOnSerialDataCallback.onSerialDataChanged`) to HomeUI.
- `HomeUI.apk` (`com.baiyi.homeui.hshomeui`, the launcher): `MsgReceiverManager.java` dispatches
  on cmdType (`waterBlockScreenId` at `:173`) and re-arms a 5 s disconnect timer on every message
  (`:491`). `MainActivity` handler case 105 applies the ScreenConfig
  (`home-bad/.../MainActivity.java:338`); `setLayout1Path` (`:1147`) plays `.mp4` in a VideoView
  and anything else in an ImageView.
- Brightness: on disconnect (case 111, `:630`) it saves the current brightness, which is 50 when
  already in standby, and the reconnect handler (case 112, `:649`) restores that saved value.
- Clock: every `STATE all` with a `timestamp` more than 5 s off resets the Android clock
  (`:151`). Omitting `timestamp` would set the clock to 1970. The first heartbeat on 2026-10-23
  moved the device clock from 12-29 to the correct date.

## Design already agreed

- The CLI driver is plain Python standard library, using hidraw and the `adb` binary. No pyusb
  and no kernel module.
- Access is through a udev `uaccess` rule (`70-rog-ryuo-iv.rules`, installed in
  `/etc/udev/rules.d/` by the user on 2026-10-23), not root.
- Next: a background app with a tray icon and a GUI for upload, select and brightness. Toolkit and
  process split are **open**; `docs/gui-research-brief.md` asks those questions.
- Decompiled vendor code and APKs stay local in `re/` and are not to be committed (see `.gitignore`).

## Recommended order of work

| # | step | ships alone? |
|---|---|---|
| 1 | systemd user unit running `ryuo.py play <last file>` at login | yes — on its own this gets the screen showing video after every boot |
| 2 | split `ryuo.py` into a protocol module + CLI, add a reconnect loop (reopen hidraw when the cooler re-enumerates, e.g. after suspend) | yes |
| 3 | daemon with a local control socket or D-Bus (select, brightness, pause) that the CLI talks to | yes |
| 4 | tray icon + GUI client on top of #3, per the research answer | after #3 |
| 5 | optional: ffmpeg transcode to 2240×1080 H.264 before push | independent |

Ship #1 by itself first. Keep it separate from the GUI work.

## Files

| path | why it matters |
|---|---|
| `ryuo.py:43` `encode`, `:53` `decode` | the frame codec |
| `ryuo.py:67` `Ryuo.send` | header lines (≥2 required), report-ID prefix, 1024 limit |
| `ryuo.py:92` `heartbeat` | must include `timestamp` (see clock trap) |
| `ryuo.py:124` `media_config` | ScreenConfig builder |
| `ryuo.py:96` `running_player`, `:108` `stop_player` | pidfile handling for `stop` and player replacement |
| `ryuo.py:195` | `power resume` after config; without it a quick re-`play` stays behind standby |
| `ryuo.py:198` | brightness after config; without it the screen stays at 50/255 |
| `70-rog-ryuo-iv.rules` | udev rule, installed in `/etc/udev/rules.d/` |
| `docs/gui-research-brief.md` | brief for researching the tray app |
| `re/apk/HomeUI.apk`, `re/apk/SerialService.apk` | pulled from `/system/app/HomeUI/` and `/system/priv-app/SerialService/` |
| `re/src/serial/sources/…/data/manager/SerialMsgReceiverHandler.java` | command handling in the service, `conn` reply `:198`, `transport` stub `:252` |
| `re/src/serial/sources/…/data/manager/SerialMsgManager.java:113` | reference encoder |
| `re/src/serial/sources/…/data/tool/DataConvert.java` | reference decoder and the 0x5A-count trap |
| `re/src/serial/sources/…/data/tool/ByteTools.java:342` | CRC |
| `re/src/home/sources/…/manage/MsgReceiverManager.java` | HomeUI command dispatch, 5 s timeout |
| `re/src/home-bad/sources/…/MainActivity.java` | decompiled with `--show-bad-code`: the main handler that the normal `re/src/home` output leaves out |
| `re/src/home/sources/…/entity/ScreenConfig.java`, `PmSetting.java`, `PcInfo.java` | JSON shapes |
| `re/jadx/bin/jadx` | jadx 1.5.1, used for the decompile |
| `re/screen.png` | standby screen before any PC traffic |

`…` = `com/baiyi/service/serialservice/serialdataservice` (serial) or `com/baiyi/homeui/hshomeui` (home).

## How to work

- Local git repo, branch `main`, no remote (as of 2026-10-23). `re/` is ignored.
- Claude can run everything here: `adb` works without root on the host, and hidraw is user-accessible
  through the udev rule.
- The user must run anything that needs sudo (udev rules, system units).
- Don't send `upgrade`, firmware `transport` or `rotate` without asking. The first two flash the
  device and `rotate` persists.
- `ryuo.py play` blocks until stopped. It writes `$XDG_RUNTIME_DIR/ryuo-play.pid`. `ryuo.py stop`
  sends it SIGTERM, and on exit it sends `disconn`, so standby starts at once. A new `play` stops
  the old one first.
- `pgrep -f 'ryuo.py play'` also matches the Bash tool's own wrapper shell. Use
  `cat $XDG_RUNTIME_DIR/ryuo-play.pid` or `dumpsys media.player` to check what is running.
- Python stdout is buffered when not on a TTY. Use `python3 -u` to see `-v` output from a background run.

## Commands that establish state (all run on 2026-10-23)

```sh
adb devices -l                                   # TC2506… device usb:1-12 model:cm16
cat /sys/bus/usb/devices/1-12/{idVendor,idProduct,product}
for h in /sys/class/hidraw/*; do echo $h $(readlink -f $h/device | grep -o '1-12[^/]*'); done
adb shell 'cat /config/usb_gadget/g1/functions/hid.gs0/report_length; xxd /config/usb_gadget/g1/functions/hid.gs0/report_desc'
adb exec-out screencap -p > shot.png             # what the panel shows right now
adb shell settings get system screen_brightness  # 50 = standby level, 250 = brightness 100
adb shell ls -la /sdcard/pcMedia /sdcard/pcMediaPreset

./ryuo.py info                                   # prints the conn reply JSON
./ryuo.py push some.mp4                          # lands in /sdcard/pcMedia/
python3 -u ./ryuo.py -v play some.mp4            # keep running
./ryuo.py brightness 60                          # works from a second process while play runs
./ryuo.py stop                                   # standby in ~0.5 s; also fine with no player
adb shell dumpsys media.player | grep -c standby.mp4   # 2 = standby showing, 0 = user media

# watch the device parse what you send; filter out the 50 ms idle noise
adb logcat -c; ./ryuo.py -v info; adb logcat -d | grep -v 'read timeout\|select ret: 0\|sendStrTask' \
  | grep -i 'DataConvert\|SerialMsg\|MsgReceiver\|HSMain'
```

Traps:
- The device's own clock was wrong (2025-12-29) until the first heartbeat, so
  pre-heartbeat logcat timestamps don't match host time.
- `/sys/class/hidraw/hidraw4/device/report_descriptor` is root-only on the host. Read the
  descriptor from the gadget side with adb, as above.

## Success criteria

1. `./ryuo.py info` prints JSON containing `"product":"Ryuo IV Standard"`.
2. `play <file>` shows the file on the panel (`adb exec-out screencap -p`) within 3 s.
3. During play, `settings get system screen_brightness` returns `value × 2.5`.
4. `ryuo.py stop` puts the panel in standby within 1 s. Killing the player with SIGKILL gives
   standby within ~6 s; the heartbeat is the only thing keeping playback alive.
5. `play` started within 1 s of `stop`, or while another `play` runs, ends with
   `dumpsys media.player | grep -c standby.mp4` = 0.
6. For the daemon: suspend/resume and `adb kill-server` don't stop playback, or it recovers
   within 5 s.

## Open questions

- **Screensaver interruption**: confirm on the panel that `Screensaver.mp4` appears ~5 min into
  playback, and decide whether the daemon should suppress it (re-send config before 300 s, which
  restarts the video) or leave the burn-in protection alone.

- **Images**: `.png`/`.jpg` go to an ImageView in `setLayout1Path`. That's from the code; not
  tested on the panel. One such file is already on the device (`2026-01-26_20-04-35-774.png`).
- **Video formats**: only H.264 MP4 has been played. The Rockchip `media.c2` codecs probably handle
  HEVC as well, but that's untested and decides whether step 5 needs to transcode.
- **Is `conn` needed?** `play` sends it first like the Windows app does. Whether
  `waterBlockScreenId` works without it is untested; that matters for a daemon reconnecting quietly.
- **Sysinfo overlay**: `sysinfoDisplay` + a full `PcInfo` heartbeat (CPU/GPU temperature, load,
  fans) would show live stats over the video. Field names are in `entity/Pc*.java`; the sample
  payload in `MainActivity.java:349` (`re/src/home`) is a good template. Not tried.
- **Pump/fan control** (`fanLCD`, `turboPump`, sysfs `/sys/bus/i2c/drivers/aio_cooler/`): reachable
  but out of scope so far.
