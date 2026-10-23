"""ryuo_tray.py with api(), subprocess and webbrowser mocked.

PySide6 comes from the system package (python3-pyside6), not the uv venv, so under `uv run pytest`
this module is skipped. Run it with the system interpreter:

    /usr/bin/python3 -m pytest tests/test_tray.py

QT_QPA_PLATFORM defaults to offscreen below, so no display is needed.
"""

import fcntl
import http.server
import json
import os
import sys
import threading
import types
from typing import ClassVar
from unittest import mock

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")

from PySide6.QtWidgets import QApplication, QSystemTrayIcon

import ryuo_tray

CONNECTED = {
    "ok": True,
    "device": {"connected": True, "product": "Ryuo IV Standard", "firmware": "V1.0.10"},
    "config": {"statsVisible": True, "brightness": 75},
}


@pytest.fixture(scope="module")
def qapp():
    return QApplication.instance() or QApplication([])


class FakeSubprocess:
    DEVNULL = -3

    def __init__(self, unit=True):
        self.unit = unit
        self.runs = []
        self.popens = []

    def run(self, argv, **kw):
        self.runs.append(argv)
        rc = 0 if self.unit or argv[:3] != ["systemctl", "--user", "cat"] else 1
        return types.SimpleNamespace(returncode=rc)

    def Popen(self, argv, **kw):
        self.popens.append((argv, kw))
        return types.SimpleNamespace(pid=1)


@pytest.fixture
def env(qapp, monkeypatch):
    calls = []
    state = {"value": None}

    def api(path, body=None):
        calls.append((path, body))
        if path == "/api/state":
            return state["value"]
        return state.get("post", {"ok": True})

    opened = []
    sub = FakeSubprocess()
    monkeypatch.setattr(ryuo_tray, "api", api)
    monkeypatch.setattr(ryuo_tray, "webbrowser", types.SimpleNamespace(open=opened.append))
    monkeypatch.setattr(ryuo_tray, "subprocess", sub)
    return types.SimpleNamespace(calls=calls, state=state, opened=opened, sub=sub, app=qapp)


@pytest.fixture
def tray(env):
    t = ryuo_tray.Tray(env.app)
    yield t
    t.timer.stop()
    t.tray.hide()
    t.tray.deleteLater()


def is_icon(tray, name):
    return tray.tray.icon().cacheKey() == tray.icons[name].cacheKey()


# ---------------------------------------------------------------- refresh()


def test_daemon_down(env, tray):
    tray.refresh()
    assert tray.status.text() == "ryuod is not running"
    assert tray.tray.toolTip() == "RYUO LCD — ryuod is not running"
    assert is_icon(tray, "off")
    assert not tray.stats.isEnabled()
    assert not tray.bright_menu.menuAction().isEnabled()
    assert not tray.stop.isEnabled()
    assert tray.start.isVisible()
    assert env.calls[-1] == ("/api/state", None)


def test_cooler_missing(env, tray):
    env.state["value"] = {"ok": True, "device": {"connected": False}, "config": {"statsVisible": True, "brightness": 50}}
    tray.refresh()
    assert tray.status.text() == "ryuod running, cooler not connected"
    assert is_icon(tray, "off")
    assert tray.stats.isEnabled() and tray.stop.isEnabled()
    assert not tray.start.isVisible()
    assert tray.stats.isChecked()
    assert tray.bright[50].isChecked()
    assert not tray.bright[75].isChecked()


def test_connected(env, tray):
    env.state["value"] = json.loads(json.dumps(CONNECTED))
    env.state["value"]["config"]["statsVisible"] = False
    tray.refresh()
    assert tray.status.text() == "Ryuo IV Standard · V1.0.10"
    assert is_icon(tray, "on")
    assert not tray.stats.isChecked()
    assert [v for v, a in tray.bright.items() if a.isChecked()] == [75]


def test_brightness_off_the_menu_steps_checks_nothing(env, tray):
    env.state["value"] = json.loads(json.dumps(CONNECTED))
    env.state["value"]["config"]["brightness"] = 102
    tray.refresh()
    assert not any(a.isChecked() for a in tray.bright.values())


def test_state_toggles_back_to_down(env, tray):
    env.state["value"] = CONNECTED
    tray.refresh()
    env.state["value"] = None
    tray.refresh()
    assert is_icon(tray, "off")
    assert tray.start.isVisible()


@pytest.mark.xfail(
    strict=True,
    reason="BUG: ryuo_tray.py:125 uses dev.get('product', 'RYUO IV'), but ryuod's status() always sends the "
    "keys, with null before a conn reply, so the menu reads 'None · None'",
)
def test_connected_without_conn_reply_has_no_none_text(env, tray):
    env.state["value"] = {
        "ok": True,
        "device": {"connected": True, "product": None, "firmware": None},
        "config": {"statsVisible": True, "brightness": 100},
    }
    tray.refresh()
    assert "None" not in tray.status.text()


# ---------------------------------------------------------------- menu actions


def test_stats_toggle_posts_overlay(env, tray):
    env.state["value"] = CONNECTED
    tray.refresh()
    assert tray.stats.isChecked()
    tray.stats.trigger()
    assert ("/api/overlay", {"statsVisible": False}) in env.calls
    assert env.calls[-1] == ("/api/state", None)  # refreshed after the post


def test_brightness_action_posts_value(env, tray):
    env.state["value"] = CONNECTED
    tray.refresh()
    tray.bright[25].trigger()
    assert ("/api/brightness", {"value": 25}) in env.calls


def test_post_failure_shows_message(env, tray):
    env.state["post"] = None
    tray.tray = mock.MagicMock(wraps=tray.tray)
    tray.post("/api/brightness", {"value": 50})
    tray.tray.showMessage.assert_called_once()
    assert tray.tray.showMessage.call_args.args[:2] == ("RYUO LCD", "ryuod did not answer")


def test_left_click_opens_page(env, tray):
    tray.on_activated(QSystemTrayIcon.Trigger)
    assert env.opened == ["http://127.0.0.1:8746/"]
    tray.on_activated(QSystemTrayIcon.Context)
    assert env.opened == ["http://127.0.0.1:8746/"]


def test_refresh_on_menu_show_and_timer(env, tray):
    assert tray.timer.isActive()
    assert tray.timer.interval() == 3000
    n = len(env.calls)
    tray.menu.aboutToShow.emit()
    assert len(env.calls) == n + 1


# ---------------------------------------------------------------- start / stop


def test_have_unit(env):
    assert ryuo_tray.have_unit() is True
    assert env.sub.runs == [["systemctl", "--user", "cat", "ryuod.service"]]
    env.sub.unit = False
    assert ryuo_tray.have_unit() is False


def test_start_with_unit_uses_systemctl(env, tray):
    tray.start_daemon()
    assert env.sub.runs[-1] == ["systemctl", "--user", "start", "ryuod.service"]
    assert env.sub.popens == []


def test_start_without_unit_spawns_ryuod(env, tray, runtime_dir):
    env.sub.unit = False
    tray.start_daemon()
    ((argv, kw),) = env.sub.popens
    assert argv == [sys.executable, "-u", os.path.join(ryuo_tray.HERE, "ryuod.py")]
    assert kw["start_new_session"] is True
    assert kw["stdin"] == FakeSubprocess.DEVNULL
    assert kw["stdout"].name == str(runtime_dir / "ryuod.log")
    assert not any(a[:2] == ["systemctl", "--user"] and a[2] != "cat" for a in env.sub.runs)


def test_stop_with_unit(env, tray):
    tray.stop_daemon()
    runs = [r for r in env.sub.runs if r[:3] != ["systemctl", "--user", "cat"]]
    assert runs == [
        ["systemctl", "--user", "stop", "ryuod.service"],
        [sys.executable, os.path.join(ryuo_tray.HERE, "ryuo.py"), "stop"],
    ]


def test_stop_without_unit_uses_ryuo_stop(env, tray):
    env.sub.unit = False
    tray.stop_daemon()
    runs = [r for r in env.sub.runs if r[:3] != ["systemctl", "--user", "cat"]]
    assert runs == [[sys.executable, os.path.join(ryuo_tray.HERE, "ryuo.py"), "stop"]]


# ---------------------------------------------------------------- api()


class _Handler(http.server.BaseHTTPRequestHandler):
    seen: ClassVar[list] = []

    def log_message(self, *a):
        pass

    def _reply(self, data):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.seen.append(("GET", self.path, None, None))
        self._reply(b"not json" if self.path == "/bad" else b'{"ok":true}')

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.seen.append(("POST", self.path, self.headers["Content-Type"], json.loads(body)))
        self._reply(b'{"ok":true,"applied":true}')


@pytest.fixture
def local_api(monkeypatch):
    _Handler.seen = []
    srv = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
    t = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    monkeypatch.setattr(ryuo_tray, "URL", f"http://127.0.0.1:{srv.server_address[1]}")
    yield _Handler.seen
    srv.shutdown()
    srv.server_close()


def test_api_get_and_post(local_api):
    assert ryuo_tray.api("/api/state") == {"ok": True}
    assert ryuo_tray.api("/api/brightness", {"value": 50}) == {"ok": True, "applied": True}
    assert local_api == [("GET", "/api/state", None, None), ("POST", "/api/brightness", "application/json", {"value": 50})]


def test_api_bad_json_is_none(local_api):
    assert ryuo_tray.api("/bad") is None


def test_api_refused_is_none(monkeypatch):
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens there now
    monkeypatch.setattr(ryuo_tray, "URL", f"http://127.0.0.1:{port}")
    assert ryuo_tray.api("/api/state") is None


def test_api_default_url_targets_port_8746():
    assert ryuo_tray.URL == "http://127.0.0.1:8746"


# ---------------------------------------------------------------- main(): single instance


def test_lock_path_is_in_test_runtime_dir(runtime_dir):
    assert str(runtime_dir / "ryuo-tray.lock") == ryuo_tray.LOCK
    assert str(runtime_dir / "ryuod.log") == ryuo_tray.LOG


def test_second_instance_opens_page(env, monkeypatch):
    app_made = []
    monkeypatch.setattr(ryuo_tray, "QApplication", lambda argv: app_made.append(argv))
    with open(ryuo_tray.LOCK, "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert ryuo_tray.main() is None
    assert env.opened == ["http://127.0.0.1:8746/"]
    assert app_made == []


def test_first_instance_takes_lock_and_runs(env, monkeypatch):
    lock_state = []

    class FakeApp:
        def __init__(self, argv):
            pass

        def setApplicationName(self, n):
            pass

        def setDesktopFileName(self, n):
            pass

        def setQuitOnLastWindowClosed(self, v):
            pass

        def exec(self):
            # While the tray runs, a second launch cannot take the lock.
            with open(ryuo_tray.LOCK, "w") as other:
                try:
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    lock_state.append("free")
                except BlockingIOError:
                    lock_state.append("held")
            return 0

    monkeypatch.setattr(ryuo_tray, "QApplication", FakeApp)
    monkeypatch.setattr(ryuo_tray, "QSystemTrayIcon", types.SimpleNamespace(isSystemTrayAvailable=lambda: True))
    trays = []
    monkeypatch.setattr(ryuo_tray, "Tray", trays.append)
    with pytest.raises(SystemExit) as ei:
        ryuo_tray.main()
    assert ei.value.code == 0
    assert lock_state == ["held"]
    assert len(trays) == 1
    assert env.opened == []


def test_no_system_tray_exits(env, monkeypatch):
    monkeypatch.setattr(ryuo_tray, "QApplication", lambda argv: mock.MagicMock())
    monkeypatch.setattr(ryuo_tray, "QSystemTrayIcon", types.SimpleNamespace(isSystemTrayAvailable=lambda: False))
    with pytest.raises(SystemExit) as ei:
        ryuo_tray.main()
    assert ei.value.code == "ryuo_tray: no system tray available"


def test_make_icon(qapp):
    icon = ryuo_tray.make_icon("#E5252B")
    img = icon.pixmap(64, 64).toImage()
    assert img.pixelColor(8, 30).name() == "#e5252b"
    assert img.pixelColor(0, 0).alpha() == 0
