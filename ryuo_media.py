"""Video files for the RYUO IV panel: probe, transcode when needed, adb push, and thumbnails and
H.264 proxies so the browser can preview files already on the panel. Still images are converted to a
full-panel PNG (still_to_png). Used by ryuod.py.

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
import struct
import subprocess
import threading
import time
import zlib

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


class StillImage(MediaError):
    """The file is a single picture (PNG, JPEG, WebP, BMP, HEIC...), not a video. still_to_png() takes
    those, with `grid` from tile_grid() when the picture is stored as tiles."""

    def __init__(self, grid=None):
        super().__init__("this is a still image; choose a video file")
        self.grid = grid


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


# ISO BMFF major brands of a HEIF or AVIF picture. ffmpeg reads those through its MP4 demuxer, so
# the format name alone looks like a video. msf1, hevc and avis are image sequences and are left out.
HEIF_BRANDS = ("heic", "heix", "mif1", "avif")


def tile_grid(probed):
    """How to rebuild a HEIF picture stored as tiles, from ffprobe's -show_stream_groups JSON, or None.

    Phones save a 12 MP photo as a grid of 512x512 HEVC tiles, and ffmpeg 7.1 lists each tile as
    its own video stream without joining them. Returns {"tiles": [(stream index, x, y)...],
    "crop": (w, h, x, y)} for the default group, else the first: xstack places the tiles, and the
    crop cuts the grid's padding off the right and bottom edges."""
    groups = [g for g in probed.get("stream_groups") or [] if g.get("type") == "Tile Grid"]
    if not groups:
        return None
    group = next((g for g in groups if (g.get("disposition") or {}).get("default")), groups[0])
    grid = group["components"][0]
    indexes = [s["index"] for s in group["streams"]]
    tiles = [(indexes[sub["stream_index"]], sub["tile_horizontal_offset"], sub["tile_vertical_offset"])
             for sub in grid["subcomponents"]]
    return {"tiles": tiles,
            "crop": (grid["width"], grid["height"], grid["horizontal_offset"], grid["vertical_offset"])}


def video_info(probed):
    """The facts plan() needs, from ffprobe's JSON. Raises MediaError for files with no video."""
    fmt = probed.get("format") or {}
    streams = probed.get("streams") or []
    if is_still(fmt.get("format_name", "")) or (fmt.get("tags") or {}).get("major_brand") in HEIF_BRANDS:
        raise StillImage(tile_grid(probed))
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
    the duration (for progress), and the first video stream's codec and pixel format (for the
    browser preview). Size is left unknown, and plan() transcodes any file probed this way."""
    m = re.search(r"^Input #0, ([^,]+(?:,[^,\s]+)*), from ", text, re.M)
    if m is None:
        last = (text.strip().splitlines() or ["no output"])[-1]
        raise MediaError(f"ffmpeg cannot read this file: {last}")
    if is_still(m.group(1)):
        raise StillImage()
    # ffmpeg -i names the grid but not where each tile goes; ffprobe's -show_stream_groups does.
    if "Tile Grid:" in text:
        raise MediaError("this picture is stored as tiles, and joining them needs ffprobe: install ffmpeg on PATH")
    brand = re.search(r"^\s*major_brand\s*: (\w+)", text, re.M)
    if brand and brand.group(1) in HEIF_BRANDS:
        raise StillImage()
    # "Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x960 ..."
    v = re.search(r"^\s*Stream #0:\d+\S*: Video: (\w+)[^,\n]*(?:, (\w+))?", text, re.M)
    if v is None:
        raise MediaError("no video stream in this file")
    d = re.search(r"Duration: (\d+):(\d\d):(\d\d(?:\.\d+)?)", text)
    duration = int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3)) if d else None
    # sar "unknown" makes video_filter square the pixels, a no-op for square ones.
    return {"probed": False, "map": "v:0", "codec": v.group(1), "tag": None, "width": 0, "height": 0,
            "pix_fmt": v.group(2), "sar": "unknown", "rotation": 0, "fps": None, "bitrate": None,
            "duration": duration, "streams": None, "mp4": m.group(1).startswith("mov,mp4")}


def inspect(path, t):
    """video_info() through ffprobe when there is one, else ffmpeg_info()."""
    try:
        if t.ffprobe:
            r = subprocess.run([t.ffprobe, "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
                                "-show_stream_groups", path],
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


def _boxes(f, end):
    """(type, payload start, payload end) for each ISO BMFF box from f's position up to end."""
    pos = f.tell()
    while pos + 8 <= end:
        f.seek(pos)
        size, kind = struct.unpack(">I4s", f.read(8))
        start = pos + 8
        if size == 1:
            (size,) = struct.unpack(">Q", f.read(8))
            start += 8
        elif size == 0:
            size = end - pos
        if size < start - pos:
            return
        yield kind.decode("latin-1"), start, pos + size
        pos += size


def _child(f, start, end, kind):
    f.seek(start)
    return next(((s, e) for k, s, e in _boxes(f, end) if k == kind), None)


# irot turns the picture counter-clockwise by 90° per step; imir axis 0 mirrors left-right.
IROT_FILTERS = {1: ["transpose=cclock"], 2: ["hflip", "vflip"], 3: ["transpose=clock"]}
IMIR_FILTERS = {0: ["hflip"], 1: ["vflip"]}


def heif_orientation(path):
    """ffmpeg filters that turn a HEIF picture upright, from the irot and imir properties of its
    primary item; [] for any other file. ffmpeg 7.1 neither applies these to a tile grid nor
    reports them. A phone holding the camera upright saves a landscape grid with irot 3."""
    try:
        with open(path, "rb") as f:
            end = os.fstat(f.fileno()).st_size
            if f.read(8)[4:] != b"ftyp":
                return []
            f.seek(0)
            meta = next(((s, e) for k, s, e in _boxes(f, end) if k == "meta"), None)
            if meta is None:
                return []
            meta = (meta[0] + 4, meta[1])  # skip the full box's version and flags
            pitm, iprp = _child(f, *meta, "pitm"), _child(f, *meta, "iprp")
            if pitm is None or iprp is None:
                return []
            f.seek(pitm[0])
            version = f.read(4)[0]
            (primary,) = struct.unpack(">H" if version == 0 else ">I", f.read(2 if version == 0 else 4))
            ipco, ipma = _child(f, *iprp, "ipco"), _child(f, *iprp, "ipma")
            if ipco is None or ipma is None:
                return []
            f.seek(ipco[0])
            props = [(k, s) for k, s, _ in _boxes(f, ipco[1])]
            f.seek(ipma[0])
            version, flags = f.read(1)[0], int.from_bytes(f.read(3), "big")
            (count,) = struct.unpack(">I", f.read(4))
            for _ in range(count):
                (item,) = struct.unpack(">H" if version < 1 else ">I", f.read(2 if version < 1 else 4))
                links = [int.from_bytes(f.read(2 if flags & 1 else 1), "big") & (0x7FFF if flags & 1 else 0x7F)
                         for _ in range(f.read(1)[0])]
                if item != primary:
                    continue
                filters = []
                # Property indexes count from 1; 0 means none. The order of the links is the order to apply them.
                for kind, start in (props[i - 1] for i in links if 0 < i <= len(props)):
                    if kind in ("irot", "imir"):
                        f.seek(start)
                        value = f.read(1)[0]
                        filters += IROT_FILTERS.get(value & 3, []) if kind == "irot" else IMIR_FILTERS[value & 1]
                return filters
    except (OSError, struct.error, IndexError):
        pass
    return []


def still_to_png(src, dst, fit, t, cancel=None, grid=None):
    """A still image as a PANEL_W x PANEL_H 8-bit RGB PNG, the format of black_png(), which HomeUI
    shows full screen in its ImageView. The first frame only (an animated WebP keeps one), no
    metadata; an alpha channel is dropped. Pixels count as square: picture formats rarely say otherwise.
    A HEIF picture is joined from its tiles (grid, from tile_grid()) and turned upright first."""
    part = dst + ".part"
    if grid and len(grid["tiles"]) > 1:
        inputs = "".join(f"[0:{index}]" for index, _, _ in grid["tiles"])
        layout = "|".join(f"{x}_{y}" for _, x, y in grid["tiles"])
        source = f"{inputs}xstack=inputs={len(grid['tiles'])}:layout={layout}"
    else:
        source = f"[0:{grid['tiles'][0][0]}]null" if grid else "[0:v:0]null"
    steps = [source]
    if grid:
        steps.append("crop={}:{}:{}:{}".format(*grid["crop"]))
    steps += [*heif_orientation(src), video_filter({"sar": None}, fit)]
    run([t.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", src,
         "-filter_complex", ",".join(steps) + "[out]", "-map", "[out]",
         "-map_metadata", "-1", "-frames:v", "1", "-pix_fmt", "rgb24",
         "-c:v", "png", "-f", "image2", part], cancel=cancel, name="ffmpeg")
    if not os.path.exists(part) or os.path.getsize(part) == 0:
        raise MediaError("ffmpeg wrote no image")
    os.replace(part, dst)


# ---------------------------------------------------------------- browser preview

THUMB_W = 320
PROXY_W = 640


def browser_plays(info):
    """True if Chrome decodes the video stream as it is. It plays 8-bit 4:2:0 H.264 but not HEVC,
    and every file the upload converts is HEVC."""
    return info["codec"] == "h264" and info["pix_fmt"] in PIX_FMTS


def thumbnail(src, dst, t):
    """A THUMB_W px wide JPEG of the frame at 1 s, or of the first frame when the clip is shorter."""
    part = dst + ".part"
    for seek in (["-ss", "1"], []):
        try:
            run([t.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *seek, "-i", src,
                 "-frames:v", "1", "-vf", f"scale={THUMB_W}:-2", "-q:v", "4", "-f", "image2", "-c:v", "mjpeg", part],
                name="ffmpeg")
        except MediaError:
            # Seeking past the end: ffmpeg 7.0 exits 0 and writes nothing, 7.1 exits 234.
            if not seek:
                raise
            continue
        if os.path.exists(part) and os.path.getsize(part) > 0:
            os.replace(part, dst)
            return
    raise MediaError("ffmpeg found no frame to make a thumbnail from")


def proxy(src, dst, t):
    """A PROXY_W px wide H.264 copy of the video stream for the browser, without sound. About 2 s
    for 2 minutes of 1920x960 video; faststart puts the index first, so playback starts early."""
    part = dst + ".part"
    run([t.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", src, "-map", "0:v:0",
         "-map_metadata", "-1", "-vf", f"scale={PROXY_W}:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", part], name="ffmpeg")
    os.replace(part, dst)


# ---------------------------------------------------------------- device side

def device_name(filename, now=None, ext=".mp4"):
    """Name for /sdcard/pcMedia: a millisecond timestamp, like Armoury Crate's uploads, then the
    original stem in [A-Za-z0-9._-]. HomeUI matches names by substring and looks in the preset
    folder first for names starting with RYUO, so every name starts with its own unique timestamp.
    HomeUI plays a .mp4 as video and shows any other name as a still image."""
    now = time.time() if now is None else now
    stamp = time.strftime("%Y-%m-%d_%H-%M-%S", time.localtime(now)) + f"-{int(now * 1000) % 1000:03d}"
    stem = os.path.splitext(os.path.basename(filename or ""))[0]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-_")[:STEM_MAX].strip(".-_")
    return f"{stamp}_{stem}{ext}" if stem else f"{stamp}{ext}"


def black_png(width=PANEL_W, height=PANEL_H):
    """A black 8-bit RGB PNG, built with zlib alone. 2240x1080 compresses to about 7 kB."""

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    # Each row is filter type 0 (none) followed by width black pixels of 3 bytes.
    rows = bytes(1 + 3 * width) * height
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # bit depth 8, colour type 2 (RGB)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def push(src, name, media_dir, cancel=None):
    """adb push src to media_dir + name. A failed or cancelled push removes the partial file."""
    dst = media_dir + name
    try:
        run([*ADB, "push", src, dst], cancel=cancel, name="adb push")
    except (MediaError, Cancelled):
        with contextlib.suppress(OSError, subprocess.SubprocessError):
            subprocess.run([*ADB, "shell", "rm", "-f", dst], capture_output=True, timeout=10)
        raise
