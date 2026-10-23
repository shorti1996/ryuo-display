#!/usr/bin/env python3
"""Linux driver for the ASUS ROG RYUO IV pump LCD (USB 0b05:1c76).

The cooler runs Android. Media files go over adb into /sdcard/pcMedia/; playback is
selected with text commands framed into 1024-byte HID output reports, parsed on the
device by SerialService (DataConvert / SerialMsgManager in SerialService.apk).

Frame: 0x5A | escape(len_be16 + payload + crc8) | 0x5A
  len   = len(payload) + 5, big-endian
  crc8  = low byte of the signed-byte sum over len + payload
  escape: 0x5A -> 5B 01, 0x5B -> 5B 02
Payload: "<METHOD> <cmd> 1\r\nKey=Value\r\n...\r\n\r\n<json>". The device needs at
least two header lines, or it NPEs reading SeqNumber.

HomeUI drops back to the standby video if no command arrives for 5 s, so `play` keeps
sending "STATE all" heartbeats until stopped. `stop` signals that process through its
pidfile; on exit it sends "disconn" so standby starts at once instead of 5 s later.
"""
import argparse
import glob
import json
import os
import select
import signal
import subprocess
import sys
import time

VID_PID = "0003:00000B05:00001C76"
REPORT_LEN = 1024
MEDIA_DIR = "/sdcard/pcMedia/"
PIDFILE = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "ryuo-play.pid")


def find_hidraw():
    for node in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        with open(os.path.join(node, "device/uevent")) as f:
            if f"HID_ID={VID_PID}" in f.read():
                return "/dev/" + os.path.basename(node)
    sys.exit("RYUO IV HID interface not found")


def encode(payload: bytes) -> bytes:
    body = (len(payload) + 5).to_bytes(2, "big") + payload
    crc = sum(b - 256 if b > 127 else b for b in body) & 0xFF
    out = bytearray([0x5A])
    for b in body + bytes([crc]):
        out += {0x5A: b"\x5b\x01", 0x5B: b"\x5b\x02"}.get(b, bytes([b]))
    out.append(0x5A)
    return bytes(out)


def decode(frame: bytes) -> str:
    frame = frame.rstrip(b"\x00")
    if len(frame) < 5 or frame[0] != 0x5A or frame[-1] != 0x5A:
        return f"<unparsed {frame[:32].hex()}>"
    body = frame[1:-1].replace(b"\x5b\x01", b"\x5a").replace(b"\x5b\x02", b"\x5b")
    return body[2:-1].decode("utf-8", "replace")


class Ryuo:
    def __init__(self, path):
        self.fd = os.open(path, os.O_RDWR)
        self.seq = 0
        self.verbose = False

    def send(self, method, cmd, content=None, wait=0.3):
        text = "" if content is None else json.dumps(content, separators=(",", ":"))
        self.seq += 1
        head = f"{method} {cmd} 1\r\nSeqNumber={self.seq}\r\nContentLength={len(text.encode())}\r\nContentType=json"
        frame = encode((head + "\r\n\r\n" + text).encode())
        if len(frame) > REPORT_LEN:
            sys.exit(f"{cmd}: frame is {len(frame)} bytes, limit {REPORT_LEN}")
        # hidraw wants the report ID first; this descriptor has none, so 0.
        os.write(self.fd, b"\x00" + frame.ljust(REPORT_LEN, b"\x00"))
        if self.verbose:
            print(f">> {method} {cmd} {text}")
        return self.read_replies(wait)

    def read_replies(self, timeout):
        replies = []
        end = time.monotonic() + timeout
        while (left := end - time.monotonic()) > 0:
            if not select.select([self.fd], [], [], left)[0]:
                break
            reply = decode(os.read(self.fd, REPORT_LEN + 1))
            replies.append(reply)
            if self.verbose:
                print("<<", reply.replace("\r\n", " | "))
        return replies

    def heartbeat(self):
        self.send("STATE", "all", {"timestamp": int(time.time() * 1000)})


def running_player():
    """PID of a live `ryuo.py play`, or None. Ignores a stale pidfile."""
    try:
        with open(PIDFILE) as f:
            pid = int(f.read())
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmdline = f.read()
    except (OSError, ValueError):
        return None
    return pid if b"ryuo" in cmdline and b"play" in cmdline else None


def stop_player(timeout=3.0):
    """SIGTERM the running player and wait for it to exit. True if there was one."""
    pid = running_player()
    if pid is None:
        return False
    os.kill(pid, signal.SIGTERM)
    end = time.monotonic() + timeout
    while os.path.exists(f"/proc/{pid}") and time.monotonic() < end:
        time.sleep(0.1)
    return True


def adb(*args):
    subprocess.run(["adb", *args], check=True)


def media_config(names, mode, ratio, sysinfo):
    return {
        "id": "Customization",
        "screenMode": "Full Screen",
        "ratio": ratio,
        "playMode": mode,
        "media": names,
        "sysinfoDisplay": sysinfo,
        "settings": None,
        "timeZone": time.tzname[0] if not os.path.exists("/etc/localtime")
        else os.path.realpath("/etc/localtime").split("zoneinfo/")[-1],
    }


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

    sub.add_parser("stop", help="stop a running `play` and switch the cooler to standby")

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

    dev = Ryuo(find_hidraw())
    dev.verbose = a.verbose

    if a.cmd == "info":
        for r in dev.send("POST", "conn", {"OS": "Linux"}, wait=1.5):
            print(r.split("\r\n\r\n", 1)[-1])
    elif a.cmd == "brightness":
        dev.send("POST", "brightness", {"value": a.value})
    elif a.cmd == "raw":
        dev.verbose = True
        dev.send(a.method, a.name, json.loads(a.json) if a.json else None)
    elif a.cmd == "stop":
        if not stop_player():
            dev.send("POST", "disconn")
    elif a.cmd == "play":
        # Two players would interleave heartbeats and configs; the newest one wins.
        stop_player()
        dev.send("POST", "conn", {"OS": "Linux"}, wait=1.5)
        dev.send("POST", "waterBlockScreen", {"enable": True})
        dev.send("POST", "waterBlockScreenId", media_config(a.names, a.mode, a.ratio, a.sysinfo))
        # HomeUI only leaves standby on its own after a 5 s silence; a play started within 5 s
        # of a "disconn" would stay behind the standby video. "resume" hides it unconditionally.
        dev.send("POST", "power", {"event": "resume"})
        # On reconnect the cooler restores whatever brightness it had in standby (50/255),
        # so set it explicitly the way the Windows app does.
        dev.send("POST", "brightness", {"value": a.brightness})
        with open(PIDFILE, "w") as f:
            f.write(str(os.getpid()))
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        print(f"playing {', '.join(a.names)}; stop with Ctrl-C or `ryuo.py stop`", flush=True)
        try:
            while True:
                dev.heartbeat()
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            dev.send("POST", "disconn")
            if running_player() == os.getpid():
                os.remove(PIDFILE)


if __name__ == "__main__":
    main()
