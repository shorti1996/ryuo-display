"""ryuod state file, validation helpers and config builders."""

import json
import os
from unittest import mock

import pytest

import ryuo_proto as P
import ryuod


@pytest.fixture(autouse=True)
def _fixed_timezone(monkeypatch):
    monkeypatch.setattr(P, "local_timezone", lambda: "Europe/Warsaw")


@pytest.fixture
def state_path(tmp_path):
    return str(tmp_path / "cfg" / "ryuo" / "state.json")


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(obj if isinstance(obj, str) else json.dumps(obj))


# ---------------------------------------------------------------- State


def test_default_state_path_follows_xdg(monkeypatch, tmp_path):
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "x"))
    assert ryuod.default_state_path() == str(tmp_path / "x" / "ryuo" / "state.json")
    monkeypatch.delenv("XDG_CONFIG_HOME")
    assert ryuod.default_state_path() == os.path.join(os.environ["HOME"], ".config", "ryuo", "state.json")


def test_defaults_without_file(state_path):
    s = ryuod.State(state_path)
    assert s.fresh
    st = s.get()
    assert st == ryuod.DEFAULT_STATE
    assert st["items"] == ["CPU Temperature", "CPU Load", "GPU Temperature", "GPU Load", "Memory Utilization", "Date&Time"]
    assert st["statsVisible"] is True
    assert st["brightness"] == 100
    assert not os.path.exists(state_path)


def test_get_returns_a_copy(state_path):
    s = ryuod.State(state_path)
    s.get()["items"].append("x")
    s.get()["filter"]["on"] = True
    assert s.get() == ryuod.DEFAULT_STATE
    assert ryuod.DEFAULT_STATE["filter"] == {"on": False, "opacity": 100}


def test_load_valid_file(state_path):
    saved = {
        "version": 1,
        "media": ["RYUO_IV_HW_Info_04.mp4"],
        "playMode": "Cycle",
        "ratio": "16:9",
        "items": ["CPU Temperature", "Fan Speed Disk R MB/s", "", "Date&Time"],
        "statsVisible": False,
        "titleColor": "#00FF00",
        "contentColor": "#80FFFF00",
        "filter": {"on": True, "opacity": 40},
        "brightness": 102,
        "tempUnit": "Fahrenheit",
        "memoryMHz": 6000,
        "sensors": {"motherboard": "gigabyte_wmi:temp2"},
        "secondDisplay": True,
        "burnInProtection": False,
        "unknown": "ignored",
    }
    write_json(state_path, saved)
    st = ryuod.State(state_path).get()
    assert st["items"] == ["CPU Temperature", "Fan Speed Disk R MB/s", "", "Date&Time", "", ""]
    for key in (
        "media",
        "playMode",
        "ratio",
        "statsVisible",
        "titleColor",
        "contentColor",
        "filter",
        "brightness",
        "tempUnit",
        "memoryMHz",
        "sensors",
        "secondDisplay",
        "burnInProtection",
    ):
        assert st[key] == saved[key], key
    assert "unknown" not in st


def test_load_partly_invalid_each_key_falls_back(state_path):
    write_json(
        state_path,
        {
            "media": [],  # too short
            "playMode": "single",  # lowercase never matches on the device
            "ratio": "21:9",
            "items": ["CPU Temperature", "GPU Frequency"],  # unknown item
            "statsVisible": "no",
            "titleColor": "green",
            "contentColor": "#00FF00",  # valid: kept
            "filter": {"on": "yes"},
            "brightness": 103,
            "tempUnit": "Kelvin",
            "memoryMHz": True,  # bool is not an int here
            "sensors": {"motherboard": 5},
            "secondDisplay": "on",
            "burnInProtection": "off",
        },
    )
    s = ryuod.State(state_path)
    assert not s.fresh
    st = s.get()
    expected = dict(ryuod.DEFAULT_STATE, contentColor="#00FF00")
    assert st == expected


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("media", ["a.mp4"] * 21),
        ("media", ["a" * 256]),
        ("media", [1]),
        ("items", ["CPU Load", "CPU Load"]),
        ("items", ["a"] * 7),
        ("items", "CPU Load"),
        ("filter", {"opacity": 101}),
        ("filter", []),
        ("brightness", -1),
        ("brightness", 50.0),
        ("memoryMHz", 20001),
        ("sensors", "auto"),
        ("secondDisplay", 1),
        ("secondDisplay", None),
        ("burnInProtection", 0),
        ("burnInProtection", "false"),
        ("burnInProtection", None),
    ],
)
def test_load_rejects_bad_value(state_path, key, value):
    write_json(state_path, {key: value, "brightness": 7} if key != "brightness" else {key: value})
    st = ryuod.State(state_path).get()
    assert st[key] == ryuod.DEFAULT_STATE[key]
    if key != "brightness":
        assert st["brightness"] == 7  # the good key next to it survives


@pytest.mark.parametrize(("saved", "want"), [
    ({"leftClick": "panel", "brightnessSteps": [60, 10]}, {"leftClick": "panel", "brightnessSteps": [10, 60]}),
    ({"leftClick": "menu"}, {"leftClick": "menu", "brightnessSteps": [25, 50, 75, 100]}),
    ({"leftClick": "nope", "brightnessSteps": [10]}, ryuod.DEFAULT_STATE["tray"]),
    ({"brightnessSteps": [10, 10]}, ryuod.DEFAULT_STATE["tray"]),
    ("page", ryuod.DEFAULT_STATE["tray"]),
])
def test_load_tray(state_path, saved, want):
    write_json(state_path, {"tray": saved, "brightness": 40})
    st = ryuod.State(state_path).get()
    assert st["tray"] == want
    assert st["brightness"] == 40  # a bad tray value falls back on its own


def test_check_steps_sorts():
    assert ryuod.check_steps([100, 1, 50]) == [1, 50, 100]
    assert ryuod.check_steps([7]) == [7]


def test_load_filter_merges_partial(state_path):
    write_json(state_path, {"filter": {"opacity": 30}})
    assert ryuod.State(state_path).get()["filter"] == {"on": False, "opacity": 30}


@pytest.mark.parametrize("content", ["{not json", "[1, 2]", '"text"', "\xff\xfe"])
def test_unreadable_file_renamed_bad(state_path, content):
    write_json(state_path, content)
    s = ryuod.State(state_path)
    assert s.get() == ryuod.DEFAULT_STATE
    assert s.fresh
    assert not os.path.exists(state_path)
    with open(state_path + ".bad") as f:
        assert f.read() == content


def test_update_saves_and_returns_copy(state_path):
    s = ryuod.State(state_path)
    st = s.update({"brightness": 40, "statsVisible": False})
    assert st["brightness"] == 40
    assert not s.fresh
    with open(state_path) as f:
        on_disk = json.load(f)
    assert on_disk["brightness"] == 40
    assert on_disk["statsVisible"] is False
    assert not os.path.exists(state_path + ".tmp")


def test_burn_in_protection_is_on_by_default_and_persists(state_path):
    assert ryuod.State(state_path).get()["burnInProtection"] is True
    # A state file from before the setting existed: on.
    write_json(state_path, {"brightness": 40})
    assert ryuod.State(state_path).get()["burnInProtection"] is True
    ryuod.State(state_path).update({"burnInProtection": False})
    assert ryuod.State(state_path).get()["burnInProtection"] is False
    assert ryuod.public_config(ryuod.State(state_path).get())["burnInProtection"] is False


@pytest.mark.parametrize(("value", "share"), [(0, 0), (40, 100 / 255), (100, 250 / 255), (102, 1.0)])
def test_backlight_share(value, share):
    assert ryuod.backlight_share(value) == share


def test_stats_visible_persists_across_restart(state_path):
    ryuod.State(state_path).update({"statsVisible": False, "items": ["CPU Load", "", "", "", "", ""]})
    st = ryuod.State(state_path).get()
    assert st["statsVisible"] is False
    assert st["items"][0] == "CPU Load"


def test_save_is_atomic(state_path):
    s = ryuod.State(state_path)
    s.update({"brightness": 40})
    with open(state_path) as f:
        before = f.read()

    def broken_dump(obj, f, **kw):
        f.write('{"brightness": 9')  # half-written, then the write fails
        raise OSError("disk full")

    with mock.patch.object(ryuod.json, "dump", broken_dump), pytest.raises(OSError):
        s.update({"brightness": 9})
    with open(state_path) as f:
        assert f.read() == before  # the real file is never half-written

    real_fsync = os.fsync
    with mock.patch.object(ryuod.os, "fsync", side_effect=real_fsync) as fsync:
        s.update({"brightness": 11})
    fsync.assert_called_once()
    with open(state_path) as f:
        assert json.load(f)["brightness"] == 11
    assert not os.path.exists(state_path + ".tmp")


def test_save_creates_directory(tmp_path):
    path = str(tmp_path / "deep" / "er" / "state.json")
    ryuod.State(path).save()
    assert os.path.exists(path)


def test_unicode_survives_round_trip(state_path):
    s = ryuod.State(state_path)
    s.update({"media": ["żółw.mp4"]})
    assert ryuod.State(state_path).get()["media"] == ["żółw.mp4"]


# ---------------------------------------------------------------- shown_items / config builders


def test_shown_items_visible_and_hidden():
    st = dict(ryuod.DEFAULT_STATE)
    assert ryuod.shown_items(st) == ryuod.DEFAULT_ITEMS
    st["statsVisible"] = False
    assert ryuod.shown_items(st) == []
    # Padded to six blanks on the wire.
    assert P.preset(ryuod.shown_items(st), ryuod.overlay_settings(st))["sysinfoDisplay"] == [""] * 6
    assert ryuod.config_for(dict(st, media=["a.mp4"]))["sysinfoDisplay"] == [""] * 6


def test_overlay_settings_and_config_for():
    st = dict(ryuod.DEFAULT_STATE, media=["a.mp4"], filter={"on": True, "opacity": 55}, titleColor="#010203")
    assert ryuod.overlay_settings(st) == P.settings("#010203", "#FFFFFF", True, 55)
    cfg = ryuod.config_for(st)
    assert cfg["media"] == ["a.mp4"]
    assert cfg["sysinfoDisplay"] == ryuod.DEFAULT_ITEMS
    assert cfg["settings"]["filter"] == {"value": "Smoke", "opacity": 55}
    assert cfg["timeZone"] == "Europe/Warsaw"


def test_black_config_has_no_overlay_and_keeps_the_saved_one():
    st = dict(ryuod.DEFAULT_STATE, media=["a.mp4"], items=["CPU Load", "", "", "", "", ""], statsVisible=True)
    cfg = ryuod.black_config(st)
    assert (cfg["media"], cfg["playMode"]) == ([ryuod.BLACK_NAME], "Single")
    assert cfg["sysinfoDisplay"] == [""] * 6
    assert cfg["settings"] == ryuod.overlay_settings(st)
    # The user's slots are untouched and come back with the saved media.
    assert st["items"] == ["CPU Load", "", "", "", "", ""] and st["statsVisible"] is True
    assert ryuod.config_for(st)["sysinfoDisplay"] == ["CPU Load", "", "", "", "", ""]


def test_public_config_keys():
    cfg = ryuod.public_config(dict(ryuod.DEFAULT_STATE))
    # The tray's settings go out under GET /api/state's "tray"; brightnessPercent is derived.
    assert set(cfg) == set(ryuod.DEFAULT_STATE) - {"version", "tray"} | {"brightnessPercent"}


def test_fitted_config_drops_media_until_it_fits():
    names = [f"{i:02d}-" + "n" * 60 + ".mp4" for i in range(20)]
    st = dict(ryuod.DEFAULT_STATE, media=names)
    cfg, dropped = ryuod.fitted_config(st)
    assert dropped > 0
    assert cfg["media"] == names[: 20 - dropped]
    assert P.fits("POST", "waterBlockScreenId", cfg)
    # One more name would not have fitted.
    longer = ryuod.config_for(dict(st, media=names[: 21 - dropped]))
    assert not P.fits("POST", "waterBlockScreenId", longer)
    assert st["media"] == names  # caller's dict untouched


def test_fitted_config_short_playlist_untouched():
    st = dict(ryuod.DEFAULT_STATE, media=["a.mp4", "b.mp4"])
    assert ryuod.fitted_config(st) == (ryuod.config_for(st), 0)


def test_fitted_config_keeps_last_single_name():
    st = dict(ryuod.DEFAULT_STATE, media=["x" * 1200])
    cfg, dropped = ryuod.fitted_config(st)
    assert dropped == 0 and cfg["media"] == ["x" * 1200]


# ---------------------------------------------------------------- validation helpers

KNOWN = {i[0] for i in P.ITEMS} | {c[0] for c in ryuod.CUSTOM}


def test_check_items_pads_and_accepts_custom_labels():
    assert ryuod.check_items(["CPU Load", "Fan Speed My Label 1"], KNOWN) == [
        "CPU Load",
        "Fan Speed My Label 1",
        "",
        "",
        "",
        "",
    ]
    assert ryuod.check_items(["", "", "CPU Load", "", "", ""], KNOWN)[2] == "CPU Load"
    assert ryuod.check_items(["", "", ""], KNOWN) == [""] * 6  # blanks are not duplicates


@pytest.mark.parametrize(
    "items",
    [
        ["CPU Load"] * 7,
        ["CPU Load", "CPU Load"],
        ["Fan Speed " + "x" * 17],
        ["Fan Speed "],
        ["Fan Speed °C"],
        ["GPU Frequency"],
        ["cpu load"],
        "CPU Load",
        [1],
        None,
    ],
)
def test_check_items_rejects(items):
    with pytest.raises(ryuod.Invalid):
        ryuod.check_items(items, KNOWN)


def test_check_fit_custom_labels_per_slot():
    items = P.pad_items(["Fan Speed " + "W" * 16])
    assert ryuod.check_fit(items) == items  # slot 1 is wide
    in_slot3 = ["", "", "Fan Speed " + "W" * 16, "", "", ""]
    with pytest.raises(ryuod.Invalid, match="slot 3"):
        ryuod.check_fit(in_slot3)
    # Firmware titles are fixed and never rejected, even where they clip.
    assert ryuod.check_fit(["", "", "", "", "Hard Disk Temperature", ""])


def test_title_of_and_clips_in():
    assert ryuod.title_of("Fan Speed Disk R MB/s") == "Disk R MB/s"
    assert ryuod.title_of("Memory Utilization") == "Memory Utilization"
    assert ryuod.title_of("Date&Time") == ""
    assert ryuod.title_of("nope") == ""
    assert ryuod.clips_in("Hard Disk Temperature") == [3, 4, 5]
    assert ryuod.clips_in("CPU Load") == []


@pytest.mark.parametrize("v", ["#E5252B", "#e5252b", "#80E5252B"])
def test_check_color_ok(v):
    assert ryuod.check_color(v, "titleColor") == v


@pytest.mark.parametrize("v", ["green", "#FFF", "E5252B", "#E5252B0", "#GGGGGG", "", None, 0xFFFFFF])
def test_check_color_rejects(v):
    with pytest.raises(ryuod.Invalid, match="titleColor"):
        ryuod.check_color(v, "titleColor")


def test_check_color_rejects_trailing_newline():
    with pytest.raises(ryuod.Invalid):
        ryuod.check_color("#E5252B\n", "titleColor")


def test_check_int():
    assert ryuod.check_int(0, "v", 0, 102) == 0
    assert ryuod.check_int(102, "v", 0, 102) == 102
    for bad in (-1, 103, True, False, 50.0, "50", None):
        with pytest.raises(ryuod.Invalid, match="v must be an integer 0-102"):
            ryuod.check_int(bad, "v", 0, 102)


def test_check_filter():
    cur = {"on": False, "opacity": 100}
    assert ryuod.check_filter({"on": True}, cur) == {"on": True, "opacity": 100}
    assert ryuod.check_filter({"opacity": 0}, cur) == {"on": False, "opacity": 0}
    assert ryuod.check_filter({}, cur) == cur
    assert cur == {"on": False, "opacity": 100}
    for bad in ({"on": 1}, {"opacity": 101}, {"opacity": "5"}, [], None):
        with pytest.raises(ryuod.Invalid):
            ryuod.check_filter(bad, cur)


def test_panel_text():
    assert ryuod.panel_text("CPU Temperature", 50.9, "Celsius") == "50"
    assert ryuod.panel_text("CPU Temperature", 50.0, "Fahrenheit") == "122"
    assert ryuod.panel_text("CPU Voltage", 1.23456, "Celsius") == "1.235"
    assert ryuod.panel_text("CPU Load", 12.5, "Celsius") == "12"
    assert ryuod.panel_text("CPU Load", 13.5, "Celsius") == "14"
    assert ryuod.panel_text("Date&Time", "12:34", "Celsius") == "12:34"
