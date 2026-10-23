"""ryuo_media: compatibility rules, ffmpeg commands, progress parsing, binary lookup and tool runs.

Nothing here touches adb or the cooler. The real-transcode tests at the end run ffmpeg on clips
generated into tmp_path and are skipped when the binaries are missing.
"""
import json
import shutil
import subprocess
import sys
import threading
import time
import types

import pytest

import ryuo_media as M

FFMPEG_I_STDERR = """\
Input #0, matroska,webm, from '/tmp/x/source.mkv':
  Metadata:
    ENCODER         : Lavf61.7.103
  Duration: 00:01:05.02, start: -0.023000, bitrate: 6365 kb/s
  Stream #0:0: Video: h264 (High 10), yuv420p10le(tv, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 1k tbn
  Stream #0:1: Audio: aac (LC), 44100 Hz, mono, fltp
At least one output file must be specified
"""


def probed(codec="h264", tag="avc1", w=1920, h=926, pix="yuv420p", fmt="mov,mp4,m4a,3gp,3g2,mj2",
           extra=(), fps="30/1", bitrate="2200000", duration="12.5", **video):
    v = {"index": 0, "codec_type": "video", "codec_name": codec, "codec_tag_string": tag, "width": w, "height": h,
         "pix_fmt": pix, "sample_aspect_ratio": "1:1", "avg_frame_rate": fps, "bit_rate": bitrate, **video}
    return {"format": {"format_name": fmt, "duration": duration}, "streams": [v, *extra]}


AUDIO = {"index": 1, "codec_type": "audio", "codec_name": "aac"}
X265 = M.Tools("/usr/bin/ffmpeg", "/usr/bin/ffprobe", "libx265")


# ---------------------------------------------------------------- plan

def test_asus_shaped_h264_mp4_goes_over_unchanged():
    assert M.plan(M.video_info(probed())) == ("copy", "already plays on the panel")


def test_full_panel_hevc_mp4_goes_over_unchanged():
    assert M.plan(M.video_info(probed("hevc", "hvc1", 2240, 1080)))[0] == "copy"


@pytest.mark.parametrize("p, reason", [
    (probed(w=2240, h=1080), "H.264 at 2240x1080; the panel's H.264 decoder stops at 1920x1088"),
    (probed("hevc", "hvc1", 2240, 1080, pix="yuv420p10le"), "pixel format yuv420p10le"),
    (probed("vp9", "vp09", 2240, 1080), "codec vp9; the panel decodes H.264 and HEVC"),
    (probed(w=1920, h=1080), "aspect ratio 1.78:1; the panel is 2.07:1"),
    (probed(side_data_list=[{"side_data_type": "Display Matrix", "rotation": -90}]), "rotated 270°"),
    (probed(tags={"rotate": "90"}), "rotated 90°"),
    (probed(fps="120/1"), "120 fps; capped at 60"),
    (probed(bitrate="20000000"), "20.0 Mb/s; capped at 8"),
    (probed(sample_aspect_ratio="4:3"), "non-square pixels (SAR 4:3)"),
    (probed("hevc", "hvc1", 3840, 1852), "3840x1852 is larger than the 2240x1080 panel"),
])
def test_incompatible_video_is_transcoded_with_the_reason(p, reason):
    action, why = M.plan(M.video_info(p))
    assert action == "transcode"
    assert reason in why


def test_59_94_fps_is_within_the_cap():
    assert M.plan(M.video_info(probed(fps="60000/1001")))[0] == "copy"


@pytest.mark.parametrize("p", [
    probed("hevc", "hev1", 2240, 1080),                          # fourcc rockit may not accept
    probed(fmt="matroska,webm", tag=""),                           # right stream, wrong container
    probed(extra=[AUDIO]),                                         # a phone clip with sound
])
def test_compatible_stream_in_the_wrong_wrapper_is_remuxed(p):
    assert M.plan(M.video_info(p))[0] == "remux"


def test_cover_art_is_not_taken_for_the_video():
    art = {"index": 0, "codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}}
    p = probed()
    p["streams"][0]["index"] = 1
    p["streams"].insert(0, art)
    info = M.video_info(p)
    assert (info["codec"], info["map"]) == ("h264", "1")


@pytest.mark.parametrize("p, msg", [
    ({"format": {"format_name": "png_pipe"}, "streams": [{"codec_type": "video"}]}, "still image"),
    ({"format": {"format_name": "mp3"}, "streams": [AUDIO]}, "no video stream"),
])
def test_files_without_video_are_refused(p, msg):
    with pytest.raises(M.MediaError, match=msg):
        M.video_info(p)


# ---------------------------------------------------------------- no ffprobe: ffmpeg -i stderr

def test_ffmpeg_info_reads_container_and_duration_and_always_transcodes():
    info = M.ffmpeg_info(FFMPEG_I_STDERR)
    assert info["duration"] == pytest.approx(65.02)
    assert (info["probed"], info["map"], info["mp4"]) == (False, "v:0", False)
    assert M.plan(info) == ("transcode", "no ffprobe to check the file, so it is converted")


def test_ffmpeg_info_refusals():
    with pytest.raises(M.MediaError, match="still image"):
        M.ffmpeg_info("Input #0, png_pipe, from 'a.png':\n  Stream #0:0: Video: png, rgb24, 64x64\n")
    with pytest.raises(M.MediaError, match="no video stream"):
        M.ffmpeg_info("Input #0, mp3, from 'a.mp3':\n  Duration: 00:00:03.00\n  Stream #0:0: Audio: mp3\n")
    with pytest.raises(M.MediaError, match="cannot read this file: x: Invalid data found"):
        M.ffmpeg_info("x: Invalid data found when processing input\n")


def test_inspect_without_ffprobe_runs_ffmpeg_i(monkeypatch):
    seen = []

    def fake_run(args, **kw):
        seen.append(args)
        return types.SimpleNamespace(returncode=1, stdout="", stderr=FFMPEG_I_STDERR)

    monkeypatch.setattr(M.subprocess, "run", fake_run)
    info = M.inspect("/tmp/x/source.mkv", M.Tools("/b/ffmpeg", None, "libx265"))
    assert seen == [["/b/ffmpeg", "-hide_banner", "-nostdin", "-i", "/tmp/x/source.mkv"]]
    assert info["probed"] is False


def test_inspect_reports_ffprobe_failure(monkeypatch):
    monkeypatch.setattr(M.subprocess, "run", lambda args, **kw: types.SimpleNamespace(
        returncode=1, stdout="", stderr="x\n/tmp/a: Invalid data found when processing input\n"))
    with pytest.raises(M.MediaError, match="ffprobe exited with 1: /tmp/a: Invalid data found"):
        M.inspect("/tmp/a", X265)


# ---------------------------------------------------------------- ffmpeg commands

def test_transcode_command_crop():
    info = M.video_info(probed(w=1920, h=1080))
    assert M.ffmpeg_args("in.mkv", "out.mp4", info, "transcode", "crop", X265) == [
        "/usr/bin/ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-i", "in.mkv",
        "-map", "0:0", "-map_metadata", "-1",
        "-vf", "scale=2240:1080:force_original_aspect_ratio=increase:flags=lanczos,crop=2240:1080,setsar=1",
        "-fpsmax", "60",
        "-c:v", "libx265", "-preset", "medium", "-crf", "24", "-maxrate", "8M", "-bufsize", "16M",
        "-x265-params", "log-level=error", "-pix_fmt", "yuv420p",
        "-tag:v", "hvc1", "-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-f", "mp4", "out.mp4"]


def test_transcode_command_pad_and_nvenc():
    info = M.video_info(probed(w=1920, h=1080))
    args = M.ffmpeg_args("in", "out.mp4", info, "transcode", "pad", M.Tools("ffmpeg", None, "hevc_nvenc"))
    vf = args[args.index("-vf") + 1]
    assert vf == ("scale=2240:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,"
                  "pad=2240:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1")
    assert args[args.index("-c:v") + 1] == "hevc_nvenc"
    assert args[args.index("-maxrate") + 1] == "7M"
    assert args[args.index("-pix_fmt") + 1] == "yuv420p"
    assert args[args.index("-tag:v") + 1] == "hvc1"


def test_non_square_pixels_are_squared_before_scaling():
    info = M.video_info(probed(w=720, h=576, sample_aspect_ratio="16:15"))
    assert M.video_filter(info, "crop").startswith("scale=trunc(iw*sar/2)*2:ih,setsar=1,scale=2240:1080:")


def test_unprobed_input_maps_first_video_stream_and_squares_pixels():
    args = M.ffmpeg_args("in", "out.mp4", M.ffmpeg_info(FFMPEG_I_STDERR), "transcode", "crop", X265)
    assert args[args.index("-map") + 1] == "0:v:0"
    assert args[args.index("-vf") + 1].startswith("scale=trunc(iw*sar/2)*2:ih,setsar=1,")


def test_remux_command_copies_the_stream_and_fixes_the_tag():
    info = M.video_info(probed("hevc", "hev1", 2240, 1080, extra=[AUDIO]))
    args = M.ffmpeg_args("in.mov", "out.mp4", info, "remux", "crop", X265)
    assert args[args.index("-c:v") + 1] == "copy"
    assert args[args.index("-tag:v") + 1] == "hvc1"
    assert args[args.index("-map") + 1] == "0:0"
    assert "-vf" not in args


def test_bad_fit_is_rejected():
    with pytest.raises(ValueError):
        M.video_filter(M.video_info(probed()), "stretch")


# ---------------------------------------------------------------- progress

def test_progress_blocks():
    p = M.Progress(10.0)
    assert p.feed("frame=30") is None
    assert p.feed("out_time_us=2500000") is None
    assert p.feed("speed=2.5x") is None
    assert p.feed("progress=continue") == (0.25, "2.5x")
    for line in ("out_time_us=N/A", "speed=N/A"):
        p.feed(line)
    assert p.feed("progress=continue") == (None, None)
    p.feed("out_time_us=99000000")
    assert p.feed("progress=continue")[0] == 1.0
    assert p.feed("progress=end")[0] == 1.0


def test_progress_without_duration():
    p = M.Progress(None)
    p.feed("out_time_us=1000000")
    assert p.feed("progress=continue") == (None, None)


# ---------------------------------------------------------------- device names

def test_device_name():
    now = time.mktime((2026, 10, 23, 18, 7, 49, 0, 0, -1)) + 0.639
    assert M.device_name("My Holiday (1).MOV", now) == "2026-10-23_18-07-49-639_My-Holiday-1.mp4"
    assert M.device_name("", now) == "2026-10-23_18-07-49-639.mp4"
    assert M.device_name("ŻÓŁW.mkv", now) == "2026-10-23_18-07-49-639_W.mp4"
    assert M.device_name("żółć.mkv", now) == "2026-10-23_18-07-49-639.mp4"
    long = M.device_name("a" * 100 + ".mp4", now)
    assert long == "2026-10-23_18-07-49-639_" + "a" * M.STEM_MAX + ".mp4"
    assert not M.device_name("RYUO_IV_HW_Info_01.mp4", now).startswith("RYUO")


# ---------------------------------------------------------------- running tools

def test_run_reports_exit_code_and_last_stderr_line():
    script = "import sys; print('out'); sys.stderr.write('first\\nboom: bad input\\n\\n'); sys.exit(3)"
    lines = []
    with pytest.raises(M.MediaError, match=r"^ffmpeg exited with 3: boom: bad input$"):
        M.run([sys.executable, "-c", script], lines.append, name="ffmpeg")
    assert lines == ["out"]


def test_run_missing_binary():
    with pytest.raises(M.MediaError, match="No such file"):
        M.run(["/nonexistent/ffmpeg"])


def test_cancel_kills_the_tool():
    cancel = M.Cancel()
    t0 = time.monotonic()
    threading.Timer(0.3, cancel.cancel).start()
    with pytest.raises(M.Cancelled):
        M.run([sys.executable, "-c", "import time; print('x', flush=True); time.sleep(30)"], cancel=cancel)
    assert time.monotonic() - t0 < 5


# ---------------------------------------------------------------- binary lookup

def which_from(table):
    return lambda name: table.get(name)


@pytest.fixture
def no_nvenc_probe(monkeypatch):
    monkeypatch.setattr(M, "nvenc_works", lambda ffmpeg: False)


def test_resolve_prefers_path_binaries(monkeypatch, no_nvenc_probe):
    monkeypatch.setattr(M.shutil, "which", which_from({"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe"}))
    monkeypatch.setattr(M, "bundled_ffmpeg", lambda: pytest.fail("bundled ffmpeg looked up although PATH has one"))
    assert M.resolve().describe() == {"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe", "encoder": "libx265"}


def test_resolve_falls_back_to_imageio_ffmpeg(monkeypatch, no_nvenc_probe):
    monkeypatch.setattr(M.shutil, "which", which_from({}))
    monkeypatch.setattr(M, "bundled_ffmpeg", lambda: "/venv/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v7.0.2")
    t = M.resolve()
    assert t.ffmpeg.endswith("ffmpeg-linux-x86_64-v7.0.2")
    assert t.ffprobe is None


def test_resolve_without_any_ffmpeg(monkeypatch, no_nvenc_probe):
    monkeypatch.setattr(M.shutil, "which", which_from({"ffprobe": "/usr/bin/ffprobe"}))
    monkeypatch.setattr(M, "bundled_ffmpeg", lambda: None)
    with pytest.raises(M.MediaError, match="no ffmpeg"):
        M.resolve()


def test_bundled_ffmpeg_without_the_package(monkeypatch):
    monkeypatch.setitem(sys.modules, "imageio_ffmpeg", None)  # makes the import raise ImportError
    assert M.bundled_ffmpeg() is None


def test_tools_resolves_once(monkeypatch):
    calls = []
    monkeypatch.setattr(M, "_tools", None)
    monkeypatch.setattr(M, "resolve", lambda: calls.append(1) or X265)
    assert M.tools() is M.tools() is X265
    assert calls == [1]


@pytest.mark.parametrize("listed, encode_rc, want", [
    (" V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)\n", 0, "hevc_nvenc"),
    (" V....D libx265              libx265 H.265 / HEVC (codec hevc)\n", 0, "libx265"),
    (" V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)\n", 1, "libx265"),  # no GPU/driver
])
def test_encoder_detection(monkeypatch, listed, encode_rc, want):
    def fake_run(args, **kw):
        if "-encoders" in args:
            return types.SimpleNamespace(returncode=0, stdout=listed, stderr="")
        return types.SimpleNamespace(returncode=encode_rc, stdout="", stderr="")

    monkeypatch.setattr(M.subprocess, "run", fake_run)
    monkeypatch.setattr(M.shutil, "which", which_from({"ffmpeg": "/usr/bin/ffmpeg"}))
    assert M.resolve().encoder == want


# ---------------------------------------------------------------- real ffmpeg runs

def make_clip(ffmpeg, path, size, seconds, *extra):
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
                    "-i", f"testsrc2=size={size}:rate=30:duration={seconds}", *extra, path], check=True)


def ffprobe_json(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


needs_system = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
                                  reason="system ffmpeg and ffprobe needed")


@needs_system
def test_real_remux_drops_audio_and_keeps_the_stream(tmp_path):
    src, dst = str(tmp_path / "in.mkv"), str(tmp_path / "out.mp4")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                    "testsrc2=size=1920x926:rate=30:duration=1", "-f", "lavfi", "-i", "sine=duration=1",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src], check=True)
    t = M.Tools("ffmpeg", "ffprobe", "libx265")
    info = M.inspect(src, t)
    assert M.plan(info)[0] == "remux"
    M.convert(src, dst, info, "remux", "crop", t)
    out = ffprobe_json(dst)
    assert [(s["codec_name"], s["codec_tag_string"]) for s in out["streams"]] == [("h264", "avc1")]
    assert M.plan(M.video_info(out))[0] == "copy"


def test_real_transcode_with_imageio_ffmpeg_and_libx265(tmp_path):
    """The fallback binary end to end: no ffprobe for the probe, libx265 for the encode.
    The result is checked with the system ffprobe."""
    imageio_ffmpeg = pytest.importorskip("imageio_ffmpeg")
    if not shutil.which("ffprobe"):
        pytest.skip("system ffprobe needed to check the result")
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    src, dst = str(tmp_path / "in.mp4"), str(tmp_path / "out.mp4")
    make_clip(exe, src, "1920x1080", 5, "-pix_fmt", "yuv420p10le", "-c:v", "libx264")
    t = M.Tools(exe, None, "libx265")
    info = M.inspect(src, t)
    assert M.plan(info)[0] == "transcode"
    seen = []
    t0 = time.monotonic()
    M.convert(src, dst, info, "transcode", "crop", t, lambda done, speed: seen.append(done))
    elapsed = time.monotonic() - t0
    print(f"\nimageio-ffmpeg libx265: 5 s of 1920x1080 30 fps -> 2240x1080 in {elapsed:.1f} s")
    assert seen and seen[-1] == 1.0
    out = ffprobe_json(dst)
    (v,) = out["streams"]
    assert (v["codec_name"], v["codec_tag_string"], v["width"], v["height"], v["pix_fmt"], v["profile"]) == \
        ("hevc", "hvc1", 2240, 1080, "yuv420p", "Main")
    assert float(out["format"]["duration"]) == pytest.approx(5, abs=0.1)
    assert int(out["format"]["bit_rate"]) < 8_500_000
    assert M.plan(M.video_info(out))[0] == "copy"
