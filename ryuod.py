#!/usr/bin/env python3
"""ryuod: keeps the RYUO IV pump LCD showing media with live Linux stats over it.

Control page and JSON API on http://127.0.0.1:8746/. One device worker thread owns the
hidraw fd: it runs the startup sequence, sends a PcInfo heartbeat every second (HomeUI
drops to standby after 5 s of silence) and reconnects after USB loss, suspend, or a
HomeUI restart. Settings persist in ~/.config/ryuo/state.json. A video uploaded through the
page is converted on an upload thread when the panel cannot play it as it is (ryuo_media.py),
pushed with adb and played.
"""
import argparse
import collections
import concurrent.futures
import contextlib
import copy
import errno
import glob
import http.server
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

HERE = os.path.dirname(os.path.realpath(__file__))
sys.path.insert(0, HERE)
import ryuo_media as M  # noqa: E402
import ryuo_proto as P  # noqa: E402

DEFAULT_PORT = 8746
INDEX = os.path.join(HERE, "web", "index.html")
MAX_BODY = 16 * 1024
MAX_UPLOAD = 4 * 2**30      # bytes, for POST /api/media/upload
UPLOAD_CHUNK = 2**20
UPLOAD_IDLE_S = 60          # an upload that sends nothing for this long is dropped
MAX_MEDIA = 20
LATE_ACK_S = 1.5   # a command's ack can queue behind HomeUI's slower POST all ack
COLOR_RE = re.compile(r"^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
SENSOR_RE = re.compile(r"^([A-Za-z0-9_.-]+):(temp[0-9]+)$")
DEFAULT_ITEMS = ["CPU Temperature", "CPU Load", "GPU Temperature", "GPU Load", "Memory Utilization", "Date&Time"]
DEFAULT_STATE = {
    "version": 1, "media": [], "playMode": "Single", "ratio": "2:1",
    "items": DEFAULT_ITEMS, "statsVisible": True, "titleColor": "#E5252B", "contentColor": "#FFFFFF",
    "filter": {"on": False, "opacity": 100}, "brightness": 100, "tempUnit": "Celsius",
    "memoryMHz": 0, "sensors": {"motherboard": "auto"},
}
TEMP_ITEMS = {"CPU Temperature", "GPU Temperature", "Hard Disk Temperature", "Motherboard Temperature"}
# (item, source key, note) for the custom labels; the unit slot always reads RPM.
CUSTOM = [
    ("Fan Speed Disk R MB/s", "disk", "unit slot always reads RPM"),
    ("Fan Speed Disk W MB/s", "disk", "unit slot always reads RPM"),
    ("Fan Speed Net Down KB/s", "net", "unit slot always reads RPM"),
    ("Fan Speed Net Up KB/s", "net", "unit slot always reads RPM"),
    ("Fan Speed GPU W", "gpu", "unit slot always reads RPM; same value as GPU Power"),
]
NOTES = {
    "GPU Usage": "same value as GPU Load (firmware reads gpu.load)",
    "GPU Power": "firmware draws a °C unit; Fan Speed GPU W shows RPM instead",
    "CPU Usage": "busiest single core",
    "Memory Frequency": "no unprivileged source; enter it under Units",
    "Date&Time": "device clock; title is weekday and day",
}
VERBOSE = False


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def boottime():
    # Keeps counting through suspend, unlike CLOCK_MONOTONIC, so a resume shows up as a gap.
    return time.clock_gettime(time.CLOCK_BOOTTIME)


def rd(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def rd_num(path, scale=1.0):
    try:
        return float(rd(path)) / scale
    except (TypeError, ValueError):
        return None


class Invalid(Exception):
    pass


# ---------------------------------------------------------------- validation, shared by HTTP and state load

def check_items(items, known):
    if not isinstance(items, list) or len(items) > P.SLOTS or not all(isinstance(i, str) for i in items):
        raise Invalid(f"items must be a list of at most {P.SLOTS} strings")
    items = P.pad_items(items)
    for it in items:
        if it and it not in known and not (it.startswith(P.FAN_PREFIX) and P.valid_label(it[len(P.FAN_PREFIX):])):
            raise Invalid(f"unknown item {it!r}; custom labels are 'Fan Speed ' + 1-16 of [A-Za-z0-9 ./%-]")
    used = [i for i in items if i]
    if len(used) != len(set(used)):
        raise Invalid("the same item in two slots only feeds the last one")
    return items


def check_fit(items):
    """Reject a custom label that would run past the panel edge in its slot.

    Firmware titles are fixed, so they pass; the catalog marks the slots where they clip."""
    for slot, it in enumerate(items, 1):
        if not it.startswith(P.FAN_PREFIX):
            continue
        label = it[len(P.FAN_PREFIX):]
        if not P.title_fits(label, slot):
            raise Invalid(f"label {label!r} is {P.title_px(label, slot):.0f} px wide; slot {slot} shows"
                          f" {P.SLOT_TITLE[slot][1]} px before the panel edge. Use a shorter label or slot 1, 2 or 6")
    return items


def title_of(item):
    """Panel title of an item: the label for Fan Speed items, else HomeUI's subTitle."""
    if item.startswith(P.FAN_PREFIX):
        return item[len(P.FAN_PREFIX):]
    return next((t for i, t, _, _ in P.ITEMS if i == item), "")


def clips_in(item):
    """Slots (1-6) where the item's title runs past the panel's right edge."""
    title = title_of(item)
    return [s for s in P.SLOT_TITLE if not P.title_fits(title, s)]


def check_color(v, key):
    if not isinstance(v, str) or not COLOR_RE.match(v):
        raise Invalid(f"{key} must be #RRGGBB or #AARRGGBB")
    return v


def check_int(v, key, lo, hi):
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise Invalid(f"{key} must be an integer {lo}-{hi}")
    return v


def check_filter(v, cur):
    if not isinstance(v, dict):
        raise Invalid("filter must be an object {on, opacity}")
    out = dict(cur)
    if "on" in v:
        if not isinstance(v["on"], bool):
            raise Invalid("filter.on must be true or false")
        out["on"] = v["on"]
    if "opacity" in v:
        out["opacity"] = check_int(v["opacity"], "filter.opacity", 0, 100)
    return out


# ---------------------------------------------------------------- state

def default_state_path():
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "ryuo", "state.json")


class State:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.data = copy.deepcopy(DEFAULT_STATE)
        self.fresh = True
        self.load()

    def load(self):
        try:
            with open(self.path) as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                raise ValueError("not an object")
        except FileNotFoundError:
            return
        except (OSError, ValueError) as e:
            log(f"state: {self.path} unreadable ({e}); moved to state.json.bad, using defaults")
            with contextlib.suppress(OSError):
                os.replace(self.path, self.path + ".bad")
            return
        self.fresh = False
        d = self.data
        known = {i[0] for i in P.ITEMS} | {c[0] for c in CUSTOM}
        # Each key is checked on its own, so one bad value falls back without losing the rest.
        loaders = {
            "media": lambda v: v if isinstance(v, list) and 1 <= len(v) <= MAX_MEDIA
            and all(isinstance(x, str) and 1 <= len(x) <= 255 for x in v) else None,
            "playMode": lambda v: v if v in P.PLAY_MODES else None,
            "ratio": lambda v: v if v in P.RATIOS else None,
            "items": lambda v: check_items(v, known),
            "statsVisible": lambda v: v if isinstance(v, bool) else None,
            "titleColor": lambda v: check_color(v, "titleColor"),
            "contentColor": lambda v: check_color(v, "contentColor"),
            "filter": lambda v: check_filter(v, d["filter"]),
            "brightness": lambda v: check_int(v, "brightness", 0, P.BRIGHTNESS_MAX),
            "tempUnit": lambda v: v if v in P.TEMP_UNITS else None,
            "memoryMHz": lambda v: check_int(v, "memoryMHz", 0, 20000),
            "sensors": lambda v: {"motherboard": v.get("motherboard")}
            if isinstance(v, dict) and isinstance(v.get("motherboard"), str) else None,
        }
        for key, fn in loaders.items():
            if key in raw:
                try:
                    val = fn(raw[key])
                except Invalid:
                    val = None
                if val is not None:
                    d[key] = val

    def get(self):
        with self.lock:
            return copy.deepcopy(self.data)

    def update(self, changes):
        with self.lock:
            self.data.update(copy.deepcopy(changes))
            self.save()
            return copy.deepcopy(self.data)

    def save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.data, f, indent=1, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)
        self.fresh = False


def public_config(st):
    return {k: st[k] for k in ("media", "playMode", "ratio", "items", "statsVisible", "titleColor",
                               "contentColor", "filter", "brightness", "tempUnit", "memoryMHz", "sensors")}


def shown_items(st):
    """The slots sent to the panel: the chosen items, or all blank while stats are hidden.
    Hiding keeps st["items"], so showing again restores the same layout."""
    return st["items"] if st["statsVisible"] else []


def overlay_settings(st):
    return P.settings(st["titleColor"], st["contentColor"], st["filter"]["on"], st["filter"]["opacity"])


def config_for(st):
    return P.screen_config(st["media"], st["playMode"], st["ratio"], shown_items(st), overlay_settings(st))


def fitted_config(st):
    """config_for(st), with media dropped from the end until the frame fits one report.

    Covers a state file with a long playlist, or a local timezone name that grew since the
    playlist was accepted. Returns (config, number of media dropped)."""
    st = dict(st)
    media = list(st["media"])
    total = len(media)
    while True:
        st["media"] = media
        cfg = config_for(st)
        if len(media) <= 1 or P.fits("POST", "waterBlockScreenId", cfg):
            return cfg, total - len(media)
        media = media[:-1]


# ---------------------------------------------------------------- Linux stats

def hwmon_chips():
    nodes = glob.glob("/sys/class/hwmon/hwmon*")
    nodes.sort(key=lambda p: int(re.sub(r"\D", "", os.path.basename(p)) or 0))
    return [(rd(d + "/name") or "", d) for d in nodes]


def chip_match(name, want):
    return name.startswith(want[:-1]) if want.endswith("*") else name == want


def find_sensor(chips, candidates, kind="temp"):
    """First (input path, source text) for [(chip name, label or None)]; None means index 1."""
    for want, label in candidates:
        for name, d in chips:
            if not chip_match(name, want):
                continue
            if label is None:
                path = f"{d}/{kind}1_input"
                if os.path.exists(path):
                    return path, f"{name} {kind}1"
                continue
            for lab in sorted(glob.glob(f"{d}/{kind}*_label")):
                if rd(lab) == label:
                    return lab[:-6] + "_input", f"{name} {label}"
    return None


def sensor_override(chips, spec):
    """'<hwmon name>:tempN' -> (path, source) if it exists."""
    m = SENSOR_RE.match(spec or "")
    if not m:
        return None
    for name, d in chips:
        if name == m.group(1) and os.path.exists(f"{d}/{m.group(2)}_input"):
            return f"{d}/{m.group(2)}_input", f"{name} {m.group(2)}"
    return None


def fan_label(text):
    text = "".join(c for c in text if c in P.LABEL_CHARS).strip()
    return text[:16].strip()


class Sampler(threading.Thread):
    """Samples Linux stats once a second into a snapshot {item string: value}."""

    def __init__(self, state):
        super().__init__(daemon=True, name="sampler")
        self.state = state
        self.lock = threading.Lock()
        self.values, self.sources, self.sampled_at = {}, {}, None
        self.prev = {}
        self.probed_at = -1e9
        self.nv_fail, self.nv_next = 0, 0.0
        self.stop_ev = threading.Event()

    # sources are re-probed every 60 s: hwmon numbers change across boots and hotplug
    def probe(self):
        chips = hwmon_chips()
        self.chips = chips
        self.cpu_temp = find_sensor(chips, [("k10temp", "Tctl"), ("zenpower", "Tdie"),
                                            ("coretemp", "Package id 0"), ("acpitz", None)])
        self.disk_temp = find_sensor(chips, [("nvme", "Composite"), ("drivetemp", None)])
        self.mb_auto = find_sensor(chips, [("nct67*", "SYSTIN"), ("gigabyte_wmi", None),
                                           ("asus_ec_sensors", "Motherboard")])
        self.cpu_volt = (find_sensor(chips, [("nct67*", "Vcore"), ("it87", "Vcore")], "in")
                         or find_sensor(chips, [("nct67*", None), ("it87", None)], "in"))
        self.nvidia = shutil.which("nvidia-smi")
        self.amd = None
        best = -1
        for card in glob.glob("/sys/class/drm/card[0-9]*"):
            dev = card + "/device"
            if not os.path.exists(dev + "/gpu_busy_percent"):
                continue
            vram = rd_num(dev + "/mem_info_vram_total") or 0
            if vram > best:
                mons = glob.glob(dev + "/hwmon/hwmon*")
                best, self.amd = vram, {"busy": dev + "/gpu_busy_percent", "hwmon": mons[0] if mons else None,
                                        "name": os.path.basename(card)}
        self.disks = [os.path.basename(os.path.dirname(p)) for p in glob.glob("/sys/block/*/device")]
        self.ifaces = [p.split("/")[4] for p in glob.glob("/sys/class/net/*/device")]
        self.fans = []
        for name, d in chips:
            for inp in sorted(glob.glob(f"{d}/fan*_input")):
                n = os.path.basename(inp)[:-6]
                label = fan_label(rd(f"{d}/{n}_label") or f"{name} {n}")
                item = P.FAN_PREFIX + label
                if label and item not in {f[0] for f in self.fans} | {c[0] for c in CUSTOM}:
                    self.fans.append((item, inp, f"{name} {n}"))

    def run(self):
        while not self.stop_ev.is_set():
            t0 = boottime()
            try:
                self.sample()
            except Exception as e:  # a sampler bug must not take the heartbeat down with it
                log(f"sampler: {type(e).__name__}: {e}")
            self.stop_ev.wait(max(0.05, 1.0 - (boottime() - t0)))

    def sample(self):
        now = boottime()
        if now - self.probed_at > 60:
            self.probe()
            self.probed_at = now
        st = self.state.get()
        v, src = {}, {}

        # CPU: load over all cores, usage = busiest core; busy excludes idle and iowait
        cores = {}
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("cpu"):
                    parts = line.split()
                    nums = [int(x) for x in parts[1:9]]
                    cores[parts[0]] = (sum(nums), nums[3] + nums[4])
        prev = self.prev.get("stat")
        if prev:
            def busy(key):
                if key not in prev:
                    return None
                dt, di = cores[key][0] - prev[key][0], cores[key][1] - prev[key][1]
                return 100.0 * (dt - di) / dt if dt > 0 else 0.0
            v["CPU Load"] = busy("cpu")
            per = [b for k in cores if k != "cpu" and (b := busy(k)) is not None]
            v["CPU Usage"] = max(per) if per else None
            src["CPU Load"] = src["CPU Usage"] = "/proc/stat"
        self.prev["stat"] = cores

        if self.cpu_temp:
            v["CPU Temperature"] = rd_num(self.cpu_temp[0], 1000)
            src["CPU Temperature"] = self.cpu_temp[1]
        freqs = [rd_num(p, 1000) for p in glob.glob("/sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq")]
        freqs = [x for x in freqs if x]
        if not freqs:
            with open("/proc/cpuinfo") as f:
                freqs = [float(line.split(":")[1]) for line in f if line.startswith("cpu MHz")]
        if freqs:
            v["CPU Speed Average"] = sum(freqs) / len(freqs)
            src["CPU Speed Average"] = "cpufreq"
        if self.cpu_volt:
            v["CPU Voltage"] = rd_num(self.cpu_volt[0], 1000)
            src["CPU Voltage"] = self.cpu_volt[1]

        self.sample_gpu(v, src, now)

        mem = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, _, rest = line.partition(":")
                mem[k] = int(rest.split()[0])
        if mem.get("MemTotal"):
            v["Memory Utilization"] = 100.0 * (mem["MemTotal"] - mem.get("MemAvailable", 0)) / mem["MemTotal"]
            src["Memory Utilization"] = "/proc/meminfo"
        if st["memoryMHz"] > 0:
            v["Memory Frequency"] = st["memoryMHz"]
            src["Memory Frequency"] = "state memoryMHz"

        if self.disk_temp:
            v["Hard Disk Temperature"] = rd_num(self.disk_temp[0], 1000)
            src["Hard Disk Temperature"] = self.disk_temp[1]
        mb_spec = st["sensors"].get("motherboard", "auto")
        mb = sensor_override(self.chips, mb_spec) if mb_spec != "auto" else self.mb_auto
        if mb:
            v["Motherboard Temperature"] = rd_num(mb[0], 1000)
            src["Motherboard Temperature"] = mb[1]
        v["Date&Time"] = time.strftime("%H:%M")
        src["Date&Time"] = "device clock"

        # Disk and network throughput, as deltas since the previous sample
        rd_s = wr_s = 0
        with open("/proc/diskstats") as f:
            for line in f:
                p = line.split()
                if len(p) > 9 and p[2] in self.disks:
                    rd_s += int(p[5])
                    wr_s += int(p[9])
        rx = tx = 0
        with open("/proc/net/dev") as f:
            for line in f:
                name, sep, rest = line.partition(":")
                if sep and name.strip() in self.ifaces:
                    p = rest.split()
                    rx += int(p[0])
                    tx += int(p[8])
        cur = (now, rd_s, wr_s, rx, tx)
        last = self.prev.get("io")
        if last and cur[0] > last[0]:
            dt = cur[0] - last[0]
            if self.disks:
                v["Fan Speed Disk R MB/s"] = max(0, cur[1] - last[1]) * 512 / 1e6 / dt
                v["Fan Speed Disk W MB/s"] = max(0, cur[2] - last[2]) * 512 / 1e6 / dt
                src["Fan Speed Disk R MB/s"] = src["Fan Speed Disk W MB/s"] = "/proc/diskstats " + ",".join(self.disks)
            if self.ifaces:
                v["Fan Speed Net Down KB/s"] = max(0, cur[3] - last[3]) / 1024 / dt
                v["Fan Speed Net Up KB/s"] = max(0, cur[4] - last[4]) / 1024 / dt
                src["Fan Speed Net Down KB/s"] = src["Fan Speed Net Up KB/s"] = "/proc/net/dev " + ",".join(self.ifaces)
        self.prev["io"] = cur

        for item, path, source in self.fans:
            x = rd_num(path)
            if x is not None:
                v[item], src[item] = x, source

        v = {k: x for k, x in v.items() if x is not None}
        src = {k: s for k, s in src.items() if k in v}
        with self.lock:
            self.values, self.sources, self.sampled_at = v, src, int(time.time() * 1000)

    def sample_gpu(self, v, src, now):
        if self.nvidia:
            if now < self.nv_next:
                return
            try:
                out = subprocess.run(
                    [self.nvidia, "--query-gpu=temperature.gpu,utilization.gpu,clocks.current.graphics,power.draw",
                     "--format=csv,noheader,nounits", "-i", "0"],
                    capture_output=True, text=True, timeout=1.5, check=True).stdout
                fields = [x.strip() for x in out.strip().splitlines()[0].split(",")]
                if len(fields) != 4:
                    raise ValueError(out)
            except (OSError, subprocess.SubprocessError, ValueError, IndexError) as e:
                self.nv_fail += 1
                if self.nv_fail >= 3:
                    self.nv_next = now + 30
                    if self.nv_fail == 3:
                        log(f"sampler: nvidia-smi failed 3 times ({type(e).__name__}); retrying every 30 s")
                return
            self.nv_fail = 0
            for item, raw in zip(("GPU Temperature", "GPU Load", "GPU Speed", "GPU Power"), fields, strict=True):
                try:
                    v[item] = float(raw)
                    src[item] = "nvidia-smi"
                except ValueError:  # "[N/A]"
                    pass
        elif self.amd:
            a, mon = self.amd, self.amd["hwmon"]
            v["GPU Load"] = rd_num(a["busy"])
            src["GPU Load"] = f"amdgpu {a['name']}"
            if mon:
                t = find_sensor([("amdgpu", mon)], [("amdgpu", "edge")])
                if t:
                    v["GPU Temperature"], src["GPU Temperature"] = rd_num(t[0], 1000), t[1]
                if os.path.exists(mon + "/freq1_input"):
                    v["GPU Speed"], src["GPU Speed"] = rd_num(mon + "/freq1_input", 1e6), "amdgpu freq1"
                for f in ("power1_average", "power1_input"):
                    if os.path.exists(f"{mon}/{f}"):
                        v["GPU Power"], src["GPU Power"] = rd_num(f"{mon}/{f}", 1e6), f"amdgpu {f}"
                        break
                volt = find_sensor([("amdgpu", mon)], [("amdgpu", "vddgfx")], "in")
                if volt:
                    v["GPU Voltage"], src["GPU Voltage"] = rd_num(volt[0], 1000), volt[1]
        if "GPU Load" in v:
            v["GPU Usage"], src["GPU Usage"] = v["GPU Load"], src["GPU Load"]
        if "GPU Power" in v:
            v["Fan Speed GPU W"], src["Fan Speed GPU W"] = v["GPU Power"], src["GPU Power"]

    def snapshot(self):
        with self.lock:
            return dict(self.values), dict(self.sources), self.sampled_at

    def catalog(self, temp_unit):
        _, sources, _ = self.snapshot()
        deg = "°F" if temp_unit == "Fahrenheit" else "°C"
        out = []
        for item, title, unit, group in P.ITEMS:
            out.append({"item": item, "title": title, "unit": deg if unit == "°C" else unit, "group": group,
                        "available": item in sources, "source": sources.get(item), "note": NOTES.get(item),
                        "clipsIn": clips_in(item)})
        for item, _, note in CUSTOM:
            out.append({"item": item, "title": item[len(P.FAN_PREFIX):], "unit": "RPM", "group": "Custom",
                        "available": item in sources, "source": sources.get(item), "note": note,
                        "clipsIn": clips_in(item)})
        for item, _, _source in getattr(self, "fans", []):
            out.append({"item": item, "title": item[len(P.FAN_PREFIX):], "unit": "RPM", "group": "Custom",
                        "available": item in sources, "source": sources.get(item), "note": None,
                        "clipsIn": clips_in(item)})
        return out

    def known_items(self):
        return {i[0] for i in P.ITEMS} | {c[0] for c in CUSTOM} | {f[0] for f in getattr(self, "fans", [])}


def panel_text(item, value, temp_unit):
    """The value as HomeUI would draw it, for the preview. Temperatures convert on the device."""
    if isinstance(value, str):
        return value
    if item in TEMP_ITEMS:
        return str(int(value * 1.8 + 32 if temp_unit == "Fahrenheit" else value))
    if item.endswith("Voltage"):
        return repr(round(value, 3))
    return str(round(value))


# ---------------------------------------------------------------- device worker

class Job:
    def __init__(self, method, cmd, body, wait=0.25):
        self.method, self.cmd, self.body, self.wait = method, cmd, body, wait
        self.futures = [concurrent.futures.Future()]


class Device(threading.Thread):
    def __init__(self, state, sampler, heartbeat_mode):
        super().__init__(daemon=True, name="device")
        self.state, self.sampler, self.mode = state, sampler, heartbeat_mode
        self.dev = None
        self.lock = threading.Lock()
        self.jobs = collections.deque()
        self.wake_r, self.wake_w = os.pipe()
        os.set_blocking(self.wake_r, False)
        self.stopping = threading.Event()
        self.send_disconn = True
        self.ready = False          # startup sequence finished on the open fd
        self.ids = None
        self.info = {}              # parsed conn reply
        self.media = {"source": None, "fetchedAt": None, "preset": [], "custom": []}
        self.last_write = 0.0
        self.last_hb_ok = None      # boottime of the last heartbeat write
        self.last_hb_wall = None    # monotonic, for the age shown in /api/state
        self.last_ack_wall = None
        self.next_hb = 0.0
        self.hb_pending = None
        self.missed = 0
        self.last_t3 = -1e9
        self.recoveries = 0
        self.was_connected = False
        self.last_error = None
        self.last_pcinfo = None
        self.last_hb_bytes = None
        # Jobs whose ack missed call()'s window: ack number -> (futures, result, monotonic deadline).
        self.pending = {}
        self.last_seq = 0

    # -- called from HTTP threads

    def submit(self, method, cmd, body, wait=0.25):
        with self.lock:
            if self.dev is None:
                return None
            last = self.jobs[-1] if self.jobs else None
            if cmd == "preset" and last is not None and last.cmd == "preset":
                # Consecutive presets collapse into the newest; every waiter gets its result.
                last.body = body
                fut = concurrent.futures.Future()
                last.futures.append(fut)
            else:
                job = Job(method, cmd, body, wait)
                self.jobs.append(job)
                fut = job.futures[0]
        os.write(self.wake_w, b"x")
        return fut

    def stop(self, send_disconn):
        self.send_disconn = send_disconn
        self.stopping.set()
        os.write(self.wake_w, b"x")

    def status(self):
        now = time.monotonic()
        age = lambda t: None if t is None else int((now - t) * 1000)  # noqa: E731
        vid, pid = self.ids or (None, None)
        dev = self.dev
        return {"connected": dev is not None and self.ready, "hidraw": dev.path if dev else None,
                "vid": f"{vid:04x}" if vid else None, "pid": f"{pid:04x}" if pid else None,
                "firmware": (self.info.get("version") or {}).get("firmware"), "product": self.info.get("product"),
                "lastHeartbeatMs": age(self.last_hb_wall), "lastHomeuiAckMs": age(self.last_ack_wall),
                "recoveries": self.recoveries, "lastError": self.last_error, "heartbeat": self.mode}

    # -- worker thread

    def run(self):
        while not self.stopping.is_set():
            if self.dev is None:
                self.connect()
                continue
            try:
                self.tick()
            except OSError as e:
                self.lost(e)
            except Exception as e:  # a bug here must not end the heartbeat for good
                log(f"device: unexpected {type(e).__name__}: {e}; reconnecting")
                self.lost(e)
                self.stopping.wait(2)
        if self.dev is not None:
            if self.send_disconn:
                with contextlib.suppress(OSError):
                    self.call("POST", "disconn", None, wait=0.1)
            self.dev.close()
            self.dev = None
        self.fail_jobs()

    def connect(self):
        path = P.find_hidraw()
        if path is None:
            if self.last_error != "HID interface not found":
                log("device: RYUO IV HID interface not found; rescanning every 2 s")
            self.last_error = "HID interface not found"
            self.stopping.wait(2)
            return
        try:
            dev = P.Ryuo(path)
        except OSError as e:
            self.last_error = f"open {path}: {e.strerror}"
            log(f"device: {self.last_error}")
            self.stopping.wait(2)
            return
        dev.verbose = VERBOSE
        self.ids = P.hid_ids("/sys/class/hidraw/" + os.path.basename(path))
        with self.lock:
            self.dev = dev
        try:
            self.startup()
        except Exception as e:  # OSError is USB loss; anything else must not kill the thread
            if not isinstance(e, OSError):
                log(f"device: startup failed with {type(e).__name__}: {e}")
            self.lost(e)
            self.stopping.wait(2)
            return
        if self.was_connected:
            self.recoveries += 1
        self.was_connected = True
        log(f"device: connected on {path} ({self.info.get('product')}, {(self.info.get('version') or {}).get('firmware')})")

    def lost(self, e):
        log(f"device: lost ({e}); rescanning every 2 s")
        self.last_error = f"{type(e).__name__}: {e}"
        with self.lock:
            dev, self.dev = self.dev, None
        self.ready = False
        if dev:
            dev.close()
        self.fail_jobs()

    def fail_jobs(self):
        with self.lock:
            jobs, self.jobs = list(self.jobs), collections.deque()
        for job in jobs:
            for f in job.futures:
                f.set_result({"applied": False, "acked": False})
        self.expire_pending(all_=True)

    def expire_pending(self, all_=False):
        """Report jobs whose late-ack window closed (or all of them) as written but not acked."""
        now = time.monotonic()
        for ack in [a for a, (_, _, end) in self.pending.items() if all_ or end <= now]:
            futures, result, _ = self.pending.pop(ack)
            for f in futures:
                f.set_result(result)

    def startup(self):
        """§2.4: run on connect and on every recovery. Each step waits for its ack or 0.3 s."""
        self.ready = False
        _acked, body = self.call("POST", "conn", {"OS": "Linux"}, wait=1.5)
        if body and "media" in body:
            self.set_media_from_conn(body)
        st = self.state.get()
        if not st["media"]:
            names = sorted(self.media["preset"]) or ["RYUO_IV_HW_Info_01.mp4"]
            st = self.state.update({"media": names[:1]})
        self.call("POST", "temperature", {"value": st["tempUnit"]}, wait=0.3)
        # isBlockScreen gates brightness; without this the brightness step is ignored
        self.call("POST", "waterBlockScreen", {"enable": True}, wait=0.3)
        cfg, dropped = fitted_config(st)
        if dropped:
            log(f"device: playlist too long for one HID report; playing the first {len(cfg['media'])}"
                f" of {len(st['media'])} files")
        try:
            self.call("POST", "waterBlockScreenId", cfg, wait=0.3)
        except P.FrameTooLarge as e:
            # Only a single media name this long gets here; keep the heartbeat and brightness
            # going rather than lose the device worker.
            log(f"device: {e}; config not sent")
            self.last_error = str(e)
        # HomeUI only leaves standby on its own after a 5 s silence; "resume" hides it at once.
        self.call("POST", "power", {"event": "resume"}, wait=0.3)
        # Steps above restore the brightness HomeUI saved in standby (50/255); set ours last.
        self.call("POST", "brightness", {"value": st["brightness"]}, wait=0.3)
        self.ready = True
        self.missed, self.hb_pending = 0, None
        self.next_hb = 0.0
        self.heartbeat()

    def set_media_from_conn(self, body):
        self.info = body
        media = body.get("media") or {}
        self.media = {"source": "conn", "fetchedAt": int(time.time() * 1000),
                      "preset": [m for m in media.get("preset", []) if isinstance(m, str)],
                      "custom": [m for m in media.get("custom", []) if isinstance(m, str)]}

    def call(self, method, cmd, body, wait):
        """Write one frame (at most 8/s), then read until its ack or `wait` s. (acked, ack body)."""
        gap = self.last_write + 0.125 - time.monotonic()
        while gap > 0:
            self.drain(gap)
            gap = self.last_write + 0.125 - time.monotonic()
        seq = self.last_seq = self.dev.write(method, cmd, body)
        self.last_write = time.monotonic()
        end = self.last_write + wait
        while (left := end - time.monotonic()) > 0:
            for text in self.dev.poll(left):
                status, ack, rbody = self.handle(text)
                if ack == seq + 1:
                    return status == 200, rbody
        return False, None

    def drain(self, timeout):
        for text in self.dev.poll(timeout):
            self.handle(text)

    def handle(self, text):
        status, ack, body = P.parse_reply(text)
        if body is not None and "status" in body:
            # Only HomeUI answers POST all, with {"status":{"fanLCD":...}}: proof it is alive.
            self.last_ack_wall = time.monotonic()
            self.missed, self.hb_pending = 0, None
        late = self.pending.pop(ack, None) if ack is not None else None
        if late:
            futures, result, _ = late
            for f in futures:
                f.set_result({**result, "acked": status == 200})
        return status, ack, body

    def tick(self):
        now = boottime()
        if self.last_hb_ok is not None and now - self.last_hb_ok > 4.5:
            self.recover(f"heartbeat gap {now - self.last_hb_ok:.1f} s")
            return
        if self.mode == "post" and self.missed >= 5 and now - self.last_t3 > 30:
            self.last_t3 = now
            self.recover(f"no HomeUI ack for {self.missed} heartbeats")
            return
        if now >= self.next_hb:
            self.heartbeat()
            return
        with self.lock:
            job = self.jobs.popleft() if self.jobs else None
        if job:
            self.run_job(job)
            return
        self.expire_pending()
        timeout = self.next_hb - now
        if self.pending:
            timeout = min(timeout, min(end for _, _, end in self.pending.values()) - time.monotonic())
        r, _, _ = select.select([self.dev.fd, self.wake_r], [], [], max(0.0, timeout))
        if self.wake_r in r:
            with contextlib.suppress(BlockingIOError):
                os.read(self.wake_r, 4096)
        if self.dev.fd in r:
            self.drain(0)

    def recover(self, why):
        log(f"device: recovery ({why}); re-running startup")
        self.last_error = why
        self.startup()  # an OSError here falls through to lost() and a reconnect, counted there
        self.recoveries += 1

    def heartbeat(self):
        st = self.state.get()
        values, _, _ = self.sampler.snapshot()
        body = P.pc_info(values, st["items"], time.time() * 1000)
        method, cmd = ("POST", "all") if self.mode == "post" else ("STATE", "all")
        size = len(P.message(method, cmd, self.dev.seq + 1, body)[0])
        if size > P.REPORT_LEN:
            log(f"device: heartbeat frame {size} bytes > {P.REPORT_LEN}; sending timestamp only")
            body = {"timestamp": body["timestamp"]}
            size = len(P.message(method, cmd, self.dev.seq + 1, body)[0])
        if self.mode == "post" and self.hb_pending is not None:
            self.missed += 1
        self.hb_pending = True
        now = boottime()
        self.next_hb = self.next_hb + 1.0 if self.next_hb + 1.0 > now else now + 1.0
        self.call(method, cmd, body, wait=0.25)
        self.last_hb_ok = boottime()
        self.last_hb_wall = time.monotonic()
        self.last_pcinfo, self.last_hb_bytes = body, size

    def run_job(self, job):
        result = {"applied": True, "acked": False}
        try:
            acked, body = self.call(job.method, job.cmd, job.body, job.wait)
            result["acked"] = acked
            if job.cmd == "conn":
                if body and "media" in body:
                    self.set_media_from_conn(body)
                result["media"] = body is not None and "media" in body
        except P.FrameTooLarge as e:
            result = {"applied": False, "acked": False, "error": str(e)}
        except OSError:
            for f in job.futures:
                f.set_result({"applied": False, "acked": False})
            raise
        if result["applied"] and not result["acked"] and job.cmd != "conn":
            # The ack can still come: SerialService acks in order, and this one may sit behind
            # HomeUI's ack for the previous POST all. handle() resolves it; tick() times it out.
            self.pending[self.last_seq + 1] = (job.futures, result, self.last_write + LATE_ACK_S)
            return
        for f in job.futures:
            f.set_result(result)


# ---------------------------------------------------------------- HTTP

def adb_media():
    try:
        out = subprocess.run(["adb", "shell", "ls -1 /sdcard/pcMediaPreset /sdcard/pcMedia"],
                             capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    lists, cur = {"preset": [], "custom": []}, None
    for line in out.splitlines():
        line = line.strip()
        if line.endswith(":"):
            cur = {"/sdcard/pcMediaPreset:": "preset", "/sdcard/pcMedia:": "custom"}.get(line)
        elif line and cur:
            lists[cur].append(line)
    if cur is None:
        return None
    return {"source": "adb", "fetchedAt": int(time.time() * 1000), **lists}


def select_playlist(d, media, mode):
    """Validate a playlist against the device media list and save it. Returns (ScreenConfig, state)."""
    st = d.state.get()
    if not isinstance(media, list) or not 1 <= len(media) <= MAX_MEDIA or not all(isinstance(m, str) for m in media):
        raise Invalid(f"media must be a list of 1-{MAX_MEDIA} file names")
    known = set(d.device.media["preset"]) | set(d.device.media["custom"])
    missing = [m for m in media if m not in known]
    if missing:
        raise Invalid(f"not in the device media list: {', '.join(missing)} (GET /api/media?refresh=1)")
    if mode not in P.PLAY_MODES:
        raise Invalid("playMode must be Single, Cycle or Random")  # anything else: black screen
    cfg = P.screen_config(media, mode, st["ratio"], shown_items(st), overlay_settings(st))
    # Measured at the largest SeqNumber the daemon will reach, so a playlist accepted now
    # still fits after days of heartbeats; state is saved only once it passes.
    if not P.fits("POST", "waterBlockScreenId", cfg):
        raise Invalid("playlist too long for one HID report")
    return cfg, d.state.update({"media": media, "playMode": mode})


# ---------------------------------------------------------------- video upload

def default_upload_dir():
    # On disk under ~/.cache: /tmp is a RAM-backed tmpfs on Fedora, too small for large videos.
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "ryuo", "upload")


class Upload(threading.Thread):
    """One uploaded video on its way to the panel: received, probed, converted if the panel
    cannot play it as it is, pushed with adb and played as a single looping clip.

    Runs on its own thread, apart from the device worker; it only queues the final
    waterBlockScreenId, so the heartbeat keeps going during a long transcode."""

    def __init__(self, d, filename, fit, length):
        super().__init__(daemon=True, name="upload")
        self.d, self.fit, self.length = d, fit, length
        self.lock = threading.Lock()
        self.cancel_ = M.Cancel()
        self.finished = False
        self.dir = tempfile.mkdtemp(prefix="job-", dir=d.upload_dir)
        ext = os.path.splitext(filename)[1].lower()
        self.src = os.path.join(self.dir, "source" + (ext if re.fullmatch(r"\.[a-z0-9]{1,8}", ext) else ""))
        self.status = {"state": "receiving", "file": os.path.basename(filename) or None, "bytes": length,
                       "received": 0, "progress": 0.0, "speed": None, "action": None, "reason": None,
                       "encoder": None, "name": None, "error": None, "applied": None, "acked": None,
                       "startedAt": int(time.time() * 1000), "finishedAt": None}

    def snapshot(self):
        with self.lock:
            return dict(self.status)

    def set(self, **kw):
        with self.lock:
            self.status.update(kw)

    def receive(self, rfile):
        """Copy exactly `length` bytes of the request body to the source file, 1 MiB at a time."""
        left = self.length
        with open(self.src, "wb") as f:
            while left > 0:
                chunk = rfile.read(min(UPLOAD_CHUNK, left))
                if not chunk:
                    raise Invalid(f"connection closed after {self.length - left} of {self.length} bytes")
                if self.cancel_.is_set():
                    raise Invalid("cancelled")
                f.write(chunk)
                left -= len(chunk)
                self.set(received=self.length - left, progress=(self.length - left) / self.length)

    def cancel(self):
        self.cancel_.cancel()

    def fail(self, msg, state="error"):
        self.set(state=state, error=msg if state == "error" else None, progress=None, speed=None,
                 finishedAt=int(time.time() * 1000))
        shutil.rmtree(self.dir, ignore_errors=True)
        self.finished = True

    def run(self):
        try:
            self.process()
        except M.Cancelled:
            self.fail(None, "cancelled")
        except (M.MediaError, Invalid) as e:
            # ffprobe and ffmpeg name the job's temp file; show the name the user picked instead.
            self.fail(str(e).replace(self.src, self.status["file"] or "the file"))
        except Exception as e:  # shown in the UI; otherwise the job would read "running" forever
            log(f"upload: unexpected {type(e).__name__}: {e}")
            self.fail(f"{type(e).__name__}: {e}")
        else:
            self.set(finishedAt=int(time.time() * 1000))
            shutil.rmtree(self.dir, ignore_errors=True)
            self.finished = True

    def process(self):
        self.set(state="probing", progress=None)
        t = M.tools()
        info = M.inspect(self.src, t)
        action, reason = M.plan(info)
        self.set(action=action, reason=reason, encoder=t.encoder if action == "transcode" else None)
        log(f"upload: {self.status['file']}: {action} ({reason})")
        out = self.src
        if action != "copy":
            out = os.path.join(self.dir, "panel.mp4")
            self.set(state="converting", progress=0.0 if info["duration"] else None)
            M.convert(self.src, out, info, action, self.fit, t,
                      lambda done, speed: self.set(progress=done, speed=speed), self.cancel_)
        if self.cancel_.is_set():
            raise M.Cancelled()
        name = M.device_name(self.status["file"])
        self.set(state="pushing", progress=None, speed=None, name=name)
        M.push(out, name, P.MEDIA_DIR, self.cancel_)
        dev = self.d.device
        dev.media = {**dev.media, "custom": [*dev.media["custom"], name]}
        self.set(state="starting")
        cfg, _ = select_playlist(self.d, [name], "Single")
        fut = dev.submit("POST", "waterBlockScreenId", cfg, 1.0)
        res = {"applied": False, "acked": False}  # saved; the startup sequence sends it on reconnect
        if fut is not None:
            try:
                res = fut.result(3)
            except concurrent.futures.TimeoutError:
                res = {"applied": True, "acked": False}
        self.set(state="done", applied=res.get("applied"), acked=res.get("acked"))
        log(f"upload: playing {name}")


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "ryuod"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if VERBOSE:
            log("http: " + fmt % args)

    @property
    def d(self):
        return self.server.daemon_ref

    def reply(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def error(self, code, msg):
        self.reply(code, {"ok": False, "error": msg})

    def host_ok(self):
        port = self.server.server_address[1]
        if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            self.error(403, "Host must be 127.0.0.1 or localhost")
            return False
        return True

    def do_OPTIONS(self):
        self.error(405, "method not allowed")

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS

    def do_GET(self):
        if not self.host_ok():
            return
        path, _, query = self.path.partition("?")
        if path in ("/", "/index.html"):
            try:
                with open(INDEX, "rb") as f:
                    data = f.read()
            except OSError:
                return self.error(404, "web/index.html missing")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        route = {"/api/state": self.get_state, "/api/stats": self.get_stats,
                 "/api/catalog": self.get_catalog, "/api/media": self.get_media}.get(path)
        if route is None:
            return self.error(404, "not found")
        route(query)

    def do_POST(self):
        if not self.host_ok():
            return
        path, _, query = self.path.partition("?")
        if path == "/api/media/upload":
            return self.post_upload(query)  # a raw file body, too large for the JSON path below
        route = {"/api/overlay": self.post_overlay, "/api/brightness": self.post_brightness,
                 "/api/media/select": self.post_media_select, "/api/prefs": self.post_prefs,
                 "/api/media/upload/cancel": self.post_upload_cancel}.get(path)
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.close_connection = True
            return self.error(413, f"body over {MAX_BODY} bytes")
        raw = self.rfile.read(length)
        if route is None:
            return self.error(404, "not found")
        # A cross-origin page can only send text/plain or form bodies without a preflight,
        # and OPTIONS is refused, so this blocks other web pages from driving the cooler.
        if ctype != "application/json":
            return self.error(415, "Content-Type must be application/json")
        try:
            body = json.loads(raw)
        except ValueError:
            return self.error(400, "invalid JSON")
        if not isinstance(body, dict):
            return self.error(400, "body must be a JSON object")
        try:
            route(body)
        except Invalid as e:
            self.error(400, str(e))

    # -- GET

    def get_state(self, _q):
        st = self.d.state.get()
        dev = self.d.device
        self.reply(200, {"ok": True, "device": dev.status(), "config": public_config(st),
                         "limits": {"slots": P.SLOTS, "brightnessMax": P.BRIGHTNESS_MAX,
                                    "frameMax": P.REPORT_LEN, "lastHeartbeatBytes": dev.last_hb_bytes,
                                    "uploadMax": MAX_UPLOAD},
                         "media": {k: dev.media[k] for k in ("preset", "custom")},
                         "upload": self.d.upload.snapshot() if self.d.upload else None})

    def get_stats(self, _q):
        st = self.d.state.get()
        values, sources, at = self.d.sampler.snapshot()
        out = {}
        for c in self.d.sampler.catalog(st["tempUnit"]):
            item = c["item"]
            val = values.get(item, 0)
            shown = val
            if isinstance(val, (int, float)) and item in TEMP_ITEMS and st["tempUnit"] == "Fahrenheit":
                shown = round(val * 1.8 + 32, 1)
            elif isinstance(val, float):
                shown = round(val, 3 if item.endswith("Voltage") else 1)
            out[item] = {"value": shown, "unit": c["unit"], "available": item in sources,
                         "panel": panel_text(item, val, st["tempUnit"])}
        self.reply(200, {"ok": True, "sampledAt": at, "values": out, "lastPcInfo": self.d.device.last_pcinfo})

    def get_catalog(self, _q):
        self.reply(200, {"ok": True, "items": self.d.sampler.catalog(self.d.state.get()["tempUnit"])})

    def get_media(self, query):
        dev = self.d.device
        if "refresh=1" in query.split("&") or not dev.media["source"]:
            fut = dev.submit("POST", "conn", {"OS": "Linux"}, wait=1.5)
            got = False
            if fut is not None:
                with contextlib.suppress(concurrent.futures.TimeoutError):
                    got = fut.result(3).get("media", False)
            if not got:
                fallback = adb_media()
                if fallback is None:
                    return self.error(504, "neither the conn reply nor adb gave a media list")
                dev.media = fallback
        self.reply(200, {"ok": True, **dev.media})

    # -- POST

    def apply(self, method, cmd, body, wait=0.25):
        """Send through the worker. Returns the response fields, or None after a 504."""
        fut = self.d.device.submit(method, cmd, body, wait)
        if fut is None:
            return {"applied": False, "acked": False}
        try:
            res = fut.result(3)
        except concurrent.futures.TimeoutError:
            self.error(504, "device worker did not answer within 3 s")
            return None
        if res.get("error"):
            self.error(400, res["error"])
            return None
        return {"applied": res["applied"], "acked": res["acked"]}

    def post_overlay(self, body):
        st = self.d.state.get()
        changes = {}
        if "items" in body:
            changes["items"] = check_fit(check_items(body["items"], self.d.sampler.known_items()))
        for key in ("titleColor", "contentColor"):
            if key in body:
                changes[key] = check_color(body[key], key)
        if "filter" in body:
            changes["filter"] = check_filter(body["filter"], st["filter"])
        if "statsVisible" in body:
            if not isinstance(body["statsVisible"], bool):
                raise Invalid("statsVisible must be true or false")
            changes["statsVisible"] = body["statsVisible"]
        st = self.d.state.update(changes)
        res = self.apply("POST", "preset", P.preset(shown_items(st), overlay_settings(st)))
        if res is not None:
            self.reply(200, {"ok": True, **res, "sent": ["POST preset"], "restartsVideo": False,
                             "config": public_config(st)})

    def post_brightness(self, body):
        value = check_int(body.get("value"), "value", 0, P.BRIGHTNESS_MAX)
        self.d.state.update({"brightness": value})
        res = self.apply("POST", "brightness", {"value": value})
        if res is not None:
            self.reply(200, {"ok": True, **res, "sent": ["POST brightness"], "restartsVideo": False,
                             "deviceLevel": min(255, int(value * 2.5))})

    def post_media_select(self, body):
        media = body.get("media")
        mode = body.get("playMode", self.d.state.get()["playMode"])
        cfg, st = select_playlist(self.d, media, mode)
        # The ack follows HomeUI's config handling and lands after the usual 250 ms window.
        res = self.apply("POST", "waterBlockScreenId", cfg, wait=1.0)
        if res is not None:
            self.reply(200, {"ok": True, **res, "sent": ["POST waterBlockScreenId"], "restartsVideo": True,
                             "config": public_config(st)})

    def post_upload(self, query):
        """Stream the body to a file under the cache dir, then probe, convert, push and play it
        on a job thread. Answers 202 once the file is received; GET /api/state reports the job."""
        # application/octet-stream and X-Filename both need a CORS preflight, which OPTIONS
        # refuses, so other web pages cannot upload either.
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        params = urllib.parse.parse_qs(query)
        fit = params.get("fit", ["crop"])[0]
        filename = urllib.parse.unquote(self.headers.get("X-Filename", ""))
        # The body stays unread on every refusal below, so the connection cannot be reused.
        self.close_connection = True
        if ctype != "application/octet-stream":
            return self.error(415, "Content-Type must be application/octet-stream")
        if length <= 0:
            return self.error(411, "Content-Length required")
        if length > MAX_UPLOAD:
            return self.error(413, f"file over {MAX_UPLOAD // 2**30} GiB")
        if fit not in M.FITS:
            return self.error(400, "fit must be crop or pad")
        d = self.d
        with d.upload_lock:
            if d.upload is not None and not d.upload.finished:
                return self.error(409, "another video is still being processed")
            os.makedirs(d.upload_dir, exist_ok=True)
            # The source and the converted copy can each be about the size of the upload.
            if shutil.disk_usage(d.upload_dir).free < 2 * length + 256 * 2**20:
                return self.error(507, f"not enough free space in {d.upload_dir}")
            job = d.upload = Upload(d, filename, fit, length)
        try:
            self.connection.settimeout(UPLOAD_IDLE_S)
            job.receive(self.rfile)
        except (OSError, Invalid) as e:
            if job.cancel_.is_set():
                job.fail(None, "cancelled")
                return self.error(400, "upload cancelled")
            job.fail(f"upload stopped: {e}")
            return self.error(400, f"upload stopped: {e}")
        finally:
            self.connection.settimeout(None)
        self.close_connection = False
        job.start()
        self.reply(202, {"ok": True, "upload": job.snapshot()})

    def post_upload_cancel(self, _body):
        job = self.d.upload
        if job is None or job.finished:
            return self.error(409, "no upload in progress")
        job.cancel()
        self.reply(200, {"ok": True, "upload": job.snapshot()})

    def post_prefs(self, body):
        st = self.d.state.get()
        changes = {}
        if "tempUnit" in body:
            if body["tempUnit"] not in P.TEMP_UNITS:
                raise Invalid("tempUnit must be Celsius or Fahrenheit")  # anything else freezes temperatures
            changes["tempUnit"] = body["tempUnit"]
        if "memoryMHz" in body:
            changes["memoryMHz"] = check_int(body["memoryMHz"], "memoryMHz", 0, 20000)
        if "sensors" in body:
            s = body["sensors"]
            mb = s.get("motherboard") if isinstance(s, dict) else None
            if mb != "auto" and (not isinstance(mb, str) or sensor_override(hwmon_chips(), mb) is None):
                raise Invalid("sensors.motherboard must be 'auto' or an existing '<hwmon name>:tempN'")
            changes["sensors"] = {"motherboard": mb}
        unit_changed = "tempUnit" in changes and changes["tempUnit"] != st["tempUnit"]
        st = self.d.state.update(changes)
        res, sent = {"applied": True, "acked": False}, []
        if unit_changed:
            res = self.apply("POST", "temperature", {"value": st["tempUnit"]})
            sent = ["POST temperature"]
        if res is not None:
            self.reply(200, {"ok": True, **res, "sent": sent, "restartsVideo": False, "config": public_config(st)})


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Daemon:
    upload = None               # the current or last Upload
    upload_lock = threading.Lock()
    upload_dir = default_upload_dir()


def is_ryuod(pid):
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return b"ryuod" in f.read()
    except OSError:
        return False


def bind(port):
    """The HTTP server on 127.0.0.1:port. Exits if the port is taken by anything but our ryuod."""
    try:
        return Server(("127.0.0.1", port), Handler)
    except OSError as e:
        holder = P.running_driver()
        if e.errno != errno.EADDRINUSE or holder is None or not is_ryuod(holder):
            sys.exit(f"ryuod: cannot bind 127.0.0.1:{port}: {e.strerror}")
    # The previous ryuod holds the port: stop it (newest wins), then wait for the port.
    P.stop_driver()
    log("stopped the previous driver")
    end = time.monotonic() + 3
    while True:
        try:
            return Server(("127.0.0.1", port), Handler)
        except OSError as e:
            if e.errno != errno.EADDRINUSE or time.monotonic() > end:
                sys.exit(f"ryuod: cannot bind 127.0.0.1:{port}: {e.strerror}")
            time.sleep(0.1)


def main():
    global VERBOSE
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("-v", "--verbose", action="store_true", help="print every frame sent and received")
    p.add_argument("--port", type=int, default=DEFAULT_PORT)
    p.add_argument("--state", default=default_state_path(), help="state file (default %(default)s)")
    p.add_argument("--heartbeat", choices=["post", "state"], default="post",
                   help="post: POST all, acked by HomeUI (default); state: STATE all, as ryuo.py play")
    a = p.parse_args()
    VERBOSE = a.verbose

    # Bind before stopping anything: if the port belongs to an unrelated process, exit and leave
    # a running `ryuo.py play` alone. Only a previous ryuod holding the port is stopped first.
    httpd = bind(a.port)
    # Two drivers would interleave heartbeats and configs; the newest one wins.
    if P.stop_driver():
        log("stopped the previous driver")
    P.write_pidfile()
    d = Daemon()
    # Jobs left behind by a daemon that was killed mid-upload.
    shutil.rmtree(d.upload_dir, ignore_errors=True)
    d.state = State(a.state)
    httpd.daemon_ref = d
    d.sampler = Sampler(d.state)
    d.sampler.start()
    d.device = Device(d.state, d.sampler, a.heartbeat)
    d.device.start()
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True, name="http").start()
    log(f"ryuod: http://127.0.0.1:{a.port}/  state {a.state}  heartbeat {a.heartbeat}")

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    while not stop.wait(0.5):
        # A driver that started during our startup, or overwrote the pidfile, owns the screen.
        if P.superseded():
            log(f"ryuod: pid {P.running_driver()} took over the pidfile; exiting")
            break
    log("ryuod: shutting down")
    httpd.shutdown()
    # Another driver that already took the pidfile owns the screen now: no disconn.
    taken_over = P.running_driver() is not None
    d.device.stop(send_disconn=not taken_over)
    d.device.join(3)
    d.sampler.stop_ev.set()
    P.remove_pidfile()
    log("ryuod: stopped" + (" (another driver took over; no disconn)" if taken_over else ", sent disconn"))


if __name__ == "__main__":
    main()
