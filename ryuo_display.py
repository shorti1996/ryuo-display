#!/usr/bin/env python3
"""Use the RYUO IV pump panel as a second monitor for a KDE Plasma (Wayland) desktop.

Creates a 2240x1080 virtual output named Virtual-RYUO, encodes it to HEVC with NVENC and shows
it on the panel through receiver/receiver.jar. Runs until Ctrl-C or SIGTERM, then removes the
output and stops everything it started, on the PC and on the cooler.

What runs, in start order (teardown goes in reverse):
  1. adb pushes receiver.jar to the cooler and runs it with app_process. The receiver listens on
     the abstract socket "ryuo-display"; `adb forward` maps tcp:127.0.0.1:PORT to it.
  2. krfb-virtualmonitor asks KWin for the virtual output (zkde_screencast_unstable_v1). KWin
     grants that protocol to the krfb-virtualmonitor binary through its desktop file, so Plasma
     shows no dialog. krfb also serves the output over VNC on all interfaces; it runs inside its
     own empty network namespace (unshare --user --net), so that VNC port is reachable from
     nowhere.
  3. The desktop portal (org.freedesktop.portal.ScreenCast) asks KWin for a second stream of the
     same output, with the mouse pointer drawn into the frames. Plasma asks the user once which
     screen to share; the restore token it returns is kept in ~/.config/ryuo/display-portal-token
     (mode 0600), so later starts skip the dialog. Without the portal (dialog cancelled or not
     answered within --dialog-timeout s, a stale token, --no-pointer) krfb's stream is used and
     the pointer is not shown. The tool prints "pointer: shown" or "pointer: not shown: <reason>".
  4. gst-launch-1.0 opens its own consumer (pipewiresrc, not auto-connected); pw-link removes the
     links to the chosen stream and to krfb's and links this consumer. GStreamer imports the
     frames as DMA-BUFs into OpenGL and nvh265enc encodes them on the GPU, with an access unit
     delimiter before every frame, which is where the receiver cuts frames.
  5. gst-launch hands each encoded frame to this process in a GDP packet (gdppay). This process
     sends it to the forwarded TCP port followed at once by the next frame's delimiter (see
     panel_frame()), and prints the frame rate and bitrate every 5 s.
  6. A KWin script reports windows that come onto the output, and the tool then restarts KWin's
     stream with a fresh encoder (see "windows arriving on the output" below): on KWin 6.7.5 such
     windows are otherwise captured at about 1 frame/s, with either stream.
  7. When the times of the frames sent show KWin capturing in its slow cycle of 3 frames every
     100-500 ms, the tool restarts KWin's stream the same way (see "KWin's slow capture cycle").
  8. The receiver protects the OLED panel from burn-in by itself: it shifts the picture by a few
     pixels, dims it and then blacks it out while the desktop stays still. This process tells it
     only whether that is on and how bright the backlight is (see "burn-in protection" below);
     ryuod passes changes on through stdin (--control-stdin).

KWin sends a frame only when something on the virtual output changes: a still desktop sends
nothing and the panel keeps the last frame.

Needs: adb, krfb-virtualmonitor (krfb), unshare (util-linux), pw-dump and pw-link (pipewire-utils),
gst-launch-1.0 with pipewiresrc, glupload and nvh265enc (gstreamer1-plugins-bad with nvcodec), an
NVIDIA GPU, and kscreen-doctor for --scale. Python: the standard library, plus PyGObject
(python3-gobject, imported as gi) for D-Bus: the desktop portal and the window watch. Without it
the tool still runs, without the pointer, and windows that arrive after the start stay at about
1 frame/s.
"""

import argparse
import collections
import contextlib
import json
import os
import re
import secrets
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.realpath(__file__))
JAR = os.path.join(HERE, "receiver", "receiver.jar")
DEVICE_JAR = "/data/local/tmp/receiver.jar"
RECEIVER_CLASS = "RyuoDisplay"
SOCKET_NAME = "ryuo-display"
PANEL_W, PANEL_H = 2240, 1080
NAL_AUD = 35
# HEVC leaves NAL types 48-63 unspecified, for applications; the receiver reads type 48 as a control
# message and never passes it to its decoder.
NAL_CONTROL = 48
# HEVC access unit delimiter: 4-byte start code, NAL header (type 35, layer 0, temporal id 0),
# then pic_type 2 ("I, P or B slices") and the RBSP stop bit.
AUD = b"\0\0\0\1\x46\x01\x50"
GDP_HEADER = 62  # bytes
GDP_BUFFER = 1  # GDP payload type of a data buffer

DEFAULT_PORT = 27183
DEFAULT_NAME = "RYUO"
DEFAULT_BITRATE = 10  # Mb/s; the cooler's USB 2.0 link carries about 176 Mb/s
BITRATE_RANGE = (2, 40)  # Mb/s
SCALE_RANGE = (1.0, 3.0)  # KWin device-pixel ratio for the output; 2 gives a 1120x540 logical desktop
VNC_PORT = 5900  # krfb's VNC port, inside its own network namespace

LISTEN_TIMEOUT = 20  # s from starting the receiver to its "listening" line
GRAPH_TIMEOUT = 10  # s to wait for each PipeWire node to appear
STATS_EVERY = 5  # s between frame-rate and bitrate lines
SEND_TIMEOUT = 10  # s a write to the receiver may block before the stream counts as stalled
STOP_TIMEOUT = 3  # s a child gets after SIGTERM before SIGKILL
LINK_ATTEMPTS = 3  # encoders tried before giving up on taking KWin's stream
LINK_TIMEOUT = 3  # s for a new link to KWin's stream to become active
RELEASE_TIMEOUT = 5  # s the receiver gets to release the decoder after the stream closes

REQUIRED = ("adb", "krfb-virtualmonitor", "unshare", "pw-dump", "pw-link", "gst-launch-1.0")


class DisplayError(Exception):
    pass


class Stop(Exception):
    """Raised by the SIGTERM and SIGHUP handlers."""


# ---------------------------------------------------------------- arguments


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        prog="ryuo_display.py",
        description="Show a 2240x1080 virtual monitor of this KDE Plasma desktop on the RYUO IV pump panel. "
        "Stop with Ctrl-C; the virtual monitor is removed on exit.",
    )
    p.add_argument(
        "--bitrate",
        type=float,
        default=DEFAULT_BITRATE,
        metavar="MBPS",
        help=f"HEVC bitrate in Mb/s, {BITRATE_RANGE[0]}-{BITRATE_RANGE[1]} (default {DEFAULT_BITRATE})",
    )
    p.add_argument(
        "--scale",
        type=float,
        metavar="RATIO",
        help=f"set the virtual monitor's scale, {SCALE_RANGE[0]:g}-{SCALE_RANGE[1]:g} in steps of 0.25 "
        "(2 makes text twice as large). KWin remembers the last scale set for the output, here or in "
        "System Settings, and uses it when this option is left out.",
    )
    p.add_argument(
        "--name",
        default=DEFAULT_NAME,
        help=f"virtual output name after 'Virtual-': letters, digits, '-' and '_' (default {DEFAULT_NAME})",
    )
    p.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"local TCP port forwarded to the receiver, 1024-65535 (default {DEFAULT_PORT})",
    )
    p.add_argument("-s", "--serial", help="adb serial of the cooler, when more than one adb device is connected")
    p.add_argument(
        "--no-pointer",
        action="store_true",
        help="capture without the mouse pointer and without the desktop portal (no screen-selection dialog)",
    )
    p.add_argument(
        "--dialog-timeout",
        type=float,
        default=DIALOG_TIMEOUT,
        metavar="S",
        help=f"seconds to wait for an answer in the screen-selection dialog before going on without the pointer "
        f"(default {DIALOG_TIMEOUT})",
    )
    p.add_argument(
        "--protection",
        choices=("on", "off"),
        default="on",
        help="the receiver's burn-in protection: shift, dim and black out a still picture (default on)",
    )
    p.add_argument(
        "--backlight",
        type=float,
        default=1.0,
        metavar="SHARE",
        help="the panel's backlight as a share of full, 0-1, which sets how far the receiver dims (default 1)",
    )
    p.add_argument(
        "--control-stdin",
        action="store_true",
        help="read 'protection on|off' and 'backlight SHARE' lines from stdin and pass them to the receiver",
    )
    p.add_argument("-v", "--verbose", action="store_true", help="also print krfb-virtualmonitor's output")
    a = p.parse_args(argv)
    if not 0 <= a.backlight <= 1:
        p.error("--backlight must be between 0 and 1")
    if a.dialog_timeout <= 0:
        p.error("--dialog-timeout must be more than 0 s")
    if not BITRATE_RANGE[0] <= a.bitrate <= BITRATE_RANGE[1]:
        p.error(f"--bitrate must be between {BITRATE_RANGE[0]} and {BITRATE_RANGE[1]} Mb/s")
    if a.scale is not None and (not SCALE_RANGE[0] <= a.scale <= SCALE_RANGE[1] or (a.scale * 4) % 1):
        p.error(f"--scale must be between {SCALE_RANGE[0]:g} and {SCALE_RANGE[1]:g} in steps of 0.25")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", a.name):
        p.error("--name may hold 1-32 letters, digits, '-' and '_'")
    if not 1024 <= a.port <= 65535:
        p.error("--port must be between 1024 and 65535")
    return a


# ---------------------------------------------------------------- commands


def adb_cmd(serial, *args):
    return ["adb", *(["-s", serial] if serial else []), *args]


def receiver_shell():
    """Shell line run on the cooler: print the shell's pid, then exec the receiver in that same
    process, so `kill <pid>` later stops the receiver itself."""
    return f"echo pid=$$; export CLASSPATH={DEVICE_JAR}; exec app_process / {RECEIVER_CLASS}"


def stale_receiver_kill():
    """Shell line that kills receivers left by an earlier run, which would hold the socket name.
    The bracket keeps the pattern from matching the command line of the shell running it."""
    return f"pkill -f 'app_process / {RECEIVER_CLASS[:-1]}[{RECEIVER_CLASS[-1]}]'"


def receiver_pid(line):
    """The device pid from the receiver_shell() banner line, or None for any other line."""
    m = re.fullmatch(r"pid=(\d+)", line.strip())
    return int(m.group(1)) if m else None


def is_listening(line):
    return f"listening on localabstract:{SOCKET_NAME}" in line


def output_name(name):
    return f"Virtual-{name}"


def krfb_cmd(name, password):
    return [
        "unshare",
        "--user",
        "--net",
        "krfb-virtualmonitor",
        "--resolution",
        f"{PANEL_W}x{PANEL_H}",
        "--name",
        name,
        "--password",
        password,
        "--port",
        str(VNC_PORT),
    ]


def scale_cmd(name, scale):
    return ["kscreen-doctor", f"output.{output_name(name)}.scale.{scale:g}"]


def gst_cmd(node_name, fd, bitrate_mbps):
    """gst-launch-1.0 pipeline from an unconnected PipeWire consumer to HEVC on fd, one access
    unit per GDP packet (gdppay), so the reader knows where each frame ends.

    nvh265enc: P1 (fastest preset) with the ultra-low-latency tune and zerolatency, no B-frames,
    constant bitrate, one keyframe at the start and none after (gop-size -1: each connection gets
    its own encoder, so the decoder starts on that keyframe, and TCP loses no frame that a later
    keyframe would have to repair), and an access unit delimiter (NAL type 35) before every frame.

    identity drops buffers flagged corrupted. KWin sends one each time the pointer moves on the
    output: in krfb's cursor-as-metadata mode it renders nothing for a pointer move, flags the
    chunk SPA_CHUNK_FLAG_CORRUPTED, and leaves whatever an earlier frame put in that buffer (KWin
    cycles 3 buffers). pipewiresrc passes such a buffer on with GST_BUFFER_FLAG_CORRUPTED; encoded,
    it shows that earlier frame again, which made the panel flicker while the pointer moved."""
    return [
        "gst-launch-1.0",
        "-q",
        "pipewiresrc",
        "autoconnect=false",
        f"client-name={node_name}",
        "!",
        "identity",
        "drop-buffer-flags=corrupted",
        "!",
        "glupload",
        "!",
        "glcolorconvert",
        "!",
        "video/x-raw(memory:GLMemory),format=BGRx",
        "!",
        "nvh265enc",
        "preset=p1",
        "tune=ultra-low-latency",
        "zerolatency=true",
        "bframes=0",
        "rc-mode=cbr",
        f"bitrate={round(bitrate_mbps * 1000)}",
        "gop-size=-1",
        "aud=true",
        "!",
        "video/x-h265,stream-format=byte-stream,alignment=au,profile=main",
        "!",
        "gdppay",
        "!",
        "fdsink",
        f"fd={fd}",
        "sync=false",
    ]


# ---------------------------------------------------------------- PipeWire graph (pw-dump JSON)


def _of_type(dump, kind):
    return [o for o in dump if o.get("type") == f"PipeWire:Interface:{kind}"]


def _props(o):
    return (o.get("info") or {}).get("props") or {}


def kwin_output_port(dump, pid):
    """(KWin output port id, link id) of the link from KWin's screencast stream to the video
    consumer of process pid (krfb), or None until that link exists. pipewire.sec.pid is the
    kernel's view of the client's pid."""
    clients = {
        o["id"]
        for o in _of_type(dump, "Client")
        if pid in (_props(o).get("pipewire.sec.pid"), _props(o).get("application.process.id"))
    }
    nodes = {
        o["id"]
        for o in _of_type(dump, "Node")
        if _props(o).get("client.id") in clients and _props(o).get("media.class") == "Stream/Input/Video"
    }
    sources = {o["id"] for o in _of_type(dump, "Node") if _props(o).get("media.class") == "Stream/Output/Video"}
    for link in _of_type(dump, "Link"):
        info = link.get("info") or {}
        if info.get("input-node-id") in nodes and info.get("output-node-id") in sources:
            return info.get("output-port-id"), link["id"]
    return None


def link_active(dump, out_port, in_port):
    """True if a link from out_port to in_port exists and is active (format and buffers agreed)."""
    return any(
        (o.get("info") or {}).get("output-port-id") == out_port
        and (o.get("info") or {}).get("input-port-id") == in_port
        and (o.get("info") or {}).get("state") == "active"
        for o in _of_type(dump, "Link")
    )


def links_from(dump, port_id):
    """Ids of the links that leave output port port_id."""
    return [o["id"] for o in _of_type(dump, "Link") if (o.get("info") or {}).get("output-port-id") == port_id]


def input_port(dump, node_name):
    """Id of the input port of the video consumer node called node_name, or None."""
    nodes = {
        o["id"]
        for o in _of_type(dump, "Node")
        if _props(o).get("node.name") == node_name and _props(o).get("media.class") == "Stream/Input/Video"
    }
    for port in _of_type(dump, "Port"):
        info = port.get("info") or {}
        if info.get("direction") == "input" and _props(port).get("node.id") in nodes:
            return port["id"]
    return None


def running_monitors(cmdlines, name):
    """Pids from {pid: argv} of krfb-virtualmonitor processes serving the output called name."""
    out = []
    for pid, argv in cmdlines.items():
        if any(os.path.basename(x) == "krfb-virtualmonitor" for x in argv[:4]):
            with contextlib.suppress(ValueError, IndexError):
                if argv[argv.index("--name") + 1] == name:
                    out.append(pid)
    return sorted(out)


def proc_cmdlines():
    out = {}
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            with contextlib.suppress(OSError), open(f"/proc/{entry}/cmdline", "rb") as f:
                out[int(entry)] = [x.decode(errors="replace") for x in f.read().split(b"\0") if x]
    return out


# ---------------------------------------------------------------- the HEVC stream


class GdpReader:
    """Splits gdppay output (GStreamer Data Protocol 1.0) into (payload type, payload) packets.

    Each packet is a 62-byte header followed by the payload; the header holds the payload type
    as a big-endian u16 at byte 4 and the payload length as a big-endian u32 at byte 6. Type 1 is
    a buffer (here one HEVC access unit); caps and events have other types."""

    def __init__(self):
        self._buf = bytearray()

    def feed(self, chunk):
        """The packets completed by chunk, in order. Raises ValueError on a non-GDP 1.x stream."""
        self._buf += chunk
        out = []
        while len(self._buf) >= GDP_HEADER:
            if self._buf[0] != 1:
                raise ValueError(f"not a GDP 1.x packet (version byte {self._buf[0]})")
            kind, size = struct.unpack_from(">HI", self._buf, 4)
            end = GDP_HEADER + size
            if len(self._buf) < end:
                break
            out.append((kind, bytes(self._buf[GDP_HEADER:end])))
            del self._buf[:end]
        return out


def strip_leading_aud(au):
    """au without its leading access unit delimiter NAL; au unchanged when it has none."""
    if au.startswith(b"\0\0\1"):
        start = 3
    elif au.startswith(b"\0\0\0\1"):
        start = 4
    else:
        return au
    if len(au) <= start or (au[start] >> 1) & 0x3F != NAL_AUD:
        return au
    nxt = au.find(b"\0\0\1", start + 2)
    if nxt == -1:
        return b""
    # Keep the leading zero of a 4-byte start code with the NAL it introduces.
    return au[nxt - 1 :] if au[nxt - 1] == 0 else au[nxt:]


def panel_frame(au):
    """What goes on the wire for one encoded frame: the frame without its own delimiter, then
    the delimiter that opens the next frame.

    The receiver cuts the stream at each delimiter, so it queues a frame for decoding only once
    the next delimiter arrives. Sending that delimiter straight after the frame lets the panel
    show the frame at once instead of when the desktop next changes, which on a still desktop
    can be minutes later. The stream stays a valid Annex-B HEVC stream: AUD here says "any slice
    type", which is true of every frame."""
    return strip_leading_aud(au) + AUD


# ---------------------------------------------------------------- burn-in protection

# The receiver runs the protection's timers itself (RyuoDisplay.Protection), so they go on when the
# stream stalls or the PC sleeps. It needs two facts only the PC has: whether the protection is on,
# and the backlight as a share of full, which sets how far it dims. Both travel in the stream itself,
# as a control message between two frames: no second socket or adb forward, and every new connection
# starts with the current values, so a reconnect cannot leave the receiver with stale ones. Until the
# first message arrives the receiver has the protection on with the backlight at full.


def control_unit(protect, backlight):
    """A control message for the receiver: a NAL unit of type NAL_CONTROL whose payload is ASCII,
    which has no zero bytes and so cannot contain a start code. The Relay sends it with a delimiter
    after it, so the receiver cuts it off as an access unit of its own at once."""
    text = f"ryuo protect={int(bool(protect))} backlight={backlight:.3f}"
    return b"\0\0\0\1" + bytes((NAL_CONTROL << 1, 1)) + text.encode("ascii")


def parse_control(line):
    """The set_protection() arguments in one --control-stdin line ("protection on", "protection off",
    "backlight 0.392"), or None for any other line."""
    words = line.split()
    if words == ["protection", "on"]:
        return {"protect": True}
    if words == ["protection", "off"]:
        return {"protect": False}
    if len(words) == 2 and words[0] == "backlight":
        with contextlib.suppress(ValueError):
            share = float(words[1])
            if 0 <= share <= 1:
                return {"backlight": share}
    return None


def read_control(stream, apply):
    """Pass each control line of stream to apply(**changes) until the stream ends; runs on a thread."""
    for line in stream:
        changes = parse_control(line)
        if changes is not None:
            apply(**changes)
        elif line.strip():
            say(f"warning: ignored control line {line.strip()!r}")


class Stats:
    def __init__(self):
        self.frames = 0
        self.bytes = 0

    def add(self, n):
        self.frames += 1
        self.bytes += n


class Rate:
    """Frames per second and Mb/s since the previous sample()."""

    def __init__(self, stats, now=time.monotonic):
        self.stats, self.now = stats, now
        self.t, self.frames, self.bytes = now(), stats.frames, stats.bytes

    def sample(self):
        t = self.now()
        dt = max(t - self.t, 1e-9)
        fps = (self.stats.frames - self.frames) / dt
        mbps = (self.stats.bytes - self.bytes) * 8 / dt / 1e6
        self.t, self.frames, self.bytes = t, self.stats.frames, self.stats.bytes
        return fps, mbps


class Relay:
    """Sends encoded frames from the current encoder's pipe to the receiver, on its own thread.

    use(fd) makes fd the current pipe at once and closes the previous one unread. Frames the old
    encoder still had in flight are dropped instead of delaying the new encoder's first frame, and
    the old encoder, which can take a second to shut down, gets EPIPE on its next write. The new
    encoder starts with its own parameter sets and keyframe, which the panel's decoder takes
    mid-stream. first_frame is set when the first frame read from the current pipe has been sent.

    slow_cycle is the cycle length in ms while the current pipe's frames show KWin's slow capture
    cycle (see SlowCycle), else None. The SlowCycle is fed and reset on this thread only.

    control(unit) sends a control_unit() between two frames, followed by a delimiter; a unit given to
    the constructor goes out first, before any frame."""

    def __init__(self, sock, stats, on_error, control=None):
        self.sock, self.stats, self.on_error = sock, stats, on_error
        self.lock = threading.Lock()
        self.fd = None
        self.closed = False
        self.pending = control
        self.first_frame = threading.Event()
        self.slow = SlowCycle()
        self.slow_cycle = None
        self.wake_r, self.wake_w = os.pipe()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def use(self, fd):
        with self.lock:
            self.fd = fd
            self.first_frame.clear()
            self.slow_cycle = None
        os.write(self.wake_w, b"x")

    def control(self, unit):
        with self.lock:
            self.pending = unit
        os.write(self.wake_w, b"x")

    def close(self):
        with self.lock:
            self.closed = True
        os.write(self.wake_w, b"x")
        self.thread.join(5)
        for fd in (self.wake_r, self.wake_w):
            os.close(fd)

    def _run(self):
        current, reader = None, GdpReader()
        try:
            self.sock.sendall(AUD)
            while True:
                with self.lock:
                    fd, closed, unit = self.fd, self.closed, self.pending
                    self.pending = None
                if closed:
                    return
                if unit is not None:
                    self.sock.sendall(unit + AUD)
                if fd != current:
                    if current is not None:
                        os.close(current)
                    current, reader = fd, GdpReader()
                    # A new encoder's frames say nothing yet about the cycle of the old one's.
                    self.slow.reset()
                    self.slow_cycle = None
                ready = select.select([self.wake_r] + ([current] if current is not None else []), [], [])[0]
                if self.wake_r in ready:
                    os.read(self.wake_r, 64)
                    continue
                chunk = os.read(current, 1 << 20)
                if not chunk:
                    # The encoder exited; Session.watch() reports that.
                    with self.lock:
                        if self.fd == current:
                            self.fd = None
                    os.close(current)
                    current = None
                    continue
                for kind, payload in reader.feed(chunk):
                    if kind == GDP_BUFFER:
                        data = panel_frame(payload)
                        self.sock.sendall(data)
                        self.stats.add(len(data))
                        self.slow_cycle = self.slow.frame(time.monotonic())
                        self.first_frame.set()
        except (OSError, ValueError) as e:
            self.on_error(f"stream to the panel failed: {e}")
        finally:
            if current is not None:
                with contextlib.suppress(OSError):
                    os.close(current)


# ---------------------------------------------------------------- windows arriving on the output

# Works around KWin 6.7.5 behaviour measured on the development PC (2026-10-23). Once the
# screencast stream for the virtual output is running, a window that comes onto the output (opened
# there, or moved there from another monitor) is captured at 0.5-2.3 frames/s, in bursts of 3
# frames (KWin's buffer count) about 0.4-1.3 s apart, while KWin presents the same window at 60 Hz.
# A plain pipewiresrc ! fakesink consumer sees the same rate, so the encoder is not the cause.
# Windows that were on the output when the stream last went from paused to streaming are captured
# at 56-60 frames/s. So the tool restarts the stream after a window arrives: a KWin script reports
# arrivals over D-Bus, and restart_capture() swaps in a new encoder. A stream can also start slow
# with no window arriving at all; "KWin's slow capture cycle" below covers that case.

DBUS_IFACE = "org.rogryuolcd.Display"
DBUS_PATH = "/org/rogryuolcd/Display"
DBUS_XML = f"""<node><interface name="{DBUS_IFACE}">
<method name="WindowEvent"><arg type="s" name="kind" direction="in"/><arg type="s" name="window" direction="in"/></method>
</interface></node>"""
RESTART_QUIET = 0.3  # s without window events after an arrival before the stream is restarted
MOVE_REPORT_WINDOW = 3000  # ms after an arrival during which the script also reports moves


def kwin_script(output, service):
    """KWin script that calls WindowEvent(kind, window id) on service: "enter" when a window starts
    to overlap output, "leave" when it stops overlapping or closes, and "move" while windows on
    output keep moving shortly after an arrival (so the restart waits until a drag has settled)."""
    return f"""// Loaded by ryuo_display.py; unloaded when it exits.
const OUTPUT = {json.dumps(output)};
let lastEnter = 0;
function send(kind, w) {{
    callDBus({json.dumps(service)}, {json.dumps(DBUS_PATH)}, {json.dumps(DBUS_IFACE)}, "WindowEvent", kind,
             String(w.internalId));
}}
function onOutput(w) {{
    const s = workspace.screens.find(o => o.name === OUTPUT);
    if (!s || !w.frameGeometry) return false;
    const a = s.geometry, g = w.frameGeometry;
    return g.x < a.x + a.width && a.x < g.x + g.width && g.y < a.y + a.height && a.y < g.y + g.height;
}}
const on = new Map();  // window id -> overlaps OUTPUT
function track(w, isNew) {{
    const id = String(w.internalId);
    on.set(id, onOutput(w));
    if (isNew && on.get(id)) {{ lastEnter = Date.now(); send("enter", w); }}
    w.frameGeometryChanged.connect(function () {{
        const was = on.get(id), now = onOutput(w);
        if (now && !was) {{ lastEnter = Date.now(); send("enter", w); }}
        else if (!now && was) send("leave", w);
        else if (now && Date.now() - lastEnter < {MOVE_REPORT_WINDOW}) send("move", w);
        on.set(id, now);
    }});
}}
workspace.windowList().forEach(w => track(w, false));
workspace.windowAdded.connect(w => track(w, true));
workspace.windowRemoved.connect(function (w) {{
    const id = String(w.internalId);
    if (on.get(id)) send("leave", w);
    on.delete(id);
}});
"""


_glib_loop = None
_glib_lock = threading.Lock()


def glib():
    """PyGObject's GLib and Gio, with a GLib main loop running on a thread of its own so D-Bus
    signals and method calls reach this process. Raises ImportError or ValueError without
    PyGObject."""
    global _glib_loop
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib

    with _glib_lock:
        if _glib_loop is None:
            _glib_loop = GLib.MainLoop()
            threading.Thread(target=_glib_loop.run, daemon=True, name="glib").start()
    return GLib, Gio


class WindowWatch:
    """Loads kwin_script() into KWin and calls on_event(kind) for each report. Uses PyGObject
    (gi.repository.Gio) for D-Bus: the script reaches this process by calling a method on a bus
    name it owns, and the standard library has no D-Bus."""

    def __init__(self, output, on_event):
        GLib, Gio = glib()
        self.GLib, self.on_event = GLib, on_event
        self.service = f"{DBUS_IFACE}.pid{os.getpid()}"
        self.plugin = f"ryuo-display-{os.getpid()}"
        self.conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        node = Gio.DBusNodeInfo.new_for_xml(DBUS_XML)
        self.object_id = self.conn.register_object_with_closures2(DBUS_PATH, node.interfaces[0], self._call, None, None)
        self._dbus(
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            "RequestName",
            GLib.Variant("(su)", (self.service, 4)),
        )
        self.dir = tempfile.mkdtemp(prefix="ryuo-display-", dir=os.environ.get("XDG_RUNTIME_DIR"))
        path = os.path.join(self.dir, "windows.js")
        with open(path, "w") as f:
            f.write(kwin_script(output, self.service))
        (script_id,) = self._dbus(
            "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting", "loadScript", GLib.Variant("(ss)", (path, self.plugin))
        ).unpack()
        if script_id < 0:
            self.close()
            raise DisplayError("KWin refused the window-watch script")
        self._dbus("org.kde.KWin", f"/Scripting/Script{script_id}", "org.kde.kwin.Script", "run", None)

    def _dbus(self, name, path, iface, method, args):
        try:
            return self.conn.call_sync(name, path, iface, method, args, None, 0, 5000, None)
        except self.GLib.Error as e:
            raise DisplayError(f"D-Bus {iface}.{method}: {e.message}") from e

    def _call(self, conn, sender, path, iface, method, params, invocation):
        self.on_event(*params.unpack())
        invocation.return_value(None)

    def close(self):
        with contextlib.suppress(DisplayError):
            self._dbus(
                "org.kde.KWin",
                "/Scripting",
                "org.kde.kwin.Scripting",
                "unloadScript",
                self.GLib.Variant("(s)", (self.plugin,)),
            )
        self.conn.unregister_object(self.object_id)
        with contextlib.suppress(DisplayError):
            self._dbus(
                "org.freedesktop.DBus",
                "/org/freedesktop/DBus",
                "org.freedesktop.DBus",
                "ReleaseName",
                self.GLib.Variant("(s)", (self.service,)),
            )
        shutil.rmtree(self.dir, ignore_errors=True)


# ---------------------------------------------------------------- pointer: capture through the desktop portal

# krfb asks KWin for the pointer as metadata, so its stream has no pointer in the frames. The
# desktop portal's ScreenCast can ask KWin for a stream of the same output with the pointer drawn
# in. Plasma shows its screen-selection dialog for that unless the request carries a restore token
# from an earlier selection that the user allowed to be restored; the token is kept in TOKEN_FILE.
PORTAL_BUS = "org.freedesktop.portal.Desktop"
PORTAL_PATH = "/org/freedesktop/portal/desktop"
PORTAL_APP_ID = "org.rogryuolcd.Display"  # registered with the portal, so tokens survive any launcher
SOURCE_MONITOR = 1  # ScreenCast source type
CURSOR_EMBEDDED = 2  # ScreenCast cursor mode: drawn into the frames
PERSIST_UNTIL_REVOKED = 2  # ScreenCast persist mode
DIALOG_TIMEOUT = 120  # s the screen-selection dialog may stay unanswered before the run goes on without a pointer
DIALOG_AFTER = 2  # s without an answer after which the dialog is assumed to be on screen
RESPONSE_REASONS = {1: "screen selection was cancelled", 2: "the desktop portal could not start the screen capture"}


def token_path(environ=None):
    environ = os.environ if environ is None else environ
    base = environ.get("XDG_CONFIG_HOME") or os.path.join(environ.get("HOME", os.path.expanduser("~")), ".config")
    return os.path.join(base, "ryuo", "display-portal-token")


def read_token(path):
    try:
        with open(path) as f:
            return f.read().strip() or None
    except OSError:
        return None


def write_token(path, token):
    """Store token readable by this user only (0600); None removes the file."""
    if token is None:
        with contextlib.suppress(FileNotFoundError):
            os.remove(path)
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(token + "\n")
    os.replace(tmp, path)


def select_sources_options(token):
    """SelectSources options as {key: (GVariant type, value)}: one monitor, pointer drawn in, and a
    selection the user may allow to be restored without the dialog next time."""
    opts = {
        "types": ("u", SOURCE_MONITOR),
        "multiple": ("b", False),
        "cursor_mode": ("u", CURSOR_EMBEDDED),
        "persist_mode": ("u", PERSIST_UNTIL_REVOKED),
    }
    if token:
        opts["restore_token"] = ("s", token)
    return opts


def stream_node(results):
    """The PipeWire node id of the one stream in a Start response's results."""
    streams = results.get("streams") or []
    if len(streams) != 1:
        raise PortalError(f"the desktop portal returned {len(streams)} streams instead of one")
    return int(streams[0][0])


def node_output_port(dump, node_id):
    """(media.name, output port id) of PipeWire node node_id, or None while it has no output port."""
    nodes = {o["id"]: _props(o) for o in _of_type(dump, "Node")}
    if node_id not in nodes:
        return None
    for port in _of_type(dump, "Port"):
        if (port.get("info") or {}).get("direction") == "output" and _props(port).get("node.id") == node_id:
            return nodes[node_id].get("media.name"), port["id"]
    return None


class PortalError(Exception):
    """The portal capture is not available; the text is the reason the panel shows no pointer."""


class PortalCapture:
    """A ScreenCast session of the desktop portal for one monitor with the pointer drawn in.

    start() returns the PipeWire node id of KWin's stream. It shows Plasma's screen-selection
    dialog when the stored restore token is missing or no longer valid, waits up to timeout s for
    an answer, and stores the new token the portal returns (tokens are single-use). close() ends
    the session, which ends KWin's stream."""

    def __init__(self, path, timeout=DIALOG_TIMEOUT, on_dialog=None):
        try:
            self.GLib, Gio = glib()
        except (ImportError, ValueError) as e:
            raise PortalError(f"PyGObject (python3-gobject) is missing: {e}") from e
        self.path, self.timeout, self.on_dialog = path, timeout, on_dialog
        self.session = None
        self.requests = 0
        try:
            # A private connection: Registry.Register must come before any other portal call on it.
            address = Gio.dbus_address_get_for_bus_sync(Gio.BusType.SESSION, None)
            flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
            self.conn = Gio.DBusConnection.new_for_address_sync(address, flags, None, None)
        except self.GLib.Error as e:
            raise PortalError(f"no D-Bus session bus: {e.message}") from e
        with contextlib.suppress(PortalError):
            # Older portals lack the registry; the token is then kept under the launcher's app id.
            self._call("org.freedesktop.host.portal.Registry", "Register", "(sa{sv})", (PORTAL_APP_ID, {}))

    def _call(self, iface, method, sig, args, path=PORTAL_PATH):
        try:
            return self.conn.call_sync(PORTAL_BUS, path, iface, method, self.GLib.Variant(sig, args), None, 0, 10000, None)
        except self.GLib.Error as e:
            raise PortalError(f"desktop portal {method} failed: {e.message}") from e

    def _request(self, method, sig, args, options, timeout):
        """Call a portal method that answers through a Request object; return its results."""
        GLib = self.GLib
        self.requests += 1
        token = f"ryuo{os.getpid()}_{self.requests}"
        sender = self.conn.get_unique_name()[1:].replace(".", "_")
        handle = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
        answer, done = [], threading.Event()

        def response(conn, sender_name, path, iface, signal_name, params, *user):
            answer.append(params.unpack())
            done.set()

        sub = self.conn.signal_subscribe(PORTAL_BUS, "org.freedesktop.portal.Request", "Response", handle, None, 0, response)
        try:
            opts = {"handle_token": GLib.Variant("s", token)}
            opts.update({k: GLib.Variant(t, v) for k, (t, v) in options.items()})
            self._call("org.freedesktop.portal.ScreenCast", method, sig, (*args, opts))
            if not done.wait(min(DIALOG_AFTER, timeout)) and self.on_dialog is not None:
                self.on_dialog()
            if not done.wait(max(0, timeout - DIALOG_AFTER)):
                with contextlib.suppress(PortalError):
                    self._call("org.freedesktop.portal.Request", "Close", "()", (), path=handle)
                raise PortalError(f"no answer to the screen selection within {timeout:g} s")
        finally:
            self.conn.signal_unsubscribe(sub)
        code, results = answer[0]
        if code != 0:
            raise PortalError(RESPONSE_REASONS.get(code, f"the desktop portal answered {code}"))
        return results

    def start(self):
        results = self._request("CreateSession", "(a{sv})", (), {"session_handle_token": ("s", f"ryuo{os.getpid()}")}, 10)
        self.session = results["session_handle"]
        token = read_token(self.path)
        self._request("SelectSources", "(oa{sv})", (self.session,), select_sources_options(token), 10)
        try:
            results = self._request("Start", "(osa{sv})", (self.session, ""), {}, self.timeout)
        except PortalError:
            # The portal shows the dialog only when the token did not restore; either way it is spent.
            write_token(self.path, None)
            raise
        write_token(self.path, results.get("restore_token"))
        return stream_node(results)

    def close(self):
        if self.session is not None:
            with contextlib.suppress(PortalError):
                self._call("org.freedesktop.portal.Session", "Close", "()", (), path=self.session)
            self.session = None
        with contextlib.suppress(Exception):
            self.conn.close_sync(None)


class RestartTimer:
    """Decides when to restart the stream: RESTART_QUIET s after the last window event, when a
    window that arrived since the previous restart is still on the output. A tooltip or menu that
    closes again within that time causes no restart. Thread-safe; now() is injectable for tests."""

    def __init__(self, now=time.monotonic):
        self.now = now
        self.lock = threading.Lock()
        self.arrived = set()
        self.last = 0.0

    def event(self, kind, window=""):
        with self.lock:
            self.last = self.now()
            if kind == "enter":
                self.arrived.add(window)
            elif kind == "leave":
                self.arrived.discard(window)

    def due(self):
        """True when the restart should happen now; the arrivals it covers are then forgotten."""
        with self.lock:
            if self.arrived and self.now() - self.last >= RESTART_QUIET:
                self.arrived.clear()
                return True
            return False


# ---------------------------------------------------------------- KWin's slow capture cycle

# Works around more KWin 6.7.5 behaviour, measured on the development PC (2026-10-24) from the time
# each frame was sent to the panel. Right after the stream starts, with the user's windows already
# on the output and none arriving, KWin can capture in a fixed cycle of 3 frames every 500 ms, about
# 6 frames/s: the gaps between frames ran 407, 1, 92, 407, 1, 92 ms (399, 17, 84 ms in another run)
# and stayed so while the pointer moved across the output. One restart took a stream to a faster
# form of the same cycle, 3 frames every 100 ms (gaps of 16, 17, 67 ms, about 30 frames/s); a second
# restart brought it to 60 frames/s. No window arrives, so RestartTimer never asks for these
# restarts: SlowCycle recognises the cycle from the frame times and watch() calls restart_capture().
# The restarts clear the cycle only some of the time: in other starts that day, 3 restarts in a row
# each fell back into the 500 ms cycle. The likely cause is that KWin stamps frames with the
# output's last repaint time, and a live pipewiresrc holds every frame for as long as the first
# one was stale; KWin 6.8.0 timestamps frames at capture time. Making pipewiresrc not live
# (stream.is-live=false) left frames unpaced at up to 102 frames/s, more than the panel decodes,
# even with max-framerate=60/1 negotiated. docs/006-second-display-slow-capture/ has the details.
#
# SlowCycle matches gaps that repeat with a period of 3 frames (each gap within SLOW_TOLERANCE of the
# gap 3 frames earlier) over SLOW_CYCLES cycles, where a cycle lasts SLOW_MIN_CYCLE or longer and its
# longest gap exceeds its shortest by SLOW_MIN_SPREAD or more. An app's steady cadence on the 60 Hz
# output can also repeat every 3 frames (45 frames/s as 17, 17, 33 ms; 36 frames/s as 17, 33, 33
# ms), but its gaps differ by one refresh interval (17 ms) at most, and at 45 frames/s the cycle
# lasts 67 ms. A uniform cadence (60 frames/s, a 30 frames/s video, a cursor blinking every 500 ms)
# has no spread, and an idle desktop sends no frames to match. In two recordings (12,900 frames),
# the 60 frames/s phases repeated with a period of 3 frames only in cycles of 57 ms or shorter; the
# slow cycles matched at 99 ms or longer, with a spread of 50 ms or more and gaps that repeated to
# within 7 ms. The 500 ms cycle was recognised 2.5-3.4 s after the first frame, the 100 ms cycle 0.5 s
# after the restart.
#
# A restart leaves the panel without new frames for about 80 ms. A slow-cycle restart waits
# SLOW_COOLDOWN s after any restart, so the new stream shows its own cadence first, and at most
# SLOW_RESTART_LIMIT of them happen within SLOW_RESTART_PERIOD s, so a stream that stays slow
# whatever the tool does gets a few restarts a minute instead of one every few seconds.

SLOW_FRAMES = 3  # frames per cycle of KWin's slow capture (KWin cycles 3 buffers)
SLOW_CYCLES = 3  # consecutive cycles with matching gaps before the capture counts as slow
SLOW_TOLERANCE = 10  # ms a gap may differ from the gap one cycle earlier
SLOW_MIN_CYCLE = 80  # ms; shorter cycles are an app's own cadence
SLOW_MIN_SPREAD = 33  # ms from the shortest to the longest gap of a cycle: two 60 Hz refresh intervals
SLOW_COOLDOWN = 3  # s after any restart before the slow cycle may cause another
SLOW_RESTART_LIMIT = 3  # slow-cycle restarts allowed within SLOW_RESTART_PERIOD
SLOW_RESTART_PERIOD = 60  # s


class SlowCycle:
    """Recognises KWin's slow capture cycle from the times frames are sent. frame(t) takes a frame's
    time in monotonic s and returns the cycle length in ms while the last cycles * period gaps show
    the cycle, else None. reset() forgets every frame. Not thread-safe: one thread feeds it."""

    def __init__(
        self,
        period=SLOW_FRAMES,
        cycles=SLOW_CYCLES,
        tolerance=SLOW_TOLERANCE,
        min_cycle=SLOW_MIN_CYCLE,
        min_spread=SLOW_MIN_SPREAD,
    ):
        self.period, self.tolerance, self.min_cycle, self.min_spread = period, tolerance, min_cycle, min_spread
        self.gaps = collections.deque(maxlen=period * cycles)  # ms
        self.last = None

    def reset(self):
        self.gaps.clear()
        self.last = None

    def frame(self, t):
        if self.last is not None:
            self.gaps.append((t - self.last) * 1000)
        self.last = t
        g, p = self.gaps, self.period
        if len(g) < g.maxlen:
            return None
        cycle = [g[i] for i in range(len(g) - p, len(g))]
        length = sum(cycle)
        if length < self.min_cycle or max(cycle) - min(cycle) < self.min_spread:
            return None
        if any(abs(g[i] - g[i + p]) > self.tolerance for i in range(len(g) - p)):
            return None
        return length


class SlowRestarts:
    """Decides whether the slow cycle may restart the stream now: not within cooldown s of any
    restart (restarted() notes one, and the stream's start counts as one), and at most limit times
    within period s. When the limit first holds a restart back, on_capped() is called; it is called
    again only after a later restart has been allowed. now() is injectable for tests."""

    def __init__(
        self,
        on_capped,
        now=time.monotonic,
        cooldown=SLOW_COOLDOWN,
        limit=SLOW_RESTART_LIMIT,
        period=SLOW_RESTART_PERIOD,
    ):
        self.on_capped, self.now = on_capped, now
        self.cooldown, self.limit, self.period = cooldown, limit, period
        self.last = now()
        self.allowed = collections.deque()  # times of the slow-cycle restarts allowed
        self.capped = False

    def restarted(self):
        self.last = self.now()

    def allow(self):
        """True when a slow-cycle restart may happen now; it then counts towards the limit."""
        t = self.now()
        if t - self.last < self.cooldown:
            return False
        while self.allowed and t - self.allowed[0] >= self.period:
            self.allowed.popleft()
        if len(self.allowed) >= self.limit:
            if not self.capped:
                self.capped = True
                self.on_capped()
            return False
        self.allowed.append(t)
        self.capped = False
        return True


# ---------------------------------------------------------------- processes

_print_lock = threading.Lock()


def say(text):
    """Print a line. A closed stdout (the reader went away) must not stop the run or its teardown."""
    with _print_lock, contextlib.suppress(OSError, ValueError):
        print(text, flush=True)


class Child:
    """A child process in its own session (so Ctrl-C reaches only this script, which then stops
    the children in order) whose output lines go to on_line and to a short history."""

    def __init__(self, name, args, on_line=None, pass_fds=()):
        self.name = name
        self.shown = on_line is not None
        self.tail = collections.deque(maxlen=20)
        try:
            self.proc = subprocess.Popen(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                errors="replace",
                start_new_session=True,
                pass_fds=pass_fds,
            )
        except OSError as e:
            raise DisplayError(f"{name}: {e.strerror}") from e
        self.reader = threading.Thread(target=self._read, args=(on_line,), daemon=True)
        self.reader.start()

    def _read(self, on_line):
        for line in self.proc.stdout:
            line = line.rstrip("\n")
            self.tail.append(line)
            if on_line is not None:
                on_line(line)

    def alive(self):
        return self.proc.poll() is None

    def last_lines(self):
        return "\n".join(f"  {x}" for x in self.tail) or "  (no output)"

    def exited(self, before=""):
        """Error text for an unexpected exit, with the child's last lines unless already printed."""
        text = f"{self.name} exited (status {self.proc.returncode}){before}"
        return text if self.shown else f"{text}:\n{self.last_lines()}"

    def stop(self, sig=signal.SIGTERM):
        if self.alive():
            with contextlib.suppress(ProcessLookupError):
                self.proc.send_signal(sig)
            try:
                self.proc.wait(STOP_TIMEOUT)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.reader.join(1)


def run_tool(args, what, timeout=30):
    """Run a short command; raise DisplayError with its output if it fails."""
    try:
        r = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace", timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise DisplayError(f"{what}: {e}") from e
    if r.returncode != 0:
        out = (r.stderr.strip() or r.stdout.strip() or "no output").splitlines()[-1]
        raise DisplayError(f"{what} failed (exit {r.returncode}): {out}")
    return r.stdout


def pw_dump():
    try:
        return json.loads(run_tool(["pw-dump"], "pw-dump"))
    except ValueError as e:
        raise DisplayError("pw-dump printed invalid JSON") from e


def wait_for(what, find, child, timeout):
    """Poll find() until it returns something other than None; fail if child exits first."""
    deadline = time.monotonic() + timeout
    while True:
        found = find()
        if found is not None:
            return found
        if not child.alive():
            raise DisplayError(child.exited(f" before {what}"))
        if time.monotonic() > deadline:
            raise DisplayError(f"no {what} after {timeout} s; {child.name} printed:\n{child.last_lines()}")
        time.sleep(0.2)


# ---------------------------------------------------------------- session


class Session:
    def __init__(self, a, stack):
        self.a, self.stack = a, stack
        self.failed = threading.Event()
        self.reason = None
        self.stats = Stats()
        self.portal_used = False
        self.relay = None
        # What the receiver is told about burn-in protection; control_lock keeps a change from
        # slipping in between reading these and creating the relay that sends them first.
        self.control_lock = threading.Lock()
        self.protect = a.protection == "on"
        self.backlight = a.backlight

    def set_protection(self, protect=None, backlight=None):
        """Change what the receiver is told: sent at once while streaming, else first thing when
        the stream starts."""
        with self.control_lock:
            if protect is not None:
                self.protect = protect
            if backlight is not None:
                self.backlight = backlight
            if self.relay is not None:
                self.relay.control(control_unit(self.protect, self.backlight))

    def fail(self, reason):
        if not self.failed.is_set():
            self.reason = reason
            self.failed.set()

    def adb(self, *args, timeout=30):
        return run_tool(adb_cmd(self.a.serial, *args), "adb " + " ".join(args[:2]), timeout)

    # ---- cooler

    def start_receiver(self):
        if not os.path.exists(JAR):
            raise DisplayError(f"{JAR} is missing: run `make receiver`")
        state = subprocess.run(adb_cmd(self.a.serial, "get-state"), capture_output=True, text=True).stdout.strip()
        if state != "device":
            raise DisplayError("no cooler on adb (`adb devices` lists none, or more than one: pass --serial)")
        self.adb("push", JAR, DEVICE_JAR)
        subprocess.run(adb_cmd(self.a.serial, "shell", stale_receiver_kill()), capture_output=True, timeout=15)

        pid = []
        listening = threading.Event()
        self.decoding = False
        self.decoder_released = threading.Event()

        def line(text):
            n = receiver_pid(text)
            if n is not None and not pid:
                pid.append(n)
                return
            say(text)
            if is_listening(text):
                listening.set()
            elif text.endswith(": client connected"):
                self.decoding = True
                self.decoder_released.clear()
            elif text.endswith(": client gone, layer hidden"):
                self.decoder_released.set()

        receiver = Child("receiver", adb_cmd(self.a.serial, "shell", receiver_shell()), line)
        self.stack.callback(self.stop_receiver, receiver, pid)
        wait_for("'listening' from the receiver", lambda: True if listening.is_set() else None, receiver, LISTEN_TIMEOUT)
        self.receiver = receiver

        self.adb("forward", f"tcp:{self.a.port}", f"localabstract:{SOCKET_NAME}")
        self.stack.callback(self.remove_forward)

    def stop_receiver(self, receiver, pid):
        # Killing the receiver while it holds the hardware decoder leaks the decoder in the
        # cooler's codec service (android.hardware.media.c2@1.1-service): its release never
        # finishes, and after a few such kills no process can get a decoder, HomeUI's own video
        # player included ("Can't play this video.") until that service restarts. The stream
        # socket is closed by now, so the receiver releases the decoder itself; wait for that.
        if self.decoding and receiver.alive() and not self.decoder_released.wait(RELEASE_TIMEOUT):
            say(
                f"warning: the receiver did not release the decoder within {RELEASE_TIMEOUT} s; if the panel "
                "later fails to play video, run: adb shell setprop ctl.restart android-hardware-media-c2-hal-1-1"
            )
        if pid:
            with contextlib.suppress(DisplayError):
                self.adb("shell", f"kill {pid[0]}", timeout=10)
        receiver.stop()

    def remove_forward(self):
        with contextlib.suppress(DisplayError):
            self.adb("forward", "--remove", f"tcp:{self.a.port}", timeout=10)

    # ---- desktop

    def check_free(self):
        """Refuse to start while another run serves the same output. Runs before anything touches
        the cooler, so a second run cannot kill the first run's receiver."""
        busy = running_monitors(proc_cmdlines(), self.a.name)
        if busy:
            raise DisplayError(
                f"krfb-virtualmonitor already serves {output_name(self.a.name)} (pid "
                f"{', '.join(map(str, busy))}); stop it or pass another --name"
            )

    def start_monitor(self):
        on_line = (lambda t: say(f"krfb-virtualmonitor: {t}")) if self.a.verbose else None
        # The VNC password guards nothing reachable (the port is in an empty network namespace),
        # but krfb requires one.
        krfb = Child("krfb-virtualmonitor", krfb_cmd(self.a.name, secrets.token_hex(4)), on_line)
        self.stack.callback(self.stop_monitor, krfb)
        source = wait_for(
            f"PipeWire stream for {output_name(self.a.name)}",
            lambda: kwin_output_port(pw_dump(), krfb.proc.pid),
            krfb,
            GRAPH_TIMEOUT,
        )
        self.krfb = krfb
        say(f"virtual monitor {output_name(self.a.name)} is up, {PANEL_W}x{PANEL_H} at 60 Hz")
        if self.a.scale is not None:
            run_tool(scale_cmd(self.a.name, self.a.scale), "kscreen-doctor")
        return source

    def pointer_source(self, krfb_source):
        """The stream to encode: the desktop portal's, which has the pointer drawn in, or krfb's
        when the portal capture is unavailable (the reason is printed as a "pointer:" line)."""
        out = output_name(self.a.name)
        self.portal_used = False
        if self.a.no_pointer:
            say("pointer: not shown: turned off with --no-pointer")
            return krfb_source

        def dialog():
            say(
                f"waiting for the screen-sharing dialog: choose {out}, allow restoring, then Share "
                f"(goes on without the pointer after {self.a.dialog_timeout:g} s)"
            )

        path = token_path()
        try:
            portal = PortalCapture(path, self.a.dialog_timeout, dialog)
            self.stack.callback(portal.close)
            node = portal.start()
            found = wait_for(
                "PipeWire stream from the desktop portal",
                lambda: node_output_port(pw_dump(), node),
                self.krfb,
                GRAPH_TIMEOUT,
            )
            media, port = found
            if media != f"kwin-screencast-{out}":
                write_token(path, None)
                portal.close()
                raise PortalError(f"the screen selected in the dialog was not {out} (got {media})")
        except PortalError as e:
            say(f"pointer: not shown: {e}")
            return krfb_source
        # krfb's stream is not used; without a link KWin stops rendering it.
        subprocess.run(["pw-link", "-d", str(krfb_source[1])], stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
        self.portal_used = True
        say("pointer: shown")
        return port, None

    def stop_monitor(self, krfb):
        krfb.stop()
        say(f"virtual monitor {output_name(self.a.name)} removed")

    def start_stream(self, source):
        try:
            sock = socket.create_connection(("127.0.0.1", self.a.port), timeout=5)
        except OSError as e:
            raise DisplayError(f"cannot connect to the adb forward on port {self.a.port}: {e}") from e
        self.stack.callback(sock.close)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.settimeout(SEND_TIMEOUT)

        self.source_port = source[0]
        with self.control_lock:
            self.relay = Relay(sock, self.stats, self.fail, control_unit(self.protect, self.backlight))
        self.generation = 0
        self.link_retries = 0
        self.gst = self.spare = None
        self.stack.callback(self.stop_encoders)
        self.relay.start()
        # A restart, or a retry when linking fails, would otherwise wait for a new encoder to start
        # (about 1.5 s for GStreamer's OpenGL and CUDA setup), so one is kept ready, idle and unlinked.
        first = self.start_encoder()
        self.spare = self.start_encoder()
        self.switch_to(first)
        if self.spare is None:
            self.spare = self.start_encoder()
        say(f"streaming to the panel at {self.a.bitrate:g} Mb/s; stop with Ctrl-C")

        self.slow_restarts = SlowRestarts(
            lambda: say(
                f"warning: the capture is still in KWin's slow cycle after {SLOW_RESTART_LIMIT} restarts within "
                f"{SLOW_RESTART_PERIOD} s; further restarts for it are held to {SLOW_RESTART_LIMIT} per "
                f"{SLOW_RESTART_PERIOD} s"
            )
        )
        self.restarts = RestartTimer()
        try:
            watch = WindowWatch(output_name(self.a.name), self.restarts.event)
        except (ImportError, ValueError, DisplayError) as e:
            say(
                f"warning: cannot watch windows ({e}); a window that comes onto {output_name(self.a.name)} "
                "after this point is shown at about 1 frame/s"
            )
        else:
            self.stack.callback(watch.close)

    def start_encoder(self):
        """Start a gst-launch-1.0 encoder whose PipeWire input is not linked yet. Its pipe's read
        end is kept on it (read_fd) until switch_to() hands it to the relay."""
        self.generation += 1
        node_name = f"ryuo-display-{os.getpid()}-{self.generation}"
        read_fd, write_fd = os.pipe()
        retired = threading.Event()
        quiet = threading.Event()  # set until the encoder has taken the stream; a failed try is not news
        quiet.set()

        def line(text):
            if not retired.is_set() and not quiet.is_set():
                say(f"gst-launch-1.0: {text}")

        try:
            gst = Child(
                "gst-launch-1.0",
                gst_cmd(node_name, write_fd, self.a.bitrate),
                line,
                pass_fds=(write_fd,),
            )
        except DisplayError:
            os.close(read_fd)
            raise
        finally:
            os.close(write_fd)
        gst.node_name, gst.retired, gst.quiet, gst.read_fd = node_name, retired, quiet, read_fd
        return gst

    def switch_to(self, gst):
        """Give KWin's stream to gst in place of the current consumer (krfb at first, the previous
        encoder on a restart).

        KWin renders a frame for the stream when the desktop changes and once when the stream goes
        from paused to streaming. Removing every link from KWin's port first pauses the stream, so
        linking gst restarts it: the panel gets the current desktop at once, and every window now on
        the output is captured at the full rate. krfb keeps running without frames, which also saves
        the CPU time of its VNC copy. The old encoder fails when its link goes; its output is muted
        and it is stopped.

        Linking can fail: on a stream KWin has just created (the portal's), KWin first offers one
        DMA-BUF modifier and moves to another once its test allocation fails, and pipewiresrc
        sometimes rejects the first one ("unhandled format") and exits. A fresh encoder then gets
        the settled format, so up to LINK_ATTEMPTS encoders are tried."""
        old, self.gst = self.gst, gst
        if old is not None:
            old.retired.set()
        for attempt in range(1, LINK_ATTEMPTS + 1):
            sink = wait_for(
                "PipeWire input from gst-launch-1.0",
                lambda name=gst.node_name: input_port(pw_dump(), name),
                gst,
                GRAPH_TIMEOUT,
            )
            for link in links_from(pw_dump(), self.source_port):
                # A link can vanish in between, when the consumer at its end exits on its own.
                subprocess.run(["pw-link", "-d", str(link)], stdin=subprocess.DEVNULL, capture_output=True, timeout=10)
            self.relay.use(gst.read_fd)
            gst.read_fd = None
            if self.link(gst, sink):
                gst.quiet.clear()
                break
            if attempt == LINK_ATTEMPTS:
                raise DisplayError(
                    f"gst-launch-1.0 could not take KWin's stream in {LINK_ATTEMPTS} attempts:\n{gst.last_lines()}"
                )
            self.link_retries += 1
            say(f"the encoder could not take KWin's stream (attempt {attempt} of {LINK_ATTEMPTS}); starting another")
            gst.retired.set()
            gst.stop(signal.SIGINT)
            gst, self.spare = (self.spare or self.start_encoder()), None
            self.gst = gst
        if old is not None:
            # Its pipe is closed and its link is gone; NVENC and CUDA teardown can take a while.
            threading.Thread(target=old.stop, args=(signal.SIGINT,), daemon=True).start()

    def link(self, gst, sink):
        """Link KWin's port to sink; True once the link is active, False if gst exits first."""
        subprocess.run(
            ["pw-link", str(self.source_port), str(sink)], stdin=subprocess.DEVNULL, capture_output=True, timeout=10
        )
        deadline = time.monotonic() + LINK_TIMEOUT
        while gst.alive() and time.monotonic() < deadline:
            if link_active(pw_dump(), self.source_port, sink):
                return True
            time.sleep(0.02)
        return False

    def stop_encoders(self):
        self.relay.close()
        for gst in (self.gst, self.spare):
            if gst is not None:
                gst.retired.set()
                gst.stop(signal.SIGINT)
                if gst.read_fd is not None:
                    os.close(gst.read_fd)

    def restart_capture(self, reason):
        """Give KWin's stream to the spare encoder, which restarts the capture, and print reason
        with the time the restart took."""
        started = time.monotonic()
        spare, self.spare = self.spare, None
        self.switch_to(spare)
        self.slow_restarts.restarted()
        linked = time.monotonic()
        first = (time.monotonic() - linked) * 1000 if self.relay.first_frame.wait(2) else None
        if self.spare is None:
            self.spare = self.start_encoder()
        say(
            f"{reason}: restarted the capture, "
            + (
                f"relinked after {(linked - started) * 1000:.0f} ms, first new frame sent {first:.0f} ms later"
                if first is not None
                else "no frame within 2 s of relinking"
            )
        )

    def watch(self):
        rate = Rate(self.stats)
        next_stats = time.monotonic() + STATS_EVERY
        while not self.failed.wait(0.1):
            for c in (self.receiver, self.krfb, self.gst, self.spare):
                if not c.alive():
                    raise DisplayError(c.exited())
            if self.restarts.due():
                self.restart_capture(f"a window came onto {output_name(self.a.name)}")
            cycle = self.relay.slow_cycle
            if cycle is not None and self.slow_restarts.allow():
                self.restart_capture(f"the capture fell into KWin's slow cycle ({SLOW_FRAMES} frames every {cycle:.0f} ms)")
            if time.monotonic() >= next_stats:
                next_stats += STATS_EVERY
                fps, mbps = rate.sample()
                say(f"sent {fps:.1f} fps, {mbps:.1f} Mb/s")
        raise DisplayError(self.reason)


def missing_tools(scale):
    need = (*REQUIRED, "kscreen-doctor") if scale is not None else REQUIRED
    return [t for t in need if shutil.which(t) is None]


def _raise_stop(signum, frame):
    raise Stop()


def main(argv=None):
    a = parse_args(argv)
    missing = missing_tools(a.scale)
    if missing:
        sys.exit(f"missing programs: {', '.join(missing)}")
    handled = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    previous = {sig: signal.getsignal(sig) for sig in handled}
    signal.signal(signal.SIGTERM, _raise_stop)
    signal.signal(signal.SIGHUP, _raise_stop)
    stack = contextlib.ExitStack()
    status = 0
    try:
        s = Session(a, stack)
        if a.control_stdin:
            threading.Thread(target=read_control, args=(sys.stdin, s.set_protection), daemon=True).start()
        s.check_free()
        s.start_receiver()
        source = s.start_monitor()
        s.start_stream(s.pointer_source(source))
        s.watch()
    except (KeyboardInterrupt, Stop):
        say("stopping")
    except DisplayError as e:
        say(f"error: {e}")
        status = 1
    finally:
        # A second Ctrl-C must not cut the teardown short and leave the monitor or receiver behind.
        for sig in handled:
            signal.signal(sig, signal.SIG_IGN)
        try:
            stack.close()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    return status


if __name__ == "__main__":
    sys.exit(main())
