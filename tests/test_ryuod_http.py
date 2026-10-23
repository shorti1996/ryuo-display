"""ryuod's HTTP API on an ephemeral port, with the device worker faked at Device.submit().

Handler.apply() hands every device command to Device.submit(method, cmd, body, wait), which
returns a Future (or None while the cooler is disconnected). FakeDevice records those calls and
resolves the Future at once, so the tests see exactly what would have gone to the cooler.
"""

import concurrent.futures
import http.client
import json
import os
import threading

import pytest

import ryuo_proto as P
import ryuod

PRESET = ["RYUO_IV_HW_Info_01.mp4", "RYUO_IV_HW_Info_02.mp4", "RYUO_IV_HW_Info_04.mp4"]
CUSTOM = ["2026-01-26_22-07-49-639.mp4", "2026-01-26_20-04-35-774.png"]


class FakeDevice(ryuod.Device):
    def __init__(self, state, sampler):
        super().__init__(state, sampler, "post")
        self.media = {"source": "conn", "fetchedAt": 1792771200000, "preset": list(PRESET), "custom": list(CUSTOM)}
        self.submitted = []
        self.connected = True
        self.result = {"applied": True, "acked": True}
        self.conn_media = None  # media lists a refresh 'conn' would return; None = conn reply missing

    def submit(self, method, cmd, body, wait=0.25):
        if not self.connected:
            return None
        self.submitted.append((method, cmd, body, wait))
        fut = concurrent.futures.Future()
        res = dict(self.result)
        if cmd == "conn":
            res["media"] = self.conn_media is not None
            if self.conn_media is not None:
                self.set_media_from_conn({"media": self.conn_media})
        fut.set_result(res)
        return fut

    def close_pipe(self):
        os.close(self.wake_r)
        os.close(self.wake_w)


class Api:
    def __init__(self, port, daemon):
        self.port = port
        self.d = daemon

    def request(self, method, path, body=None, headers=None, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        hdrs = dict(headers or {})
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            hdrs.setdefault("Content-Type", "application/json")
        try:
            conn.request(method, path, body=data, headers=hdrs)
            resp = conn.getresponse()
            payload = resp.read()
            ctype = resp.getheader("Content-Type", "")
            out = json.loads(payload) if ctype.startswith("application/json") else payload
            return resp.status, resp, out
        finally:
            conn.close()

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, body, **kw):
        return self.request("POST", path, body=body, **kw)

    @property
    def sent(self):
        return [(m, c, b) for m, c, b, _ in self.d.device.submitted]

    def disk_state(self):
        with open(self.d.state.path) as f:
            return json.load(f)


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(P, "local_timezone", lambda: "Europe/Warsaw")
    d = ryuod.Daemon()
    d.state = ryuod.State(str(tmp_path / "config" / "ryuo" / "state.json"))
    d.state.update({"media": ["RYUO_IV_HW_Info_04.mp4"]})
    d.sampler = ryuod.Sampler(d.state)  # never started; tests fill its snapshot by hand
    d.device = FakeDevice(d.state, d.sampler)
    httpd = ryuod.Server(("127.0.0.1", 0), ryuod.Handler)
    httpd.daemon_ref = d
    t = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    try:
        yield Api(httpd.server_address[1], d)
    finally:
        httpd.shutdown()
        httpd.server_close()
        t.join(2)
        d.device.close_pipe()


def test_server_binds_loopback_ephemeral(api):
    assert api.port != 8746


# ---------------------------------------------------------------- GET


def test_get_state(api):
    status, resp, body = api.get("/api/state")
    assert status == 200
    assert resp.getheader("Content-Type") == "application/json"
    assert resp.getheader("Access-Control-Allow-Origin") is None
    assert body["ok"] is True
    assert body["config"] == ryuod.public_config(api.d.state.get())
    assert body["config"]["media"] == ["RYUO_IV_HW_Info_04.mp4"]
    assert body["limits"] == {"slots": 6, "brightnessMax": 102, "frameMax": 1024, "lastHeartbeatBytes": None}
    assert body["media"] == {"preset": PRESET, "custom": CUSTOM}
    dev = body["device"]
    assert dev["connected"] is False  # no fd in the fake
    assert dev["lastHeartbeatMs"] is None and dev["recoveries"] == 0
    assert dev["heartbeat"] == "post"


def test_get_state_connected_device(api):
    dev = api.d.device
    dev.dev = type("FakeRyuo", (), {"path": "/dev/hidraw4"})()
    dev.ready = True
    dev.ids = (0x0B05, 0x1C76)
    dev.info = {"product": "Ryuo IV Standard", "version": {"firmware": "V1.0.10"}}
    dev.last_hb_bytes = 548
    try:
        _, _, body = api.get("/api/state")
    finally:
        dev.dev = None
    assert body["device"]["connected"] is True
    assert body["device"]["hidraw"] == "/dev/hidraw4"
    assert (body["device"]["vid"], body["device"]["pid"]) == ("0b05", "1c76")
    assert body["device"]["firmware"] == "V1.0.10"
    assert body["device"]["product"] == "Ryuo IV Standard"
    assert body["limits"]["lastHeartbeatBytes"] == 548


def test_get_stats(api):
    s = api.d.sampler
    s.values = {"CPU Temperature": 50.44, "CPU Voltage": 1.23456, "CPU Load": 12.36, "Date&Time": "12:34"}
    s.sources = {
        "CPU Temperature": "k10temp Tctl",
        "CPU Voltage": "nct6799 Vcore",
        "CPU Load": "/proc/stat",
        "Date&Time": "device clock",
    }
    s.sampled_at = 1792771200000
    api.d.device.last_pcinfo = {"timestamp": 1792771200000, "cpu": {"load": 12}}
    status, _, body = api.get("/api/stats")
    assert status == 200
    assert body["sampledAt"] == 1792771200000
    assert body["lastPcInfo"] == {"timestamp": 1792771200000, "cpu": {"load": 12}}
    v = body["values"]
    assert set(v) == {c["item"] for c in s.catalog("Celsius")}
    assert v["CPU Temperature"] == {"value": 50.4, "unit": "°C", "available": True, "panel": "50"}
    assert v["CPU Voltage"] == {"value": 1.235, "unit": "V", "available": True, "panel": "1.235"}
    assert v["CPU Load"]["value"] == 12.4
    assert v["Date&Time"]["value"] == "12:34"
    assert v["GPU Load"] == {"value": 0, "unit": "%", "available": False, "panel": "0"}


def test_get_stats_fahrenheit_is_display_only(api):
    api.d.state.update({"tempUnit": "Fahrenheit"})
    api.d.sampler.values = {"CPU Temperature": 50.0}
    api.d.sampler.sources = {"CPU Temperature": "k10temp Tctl"}
    _, _, body = api.get("/api/stats")
    assert body["values"]["CPU Temperature"] == {"value": 122.0, "unit": "°F", "available": True, "panel": "122"}
    assert api.d.sampler.values["CPU Temperature"] == 50.0


def test_get_catalog(api):
    status, _, body = api.get("/api/catalog")
    assert status == 200
    items = body["items"]
    assert len(items) == len(P.ITEMS) + len(ryuod.CUSTOM)
    assert {"item", "title", "unit", "group", "available", "source", "note", "clipsIn"} <= set(items[0])
    custom = [c for c in items if c["group"] == "Custom"]
    assert [c["item"] for c in custom] == [c[0] for c in ryuod.CUSTOM]


def test_get_media_cached(api):
    status, _, body = api.get("/api/media")
    assert status == 200
    assert body == {"ok": True, "source": "conn", "fetchedAt": 1792771200000, "preset": PRESET, "custom": CUSTOM}
    assert api.sent == []


def test_get_media_refresh_resends_conn(api):
    api.d.device.conn_media = {"preset": ["RYUO_IV_HW_Info_09.mp4"], "custom": ["new.mp4"]}
    status, _, body = api.get("/api/media?refresh=1")
    assert status == 200
    assert api.sent == [("POST", "conn", {"OS": "Linux"})]
    assert api.d.device.submitted[0][3] == 1.5
    assert body["source"] == "conn"
    assert body["preset"] == ["RYUO_IV_HW_Info_09.mp4"]
    assert body["custom"] == ["new.mp4"]


def test_get_media_falls_back_to_adb(api, monkeypatch):
    api.d.device.media = {"source": None, "fetchedAt": None, "preset": [], "custom": []}
    fallback = {"source": "adb", "fetchedAt": 5, "preset": ["p.mp4"], "custom": ["c.mp4"]}
    monkeypatch.setattr(ryuod, "adb_media", lambda: fallback)
    status, _, body = api.get("/api/media")
    assert status == 200
    assert api.sent == [("POST", "conn", {"OS": "Linux"})]
    assert body == {"ok": True, **fallback}


def test_get_media_504_when_both_fail(api, monkeypatch):
    api.d.device.connected = False
    monkeypatch.setattr(ryuod, "adb_media", lambda: None)
    status, _, body = api.get("/api/media?refresh=1")
    assert status == 504
    assert body["ok"] is False


def test_adb_media_parses_ls_output(monkeypatch):
    out = "/sdcard/pcMediaPreset:\nRYUO_IV_HW_Info_01.mp4\nRYUO_IV_HW_Info_02.mp4\n\n/sdcard/pcMedia:\na.mp4\n"
    calls = []

    def run(argv, **kw):
        calls.append(argv)
        return ryuod.subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

    monkeypatch.setattr(ryuod.subprocess, "run", run)
    res = ryuod.adb_media()
    assert calls[0][:2] == ["adb", "shell"]
    assert res["source"] == "adb"
    assert res["preset"] == ["RYUO_IV_HW_Info_01.mp4", "RYUO_IV_HW_Info_02.mp4"]
    assert res["custom"] == ["a.mp4"]


def test_adb_media_failure(monkeypatch):
    def run(argv, **kw):
        raise ryuod.subprocess.TimeoutExpired(argv, 5)

    monkeypatch.setattr(ryuod.subprocess, "run", run)
    assert ryuod.adb_media() is None
    monkeypatch.setattr(ryuod.subprocess, "run", lambda argv, **kw: ryuod.subprocess.CompletedProcess(argv, 1, "", ""))
    assert ryuod.adb_media() is None


def test_get_index(api, tmp_path, monkeypatch):
    page = tmp_path / "index.html"
    page.write_text("<!doctype html><title>ryuo</title>")
    monkeypatch.setattr(ryuod, "INDEX", str(page))
    for path in ("/", "/index.html"):
        status, resp, body = api.get(path)
        assert status == 200
        assert resp.getheader("Content-Type") == "text/html; charset=utf-8"
        assert body == b"<!doctype html><title>ryuo</title>"


def test_get_index_missing(api, tmp_path, monkeypatch):
    monkeypatch.setattr(ryuod, "INDEX", str(tmp_path / "nope.html"))
    status, _, body = api.get("/")
    assert status == 404
    assert body["ok"] is False


def test_get_unknown_path(api):
    assert api.get("/api/nope")[0] == 404
    assert api.get("/api/state/extra")[0] == 404


# ---------------------------------------------------------------- POST /api/overlay


def test_overlay_items_sends_preset(api):
    items = ["CPU Temperature", "GPU Temperature", "Memory Utilization", "Date&Time", "Fan Speed Disk W MB/s"]
    status, _, body = api.post("/api/overlay", {"items": items})
    assert status == 200
    assert body["ok"] is True
    assert body["applied"] is True and body["acked"] is True
    assert body["sent"] == ["POST preset"]
    assert body["restartsVideo"] is False
    assert body["config"]["items"] == [*items, ""]
    ((method, cmd, sent),) = api.sent
    assert (method, cmd) == ("POST", "preset")
    assert sent == P.preset([*items, ""], P.settings("#E5252B", "#FFFFFF"))
    assert api.disk_state()["items"] == [*items, ""]


def test_overlay_colours_and_filter(api):
    status, _, _ = api.post(
        "/api/overlay", {"titleColor": "#00FF00", "contentColor": "#FFFF00", "filter": {"on": True, "opacity": 60}}
    )
    assert status == 200
    sent = api.sent[0][2]
    assert sent["settings"] == {
        "titleColor": "#00FF00",
        "contentColor": "#FFFF00",
        "filter": {"value": "Smoke", "opacity": 60},
        "badges": [],
    }
    assert sent["sysinfoDisplay"] == ryuod.DEFAULT_ITEMS  # unchanged keys keep their value
    assert api.disk_state()["filter"] == {"on": True, "opacity": 60}


def test_overlay_stats_hidden_then_shown(api):
    status, _, body = api.post("/api/overlay", {"statsVisible": False})
    assert status == 200
    assert body["config"]["statsVisible"] is False
    assert body["config"]["items"] == ryuod.DEFAULT_ITEMS  # kept, only the panel is blanked
    assert api.sent[-1][2]["sysinfoDisplay"] == [""] * 6
    assert api.disk_state()["statsVisible"] is False

    # Changing items while hidden saves them but still sends blanks.
    api.post("/api/overlay", {"items": ["CPU Load"]})
    assert api.sent[-1][2]["sysinfoDisplay"] == [""] * 6
    assert api.disk_state()["items"] == ["CPU Load", "", "", "", "", ""]

    status, _, body = api.post("/api/overlay", {"statsVisible": True})
    assert status == 200
    assert api.sent[-1][2]["sysinfoDisplay"] == ["CPU Load", "", "", "", "", ""]
    assert api.disk_state()["statsVisible"] is True


@pytest.mark.parametrize(
    "body",
    [
        {"items": ["CPU Load"] * 7},
        {"items": ["CPU Load", "CPU Load"]},
        {"items": ["Fan Speed " + "x" * 17]},
        {"items": ["GPU Frequency"]},
        {"items": ["", "", "Fan Speed " + "W" * 16]},  # clips past the panel edge in slot 3
        {"items": "CPU Load"},
        {"titleColor": "green"},
        {"contentColor": "#FFF"},
        {"filter": {"opacity": 101}},
        {"filter": {"on": "yes"}},
        {"statsVisible": "false"},
        {"statsVisible": 0},
        # One bad key rejects the whole request, the good one included.
        {"titleColor": "#00FF00", "contentColor": "nope"},
    ],
)
def test_overlay_validation_sends_nothing(api, body):
    before = api.disk_state()
    status, _, resp = api.post("/api/overlay", body)
    assert status == 400
    assert resp["ok"] is False and resp["error"]
    assert api.sent == []
    assert api.disk_state() == before


def test_overlay_wide_label_ok_in_slot_one(api):
    status, _, _ = api.post("/api/overlay", {"items": ["Fan Speed " + "W" * 16]})
    assert status == 200


def test_overlay_colour_with_trailing_newline_rejected(api):
    status, _, _ = api.post("/api/overlay", {"titleColor": "#00FF00\n"})
    assert status == 400
    assert api.sent == []


def test_overlay_while_disconnected_saves_and_reports_not_applied(api):
    api.d.device.connected = False
    status, _, body = api.post("/api/overlay", {"titleColor": "#123456"})
    assert status == 200
    assert body["applied"] is False and body["acked"] is False
    assert api.disk_state()["titleColor"] == "#123456"


def test_overlay_unacked(api):
    api.d.device.result = {"applied": True, "acked": False}
    _, _, body = api.post("/api/overlay", {"titleColor": "#123456"})
    assert body["applied"] is True and body["acked"] is False


def test_overlay_frame_too_large_is_400(api):
    api.d.device.result = {"applied": False, "acked": False, "error": "preset: frame is 1100 bytes, limit 1024"}
    status, _, body = api.post("/api/overlay", {"titleColor": "#123456"})
    assert status == 400
    assert "limit 1024" in body["error"]


# ---------------------------------------------------------------- POST /api/brightness


@pytest.mark.parametrize(("value", "level"), [(0, 0), (40, 100), (85, 212), (100, 250), (102, 255)])
def test_brightness(api, value, level):
    status, _, body = api.post("/api/brightness", {"value": value})
    assert status == 200
    assert body == {
        "ok": True,
        "applied": True,
        "acked": True,
        "sent": ["POST brightness"],
        "restartsVideo": False,
        "deviceLevel": level,
    }
    assert api.sent == [("POST", "brightness", {"value": value})]
    assert api.disk_state()["brightness"] == value


@pytest.mark.parametrize("value", [103, -1, 50.5, "50", True, None])
def test_brightness_out_of_range(api, value):
    status, _, body = api.post("/api/brightness", {"value": value})
    assert status == 400
    assert "0-102" in body["error"]
    assert api.sent == []
    assert api.disk_state()["brightness"] == 100


def test_brightness_missing_value(api):
    assert api.post("/api/brightness", {})[0] == 400
    assert api.sent == []


def test_brightness_disconnected(api):
    api.d.device.connected = False
    status, _, body = api.post("/api/brightness", {"value": 50})
    assert status == 200
    assert body["applied"] is False
    assert api.disk_state()["brightness"] == 50


# ---------------------------------------------------------------- POST /api/media/select


def test_media_select(api):
    status, _, body = api.post("/api/media/select", {"media": ["RYUO_IV_HW_Info_02.mp4", CUSTOM[0]], "playMode": "Cycle"})
    assert status == 200
    assert body["restartsVideo"] is True
    assert body["sent"] == ["POST waterBlockScreenId"]
    assert body["config"]["media"] == ["RYUO_IV_HW_Info_02.mp4", CUSTOM[0]]
    ((method, cmd, cfg),) = api.sent
    assert (method, cmd) == ("POST", "waterBlockScreenId")
    assert cfg == P.screen_config(
        ["RYUO_IV_HW_Info_02.mp4", CUSTOM[0]], "Cycle", "2:1", ryuod.DEFAULT_ITEMS, P.settings("#E5252B", "#FFFFFF")
    )
    assert api.d.device.submitted[0][3] == 1.0
    assert api.disk_state()["media"] == ["RYUO_IV_HW_Info_02.mp4", CUSTOM[0]]
    assert api.disk_state()["playMode"] == "Cycle"


def test_media_select_keeps_play_mode_and_hidden_stats(api):
    api.d.state.update({"playMode": "Random", "statsVisible": False})
    status, _, _ = api.post("/api/media/select", {"media": [PRESET[0]]})
    assert status == 200
    cfg = api.sent[0][2]
    assert cfg["playMode"] == "Random"
    assert cfg["sysinfoDisplay"] == [""] * 6


@pytest.mark.parametrize(
    "body",
    [
        {"media": ["not-on-device.mp4"]},
        {"media": [PRESET[0], "not-on-device.mp4"]},
        {"media": []},
        {"media": PRESET[0]},
        {"media": [1]},
        {"media": [PRESET[0]] * 21},
        {"media": [PRESET[0]], "playMode": "single"},
        {"playMode": "Single"},
    ],
)
def test_media_select_rejects(api, body):
    before = api.disk_state()
    status, _, resp = api.post("/api/media/select", body)
    assert status == 400
    assert resp["ok"] is False
    assert api.sent == []
    assert api.disk_state() == before


def test_media_select_playlist_too_long_rejected_before_save(api):
    names = [f"{i:02d}_" + "a" * 60 + ".mp4" for i in range(20)]
    api.d.device.media["custom"] = names
    before = api.disk_state()
    status, _, body = api.post("/api/media/select", {"media": names})
    assert status == 400
    assert body["error"] == "playlist too long for one HID report"
    assert api.sent == []
    assert api.disk_state() == before


# ---------------------------------------------------------------- POST /api/prefs


def test_prefs_temp_unit_change_sends_temperature(api):
    status, _, body = api.post("/api/prefs", {"tempUnit": "Fahrenheit"})
    assert status == 200
    assert body["sent"] == ["POST temperature"]
    assert api.sent == [("POST", "temperature", {"value": "Fahrenheit"})]
    assert api.disk_state()["tempUnit"] == "Fahrenheit"


def test_prefs_same_unit_sends_nothing(api):
    status, _, body = api.post("/api/prefs", {"tempUnit": "Celsius", "memoryMHz": 6000})
    assert status == 200
    assert body["sent"] == []
    assert body["applied"] is True
    assert api.sent == []
    assert api.disk_state()["memoryMHz"] == 6000


def test_prefs_sensor_override(api, tmp_path, monkeypatch):
    d = tmp_path / "hwmon3"
    d.mkdir()
    (d / "temp2_input").write_text("41000\n")
    monkeypatch.setattr(ryuod, "hwmon_chips", lambda: [("gigabyte_wmi", str(d))])
    status, _, body = api.post("/api/prefs", {"sensors": {"motherboard": "gigabyte_wmi:temp2"}})
    assert status == 200
    assert body["config"]["sensors"] == {"motherboard": "gigabyte_wmi:temp2"}
    assert api.post("/api/prefs", {"sensors": {"motherboard": "auto"}})[0] == 200
    assert api.disk_state()["sensors"] == {"motherboard": "auto"}


@pytest.mark.parametrize(
    "body",
    [
        {"tempUnit": "Kelvin"},
        {"tempUnit": "celsius"},
        {"memoryMHz": 20001},
        {"memoryMHz": -1},
        {"memoryMHz": "6000"},
        {"sensors": {"motherboard": "nope:temp1"}},
        {"sensors": {"motherboard": 1}},
        {"sensors": "auto"},
    ],
)
def test_prefs_rejects(api, body, monkeypatch):
    monkeypatch.setattr(ryuod, "hwmon_chips", lambda: [])
    before = api.disk_state()
    status, _, _ = api.post("/api/prefs", body)
    assert status == 400
    assert api.sent == []
    assert api.disk_state() == before


# ---------------------------------------------------------------- request hygiene


@pytest.mark.parametrize("host", ["evil.example", "127.0.0.1", "127.0.0.1:1", "localhost", "[::1]:{port}"])
def test_foreign_host_403(api, host):
    host = host.format(port=api.port)
    status, _, body = api.get("/api/state", headers={"Host": host})
    assert status == 403
    assert body == {"ok": False, "error": "Host must be 127.0.0.1 or localhost"}
    status, _, _ = api.post("/api/brightness", {"value": 50}, headers={"Host": host})
    assert status == 403
    assert api.sent == []


def test_localhost_host_ok(api):
    assert api.get("/api/state", headers={"Host": f"localhost:{api.port}"})[0] == 200


@pytest.mark.parametrize("ctype", ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", ""])
def test_post_needs_json_content_type(api, ctype):
    status, _, body = api.request("POST", "/api/brightness", raw=b'{"value":50}', headers={"Content-Type": ctype})
    assert status == 415
    assert body["ok"] is False
    assert api.sent == []


def test_post_json_with_charset_ok(api):
    status, _, _ = api.request(
        "POST", "/api/brightness", raw=b'{"value":50}', headers={"Content-Type": "Application/JSON; charset=utf-8"}
    )
    assert status == 200


def test_post_body_too_large(api):
    raw = json.dumps({"value": 50, "pad": "x" * (ryuod.MAX_BODY + 10)}).encode()
    status, _, body = api.request("POST", "/api/brightness", raw=raw, headers={"Content-Type": "application/json"})
    assert status == 413
    assert body["ok"] is False
    assert api.sent == []


@pytest.mark.parametrize(
    ("raw", "msg"), [(b"{nope", "invalid JSON"), (b"[1,2]", "body must be a JSON object"), (b"", "invalid JSON")]
)
def test_post_bad_json(api, raw, msg):
    status, _, body = api.request("POST", "/api/brightness", raw=raw, headers={"Content-Type": "application/json"})
    assert status == 400
    assert body["error"] == msg


def test_post_unknown_path(api):
    assert api.post("/api/nope", {})[0] == 404


@pytest.mark.parametrize("method", ["OPTIONS", "PUT", "DELETE", "PATCH"])
def test_other_methods_405(api, method):
    status, resp, body = api.request(method, "/api/brightness", headers={"Origin": "http://evil.example"})
    assert status == 405
    assert resp.getheader("Access-Control-Allow-Origin") is None
    assert body["ok"] is False


def test_errors_are_json(api):
    status, resp, body = api.get("/api/state", headers={"Host": "evil.example"})
    assert status == 403
    assert resp.getheader("Content-Type") == "application/json"
    assert resp.getheader("Cache-Control") == "no-store"
    assert set(body) == {"ok", "error"}


def test_keep_alive_serves_several_requests(api):
    conn = http.client.HTTPConnection("127.0.0.1", api.port, timeout=5)
    try:
        for _ in range(3):
            conn.request("GET", "/api/catalog")
            resp = conn.getresponse()
            assert resp.status == 200
            json.loads(resp.read())
    finally:
        conn.close()
