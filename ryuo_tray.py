#!/usr/bin/env python3
"""Tray icon for ryuod: show/hide stats, brightness, open the control page, start/stop.

Talks only to ryuod's HTTP API on 127.0.0.1:8746, so it can be closed and reopened without
touching the cooler. Needs python3-pyside6. The icon is red while ryuod drives the cooler,
grey while ryuod is down or the cooler is missing.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QActionGroup, QColor, QIcon, QPainter, QPixmap
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "http://127.0.0.1:8746"
BRIGHTNESS_STEPS = [25, 50, 75, 100]
LOG = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "ryuod.log")


def api(path, body=None):
    """GET, or POST when body is given. None when ryuod is not answering."""
    req = urllib.request.Request(URL + path)
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=1.5) as r:
            return json.load(r)
    except (urllib.error.URLError, OSError, ValueError):
        return None


def make_icon(color):
    pm = QPixmap(64, 64)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    p.setPen(Qt.NoPen)
    p.setBrush(QColor(color))
    p.drawRoundedRect(4, 12, 56, 40, 8, 8)  # the panel's wide shape
    p.setBrush(QColor("#ffffff"))
    for i, h in enumerate((10, 18, 26)):  # three stat bars
        p.drawRect(14 + i * 14, 44 - h, 8, h)
    p.end()
    return QIcon(pm)


class Tray:
    def __init__(self, app):
        self.state = None
        self.icons = {"on": make_icon("#E5252B"), "off": make_icon("#6b6b6b")}
        self.tray = QSystemTrayIcon(self.icons["off"], app)
        self.tray.activated.connect(self.on_activated)

        m = QMenu()
        self.status = m.addAction("…")
        self.status.setEnabled(False)
        m.addSeparator()
        self.stats = m.addAction("Show stats on panel")
        self.stats.setCheckable(True)
        self.stats.triggered.connect(lambda on: self.post("/api/overlay", {"statsVisible": on}))
        self.bright_menu = m.addMenu("Brightness")
        group = QActionGroup(m)
        self.bright = {}
        for v in BRIGHTNESS_STEPS:
            a = self.bright_menu.addAction(f"{v} %")
            a.setCheckable(True)
            group.addAction(a)
            a.triggered.connect(lambda _, v=v: self.post("/api/brightness", {"value": v}))
            self.bright[v] = a
        m.addAction("Open control page", lambda: webbrowser.open(URL + "/"))
        m.addSeparator()
        self.start = m.addAction("Start ryuod", self.start_daemon)
        self.stop = m.addAction("Stop (panel goes to standby)", self.stop_daemon)
        m.addAction("Quit tray", app.quit)
        m.aboutToShow.connect(self.refresh)
        self.menu = m  # QSystemTrayIcon does not own the menu
        self.tray.setContextMenu(m)

        self.timer = QTimer()
        self.timer.timeout.connect(self.refresh)
        self.timer.start(3000)
        self.refresh()
        self.tray.show()

    def on_activated(self, reason):
        if reason == QSystemTrayIcon.Trigger:
            webbrowser.open(URL + "/")

    def post(self, path, body):
        if api(path, body) is None:
            self.tray.showMessage("RYUO LCD", "ryuod did not answer", QSystemTrayIcon.Warning, 3000)
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
            text = f"{dev.get('product', 'RYUO IV')} · {dev.get('firmware', '')}"
        self.status.setText(text)
        self.tray.setToolTip(f"RYUO LCD — {text}")
        self.tray.setIcon(self.icons["on" if live else "off"])
        for a in (self.stats, self.bright_menu.menuAction(), self.stop):
            a.setEnabled(up)
        self.start.setVisible(not up)
        if up:
            self.stats.setChecked(cfg.get("statsVisible", True))
            for v, a in self.bright.items():
                a.setChecked(cfg.get("brightness") == v)

    def start_daemon(self):
        # Own session, so quitting the tray leaves ryuod running.
        with open(LOG, "a") as log:
            subprocess.Popen([sys.executable, "-u", os.path.join(HERE, "ryuod.py")],
                             stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
        QTimer.singleShot(4000, self.refresh)

    def stop_daemon(self):
        subprocess.run([sys.executable, os.path.join(HERE, "ryuo.py"), "stop"], check=False)
        self.refresh()


def main():
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
