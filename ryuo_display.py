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
  3. KWin publishes the output as a PipeWire video stream for krfb. gst-launch-1.0 opens its own
     consumer (pipewiresrc, not auto-connected); pw-link removes krfb's link to KWin's stream and
     links this consumer in its place. GStreamer imports the frames as DMA-BUFs into OpenGL and
     nvh265enc encodes them on the GPU, with an access unit delimiter before every frame, which
     is where the receiver cuts frames.
  4. gst-launch hands each encoded frame to this process in a GDP packet (gdppay). This process
     sends it to the forwarded TCP port followed at once by the next frame's delimiter (see
     panel_frame()), and prints the frame rate and bitrate every 5 s.
  5. A KWin script reports windows that come onto the output, and the tool then restarts KWin's
     stream with a fresh encoder (see "windows arriving on the output" below): on KWin 6.7.5 such
     windows are otherwise captured at about 1 frame/s.

KWin sends a frame only when something on the virtual output changes: a still desktop sends
nothing and the panel keeps the last frame. The mouse pointer is not drawn on the panel, because
krfb requests it from KWin as metadata, which pipewiresrc ignores.

Needs: adb, krfb-virtualmonitor (krfb), unshare (util-linux), pw-dump and pw-link (pipewire-utils),
gst-launch-1.0 with pipewiresrc, glupload and nvh265enc (gstreamer1-plugins-bad with nvcodec), an
NVIDIA GPU, and kscreen-doctor for --scale. Python: the standard library, plus PyGObject
(python3-gobject, imported as gi) for the D-Bus side of the window watch; without it the tool
still runs, and windows that arrive after the start stay at about 1 frame/s.
"""

import argparse
import collections
import contextlib
import json
import os
import queue
import re
import secrets
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
    p.add_argument("-v", "--verbose", action="store_true", help="also print krfb-virtualmonitor's output")
    a = p.parse_args(argv)
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
    keyframe would have to repair), and an access unit delimiter (NAL type 35) before every frame."""
    return [
        "gst-launch-1.0",
        "-q",
        "pipewiresrc",
        "autoconnect=false",
        f"client-name={node_name}",
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


def relay(fds, sock, stats, on_error):
    """Send encoded frames to the receiver, reading each encoder's pipe in turn.

    fds is a queue of pipe read ends, one per encoder process. When an encoder is replaced (see
    Session.restart_capture()) its pipe reaches end of file and reading continues with the next
    one; the new encoder starts with its own parameter sets and keyframe, which the panel's decoder
    takes mid-stream. None in the queue ends the relay."""
    try:
        sock.sendall(AUD)
        while (fd := fds.get()) is not None:
            reader = GdpReader()
            try:
                while chunk := os.read(fd, 1 << 20):
                    for kind, payload in reader.feed(chunk):
                        if kind == GDP_BUFFER:
                            data = panel_frame(payload)
                            sock.sendall(data)
                            stats.add(len(data))
            finally:
                os.close(fd)
    except (OSError, ValueError) as e:
        on_error(f"stream to the panel failed: {e}")


# ---------------------------------------------------------------- windows arriving on the output

# Works around KWin 6.7.5 behaviour measured on the development PC (2026-10-23). Once the
# screencast stream for the virtual output is running, a window that comes onto the output (opened
# there, or moved there from another monitor) is captured at 0.5-2.3 frames/s, in bursts of 3
# frames (KWin's buffer count) about 0.4-1.3 s apart, while KWin presents the same window at 60 Hz.
# A plain pipewiresrc ! fakesink consumer sees the same rate, so the encoder is not the cause.
# Windows that were on the output when the stream last went from paused to streaming are captured
# at 56-60 frames/s. So the tool restarts the stream after a window arrives: a KWin script reports
# arrivals over D-Bus, and restart_capture() swaps in a new encoder.

DBUS_IFACE = "org.rogryuolcd.Display"
DBUS_PATH = "/org/rogryuolcd/Display"
DBUS_XML = f"""<node><interface name="{DBUS_IFACE}">
<method name="WindowEvent"><arg type="s" name="kind" direction="in"/></method>
</interface></node>"""
RESTART_QUIET = 0.5  # s without window events after an arrival before the stream is restarted
MOVE_REPORT_WINDOW = 3000  # ms after an arrival during which the script also reports moves


def kwin_script(output, service):
    """KWin script that calls WindowEvent("enter") on service when a window starts to overlap
    output, and WindowEvent("move") while windows on output keep moving shortly after an arrival
    (so the restart waits until a drag has settled)."""
    return f"""// Loaded by ryuo_display.py; unloaded when it exits.
const OUTPUT = {json.dumps(output)};
let lastEnter = 0;
function send(kind) {{
    callDBus({json.dumps(service)}, {json.dumps(DBUS_PATH)}, {json.dumps(DBUS_IFACE)}, "WindowEvent", kind);
}}
function onOutput(w) {{
    const s = workspace.screens.find(o => o.name === OUTPUT);
    if (!s || !w.frameGeometry) return false;
    const a = s.geometry, g = w.frameGeometry;
    return g.x < a.x + a.width && a.x < g.x + g.width && g.y < a.y + a.height && a.y < g.y + g.height;
}}
function track(w, isNew) {{
    let was = onOutput(w);
    if (isNew && was) {{ lastEnter = Date.now(); send("enter"); }}
    w.frameGeometryChanged.connect(function () {{
        const now = onOutput(w);
        if (now && !was) {{ lastEnter = Date.now(); send("enter"); }}
        else if (now && Date.now() - lastEnter < {MOVE_REPORT_WINDOW}) send("move");
        was = now;
    }});
}}
workspace.windowList().forEach(w => track(w, false));
workspace.windowAdded.connect(w => track(w, true));
"""


class WindowWatch:
    """Loads kwin_script() into KWin and calls on_event(kind) for each report. Uses PyGObject
    (gi.repository.Gio) for D-Bus: the script reaches this process by calling a method on a bus
    name it owns, and the standard library has no D-Bus."""

    def __init__(self, output, on_event):
        import gi

        gi.require_version("Gio", "2.0")
        from gi.repository import Gio, GLib

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
        self.loop = GLib.MainLoop()
        threading.Thread(target=self.loop.run, daemon=True).start()
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
        self.on_event(params.unpack()[0])
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
        self.loop.quit()
        shutil.rmtree(self.dir, ignore_errors=True)


class RestartTimer:
    """Decides when to restart the stream: RESTART_QUIET s after the last window event, once a
    window has arrived since the previous restart. Thread-safe; now() is injectable for tests."""

    def __init__(self, now=time.monotonic):
        self.now = now
        self.lock = threading.Lock()
        self.pending = False
        self.last = 0.0

    def event(self, kind):
        with self.lock:
            self.last = self.now()
            if kind == "enter":
                self.pending = True

    def due(self):
        """True once per arrival, when the restart should happen now."""
        with self.lock:
            if self.pending and self.now() - self.last >= RESTART_QUIET:
                self.pending = False
                return True
            return False


# ---------------------------------------------------------------- processes

_print_lock = threading.Lock()


def say(text):
    with _print_lock:
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
        self.fds = queue.Queue()
        self.generation = 0
        self.gst = self.spare = None
        self.stack.callback(self.stop_encoders)
        threading.Thread(target=relay, args=(self.fds, sock, self.stats, self.fail), daemon=True).start()
        self.switch_to(self.start_encoder())
        # A restart has to wait for the replacement encoder to start (about 1.5 s for GStreamer's
        # OpenGL and CUDA setup), so one is kept ready, idle and unlinked.
        self.spare = self.start_encoder()
        say(f"streaming to the panel at {self.a.bitrate:g} Mb/s; stop with Ctrl-C")

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
        """Start a gst-launch-1.0 encoder whose PipeWire input is not linked yet. Its pipe goes into
        the relay's queue now, so the relay reads it after the encoders started before it."""
        self.generation += 1
        node_name = f"ryuo-display-{os.getpid()}-{self.generation}"
        read_fd, write_fd = os.pipe()
        retired = threading.Event()

        def line(text):
            if not retired.is_set():
                say(f"gst-launch-1.0: {text}")

        try:
            gst = Child("gst-launch-1.0", gst_cmd(node_name, write_fd, self.a.bitrate), line, pass_fds=(write_fd,))
        except DisplayError:
            os.close(read_fd)
            raise
        finally:
            os.close(write_fd)
        gst.node_name, gst.retired = node_name, retired
        self.fds.put(read_fd)
        return gst

    def switch_to(self, gst):
        """Give KWin's stream to gst in place of the current consumer (krfb at first, the previous
        encoder on a restart).

        KWin renders a frame for the stream when the desktop changes and once when the stream goes
        from paused to streaming. Removing every link from KWin's port first pauses the stream, so
        linking gst restarts it: the panel gets the current desktop at once, and every window now on
        the output is captured at the full rate. krfb keeps running without frames, which also saves
        the CPU time of its VNC copy. The old encoder fails when its link goes; its output is muted
        and it is stopped."""
        sink = wait_for(
            "PipeWire input from gst-launch-1.0", lambda: input_port(pw_dump(), gst.node_name), gst, GRAPH_TIMEOUT
        )
        old, self.gst = self.gst, gst
        if old is not None:
            old.retired.set()
        for link in links_from(pw_dump(), self.source_port):
            run_tool(["pw-link", "-d", str(link)], "pw-link -d")
        run_tool(["pw-link", str(self.source_port), str(sink)], "pw-link")
        if old is not None:
            old.stop(signal.SIGINT)

    def stop_encoders(self):
        for gst in (self.gst, self.spare):
            if gst is not None:
                gst.retired.set()
                gst.stop(signal.SIGINT)
        self.fds.put(None)

    def restart_capture(self):
        self.switch_to(self.spare)
        self.spare = None
        linked, frames = time.monotonic(), self.stats.frames
        while self.stats.frames == frames and time.monotonic() - linked < 1:
            time.sleep(0.005)
        first = (time.monotonic() - linked) * 1000 if self.stats.frames != frames else None
        self.spare = self.start_encoder()
        say(
            f"a window came onto {output_name(self.a.name)}: restarted the capture, "
            + (f"first new frame sent {first:.0f} ms after relinking" if first is not None else "no frame within 1 s")
        )

    def watch(self):
        rate = Rate(self.stats)
        next_stats = time.monotonic() + STATS_EVERY
        while not self.failed.wait(0.1):
            for c in (self.receiver, self.krfb, self.gst, self.spare):
                if not c.alive():
                    raise DisplayError(c.exited())
            if self.restarts.due():
                self.restart_capture()
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
        s.check_free()
        s.start_receiver()
        source = s.start_monitor()
        s.start_stream(source)
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
