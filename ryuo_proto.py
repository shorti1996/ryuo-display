"""Protocol layer for the ASUS ROG RYUO IV pump LCD, shared by ryuo.py and ryuod.py.

Frame: 0x5A | escape(len_be16 + payload + crc8) | 0x5A
  len   = len(payload) + 5, big-endian
  crc8  = low byte of the signed-byte sum over len + payload
  escape: 0x5A -> 5B 01, 0x5B -> 5B 02
Payload: "<METHOD> <cmd> 1\r\nKey=Value\r\n...\r\n\r\n<json>". The device needs at
least two header lines, or it NPEs reading SeqNumber. Replies: "1 200\r\nAckNumber=N...".
"""
import contextlib
import glob
import json
import os
import select
import signal
import time

REPORT_LEN = 1024
MEDIA_DIR = "/sdcard/pcMedia/"
PIDFILE = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "ryuo-play.pid")
SLOTS = 6
BRIGHTNESS_MAX = 102  # (int)(102 * 2.5) = 255; the device has no upper clamp
# Firmware 1.0.7 enumerates as 1c75:1c76. Never match the VID alone: 0b05:19af is the
# motherboard's Aura controller.
PIDS = {(0x0B05, 0x1C76), (0x1C75, 0x1C76)}
PLAY_MODES = ("Single", "Cycle", "Random")
RATIOS = ("2:1", "16:9", "3:2", "4:3", "1:1")
TEMP_UNITS = ("Celsius", "Fahrenheit")

# (item string, panel title, panel unit, picker group). "°C" means it follows the unit
# setting. Titles are HomeUI's subTitle map; Date&Time's title is drawn from the device clock.
ITEMS = [
    ("CPU Load", "CPU", "%", "CPU"),
    ("CPU Usage", "CPU", "%", "CPU"),
    ("CPU Temperature", "CPU", "°C", "CPU"),
    ("CPU Speed Average", "CPU", "MHZ", "CPU"),
    ("CPU Voltage", "CPU", "V", "CPU"),
    ("GPU Load", "GPU", "%", "GPU"),
    ("GPU Usage", "GPU", "%", "GPU"),
    ("GPU Temperature", "GPU", "°C", "GPU"),
    ("GPU Speed", "GPU", "MHZ", "GPU"),
    ("GPU Power", "GPU", "°C", "GPU"),  # firmware draws a temperature unit here
    ("GPU Voltage", "GPU", "V", "GPU"),
    ("Memory Utilization", "Memory Utilization", "%", "Memory"),
    ("Memory Frequency", "Memory Frequency", "MHZ", "Memory"),
    ("Hard Disk Temperature", "Hard Disk Temperature", "°C", "Storage"),
    ("Motherboard Temperature", "Motherboard", "°C", "Board"),
    ("Date&Time", "", "ss", "Clock"),
]
FAN_PREFIX = "Fan Speed "
LABEL_CHARS = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ./%-")

# Title advance widths in trade.ttf (HomeUI assets/fonts/trade.ttf, 1000 units per em), for
# the label characters and the firmware titles. Read from the font's hmtx table.
_TITLE_ADVANCE = {}
for _w, _chars in ((278, "Ifijlt ./"), (333, "Jr-"), (444, "FLsvxyz"), (500, "ETZabcdeghknopqu"),
                   (556, "ABCDGKOPQRSVXY0123456789"), (611, "HNU"), (667, "w&"), (722, "m"),
                   (778, "M"), (833, "W"), (889, "%")):
    _TITLE_ADVANCE.update(dict.fromkeys(_chars, _w))
# slot -> (title font px, widest title in px that stays on the panel). activity_main.xml: slots
# 1-2 start at x=120; 3-5 are centred on x=1994, so they clip past 2 x 246 px (slot 4 has
# paddingRight 12, which moves its text 6 px left); slot 6 starts at x=1368.
SLOT_TITLE = {1: (76, 2120), 2: (76, 2120), 3: (56, 492), 4: (76, 504), 5: (56, 492), 6: (42, 872)}


class FrameTooLarge(Exception):
    def __init__(self, cmd, size):
        super().__init__(f"{cmd}: frame is {size} bytes, limit {REPORT_LEN}")
        self.cmd, self.size = cmd, size


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


def message(method, cmd, seq, content=None):
    """Framed bytes and the JSON text for one command, headers as ryuo.py has always sent."""
    text = "" if content is None else json.dumps(content, separators=(",", ":"))
    head = f"{method} {cmd} 1\r\nSeqNumber={seq}\r\nContentLength={len(text.encode())}\r\nContentType=json"
    return encode((head + "\r\n\r\n" + text).encode()), text


class ReplyBuffer:
    """Reassembles device frames from raw reports; a reply can span several reports."""

    def __init__(self):
        self.buf = bytearray()

    def feed(self, report: bytes) -> list:
        # Kept whole: padding only follows a closing 0x5A, where the search for the next opener
        # skips it, while stripping zeros per report would also drop a 0x00 crc at a report edge.
        self.buf += report
        out = []
        while True:
            start = self.buf.find(0x5A)
            if start < 0:
                self.buf.clear()
                break
            end = self.buf.find(0x5A, start + 1)
            if end < 0:
                del self.buf[:start]
                break
            body = bytes(self.buf[start + 1:end]).replace(b"\x5b\x01", b"\x5a").replace(b"\x5b\x02", b"\x5b")
            if len(body) < 3 or int.from_bytes(body[:2], "big") != len(body) + 2:
                # Not a frame (a lost half, or the gap between two frames). Keep the closing
                # 0x5A: it may open the next frame.
                del self.buf[:end]
                continue
            out.append(body[2:-1].decode("utf-8", "replace"))
            del self.buf[:end + 1]
        if len(self.buf) > 16 * REPORT_LEN:
            self.buf.clear()
        return out


def parse_reply(text):
    """(status, ack, body) for "1 200\r\nAckNumber=N\r\n...\r\n\r\n<json>"; None where absent."""
    head, _, rest = text.partition("\r\n\r\n")
    lines = head.split("\r\n")
    first = lines[0].split()
    status = int(first[-1]) if first and first[-1].isdigit() else None
    hdr = dict(line.split("=", 1) for line in lines[1:] if "=" in line)
    ack = int(hdr["AckNumber"]) if hdr.get("AckNumber", "").lstrip("-").isdigit() else None
    try:
        body = json.loads(rest) if rest.strip() else None
    except ValueError:
        body = None
    return status, ack, body if isinstance(body, dict) else None


def hid_ids(node):
    """(vid, pid) of a /sys/class/hidraw/hidrawN node, or None."""
    try:
        with open(os.path.join(node, "device/uevent")) as f:
            for line in f:
                if line.startswith("HID_ID="):
                    _, vid, pid = line.strip()[7:].split(":")
                    return int(vid, 16), int(pid, 16)
    except (OSError, ValueError):
        pass
    return None


def find_hidraw():
    for node in sorted(glob.glob("/sys/class/hidraw/hidraw*")):
        if hid_ids(node) in PIDS:
            return "/dev/" + os.path.basename(node)
    return None


class Ryuo:
    def __init__(self, path):
        self.path = path
        self.fd = os.open(path, os.O_RDWR)
        self.seq = 0
        self.verbose = False
        self.replies = ReplyBuffer()

    def write(self, method, cmd, content=None):
        """Send one command; returns its SeqNumber (acks carry seq + 1)."""
        frame, text = message(method, cmd, self.seq + 1, content)
        if len(frame) > REPORT_LEN:
            raise FrameTooLarge(cmd, len(frame))
        self.seq += 1
        # hidraw wants the report ID first; this descriptor has none, so 0.
        os.write(self.fd, b"\x00" + frame.ljust(REPORT_LEN, b"\x00"))
        if self.verbose:
            print(f">> {method} {cmd} {text}", flush=True)
        return self.seq

    def poll(self, timeout):
        """Complete replies that arrive within timeout; returns early after the first batch."""
        if not select.select([self.fd], [], [], max(timeout, 0))[0]:
            return []
        out = self.replies.feed(os.read(self.fd, REPORT_LEN + 1))
        if self.verbose:
            for reply in out:
                print("<<", reply.replace("\r\n", " | "), flush=True)
        return out

    def send(self, method, cmd, content=None, wait=0.3):
        self.write(method, cmd, content)
        return self.read_replies(wait)

    def read_replies(self, timeout):
        replies = []
        end = time.monotonic() + timeout
        while (left := end - time.monotonic()) > 0:
            replies += self.poll(left)
        return replies

    def heartbeat(self):
        self.send("STATE", "all", {"timestamp": int(time.time() * 1000)})

    def close(self):
        with contextlib.suppress(OSError):
            os.close(self.fd)


def is_driver_argv(argv, daemon_only=False):
    """True for ryuod (`…/ryuod.py`) or, unless daemon_only, `…/ryuo.py [opts] play …`.

    Exact script names, not substrings: every path in this checkout contains "ryuo", so a
    substring test would match any process started from here."""
    for i, arg in enumerate(argv):
        name = os.path.basename(arg)
        if name == b"ryuod.py":
            return True
        if name == b"ryuo.py":
            return not daemon_only and b"play" in argv[i + 1:]
    return False


def proc_argv(pid):
    with open(f"/proc/{pid}/cmdline", "rb") as f:
        return f.read().rstrip(b"\0").split(b"\0")


def proc_started_at(pid):
    """Wall-clock start time of pid, rounded down to the second the kernel's btime has."""
    with open(f"/proc/{pid}/stat", "rb") as f:
        stat = f.read()
    ticks = int(stat[stat.rindex(b")") + 2:].split()[19])  # field 22, starttime
    with open("/proc/stat") as f:
        btime = next(int(line.split()[1]) for line in f if line.startswith("btime "))
    return btime + ticks / os.sysconf("SC_CLK_TCK")


def running_driver():
    """PID of a live `ryuo.py play` or ryuod, or None. Ignores a stale pidfile."""
    try:
        with open(PIDFILE) as f:
            pid = int(f.read())
        written = os.stat(PIDFILE).st_mtime
        argv = proc_argv(pid)
        started = proc_started_at(pid)
    except (OSError, ValueError, IndexError, StopIteration):
        return None
    if pid == os.getpid():
        return None
    # A driver writes the pidfile after it starts. A process that started later got a reused pid
    # from a stale file; 1 s of slack covers btime's whole-second resolution.
    if started > written + 1:
        return None
    return pid if is_driver_argv(argv) else None


def stop_driver(timeout=3.0):
    """SIGTERM the running driver and wait for it to exit. True if there was one."""
    pid = running_driver()
    if pid is None:
        return False
    os.kill(pid, signal.SIGTERM)
    end = time.monotonic() + timeout
    while os.path.exists(f"/proc/{pid}") and time.monotonic() < end:
        time.sleep(0.1)
    return True


def write_pidfile():
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))


def remove_pidfile():
    """Remove the pidfile only if it still names this process."""
    try:
        with open(PIDFILE) as f:
            if int(f.read()) == os.getpid():
                os.remove(PIDFILE)
    except (OSError, ValueError):
        pass


def local_timezone():
    if not os.path.exists("/etc/localtime"):
        return time.tzname[0]
    return os.path.realpath("/etc/localtime").split("zoneinfo/")[-1]


def pad_items(items):
    """Exactly 6 entries: a slot past the end of a shorter list keeps a stale title and value."""
    return (list(items) + [""] * SLOTS)[:SLOTS]


def settings(title_color, content_color, filter_on=False, opacity=100):
    # settings: null would load the "defult" drawable on preset; always send an object.
    return {"titleColor": title_color, "contentColor": content_color,
            "filter": {"value": "Smoke" if filter_on else None, "opacity": int(opacity)},
            "badges": []}


def screen_config(media, play_mode, ratio, items, settings, pad=True):
    return {
        "id": "Customization",
        "screenMode": "Full Screen",
        "ratio": ratio,
        "playMode": play_mode,
        "media": list(media),
        # Never null: case 105 calls showInfo() on it unguarded.
        "sysinfoDisplay": pad_items(items) if pad else list(items),
        "settings": settings,
        "timeZone": local_timezone(),
    }


def preset(items, settings):
    return {"id": "Customization", "sysinfoDisplay": pad_items(items), "settings": settings}


def valid_label(label):
    return 1 <= len(label) <= 16 and set(label) <= LABEL_CHARS


def title_px(title, slot):
    """Width in panel px of a title drawn in `slot` (1-6). Unknown characters count as 'W'."""
    size, _ = SLOT_TITLE[slot]
    return sum(_TITLE_ADVANCE.get(c, 833) for c in title) * size / 1000


def title_fits(title, slot):
    """False if the title runs past the panel's right edge (x=2240) in that slot.
    Checked on hardware: 16 x 'W' fits slot 1; 'Hard Disk Temperature' and 16 x 'M' clip in slot 5."""
    return title_px(title, slot) <= SLOT_TITLE[slot][1]


# A frame measured at this SeqNumber is at least as long as any real one: real seqs stay below
# 10 digits. The 3 B slack covers escapes (0x5A/0x5B) in len_be16 and the crc, which change with seq.
_FIT_SEQ = 10 ** 10 - 1
_ESCAPE_SLACK = 3


def fits(method, cmd, content):
    """True if the command fits one report at any SeqNumber the driver will reach."""
    return len(message(method, cmd, _FIT_SEQ, content)[0]) <= REPORT_LEN - _ESCAPE_SLACK


def superseded():
    """True when the pidfile names another live driver: a newer `play` or ryuod took over."""
    return running_driver() is not None


def pc_info(snapshot, items, now_ms):
    """PcInfo heartbeat body. snapshot maps item strings to values (°C, MHz, %, V, W).

    Gson rejects a fraction in an int field and drops the whole sample, so ints are rounded.
    gpu.temperature must stay numeric: HomeUI parses it with Float.parseFloat, uncaught.
    """
    def i(item):
        v = snapshot.get(item)
        return round(v) if isinstance(v, (int, float)) else 0

    def f(item, nd):
        v = snapshot.get(item)
        return round(float(v), nd) if isinstance(v, (int, float)) else 0.0

    body = {
        "timestamp": int(now_ms),
        "cpu": {"load": i("CPU Load"), "usage": i("CPU Usage"), "temperature": f("CPU Temperature", 1),
                "speedAverage": i("CPU Speed Average"), "voltage": f("CPU Voltage", 3)},
        "gpu": {"load": i("GPU Load"), "temperature": i("GPU Temperature"), "speed": i("GPU Speed"),
                "power": i("GPU Power"), "voltage": f("GPU Voltage", 3)},
        "memory": {"load": i("Memory Utilization"), "speed": i("Memory Frequency")},
        "disk": {"temperature": i("Hard Disk Temperature")},
        "motherboard": {"temperature": f("Motherboard Temperature", 1)},
    }
    fans = [{"name": it[len(FAN_PREFIX):], "value": i(it)} for it in items
            if it.startswith(FAN_PREFIX) and len(it) > len(FAN_PREFIX)]
    if fans:
        body["fans"] = fans
    return body
