"""ryuo.py (CLI) parsing and dispatch, and ryuod.main()'s lifecycle, with the device mocked."""

import contextlib
import json
import os
import subprocess
import sys
import threading
import time
import types
from typing import ClassVar

import pytest

import ryuo
import ryuo_proto as P
import ryuod

PYTHON = os.path.realpath(sys.executable)  # a path without "ryuo" in it, see test_proto_device


class FakeDev:
    instances: ClassVar[list] = []

    def __init__(self, path):
        self.path = path
        self.verbose = False
        self.sent = []
        self.heartbeats = 0
        self.replies = {}
        self.raise_on = {}
        self.on_heartbeat = None
        FakeDev.instances.append(self)

    def send(self, method, cmd, content=None, wait=0.3):
        self.sent.append((method, cmd, content))
        if cmd in self.raise_on:
            raise self.raise_on[cmd]
        return self.replies.get(cmd, [])

    def heartbeat(self):
        self.heartbeats += 1
        if self.on_heartbeat:
            self.on_heartbeat(self)


@pytest.fixture
def cli(monkeypatch):
    FakeDev.instances = []
    monkeypatch.setattr(ryuo, "Ryuo", FakeDev)
    monkeypatch.setattr(ryuo, "find_hidraw", lambda: "/fake/ryuo-hidraw")
    adb_calls = []
    monkeypatch.setattr(ryuo, "adb", lambda *a: adb_calls.append(a))
    handlers = {}
    monkeypatch.setattr(ryuo.signal, "signal", lambda sig, fn: handlers.__setitem__(sig, fn))
    monkeypatch.setattr(ryuo, "time", types.SimpleNamespace(sleep=lambda s: None))

    def run(*argv):
        monkeypatch.setattr(sys, "argv", ["ryuo.py", *argv])
        ryuo.main()
        return FakeDev.instances[-1] if FakeDev.instances else None

    run.adb = adb_calls
    run.handlers = handlers
    return run


@pytest.fixture
def spawn():
    procs = []

    def start(*words):
        p = subprocess.Popen(
            [PYTHON, "-c", "import time; print(1, flush=True); time.sleep(30)", *words], stdout=subprocess.PIPE
        )
        p.stdout.readline()
        procs.append(p)
        threading.Thread(target=p.wait, daemon=True).start()
        return p

    yield start
    for p in procs:
        if p.poll() is None:
            p.kill()
        p.wait(5)
        p.stdout.close()


def write_pid(pid):
    with open(P.PIDFILE, "w") as f:
        f.write(str(pid))


# ---------------------------------------------------------------- argument parsing


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["nope"],
        ["play"],
        ["play", "a.mp4", "--mode", "single"],
        ["play", "a.mp4", "--ratio", "21:9"],
        ["brightness"],
        ["brightness", "high"],
        ["raw", "POST"],
        ["push"],
    ],
)
def test_bad_arguments_exit_2(cli, argv, capsys):
    with pytest.raises(SystemExit) as ei:
        cli(*argv)
    assert ei.value.code == 2
    assert FakeDev.instances == []


def test_aliases():
    assert ryuo.running_player is P.running_driver
    assert ryuo.stop_player is P.stop_driver


def test_find_hidraw_exits_when_missing(monkeypatch):
    monkeypatch.setattr(P, "find_hidraw", lambda: None)
    with pytest.raises(SystemExit) as ei:
        ryuo.find_hidraw()
    assert ei.value.code == "RYUO IV HID interface not found"
    monkeypatch.setattr(P, "find_hidraw", lambda: "/fake/hidraw7")
    assert ryuo.find_hidraw() == "/fake/hidraw7"


def test_media_config_pads_and_sends_settings(monkeypatch):
    monkeypatch.setattr(P, "local_timezone", lambda: "Europe/Warsaw")
    cfg = ryuo.media_config(["a.mp4"], "Single", "2:1", ["CPU Temperature"])
    assert cfg["sysinfoDisplay"] == ["CPU Temperature", "", "", "", "", ""]
    assert cfg["settings"] == P.settings("#E5252B", "#FFFFFF")
    assert cfg["media"] == ["a.mp4"]
    assert cfg["timeZone"] == "Europe/Warsaw"


# ---------------------------------------------------------------- dispatch


def test_push_uses_adb_only(cli):
    assert cli("push", "/some/dir/clip.mp4") is None
    assert cli.adb == [("push", "/some/dir/clip.mp4", "/sdcard/pcMedia/clip.mp4")]


def test_adb_helper_runs_adb(monkeypatch):
    calls = []
    monkeypatch.setattr(ryuo.subprocess, "run", lambda argv, check: calls.append((argv, check)))
    ryuo.adb("push", "a", "b")
    assert calls == [(["adb", "push", "a", "b"], True)]


def test_info_prints_conn_body(cli, capsys, monkeypatch):
    def fake(path):
        dev = FakeDev(path)
        dev.replies["conn"] = ['1 200\r\nAckNumber=2\r\n\r\n{"product":"Ryuo IV Standard"}']
        return dev

    monkeypatch.setattr(ryuo, "Ryuo", fake)
    dev = cli("info")
    assert dev.sent == [("POST", "conn", {"OS": "Linux"})]
    assert capsys.readouterr().out == '{"product":"Ryuo IV Standard"}\n'


def test_brightness(cli):
    dev = cli("-v", "brightness", "60")
    assert dev.path == "/fake/ryuo-hidraw"
    assert dev.verbose is True
    assert dev.sent == [("POST", "brightness", {"value": 60})]


def test_raw_with_and_without_json(cli):
    dev = cli("raw", "POST", "waterBlockScreen", '{"enable":true}')
    assert dev.verbose is True
    assert dev.sent == [("POST", "waterBlockScreen", {"enable": True})]
    dev = cli("raw", "GET", "conn")
    assert dev.sent == [("GET", "conn", None)]


def test_raw_bad_json_raises(cli):
    with pytest.raises(ValueError):
        cli("raw", "POST", "x", "{nope")


def test_frame_too_large_exits_with_message(cli, monkeypatch):
    def fake(path):
        dev = FakeDev(path)
        dev.raise_on["brightness"] = P.FrameTooLarge("brightness", 2000)
        return dev

    monkeypatch.setattr(ryuo, "Ryuo", fake)
    with pytest.raises(SystemExit) as ei:
        cli("brightness", "5")
    assert ei.value.code == "brightness: frame is 2000 bytes, limit 1024"


def test_stop_without_driver_sends_disconn(cli):
    dev = cli("stop")
    assert dev.sent == [("POST", "disconn", None)]


def test_stop_with_driver_signals_it(cli, spawn):
    p = spawn("ryuod.py")
    write_pid(p.pid)
    assert cli("stop") is None  # no device opened: the driver sends its own disconn on exit
    assert p.wait(3) < 0


def test_stop_works_without_cooler(monkeypatch, spawn):
    monkeypatch.setattr(P, "find_hidraw", lambda: None)
    p = spawn("ryuod.py")
    write_pid(p.pid)
    monkeypatch.setattr(sys, "argv", ["ryuo.py", "stop"])
    with contextlib.suppress(SystemExit):
        ryuo.main()
    assert p.wait(1) < 0


# ---------------------------------------------------------------- play


def test_play_sequence_and_takeover(cli, monkeypatch):
    monkeypatch.setattr(P, "local_timezone", lambda: "Europe/Warsaw")
    seen_pidfile = []
    checks = iter([False, False, False, True, True])

    def superseded():
        if not seen_pidfile:
            with open(P.PIDFILE) as f:
                seen_pidfile.append(int(f.read()))
        return next(checks)

    monkeypatch.setattr(ryuo, "superseded", superseded)
    dev = cli(
        "play", "a.mp4", "b.mp4", "--mode", "Cycle", "--ratio", "16:9", "--sysinfo", "CPU Temperature", "--brightness", "70"
    )
    assert [c for _, c, _ in dev.sent] == ["conn", "waterBlockScreen", "waterBlockScreenId", "power", "brightness"]
    bodies = {c: b for _, c, b in dev.sent}
    assert bodies["conn"] == {"OS": "Linux"}
    assert bodies["waterBlockScreen"] == {"enable": True}
    assert bodies["waterBlockScreenId"] == ryuo.media_config(["a.mp4", "b.mp4"], "Cycle", "16:9", ["CPU Temperature"])
    assert bodies["power"] == {"event": "resume"}
    assert bodies["brightness"] == {"value": 70}
    assert dev.heartbeats == 3
    assert seen_pidfile == [os.getpid()]  # pidfile claimed before the setup
    assert ryuo.signal.SIGTERM in cli.handlers
    assert not os.path.exists(P.PIDFILE)  # it named us, so it is removed


def test_play_ctrl_c_sends_disconn(cli, monkeypatch):
    monkeypatch.setattr(ryuo, "superseded", lambda: False)

    def fake(path):
        dev = FakeDev(path)

        def hb(d):
            if d.heartbeats == 2:
                raise KeyboardInterrupt

        dev.on_heartbeat = hb
        return dev

    monkeypatch.setattr(ryuo, "Ryuo", fake)
    dev = cli("play", "a.mp4")
    assert dev.sent[-1] == ("POST", "disconn", None)
    assert bodies_of(dev)["brightness"] == {"value": 100}
    assert not os.path.exists(P.PIDFILE)


def test_play_sigterm_handler_exits_cleanly(cli, monkeypatch):
    monkeypatch.setattr(ryuo, "superseded", lambda: False)

    def fake(path):
        dev = FakeDev(path)
        dev.on_heartbeat = lambda d: cli.handlers[ryuo.signal.SIGTERM](15, None)
        return dev

    monkeypatch.setattr(ryuo, "Ryuo", fake)
    with pytest.raises(SystemExit) as ei:
        cli("play", "a.mp4")
    assert ei.value.code == 0
    dev = FakeDev.instances[-1]
    assert dev.sent[-1] == ("POST", "disconn", None)
    assert not os.path.exists(P.PIDFILE)


def test_play_stops_previous_driver_first(cli, monkeypatch, spawn):
    p = spawn("ryuo.py", "play")
    write_pid(p.pid)
    monkeypatch.setattr(ryuo, "superseded", lambda: True)
    dev = cli("play", "a.mp4")
    assert p.wait(3) < 0
    assert "disconn" not in [c for _, c, _ in dev.sent]  # superseded: the new owner keeps the screen


def bodies_of(dev):
    return {c: b for _, c, b in dev.sent}


# ---------------------------------------------------------------- ryuod.main / bind


class FakeHttpd:
    def __init__(self):
        self.served = threading.Event()
        self.shut = False

    def serve_forever(self, poll_interval=0.5):
        self.served.set()

    def shutdown(self):
        self.shut = True

    def server_close(self):
        self.closed = True


class FakeThread:
    def __init__(self, *a):
        self.args = a
        self.started = False
        self.stop_ev = threading.Event()
        self.stopped_with = None

    def start(self):
        self.started = True

    def stop(self, send_disconn):
        self.stopped_with = send_disconn

    def join(self, timeout=None):
        pass


class FakeDisplay:
    """ryuod.Display without a child process; records the switch and the order of shutdown."""

    def __init__(self, events, **kw):
        self.events, self.kw = events, kw
        self.started = False
        self.wanted = []

    def start(self):
        self.started = True

    def set(self, on):
        self.wanted.append(on)

    def status(self):
        return {"on": bool(self.wanted and self.wanted[-1]), "state": "on" if self.wanted and self.wanted[-1] else "off"}

    def stop(self, timeout):
        self.events.append(("display stop", timeout))
        return True


@pytest.fixture
def daemon_main(monkeypatch, tmp_path):
    made = {}
    httpd = FakeHttpd()
    monkeypatch.setattr(ryuod, "VERBOSE", False)

    def bind(port):
        made["port"] = port
        return httpd

    monkeypatch.setattr(ryuod, "bind", bind)
    monkeypatch.setattr(ryuod, "Sampler", lambda st: made.setdefault("sampler", FakeThread(st)))
    monkeypatch.setattr(ryuod, "Device", lambda st, s, mode: made.setdefault("device", FakeThread(st, s, mode)))
    events = made["events"] = []
    monkeypatch.setattr(ryuod, "Display", lambda **kw: made.setdefault("display", FakeDisplay(events, **kw)))
    monkeypatch.setattr(ryuod, "log", lambda msg: made.setdefault("log", []).append(msg))
    handlers = {}
    monkeypatch.setattr(ryuod.signal, "signal", lambda sig, fn: handlers.__setitem__(sig, fn))
    stopped = []
    monkeypatch.setattr(P, "stop_driver", lambda: stopped.append(1) or False)
    state = str(tmp_path / "st" / "state.json")
    monkeypatch.setattr(sys, "argv", ["ryuod.py", "-v", "--port", "9999", "--state", state, "--heartbeat", "state"])
    made.update(httpd=httpd, handlers=handlers, stopped=stopped, state=state)
    return made


def test_ryuod_main_sigterm_sends_disconn(daemon_main, monkeypatch):
    monkeypatch.setattr(P, "superseded", lambda: False)
    monkeypatch.setattr(P, "running_driver", lambda: None)

    def fire():
        while ryuod.signal.SIGTERM not in daemon_main["handlers"]:
            time.sleep(0.01)
        with open(P.PIDFILE) as f:
            daemon_main["pid_seen"] = int(f.read())
        daemon_main["handlers"][ryuod.signal.SIGTERM](15, None)

    t = threading.Thread(target=fire, daemon=True)
    t.start()
    t0 = time.monotonic()
    ryuod.main()
    t.join(2)
    assert time.monotonic() - t0 < 2
    assert daemon_main["port"] == 9999
    assert ryuod.VERBOSE is True
    assert daemon_main["stopped"] == [1]  # newest driver wins
    assert daemon_main["pid_seen"] == os.getpid()
    dev = daemon_main["device"]
    assert dev.started and dev.args[2] == "state"
    assert dev.args[0].path == daemon_main["state"]
    assert daemon_main["sampler"].started
    assert daemon_main["sampler"].stop_ev.is_set()
    assert daemon_main["httpd"].shut
    assert dev.stopped_with is True  # nobody took over: send disconn
    assert ryuod.signal.SIGINT in daemon_main["handlers"]
    assert not os.path.exists(P.PIDFILE)
    display = daemon_main["display"]
    assert display.started
    assert display.wanted == []  # switch off in a fresh state: nothing started
    assert daemon_main["httpd"].closed  # the port is free while the second display stops


def run_main_until_sigterm(daemon_main):
    def fire():
        while ryuod.signal.SIGTERM not in daemon_main["handlers"]:
            time.sleep(0.01)
        daemon_main["handlers"][ryuod.signal.SIGTERM](15, None)

    t = threading.Thread(target=fire, daemon=True)
    t.start()
    ryuod.main()
    t.join(2)


def test_ryuod_main_restores_second_display(daemon_main, monkeypatch):
    monkeypatch.setattr(P, "superseded", lambda: False)
    monkeypatch.setattr(P, "running_driver", lambda: None)
    os.makedirs(os.path.dirname(daemon_main["state"]))
    with open(daemon_main["state"], "w") as f:
        json.dump({"secondDisplay": True}, f)
    run_main_until_sigterm(daemon_main)
    display = daemon_main["display"]
    assert display.started and display.wanted == [True]
    assert any("switch saved on" in m for m in daemon_main["log"])


def test_ryuod_main_stops_second_display_before_the_device(daemon_main, monkeypatch):
    monkeypatch.setattr(P, "superseded", lambda: False)
    monkeypatch.setattr(P, "running_driver", lambda: None)
    dev_stop = FakeThread.stop

    def stop(self, send_disconn):
        daemon_main["events"].append(("device stop", send_disconn))
        dev_stop(self, send_disconn)

    monkeypatch.setattr(FakeThread, "stop", stop)
    run_main_until_sigterm(daemon_main)
    # The heartbeat keeps HomeUI out of standby while ryuo_display.py tears down, which takes
    # about 10 s; it is never cut short.
    assert daemon_main["events"] == [("display stop", ryuod.DISPLAY_STOP_S + 5), ("device stop", True)]


def test_ryuod_main_display_cooler_token(daemon_main, monkeypatch):
    monkeypatch.setattr(P, "superseded", lambda: False)
    monkeypatch.setattr(P, "running_driver", lambda: None)
    run_main_until_sigterm(daemon_main)
    cooler = daemon_main["display"].kw["cooler"]
    dev = daemon_main["device"]
    dev.recoveries = 3
    dev.status = lambda: {"connected": False}
    assert cooler() is None
    dev.status = lambda: {"connected": True}
    assert cooler() == 3


def test_ryuod_main_takeover_skips_disconn(daemon_main, monkeypatch, spawn):
    p = spawn("ryuo.py", "play")
    monkeypatch.setattr(P, "superseded", lambda: True)
    monkeypatch.setattr(P, "running_driver", lambda: p.pid)
    ryuod.main()
    assert daemon_main["device"].stopped_with is False
    assert any("took over" in m for m in daemon_main["log"])
    assert p.poll() is None  # the new owner is left running


def test_bind_ephemeral_port():
    httpd = ryuod.bind(0)
    try:
        host, port = httpd.server_address
        assert host == "127.0.0.1" and port != 8746
    finally:
        httpd.server_close()


def test_bind_port_taken_by_other_process_exits(monkeypatch):
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen()
    port = s.getsockname()[1]
    stopped = []
    monkeypatch.setattr(P, "stop_driver", lambda: stopped.append(1))
    try:
        with pytest.raises(SystemExit) as ei:
            ryuod.bind(port)
    finally:
        s.close()
    assert f"cannot bind 127.0.0.1:{port}" in str(ei.value.code)
    assert stopped == []  # an unrelated holder is never signalled


def test_is_ryuod(spawn):
    assert ryuod.is_ryuod(spawn("ryuod.py").pid)
    assert not ryuod.is_ryuod(spawn("ryuo.py", "play").pid)
    assert not ryuod.is_ryuod(2**22 + 12345)
