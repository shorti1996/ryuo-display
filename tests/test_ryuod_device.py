"""ryuod's device worker against a fake cooler on a SOCK_SEQPACKET socketpair (no hidraw)."""

import http.client
import json
import os
import threading
import time

import pytest
from fakes import CONN_BODY, FAKE_PATH, FakeCooler, hid_pair, make_ryuo

import ryuo_proto as P
import ryuod

STARTUP = ["conn", "temperature", "waterBlockScreen", "waterBlockScreenId", "power", "brightness", "all"]


class FakeSampler:
    def __init__(self, values=None):
        self.values = dict(values or {})

    def snapshot(self):
        return dict(self.values), {}, 0


class Rig:
    """A Device wired to fake coolers. Every P.Ryuo(path) the worker opens gets a fresh socketpair
    and a fresh FakeCooler, so a reconnect looks like the cooler re-enumerating."""

    def __init__(self, tmp_path, monkeypatch, mode="post", **cooler_kw):
        self.cooler_kw = cooler_kw
        self.coolers = []
        self.ryuos = []
        self.hid_present = True
        self.logs = []
        # Worker threads log on their own schedule; collect it instead of racing pytest's capture.
        monkeypatch.setattr(ryuod, "log", self.logs.append)
        monkeypatch.setattr(P, "local_timezone", lambda: "Europe/Warsaw")
        monkeypatch.setattr(P, "find_hidraw", lambda: FAKE_PATH if self.hid_present else None)
        monkeypatch.setattr(P, "Ryuo", self.open)
        self.state = ryuod.State(str(tmp_path / "state.json"))
        self.sampler = FakeSampler({"CPU Temperature": 50.44, "CPU Load": 12.6, "Fan Speed Disk R MB/s": 12.6})
        self.device = ryuod.Device(self.state, self.sampler, mode)

    def open(self, path):
        assert path == FAKE_PATH
        host_fd, dev_sock = hid_pair()
        cooler = FakeCooler(dev_sock, **self.cooler_kw)
        cooler.start()
        self.coolers.append(cooler)
        r = make_ryuo(host_fd, path)
        self.ryuos.append(r)
        return r

    @property
    def cooler(self):
        return self.coolers[-1]

    def attach(self):
        """Open a device for the synchronous tests that call Device methods directly."""
        self.device.dev = self.open(FAKE_PATH)
        return self.cooler

    def close(self):
        if self.device.is_alive():
            self.device.stop(send_disconn=False)
            self.device.join(3)
        for r in self.ryuos:
            r.close()
        for c in self.coolers:
            c.stop()
        os.close(self.device.wake_r)
        os.close(self.device.wake_w)


@pytest.fixture
def make_rig(tmp_path, monkeypatch):
    rigs = []

    def make(**kw):
        rig = Rig(tmp_path, monkeypatch, **kw)
        rigs.append(rig)
        return rig

    yield make
    for rig in rigs:
        rig.close()


@pytest.fixture
def rig(make_rig):
    return make_rig()


def count(cmd, n):
    return lambda received: sum(1 for _, c, _ in received if c == cmd) >= n


def wait_until(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


# ---------------------------------------------------------------- startup sequence (threaded)


def test_startup_sequence_heartbeat_and_disconn(rig):
    d = rig.device
    d.start()
    assert wait_until(lambda: rig.coolers)
    cooler = rig.cooler
    received = cooler.wait_for(count("all", 2), timeout=6)
    assert d.status()["connected"] is True
    d.stop(send_disconn=True)
    d.join(3)
    assert not d.is_alive()
    assert cooler.closed.wait(2)

    cmds = [c for _, c, _ in cooler.received]
    assert cmds[:7] == STARTUP
    assert cmds[-1] == "disconn"
    assert all(m == "POST" for m, _, _ in cooler.received)
    bodies = {c: b for _, c, b in received[:7]}
    assert bodies["conn"] == {"OS": "Linux"}
    assert bodies["temperature"] == {"value": "Celsius"}
    assert bodies["waterBlockScreen"] == {"enable": True}
    # No media in state: the first preset name from the conn reply, sorted, is chosen and saved.
    assert bodies["waterBlockScreenId"] == P.screen_config(
        ["RYUO_IV_HW_Info_01.mp4"], "Single", "2:1", ryuod.DEFAULT_ITEMS, P.settings("#E5252B", "#FFFFFF")
    )
    assert rig.state.get()["media"] == ["RYUO_IV_HW_Info_01.mp4"]
    assert bodies["power"] == {"event": "resume"}
    assert bodies["brightness"] == {"value": 100}
    assert set(bodies["all"]) >= {"timestamp", "cpu", "gpu"}

    seqs = [int(h["SeqNumber"]) for h in cooler.headers]
    assert seqs == list(range(1, len(seqs) + 1))
    gaps = [b - a for a, b in zip(cooler.times, cooler.times[1:], strict=False)]
    assert min(gaps) >= 0.12  # at most 8 frames/s
    hb_times = [t for t, (_, c, _) in zip(cooler.times, cooler.received, strict=True) if c == "all"]
    assert 0.85 <= hb_times[1] - hb_times[0] <= 1.3

    # The conn reply spans two reports and is reassembled.
    assert d.info["product"] == "Ryuo IV Standard"
    assert d.media["source"] == "conn"
    assert d.media["custom"] == CONN_BODY["media"]["custom"]
    assert d.recoveries == 0
    assert d.dev is None


def test_stop_without_disconn_when_taken_over(rig):
    d = rig.device
    d.start()
    assert wait_until(lambda: rig.coolers)
    rig.cooler.wait_for(count("all", 1))
    d.stop(send_disconn=False)
    d.join(3)
    assert "disconn" not in rig.cooler.cmds()
    assert rig.cooler.closed.wait(2)


def test_startup_uses_saved_state(rig):
    rig.state.update(
        {
            "media": ["a.mp4", "b.mp4"],
            "playMode": "Cycle",
            "brightness": 40,
            "tempUnit": "Fahrenheit",
            "statsVisible": False,
            "titleColor": "#00FF00",
        }
    )
    cooler = rig.attach()
    rig.device.startup()
    bodies = {c: b for _, c, b in cooler.wait_for(count("all", 1))}
    assert bodies["temperature"] == {"value": "Fahrenheit"}
    cfg = bodies["waterBlockScreenId"]
    assert cfg["media"] == ["a.mp4", "b.mp4"] and cfg["playMode"] == "Cycle"
    assert cfg["sysinfoDisplay"] == [""] * 6
    assert cfg["settings"]["titleColor"] == "#00FF00"
    assert bodies["brightness"] == {"value": 40}
    assert rig.device.ready


def test_startup_while_the_second_display_streams_sends_the_black_image(rig):
    rig.state.update({"media": ["a.mp4", "b.mp4"], "playMode": "Cycle"})
    rig.device.backdrop = ryuod.Backdrop(None)
    rig.device.backdrop.on = True
    cooler = rig.attach()
    rig.device.startup()
    bodies = {c: b for _, c, b in cooler.wait_for(count("all", 1))}
    assert bodies["waterBlockScreenId"] == ryuod.black_config(rig.state.get())
    assert bodies["waterBlockScreenId"]["media"] == [ryuod.BLACK_NAME]
    assert rig.state.get()["media"] == ["a.mp4", "b.mp4"]  # the user's selection stays saved


def test_startup_skips_oversized_config_but_keeps_going(rig):
    rig.state.update({"media": ["x" * 1200]})
    cooler = rig.attach()
    rig.device.startup()
    cmds = [c for _, c, _ in cooler.wait_for(count("all", 1))]
    assert cmds == ["conn", "temperature", "waterBlockScreen", "power", "brightness", "all"]
    assert "limit 1024" in rig.device.last_error
    assert rig.device.ready


def test_startup_trims_long_playlist(rig):
    names = [f"{i:02d}_" + "n" * 60 + ".mp4" for i in range(20)]
    rig.state.update({"media": names})
    cooler = rig.attach()
    rig.device.startup()
    cfg = next(b for _, c, b in cooler.wait_for(count("all", 1)) if c == "waterBlockScreenId")
    assert 1 <= len(cfg["media"]) < 20
    assert cfg["media"] == names[: len(cfg["media"])]
    assert rig.state.get()["media"] == names  # state keeps the full list


def test_startup_without_conn_reply_falls_back_to_default_media(make_rig):
    rig = make_rig(silent={"conn"})
    cooler = rig.attach()
    rig.device.startup()
    cfg = next(b for _, c, b in cooler.wait_for(count("all", 1)) if c == "waterBlockScreenId")
    assert cfg["media"] == ["RYUO_IV_HW_Info_01.mp4"]
    assert rig.device.info == {}


# ---------------------------------------------------------------- heartbeat


def test_heartbeat_body(rig):
    rig.state.update({"items": ["CPU Temperature", "Fan Speed Disk R MB/s", "", "", "", ""]})
    cooler = rig.attach()
    before = time.time() * 1000
    rig.device.heartbeat()
    ((method, cmd, body),) = cooler.wait_for(count("all", 1))
    assert (method, cmd) == ("POST", "all")
    assert before - 1 <= body["timestamp"] <= time.time() * 1000
    assert body == P.pc_info(rig.sampler.values, rig.state.get()["items"], body["timestamp"])
    assert body["cpu"]["temperature"] == 50.4
    assert body["cpu"]["load"] == 13
    assert body["fans"] == [{"name": "Disk R MB/s", "value": 13}]
    assert rig.device.last_pcinfo == body
    assert rig.device.last_hb_bytes == len(P.message("POST", "all", 1, body)[0])
    assert rig.device.last_hb_ok is not None


def test_heartbeat_state_mode(make_rig):
    rig = make_rig(mode="state")
    cooler = rig.attach()
    rig.device.heartbeat()
    ((method, cmd, body),) = cooler.wait_for(count("all", 1))
    assert (method, cmd) == ("STATE", "all")
    assert "timestamp" in body


def test_heartbeat_oversized_sends_timestamp_only(rig, monkeypatch):
    monkeypatch.setattr(P, "pc_info", lambda snap, items, now: {"timestamp": int(now), "pad": "x" * 1100})
    cooler = rig.attach()
    rig.device.heartbeat()
    ((_, _, body),) = cooler.wait_for(count("all", 1))
    assert list(body) == ["timestamp"]


def test_homeui_ack_resets_missed(rig):
    cooler = rig.attach()
    d = rig.device
    for _ in range(3):
        d.heartbeat()
    cooler.wait_for(count("all", 3))
    assert d.missed == 0
    assert d.last_ack_wall is not None
    assert d.status()["lastHomeuiAckMs"] is not None


def test_missing_homeui_ack_counts_misses(make_rig):
    rig = make_rig(homeui_ack=False)
    rig.attach()
    d = rig.device
    for _ in range(3):
        d.heartbeat()
    assert d.missed == 2
    assert d.last_ack_wall is None


# ---------------------------------------------------------------- recovery


def test_recovery_on_heartbeat_gap(rig):
    cooler = rig.attach()
    d = rig.device
    d.startup()
    cooler.wait_for(count("all", 1))
    cooler.clear()
    d.last_hb_ok = ryuod.boottime() - 4.6  # e.g. a suspend: CLOCK_BOOTTIME moved on
    d.tick()
    assert cooler.cmds()[:7] == STARTUP
    assert d.recoveries == 1
    assert d.last_error.startswith("heartbeat gap")


def test_no_recovery_within_gap_limit(rig):
    cooler = rig.attach()
    d = rig.device
    d.startup()
    cooler.wait_for(count("all", 1))
    cooler.clear()
    d.last_hb_ok = ryuod.boottime() - 4.0
    d.next_hb = 0.0
    d.tick()
    assert cooler.cmds() == ["all"]
    assert d.recoveries == 0


def test_recovery_on_homeui_silence_rate_limited(rig):
    cooler = rig.attach()
    d = rig.device
    d.startup()
    cooler.wait_for(count("all", 1))
    cooler.clear()
    d.missed = 5
    d.tick()
    assert cooler.cmds()[:7] == STARTUP
    assert d.recoveries == 1
    assert "no HomeUI ack" in d.last_error
    cooler.clear()
    d.missed = 5
    d.next_hb = 0.0
    d.tick()  # within 30 s of the last one: only a heartbeat
    assert cooler.cmds() == ["all"]
    assert d.recoveries == 1


def test_state_mode_ignores_homeui_silence(make_rig):
    rig = make_rig(mode="state")
    cooler = rig.attach()
    d = rig.device
    d.startup()
    cooler.wait_for(count("all", 1))
    cooler.clear()
    d.missed = 9
    d.next_hb = 0.0
    d.tick()
    assert cooler.cmds() == ["all"]
    assert d.recoveries == 0


def test_usb_loss_reconnects_and_counts_recovery(rig):
    d = rig.device
    d.start()
    assert wait_until(lambda: rig.coolers)
    first = rig.cooler
    first.wait_for(count("all", 1))
    first.sock.close()  # the cooler re-enumerates: writes fail with EPIPE
    assert wait_until(lambda: len(rig.coolers) == 2, timeout=4)
    second = rig.coolers[1]
    second.wait_for(count("all", 1))
    assert second.cmds()[:7] == STARTUP
    assert wait_until(lambda: d.recoveries == 1)
    assert d.status()["connected"] is True
    assert d.last_error is not None
    assert rig.ryuos[0].closed
    assert any(m.startswith("device: lost") for m in rig.logs)


def test_usb_loss_without_device_rescans(rig):
    d = rig.device
    d.start()
    assert wait_until(lambda: rig.coolers)
    rig.cooler.wait_for(count("all", 1))
    rig.hid_present = False
    rig.cooler.sock.close()
    assert wait_until(lambda: d.last_error == "HID interface not found", timeout=4)
    assert d.status()["connected"] is False
    assert d.submit("POST", "brightness", {"value": 1}) is None
    assert len(rig.coolers) == 1
    t0 = time.monotonic()
    d.stop(send_disconn=True)
    d.join(3)
    assert time.monotonic() - t0 < 1  # the 2 s rescan wait ends on stop


# ---------------------------------------------------------------- job queue


def test_submit_runs_job_and_reports_ack(rig):
    d = rig.device
    d.start()
    assert wait_until(lambda: rig.coolers)
    rig.cooler.wait_for(count("all", 1))
    fut = d.submit("POST", "brightness", {"value": 85})
    assert fut.result(3) == {"applied": True, "acked": True}
    assert ("POST", "brightness", {"value": 85}) in rig.cooler.received


def test_late_ack_resolves_pending_job(make_rig):
    rig = make_rig(delay={"brightness": 0.5})
    d = rig.device
    d.start()
    assert wait_until(lambda: rig.coolers)
    rig.cooler.wait_for(count("all", 1))
    t0 = time.monotonic()
    fut = d.submit("POST", "brightness", {"value": 85}, wait=0.1)
    assert fut.result(3) == {"applied": True, "acked": True}
    assert time.monotonic() - t0 >= 0.4
    assert d.pending == {}


def test_missing_ack_expires_as_unacked(make_rig, monkeypatch):
    monkeypatch.setattr(ryuod, "LATE_ACK_S", 0.3)
    rig = make_rig(silent={"brightness"})
    d = rig.device
    d.start()
    assert wait_until(lambda: rig.coolers)
    rig.cooler.wait_for(count("all", 1))
    fut = d.submit("POST", "brightness", {"value": 85}, wait=0.1)
    assert fut.result(3) == {"applied": True, "acked": False}


def test_presets_collapse_into_newest(rig):
    d = rig.device
    d.dev = object()  # submit() only checks that a device is open
    f1 = d.submit("POST", "preset", {"n": 1})
    f2 = d.submit("POST", "preset", {"n": 2})
    f3 = d.submit("POST", "brightness", {"value": 1})
    f4 = d.submit("POST", "preset", {"n": 4})
    assert [(j.cmd, j.body, len(j.futures)) for j in d.jobs] == [
        ("preset", {"n": 2}, 2),
        ("brightness", {"value": 1}, 1),
        ("preset", {"n": 4}, 1),
    ]
    d.dev = None
    d.fail_jobs()
    for f in (f1, f2, f3, f4):
        assert f.result(0) == {"applied": False, "acked": False}
    assert not d.jobs


def test_submit_while_disconnected(rig):
    assert rig.device.submit("POST", "brightness", {"value": 1}) is None


# ---------------------------------------------------------------- panel switch: standby with the heartbeat running


def test_standby_sends_disconn_and_keeps_the_heartbeat(rig):
    d = rig.device
    d.start()
    assert wait_until(lambda: rig.coolers)
    cooler = rig.cooler
    cooler.wait_for(count("all", 1))
    cooler.clear()
    fut, changed = d.set_panel(False)
    assert changed and d.panel_on is False
    assert fut.result(3) == {"applied": True, "acked": True}
    received = cooler.wait_for(count("all", 3), timeout=5)
    cmds = [c for _, c, _ in received]
    assert cmds.count("disconn") == 1
    assert ("POST", "disconn", None) in received
    assert set(cmds) == {"disconn", "all"}  # nothing else: HomeUI stays in standby on heartbeats alone
    assert d.status()["connected"] is True
    assert d.recoveries == 0


def test_standby_holds_commands_that_would_show(rig):
    d = rig.device
    d.dev = object()  # submit() only checks that a device is open
    d.set_panel(False)
    for cmd in ("brightness", "preset", "waterBlockScreenId"):
        fut = d.submit("POST", cmd, {})
        assert fut.result(0) == {"applied": False, "acked": False, "heldByStandby": True}
    d.submit("POST", "temperature", {"value": "Celsius"})
    assert [(j.method, j.cmd) for j in d.jobs] == [(ryuod.PANEL, "standby"), ("POST", "temperature")]
    d.dev = None
    d.fail_jobs()


def test_panel_on_again_shows_the_saved_state(rig):
    rig.state.update({"media": ["a.mp4"], "brightness": 60})
    d = rig.device
    d.start()
    assert wait_until(lambda: rig.coolers)
    cooler = rig.cooler
    cooler.wait_for(count("all", 1))
    d.set_panel(False)[0].result(3)
    d.submit("POST", "brightness", {"value": 30})  # held; the state is what counts
    rig.state.update({"brightness": 30, "media": ["b.mp4"]})
    cooler.clear()
    fut, changed = d.set_panel(True)
    assert changed
    assert fut.result(5) == {"applied": True, "acked": True}
    cmds = [c for _, c, _ in cooler.received if c != "all"]
    assert cmds == ["waterBlockScreen", "waterBlockScreenId", "power", "brightness"]
    bodies = {c: b for _, c, b in cooler.received}
    assert bodies["waterBlockScreenId"]["media"] == ["b.mp4"]
    assert bodies["power"] == {"event": "resume"}
    assert bodies["brightness"] == {"value": 30}
    assert d.submit("POST", "brightness", {"value": 31}).result(3) == {"applied": True, "acked": True}


def test_set_panel_to_the_state_it_is_in_sends_nothing(rig):
    d = rig.device
    d.dev = object()
    assert d.set_panel(True) == (None, False)
    assert not d.jobs
    d.dev = None


def test_set_panel_while_disconnected_is_kept_for_startup(rig):
    d = rig.device
    assert d.set_panel(False) == (None, True)
    assert d.panel_on is False
    cooler = rig.attach()
    d.startup()
    cmds = [c for _, c, _ in cooler.wait_for(count("all", 1))]
    # A reconnect or recovery in standby goes back to standby instead of showing the media.
    assert cmds == ["conn", "temperature", "disconn", "all"]
    assert d.ready


def test_run_job_frame_too_large(rig):
    cooler = rig.attach()
    job = ryuod.Job("POST", "preset", {"x": "a" * 1100})
    rig.device.run_job(job)
    res = job.futures[0].result(0)
    assert res["applied"] is False and "limit 1024" in res["error"]
    time.sleep(0.1)
    assert cooler.cmds() == []


def test_run_job_conn_updates_media(rig):
    rig.attach()
    job = ryuod.Job("POST", "conn", {"OS": "Linux"}, wait=1.5)
    rig.device.run_job(job)
    assert job.futures[0].result(0) == {"applied": True, "acked": True, "media": True}
    assert rig.device.media["preset"] == CONN_BODY["media"]["preset"]


def test_unexpected_error_in_tick_reconnects(rig, monkeypatch):
    d = rig.device
    real_tick = d.tick
    calls = []

    def tick():
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("bug")
        return real_tick()

    monkeypatch.setattr(d, "tick", tick)
    monkeypatch.setattr(d.stopping, "wait", lambda t=None: d.stopping.is_set())  # skip the 2 s pause
    d.start()
    assert wait_until(lambda: len(rig.coolers) == 2, timeout=5)
    rig.coolers[1].wait_for(count("all", 1))
    assert wait_until(lambda: d.recoveries == 1)
    assert any("unexpected RuntimeError: bug" in m for m in rig.logs)
    assert rig.ryuos[0].closed


# ---------------------------------------------------------------- end to end: HTTP -> worker -> cooler


def test_http_to_cooler(rig):
    d = ryuod.Daemon()
    d.state, d.sampler, d.device = rig.state, rig.sampler, rig.device
    rig.device.start()
    assert wait_until(lambda: rig.coolers)
    rig.cooler.wait_for(count("all", 1))
    httpd = ryuod.Server(("127.0.0.1", 0), ryuod.Handler)
    httpd.daemon_ref = d
    t = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    try:
        conn = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
        conn.request("POST", "/api/brightness", body=b'{"value":85}', headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        body = json.loads(resp.read())
        assert resp.status == 200
        assert body["applied"] is True and body["acked"] is True and body["deviceLevel"] == 212
        conn.request("POST", "/api/overlay", body=b'{"statsVisible":false}', headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        assert resp.status == 200
        json.loads(resp.read())
        conn.request("GET", "/api/state")
        state = json.loads(conn.getresponse().read())
        conn.close()
    finally:
        httpd.shutdown()
        httpd.server_close()
        t.join(2)
    received = rig.cooler.received
    assert ("POST", "brightness", {"value": 85}) in received
    preset = next(b for _, c, b in received if c == "preset")
    assert preset["sysinfoDisplay"] == [""] * 6
    assert state["device"]["connected"] is True
    assert state["device"]["product"] == "Ryuo IV Standard"
    assert state["limits"]["lastHeartbeatBytes"] > 0
