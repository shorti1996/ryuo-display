"""POST /api/media/upload end to end through ryuod's real HTTP handler, with a stub device worker
and a fake adb that "pushes" into a directory under tmp_path. No hidraw, adb, pidfile or port 8746.
"""
import concurrent.futures
import http.client
import json
import os
import shutil
import subprocess
import sys
import textwrap
import threading
import time

import pytest

import ryuo_media as M
import ryuod

FAKE_ADB = textwrap.dedent("""\
    import os, shutil, sys
    root = os.environ["FAKE_ADB_ROOT"]
    with open(os.path.join(root, "log"), "a") as f:
        f.write(" ".join(sys.argv[1:]) + "\\n")
    if sys.argv[1] == "push":
        if os.path.exists(os.path.join(root, "fail")):
            sys.stderr.write("adb: error: failed to copy: remote No space left on device\\n")
            sys.exit(1)
        dst = os.path.join(root, "device", sys.argv[3].lstrip("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(sys.argv[2], dst)
        print("1 file pushed")
    elif sys.argv[1:4] == ["shell", "rm", "-f"]:
        p = os.path.join(root, "device", sys.argv[4].lstrip("/"))
        if os.path.exists(p):
            os.remove(p)
""")

# ffmpeg stand-in for the cancel test: `-i FILE` alone prints a banner, a conversion reports
# progress once and then hangs until killed.
FAKE_FFMPEG = textwrap.dedent("""\
    import sys, time
    if "-progress" not in sys.argv:
        sys.stderr.write("Input #0, matroska,webm, from 'x':\\n  Duration: 00:00:10.00, start: 0\\n"
                         "  Stream #0:0: Video: h264, yuv420p, 1920x1080\\n")
        sys.exit(1)
    print("out_time_us=2500000\\nspeed=1.5x\\nprogress=continue", flush=True)
    time.sleep(60)
""")


class FakeDevice:
    def __init__(self):
        self.media = {"source": "conn", "fetchedAt": 0, "preset": ["RYUO_IV_HW_Info_01.mp4"], "custom": []}
        self.sent = []
        self.last_hb_bytes = None

    def submit(self, method, cmd, body, wait=0.25):
        self.sent.append((method, cmd, body))
        fut = concurrent.futures.Future()
        fut.set_result({"applied": True, "acked": True})
        return fut

    def status(self):
        return {"connected": True}


@pytest.fixture
def daemon(tmp_path, monkeypatch):
    adb_root = tmp_path / "adb"
    adb_root.mkdir()
    (tmp_path / "fake_adb_tool.py").write_text(FAKE_ADB)
    monkeypatch.setenv("FAKE_ADB_ROOT", str(adb_root))
    monkeypatch.setattr(M, "ADB", [sys.executable, str(tmp_path / "fake_adb_tool.py")])
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        monkeypatch.setattr(M, "_tools", M.Tools(shutil.which("ffmpeg"), shutil.which("ffprobe"), "libx265"))
    d = ryuod.Daemon()
    d.upload_dir = str(tmp_path / "cache" / "upload")
    d.upload_lock = threading.Lock()
    d.state = ryuod.State(str(tmp_path / "state.json"))
    d.device = FakeDevice()
    d.adb_root = adb_root
    httpd = ryuod.Server(("127.0.0.1", 0), ryuod.Handler)
    httpd.daemon_ref = d
    threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    d.port = httpd.server_address[1]
    yield d
    if d.upload is not None and d.upload.is_alive():
        d.upload.cancel()
        d.upload.join(5)
    httpd.shutdown()
    httpd.server_close()


def request(d, method, path, body=b"", headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", d.port, timeout=30)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        r = conn.getresponse()
        return r.status, json.loads(r.read() or b"null")
    finally:
        conn.close()


def upload(d, data, filename="clip.mkv", fit="crop", ctype="application/octet-stream"):
    return request(d, "POST", f"/api/media/upload?fit={fit}", data,
                   {"Content-Type": ctype, "X-Filename": filename})


def wait_done(d, timeout=60):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        _, j = request(d, "GET", "/api/state")
        if j["upload"]["state"] in ("done", "error", "cancelled"):
            return j["upload"]
        time.sleep(0.1)
    pytest.fail(f"upload still {j['upload']} after {timeout} s")


def make_clip(path, size, seconds=1, *extra):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    f"testsrc2=size={size}:rate=30:duration={seconds}", *extra, str(path)], check=True)
    return path.read_bytes()


needs_ffmpeg = pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")),
                                  reason="system ffmpeg and ffprobe needed")


@needs_ffmpeg
def test_compatible_file_is_pushed_unchanged_and_played(daemon, tmp_path):
    data = make_clip(tmp_path / "asus.mp4", "1920x926", 1, "-c:v", "libx264", "-pix_fmt", "yuv420p")
    status, j = upload(daemon, data, "asus.mp4")
    assert status == 202, j
    u = wait_done(daemon)
    assert (u["state"], u["action"], u["applied"], u["acked"]) == ("done", "copy", True, True), u
    name = u["name"]
    assert name.endswith("_asus.mp4")
    assert (daemon.adb_root / "device/sdcard/pcMedia" / name).read_bytes() == data
    method, cmd, cfg = daemon.device.sent[-1]
    assert (method, cmd, cfg["media"], cfg["playMode"]) == ("POST", "waterBlockScreenId", [name], "Single")
    assert daemon.state.get()["media"] == [name]
    assert name in daemon.device.media["custom"]
    assert os.listdir(daemon.upload_dir) == []  # job files removed


@needs_ffmpeg
def test_16_9_h264_is_transcoded_to_full_panel_hevc(daemon, tmp_path):
    data = make_clip(tmp_path / "wide.mkv", "1920x1080", 2, "-c:v", "libx264", "-pix_fmt", "yuv420p10le")
    status, _ = upload(daemon, data, "wide.mkv", fit="pad")
    assert status == 202
    u = wait_done(daemon)
    assert (u["state"], u["action"], u["encoder"]) == ("done", "transcode", "libx265"), u
    assert "aspect ratio 1.78:1" in u["reason"] and "pixel format yuv420p10le" in u["reason"]
    pushed = str(daemon.adb_root / "device/sdcard/pcMedia" / u["name"])
    info = M.video_info(json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", pushed],
        capture_output=True, text=True, check=True).stdout))
    assert (info["codec"], info["tag"], info["width"], info["height"], info["pix_fmt"]) == \
        ("hevc", "hvc1", 2240, 1080, "yuv420p")


@needs_ffmpeg
def test_unreadable_file_reports_the_ffprobe_error(daemon):
    status, _ = upload(daemon, os.urandom(4096), "junk.mp4")
    assert status == 202
    u = wait_done(daemon)
    assert u["state"] == "error"
    assert u["error"].startswith("ffprobe exited with 1: ")
    assert daemon.device.sent == []


@needs_ffmpeg
def test_failed_push_reports_adb_error_and_removes_partial_file(daemon, tmp_path):
    (daemon.adb_root / "fail").touch()
    data = make_clip(tmp_path / "asus.mp4", "1920x926", 1, "-c:v", "libx264", "-pix_fmt", "yuv420p")
    upload(daemon, data, "asus.mp4")
    u = wait_done(daemon)
    assert u["state"] == "error"
    assert u["error"] == "adb push exited with 1: adb: error: failed to copy: remote No space left on device"
    log = (daemon.adb_root / "log").read_text().splitlines()
    assert log[-1] == f"shell rm -f /sdcard/pcMedia/{u['name']}"
    assert daemon.device.sent == []


def test_cancel_during_conversion_without_ffprobe(daemon, tmp_path, monkeypatch):
    (tmp_path / "fake_ffmpeg_tool.py").write_text(FAKE_FFMPEG)
    fake = tmp_path / "ffmpeg-wrapper"
    fake.write_text(f"#!/bin/sh\nexec {sys.executable} {tmp_path / 'fake_ffmpeg_tool.py'} \"$@\"\n")
    fake.chmod(0o755)
    monkeypatch.setattr(M, "_tools", M.Tools(str(fake), None, "libx265"))
    assert upload(daemon, b"\0" * 1000, "x.mkv")[0] == 202
    end = time.monotonic() + 10
    while (u := request(daemon, "GET", "/api/state")[1]["upload"])["progress"] != 0.25:
        assert time.monotonic() < end, u
        time.sleep(0.05)
    assert (u["state"], u["action"], u["speed"]) == ("converting", "transcode", "1.5x")
    assert u["reason"] == "no ffprobe to check the file, so it is converted"
    status, j = request(daemon, "POST", "/api/media/upload/cancel", b"{}", {"Content-Type": "application/json"})
    assert status == 200, j
    assert wait_done(daemon, 10)["state"] == "cancelled"
    assert not (daemon.adb_root / "log").exists()  # never reached adb


def test_request_hygiene(daemon, monkeypatch):
    assert upload(daemon, b"{}", ctype="application/json")[0] == 415
    assert upload(daemon, b"x", fit="stretch")[0] == 400
    monkeypatch.setattr(ryuod, "MAX_UPLOAD", 10)
    assert upload(daemon, b"x" * 11)[0] == 413
    status, _ = request(daemon, "POST", "/api/media/upload", b"x",
                        {"Content-Type": "application/octet-stream", "Host": "evil.example"})
    assert status == 403
    status, j = request(daemon, "POST", "/api/media/upload/cancel", b"{}", {"Content-Type": "application/json"})
    assert (status, j["error"]) == (409, "no upload in progress")
    _, j = request(daemon, "GET", "/api/state")
    assert j["upload"] is None


def test_second_upload_while_one_runs_is_refused(daemon):
    class Busy:
        finished = False

        def snapshot(self):
            return {"state": "converting"}

    daemon.upload = Busy()
    status, j = upload(daemon, b"x" * 100)
    assert (status, j["error"]) == (409, "another video is still being processed")
    daemon.upload = None


def test_body_shorter_than_content_length_fails_the_job(daemon):
    conn = http.client.HTTPConnection("127.0.0.1", daemon.port, timeout=10)
    conn.putrequest("POST", "/api/media/upload")
    conn.putheader("Content-Type", "application/octet-stream")
    conn.putheader("Content-Length", "1000")
    conn.endheaders()
    conn.send(b"x" * 10)
    conn.sock.shutdown(1)  # half-close: the server sees end of body after 10 bytes
    r = conn.getresponse()
    assert r.status == 400
    assert "connection closed after 10 of 1000 bytes" in json.loads(r.read())["error"]
    conn.close()
    _, j = request(daemon, "GET", "/api/state")
    assert j["upload"]["state"] == "error"
    assert os.listdir(daemon.upload_dir) == []
