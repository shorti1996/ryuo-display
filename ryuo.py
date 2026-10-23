#!/usr/bin/env python3
"""Linux driver for the ASUS ROG RYUO IV pump LCD (USB 0b05:1c76).

The cooler runs Android. Media files go over adb into /sdcard/pcMedia/; playback is
selected with text commands framed into 1024-byte HID output reports, parsed on the
device by SerialService (DataConvert / SerialMsgManager in SerialService.apk). The frame
codec and device class live in ryuo_proto.py.

HomeUI drops back to the standby video if no command arrives for 5 s, so `play` keeps
sending "STATE all" heartbeats until stopped. `stop` signals that process (or ryuod)
through its pidfile; on exit it sends "disconn" so standby starts at once instead of 5 s later.
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from ryuo_proto import (MEDIA_DIR, PIDFILE, REPORT_LEN, FrameTooLarge, Ryuo, decode, encode,  # noqa: F401,E402
                        remove_pidfile, running_driver, screen_config, stop_driver, superseded,
                        write_pidfile)
import ryuo_proto  # noqa: E402

running_player = running_driver
stop_player = stop_driver


def find_hidraw():
    path = ryuo_proto.find_hidraw()
    if path is None:
        sys.exit("RYUO IV HID interface not found")
    return path


def adb(*args):
    subprocess.run(["adb", *args], check=True)


def media_config(names, mode, ratio, sysinfo):
    # Padded to 6 entries: with a shorter list HomeUI keeps the slots a previous ryuod run set,
    # and this heartbeat carries only a timestamp, so they would show frozen values.
    return screen_config(names, mode, ratio, sysinfo, None, pad=True)


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("info", help="handshake and print what the device reports")

    pp = sub.add_parser("push", help="copy a media file to the cooler over adb")
    pp.add_argument("file")

    pl = sub.add_parser("play", help="play media already on the cooler; keeps a heartbeat running")
    pl.add_argument("names", nargs="+", help="file names in /sdcard/pcMedia or /sdcard/pcMediaPreset")
    pl.add_argument("--mode", default="Single", choices=["Single", "Cycle", "Random"])
    pl.add_argument("--ratio", default="2:1", choices=["2:1", "16:9", "3:2", "4:3", "1:1"],
                    help="2:1 fills the 2240x1080 panel")
    pl.add_argument("--sysinfo", nargs="*", default=[],
                    help='overlay fields, e.g. "CPU Temperature" "Date&Time"')
    pl.add_argument("--brightness", type=int, default=100, help="0-100, default 100")

    sub.add_parser("stop", help="stop a running `play` or ryuod and switch the cooler to standby")

    br = sub.add_parser("brightness", help="set backlight, 0-100")
    br.add_argument("value", type=int)

    raw = sub.add_parser("raw", help="send one command, e.g. raw POST rotate '{\"degree\":180}'")
    raw.add_argument("method")
    raw.add_argument("name")
    raw.add_argument("json", nargs="?")

    a = p.parse_args()

    if a.cmd == "push":
        adb("push", a.file, MEDIA_DIR + os.path.basename(a.file))
        return

    if a.cmd == "stop":
        # Signal the driver before looking for the cooler, so this works while it is unplugged;
        # the driver sends its own disconn on exit.
        if not stop_player():
            Ryuo(find_hidraw()).send("POST", "disconn")
        return

    dev = Ryuo(find_hidraw())
    dev.verbose = a.verbose
    try:
        run(a, dev)
    except FrameTooLarge as e:
        sys.exit(str(e))


def run(a, dev):
    if a.cmd == "info":
        for r in dev.send("POST", "conn", {"OS": "Linux"}, wait=1.5):
            print(r.split("\r\n\r\n", 1)[-1])
    elif a.cmd == "brightness":
        dev.send("POST", "brightness", {"value": a.value})
    elif a.cmd == "raw":
        dev.verbose = True
        dev.send(a.method, a.name, json.loads(a.json) if a.json else None)
    elif a.cmd == "play":
        # Two drivers would interleave heartbeats and configs; the newest one wins.
        stop_player()
        # Claim the pidfile before the ~2.4 s setup below, so a ryuod started meanwhile finds
        # and stops this process instead of running alongside it.
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        write_pidfile()
        try:
            dev.send("POST", "conn", {"OS": "Linux"}, wait=1.5)
            dev.send("POST", "waterBlockScreen", {"enable": True})
            dev.send("POST", "waterBlockScreenId", media_config(a.names, a.mode, a.ratio, a.sysinfo))
            # HomeUI only leaves standby on its own after a 5 s silence; a play started within 5 s
            # of a "disconn" would stay behind the standby video. "resume" hides it unconditionally.
            dev.send("POST", "power", {"event": "resume"})
            # On reconnect the cooler restores whatever brightness it had in standby (50/255),
            # so set it explicitly the way the Windows app does.
            dev.send("POST", "brightness", {"value": a.brightness})
            print(f"playing {', '.join(a.names)}; stop with Ctrl-C or `ryuo.py stop`", flush=True)
            # A driver that overwrote the pidfile owns the screen; leave without a disconn.
            while not superseded():
                dev.heartbeat()
                time.sleep(1)
            print("another driver took over; exiting", flush=True)
        except KeyboardInterrupt:
            pass
        finally:
            if not superseded():
                dev.send("POST", "disconn")
            remove_pidfile()


if __name__ == "__main__":
    main()
