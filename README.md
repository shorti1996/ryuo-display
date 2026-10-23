# rog-ryuo-lcd

Linux software for the 2240×1080 LCD on the pump of the ASUS ROG RYUO IV AIO cooler. It replaces
the Windows app for the screen: it plays videos stored on the cooler and draws live PC stats
(CPU, GPU, memory, disk, network, clock) over them, refreshed once per second. The panel shows
its standby video whenever no program has sent it a message for 5 s, so the daemon runs all the
time you are logged in.

You get:

| piece | what it does |
|---|---|
| `ryuod` (systemd user service) | keeps the panel alive, samples the stats, serves the control page on **http://127.0.0.1:8746/** |
| control page | pick stats, colours, brightness and background video in a browser |
| tray icon | show/hide stats, brightness, open the control page, start/stop the daemon |
| `ryuo.py` | command-line tool: device info, upload, play, stop, brightness |

Tested on one machine only: Fedora 43, KDE Plasma 6 on Wayland, cooler firmware V1.0.10.
Other distributions, desktops and firmware versions have not been tried.

## Requirements

| need | for | notes |
|---|---|---|
| Linux with systemd user sessions | the daemon | runs as `ryuod.service` under your user |
| Python 3.12 or newer at `/usr/bin/python3` | daemon, CLI, tray | the daemon and CLI use the standard library only |
| PySide6 | tray icon | Fedora: `sudo dnf install python3-pyside6`. Arch: `pyside6`. Debian 13 / Ubuntu 26.04 and later: `python3-pyside6.qtcore`, `python3-pyside6.qtgui`, `python3-pyside6.qtwidgets` (Debian splits PySide6 into one package per Qt module). Elsewhere: install PySide6 with pip for `/usr/bin/python3`. |
| `adb` (Fedora/Arch package `android-tools`, Debian/Ubuntu `adb`) | uploading videos | the daemon and the stats overlay work without it |
| a StatusNotifier system tray | tray icon | KDE Plasma has one. GNOME needs the AppIndicator extension. |
| `nvidia-smi` (optional) | NVIDIA GPU stats | AMD GPUs are read from sysfs |
| `uv`, `node`/`npm` | development only | tests and lint |

`make deps` checks all of these and prints the Fedora package names for anything missing.

## Install

From the root of a clone of this repository:

```sh
make deps           # check what is installed
make install-udev   # asks for sudo: lets your user open the cooler's HID interface
make install        # no sudo: installs and starts the daemon, adds the tray launcher
```

`make help` lists every target.

What gets installed:

| file | installed by | purpose |
|---|---|---|
| `/etc/udev/rules.d/70-rog-ryuo-iv.rules` | `make install-udev` | gives the logged-in user access to `/dev/hidraw*` for USB `0b05:1c76` and `1c75:1c76` (the cooler's HID interface) |
| `~/.config/systemd/user/ryuod.service` | `make install` | runs `ryuod.py`; enabled and started |
| `~/.local/share/applications/ryuo-tray.desktop` | `make install` | "RYUO LCD" in the start menu |
| `~/.config/autostart/ryuo-tray.desktop` | `make install` | starts the tray icon at login |

The installed unit and launchers run the code from this checkout. If you move the directory, run
`make install` again.

The two parts start at different times:

- **Daemon**: `ryuod.service` is wanted by `default.target`, so it starts when your user's systemd
  instance starts at login. It talks only to `/dev/hidraw*` and `adb` and needs no display.
- **Tray**: the XDG autostart entry starts it inside the graphical session, once a tray is there
  to show it.

### Check that it worked

1. `systemctl --user status ryuod` shows `active (running)`.
2. http://127.0.0.1:8746/ opens the control page, and its status line says the cooler is connected.
3. The tray shows a panel-shaped icon. It is red while the daemon drives the cooler, grey while
   the daemon is down or the cooler is not found.
4. The pump screen shows a video with stats over it.

## Using it

### Control page (http://127.0.0.1:8746/)

| section | what you can change |
|---|---|
| Panel preview | a scaled drawing of the overlay with the latest values |
| Stats in each slot | which stat goes in each of the 6 overlay slots, and a switch to show or hide the whole overlay (hiding keeps your slot choices). Positions are fixed by the firmware, so you place a stat by choosing its slot. |
| Overlay colours | one title colour and one value/unit colour for all slots, an optional animated filter over the text, and its opacity (0–100 %) |
| Brightness | 0–102 on the device's scale: 100 gives 250/255 backlight, 102 gives the full 255/255 |
| Background media | the videos and images already on the cooler, play mode (Single, Cycle, Random). Play restarts the video. |
| Units | °C or °F, and the memory frequency in MHz (Linux has no unprivileged source for it; 0 hides that stat) |

Settings are saved in `~/.config/ryuo/state.json` and restored when the daemon starts.

Stats whose label starts with "Fan Speed" (for example disk read MB/s, network KB/s) use the
firmware's fan slot, so the panel always prints "RPM" as their unit. The label carries the real unit.

### Tray menu

| item | does |
|---|---|
| status line | daemon and cooler state, product and firmware |
| Show stats on panel | toggles the overlay, same as the switch on the page |
| Brightness | 25, 50, 75 or 100 |
| Open control page | opens http://127.0.0.1:8746/ (left-clicking the icon does the same) |
| Start ryuod | shown only while the daemon is down; starts `ryuod.service` |
| Stop (panel goes to standby) | stops the daemon; the panel shows the standby video |
| Quit tray | closes the icon; the daemon keeps running |

Starting "RYUO LCD" from the start menu while the tray already runs opens the control page
instead of adding a second icon.

### Command line

Run from the repository root. `./ryuo.py --help` lists the commands; `-v` prints every frame sent
and received.

| command | example | does |
|---|---|---|
| `info` | `./ryuo.py info` | prints the device's reply as JSON: firmware, serial, media files on the cooler |
| `push` | `./ryuo.py push clip.mp4` | copies a file to `/sdcard/pcMedia/` on the cooler over adb |
| `play` | `./ryuo.py play clip.mp4` | plays files already on the cooler and keeps running until stopped (Ctrl-C or `stop`); no live stats |
| `stop` | `./ryuo.py stop` | stops a running `play` or the daemon and puts the panel in standby |
| `brightness` | `./ryuo.py brightness 60` | sets the backlight, 0–100 |
| `raw` | `./ryuo.py raw POST brightness '{"value":60}'` | sends one protocol command; see [Safety](#safety) first |

`play` and the daemon cannot drive the panel at the same time; see
[Troubleshooting](#troubleshooting).

### Uploading your own video

```sh
./ryuo.py push clip.mp4
```

Then open the control page, press **Refresh list** under Background media, select the file and
press **Play**.

For a video that fills the whole 2240×1080 panel, encode it as HEVC (H.265). H.264 is reported to
top out near 1920 px wide. That limit comes from the FoxPodZ project's findings and has not been
tested here; only H.264 MP4 files have been played on the test unit.

## Troubleshooting

| symptom | cause and fix |
|---|---|
| Panel shows the ROG logo or the standby video | Nothing is driving it. Check `systemctl --user status ryuod`; read why it stopped with `journalctl --user -u ryuod -n 30`; start it with `systemctl --user start ryuod` or the tray's **Start ryuod**. |
| After **Stop** in the tray the daemon stays stopped | `ryuod` exits with status 0 on SIGTERM, and the unit only restarts it after a failure (non-zero exit). It starts again on **Start ryuod** or at the next login. |
| The daemon stopped after running `./ryuo.py play` | Only one program can drive the panel; the newest one takes over and the other exits cleanly, so systemd does not restart the daemon. Stop `play` with `./ryuo.py stop`, then start the daemon from the tray. |
| No tray icon | The desktop has no StatusNotifier tray. On GNOME, install the AppIndicator extension. The daemon and the control page work without the tray. |
| `Permission denied` on `/dev/hidraw*`, or "RYUO IV HID interface not found" | The udev rule is missing or not applied yet. Run `make install-udev`, then unplug and replug the cooler's USB header (or reboot), or run `sudo udevadm trigger`. |
| Daemon exits with `cannot bind 127.0.0.1:8746` | Another program uses port 8746, which the tray and the page expect. Free the port; systemd retries every 5 s. |
| The stats overlay disappears for about 2 s every 5 min | The cooler's own burn-in protection plays a short screensaver clip. The firmware resets that timer only by restarting the video, so the daemon leaves it on. |
| Cooler not found on another firmware | The HID interface is matched by product ID `1c76` with vendor `0b05` (firmware 1.0.3 and 1.0.10) or `1c75` (firmware 1.0.7, per other projects). Only V1.0.10 has been tested. `lsusb` shows the IDs your unit reports; the test unit lists `0b05:1c76 ASUSTek Computer, Inc. ROG RYUO IV Standard`. |

## Safety

The cooler is an Android device with a root `adb` shell, reachable over its internal USB
connection. Treat both interfaces with care:

- Never send `upgrade`, or `transport`/`transported` with `"type":"firmware"`, through
  `ryuo.py raw`. They start a firmware update.
- Never send `rotate`. It writes a persistent device property and is untested. The `raw` help text
  uses `rotate` as its example; do not run it.
- `adb shell` on the cooler runs as root and can change or delete files on the device.

The control page and API listen on `127.0.0.1` only and reject requests whose `Host` header is not
`127.0.0.1:8746` or `localhost:8746`.

## Development

```sh
make test     # Python tests (uv run pytest) and web tests (npm, in web/)
make lint
make format
make run      # the daemon in the foreground with -v
make tray     # the tray icon
```

`make run` refuses while `ryuod.service` is active, because both would want port 8746. Stop the
service first (`systemctl --user stop ryuod`, or Stop in the tray) and start it again when you are
done.

`make uninstall` removes the user service and launchers. It keeps the udev rule and
`~/.config/ryuo/state.json`, and prints how to remove them.

| path | contents |
|---|---|
| `ryuo_proto.py` | frame codec, HID device class, message builders, pidfile helpers; shared by the daemon and the CLI |
| `ryuod.py` | the daemon: device worker, stats sampler, HTTP server and JSON API |
| `ryuo.py` | the CLI |
| `ryuo_tray.py` | the tray icon; talks only to the daemon's HTTP API |
| `web/` | the control page (`index.html`, plain JavaScript, no external requests) and its tests |
| `tests/` | Python tests |
| `packaging/` | templates for the systemd unit and the desktop entry |
| `70-rog-ryuo-iv.rules` | the udev rule |
| `docs/001-lcd-protocol/` | the reverse-engineered HID protocol: frame format, commands, device quirks |
| `docs/002-stats-prototype/` | daemon design: stat sources, overlay slots, startup and reconnect sequence, HTTP API |
| `re/` | local reverse-engineering material (vendor APKs, decompiled sources, screenshots); git-ignored |

How the protocol works, in short: video files go to the cooler over adb; commands go over a HID
interface as framed text messages in 1024-byte reports; the panel returns to standby 5 s after the
last message, so the daemon sends a stats heartbeat every second.

## Credits

Prior work on the same cooler, read during the reverse engineering:

- https://github.com/FoxPodZ/ryuo-iv-screen
- https://github.com/dragocz95/asus-ryuo-iv-linux

This project is not affiliated with or endorsed by ASUS.

No license has been chosen yet.
