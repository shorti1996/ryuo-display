"""ryuod's Linux stats sampler, against a fake hwmon tree and a fake nvidia-smi."""

import re
import subprocess
import threading
import types

import pytest

import ryuo_proto as P
import ryuod


def make_hwmon(root, index, name, files):
    d = root / f"hwmon{index}"
    d.mkdir(parents=True)
    (d / "name").write_text(name + "\n")
    for fname, content in files.items():
        (d / fname).write_text(f"{content}\n")
    return str(d)


@pytest.fixture
def hwmon(tmp_path):
    root = tmp_path / "hwmon"
    chips = [
        (
            "k10temp",
            make_hwmon(
                root,
                0,
                "k10temp",
                {"temp1_label": "Tctl", "temp1_input": 50400, "temp3_label": "Tccd1", "temp3_input": 45000},
            ),
        ),
        ("nvme", make_hwmon(root, 1, "nvme", {"temp1_label": "Composite", "temp1_input": 44850})),
        ("gigabyte_wmi", make_hwmon(root, 2, "gigabyte_wmi", {"temp1_input": 30000, "temp2_input": 62000})),
        (
            "nct6799",
            make_hwmon(
                root,
                10,
                "nct6799",
                {
                    "in0_label": "Vcore",
                    "in0_input": 1100,
                    "in1_input": 3300,
                    "fan1_input": 1200,
                    "fan1_label": "CPU_FAN",
                    "fan2_input": 800,
                },
            ),
        ),
    ]
    return root, chips


@pytest.fixture
def sampler(tmp_path, hwmon, monkeypatch):
    _, chips = hwmon
    monkeypatch.setattr(ryuod, "hwmon_chips", lambda: chips)
    monkeypatch.setattr(ryuod.shutil, "which", lambda name: None)
    state = ryuod.State(str(tmp_path / "state.json"))
    return ryuod.Sampler(state)


# ---------------------------------------------------------------- sensor discovery


def test_hwmon_chips_sorted_numerically(hwmon, monkeypatch):
    root, _ = hwmon
    real_glob = ryuod.glob.glob
    monkeypatch.setattr(
        ryuod,
        "glob",
        types.SimpleNamespace(glob=lambda p: real_glob(str(root / "hwmon*")) if p == "/sys/class/hwmon/hwmon*" else []),
    )
    assert [name for name, _ in ryuod.hwmon_chips()] == ["k10temp", "nvme", "gigabyte_wmi", "nct6799"]


def test_chip_match():
    assert ryuod.chip_match("nct6799", "nct67*")
    assert not ryuod.chip_match("nct6799", "nct6798")
    assert ryuod.chip_match("k10temp", "k10temp")
    assert not ryuod.chip_match("k10temp2", "k10temp")


def test_find_sensor_by_label_and_index(hwmon):
    _, chips = hwmon
    path, source = ryuod.find_sensor(chips, [("zenpower", "Tdie"), ("k10temp", "Tctl")])
    assert path.endswith("hwmon0/temp1_input") and source == "k10temp Tctl"
    path, source = ryuod.find_sensor(chips, [("gigabyte_wmi", None)])
    assert path.endswith("hwmon2/temp1_input") and source == "gigabyte_wmi temp1"
    path, source = ryuod.find_sensor(chips, [("nct67*", "Vcore")], "in")
    assert path.endswith("hwmon10/in0_input") and source == "nct6799 Vcore"
    assert ryuod.find_sensor(chips, [("coretemp", "Package id 0"), ("acpitz", None)]) is None


def test_sensor_override(hwmon):
    _, chips = hwmon
    path, source = ryuod.sensor_override(chips, "gigabyte_wmi:temp2")
    assert path.endswith("hwmon2/temp2_input") and source == "gigabyte_wmi temp2"
    assert ryuod.sensor_override(chips, "gigabyte_wmi:temp9") is None
    assert ryuod.sensor_override(chips, "nope:temp1") is None
    assert ryuod.sensor_override(chips, "gigabyte_wmi") is None
    assert ryuod.sensor_override(chips, None) is None


def test_fan_label():
    assert ryuod.fan_label("CPU_FAN") == "CPUFAN"
    assert ryuod.fan_label("  nct6799 fan2 ") == "nct6799 fan2"
    assert ryuod.fan_label("x" * 20) == "x" * 16
    assert ryuod.fan_label("°°°") == ""
    assert P.valid_label(ryuod.fan_label("Pump (Ω) speed #1"))


def test_rd_helpers(tmp_path):
    (tmp_path / "v").write_text("42000\n")
    (tmp_path / "bad").write_text("n/a\n")
    assert ryuod.rd(str(tmp_path / "v")) == "42000"
    assert ryuod.rd(str(tmp_path / "missing")) is None
    assert ryuod.rd_num(str(tmp_path / "v"), 1000) == 42.0
    assert ryuod.rd_num(str(tmp_path / "bad")) is None
    assert ryuod.rd_num(str(tmp_path / "missing")) is None


# ---------------------------------------------------------------- sample()


def test_sample_reads_sensors(sampler):
    sampler.sample()
    sampler.sample()  # CPU load and throughput need a previous sample
    values, sources, at = sampler.snapshot()
    assert values["CPU Temperature"] == 50.4
    assert sources["CPU Temperature"] == "k10temp Tctl"
    assert values["Hard Disk Temperature"] == 44.85
    assert values["Motherboard Temperature"] == 30.0
    assert sources["Motherboard Temperature"] == "gigabyte_wmi temp1"
    assert values["CPU Voltage"] == 1.1
    assert values["Fan Speed CPUFAN"] == 1200
    assert values["Fan Speed nct6799 fan2"] == 800
    assert 0 <= values["CPU Load"] <= 100
    assert 0 <= values["CPU Usage"] <= 100
    assert 0 < values["Memory Utilization"] < 100
    assert re.fullmatch(r"\d\d:\d\d", values["Date&Time"])
    assert "Memory Frequency" not in values  # hidden while memoryMHz is 0
    assert isinstance(at, int)
    assert set(sources) == set(values)


def test_sample_uses_state_prefs(sampler):
    sampler.state.update({"memoryMHz": 6000, "sensors": {"motherboard": "gigabyte_wmi:temp2"}})
    sampler.sample()
    values, sources, _ = sampler.snapshot()
    assert values["Memory Frequency"] == 6000
    assert values["Motherboard Temperature"] == 62.0
    assert sources["Motherboard Temperature"] == "gigabyte_wmi temp2"


def test_sample_drops_unreadable_sensor(sampler, hwmon):
    sampler.sample()
    root, _ = hwmon
    (root / "hwmon0" / "temp1_input").write_text("garbage\n")
    sampler.sample()
    values, sources, _ = sampler.snapshot()
    assert "CPU Temperature" not in values
    assert "CPU Temperature" not in sources


def test_hwmon_fans_in_catalog_and_known_items(sampler):
    sampler.sample()
    assert "Fan Speed CPUFAN" in sampler.known_items()
    entry = next(c for c in sampler.catalog("Celsius") if c["item"] == "Fan Speed CPUFAN")
    assert entry == {
        "item": "Fan Speed CPUFAN",
        "title": "CPUFAN",
        "unit": "RPM",
        "group": "Custom",
        "available": True,
        "source": "nct6799 fan1",
        "note": None,
        "clipsIn": [],
    }


# ---------------------------------------------------------------- nvidia-smi


@pytest.fixture
def nv_sampler(sampler, monkeypatch):
    sampler.nvidia = "/usr/bin/nvidia-smi"
    calls = []

    def run(argv, **kw):
        calls.append(argv)
        out = sampler._nv_out
        if isinstance(out, BaseException):
            raise out
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")

    monkeypatch.setattr(ryuod.subprocess, "run", run)
    sampler._nv_calls = calls
    return sampler


def test_nvidia_smi_values(nv_sampler):
    nv_sampler._nv_out = "37, 2, 240, 27.53\n"
    v, src = {}, {}
    nv_sampler.sample_gpu(v, src, 100.0)
    assert v == {
        "GPU Temperature": 37.0,
        "GPU Load": 2.0,
        "GPU Speed": 240.0,
        "GPU Power": 27.53,
        "GPU Usage": 2.0,
        "Fan Speed GPU W": 27.53,
    }
    assert set(src.values()) == {"nvidia-smi"}
    argv = nv_sampler._nv_calls[0]
    assert argv[1] == "--query-gpu=temperature.gpu,utilization.gpu,clocks.current.graphics,power.draw"
    assert argv[-2:] == ["-i", "0"]


def test_nvidia_smi_na_field_skipped(nv_sampler):
    nv_sampler._nv_out = "37, [N/A], 240, [N/A]\n"
    v, src = {}, {}
    nv_sampler.sample_gpu(v, src, 100.0)
    assert v == {"GPU Temperature": 37.0, "GPU Speed": 240.0}


def test_nvidia_smi_backs_off_after_three_failures(nv_sampler):
    nv_sampler._nv_out = subprocess.TimeoutExpired(["nvidia-smi"], 1.5)
    for t in (1.0, 2.0, 3.0):
        nv_sampler.sample_gpu({}, {}, t)
    assert nv_sampler.nv_fail == 3
    assert nv_sampler.nv_next == 33.0
    nv_sampler.sample_gpu({}, {}, 10.0)
    assert len(nv_sampler._nv_calls) == 3  # not run during the back-off
    nv_sampler._nv_out = "40, 1, 100, 10\n"
    v = {}
    nv_sampler.sample_gpu(v, {}, 34.0)
    assert v["GPU Temperature"] == 40.0
    assert nv_sampler.nv_fail == 0


def test_nvidia_smi_wrong_field_count_is_a_failure(nv_sampler):
    nv_sampler._nv_out = "37, 2\n"
    v = {}
    nv_sampler.sample_gpu(v, {}, 1.0)
    assert v == {}
    assert nv_sampler.nv_fail == 1


# ---------------------------------------------------------------- catalog


def test_catalog_units_follow_temp_unit(sampler):
    sampler.sample()
    cat = {c["item"]: c for c in sampler.catalog("Fahrenheit")}
    assert cat["CPU Temperature"]["unit"] == "°F"
    assert cat["GPU Power"]["unit"] == "°F"  # the firmware draws a temperature unit for GPU Power
    assert cat["CPU Load"]["unit"] == "%"
    assert cat["Hard Disk Temperature"]["clipsIn"] == [3, 4, 5]
    assert cat["CPU Temperature"]["available"] is True
    assert cat["Memory Frequency"]["available"] is False  # no source while memoryMHz is 0
    assert cat["GPU Usage"]["note"].startswith("same value as GPU Load")
    assert {c["unit"] for c in cat.values() if c["group"] == "Custom"} == {"RPM"}
    assert {c["item"] for c in sampler.catalog("Celsius") if c["item"] == "CPU Temperature" and c["unit"] == "°C"}
    items = [c["item"] for c in sampler.catalog("Celsius")]
    assert items[: len(P.ITEMS)] == [i[0] for i in P.ITEMS]
    assert len(items) == len(set(items))


def test_catalog_before_first_probe(tmp_path):
    s = ryuod.Sampler(ryuod.State(str(tmp_path / "s.json")))
    assert len(s.catalog("Celsius")) == len(P.ITEMS) + len(ryuod.CUSTOM)
    assert s.known_items() == {i[0] for i in P.ITEMS} | {c[0] for c in ryuod.CUSTOM}


# ---------------------------------------------------------------- thread loop


def test_run_loop_survives_sample_errors_and_stops(sampler, monkeypatch, capsys):
    calls = []
    done = threading.Event()

    def sample():
        calls.append(1)
        if len(calls) >= 2:
            done.set()
        raise RuntimeError("boom")

    monkeypatch.setattr(sampler, "sample", sample)
    # No 1 s pause between samples: the wait returns at once unless stop was requested.
    monkeypatch.setattr(sampler.stop_ev, "wait", lambda t: sampler.stop_ev.is_set())
    sampler.start()
    assert done.wait(2)
    sampler.stop_ev.set()
    sampler.join(2)
    assert not sampler.is_alive()
    assert "sampler: RuntimeError: boom" in capsys.readouterr().out
