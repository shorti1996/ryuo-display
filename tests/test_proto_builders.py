"""Builders and size/label rules in ryuo_proto: settings, screen_config, preset, pc_info, fits."""

import json

import pytest

import ryuo_proto as P

REAL_LOCAL_TIMEZONE = P.local_timezone


@pytest.fixture(autouse=True)
def _fixed_timezone(monkeypatch):
    monkeypatch.setattr(P, "local_timezone", lambda: "Europe/Warsaw")


# ---------------------------------------------------------------- settings / screen_config / preset


def test_settings_defaults():
    assert P.settings("#E5252B", "#FFFFFF") == {
        "titleColor": "#E5252B",
        "contentColor": "#FFFFFF",
        "filter": {"value": None, "opacity": 100},
        "badges": [],
    }


def test_settings_filter_on():
    s = P.settings("#000000", "#111111", filter_on=True, opacity=60)
    assert s["filter"] == {"value": "Smoke", "opacity": 60}
    assert isinstance(P.settings("#0", "#1", opacity=60.0)["filter"]["opacity"], int)


def test_pad_items():
    assert P.pad_items([]) == [""] * 6
    assert P.pad_items(["a", "b"]) == ["a", "b", "", "", "", ""]
    assert P.pad_items(list("abcdefgh")) == list("abcdef")
    assert P.pad_items(("a",)) == ["a", "", "", "", "", ""]


def test_screen_config_shape():
    cfg = P.screen_config(("a.mp4", "b.mp4"), "Cycle", "16:9", ["CPU Load"], P.settings("#E5252B", "#FFFFFF"))
    assert cfg == {
        "id": "Customization",
        "screenMode": "Full Screen",
        "ratio": "16:9",
        "playMode": "Cycle",
        "media": ["a.mp4", "b.mp4"],
        "sysinfoDisplay": ["CPU Load", "", "", "", "", ""],
        "settings": P.settings("#E5252B", "#FFFFFF"),
        "timeZone": "Europe/Warsaw",
    }


def test_screen_config_unpadded_and_never_null():
    cfg = P.screen_config(["a.mp4"], "Single", "2:1", [], None, pad=False)
    assert cfg["sysinfoDisplay"] == []
    assert cfg["settings"] is None


def test_preset_is_six_slots():
    p = P.preset(["CPU Load", "GPU Load"], P.settings("#E5252B", "#FFFFFF"))
    assert p["id"] == "Customization"
    assert p["sysinfoDisplay"] == ["CPU Load", "GPU Load", "", "", "", ""]
    assert p["settings"]["filter"]["value"] is None


def _patch_localtime(monkeypatch, exists, target=None):
    real_exists, real_realpath = P.os.path.exists, P.os.path.realpath
    monkeypatch.setattr(P.os.path, "exists", lambda p: exists if p == "/etc/localtime" else real_exists(p))
    monkeypatch.setattr(P.os.path, "realpath", lambda p: target if p == "/etc/localtime" else real_realpath(p))


def test_local_timezone_from_symlink(monkeypatch):
    _patch_localtime(monkeypatch, True, "/usr/share/zoneinfo/America/Argentina/Buenos_Aires")
    assert REAL_LOCAL_TIMEZONE() == "America/Argentina/Buenos_Aires"


def test_local_timezone_without_localtime(monkeypatch):
    _patch_localtime(monkeypatch, False)
    monkeypatch.setattr(P.time, "tzname", ("CET", "CEST"))
    assert REAL_LOCAL_TIMEZONE() == "CET"


# ---------------------------------------------------------------- pc_info


SNAPSHOT = {
    "CPU Load": 12.4,
    "CPU Usage": 48.6,
    "CPU Temperature": 50.44,
    "CPU Speed Average": 4410.5,
    "CPU Voltage": 1.23456,
    "GPU Load": 2,
    "GPU Temperature": 37.6,
    "GPU Speed": 240.2,
    "GPU Power": 27.5,
    "GPU Voltage": 0.8765,
    "Memory Utilization": 41.2,
    "Memory Frequency": 6000,
    "Hard Disk Temperature": 43.7,
    "Motherboard Temperature": 30.04,
    "Fan Speed Disk R MB/s": 12.6,
    "Fan Speed Net Down KB/s": 840.4,
    "Date&Time": "12:34",
}
INT_FIELDS = [
    ("cpu", "load"),
    ("cpu", "usage"),
    ("cpu", "speedAverage"),
    ("gpu", "load"),
    ("gpu", "temperature"),
    ("gpu", "speed"),
    ("gpu", "power"),
    ("memory", "load"),
    ("memory", "speed"),
    ("disk", "temperature"),
]


def test_pc_info_values_and_types():
    body = P.pc_info(SNAPSHOT, ["CPU Temperature", "Fan Speed Disk R MB/s", "", "Date&Time"], 1792771200123.9)
    assert body["timestamp"] == 1792771200123
    assert body["cpu"] == {"load": 12, "usage": 49, "temperature": 50.4, "speedAverage": 4410, "voltage": 1.235}
    assert body["gpu"] == {"load": 2, "temperature": 38, "speed": 240, "power": 28, "voltage": 0.876}
    assert body["memory"] == {"load": 41, "speed": 6000}
    assert body["disk"] == {"temperature": 44}
    assert body["motherboard"] == {"temperature": 30.0}
    assert body["fans"] == [{"name": "Disk R MB/s", "value": 13}]
    for group, key in INT_FIELDS:
        assert type(body[group][key]) is int, (group, key)
    for group, key in [("cpu", "temperature"), ("cpu", "voltage"), ("gpu", "voltage"), ("motherboard", "temperature")]:
        assert type(body[group][key]) is float, (group, key)


def test_pc_info_empty_snapshot_keeps_timestamp_and_numeric_gpu_temperature():
    body = P.pc_info({}, [], 5)
    assert body["timestamp"] == 5
    # HomeUI parses gpu.temperature with Float.parseFloat, uncaught: it must stay numeric.
    assert body["gpu"]["temperature"] == 0
    assert "fans" not in body
    assert all(type(body[g][k]) is int for g, k in INT_FIELDS)


def test_pc_info_non_numeric_values_become_zero():
    body = P.pc_info({"CPU Load": "n/a", "CPU Temperature": None}, [], 0)
    assert body["cpu"]["load"] == 0
    assert body["cpu"]["temperature"] == 0.0


def test_pc_info_fans_follow_slots():
    items = ["Fan Speed Net Down KB/s", "Fan Speed Missing", "Fan Speed ", "CPU Load", "Fan Speed Disk R MB/s"]
    body = P.pc_info(SNAPSHOT, items, 0)
    assert body["fans"] == [
        {"name": "Net Down KB/s", "value": 840},
        {"name": "Missing", "value": 0},
        {"name": "Disk R MB/s", "value": 13},
    ]


def test_pc_info_worst_case_fits_one_report():
    # Spec §2.3: 6 fans with 16-character names and 6-digit values stay well under 1024 bytes.
    items = [f"Fan Speed {chr(65 + i) * 16}" for i in range(6)]
    snap = {k: 999999.999 for k in SNAPSHOT if k != "Date&Time"} | {it: 999999 for it in items}
    body = P.pc_info(snap, items, 1792771200000)
    assert len(body["fans"]) == 6
    assert P.fits("POST", "all", body)
    assert len(P.message("POST", "all", 10**9, body)[0]) < 700


def test_pc_info_json_has_no_fractional_ints():
    text = json.dumps(P.pc_info(SNAPSHOT, ["Fan Speed Disk R MB/s"], 1.5))
    body = json.loads(text)
    assert isinstance(body["fans"][0]["value"], int)


# ---------------------------------------------------------------- fits()


def _content_of_frame_len(target, seq=P._FIT_SEQ):
    """{"x": "a"*n} whose frame at `seq` is exactly `target` bytes, if one exists."""
    for n in range(0, 1100):
        body = {"x": "a" * n}
        size = len(P.message("POST", "preset", seq, body)[0])
        if size == target:
            return body
        if size > target:
            return None
    return None


def test_fits_small_and_large():
    assert P.fits("POST", "brightness", {"value": 60})
    assert not P.fits("POST", "preset", {"x": "a" * 1100})


def test_fits_boundary():
    limit = P.REPORT_LEN - P._ESCAPE_SLACK
    at = _content_of_frame_len(limit)
    over = _content_of_frame_len(limit + 1)
    assert at is not None and over is not None
    assert P.fits("POST", "preset", at)
    assert not P.fits("POST", "preset", over)


def test_fits_holds_at_every_real_seq():
    # The largest content fits() accepts must fit one report at every SeqNumber the driver reaches,
    # including seqs whose len/crc bytes need escaping.
    body = _content_of_frame_len(P.REPORT_LEN - P._ESCAPE_SLACK)
    assert P.fits("POST", "preset", body)
    seqs = list(range(1, 3000)) + [10**k - 1 for k in range(4, 10)] + [123456789, 987654321]
    worst = max(len(P.message("POST", "preset", s, body)[0]) for s in seqs)
    assert worst <= P.REPORT_LEN


# ---------------------------------------------------------------- labels and titles


@pytest.mark.parametrize("label", ["A", "Disk R MB/s", "Net Down KB/s", "x" * 16, "50%-1.0/2"])
def test_valid_label(label):
    assert P.valid_label(label)


@pytest.mark.parametrize("label", ["", "x" * 17, "°C", "a_b", "tab\t", "ł"])
def test_invalid_label(label):
    assert not P.valid_label(label)


def test_title_px_uses_font_advances():
    assert P.title_px("I", 1) == 278 * 76 / 1000
    assert P.title_px("W", 6) == 833 * 42 / 1000
    # Unknown characters count as the widest common glyph, 'W'.
    assert P.title_px("°", 3) == P.title_px("W", 3)


def test_title_fits_hardware_checks():
    # Checked on hardware (ryuo_proto.title_fits docstring).
    assert P.title_fits("W" * 16, 1)
    assert not P.title_fits("Hard Disk Temperature", 5)
    assert not P.title_fits("M" * 16, 5)


def test_title_fits_per_slot():
    fits = {s: P.title_fits("Hard Disk Temperature", s) for s in range(1, 7)}
    assert fits == {1: True, 2: True, 3: False, 4: False, 5: False, 6: True}
    assert all(P.title_fits("Net Down KB/s", s) for s in range(1, 7))


def test_items_table_consistency():
    names = [i[0] for i in P.ITEMS]
    assert len(names) == len(set(names))
    assert all(len(i) == 4 for i in P.ITEMS)
    assert ("GPU Power", "GPU", "°C", "GPU") in P.ITEMS  # the firmware draws a temperature unit
    assert P.SLOTS == 6
    assert P.BRIGHTNESS_MAX == 102
    assert int(P.BRIGHTNESS_MAX * 2.5) == 255
    assert (0x0B05, 0x1C76) in P.PIDS and (0x1C75, 0x1C76) in P.PIDS
    assert (0x0B05, 0x19AF) not in P.PIDS
