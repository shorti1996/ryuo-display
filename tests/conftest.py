"""Shared fixtures and the safety net for the whole suite.

The real ryuod.service runs on the development machine and drives the cooler while these tests
run. Everything below exists so no test can touch it:

- XDG_RUNTIME_DIR, XDG_CONFIG_HOME and HOME point at temporary directories before any project
  module is imported, because ryuo_proto.PIDFILE and ryuo_tray.LOCK are computed at import time.
- The autouse `_safety` fixture re-points every runtime path at the test's tmp_path and wraps
  os.open, open, os.replace, os.remove, os.kill, socket bind/connect and subprocess.Popen. A call
  that reaches /dev/hidraw*, the real pidfile or state file, port 8746, adb, systemctl or one of
  the project scripts raises SafetyViolation and fails the test at teardown, even when the call
  happened on a worker thread that swallowed the exception.
"""

import builtins
import os
import shutil
import socket
import subprocess
import sys
import tempfile

import pytest

# Captured before anything is redirected: these are the paths the live daemon uses.
_REAL_RUNTIME = os.environ.get("XDG_RUNTIME_DIR", "/tmp")
_REAL_HOME = os.path.expanduser("~")
_REAL_CONFIG = os.environ.get("XDG_CONFIG_HOME") or os.path.join(_REAL_HOME, ".config")
PROTECTED_PATHS = {
    os.path.realpath(p)
    for p in (
        os.path.join(_REAL_RUNTIME, "ryuo-play.pid"),
        "/tmp/ryuo-play.pid",
        os.path.join(_REAL_CONFIG, "ryuo", "state.json"),
        os.path.join(_REAL_CONFIG, "ryuo", "state.json.tmp"),
        os.path.join(_REAL_CONFIG, "ryuo", "state.json.bad"),
        os.path.join(_REAL_RUNTIME, "ryuo-tray.lock"),
        os.path.join(_REAL_RUNTIME, "ryuod.log"),
    )
}
REAL_PORT = 8746
FORBIDDEN_PROGRAMS = {"adb", "systemctl"}
FORBIDDEN_SCRIPTS = ("ryuod.py", "ryuo.py", "ryuo_tray.py")

# Redirect before any test module imports ryuo_proto (PIDFILE is computed at import time).
_SESSION_DIR = tempfile.mkdtemp(prefix="ryuo-tests-")
os.environ["XDG_RUNTIME_DIR"] = os.path.join(_SESSION_DIR, "run")
os.environ["XDG_CONFIG_HOME"] = os.path.join(_SESSION_DIR, "config")
os.makedirs(os.environ["XDG_RUNTIME_DIR"], exist_ok=True)


def pytest_unconfigure(config):
    shutil.rmtree(_SESSION_DIR, ignore_errors=True)


class SafetyViolation(BaseException):
    """Derives from BaseException so `except Exception` / `except OSError` in the code under test
    cannot swallow it."""


_violations = []


def _violate(msg):
    _violations.append(msg)
    raise SafetyViolation(msg)


def _check_path(path, what):
    if isinstance(path, int):
        return
    try:
        p = os.fsdecode(path)
    except TypeError:
        return
    if p.startswith("/dev/hidraw"):
        _violate(f"{what}({p!r}): tests must never open a hidraw node")
    if os.path.realpath(p) in PROTECTED_PATHS:
        _violate(f"{what}({p!r}): this path belongs to the running ryuod")


def _addr_port(address):
    if isinstance(address, tuple) and len(address) >= 2 and isinstance(address[1], int):
        return address[1]
    return None


def _ppid(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            return int(f.read().rsplit(")", 1)[1].split()[1])
    except (OSError, ValueError, IndexError):
        return None


@pytest.fixture(autouse=True)
def _safety(monkeypatch, tmp_path):
    runtime = tmp_path / "run"
    runtime.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    monkeypatch.setenv("HOME", str(home))

    # Module-level paths computed at import time.
    import ryuo_proto

    monkeypatch.setattr(ryuo_proto, "PIDFILE", str(runtime / "ryuo-play.pid"))
    if "ryuo" in sys.modules:
        monkeypatch.setattr(sys.modules["ryuo"], "PIDFILE", str(runtime / "ryuo-play.pid"))
    if "ryuo_tray" in sys.modules:
        tray = sys.modules["ryuo_tray"]
        monkeypatch.setattr(tray, "RUNTIME", str(runtime))
        monkeypatch.setattr(tray, "LOCK", str(runtime / "ryuo-tray.lock"))
        monkeypatch.setattr(tray, "LOG", str(runtime / "ryuod.log"))
    assert os.path.realpath(ryuo_proto.PIDFILE) not in PROTECTED_PATHS

    real_os_open = os.open
    real_open = builtins.open
    real_replace = os.replace
    real_remove = os.remove
    real_kill = os.kill
    real_bind = socket.socket.bind
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_popen = subprocess.Popen

    def guarded_os_open(path, *a, **kw):
        _check_path(path, "os.open")
        return real_os_open(path, *a, **kw)

    def guarded_open(file, *a, **kw):
        # Reads count too: a test reading the real pidfile could go on to SIGTERM the daemon.
        _check_path(file, "open")
        return real_open(file, *a, **kw)

    def guarded_replace(src, dst, *a, **kw):
        _check_path(src, "os.replace")
        _check_path(dst, "os.replace")
        return real_replace(src, dst, *a, **kw)

    def guarded_remove(path, *a, **kw):
        _check_path(path, "os.remove")
        return real_remove(path, *a, **kw)

    def guarded_kill(pid, sig):
        if sig != 0 and pid != os.getpid() and _ppid(pid) != os.getpid():
            _violate(f"os.kill({pid}, {sig}): not a child of the test process")
        return real_kill(pid, sig)

    def guarded_bind(self, address):
        if _addr_port(address) == REAL_PORT:
            _violate(f"bind({address!r}): port {REAL_PORT} belongs to the running ryuod")
        return real_bind(self, address)

    def guarded_connect(self, address):
        if _addr_port(address) == REAL_PORT:
            _violate(f"connect({address!r}): tests must not talk to the running ryuod")
        return real_connect(self, address)

    def guarded_connect_ex(self, address):
        if _addr_port(address) == REAL_PORT:
            _violate(f"connect_ex({address!r}): tests must not talk to the running ryuod")
        return real_connect_ex(self, address)

    class GuardedPopen(real_popen):
        def __init__(self, args, *a, **kw):
            argv = [args] if isinstance(args, (str, bytes, os.PathLike)) else list(args)
            argv = [os.fsdecode(x) for x in argv]
            if kw.get("shell"):
                argv = " ".join(argv).split()
            if argv and os.path.basename(argv[0]) in FORBIDDEN_PROGRAMS:
                _violate(f"subprocess {argv!r}: adb and systemctl are off limits in tests")
            if any(x.endswith(FORBIDDEN_SCRIPTS) for x in argv):
                _violate(f"subprocess {argv!r}: never start the project's scripts for real")
            super().__init__(args, *a, **kw)

    monkeypatch.setattr(os, "open", guarded_os_open)
    monkeypatch.setattr(builtins, "open", guarded_open)
    monkeypatch.setattr(os, "replace", guarded_replace)
    monkeypatch.setattr(os, "remove", guarded_remove)
    monkeypatch.setattr(os, "kill", guarded_kill)
    monkeypatch.setattr(socket.socket, "bind", guarded_bind)
    monkeypatch.setattr(socket.socket, "connect", guarded_connect)
    monkeypatch.setattr(socket.socket, "connect_ex", guarded_connect_ex)
    monkeypatch.setattr(subprocess, "Popen", GuardedPopen)

    _violations.clear()
    yield runtime
    found = list(_violations)
    _violations.clear()
    if found:
        pytest.fail("safety violation(s):\n" + "\n".join(found), pytrace=False)


@pytest.fixture
def violations():
    """For the tests that prove the guard fires: hands over the list and clears it afterwards."""
    yield _violations
    _violations.clear()


@pytest.fixture
def runtime_dir(_safety):
    return _safety
