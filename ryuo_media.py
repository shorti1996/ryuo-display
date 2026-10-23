"""Video files for the RYUO IV panel: probe, transcode when needed, adb push. Used by ryuod.py.

HomeUI plays .mp4 files through Rockchip's rockit framework and the rk_mpp hardware decoder.
FoxPodZ's decode tests on firmware 1.0.10 (ryuo-iv-screen, PROTOCOL.md "Native resolution works
in HEVC", captures/video-decode.log) set the limits used here:
  - H.264 plays up to 1920x1088 (c2.rk.avc.decoder's declared maximum; 2048x1080 also played).
    2240x1080 H.264 never gets a decoder: rockit logs RTConfigMeta and retries, the panel stays black.
  - HEVC tagged hvc1 plays at the full 2240x1080 (decoder declared to 4096x2160). verifyCodecTag
    checks the fourcc, so the tag is always written as hvc1.
  - The launcher picks a player by file extension: only .mp4 reaches the video player.
Anything outside those limits is re-encoded to 2240x1080 HEVC Main, 8-bit 4:2:0, at most 8 Mb/s
and 60 fps, without audio (the playback chain has no audio sink).

ffmpeg comes from PATH, else from the imageio-ffmpeg package. That bundled build has no ffprobe;
without one, files are not checked and always transcoded. The package is only importable under
`uv run`: the installed service runs /usr/bin/python3 and needs ffmpeg on PATH.
"""
import collections
import contextlib
import json
import os
import re
import shutil
import subprocess
import threading
import time

PANEL_W, PANEL_H = 2240, 1080
PANEL_ASPECT = PANEL_W / PANEL_H
H264_MAX = (1920, 1088)
ASPECT_TOLERANCE = 0.02     # 2 % either side of 2240:1080 counts as the panel's shape
MAX_FPS = 60
MAX_BITRATE = 10_000_000    # b/s; a file above this is re-encoded to the 8 Mb/s cap below
PIX_FMTS = ("yuv420p", "yuvj420p")
TAGS = {"h264": "avc1", "hevc": "hvc1"}
FITS = ("crop", "pad")
STEM_MAX = 32
ADB = ["adb"]

# Both land under 8 Mb/s on a 1920x1080 testsrc2 clip scaled to 2240x1080 (a worst case: noise
# in every frame). On this PC libx265 medium ran 2.9x realtime at 7.1 Mb/s. hevc_nvenc ran 7.3x
# but overshot an 8M maxrate to 8.9 Mb/s, so it gets 7M with a 1 s buffer, which gave 7.8 Mb/s.
ENCODERS = {
    "hevc_nvenc": ["-c:v", "hevc_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "24", "-b:v", "0",
                   "-maxrate", "7M", "-bufsize", "7M", "-profile:v", "main", "-pix_fmt", "yuv420p"],
    "libx265": ["-c:v", "libx265", "-preset", "medium", "-crf", "24", "-maxrate", "8M", "-bufsize", "16M",
                "-x265-params", "log-level=error", "-pix_fmt", "yuv420p"],
}


class MediaError(Exception):
    pass


class Cancelled(Exception):
    pass


# ---------------------------------------------------------------- binaries

class Tools:
    def __init__(self, ffmpeg, ffprobe, encoder):
        self.ffmpeg, self.ffprobe, self.encoder = ffmpeg, ffprobe, encoder

    def describe(self):
        return {"ffmpeg": self.ffmpeg, "ffprobe": self.ffprobe, "encoder": self.encoder}


def bundled_ffmpeg():
    """imageio-ffmpeg's static ffmpeg, or None when the package or its binary is missing."""
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError, OSError):
        return None


def nvenc_works(ffmpeg):
    """True if ffmpeg lists hevc_nvenc and can encode one frame with it. A listed encoder still
    fails without an NVIDIA GPU and driver."""
    try:
        listed = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True,
                                errors="replace", timeout=10).stdout
        if not re.search(r"^\s*V\S*\s+hevc_nvenc\s", listed, re.M):
            return False
        r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=s=256x256:d=0.1",
                            "-c:v", "hevc_nvenc", "-f", "null", "-"], capture_output=True, timeout=20)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def resolve():
    """Find ffmpeg (PATH, then imageio-ffmpeg), ffprobe (PATH only) and the HEVC encoder to use."""
    ffmpeg = shutil.which("ffmpeg") or bundled_ffmpeg()
    if ffmpeg is None:
        raise MediaError("no ffmpeg on PATH: install it (`make deps` names the package)")
    return Tools(ffmpeg, shutil.which("ffprobe"), "hevc_nvenc" if nvenc_works(ffmpeg) else "libx265")


_tools = None
_tools_lock = threading.Lock()


def tools():
    """resolve(), once per process. A failed lookup is retried on the next call."""
    global _tools
    with _tools_lock:
        if _tools is None:
            _tools = resolve()
        return _tools


# ---------------------------------------------------------------- running tools

class Cancel:
    """Cancellation shared between a job and the tool it is running; cancel() kills the tool."""

    def __init__(self):
        self.event = threading.Event()
        self.proc = None
        self.lock = threading.Lock()

    def is_set(self):
        return self.event.is_set()

    def cancel(self):
        with self.lock:
            self.event.set()
            if self.proc is not None and self.proc.poll() is None:
                self.proc.terminate()

    def attach(self, proc):
        with self.lock:
            self.proc = proc
            if self.event.is_set():
                proc.terminate()


def run(args, on_line=None, cancel=None, name=None):
    """Run a tool, passing each stdout line to on_line. Raises MediaError with the exit code and
    the last stderr line, or Cancelled."""
    name = name or os.path.basename(args[0])
    try:
        proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, errors="replace")
    except OSError as e:
        raise MediaError(f"{name}: {e.strerror}") from e
    with contextlib.suppress(OSError):
        # Below the daemon's priority, so a transcode cannot delay the heartbeat.
        os.setpriority(os.PRIO_PROCESS, proc.pid, 10)
    if cancel is not None:
        cancel.attach(proc)
    tail = collections.deque(maxlen=20)
    reader = threading.Thread(target=lambda: tail.extend(proc.stderr), daemon=True)
    reader.start()
    for line in proc.stdout:
        if on_line is not None:
            on_line(line.rstrip("\n"))
    rc = proc.wait()
    reader.join(5)
    if cancel is not None and cancel.is_set():
        raise Cancelled()
    if rc != 0:
        last = next((x.strip() for x in reversed(tail) if x.strip()), "no error output")
        raise MediaError(f"{name} exited with {rc}: {last}")


# ---------------------------------------------------------------- probing

def _rate(text):
    try:
        num, _, den = (text or "").partition("/")
        return float(num) / float(den or 1) if float(den or 1) else None
    except ValueError:
        return None


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def is_still(format_name):
    return "_pipe" in format_name or format_name == "image2"


def video_info(probed):
    """The facts plan() needs, from ffprobe's JSON. Raises MediaError for files with no video."""
    fmt = probed.get("format") or {}
    streams = probed.get("streams") or []
    if is_still(fmt.get("format_name", "")):
        raise MediaError("this is a still image; choose a video file")
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    if video is None:
        raise MediaError("no video stream in this file")
    rotation = 0
    for sd in video.get("side_data_list") or []:
        if "rotation" in sd:
            rotation = int(_num(sd["rotation"]) or 0)
    rotation = rotation or int(_num((video.get("tags") or {}).get("rotate")) or 0)
    sar = video.get("sample_aspect_ratio")
    return {
        "probed": True,
        "map": str(video.get("index", 0)),
        "codec": video.get("codec_name"),
        "tag": video.get("codec_tag_string"),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "pix_fmt": video.get("pix_fmt"),
        "sar": None if sar in (None, "0:1", "1:1") else sar,
        "rotation": rotation % 360,
        "fps": _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate")),
        "bitrate": _num(video.get("bit_rate")) or _num(fmt.get("bit_rate")),
        "duration": _num(fmt.get("duration")) or _num(video.get("duration")),
        "streams": len(streams),
        "mp4": fmt.get("format_name", "").startswith("mov,mp4"),
    }


def ffmpeg_info(text):
    """Minimal facts from `ffmpeg -i FILE` stderr, for when there is no ffprobe: the container,
    the duration (for progress) and whether a video stream exists. Codec, size and pixel format
    are left unknown, so plan() transcodes."""
    m = re.search(r"^Input #0, ([^,]+(?:,[^,\s]+)*), from ", text, re.M)
    if m is None:
        last = (text.strip().splitlines() or ["no output"])[-1]
        raise MediaError(f"ffmpeg cannot read this file: {last}")
    if is_still(m.group(1)):
        raise MediaError("this is a still image; choose a video file")
    if not re.search(r"^\s*Stream #0:\d+\S*: Video: ", text, re.M):
        raise MediaError("no video stream in this file")
    d = re.search(r"Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)", text)
    duration = int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3)) if d else None
    # sar "unknown" makes video_filter square the pixels, a no-op for square ones.
    return {"probed": False, "map": "v:0", "codec": None, "tag": None, "width": 0, "height": 0, "pix_fmt": None,
            "sar": "unknown", "rotation": 0, "fps": None, "bitrate": None, "duration": duration, "streams": None,
            "mp4": m.group(1).startswith("mov,mp4")}


def inspect(path, t):
    """video_info() through ffprobe when there is one, else ffmpeg_info()."""
    try:
        if t.ffprobe:
            r = subprocess.run([t.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
                               capture_output=True, text=True, errors="replace", timeout=60)
            if r.returncode != 0:
                last = (r.stderr.strip().splitlines() or ["no error output"])[-1]
                raise MediaError(f"ffprobe exited with {r.returncode}: {last}")
            try:
                return video_info(json.loads(r.stdout))
            except ValueError as e:
                raise MediaError("ffprobe printed invalid JSON") from e
        # ffmpeg exits 1 here ("At least one output file must be specified"); the stream list is
        # printed before that.
        r = subprocess.run([t.ffmpeg, "-hide_banner", "-nostdin", "-i", path],
                           capture_output=True, text=True, errors="replace", timeout=60)
        return ffmpeg_info(r.stderr)
    except (OSError, subprocess.SubprocessError) as e:
        raise MediaError(f"probe: {e}") from e


def problems(info):
    """Reasons the video stream cannot go to the panel unchanged; empty when it can."""
    out = []
    w, h, codec = info["width"], info["height"], info["codec"]
    if codec not in TAGS:
        out.append(f"codec {codec}; the panel decodes H.264 and HEVC")
    if info["pix_fmt"] not in PIX_FMTS:
        out.append(f"pixel format {info['pix_fmt']}; the panel needs 8-bit 4:2:0")
    if codec == "h264" and (w > H264_MAX[0] or h > H264_MAX[1]):
        out.append(f"H.264 at {w}x{h}; the panel's H.264 decoder stops at {H264_MAX[0]}x{H264_MAX[1]}")
    if w > PANEL_W or h > PANEL_H:
        out.append(f"{w}x{h} is larger than the {PANEL_W}x{PANEL_H} panel")
    if h and abs((w / h) / PANEL_ASPECT - 1) > ASPECT_TOLERANCE:
        out.append(f"aspect ratio {w / h:.2f}:1; the panel is {PANEL_ASPECT:.2f}:1")
    if info["sar"]:
        out.append(f"non-square pixels (SAR {info['sar']})")
    if info["rotation"]:
        out.append(f"rotated {info['rotation']}°")
    if info["fps"] and info["fps"] > MAX_FPS + 0.5:
        out.append(f"{info['fps']:.0f} fps; capped at {MAX_FPS}")
    if info["bitrate"] and info["bitrate"] > MAX_BITRATE:
        out.append(f"{info['bitrate'] / 1e6:.1f} Mb/s; capped at 8")
    return out


def plan(info):
    """("copy" | "remux" | "transcode", reason) for a video_info() or ffmpeg_info() result.

    copy: an MP4 holding only a compatible, correctly tagged video stream goes over as it is.
    remux: the video stream is compatible, but the container, its tag or extra streams (audio,
    subtitles) are not; ffmpeg copies the stream into a fresh MP4 without re-encoding.
    """
    if not info["probed"]:
        return "transcode", "no ffprobe to check the file, so it is converted"
    found = problems(info)
    if found:
        return "transcode", "; ".join(found)
    if info["mp4"] and info["streams"] == 1 and info["tag"] == TAGS[info["codec"]]:
        return "copy", "already plays on the panel"
    return "remux", "the video plays on the panel; repackaging it as an MP4 with only that stream"


# ---------------------------------------------------------------- converting

def video_filter(info, fit):
    """crop fills the panel and cuts the overflowing edges; pad shows the whole frame with black bars."""
    if fit not in FITS:
        raise ValueError(f"fit must be one of {FITS}")
    # Square the pixels first, so the aspect ratio the scale keeps is the one the viewer sees.
    pre = "scale=trunc(iw*sar/2)*2:ih,setsar=1," if info["sar"] else ""
    if fit == "crop":
        return pre + (f"scale={PANEL_W}:{PANEL_H}:force_original_aspect_ratio=increase:flags=lanczos,"
                      f"crop={PANEL_W}:{PANEL_H},setsar=1")
    return pre + (f"scale={PANEL_W}:{PANEL_H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,"
                  f"pad={PANEL_W}:{PANEL_H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1")


def ffmpeg_args(src, dst, info, action, fit, t):
    """The ffmpeg command for a remux or transcode. Only the chosen video stream is kept; metadata
    such as a phone's location is dropped. -progress writes key=value lines to stdout."""
    head = [t.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", src,
            "-map", f"0:{info['map']}", "-map_metadata", "-1"]
    tail = ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-f", "mp4", dst]
    if action == "remux":
        return [*head, "-c:v", "copy", "-tag:v", TAGS[info["codec"]], *tail]
    if action == "transcode":
        return [*head, "-vf", video_filter(info, fit), "-fpsmax", str(MAX_FPS), *ENCODERS[t.encoder],
                "-tag:v", "hvc1", *tail]
    raise ValueError(f"no ffmpeg step for {action!r}")


class Progress:
    """Folds ffmpeg -progress lines into (fraction done or None, speed text) once per block."""

    def __init__(self, duration):
        self.duration = duration
        self.block = {}

    def feed(self, line):
        key, sep, value = line.partition("=")
        if not sep:
            return None
        key, value = key.strip(), value.strip()
        self.block[key] = value
        if key != "progress":
            return None
        block, self.block = self.block, {}
        done = 1.0 if value == "end" else None
        us = block.get("out_time_us", "")
        if done is None and self.duration and us.lstrip("-").isdigit():
            done = min(1.0, max(0.0, int(us) / 1e6 / self.duration))
        speed = block.get("speed", "")
        return done, None if speed in ("", "N/A") else speed


def convert(src, dst, info, action, fit, t, on_progress=None, cancel=None):
    """Remux or transcode src into dst, reporting (fraction, speed) as ffmpeg goes."""
    prog = Progress(info["duration"])

    def line(text):
        got = prog.feed(text)
        if got is not None and on_progress is not None:
            on_progress(*got)

    run(ffmpeg_args(src, dst, info, action, fit, t), line, cancel, name="ffmpeg")


# ---------------------------------------------------------------- device side

def device_name(filename, now=None):
    """Name for /sdcard/pcMedia: a millisecond timestamp, like Armoury Crate's uploads, then the
    original stem in [A-Za-z0-9._-]. HomeUI matches names by substring and looks in the preset
    folder first for names starting with RYUO, so every name starts with its own unique timestamp."""
    now = time.time() if now is None else now
    stamp = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime(now)) + f"-{int(now * 1000) % 1000:03d}"
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-_")[:STEM_MAX].strip(".-_")
    return f"{stamp}_{stem}.mp4" if stem else f"{stamp}.mp4"


def push(src, name, media_dir, cancel=None):
    """adb push src to media_dir + name. A failed or cancelled push removes the partial file."""
    dst = media_dir + name
    try:
        run([*ADB, "push", src, dst], cancel=cancel, name="adb push")
    except (MediaError, Cancelled):
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            subprocess.run([*ADB, "shell", "rm", "-f", dst], capture_output=True, timeout=10)
        raise
