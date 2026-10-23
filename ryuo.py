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
sending "STATE all" heartbeats until interrupted.
"""
import argparse
import glob
import json
import os
import select
import subprocess
import sys
import time

VID_PID = "0003:00000B05:00001C76"
REPORT_LEN = 1024
MEDIA_DIR = "/sdcard/pcMedia/"


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
    elif a.cmd == "play":
        dev.send("POST", "conn", {"OS": "Linux"}, wait=1.5)
        dev.send("POST", "waterBlockScreen", {"enable": True})
        dev.send("POST", "waterBlockScreenId", media_config(a.names, a.mode, a.ratio, a.sysinfo))
        # On reconnect the cooler restores whatever brightness it had in standby (50/255),
        # so set it explicitly the way the Windows app does.
        dev.send("POST", "brightness", {"value": a.brightness})
        print(f"playing {', '.join(a.names)}; Ctrl-C to stop (cooler returns to standby 5 s later)")
        try:
            while True:
                dev.heartbeat()
                time.sleep(1)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
