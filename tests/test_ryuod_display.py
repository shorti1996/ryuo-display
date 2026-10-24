"""ryuod's second-display supervisor (ryuod.Display) with a fake ryuo_display.py.

The fake is a small Python script that reads what to do from a file in its directory each time it
starts, so one test can make it fail several times and then succeed. It prints the same status
lines as ryuo_display.py and records each start and each SIGTERM, so the tests see what the
supervisor did to it. Nothing here touches KWin, PipeWire or the cooler.
"""

import os
import sys
import time

import pytest
from fakes import FakeDisplayChild as Fake
from fakes import make_display as make
from fakes import wait_until

import ryuod


@pytest.fixture
def fake(tmp_path):
    f = Fake(tmp_path)
    f.listen("wayland-0")
    f.listen("bus")
    yield f
    f.close()


@pytest.fixture
def logs(monkeypatch):
    out = []
    monkeypatch.setattr(ryuod, "log", out.append)
    return out


@pytest.fixture
def displays():
    made = []
    yield made
    for d in made:
        assert d.stop(10), "the display thread did not stop"


def state_is(d, state):
    return lambda: d.status()["state"] == state


# ---------------------------------------------------------------- session_env


def test_session_env_keeps_a_working_wayland_display(fake):
    fake.listen("wayland-1")
    env = ryuod.session_env(fake.env("wayland-1"))
    assert env["WAYLAND_DISPLAY"] == "wayland-1"
    assert env["DBUS_SESSION_BUS_ADDRESS"] == f"unix:path={fake.run}/bus"


@pytest.mark.parametrize("value", [None, "wayland-7"])
def test_session_env_finds_the_socket_when_unset_or_stale(fake, value):
    # ryuod.service can start before Plasma exports WAYLAND_DISPLAY to the user manager.
    (fake.run / "wayland-0.lock").write_text("")
    assert ryuod.session_env(fake.env(value))["WAYLAND_DISPLAY"] == "wayland-0"


def test_session_env_keeps_a_given_bus_address(fake):
    env = fake.env()
    env["DBUS_SESSION_BUS_ADDRESS"] = "unix:path=/elsewhere"
    assert ryuod.session_env(env)["DBUS_SESSION_BUS_ADDRESS"] == "unix:path=/elsewhere"


def test_session_env_not_ready_without_wayland(tmp_path):
    f = Fake(tmp_path)
    (f.run / "wayland-0").write_text("")  # a plain file is not a compositor
    with pytest.raises(ryuod.NotReady, match="no Wayland session yet"):
        ryuod.session_env(f.env(None))


def test_session_env_not_ready_without_bus(tmp_path):
    f = Fake(tmp_path)
    f.listen("wayland-0")
    try:
        with pytest.raises(ryuod.NotReady, match="no D-Bus session bus"):
            ryuod.session_env(f.env())
    finally:
        f.close()


def test_session_env_needs_xdg_runtime_dir():
    with pytest.raises(ryuod.NotReady, match="XDG_RUNTIME_DIR"):
        ryuod.session_env({"WAYLAND_DISPLAY": "wayland-0"})


@pytest.mark.parametrize(
    ("lines", "error"),
    [
        (
            ["virtual monitor up", "error: no cooler on adb", "virtual monitor removed"],
            "no cooler on adb\nvirtual monitor removed",
        ),
        (["a", "error: first", "b", "error: krfb exited:", "  line 1", "  line 2"], "krfb exited:\n  line 1\n  line 2"),
        (["missing programs: krfb-virtualmonitor"], "missing programs: krfb-virtualmonitor"),
        ([str(i) for i in range(9)], "4\n5\n6\n7\n8"),
        ([], ""),
    ],
)
def test_display_error(lines, error):
    assert ryuod.display_error(lines) == error


# ---------------------------------------------------------------- on and off


def test_off_until_switched_on(fake, displays):
    d = make(fake)
    displays.append(d)
    time.sleep(0.2)
    assert fake.starts() == []
    assert d.status() == {
        "on": False,
        "state": "off",
        "fps": None,
        "mbps": None,
        "message": None,
        "error": None,
        "pointer": None,
        "backgroundError": None,
        "retryInS": None,
    }


@pytest.mark.parametrize(
    "line, pointer",
    [
        ("pointer: shown", {"shown": True, "reason": None}),
        (
            "pointer: not shown: screen selection was cancelled",
            {"shown": False, "reason": "screen selection was cancelled"},
        ),
        ("pointer: not shown: turned off with --no-pointer", {"shown": False, "reason": "turned off with --no-pointer"}),
        ("streaming to the panel at 10 Mb/s; stop with Ctrl-C", None),
    ],
)
def test_display_pointer(line, pointer):
    assert ryuod.display_pointer(line) == pointer


def test_pointer_status_is_reported_and_not_shown_as_the_message(fake, displays):
    d = make(fake)
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "on"))
    assert d.status()["pointer"] == {"shown": True, "reason": None}
    d.set(False)
    wait_until(state_is(d, "off"))
    assert d.status()["pointer"] is None


def test_pointer_fallback_reason_is_reported(fake, displays):
    fake.mode("nopointer")
    d = make(fake)
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "on"))
    st = d.status()
    assert st["pointer"] == {"shown": False, "reason": "screen selection was cancelled"}
    assert st["message"] == "streaming to the panel at 10 Mb/s; stop with Ctrl-C"


def test_on_reports_frame_rate_then_off_stops_the_child_cleanly(fake, displays, logs):
    d = make(fake)
    displays.append(d)
    d.set(True)
    wait_until(lambda: d.status()["fps"] is not None, what="the first frame-rate line")
    st = d.status()
    assert st["on"] is True and st["state"] == "on"
    assert (st["fps"], st["mbps"]) == (59.8, 9.7)
    assert st["message"] == "streaming to the panel at 10 Mb/s; stop with Ctrl-C"
    assert st["error"] is None
    assert fake.starts() == ["start wayland-0"]
    # Frame-rate lines arrive every 5 s; the log gets them only with -v.
    assert not any("fps" in m for m in logs)
    assert d.status()["message"] == "streaming to the panel at 10 Mb/s; stop with Ctrl-C"
    assert any("virtual monitor Virtual-RYUO is up" in m for m in logs)

    d.set(False)
    assert d.status()["on"] is False
    wait_until(state_is(d, "off"), what="off")
    assert fake.events()[-2:] == ["sigterm", "clean exit"]
    assert d.proc is None
    assert any("stopped (status 0)" in m for m in logs)
    assert len(fake.starts()) == 1


def test_switch_reports_the_next_state_at_once(fake, displays):
    d = make(fake)
    displays.append(d)
    d.set(True)
    assert d.status()["state"] == "starting"
    wait_until(state_is(d, "on"))
    d.set(False)
    assert d.status()["state"] == "stopping"
    wait_until(state_is(d, "off"))


def test_starting_shows_the_latest_line(fake, displays):
    # The child is "starting" until it prints "streaming to the panel".
    d = make(fake)
    displays.append(d)
    d.set(True)
    wait_until(lambda: d.status()["message"], what="the first line")
    st = d.status()
    assert st["state"] == "starting"
    assert st["message"] == "virtual monitor Virtual-RYUO is up, 2240x1080 at 60 Hz"
    assert st["fps"] is None
    wait_until(state_is(d, "on"), what="on")


def test_slow_teardown_is_waited_for_not_killed(fake, displays):
    # ryuo_display.py waits for the receiver to release the cooler's decoder; a SIGKILL during
    # that wait leaks the decoder. 0.8 s here stands for its usual ~10 s.
    env = fake.env()
    env["FAKE_TEARDOWN_S"] = "0.8"
    d = make(fake, environ=env, stop_s=5)
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "on"))
    d.set(False)
    wait_until(state_is(d, "stopping"), what="stopping")
    t0 = time.monotonic()
    wait_until(state_is(d, "off"), what="off")
    assert time.monotonic() - t0 > 0.5
    assert fake.events()[-1] == "clean exit"


def test_child_ignoring_sigterm_is_killed_after_stop_s(fake, displays, logs):
    fake.mode("stream ignore-term")
    d = make(fake, stop_s=0.5)
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "on"))
    t0 = time.monotonic()
    d.set(False)
    wait_until(state_is(d, "off"), what="off")
    assert time.monotonic() - t0 >= 0.5
    assert "clean exit" not in fake.events()
    assert any("killing it" in m and "ctl.restart" in m for m in logs)


def test_switch_on_again_while_stopping_restarts_after_the_exit(fake, displays):
    env = fake.env()
    env["FAKE_TEARDOWN_S"] = "0.4"
    d = make(fake, environ=env)
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "on"))
    d.set(False)
    wait_until(lambda: "sigterm" in fake.events(), what="SIGTERM")
    d.set(True)
    assert d.status()["state"] == "stopping"
    wait_until(lambda: len(fake.starts()) == 2, what="the second start")
    # The new child starts only after the old one has finished its teardown.
    assert fake.events() == ["start wayland-0", "sigterm", "clean exit", "start wayland-0"]
    wait_until(state_is(d, "on"))


def test_switch_off_and_on_before_the_stop_keeps_the_child(fake, displays):
    d = make(fake)
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "on"))
    with d.cond:  # holds the display thread off until the calls are in
        d.set(False)
        d.set(False)
        d.set(True)
    assert d.status()["state"] == "on"
    time.sleep(0.5)
    assert fake.events() == ["start wayland-0"]
    assert d.status()["state"] == "on"


def test_daemon_stop_terminates_the_child(fake, logs):
    d = make(fake)
    d.set(True)
    wait_until(state_is(d, "on"))
    assert d.stop(10)
    assert fake.events()[-2:] == ["sigterm", "clean exit"]
    assert not d.is_alive()


def test_stop_without_a_child_returns_at_once(fake):
    d = make(fake)
    t0 = time.monotonic()
    assert d.stop(5)
    assert time.monotonic() - t0 < 1


# ---------------------------------------------------------------- failures


def test_failed_start_is_retried_with_growing_backoff(fake, displays, logs):
    fake.mode("fail")
    d = make(fake, backoff=(0.3, 0.6))
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "retrying"), what="retrying")
    st = d.status()
    assert st["on"] is True
    assert st["error"] == (
        "ryuo_display.py exited with status 1: krfb-virtualmonitor exited (status 1) before PipeWire"
        " stream for Virtual-RYUO:\n  qt.qpa.wayland: could not connect to display"
    )
    assert st["retryInS"] in (0, 1)
    t0 = time.monotonic()
    wait_until(lambda: len(fake.starts()) == 2, what="the first retry")
    first = time.monotonic() - t0
    t1 = time.monotonic()
    wait_until(lambda: len(fake.starts()) == 3, what="the second retry")
    second = time.monotonic() - t1
    assert 0.2 < first < 0.6
    assert second > 0.5  # 0.6 s, the next step
    assert any("retrying in 0.3 s" in m for m in logs)

    fake.mode("stream")
    wait_until(state_is(d, "on"), what="on after the cause went away")
    assert d.status()["error"] is None


def test_switch_on_while_on_retries_at_once(fake, displays):
    # The page's "Try again now" posts on:true while the switch is already on.
    fake.mode("fail")
    d = make(fake, backoff=(30,))
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "retrying"))
    assert d.status()["retryInS"] == 30
    fake.mode("stream")
    d.set(True)
    wait_until(state_is(d, "on"), timeout=3)
    assert len(fake.starts()) == 2


def test_backoff_stays_at_its_last_step(fake, displays, logs):
    fake.mode("fail")
    d = make(fake, backoff=(0.05, 0.1))
    displays.append(d)
    d.set(True)
    wait_until(lambda: sum("retrying in" in m for m in logs) >= 4, what="four retries")
    delays = [m.rsplit("retrying in ", 1)[1] for m in logs if "retrying in" in m]
    assert delays[:4] == ["0.05 s", "0.1 s", "0.1 s", "0.1 s"]


def test_waits_for_the_wayland_session(fake, displays, tmp_path):
    (tmp_path / "late").mkdir()
    f = Fake(tmp_path / "late")
    f.listen("bus")
    d = make(fake, environ=f.env(None))  # the fake script and mode come from `fake`
    displays.append(d)
    try:
        d.set(True)
        wait_until(state_is(d, "retrying"))
        assert "no Wayland session yet" in d.status()["error"]
        assert fake.starts() == []
        f.listen("wayland-0")  # Plasma has started
        wait_until(state_is(d, "on"), what="on once the session is up")
        assert fake.starts() == ["start wayland-0"]
    finally:
        f.close()


def test_unexpected_exit_after_streaming_restarts_the_backoff(fake, displays):
    fake.mode("die")
    d = make(fake, backoff=(0.1, 5))
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "retrying"), what="the first exit")
    assert d.status()["error"] == "ryuo_display.py exited with status 1: stream to the panel failed: [Errno 32] Broken pipe"
    # Each run streams before it dies, so each retry waits the first step (0.1 s), never 5 s.
    wait_until(lambda: len(fake.starts()) >= 3, what="three starts", timeout=4)
    assert d.failures == 1


@pytest.mark.parametrize(
    ("mode", "error"),
    [
        ("nocooler", "no cooler on adb"),
        ("missing", "missing programs: krfb-virtualmonitor"),
        ("usage", "usage: ryuo_display.py"),
    ],
)
def test_permanent_error_is_not_retried(fake, displays, logs, mode, error):
    fake.mode(mode)
    d = make(fake, backoff=(0.05,))
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "error"), what="error")
    assert error in d.status()["error"]
    assert d.status()["retryInS"] is None
    time.sleep(0.4)
    assert len(fake.starts()) == 1
    assert any("not retried until the switch is turned on again" in m for m in logs)

    # Off and on again is the user's retry.
    fake.mode("stream")
    d.set(False)
    wait_until(state_is(d, "off"))
    assert d.status()["error"] is None
    d.set(True)
    wait_until(state_is(d, "on"))
    assert len(fake.starts()) == 2


def test_permanent_error_retried_when_the_cooler_reconnects(fake, displays, logs):
    token = {"v": 0}
    fake.mode("nocooler")
    d = make(fake, cooler=lambda: token["v"])
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "error"))
    time.sleep(0.2)
    assert len(fake.starts()) == 1
    token["v"] = None  # USB gone (suspend): still nothing
    time.sleep(0.2)
    assert len(fake.starts()) == 1
    fake.mode("stream")
    token["v"] = 1  # the device worker reconnected
    wait_until(state_is(d, "on"))
    assert len(fake.starts()) == 2
    assert any("cooler reconnected" in m for m in logs)


def test_program_that_cannot_run_is_permanent(fake, displays):
    d = ryuod.Display(cmd=[str(fake.dir / "nonexistent")], environ=fake.env(), backoff=(0.05,))
    d.cooler_poll = 0.05
    d.start()
    displays.append(d)
    d.set(True)
    wait_until(state_is(d, "error"))
    assert d.status()["error"].startswith(f"cannot run {fake.dir / 'nonexistent'}: ")


def test_default_command_runs_ryuo_display_unbuffered():
    d = ryuod.Display()
    assert d.cmd[1:] == ["-u", ryuod.DISPLAY_SCRIPT]
    assert d.cmd[0] in (ryuod.DISPLAY_PYTHON, sys.executable)
    assert os.path.basename(ryuod.DISPLAY_SCRIPT) == "ryuo_display.py"
