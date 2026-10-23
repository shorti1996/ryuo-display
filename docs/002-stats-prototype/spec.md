# Live PC stats on the RYUO IV LCD: localhost prototype spec

Status: build spec, written 2026-10-23. Nothing in it is implemented yet.

Sources, in order of trust:

1. **APK code**: the local decompile in `re/src/home` (normal), `re/src/home-bad` (`--show-bad-code`,
   the only place `MainActivity`'s handler is complete) and `re/src/serial`. Line numbers below
   are from these trees. `MainActivity.java` always means the `home-bad` copy.
2. **Hardware results in this repo**: `docs/001-lcd-protocol/001_problem_and_handoff.md` ("the
   handoff") and `ryuo.py`, both checked on this unit (fw 1.0.10) on 2026-10-23.
3. **Third-party repos**, cloned read-only into `re/ext/` and never executed:
   FoxPodZ/ryuo-iv-screen (`re/ext/ryuo-iv-screen`, has hardware captures from Info Hub) and
   dragocz95/asus-ryuo-iv-linux (`re/ext/asus-ryuo-iv-linux`).

When these disagree, the APK code wins and §7 says so. Do not copy code out of `re/ext/`; its
licence terms (`LICENSE-ADDITIONAL-TERMS.md`) have not been reviewed. Write the code fresh.

Hard rules for whoever builds this:

- Never send `upgrade`, `transport`, `transported` or `rotate`. Never run an OTA flow.
- No commits. `docs/001-lcd-protocol/` stays unchanged.
- Never run code from `re/ext/`. If Python must run near it, use `python3 -I`.

---

## 1. Goal

A localhost prototype, `ryuod.py`, that keeps the cooler LCD showing a video with live Linux PC
stats over it, and a browser page at `http://127.0.0.1:8746/` where the user:

1. **picks which stats appear**, one per overlay slot, up to the device limit of **6 slots**;
2. **sets the overlay colours**: one title colour and one value/unit colour, which the firmware
   applies to all six slots, plus the optional "coverage" filter overlay with its opacity;
3. **chooses the position of each stat** by choosing its slot (1–6). Free positioning and
   alignment do not exist in this firmware: `PmSetting.align` and `position` are parsed and never
   read (§7, C11);
4. **sets brightness** on the true range **0–102** (102 = 255/255; 100 = 250/255);
5. **picks the background media** from the files already on the device (`/sdcard/pcMediaPreset/`
   and `/sdcard/pcMedia/`), with play mode Single, Cycle or Random.

While it runs, the daemon samples real Linux stats every second and sends them as the heartbeat,
so the numbers on the panel change once per second.

Out of scope for this prototype: uploading or transcoding media (the relayed notes say full-panel
video needs HEVC, `libx265 -tag:v hvc1`; that belongs to the upload step, not here), the tray icon,
split-screen mode, pump/fan control, systemd packaging, and the burn-in screensaver (left on, §2.6).

---

## 2. HID messages

Frame, headers and transport are as in the handoff (§Protocol). Every frame is one 1024-byte
report after escaping; the device silently drops anything longer. Every message body below is
compact JSON (`separators=(",", ":")`).

### 2.1 Device behaviour this design depends on

| fact | evidence |
|---|---|
| HomeUI goes to standby 5 s after the last message it was forwarded. Every forwarded message re-arms the timer. | `MsgReceiverManager.java:454-455, :490-491` |
| `conn` is answered by SerialService and **never forwarded to HomeUI**, so it neither keeps the screen alive nor is needed by HomeUI. | `SerialMsgReceiverHandler.java:195` |
| `STATE all` is forwarded at most once per 300 ms; extras are acked and dropped. `POST all` is not throttled, SerialService does not ack it, and HomeUI acks it with `{"status":{"fanLCD":"…"}}`. | `SerialMsgReceiverHandler.java:181-191, :338`; `MsgReceiverManager.java:240-262` |
| Overlay values change only when a PcInfo arrives, so the heartbeat rate is the refresh rate. | `MainActivity.java:132-213` |
| Exactly 6 slots; list index *i* drives slot *i+1*; `""` hides a slot; items past the 6th are ignored. A slot past the end of a shorter list keeps its old title and a frozen value, so **always send exactly 6 entries**. | `MainActivity.java:1454-1505` |
| The same item string in two slots only feeds the last one. | `MainActivity.java:1501, :1427` |
| `showInfo(null)` would NPE: `sysinfoDisplay` must never be null in a `waterBlockScreenId` (case 105 calls `showInfo(strs)` unguarded). | `MainActivity.java:444-451` |
| `preset` dereferences the stored config without a null check, so it must only follow a `waterBlockScreenId` sent since HomeUI started. A `preset` with `settings: null` loads the `defult` drawable; always send a settings object. | `MainActivity.java:672-690, :1028-1035` |
| Brightness applies only while `isBlockScreen` is true, which `waterBlockScreen {"enable":true}` sets. Device value = `(int)(value × 2.5)`, no upper clamp, so 102 → 255. | `MainActivity.java:546-555, :557-563`; `MsgReceiverManager.java:520-525` |
| `power resume` restores the brightness HomeUI saved, re-applies the stored config through case 105 and hides standby. | `MainActivity.java:602-616` |
| Temperatures are converted to °F **on the device** when the unit is Fahrenheit: the getters compute `t × 1.8 + 32` and truncate to int. Always send Celsius. | `entity/PcCpu.java:40-45`, `PcGpu.java:48-53`, `PcMd.java:10-15`, `Disk.java:48-53` |
| A fractional number in an int field makes Gson throw; `JsonUtils.stringToObject` logs `Exception---stringToObject--fail--` and returns null, and the whole sample is dropped. | `util/JsonUtils.java:25-31`; `MainActivity.java:1578-1585` |
| `gpu.temperature` is a String passed to `Float.parseFloat` on the UI thread with no catch. If `gpu` is present, `gpu.temperature` must be present and numeric. | `entity/PcGpu.java:48-53`; `MainActivity.java:174-180` |
| `Color.parseColor` runs on the UI thread with no catch; both colours must be non-empty or neither is applied. Accepts `#RRGGBB` and `#AARRGGBB`. | `MainActivity.java:1398-1409` |

### 2.2 Messages for each user action

"Repaint" means the video keeps playing. "Restart" means case 105 runs: `mainParent` is hidden,
the player is released and `media[0]` starts from the beginning, and the 300 s burn-in timer
re-arms.

| user action | message | body | effect |
|---|---|---|---|
| change slots, colours or filter | `POST preset` | `{"id":"Customization","sysinfoDisplay":[6 strings],"settings":<Settings>}` | **repaint**; persists into HomeUI's stored config, so it survives reconnect and `power resume` (`MainActivity.java:672-690`) |
| set brightness | `POST brightness` | `{"value":<int 0-102>}` | **repaint** (backlight only) |
| pick media / play mode | `POST waterBlockScreenId` | `<ScreenConfig>` with the current slots and settings | **restart** (intended: new media) |
| °C / °F | `POST temperature` | `{"value":"Celsius"}` or `{"value":"Fahrenheit"}` | **repaint**, takes effect on the next heartbeat. Any other string freezes every temperature slot (`MsgReceiverManager.java:358-367`), so the daemon only sends these two. |
| every 1 s | `POST all` | `<PcInfo>` | **repaint** of values; resets the 5 s timer; HomeUI acks |
| daemon exit | `POST disconn` | none | standby within ~0.1 s |

`Settings` (Full Screen mode takes a single object, not an array):

```json
{"titleColor":"#E5252B","contentColor":"#FFFFFF","filter":{"value":null,"opacity":100},"badges":[]}
```

`filter.value` null clears the filter. Any non-empty string (the daemon sends `"Smoke"`) shows the
same bundled `coverage` animation above the text, fading from alpha 1.0 to `opacity`/100 over
300 ms (`MainActivity.java:1028-1066`). `opacity` is an int 0–100.

`ScreenConfig` (as in `ryuo.py media_config`, with a real settings object and 6 slots):

```json
{"id":"Customization","screenMode":"Full Screen","ratio":"2:1","playMode":"Single",
 "media":["RYUO_IV_HW_Info_04.mp4"],
 "sysinfoDisplay":["CPU Temperature","GPU Temperature","Fan Speed Disk R MB/s","Date&Time","",""],
 "settings":{"titleColor":"#E5252B","contentColor":"#FFFFFF","filter":{"value":null,"opacity":100},"badges":[]},
 "timeZone":"Europe/Warsaw"}
```

Not used, and why:

- `POST sysinfoDisplay {"items":[…]}` repaints but does **not** update the stored config, so the
  next reconnect or `power resume` brings the old slots back (`MainActivity.java:332-337` vs
  `:649-662`). `preset` does the same job and persists.
- `POST config` (the bundle Info Hub sends) restarts the video like `waterBlockScreenId`, also
  rewrites `fanLCD` (pump fan display state), and reads every key with `getJSONObject`/`getString`,
  so a missing key aborts it halfway with brightness already applied (`MsgReceiverManager.java:393-433`).
  The separate commands below are the sequence already verified on this unit.
- `POST spec`: the names are stored and never drawn (`MainActivity.java:691-693`, case 115 only logs).
- Periodic `waterBlockScreenId` re-sends (dragocz95 does one every ~60 s): each restarts the video.

### 2.3 PcInfo heartbeat

Sent as `POST all` once per second, built from the latest sample:

```json
{"timestamp":1792771200000,
 "cpu":{"load":12,"usage":48,"temperature":50.4,"speedAverage":4410,"voltage":0.0},
 "gpu":{"load":2,"temperature":37,"speed":240,"power":27,"voltage":0.0},
 "memory":{"load":41,"speed":6000},
 "disk":{"temperature":43},
 "motherboard":{"temperature":30.0},
 "fans":[{"name":"Disk R MB/s","value":12},{"name":"Net Down KB/s","value":840}]}
```

Rules:

- `timestamp` is host time in ms and is always present. A missing one sets the device clock to
  1970; one more than 5 s off resets the device clock (`MainActivity.java:148-152`).
- Every field that is an int in `entity/Pc*.java` is sent as `int(round(x))`. Float fields are
  `cpu.temperature`, `cpu.voltage`, `gpu.voltage`, `memory.temperature`, `motherboard.temperature`;
  send voltages rounded to 3 decimals, because the panel prints the Java float as-is.
- `gpu` is always present with a numeric `temperature` (0 when no GPU source exists).
- `fans[]` carries only the entries whose `"Fan Speed <name>"` item is in a slot, as `{name, value}`
  (`type` and `onBoard` are never read). This keeps the frame small.
- Fields HomeUI never displays (`network.*`, `cpu.power`, `cpu.fanAverage`, `gpu.fan`, `gpu.usage`,
  `memory.total/used`, `disk.load/total/used/activity/readSpeed/writeSpeed`, `timeZone`) are left out.
- The frame is size-checked before sending. Measured with the current `ryuo.py` codec: the example
  above is 429 bytes, and the worst case under these rules (6 fans, 16-character names, 6-digit
  values) is 616 bytes, so the 1024-byte cap is not reached. If it ever
  is, the daemon drops the frame, logs it and sends `{"timestamp":…}` instead so the screen stays up.

### 2.4 Startup sequence

Run on daemon start and after every reconnect (§2.5). Each step waits for the SerialService
`1 200` ack, or 0.3 s, before the next.

| # | message | why |
|---|---|---|
| 1 | open `/dev/hidrawN` | found by PID `1C76` with VID `0B05` or `1C75` (§4.1) |
| 2 | `POST conn {"OS":"Linux"}`, read for 1.5 s | media lists and firmware version for the UI. Not needed by HomeUI (§2.1). The reply can span several reports; reassemble it (§4.1). |
| 3 | `POST temperature {"value":"<state.tempUnit>"}` | resets a unit another client may have left |
| 4 | `POST waterBlockScreen {"enable":true}` | sets `isBlockScreen`, without which brightness is ignored |
| 5 | `POST waterBlockScreenId <ScreenConfig>` | media, 6 slots and settings from state. This is also what makes a later `preset` safe. |
| 6 | `POST power {"event":"resume"}` | **power-resume trick**: hides standby even if a `disconn` was sent less than 5 s ago (handoff item 7, `ryuo.py:193-195`) |
| 7 | `POST brightness {"value":<state.brightness>}` | **brightness after config**: steps 4 and 6 restore HomeUI's saved brightness, which is 50/255 after a standby (handoff item 6, `ryuo.py:196-198`) |
| 8 | first `POST all` immediately, then every 1.0 s | keeps the screen out of standby |

Steps 5 and 6 both run case 105, so the video starts twice in about 0.5 s. That is what
`ryuo.py play` does today and it is verified to end on the user's media.

### 2.5 Reconnect and recovery

The device worker re-runs the full startup sequence when any of these happens:

1. **USB gone**: `os.write`/`os.read` raises `OSError`. Close the fd, set `connected=false`, rescan
   `/sys/class/hidraw/*/device/uevent` every 2 s, and on a match run §2.4.
2. **Heartbeat gap**: more than 4.5 s of `CLOCK_BOOTTIME` since the last successful heartbeat write
   (suspend/resume, or a stalled worker). `CLOCK_MONOTONIC` stops during suspend, so it cannot see this.
   After a gap over 5 s HomeUI is already in standby and would restore a dim brightness on its own
   reconnect (`MainActivity.java:649-663`).
3. **HomeUI silent**: no HomeUI ack (a reply whose body has `"status"`) for 5 consecutive `POST all`
   while writes succeed. This covers a HomeUI restart, after which its stored config is null and a
   `preset` would NPE. Rate-limited to once per 30 s. Untested on hardware (§7, Q1).

### 2.6 Burn-in screensaver: left alone

Every 300 s after a `waterBlockScreenId`, at the next clip end (or 7 s still-image advance), HomeUI
hides all 6 slots and plays `Screensaver.mp4` for 2000 ms, then restarts the user's media
(`MainActivity.java:218-297, :1625-1642`). Only a new `waterBlockScreenId` resets the timer, and it
restarts the video, so the daemon does not suppress it. The UI shows a one-line note about it.

---

## 3. Stat mapping

Item string = the exact string in `sysinfoDisplay` (case-sensitive). Title = what the panel draws
above the value (`subTitle` map, `MainActivity.java:977-991`); the browser preview uses it too.
Unit = the literal unit text from `MainActivity.java:160-213`. Linux sources were checked on this
PC on 2026-10-23 (Ryzen 9 9950X3D, RTX 5080 + Raphael iGPU, NVMe, Gigabyte board).

### 3.1 Firmware items

| item string | title on panel | PcInfo path (type) | unit | Linux source | this PC |
|---|---|---|---|---|---|
| `CPU Load` | CPU | `cpu.load` (int) | `%` | `/proc/stat` line `cpu`: busy share over the last sample, `100 × (Δtotal − Δidle − Δiowait) / Δtotal` | yes |
| `CPU Usage` | CPU | `cpu.usage` (int) | `%` | `/proc/stat` lines `cpuN`: busiest single core over the last sample (our choice, so it differs from CPU Load) | yes |
| `CPU Temperature` | CPU | `cpu.temperature` (float, °C) | `°C`/`°F` | hwmon `k10temp` label `Tctl`; `zenpower` `Tdie`; `coretemp` `Package id 0`; fallback `acpitz` temp1. `tempN_input` / 1000 | k10temp Tctl, 50 °C |
| `CPU Speed Average` | CPU | `cpu.speedAverage` (int, MHz) | `MHZ` | mean of `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq` / 1000; fallback `cpu MHz` in `/proc/cpuinfo` | yes |
| `CPU Voltage` | CPU | `cpu.voltage` (float, V) | `V` | hwmon `nct67*`/`it87` `in0_input` (label `Vcore` if labelled) / 1000 | **no source** (no Super-I/O driver loaded; `gigabyte_wmi` has temps only) |
| `GPU Load` | GPU | `gpu.load` (int) | `%` | `nvidia-smi` `utilization.gpu`; else amdgpu `/sys/class/drm/cardN/device/gpu_busy_percent` | nvidia-smi |
| `GPU Usage` | GPU | firmware reads `gpu.load` | `%` | same as GPU Load; the UI marks it "same as GPU Load" | — |
| `GPU Temperature` | GPU | `gpu.temperature` (String; send a number) | `°C`/`°F` | `nvidia-smi` `temperature.gpu`; else amdgpu hwmon label `edge` | nvidia-smi, 37 °C |
| `GPU Speed` | GPU | `gpu.speed` (int, MHz) | `MHZ` | `nvidia-smi` `clocks.current.graphics`; else amdgpu hwmon `freq1_input` / 1e6 | nvidia-smi |
| `GPU Power` | GPU | `gpu.power` (int, W) | **`°C`/`°F`** (firmware bug) | `nvidia-smi` `power.draw`; else amdgpu `power1_average` or `power1_input` / 1e6 | nvidia-smi. The UI offers `Fan Speed GPU W` (unit RPM) as the alternative. |
| `GPU Voltage` | GPU | `gpu.voltage` (float, V) | `V` | amdgpu hwmon label `vddgfx` `in0_input` / 1000. nvidia-smi has no voltage query on GeForce. | **no source** for the RTX 5080 (the amdgpu here is the iGPU) |
| `Memory Utilization` | Memory Utilization | `memory.load` (long) | `%` | `/proc/meminfo`: `100 × (MemTotal − MemAvailable) / MemTotal` | yes |
| `Memory Frequency` | Memory Frequency | `memory.speed` (int, MHz) | `MHZ` | no unprivileged Linux source (`dmidecode` needs root). Static value from state `memoryMHz`, entered in the UI. Hidden from the picker while it is 0. | user-entered |
| `Hard Disk Temperature` | Hard Disk Temperature | `disk.temperature` (int, °C) | `°C`/`°F` | hwmon `nvme` label `Composite`; else `drivetemp` temp1 | nvme Composite, 44 °C |
| `Motherboard Temperature` | Motherboard | `motherboard.temperature` (float, °C) | `°C`/`°F` | hwmon `nct67*` label `SYSTIN`; else `gigabyte_wmi` temp1; else `asus_ec_sensors` label `Motherboard`; overridable with state `sensors.motherboard` = `"<hwmon name>:tempN"` | gigabyte_wmi temp1 (unlabelled; §7, Q6) |
| `Date&Time` | weekday + day, e.g. `THU 23` | none (device clock, kept right by `timestamp`) | seconds `ss` | none | yes |

Not offered: `GPU Frequency`, `Date` and `Time` get values but have no `subTitle` entry, so they draw
under a blank title (`MainActivity.java:137-138, :181` vs `:977-991`).

On the panel all CPU items are titled "CPU" and all GPU items "GPU"; only the unit tells them
apart. The picker lists the full item string; the preview shows the panel title.

### 3.2 `Fan Speed <label>` entries

Any slot item `"Fan Speed " + X` draws title X (`info.substring(10)`), and any heartbeat entry
`fans[i] = {"name": X, "value": int}` sets its value, with the fixed unit `RPM`
(`MainActivity.java:209-213, :1496-1497`; FoxPodZ confirmed custom labels on fw 1.0.10 hardware).
The match is exact and case-sensitive. The value must be an int.

The scale goes into the label, because the unit slot always says RPM:

| item string | title on panel | value | Linux source |
|---|---|---|---|
| `Fan Speed Disk R MB/s` | Disk R MB/s | int MB/s (10⁶ B) | `/proc/diskstats` field 6 (sectors read) × 512, summed over the whole disks listed in `/sys/block/` that have a `device` link (excludes `loop*`, `zram*`, `dm-*`, partitions), Δ per second |
| `Fan Speed Disk W MB/s` | Disk W MB/s | int MB/s | same, field 10 (sectors written) |
| `Fan Speed Net Down KB/s` | Net Down KB/s | int KB/s (1024 B) | `/proc/net/dev` receive bytes, summed over interfaces that have `/sys/class/net/<if>/device` (here `enp14s0`, `wlp13s0`; excludes `lo`, bridges, `veth*`, `docker0`, `wg-*`), Δ per second |
| `Fan Speed Net Up KB/s` | Net Up KB/s | int KB/s | same, transmit bytes |
| `Fan Speed GPU W` | GPU W | int W | same source as GPU Power; exists because `GPU Power` is drawn with a °C unit |
| `Fan Speed <hwmon fan label>` | that label | int RPM | every readable hwmon `fanN_input`, named by `fanN_label` or `"<chip> fanN"` | none on this PC: no hwmon exposes `fan*_input` |

Label rules enforced by the daemon: 1–16 characters from `[A-Za-z0-9 ./%-]`. The title font
(`trade.ttf`) is Latin-1 and the right-column slots are centred on x=1994, so long labels overflow
the panel edge (§7, Q4).

### 3.3 Sampling

- One sampler thread, every 1.0 s, writes a snapshot `{item string: value}` under a lock.
  The device worker reads the latest snapshot when it builds each heartbeat.
- Sources are probed once at start (hwmon names and labels, `shutil.which("nvidia-smi")`, amdgpu
  cards) and re-probed every 60 s, because hwmon numbers change across boots and hotplug.
- `nvidia-smi --query-gpu=temperature.gpu,utilization.gpu,clocks.current.graphics,power.draw
  --format=csv,noheader,nounits -i 0` with a 1.5 s timeout. A `[N/A]` field or a timeout marks
  that field unavailable; after 3 failures in a row, retry only every 30 s.
- GPU choice: nvidia-smi if present, else the amdgpu card with the largest
  `mem_info_vram_total`. Intel GPUs have no source.
- An item with no source sends 0 and is shown as unavailable in the picker; it can still be chosen
  (the panel shows 0).

---

## 4. Architecture

```
ryuod.py  (python3, stdlib only)
 ├─ device worker thread   owns the hidraw fd: startup sequence, 1 s POST all, command queue,
 │                         reply reassembly, reconnect (§2.4, §2.5)
 ├─ sampler thread         1 s Linux stats snapshot (§3.3)
 ├─ ThreadingHTTPServer    127.0.0.1:8746: GET / → web/index.html, /api/* (§5)
 └─ main thread            signals, pidfile, state.json
ryuo_proto.py              codec, Ryuo device, builders (used by ryuod.py and ryuo.py)
ryuo.py                    existing CLI, now importing ryuo_proto; behaviour unchanged
web/index.html             single file, vanilla JS, no CDN
```

### 4.1 `ryuo_proto.py`

Extracted from `ryuo.py`; `ryuo.py` imports it and every existing subcommand keeps its behaviour.

- `encode(payload: bytes) -> bytes`, `decode(frame: bytes) -> str`: moved verbatim.
- `class ReplyBuffer`: accumulates raw reports and yields complete frames. A frame runs from one
  `0x5A` to the next `0x5A`; replies may span reports (FoxPodZ saw a 1227-byte `conn` reply over two
  reports). A candidate that fails to decode is skipped up to, but not including, its closing
  `0x5A`, since that byte may open the next frame. `Ryuo.read_replies` uses it, which also fixes
  `ryuo.py info` for long media lists.
- `parse_reply(text) -> (status: int, ack: int|None, body: dict|None)` for `1 200\r\nAckNumber=N…`.
- `find_hidraw() -> str | None`: matches `HID_ID=0003:00000B05:00001C76` or
  `HID_ID=0003:00001C75:00001C76`. Never VID alone: `0B05:19AF` is the motherboard Aura controller.
  `ryuo.py` keeps its `sys.exit` message when it gets None.
- `class Ryuo(path)`: `send(method, cmd, content=None, wait=0.3) -> list[str]`, `close()`.
  Raises `FrameTooLarge(cmd, size)` instead of `sys.exit` for frames over 1024 bytes; `ryuo.py`
  catches it and exits with the same message as today. `heartbeat()` keeps sending
  `STATE all {"timestamp":…}` so `ryuo.py play` is unchanged.
- Builders: `screen_config(media, play_mode, ratio, items, settings)` (6 items, padded with `""`),
  `settings(title_color, content_color, filter_on, opacity)`, `preset(items, settings)`,
  `pc_info(snapshot, items, now_ms)` (§2.3 rules), `local_timezone()` (the `/etc/localtime` logic
  from `ryuo.py media_config`). `ryuo.py media_config` becomes a thin call to `screen_config` with
  `settings=None` and the user's `--sysinfo` list as given, to keep its current behaviour.
- Pidfile helpers, moved from `ryuo.py`: `PIDFILE = $XDG_RUNTIME_DIR/ryuo-play.pid`,
  `running_driver()`, `stop_driver(timeout=3.0)`. `running_driver()` accepts a cmdline containing
  `ryuod` or containing both `ryuo` and `play`. `ryuo.py`'s `running_player`/`stop_player` become
  aliases.
- Constants: `ITEMS` (§3.1 table: item, title, unit), `SLOTS = 6`, `BRIGHTNESS_MAX = 102`,
  `REPORT_LEN = 1024`, `PIDS = {(0x0B05, 0x1C76), (0x1C75, 0x1C76)}`.

### 4.2 `ryuod.py`

- CLI: `ryuod.py [-v] [--port 8746] [--state PATH] [--heartbeat {post,state}]`. `--heartbeat state`
  falls back to `STATE all` (verified in `ryuo.py`) and disables recovery trigger 3 in §2.5.
- **Start**: `stop_driver()` (newest wins, the same rule `ryuo.py play` uses), write the pidfile,
  load state, start the sampler, start the device worker, bind HTTP. If the port is taken, exit 1
  with a message and remove the pidfile.
- **Device worker**: the only code that touches the fd. HTTP handlers put
  `(method, cmd, body, Future)` on a queue and wait up to 3 s for the result. Rules:
  - at least 125 ms between writes (≤ 8 frames/s; the device handles about 8.5 replies/s);
  - consecutive queued `preset`s collapse into the newest one;
  - a heartbeat is due every 1.0 s of `CLOCK_BOOTTIME` and goes ahead of queued commands when late;
  - after each write, read replies for up to 250 ms through `ReplyBuffer`, and keep draining
    between writes so long replies do not stack up;
  - when disconnected, commands are not sent; the HTTP layer saves the state and answers
    `applied: false` (§5).
- **Shutdown** on SIGTERM or SIGINT: stop the HTTP server, let the worker send `POST disconn`
  (standby at once), close the fd, remove the pidfile only if it still holds our pid, exit 0.
  If another driver took over (pidfile holds a different live pid), skip `disconn`.
- **State**: `~/.config/ryuo/state.json` (`$XDG_CONFIG_HOME` if set), written atomically
  (`state.json.tmp`, `fsync`, `rename`) after each accepted change. Schema:

  ```json
  {"version":1,
   "media":["RYUO_IV_HW_Info_04.mp4"],"playMode":"Single","ratio":"2:1",
   "items":["CPU Temperature","GPU Temperature","Fan Speed Disk R MB/s","Date&Time","",""],
   "titleColor":"#E5252B","contentColor":"#FFFFFF","filter":{"on":false,"opacity":100},
   "brightness":100,"tempUnit":"Celsius","memoryMHz":0,
   "sensors":{"motherboard":"auto"}}
  ```

  With no file: `media` = the first name in the `conn` reply's `media.preset` list (sorted),
  `items` = `["CPU Temperature","CPU Load","GPU Temperature","GPU Load","Memory Utilization","Date&Time"]`,
  the rest as shown. Unknown keys are ignored; an unreadable file is renamed to `state.json.bad`
  and defaults are used.
- **Logging**: `-v` prints every sent frame (`>> POST preset {...}`) and reply, like `ryuo.py -v`.
  Without `-v`: start, connect, disconnect, recovery and errors only.

### 4.3 `web/index.html`

One file, vanilla JS, no external requests (no CDN, no web fonts; the vendor fonts stay on the
device). Works at 1280 px wide and at phone width.

- **Status line**: connected or not, firmware, last heartbeat age, last HomeUI ack age, last error.
- **Panel preview**: a 2240:1080 box drawn at the slot geometry below, with each slot's panel title
  and the latest value from `GET /api/stats` (polled every 1 s), in the chosen colours. Geometry
  (panel px, from `res/layout/activity_main.xml:94-315`; title/value/unit font px):

  | slot | where | anchor | title top | sizes |
  |---|---|---|---|---|
  | 1 | left, upper | left edge x=120 | 274 | 76/120/60, unit right of value |
  | 2 | left, lower | left edge x=120 | 662 | 76/120/60, unit right of value |
  | 3 | right column, top | centred x=1994 | 202 | 56/80/40 |
  | 4 | right column, middle | centred x=1994, unit right edge x=2189 | 419 | 76/110/55, unit under value |
  | 5 | right column, bottom | centred x=1994 | 767 | 56/80/40 |
  | 6 | centre-right, lower | left edge x=1368 | 656 | 42/64/33, unit under value |

- **Slots**: six selects labelled with the "where" column, options from `GET /api/catalog` grouped
  CPU / GPU / Memory / Storage / Board / Clock / Custom (unit RPM), plus "(empty)". An item already
  used in another slot is disabled. Unavailable items show "(no source)".
- **Colours**: two `<input type=color>` (title; value and unit), the filter checkbox and an
  opacity slider 0–100. Slot and colour changes go to `POST /api/overlay` 300 ms after the last edit.
- **Brightness**: slider 0–102 with a tick at 100 labelled "100 = 98 %", sent 150 ms after the last
  move.
- **Media**: list from `GET /api/media` in two groups (preset, custom), multi-select, play mode
  select, a Refresh button and a "Play" button labelled "restarts the video".
- **Units**: °C / °F toggle and the memory MHz field (`POST /api/prefs`).
- A one-line note: "The overlay hides for about 2 s every 5 min (device burn-in protection)."

---

## 5. HTTP API

Bound to `127.0.0.1:8746` only. Every response is JSON with `Content-Type: application/json`,
except `GET /` and `GET /index.html` (the page).

Request hygiene, so other web pages cannot drive the cooler:

- `Host` must be `127.0.0.1:8746` or `localhost:8746`, else **403** (blocks DNS rebinding).
- `POST` requires `Content-Type: application/json`, else **415**. No CORS headers are sent and
  `OPTIONS` returns 405, so a cross-origin page cannot send such a request.
- Bodies over 16 KiB → **413**. Invalid JSON → **400**.

Errors: `{"ok":false,"error":"<message>"}` with 400 (validation), 403, 404, 413, 415, or 504 (the
device worker did not answer within 3 s). Validation happens before anything is queued, so a 400
sends nothing to the device.

A POST that passes validation is saved to state. If the device is connected it is sent and the
response has `"applied":true`; otherwise `"applied":false` and the change is sent by the startup
sequence on reconnect. `"acked"` is true when the SerialService `1 200` ack for that frame arrived.

### `GET /api/state`

```json
{"ok":true,
 "device":{"connected":true,"hidraw":"/dev/hidraw4","vid":"0b05","pid":"1c76",
           "firmware":"V1.0.10","product":"Ryuo IV Standard",
           "lastHeartbeatMs":420,"lastHomeuiAckMs":430,"recoveries":0,"lastError":null},
 "config":{"media":["RYUO_IV_HW_Info_04.mp4"],"playMode":"Single","ratio":"2:1",
           "items":["CPU Temperature","GPU Temperature","Fan Speed Disk R MB/s","Date&Time","",""],
           "titleColor":"#E5252B","contentColor":"#FFFFFF","filter":{"on":false,"opacity":100},
           "brightness":100,"tempUnit":"Celsius","memoryMHz":0},
 "limits":{"slots":6,"brightnessMax":102,"frameMax":1024,"lastHeartbeatBytes":548}}
```

`lastHeartbeatMs` and `lastHomeuiAckMs` are ages in ms; null if none yet.

### `GET /api/stats`

```json
{"ok":true,"sampledAt":1792771200000,
 "values":{"CPU Temperature":{"value":50.4,"unit":"°C","available":true},
           "CPU Voltage":{"value":0,"unit":"V","available":false},
           "Fan Speed Disk R MB/s":{"value":12,"unit":"RPM","available":true}},
 "lastPcInfo":{"timestamp":1792771200000,"cpu":{"load":12}}}
```

`values` has one entry per catalog item. `unit` is what the panel draws, so it follows `tempUnit`
and the value is converted for display in the preview only (the device gets Celsius).
`lastPcInfo` is the exact body of the last heartbeat sent.

### `GET /api/catalog`

```json
{"ok":true,"items":[
  {"item":"CPU Temperature","title":"CPU","unit":"°C","group":"CPU","available":true,"source":"k10temp Tctl","note":null},
  {"item":"GPU Usage","title":"GPU","unit":"%","group":"GPU","available":true,"source":"nvidia-smi","note":"same value as GPU Load (firmware reads gpu.load)"},
  {"item":"GPU Power","title":"GPU","unit":"°C","group":"GPU","available":true,"source":"nvidia-smi","note":"firmware draws a °C unit; Fan Speed GPU W shows RPM instead"},
  {"item":"Fan Speed Disk R MB/s","title":"Disk R MB/s","unit":"RPM","group":"Custom","available":true,"source":"/proc/diskstats","note":"unit slot always reads RPM"}]}
```

### `GET /api/media[?refresh=1]`

```json
{"ok":true,"source":"conn","fetchedAt":1792771200000,
 "preset":["RYUO_IV_HW_Info_01.mp4","RYUO_IV_HW_Info_02.mp4"],
 "custom":["2026-01-26_22-07-49-639.mp4","2026-01-26_20-04-35-774.png"]}
```

Cached from step 2 of the startup sequence. `refresh=1` re-sends `POST conn` through the worker
(harmless mid-session: SerialService answers it and HomeUI never sees it). If the `conn` reply does
not parse, the daemon falls back to `adb shell ls -1 /sdcard/pcMediaPreset /sdcard/pcMedia` and
returns `"source":"adb"`. Both failing → 504.

### `POST /api/overlay`

Request (every key optional; missing keys keep their current value):

```json
{"items":["CPU Temperature","GPU Temperature","Fan Speed Disk R MB/s","Date&Time","",""],
 "titleColor":"#E5252B","contentColor":"#FFFFFF","filter":{"on":true,"opacity":60}}
```

Validation: `items` is a list of at most 6 strings, padded to 6 with `""`; each non-empty entry is
a catalog item or `"Fan Speed "` + a label passing §3.2 rules; no duplicates among non-empty
entries. Colours match `^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$`. `opacity` is an int 0–100.

Sends: `POST preset` (§2.2). Response:

```json
{"ok":true,"applied":true,"acked":true,"sent":["POST preset"],"restartsVideo":false,"config":{…}}
```

### `POST /api/brightness`

Request `{"value":85}`; int 0–102, else 400. Sends `POST brightness {"value":85}`. Response
`{"ok":true,"applied":true,"acked":true,"sent":["POST brightness"],"restartsVideo":false,"deviceLevel":212}`
where `deviceLevel = int(value × 2.5)` capped at 255.

### `POST /api/media/select`

Request `{"media":["RYUO_IV_HW_Info_04.mp4"],"playMode":"Single"}`. `media`: 1–20 names, each in
the last media list; `playMode` one of `Single`, `Cycle`, `Random` (any other string leaves a black
screen: case 102 falls through with no video). The resulting `waterBlockScreenId` frame must fit
1024 bytes, else 400 `"playlist too long for one HID report"`.

Sends: `POST waterBlockScreenId <ScreenConfig>` with the current items and settings. Response
`{"ok":true,"applied":true,"acked":true,"sent":["POST waterBlockScreenId"],"restartsVideo":true,"config":{…}}`.

### `POST /api/prefs`

Request (keys optional): `{"tempUnit":"Fahrenheit","memoryMHz":6000,"sensors":{"motherboard":"gigabyte_wmi:temp1"}}`.
`tempUnit` is `Celsius` or `Fahrenheit`; `memoryMHz` an int 0–20000; `sensors.motherboard` is
`"auto"` or `"<hwmon name>:tempN"` that exists. Sends `POST temperature` only when `tempUnit`
changed; the other keys affect the next heartbeat. Response like `/api/overlay`, with
`"sent":[]` when nothing was sent.

---

## 6. Acceptance checks

Run from the repo root with the daemon in a second terminal: `python3 -u ./ryuod.py -v`.
`S=http://127.0.0.1:8746` and `J='Content-Type: application/json'`. "Logcat window" means
`adb logcat -c` before the action and `adb logcat -d -s HSMainActivity MsgReceiverManager jsonUtil`
after it.

### Codec and CLI

1. **Extraction keeps the frames byte-identical.** With `ryuo_proto.encode` and the `ryuo.py`
   header format (`SeqNumber`, `ContentLength`, `ContentType=json`), these frames, computed with
   today's `ryuo.py` on 2026-10-23, must have these lengths and SHA-256:

   | seq | message | bytes | sha256 |
   |---|---|---|---|
   | 1 | `POST brightness {"value":60}` | 87 | `b68c81480d02a72108d32ed9a47494fc5939b5f84eaf3147e37881e52dbf8355` |
   | 2 | `POST disconn` (no body) | 71 | `ebbd91e285e71fb74f59cc062e41076fd9e5b98e5cce12a36315321b6da8ede1` |
   | 3 | `POST preset {"id":"Customization","sysinfoDisplay":["CPU Temperature","","","","",""],"settings":{"titleColor":"#E5252B","contentColor":"#FFFFFF","filter":{"value":null,"opacity":100},"badges":[]}}` | 259 | `3a998ec812203e785388ece02b2a2f4b770669b401643f0a55ed11db62f4f7fc` |

2. **`ryuo.py` still works** (daemon not running): `./ryuo.py info` prints JSON with
   `"product":"Ryuo IV Standard"`; `./ryuo.py play RYUO_IV_HW_Info_04.mp4` shows it within 3 s
   (`adb exec-out screencap -p > shot.png`); `./ryuo.py stop` gives
   `adb shell dumpsys media.player | grep -c standby.mp4` = 2 within 1 s.

### Startup and brightness

3. Start the daemon within 1 s of `./ryuo.py stop`. Within 3 s: `curl -s $S/api/state` has
   `"connected":true`, `adb shell dumpsys media.player | grep -c standby.mp4` = 0, and
   `adb shell settings get system screen_brightness` = `int(state.brightness × 2.5)`.
4. `curl -s -H "$J" -d '{"value":102}' $S/api/brightness` → `screen_brightness` = 255.
   `{"value":100}` → 250. `{"value":40}` → 100. `{"value":103}` and `{"value":-1}` → HTTP 400 and no
   new `brightness` line in logcat.

### Overlay

5. **Preset repaints without restarting the video.** In a logcat window:
   `curl -s -H "$J" -d '{"items":["CPU Temperature","GPU Temperature","Memory Utilization","Date&Time","Fan Speed Disk W MB/s",""]}' $S/api/overlay`.
   Expect `MSG_PRESET_CONFIG` and five `showInfo---<item>` lines, and zero `MSG_REFRESH_CONFIG`
   lines. `setVideoPath` lines appear only if the clip happened to end inside the window (Single
   mode replays it); run the check on a clip longer than the window. A screencap 2 s later shows
   the five titles at the slot positions in §4.3.
6. **Values update every second.** Over a 10 s logcat window,
   `grep -c 'setInfoValue---key:CPU Temperature'` is between 8 and 12, and the logged value is within
   ±3 of `cat /sys/class/hwmon/hwmon*/temp1_input` for the hwmon whose `name` is `k10temp`, divided
   by 1000. Zero `stringToObject--fail` lines.
7. **Custom label.** Run `dd if=/dev/zero of=<scratch>/ryuo-io.bin bs=1M count=2000 oflag=direct`
   while slot 5 holds `Fan Speed Disk W MB/s`. During the copy, `curl -s $S/api/stats` shows that item
   above 0, and logcat has `setInfoValue---key:Fan Speed Disk W MB/svalue:<n>unit:RPM` with n > 0.
   Delete the file afterwards.
8. **Colours.** `curl -s -H "$J" -d '{"titleColor":"#00FF00","contentColor":"#FFFF00"}' $S/api/overlay`
   → logcat `changeTextViewsFontColor---title:ff00ff00 content:ffffff00`, no `MSG_REFRESH_CONFIG`.
   `{"titleColor":"green"}` → HTTP 400 and no `MSG_PRESET_CONFIG`.
9. **Validation.** 7 items, a duplicate item, `"Fan Speed "` + 17 characters, and `"GPU Frequency"`
   each → HTTP 400, nothing in logcat.
10. **°F.** `curl -s -H "$J" -d '{"tempUnit":"Fahrenheit"}' $S/api/prefs` → within 2 s logcat shows
    `CPU Temperature` with unit `°F` and a value of about `°C × 1.8 + 32`, while
    `/api/stats` `lastPcInfo.cpu.temperature` is still Celsius. Set it back to Celsius.

### Media

11. `curl -s $S/api/media` lists the same names as `adb shell ls /sdcard/pcMediaPreset /sdcard/pcMedia`.
12. `curl -s -H "$J" -d '{"media":["RYUO_IV_HW_Info_02.mp4"],"playMode":"Single"}' $S/api/media/select`
    → `"restartsVideo":true`; logcat has `MSG_REFRESH_CONFIG` and `setVideoPath:sdcard/pcMediaPreset/RYUO_IV_HW_Info_02.mp4`;
    the overlay items from check 5 are still on screen. A name not in the list → HTTP 400.

### Lifecycle and recovery

13. **SIGTERM.** `kill -TERM $(cat $XDG_RUNTIME_DIR/ryuo-play.pid)` → the daemon exits 0, the
    pidfile is gone, and `grep -c standby.mp4` on `dumpsys media.player` = 2 within 1 s.
14. **Never two drivers.** With the daemon running, `./ryuo.py play RYUO_IV_HW_Info_01.mp4` makes
    the daemon exit and the pidfile holds the new pid; the panel ends on that file
    (`grep -c standby.mp4` = 0). Then start the daemon again: the `play` process exits, and the
    daemon owns the screen within 3 s.
15. **State persists.** Change items, colours, brightness and media; restart the daemon;
    `GET /api/state` `config` is identical and the panel shows the same thing.
16. **`adb kill-server`** while running: the overlay keeps updating (HID does not use adb).
17. **Suspend/resume** (the user runs `systemctl suspend` and wakes the PC): within 5 s of resume,
    `"connected":true`, `recoveries` went up by 1, `grep -c standby.mp4` = 0, and
    `screen_brightness` = `state.brightness × 2.5`.
18. **USB re-enumeration** (the user runs `sudo usbreset 0b05:1c76`): same expectations as 17
    within 7 s.
19. **Unplugged state.** While the device is gone (during 18), `POST /api/brightness {"value":50}`
    returns `"applied":false`; after the reconnect `screen_brightness` = 125.

### HTTP hygiene

20. `curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' $S/api/state` → 403.
21. `curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: text/plain' -d '{"value":50}' $S/api/brightness` → 415.
22. `ss -ltnp | grep 8746` shows `127.0.0.1:8746` only.

---

## 7. Conflicts between sources, and open questions

### Conflicts, and which side the spec takes

| # | conflict | resolution |
|---|---|---|
| C1 | dragocz95 research says the °F setting "only changes the unit label" and the host must convert. | **APK code wins**: the temperature getters compute `t × 1.8 + 32` themselves (`entity/PcCpu.java:40-45`, `PcGpu.java:48-53`, `PcMd.java`, `Disk.java`). Send Celsius always. |
| C2 | dragocz95 research says `gpu.temperature` is a String "so any text works" and that `"52.0"` is drawn as-is; also that floats render with no rounding. | **APK code wins**: `PcGpu.getTemperature` runs `Float.parseFloat` and truncates to int, so text throws on the UI thread and `"52.0"` draws `52`. Only voltages keep decimals. |
| C3 | Handoff: brightness `{"value":0-100}`. | **APK code wins**: no upper clamp, `(int)(102 × 2.5)` = 255 (`MsgReceiverManager.java:520-525`). FoxPodZ measured the same on hardware. Slider 0–102. |
| C4 | FoxPodZ README: disconnect after ~10 s. | **APK code and the handoff's measurement win**: 5000 ms (`MsgReceiverManager.java:491`). |
| C5 | Handoff and FoxPodZ: `spec` names are shown in the overlay. | **APK code wins**: stored, case 115 only logs. Not sent. |
| C6 | Handoff, `ryuo.py` and `70-rog-ryuo-iv.rules` pin VID `0b05`. FoxPodZ docs say fw 1.0.7 enumerates as `1c75:1c76`. | The APKs hold no VID/PID (the gadget config sets them), so this rests on FoxPodZ's docs only. Matching PID `1c76` with VID `0b05` or `1c75` is a superset that costs nothing. The udev rule needs a second line for `1c75`; the user installs it (sudo). |
| C7 | Handoff and `ryuo.py` heartbeat with `STATE all`; Info Hub (FoxPodZ capture) and dragocz95 use `POST all`. | Both reach `onRefreshUI` in code. The spec uses `POST all` because it is what Info Hub sends, is not throttled, and gets a HomeUI ack the daemon uses for liveness. `--heartbeat state` keeps the verified path available. |
| C8 | Handoff open question "is `conn` needed?" | **APK code answers it**: SerialService never forwards `conn` to HomeUI (`SerialMsgReceiverHandler.java:195`); dragocz95 never sends it. The daemon sends it only for the media list. |
| C9 | Handoff: `timeZone` is never null-checked. Research: `Util.setAndroidSystemTimeZone` returns early on null and dragocz95 omits it. | Moot: the daemon always sends the real zone. |
| C10 | Handoff lists `sysinfoDisplay` as the overlay command and omits `config`, `POST all`, `waterfallMode`. | `sysinfoDisplay` is not persisted (lost on reconnect/resume); `preset` is used instead. `config` is not used (§2.2). |
| C11 | The request asks for overlay position and alignment. | `PmSetting.align`, `position`, `color` and `badges` have no reader anywhere in HomeUI (grep over `re/src/home` and `re/src/home-bad`). Geometry is fixed in `activity_main.xml`. Position is offered as slot choice only. |
| C12 | Handoff: burn-in screensaver not observed, duration unstated. FoxPodZ: widgets vanish ~2 s every ~5 min. | Code agrees with FoxPodZ: `sendEmptyMessageDelayed(102, 2000)` (`MainActivity.java:295`), also triggered by still images. Left enabled. |
| C13 | dragocz95 re-sends `waterBlockScreenId` every ~60 s "to handle app restarts". | Rejected: each re-send restarts the video. Recovery uses the HomeUI ack instead (§2.5). |
| C14 | Handoff checksum "low byte of the signed-byte sum" vs FoxPodZ/dragocz95 "unsigned sum & 0xFF". | Same value mod 256; not a real conflict. Keep `ryuo.py`'s code. |
| C15 | Relayed notes: H.264 is capped near 1920 wide, full-panel needs HEVC. Handoff: a 98 MB H.264 MP4 played full-screen. | Not a direct contradiction (the handoff file's resolution is not recorded). Irrelevant here: this prototype plays files already on the device. Matters for the upload step. |

### Open questions

1. **HomeUI ack timing.** Does the `POST all` ack (`cmdType 200`, `{"status":{"fanLCD":…}}`) arrive
   within the 250 ms read window on this unit? Recovery trigger 3 depends on it. Check with `-v`
   before enabling it; if it is late, widen the window or count acks over 5 s instead.
2. **Gson and fractional ints.** That `7.5` in an int field drops the whole sample is inferred from
   Gson behaviour, not tested. The daemon rounds anyway; check 6 confirms no `stringToObject--fail`.
3. **UI-thread crashes.** A bad colour or a `gpu` without `temperature` probably crashes HomeUI
   (no try/catch). The daemon validates both; nobody should test this on the panel.
4. **Label width.** Slots 3–5 are centred on x=1994 with no ellipsize, so labels longer than about
   10 characters at 56 px may clip at x=2240. The 16-character limit is a guess; take a screencap
   with `Fan Speed Net Down KB/s` in slot 3 and tighten the limit if it clips.
5. **Burn-in window.** Does a `preset` sent during the 2 s screensaver bring the slots back early
   (Group visibility vs `setProtectTextView`)? A heartbeat does not call `showInfo`, so only UI edits
   could trigger it. Untested.
6. **Motherboard sensor.** `gigabyte_wmi` exposes temp1–temp5 with no labels (30, 62, 50, 41,
   48 °C on 2026-10-23). Which one is the board is unknown; temp1 is the default and the user can
   override it with `sensors.motherboard`.
7. **Date&Time seconds.** The `ss` unit refreshes only per heartbeat, so it ticks once a second at
   best and skips when a heartbeat is late. Check that it reads correctly on the panel.
8. **Double video start at startup.** Steps 5 and 6 both run case 105. Verified to end on the
   user's media; whether the visible flicker is worth dropping step 6 when no `disconn` was sent in
   the last 5 s is a polish question.
9. **`re/ext/` is not in `.gitignore`.** The two third-party clones would be picked up by
   `git add -A`. Add `re/ext/` to `.gitignore` before any commit (not done here; out of this task's scope).
10. **`#AARRGGBB` colours.** `Color.parseColor` accepts them; how translucent text looks over video
    is untested. The UI sends `#RRGGBB` from `<input type=color>`; the API accepts both.
