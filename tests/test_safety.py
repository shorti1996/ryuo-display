"""The conftest guard itself: it must refuse hidraw, the live pidfile, port 8746, adb and systemctl."""

import os
import socket
import subprocess
import sys

import pytest
from conftest import PROTECTED_PATHS, SafetyViolation

import ryuo_proto as P


def test_runtime_paths_point_at_tmp(runtime_dir, tmp_path):
    assert os.environ["XDG_RUNTIME_DIR"] == str(runtime_dir)
    assert os.environ["HOME"].startswith(str(tmp_path))
    assert os.environ["XDG_CONFIG_HOME"].startswith(str(tmp_path))
    assert P.PIDFILE.startswith(str(tmp_path))
    assert os.path.realpath(P.PIDFILE) not in PROTECTED_PATHS


def test_hidraw_open_is_refused(violations):
    with pytest.raises(SafetyViolation):
        os.open("/dev/hidraw0", os.O_RDWR)
    with pytest.raises(SafetyViolation):
        P.Ryuo("/dev/hidraw4")
    assert len(violations) == 2


def test_real_pidfile_is_refused(violations):
    real = sorted(PROTECTED_PATHS)[0]
    with pytest.raises(SafetyViolation), open(real):
        pass
    assert violations


def test_port_8746_is_refused(violations):
    s = socket.socket()
    try:
        with pytest.raises(SafetyViolation):
            s.bind(("127.0.0.1", 8746))
        with pytest.raises(SafetyViolation):
            s.connect(("127.0.0.1", 8746))
    finally:
        s.close()
    assert len(violations) == 2


@pytest.mark.parametrize(
    "argv",
    [
        ["systemctl", "--user", "stop", "ryuod.service"],
        ["adb", "devices"],
        [sys.executable, "/x/ryuod.py"],
        [sys.executable, "-u", "/x/ryuod.py", "-v"],
        [sys.executable, "-c", "import runpy; runpy.run_path('ryuod.py')"],
        [sys.executable, "-m", "pytest", "ryuo.py"],
    ],
)
def test_forbidden_subprocesses_are_refused(violations, argv):
    with pytest.raises(SafetyViolation):
        subprocess.run(argv, check=False)
    assert violations


def test_kill_of_foreign_pid_is_refused(violations):
    with pytest.raises(SafetyViolation):
        os.kill(1, 15)
    assert violations
