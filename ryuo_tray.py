#!/usr/bin/env python3
"""Tray icon for ryuod: panel on/standby, show/hide stats, brightness, open the control page, start/stop.

Talks only to ryuod's HTTP API on 127.0.0.1:8746, so it can be closed and reopened without
touching the cooler. Needs python3-pyside6. The icon shows the pump while ryuod drives the
cooler, a pointer on it while the panel is a second display, and is dimmed with a red badge
while ryuod is down or the cooler is missing.

The left-click action and the brightness steps are set on the control page and saved by ryuod;
the tray takes them from /api/state on its next poll (every 3 s, and when the menu opens).

Icons are loaded by theme name from the hicolor tree that `make install` copies from
packaging/icons, so Plasma draws its own 16 or 22 px SVG in the panel's text colour.

One tray per session: launching it again (e.g. from the start menu while the autostarted one
runs) opens the control page instead. Start/Stop go through the ryuod.service user unit when
it is installed, so systemd keeps tracking the daemon.
"""
import fcntl
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser

from PySide6.QtCore import QTimer
from PySide6.QtGui import QActionGroup, QCursor, QIcon
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "packaging", "icons")
# "standby": the panel switch is on standby (/api/state "panel": {"on": false}), ryuod still running.
ICON_STATES = ("live", "mirror", "standby", "offline")
URL = "http://127.0.0.1:8746"
BRIGHTNESS_STEPS = [25, 50, 75, 100]  # % of the backlight, until ryuod sends its saved steps
STEP_SLOTS = 8  # items in the Brightness submenu: the most steps ryuod accepts (TRAY_STEPS_MAX)
RUNTIME = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
LOG = os.path.join(RUNTIME, "ryuod.log")
LOCK = os.path.join(RUNTIME, "ryuo-tray.lock")
UNIT = "ryuod.service"


def have_unit():
    return subprocess.run(["systemctl", "--user", "cat", UNIT],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def api(path, body=None):
    """GET, or POST when body is given. None when ryuod is not answering; ryuod's {"ok": false,
    "error": ...} when it refused the request."""
    req = urllib.request.Request(URL + path)
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=1.5) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except (OSError, ValueError):
            return None
    except (urllib.error.URLError, OSError, ValueError):
        return None


def icon_name(state):
    return f"ryuo-display-{state}-symbolic"


def icon_files(state):
    """The repo's SVGs for one state, smallest first."""
    return [os.path.join(ICON_DIR, "hicolor", size, "status", icon_name(state) + ".svg")
            for size in ("16x16", "22x22", "scalable")]


def make_icon(state):
    """A theme icon, so Qt hands Plasma only the name and Plasma recolours the SVG for the panel.

    Qt sends no pixels with a named icon, so the name is only usable when Plasma can find it too:
    in an installed icon theme, not in this checkout. Before `make install` the repo's files are
    used instead; Plasma gets them as pixels, in the files' default dark text colour."""
    icon = QIcon.fromTheme(icon_name(state))
    if icon.isNull():
        print(f"ryuo_tray: {icon_name(state)} is not installed (make install), using the repo's files",
              file=sys.stderr)
        icon = QIcon()
        for path in icon_files(state):
            icon.addFile(path)
    return icon


def icon_state(state):
    """Which tray icon a /api/state reply (None when ryuod is down) calls for."""
    if state is None or not state["device"].get("connected"):
        return "offline"
    if (state.get("display") or {}).get("on"):
        return "mirror"
    if (state.get("panel") or {}).get("on") is False:
        return "standby"
    return "live"


class Tray:
    def __init__(self, app):
        self.state = None
        self.left_click = "page"  # ryuod's tray.leftClick: page, menu, panel or stats
        self.icons = {s: make_icon(s) for s in ICON_STATES}
        self.tray = QSystemTrayIcon(self.icons["offline"], app)
        self.tray.activated.connect(self.on_activated)

        m = QMenu()
        self.status = m.addAction("…")
        self.status.setEnabled(False)
        m.addSeparator()
        self.panel = m.addAction("Panel on")
        self.panel.setCheckable(True)
        self.panel.triggered.connect(lambda on: self.post("/api/panel", {"on": on}))
        self.stats = m.addAction("Show stats on panel")
        self.stats.setCheckable(True)
        self.stats.triggered.connect(lambda on: self.post("/api/overlay", {"statsVisible": on}))
        self.display = m.addAction("Use panel as second display")
        self.display.setCheckable(True)
        self.display.triggered.connect(lambda on: self.post("/api/display", {"on": on}))
        self.bright_menu = m.addMenu("Brightness")
        self.bright_group = QActionGroup(m)
        # A fixed set of STEP_SLOTS items, shown or hidden: Plasma does not redraw a submenu after
        # items are removed from it, and keeps showing them, but it does follow visibility changes.
        self.bright_slots = []
        self.bright_bodies = [None] * STEP_SLOTS  # what each slot posts to /api/brightness
        for i in range(STEP_SLOTS):
            a = self.bright_menu.addAction("")
            a.setCheckable(True)
            a.setVisible(False)
            self.bright_group.addAction(a)
            a.triggered.connect(lambda _, i=i: self.post("/api/brightness", self.bright_bodies[i]))
            self.bright_slots.append(a)
        self.bright = {}  # step -> its slot, for the visible slots
        self.steps = None  # (steps, device values) the slots show
        self.build_brightness(BRIGHTNESS_STEPS, None)
        m.addAction("Open control page", lambda: webbrowser.open(URL + "/"))
        m.addSeparator()
        self.start = m.addAction("Start ryuod", self.start_daemon)
        self.stop = m.addAction("Stop ryuod", self.stop_daemon)
        m.addAction("Quit tray", app.quit)
        m.aboutToShow.connect(self.refresh)
        self.menu = m  # QSystemTrayIcon does not own the menu
        self.tray.setContextMenu(m)

        self.timer = QTimer()
        self.timer.timeout.connect(self.refresh)
        self.timer.start(3000)
        self.refresh()
        self.tray.show()

    def build_brightness(self, steps, values):
        """Show one checkable slot per step, in % of the backlight, and hide the rest. values: the
        device-scale value of each step from ryuod, or None for a ryuod from before the steps were
        saved, which takes the step as the device value itself. Never adds or removes items."""
        steps = list(steps)[:STEP_SLOTS]
        values = None if values is None else list(values)[:STEP_SLOTS]
        if self.steps == (steps, values):
            return
        self.steps = (steps, values)
        self.bright = {}
        for i, a in enumerate(self.bright_slots):
            if i < len(steps):
                v = steps[i]
                a.setText(f"{v} %")
                a.setData(v if values is None else values[i])  # the config.brightness that checks it
                self.bright_bodies[i] = {"value": v} if values is None else {"percent": v}
                self.bright[v] = a
                a.setVisible(True)
            else:
                a.setChecked(False)
                a.setVisible(False)
                self.bright_bodies[i] = None

    def on_activated(self, reason):
        if reason != QSystemTrayIcon.Trigger:
            return
        if self.left_click == "menu":
            self.menu.popup(QCursor.pos())
            return
        if self.left_click in ("panel", "stats"):
            self.refresh()  # toggle from what ryuod reports now, not from the last poll
            if self.state is None:
                self.tray.showMessage("RYUO Display", "ryuod did not answer", QSystemTrayIcon.Warning, 3000)
            elif self.left_click == "panel":
                self.post("/api/panel", {"on": not self.state.get("panel", {}).get("on", True)})
            else:
                self.post("/api/overlay", {"statsVisible": not self.state["config"].get("statsVisible", True)})
            return
        webbrowser.open(URL + "/")

    def post(self, path, body):
        res = api(path, body)
        if res is None:
            self.tray.showMessage("RYUO Display", "ryuod did not answer", QSystemTrayIcon.Warning, 3000)
        elif res.get("ok") is False:
            self.tray.showMessage("RYUO Display", res.get("error") or "ryuod refused", QSystemTrayIcon.Warning, 3000)
        self.refresh()

    def refresh(self):
        self.state = api("/api/state")
        up = self.state is not None
        dev = self.state["device"] if up else {}
        cfg = self.state["config"] if up else {}
        live = up and dev.get("connected")
        if not up:
            text = "ryuod is not running"
        elif not live:
            text = "ryuod running, cooler not connected"
        else:
            # ryuod sends both keys as null until the cooler answers conn.
            text = " · ".join(filter(None, [dev.get("product") or "RYUO IV", dev.get("firmware")]))
        self.status.setText(text)
        icon = icon_state(self.state)
        extra = {"mirror": " · second display", "standby": " · panel in standby"}.get(icon, "")
        self.tray.setToolTip(f"RYUO Display — {text}{extra}")
        self.tray.setIcon(self.icons[icon])
        for a in (self.stats, self.bright_menu.menuAction(), self.stop):
            a.setEnabled(up)
        # A ryuod from before the second display sends no "display" key, and one from before the
        # panel switch and the tray settings no "panel" or "tray" key.
        display = self.state.get("display") if up else None
        display_on = bool(display and display.get("on"))
        panel = self.state.get("panel") if up else None
        panel_on = not panel or panel.get("on", True)
        # ryuod refuses standby while the second display is on, and the second display in standby.
        self.display.setEnabled(display is not None and panel_on)
        self.display.setChecked(display_on)
        self.panel.setEnabled(panel is not None and not display_on)
        self.panel.setChecked(panel_on)
        self.start.setVisible(not up)
        tray = self.state.get("tray") if up else None
        if tray:
            self.left_click = tray.get("leftClick", "page")
            self.build_brightness(tray.get("brightnessSteps") or BRIGHTNESS_STEPS, tray.get("brightnessStepValues"))
        if up:
            self.stats.setChecked(cfg.get("statsVisible", True))
            for a in self.bright.values():
                a.setChecked(cfg.get("brightness") == a.data())

    def start_daemon(self):
        if have_unit():
            subprocess.run(["systemctl", "--user", "start", UNIT], check=False)
        else:
            # Own session, so quitting the tray leaves ryuod running.
            with open(LOG, "a") as log:
                subprocess.Popen([sys.executable, "-u", os.path.join(HERE, "ryuod.py")],
                                 stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
        QTimer.singleShot(4000, self.refresh)

    def stop_daemon(self):
        # ryuod exits 0 on SIGTERM, so the unit's Restart=on-failure leaves it stopped.
        if have_unit():
            subprocess.run(["systemctl", "--user", "stop", UNIT], check=False)
        # Also covers a `ryuo.py play` or a hand-started ryuod holding the pidfile.
        subprocess.run([sys.executable, os.path.join(HERE, "ryuo.py"), "stop"], check=False)
        self.refresh()


def main():
    lock = open(LOCK, "w")  # noqa: SIM115 - open for the life of the process; closing it drops the flock
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        webbrowser.open(URL + "/")
        return
    app = QApplication(sys.argv)
    app.setApplicationName("ryuo-tray")
    app.setDesktopFileName("ryuo-tray")
    app.setQuitOnLastWindowClosed(False)
    if not QSystemTrayIcon.isSystemTrayAvailable():
        sys.exit("ryuo_tray: no system tray available")
    tray = Tray(app)  # noqa: F841 — keeps the tray alive
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
