"""Deleting and previewing files in /sdcard/pcMedia through ryuod's HTTP API.

The device worker is faked at Device.submit() (fakes.FakeDevice), and adb is a script that works
on a directory under tmp_path: `pull` copies out of it, `shell rm -f` and `shell ls` act on it.
Thumbnails and proxies are made by real ffmpeg runs, skipped when the binary is missing.
"""
import http.client
import json
import os
import shutil
import struct
import subprocess
import sys
import textwrap
import threading
import time

import pytest
from fakes import CUSTOM, PRESET, FakeDevice

import ryuo_media as M
import ryuo_proto as P
import ryuod

# Looked up before any test replaces shutil.which.
FFPROBE = shutil.which("ffprobe")

FAKE_ADB = textwrap.dedent("""\
    import os, shlex, shutil, sys, time
    root = os.environ["FAKE_ADB_ROOT"]
    with open(os.path.join(root, "log"), "a") as f:
        f.write(" ".join(sys.argv[1:]) + "\\n")
    if os.path.exists(os.path.join(root, "offline")):
        sys.stderr.write("adb: no devices/emulators found\\n")
        sys.exit(1)
    def dev(path):
        return os.path.join(root, "device", path.lstrip("/"))
    if sys.argv[1] == "pull":
        if os.path.exists(os.path.join(root, "slow")):
            time.sleep(1.5)
        if not os.path.exists(dev(sys.argv[2])):
            sys.stderr.write(f"adb: error: failed to stat remote object '{sys.argv[2]}': No such file or directory\\n")
            sys.exit(1)
        shutil.copyfile(dev(sys.argv[2]), sys.argv[3])
        print("1 file pulled")
    elif sys.argv[1] == "shell":
        words = shlex.split(sys.argv[2])
        if words[:2] == ["rm", "-f"]:
            for p in words[2:]:
                if os.path.exists(dev(p)):
                    os.remove(dev(p))
        elif words[:2] == ["ls", "-1"]:
            for d in words[2:]:
                print(d + ":")
                for n in sorted(os.listdir(dev(d))):
                    print(n)
                print()
        elif words[:2] == ["ls", "-l"]:
            d = dev(words[2])
            print(f"total {len(os.listdir(d))}")
            for n in sorted(os.listdir(d)):
                print(f"-rw-rw---- 1 u0_a0 media_rw {os.path.getsize(os.path.join(d, n))} 2026-10-23 18:07 {n}")
""")


class Api:
    def __init__(self, d, port):
        self.d, self.port = d, port

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        hdrs = dict(headers or {})
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        try:
            conn.request(method, path, body=data, headers=hdrs)
            r = conn.getresponse()
            payload = r.read()
            out = json.loads(payload) if r.getheader("Content-Type", "").startswith("application/json") else payload
            return r.status, r, out
        finally:
            conn.close()

    def delete(self, names):
        return self.request("POST", "/api/media/delete", {"names": names})

    def adb_log(self):
        p = self.d.adb_root / "log"
        return p.read_text().splitlines() if p.exists() else []


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "local_timezone", lambda: "Europe/Warsaw")
    adb_root = tmp_path / "adb"
    for sub in ("pcMedia", "pcMediaPreset"):
        (adb_root / "device" / "sdcard" / sub).mkdir(parents=True)
    for name in PRESET:
        (adb_root / "device/sdcard/pcMediaPreset" / name).write_bytes(b"preset")
    for i, name in enumerate(CUSTOM):
        (adb_root / "device/sdcard/pcMedia" / name).write_bytes(bytes(range(256)) * (i + 1))
    (tmp_path / "fake_adb_tool.py").write_text(FAKE_ADB)
    monkeypatch.setenv("FAKE_ADB_ROOT", str(adb_root))
    monkeypatch.setattr(M, "ADB", [sys.executable, str(tmp_path / "fake_adb_tool.py")])
    d = ryuod.Daemon()
    d.adb_root = adb_root
    d.media_lock = threading.Lock()
    d.preview = ryuod.Previews(str(tmp_path / "preview"))
    d.state = ryuod.State(str(tmp_path / "state.json"))
    d.state.update({"media": [PRESET[1]]})
    d.sampler = ryuod.Sampler(d.state)  # never started
    d.device = FakeDevice(d.state, d.sampler)
    d.device.conn_media = {"preset": list(PRESET), "custom": list(CUSTOM)}
    httpd = ryuod.Server(("127.0.0.1", 0), ryuod.Handler)
    httpd.daemon_ref = d
    t = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    try:
        yield Api(d, httpd.server_address[1])
    finally:
        httpd.shutdown()
        httpd.server_close()
        t.join(2)
        d.device.close_pipe()


def on_device(api, name):
    return (api.d.adb_root / "device/sdcard/pcMedia" / name).exists()


# ---------------------------------------------------------------- delete: playlist and media list

def test_deleting_the_only_playlist_entry_plays_the_first_preset(api):
    api.d.state.update({"media": [CUSTOM[0]], "playMode": "Single"})
    status, _, body = api.delete([CUSTOM[0]])
    assert status == 200, body
    assert body["deleted"] == [CUSTOM[0]] and body["remaining"] == []
    st = api.d.state.get()
    assert st["media"] == ["RYUO_IV_HW_Info_01.mp4"]
    sent = api.d.device.sent
    assert sent[0] == ("POST", "mediaDelete", {"include": [CUSTOM[0]]})
    method, cmd, cfg = sent[-1]
    assert (method, cmd) == ("POST", "waterBlockScreenId")
    assert cfg == ryuod.config_for(st)
    assert cfg["media"] == ["RYUO_IV_HW_Info_01.mp4"]
    assert body["sent"] == ["POST mediaDelete", "POST waterBlockScreenId"]
    assert body["restartsVideo"] is True
    assert body["config"]["media"] == ["RYUO_IV_HW_Info_01.mp4"]
    with open(api.d.state.path) as f:
        assert json.load(f)["media"] == ["RYUO_IV_HW_Info_01.mp4"]


def test_delete_keeps_the_rest_of_the_playlist_and_its_mode(api):
    api.d.state.update({"media": [CUSTOM[0], PRESET[1], CUSTOM[1]], "playMode": "Cycle"})
    status, _, body = api.delete([CUSTOM[0], CUSTOM[1]])
    assert status == 200
    assert api.d.state.get()["media"] == [PRESET[1]]
    cfg = api.d.device.sent[-1][2]
    assert (cfg["media"], cfg["playMode"]) == ([PRESET[1]], "Cycle")
    assert body["config"]["media"] == [PRESET[1]]


def test_delete_outside_the_playlist_leaves_the_video_alone(api):
    status, _, body = api.delete([CUSTOM[1]])
    assert status == 200
    assert [c for _, c, _ in api.d.device.sent] == ["mediaDelete", "conn"]
    assert body["restartsVideo"] is False
    assert body["sent"] == ["POST mediaDelete"]
    assert api.d.state.get()["media"] == [PRESET[1]]


def test_deleted_name_leaves_the_media_list_and_cannot_be_played(api):
    api.d.device.media["sizes"] = {CUSTOM[0]: 256, CUSTOM[1]: 512}
    status, _, body = api.delete([CUSTOM[0]])
    assert status == 200
    assert body["listedBy"] == "conn"
    assert body["media"]["custom"] == [CUSTOM[1]]
    assert body["media"]["sizes"] == {CUSTOM[1]: 512}
    _, _, listed = api.request("GET", "/api/media")
    assert listed["custom"] == [CUSTOM[1]]
    status, _, refused = api.request("POST", "/api/media/select", {"media": [CUSTOM[0]]})
    assert status == 400 and "not in the device media list" in refused["error"]


def test_mediadelete_names_files_with_include_and_each_body_fits_one_report(api):
    names = [f"2026-10-23_18-07-{i:02d}-639_" + "a" * 60 + ".mp4" for i in range(30)]
    api.d.device.media["custom"] = list(names)
    api.d.device.conn_media = {"preset": list(PRESET), "custom": list(names)}
    status, _, body = api.delete(names)
    assert status == 200
    bodies = [b for _, c, b in api.d.device.sent if c == "mediaDelete"]
    assert len(bodies) > 1
    for b in bodies:
        assert set(b) == {"include"}  # exclude would delete every file it does not name
        assert P.fits("POST", "mediaDelete", b)
    assert [n for b in bodies for n in b["include"]] == names
    assert body["deleted"] == names


def test_delete_drops_the_preview_cache_entry(api):
    entry = api.d.adb_root.parent / "preview" / CUSTOM[0]
    entry.mkdir(parents=True)
    (entry / "thumb.jpg").write_bytes(b"x")
    assert api.delete([CUSTOM[0]])[0] == 200
    assert not entry.exists()


# ---------------------------------------------------------------- delete: adb fallback

def test_disconnected_cooler_deletes_with_adb_rm(api):
    api.d.device.connected = False
    api.d.state.update({"media": [CUSTOM[0]]})
    status, _, body = api.delete([CUSTOM[0]])
    assert status == 200, body
    assert not on_device(api, CUSTOM[0]) and on_device(api, CUSTOM[1])
    assert f"shell rm -f {P.MEDIA_DIR}{CUSTOM[0]}" in api.adb_log()
    assert body["sent"] == ["adb shell rm", "POST waterBlockScreenId"]
    assert body["listedBy"] == "adb"
    assert body["media"]["custom"] == [CUSTOM[1]]
    # Saved; the startup sequence sends it once the cooler is back.
    assert (body["applied"], body["config"]["media"]) == (False, ["RYUO_IV_HW_Info_01.mp4"])


def test_stale_conn_list_is_checked_with_adb(api):
    api.d.device.deletes = False  # acked, but the next conn reply still lists the file
    status, _, body = api.delete([CUSTOM[0]])
    assert status == 200
    assert body["sent"] == ["POST mediaDelete", "adb shell rm"]
    assert body["listedBy"] == "adb"
    assert body["deleted"] == [CUSTOM[0]]
    assert not on_device(api, CUSTOM[0])


def test_name_still_listed_without_adb_is_reported_and_kept(api):
    api.d.device.deletes = False
    (api.d.adb_root / "offline").touch()
    status, _, body = api.delete([CUSTOM[0]])
    assert status == 200
    assert (body["deleted"], body["remaining"]) == ([], [CUSTOM[0]])
    assert CUSTOM[0] in api.d.device.media["custom"]


def test_no_way_to_the_panel_is_503_and_changes_nothing(api):
    api.d.device.connected = False
    (api.d.adb_root / "offline").touch()
    api.d.state.update({"media": [CUSTOM[0]]})
    status, _, body = api.delete([CUSTOM[0]])
    assert status == 503
    assert "adb rm exited with 1: adb: no devices/emulators found" in body["error"]
    assert api.d.state.get()["media"] == [CUSTOM[0]]
    assert api.d.device.media["custom"] == CUSTOM


def test_adb_delete_quotes_names_for_the_device_shell(api):
    name = "clip with spaces; rm -rf x.mp4"
    (api.d.adb_root / "device/sdcard/pcMedia" / name).write_bytes(b"x")
    assert ryuod.adb_delete([name]) is None
    assert not on_device(api, name)


# ---------------------------------------------------------------- delete: validation

@pytest.mark.parametrize("names, msg", [
    ([PRESET[0]], "is a preset"),
    (["../pcMediaPreset/" + PRESET[0]], "not a bare file name"),
    (["sub/" + CUSTOM[0]], "not a bare file name"),
    (["..\\x.mp4"], "not a bare file name"),
    ([".."], "not a bare file name"),
    (["not-on-device.mp4"], "not in /sdcard/pcMedia"),
    ([CUSTOM[0], "not-on-device.mp4"], "not in /sdcard/pcMedia"),
    ([], "names must be a list"),
    (CUSTOM[0], "names must be a list"),
    ([1], "names must be a list"),
    (None, "names must be a list"),
])
def test_delete_refuses(api, names, msg):
    api.d.state.update({"media": [CUSTOM[0]]})
    status, _, body = api.delete(names)
    assert status == 400
    assert msg in body["error"]
    assert api.d.device.sent == []
    assert api.adb_log() == []
    assert api.d.state.get()["media"] == [CUSTOM[0]]
    assert on_device(api, CUSTOM[0])


@pytest.mark.parametrize("method", ["DELETE", "OPTIONS"])
def test_delete_and_options_methods_stay_405(api, method):
    status, r, body = api.request(method, "/api/media/delete", headers={"Origin": "http://evil.example"})
    assert status == 405
    assert r.getheader("Access-Control-Allow-Origin") is None
    assert body["ok"] is False
    assert api.d.device.sent == []


def test_delete_needs_a_json_body(api):
    conn = http.client.HTTPConnection("127.0.0.1", api.port, timeout=5)
    conn.request("POST", "/api/media/delete", body=json.dumps({"names": [CUSTOM[0]]}),
                 headers={"Content-Type": "text/plain"})
    assert conn.getresponse().status == 415
    conn.close()
    assert api.d.device.sent == []


def test_delete_body_helpers():
    assert ryuod.delete_bodies(["a.mp4", "b.mp4"]) == [{"include": ["a.mp4", "b.mp4"]}]
    assert ryuod.bare_name("2026-01-26_22-07-49-639.mp4")
    assert not any(ryuod.bare_name(n) for n in ("", ".", "..", "a/b", "a\\b", "a\0b"))


# ---------------------------------------------------------------- sizes

def test_get_media_fills_sizes_from_adb(api):
    _, _, body = api.request("GET", "/api/media")
    assert body["sizes"] == {CUSTOM[0]: 256, CUSTOM[1]: 512}
    # Known sizes survive a refresh through conn, which lists names only.
    (api.d.adb_root / "offline").touch()
    _, _, body = api.request("GET", "/api/media?refresh=1")
    assert body["source"] == "conn"
    assert body["sizes"] == {CUSTOM[0]: 256, CUSTOM[1]: 512}


def test_adb_sizes_matches_names_whatever_the_date_format(monkeypatch):
    out = ("total 3\n"
           "drwxrwx--x 2 root sdcard_rw 3488 2026-10-23 18:07 sub\n"
           "-rw-rw---- 1 root sdcard_rw 98123456 Jan 26 22:07 2026-01-26_22-07-49-639.mp4\n"
           "-rw-rw---- 1 root sdcard_rw 12 2026-10-23 18:07 a b.mp4\n"
           "-rw-rw---- 1 root sdcard_rw 34 2026-10-23 18:07 b.mp4\n")
    monkeypatch.setattr(ryuod.subprocess, "run",
                        lambda argv, **kw: ryuod.subprocess.CompletedProcess(argv, 0, stdout=out, stderr=""))
    assert ryuod.adb_sizes(["2026-01-26_22-07-49-639.mp4", "b.mp4", "a b.mp4", "sub"]) == {
        "2026-01-26_22-07-49-639.mp4": 98123456, "a b.mp4": 12, "b.mp4": 34}


# ---------------------------------------------------------------- serving: Range

@pytest.mark.parametrize("header, want", [
    (None, None),
    ("bytes=0-9", (0, 9)),
    ("bytes=10-", (10, 99)),
    ("bytes=-5", (95, 99)),
    ("bytes=-500", (0, 99)),
    ("bytes=90-1000", (90, 99)),
    ("bytes=100-", False),
    ("bytes=-0", False),
    ("bytes=9-3", None),
    ("bytes=0-1,4-5", None),
    ("items=0-9", None),
    ("bytes=-", None),
])
def test_byte_range(header, want):
    assert ryuod.byte_range(header, 100) == want


def test_preview_honours_range_requests(api):
    png = api.d.adb_root / "device/sdcard/pcMedia" / CUSTOM[1]
    data = png.read_bytes()
    size = len(data)
    url = f"/api/media/preview?name={CUSTOM[1]}"
    status, r, body = api.request("GET", url)
    assert (status, body) == (200, data)
    assert (r.getheader("Content-Type"), r.getheader("Accept-Ranges")) == ("image/png", "bytes")
    status, r, body = api.request("GET", url, headers={"Range": "bytes=0-9"})
    assert (status, body) == (206, data[:10])
    assert r.getheader("Content-Range") == f"bytes 0-9/{size}"
    assert r.getheader("Content-Length") == "10"
    status, r, body = api.request("GET", url, headers={"Range": "bytes=100-"})
    assert (status, body, r.getheader("Content-Range")) == (206, data[100:], f"bytes 100-{size - 1}/{size}")
    status, _, body = api.request("GET", url, headers={"Range": "bytes=-7"})
    assert (status, body) == (206, data[-7:])
    status, r, body = api.request("GET", url, headers={"Range": f"bytes={size}-"})
    assert status == 416
    assert r.getheader("Content-Range") == f"bytes */{size}"
    assert body["ok"] is False


def test_range_requests_on_one_keep_alive_connection(api):
    """A <video> seeks by sending range after range on the same connection."""
    url = f"/api/media/preview?name={CUSTOM[1]}"
    data = (api.d.adb_root / "device/sdcard/pcMedia" / CUSTOM[1]).read_bytes()
    conn = http.client.HTTPConnection("127.0.0.1", api.port, timeout=10)
    try:
        for a, b in ((0, 1), (200, 299), (5, 5)):
            conn.request("GET", url, headers={"Range": f"bytes={a}-{b}"})
            r = conn.getresponse()
            assert (r.status, r.read()) == (206, data[a:b + 1])
    finally:
        conn.close()


# ---------------------------------------------------------------- serving: which files

@pytest.mark.parametrize("name", [PRESET[0], "../pcMediaPreset/" + PRESET[0], "not-on-device.mp4", ""])
def test_thumb_and_preview_only_serve_custom_files(api, name):
    for kind in ("thumb", "preview"):
        status, _, body = api.request("GET", f"/api/media/{kind}?name={name}")
        assert status == 404
        assert body["ok"] is False
    assert api.adb_log() == []


def test_other_sites_cannot_load_previews(api):
    status, _, body = api.request("GET", f"/api/media/thumb?name={CUSTOM[1]}", headers={"Sec-Fetch-Site": "cross-site"})
    assert (status, body["error"]) == (403, "only the ryuod page can load media previews")
    assert api.adb_log() == []
    status, _, _ = api.request("GET", f"/api/media/thumb?name={CUSTOM[1]}", headers={"Sec-Fetch-Site": "same-origin"})
    assert status == 200


def test_file_is_pulled_once(api):
    for _ in range(3):
        assert api.request("GET", f"/api/media/thumb?name={CUSTOM[1]}")[0] == 200
    assert api.request("GET", f"/api/media/preview?name={CUSTOM[1]}")[0] == 200
    assert [x for x in api.adb_log() if x.startswith("pull")] == [f"pull {P.MEDIA_DIR}{CUSTOM[1]} " +
                                                                   str(api.d.adb_root.parent / "preview" / CUSTOM[1] /
                                                                       "source.png.part")]


def test_file_is_pulled_again_when_its_size_changed(api):
    assert api.request("GET", f"/api/media/thumb?name={CUSTOM[1]}")[0] == 200
    (api.d.adb_root / "device/sdcard/pcMedia" / CUSTOM[1]).write_bytes(b"new")
    api.d.device.media["sizes"] = {CUSTOM[1]: 3}
    status, _, body = api.request("GET", f"/api/media/thumb?name={CUSTOM[1]}")
    assert (status, body) == (200, b"new")


def test_failed_pull_is_502_and_leaves_no_entry(api):
    os.remove(api.d.adb_root / "device/sdcard/pcMedia" / CUSTOM[1])
    status, _, body = api.request("GET", f"/api/media/thumb?name={CUSTOM[1]}")
    assert status == 502
    assert body["error"].startswith("adb pull exited with 1: adb: error: failed to stat remote object")
    assert not (api.d.adb_root.parent / "preview" / CUSTOM[1]).exists()


def test_pull_runs_on_the_http_thread_without_device_jobs(api):
    """Previews never queue work for the device worker, so a long pull cannot delay a heartbeat
    (success criterion 6 in docs/003-device-media), and other requests are answered meanwhile."""
    (api.d.adb_root / "slow").touch()
    got = {}
    t = threading.Thread(target=lambda: got.update(r=api.request("GET", f"/api/media/thumb?name={CUSTOM[1]}")))
    t.start()
    time.sleep(0.3)
    t0 = time.monotonic()
    assert api.request("GET", "/api/state")[0] == 200
    assert time.monotonic() - t0 < 1.0
    t.join(10)
    assert got["r"][0] == 200
    assert api.d.device.sent == []


def test_cache_drops_the_least_recently_used_entries_past_its_cap(api, tmp_path):
    pv = ryuod.Previews(str(tmp_path / "small"), cap=1000)
    names = []
    for i in range(3):
        name = f"f{i}.png"
        (api.d.adb_root / "device/sdcard/pcMedia" / name).write_bytes(b"x" * 400)
        names.append(name)
    pv.thumb(names[0], None)
    pv.thumb(names[1], None)
    os.utime(tmp_path / "small" / names[0], (1, 1))  # f0 used longest ago
    os.utime(tmp_path / "small" / names[1], (2, 2))
    pv.thumb(names[2], None)  # 1200 bytes: over the cap
    assert sorted(os.listdir(tmp_path / "small")) == ["f1.png", "f2.png"]


# ---------------------------------------------------------------- thumbnails and proxies, real ffmpeg

def maker():
    """An ffmpeg with libx264 and libx265 to make the test clips: the system one, else imageio's."""
    if shutil.which("ffmpeg"):
        return shutil.which("ffmpeg")
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError):
        return None


@pytest.fixture(scope="module")
def clips(tmp_path_factory):
    exe = maker()
    if exe is None:
        pytest.skip("no ffmpeg to make test clips")
    out = tmp_path_factory.mktemp("clips")
    gen = [exe, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"]
    # An upload the panel got as HEVC, an Armoury Crate style H.264 file, and a still PNG.
    subprocess.run([*gen, "-i", "testsrc2=size=2240x1080:rate=30:duration=2", "-c:v", "libx265",
                    "-x265-params", "log-level=error", "-pix_fmt", "yuv420p", "-tag:v", "hvc1",
                    str(out / "hevc.mp4")], check=True)
    subprocess.run([*gen, "-i", "testsrc2=size=1920x960:rate=30:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", str(out / "h264.mp4")], check=True)
    subprocess.run([*gen, "-i", "testsrc2=size=640x320", "-frames:v", "1", str(out / "still.png")], check=True)
    return out


def jpeg_size(data):
    """(width, height) from a JPEG's SOF marker."""
    assert data[:2] == b"\xff\xd8"
    i = 2
    while i < len(data):
        marker, length = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack(">HH", data[i + 5:i + 9])
            return w, h
        i += 2 + length
    raise AssertionError("no SOF marker")


def which_from(table):
    return lambda name: table.get(name)


@pytest.fixture(params=["system", "imageio"])
def tools(request, monkeypatch):
    """ryuo_media.tools() as resolve() finds it: system ffmpeg and ffprobe on PATH, or only the
    imageio-ffmpeg binary (no ffprobe), as tests/test_media.py sets it up."""
    monkeypatch.setattr(M, "_tools", None)
    monkeypatch.setattr(M, "nvenc_works", lambda ffmpeg: False)
    if request.param == "system":
        if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
            pytest.skip("system ffmpeg and ffprobe needed")
        monkeypatch.setattr(M.shutil, "which", which_from({"ffmpeg": shutil.which("ffmpeg"),
                                                          "ffprobe": shutil.which("ffprobe")}))
    else:
        pytest.importorskip("imageio_ffmpeg")
        monkeypatch.setattr(M.shutil, "which", which_from({}))
    return request.param


def put(api, clips, files):
    """Copy clips onto the fake panel under the given names; they become the custom list."""
    names = []
    for name, clip in files.items():
        shutil.copyfile(clips / clip, api.d.adb_root / "device/sdcard/pcMedia" / name)
        names.append(name)
    api.d.device.media["custom"] = names


FILES = {"2026-10-23_18-07-49-639_upload.mp4": "hevc.mp4", "2026-01-26_22-07-49-639.mp4": "h264.mp4",
         "2026-01-26_20-04-35-774.png": "still.png"}


def test_thumbnails_for_hevc_h264_and_png(api, clips, tools):
    put(api, clips, FILES)
    for name, clip in FILES.items():
        status, r, body = api.request("GET", f"/api/media/thumb?name={name}")
        assert status == 200, body
        if clip == "still.png":
            assert r.getheader("Content-Type") == "image/png"
            assert body == (clips / clip).read_bytes()
        else:
            assert r.getheader("Content-Type") == "image/jpeg"
            assert jpeg_size(body) == (M.THUMB_W, 154 if clip == "hevc.mp4" else 160)
    assert M.tools().ffprobe == (None if tools == "imageio" else FFPROBE)


def probe(data, tmp_path):
    p = tmp_path / "probe.mp4"
    p.write_bytes(data)
    out = subprocess.run([FFPROBE, "-v", "error", "-print_format", "json", "-show_streams", str(p)],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)["streams"][0]


def test_previews_hevc_gets_an_h264_proxy_and_h264_goes_as_it_is(api, clips, tools, tmp_path):
    if not FFPROBE:
        pytest.skip("system ffprobe needed to check the result")
    put(api, clips, FILES)
    hevc, h264 = list(FILES)[:2]
    status, r, body = api.request("GET", f"/api/media/preview?name={hevc}")
    assert (status, r.getheader("Content-Type")) == (200, "video/mp4")
    s = probe(body, tmp_path)
    assert (s["codec_name"], s["width"], s["pix_fmt"]) == ("h264", M.PROXY_W, "yuv420p")
    status, _, body = api.request("GET", f"/api/media/preview?name={h264}")
    assert status == 200
    assert body == (clips / "h264.mp4").read_bytes()
    # Seeking in the proxy: a range from the middle.
    status, r, part = api.request("GET", f"/api/media/preview?name={hevc}", headers={"Range": "bytes=1000-1999"})
    assert (status, len(part)) == (206, 1000)


def test_thumbnail_of_a_clip_shorter_than_the_seek(clips, tmp_path):
    exe = maker()
    short = tmp_path / "short.mp4"
    subprocess.run([exe, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc2=size=640x320:rate=30:duration=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(short)],
                   check=True)
    out = tmp_path / "t.jpg"
    M.thumbnail(str(short), str(out), M.Tools(exe, None, "libx265"))
    assert jpeg_size(out.read_bytes()) == (M.THUMB_W, 160)
