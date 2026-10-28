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

from PySide6.QtGui import QIcon
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
    assert tray.tray.toolTip() == "RYUO Display — ryuod is not running"
    assert is_icon(tray, "offline")
    assert not tray.stats.isEnabled()
    assert not tray.bright_menu.menuAction().isEnabled()
    assert not tray.stop.isEnabled()
    assert tray.start.isVisible()
    assert env.calls[-1] == ("/api/state", None)


def test_cooler_missing(env, tray):
    env.state["value"] = {"ok": True, "device": {"connected": False}, "config": {"statsVisible": True, "brightness": 50}}
    tray.refresh()
    assert tray.status.text() == "ryuod running, cooler not connected"
    assert is_icon(tray, "offline")
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
    assert is_icon(tray, "live")
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
    assert is_icon(tray, "offline")
    assert tray.start.isVisible()


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


def test_second_display_follows_state_and_posts(env, tray):
    env.state["value"] = {**CONNECTED, "display": {"on": False, "state": "off"}}
    tray.refresh()
    assert tray.display.isEnabled() and not tray.display.isChecked()
    tray.display.trigger()
    assert ("/api/display", {"on": True}) in env.calls
    env.state["value"] = {**CONNECTED, "display": {"on": True, "state": "starting"}}
    tray.refresh()
    assert tray.display.isChecked()
    assert is_icon(tray, "mirror")
    assert tray.tray.toolTip() == "RYUO Display — Ryuo IV Standard · V1.0.10 · second display"


def test_second_display_disabled_without_support_or_daemon(env, tray):
    env.state["value"] = CONNECTED  # an older ryuod: no "display" key
    tray.refresh()
    assert not tray.display.isEnabled()
    env.state["value"] = None
    tray.refresh()
    assert not tray.display.isEnabled() and not tray.display.isChecked()


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
    assert tray.tray.showMessage.call_args.args[:2] == ("RYUO Display", "ryuod did not answer")


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


def test_stop_item_names_the_daemon_not_standby(tray):
    # "Panel on" is the standby switch; this item stops ryuod.
    assert tray.stop.text() == "Stop ryuod"
    assert tray.panel.text() == "Panel on"


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


# ---------------------------------------------------------------- icons


@pytest.mark.parametrize(
    ("state", "icon"),
    [
        (None, "offline"),
        ({"device": {"connected": False}, "display": {"on": True}}, "offline"),
        (CONNECTED, "live"),  # an older ryuod: no "display" key
        ({**CONNECTED, "display": None}, "live"),
        ({**CONNECTED, "display": {"on": False, "state": "off"}}, "live"),
        ({**CONNECTED, "display": {"on": True, "state": "retrying"}}, "mirror"),
    ],
)
def test_icon_state(state, icon):
    assert ryuo_tray.icon_state(state) == icon


def test_every_icon_file_exists():
    for state in ryuo_tray.ICON_STATES:
        for path in ryuo_tray.icon_files(state):
            assert os.path.isfile(path), path
    # The desktop entry's Icon=ryuo-display.
    assert os.path.isfile(os.path.join(ryuo_tray.ICON_DIR, "hicolor", "scalable", "apps", "ryuo-display.svg"))


@pytest.fixture
def icon_theme(qapp, tmp_path):
    """Qt's icon theme pointed at tmp_path, restored afterwards."""
    paths, name = QIcon.themeSearchPaths(), QIcon.themeName()
    QIcon.setThemeSearchPaths([str(tmp_path)])
    QIcon.setThemeName("hicolor")
    yield tmp_path
    QIcon.setThemeSearchPaths(paths)
    QIcon.setThemeName(name)


def test_installed_icon_is_loaded_by_name(icon_theme, capsys):
    # The repo's icon directories under a hicolor theme, which on a real system gets its
    # index.theme from hicolor-icon-theme.
    theme = icon_theme / "hicolor"
    theme.mkdir()
    for size in ("16x16", "22x22", "scalable"):
        os.symlink(os.path.join(ryuo_tray.ICON_DIR, "hicolor", size), theme / size)
    (theme / "index.theme").write_text(
        "[Icon Theme]\nName=Hicolor\nDirectories=16x16/status,22x22/status,scalable/status\n"
        "[16x16/status]\nSize=16\nType=Fixed\n[22x22/status]\nSize=22\nType=Fixed\n"
        "[scalable/status]\nSize=22\nMinSize=8\nMaxSize=512\nType=Scalable\n"
    )
    icon = ryuo_tray.make_icon("live")
    assert icon.name() == "ryuo-display-live-symbolic"  # what Qt sends Plasma as IconName
    assert capsys.readouterr().err == ""


def test_uninstalled_icon_falls_back_to_repo_files(icon_theme, capsys):
    icon = ryuo_tray.make_icon("offline")
    assert icon.name() == ""
    assert "ryuo-display-offline-symbolic is not installed" in capsys.readouterr().err
    # Drawn, not blank: a blank one means Qt's SVG image plugin is missing.
    img = icon.pixmap(22, 22).toImage()
    assert img.pixelColor(0, 0).alpha() == 0
    assert img.pixelColor(18, 16).name() == "#da4453"  # the red error badge


# ---------------------------------------------------------------- panel switch and tray settings from ryuod

NEW = {
    **CONNECTED,
    "display": {"on": False, "state": "off"},
    "panel": {"on": True},
    "tray": {"autostart": True, "leftClick": "page", "brightnessSteps": [25, 50, 75, 100],
             "brightnessStepValues": [26, 51, 76, 102], "leftClickOptions": ["page", "menu", "panel", "stats"]},
}


def state_with(**changes):
    st = json.loads(json.dumps(NEW))
    for key, value in changes.items():
        st[key] = {**st[key], **value} if isinstance(st.get(key), dict) else value
    return st


def test_panel_item_follows_state_and_posts(env, tray):
    env.state["value"] = state_with()
    tray.refresh()
    assert tray.panel.isEnabled() and tray.panel.isChecked()
    tray.panel.trigger()
    assert ("/api/panel", {"on": False}) in env.calls
    env.state["value"] = state_with(panel={"on": False})
    tray.refresh()
    assert not tray.panel.isChecked()
    assert is_icon(tray, "standby")
    assert tray.tray.toolTip() == "RYUO Display — Ryuo IV Standard · V1.0.10 · panel in standby"
    assert not tray.display.isEnabled()  # ryuod refuses the second display in standby


def test_panel_item_disabled_while_the_second_display_is_on_or_ryuod_is_old(env, tray):
    env.state["value"] = state_with(display={"on": True, "state": "on"})
    tray.refresh()
    assert not tray.panel.isEnabled()
    env.state["value"] = CONNECTED  # no "panel" key
    tray.refresh()
    assert not tray.panel.isEnabled() and tray.panel.isChecked()


def test_brightness_steps_come_from_ryuod_and_post_percent(env, tray):
    env.state["value"] = state_with(tray={"brightnessSteps": [10, 60], "brightnessStepValues": [10, 61]},
                                    config={"brightness": 61})
    tray.refresh()
    assert visible_steps(tray) == ["10 %", "60 %"]
    assert [v for v, a in tray.bright.items() if a.isChecked()] == [60]
    tray.bright[10].trigger()
    assert ("/api/brightness", {"percent": 10}) in env.calls
    env.state["value"] = state_with(config={"brightness": 102})
    tray.refresh()
    assert visible_steps(tray) == ["25 %", "50 %", "75 %", "100 %"]
    assert [v for v, a in tray.bright.items() if a.isChecked()] == [100]
    tray.bright[25].trigger()  # the slot that showed 10 % now posts 25 %
    assert env.calls[-2] == ("/api/brightness", {"percent": 25})


def visible_steps(tray):
    return [a.text() for a in tray.bright_menu.actions() if a.isVisible()]


def test_brightness_submenu_keeps_its_items_and_only_hides_them(env, tray):
    """Plasma does not redraw a submenu after items are removed, but follows visibility changes."""
    assert ryuo_tray.STEP_SLOTS == 8  # ryuod's TRAY_STEPS_MAX
    items = list(tray.bright_menu.actions())
    assert len(items) == ryuo_tray.STEP_SLOTS
    assert all(a.actionGroup() is tray.bright_group for a in items)
    for steps in ([75, 85, 100], [75, 100], list(range(10, 90, 10)), [50]):
        env.state["value"] = state_with(tray={"brightnessSteps": steps,
                                              "brightnessStepValues": [round(s * 1.02) for s in steps]},
                                        config={"brightness": round(steps[-1] * 1.02)})
        tray.refresh()
        assert tray.bright_menu.actions() == items
        assert visible_steps(tray) == [f"{s} %" for s in steps]
        assert [a.text() for a in items if a.isChecked()] == [f"{steps[-1]} %"]
    assert not any(a.isChecked() for a in items if not a.isVisible())


def test_old_ryuod_gets_device_values(env, tray):
    env.state["value"] = CONNECTED  # no "tray" key: steps are device values, posted as "value"
    tray.refresh()
    tray.bright[50].trigger()
    assert ("/api/brightness", {"value": 50}) in env.calls


@pytest.mark.parametrize(("click", "state", "posted"), [
    ("panel", {}, ("/api/panel", {"on": False})),
    ("panel", {"panel": {"on": False}}, ("/api/panel", {"on": True})),
    ("stats", {}, ("/api/overlay", {"statsVisible": False})),
])
def test_left_click_toggles(env, tray, click, state, posted):
    env.state["value"] = state_with(tray={"leftClick": click}, **state)
    tray.refresh()
    tray.on_activated(QSystemTrayIcon.Trigger)
    assert posted in env.calls
    assert env.opened == []


def test_left_click_shows_the_menu(env, tray, monkeypatch):
    env.state["value"] = state_with(tray={"leftClick": "menu"})
    tray.refresh()
    shown = []
    monkeypatch.setattr(tray.menu, "popup", shown.append)
    tray.on_activated(QSystemTrayIcon.Trigger)
    assert len(shown) == 1 and env.opened == []


def test_left_click_toggle_with_ryuod_down_warns(env, tray):
    env.state["value"] = state_with(tray={"leftClick": "panel"})
    tray.refresh()
    env.state["value"] = None
    tray.tray = mock.MagicMock(wraps=tray.tray)
    tray.on_activated(QSystemTrayIcon.Trigger)
    assert tray.tray.showMessage.call_args.args[:2] == ("RYUO Display", "ryuod did not answer")
    assert not any(path == "/api/panel" for path, _ in env.calls)


def test_refused_post_shows_ryuods_error(env, tray):
    env.state["post"] = {"ok": False, "error": "the panel is in standby; turn it on before the second display"}
    tray.tray = mock.MagicMock(wraps=tray.tray)
    tray.post("/api/display", {"on": True})
    assert tray.tray.showMessage.call_args.args[:2] == (
        "RYUO Display", "the panel is in standby; turn it on before the second display")


def test_api_returns_the_error_body_of_a_refusal(monkeypatch):
    class Refusing(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            data = b'{"ok":false,"error":"busy"}'
            self.send_response(409)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    srv = http.server.HTTPServer(("127.0.0.1", 0), Refusing)
    t = threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    t.start()
    monkeypatch.setattr(ryuo_tray, "URL", f"http://127.0.0.1:{srv.server_address[1]}")
    try:
        assert ryuo_tray.api("/api/panel", {"on": False}) == {"ok": False, "error": "busy"}
    finally:
        srv.shutdown()
        srv.server_close()
