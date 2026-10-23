# Brief: a Fedora tray app for the ASUS ROG RYUO IV pump LCD

I want options for turning a working command-line driver into a background desktop app on
Fedora. Please research and compare approaches, then recommend one.

## What exists today

The ASUS ROG RYUO IV AIO cooler has a 2240×1080 LCD on the pump block. ASUS ships Windows-only
software for it (Armoury Crate). On Linux the screen only loops a standby logo.

The cooler is a small Android computer (Rockchip, Android 13) connected over internal USB, and it
exposes two USB interfaces:

- **ADB**: media files are copied with `adb push` into the cooler's storage (`/sdcard/pcMedia/`).
- **HID**: control commands go as 1024-byte HID output reports through `/dev/hidrawN`, as
  HTTP-like text with a JSON body inside a small binary frame. A udev rule (`TAG+="uaccess"`)
  gives the logged-in user access without root.

A Python 3 script (standard library only, about 170 lines) already does all of it:

| command | what it does |
|---|---|
| `ryuo.py push FILE` | `adb push` of a video into the cooler |
| `ryuo.py play NAME… [--mode Single\|Cycle\|Random] [--brightness 0-100]` | selects the video, sets brightness, then sends a heartbeat every 1 s |
| `ryuo.py brightness N` | sets backlight 0–100 |
| `ryuo.py stop` | stops the running `play` (pidfile + SIGTERM); the cooler switches to standby at once |
| `ryuo.py info` | handshake; the cooler replies with JSON including the list of media files stored on it |

## The constraint that shapes the design

The cooler falls back to its standby logo if it receives no HID command for **5 seconds**. So
something must run continuously while the user is logged in and send a heartbeat every second.
That is why this needs to be a background app rather than a one-shot command.

## What I want the app to do

1. Run in the background from login, sending the heartbeat (a systemd user service is the obvious
   candidate; tell me if there's a better fit).
2. Show a **tray icon** with quick actions: pick video, brightness, pause (let it fall to standby).
3. Open a small **GUI** to:
   - upload a local video (wrapping `adb push`, with progress for files around 100 MB),
   - list the videos already on the cooler (from the `info` reply) and select one,
   - set play mode (single, cycle through a list, random),
   - control brightness with a slider that applies immediately.
4. Remember the last selection and brightness across reboots.
5. Optionally, convert/scale an arbitrary video to the panel's 2240×1080 with ffmpeg before
   uploading.

## Environment

- Fedora 43, KDE Plasma desktop (Wayland).
- Python 3.14; keeping the existing Python protocol code is preferred but not required.
- `adb` (android-tools 37) is installed.

## Questions to answer

1. Which toolkit fits a Plasma/Wayland tray app best? Compare at least PySide6/PyQt6
   (`QSystemTrayIcon`), GTK with libayatana-appindicator, and a separate tray-plus-daemon split
   talking over D-Bus or a Unix socket. Cover how well tray icons work under Wayland on KDE for each.
2. One process (GUI + heartbeat together) or two (headless systemd user daemon + GUI client)?
   The heartbeat must keep running when the GUI window is closed.
3. Is there an existing open-source project for Linux control of AIO/pump LCD screens that this
   could plug into instead of a standalone app? Check liquidctl, OpenLinkHub, CoolerControl, and
   similar. Note that this device is an ADB + HID Android device, not the bitmap-over-USB protocol
   most pump LCDs use, so check whether any project supports a comparable model.
4. Packaging for personal use on Fedora: pip/pipx, a COPR RPM, or Flatpak? A Flatpak sandbox
   needs `/dev/hidraw*` access and an `adb` binary. Say which is least friction.
5. How should the daemon handle the cooler disappearing and reappearing (USB reset,
   suspend/resume) without a restart?

Give a recommended stack with a short justification, a rough component diagram, and an estimate
of the work in hours for a first usable version.
