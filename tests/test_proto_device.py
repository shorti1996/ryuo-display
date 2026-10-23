"""ryuo_proto.Ryuo over a fake HID fd, hidraw discovery, and the pidfile helpers."""

import json
import os
import signal
import subprocess
import sys
import threading
import time
import types

import pytest
from fakes import FakeCooler, close_fd, hid_pair, make_ryuo, parse_request, reply_reports

import ryuo_proto as P

# The venv interpreter lives under rog-ryuo-lcd/, so its path alone contains "ryuo"; resolve it
# so the children's cmdlines hold only the words a test chooses.
PYTHON = os.path.realpath(sys.executable)
assert b"ryuo" not in PYTHON.encode(), PYTHON

# ---------------------------------------------------------------- Ryuo


@pytest.fixture
def hid():
    host_fd, dev_sock = hid_pair()
    yield host_fd, dev_sock
    close_fd(host_fd)
    dev_sock.close()


def test_write_pads_report_and_counts_seq(hid):
    host_fd, dev_sock = hid
    r = make_ryuo(host_fd)
    assert r.seq == 0
    assert r.write("POST", "brightness", {"value": 60}) == 1
    assert r.write("POST", "disconn") == 2
    first, second = dev_sock.recv(4096), dev_sock.recv(4096)
    assert len(first) == len(second) == P.REPORT_LEN + 1
    assert first[0] == 0  # hidraw report-ID byte; this descriptor has none
    assert first[1:].rstrip(b"\x00") == P.message("POST", "brightness", 1, {"value": 60})[0]
    method, cmd, headers, body = parse_request(second)
    assert (method, cmd, headers["SeqNumber"], body) == ("POST", "disconn", "2", None)


def test_write_too_large_raises_and_keeps_seq(hid):
    host_fd, dev_sock = hid
    r = make_ryuo(host_fd)
    with pytest.raises(P.FrameTooLarge) as ei:
        r.write("POST", "preset", {"x": "a" * 1100})
    assert ei.value.cmd == "preset"
    assert ei.value.size > P.REPORT_LEN
    assert "limit 1024" in str(ei.value)
    assert r.seq == 0
    dev_sock.setblocking(False)
    with pytest.raises(BlockingIOError):
        dev_sock.recv(4096)


def test_send_reads_ack_and_multi_report_reply(hid):
    host_fd, dev_sock = hid
    cooler = FakeCooler(dev_sock)
    cooler.start()
    try:
        r = make_ryuo(host_fd)
        replies = r.send("POST", "conn", {"OS": "Linux"}, wait=0.5)
        assert len(replies) == 1
        status, ack, body = P.parse_reply(replies[0])
        assert (status, ack) == (200, 2)
        assert body["product"] == "Ryuo IV Standard"
        assert len(body["media"]["custom"]) == 20
    finally:
        cooler.stop()


def test_poll_times_out_empty(hid):
    host_fd, _ = hid
    r = make_ryuo(host_fd)
    t0 = time.monotonic()
    assert r.poll(0.05) == []
    assert r.read_replies(0.05) == []
    assert time.monotonic() - t0 < 1


def test_poll_returns_first_batch(hid):
    host_fd, dev_sock = hid
    r = make_ryuo(host_fd)
    for rep in reply_reports("1 200\r\nAckNumber=5\r\n\r\n"):
        dev_sock.send(rep)
    assert r.poll(1) == ["1 200\r\nAckNumber=5\r\n\r\n"]


def test_heartbeat_sends_state_all_with_timestamp(hid):
    host_fd, dev_sock = hid
    r = make_ryuo(host_fd)
    before = int(time.time() * 1000)
    r.heartbeat()
    method, cmd, _, body = parse_request(dev_sock.recv(4096))
    assert (method, cmd) == ("STATE", "all")
    assert set(body) == {"timestamp"}
    assert before <= body["timestamp"] <= int(time.time() * 1000)


def test_verbose_prints_frames(hid, capsys):
    host_fd, dev_sock = hid
    r = make_ryuo(host_fd)
    r.verbose = True
    r.write("POST", "brightness", {"value": 5})
    dev_sock.send(reply_reports("1 200\r\nAckNumber=2\r\n\r\n")[0])
    r.poll(1)
    out = capsys.readouterr().out
    assert '>> POST brightness {"value":5}' in out
    assert "<< 1 200 | AckNumber=2 |" in out


def test_close_is_idempotent(hid):
    host_fd, _ = hid
    r = make_ryuo(host_fd)
    r.close()
    r.close()


# ---------------------------------------------------------------- hidraw discovery


def fake_sysfs(tmp_path, entries):
    nodes = []
    for name, hid_id in entries:
        node = tmp_path / "sys" / name
        (node / "device").mkdir(parents=True)
        if hid_id is not None:
            (node / "device" / "uevent").write_text(f"DRIVER=hid-generic\nHID_ID={hid_id}\nHID_NAME=x\n")
        nodes.append(str(node))
    return nodes


@pytest.mark.parametrize(
    ("hid_id", "expected"),
    [
        ("0003:00000B05:00001C76", (0x0B05, 0x1C76)),
        ("0003:00001C75:00001C76", (0x1C75, 0x1C76)),
        ("0003:00000B05:000019AF", (0x0B05, 0x19AF)),
        ("garbage", None),
        (None, None),
    ],
)
def test_hid_ids(tmp_path, hid_id, expected):
    (node,) = fake_sysfs(tmp_path, [("hidraw0", hid_id)])
    assert P.hid_ids(node) == expected


def test_find_hidraw_matches_pid_not_vid_alone(tmp_path, monkeypatch):
    nodes = fake_sysfs(
        tmp_path,
        [
            ("hidraw1", "0003:00000B05:000019AF"),  # the motherboard's Aura controller: same VID
            ("hidraw2", "0003:0000046D:0000C52B"),
            ("hidraw4", "0003:00000B05:00001C76"),
        ],
    )
    monkeypatch.setattr(P, "glob", types.SimpleNamespace(glob=lambda pattern: nodes))
    assert P.find_hidraw() == "/dev/hidraw4"


def test_find_hidraw_fw_107_vid(tmp_path, monkeypatch):
    nodes = fake_sysfs(tmp_path, [("hidraw3", "0003:00001C75:00001C76")])
    monkeypatch.setattr(P, "glob", types.SimpleNamespace(glob=lambda pattern: nodes))
    assert P.find_hidraw() == "/dev/hidraw3"


def test_find_hidraw_none(tmp_path, monkeypatch):
    nodes = fake_sysfs(tmp_path, [("hidraw1", "0003:00000B05:000019AF")])
    monkeypatch.setattr(P, "glob", types.SimpleNamespace(glob=lambda pattern: nodes))
    assert P.find_hidraw() is None


# ---------------------------------------------------------------- pidfile helpers


@pytest.fixture
def spawn():
    """Start a sleeping child with chosen argv words; a thread reaps it so /proc/<pid> vanishes on exit."""
    procs = []

    def start(*words):
        p = subprocess.Popen([PYTHON, "-c", "import time; time.sleep(30)", *words])
        procs.append(p)
        threading.Thread(target=p.wait, daemon=True).start()
        # Wait until exec has replaced the forked image, so /proc/<pid>/cmdline shows the argv.
        end = time.monotonic() + 5
        while time.monotonic() < end:
            try:
                with open(f"/proc/{p.pid}/cmdline", "rb") as f:
                    if b"time.sleep" in f.read():
                        break
            except OSError:
                pass
            time.sleep(0.01)
        return p

    yield start
    for p in procs:
        if p.poll() is None:
            p.kill()
        p.wait(5)


def write_pid(pid):
    with open(P.PIDFILE, "w") as f:
        f.write(str(pid))


def test_pidfile_lives_in_test_runtime_dir(runtime_dir):
    assert str(runtime_dir / "ryuo-play.pid") == P.PIDFILE


def test_running_driver_no_pidfile():
    assert P.running_driver() is None
    assert not P.superseded()
    assert P.stop_driver() is False


@pytest.mark.parametrize("words", [("ryuo", "play"), ("ryuod",), ("--from", "ryuod-test")])
def test_running_driver_matches_driver_cmdlines(spawn, words):
    p = spawn(*words)
    write_pid(p.pid)
    assert P.running_driver() == p.pid
    assert P.superseded()


@pytest.mark.parametrize("words", [("ryuo",), ("play",), ("something", "else")])
def test_running_driver_ignores_unrelated_process(spawn, words):
    # A stale pidfile whose pid was reused by an unrelated process must not be signalled.
    p = spawn(*words)
    write_pid(p.pid)
    assert P.running_driver() is None
    assert P.stop_driver() is False
    assert p.poll() is None


def test_running_driver_ignores_dead_pid(spawn):
    p = spawn("ryuo", "play")
    p.kill()
    p.wait(5)
    write_pid(p.pid)
    assert P.running_driver() is None


@pytest.mark.parametrize("content", ["", "abc", "12 34", "-"])
def test_running_driver_ignores_garbage(content):
    with open(P.PIDFILE, "w") as f:
        f.write(content)
    assert P.running_driver() is None


def test_running_driver_ignores_own_pid():
    P.write_pidfile()
    assert P.running_driver() is None
    assert not P.superseded()


def test_stop_driver_terminates_and_waits(spawn):
    p = spawn("ryuo", "play")
    write_pid(p.pid)
    t0 = time.monotonic()
    assert P.stop_driver(timeout=3.0) is True
    assert time.monotonic() - t0 < 2.5
    assert p.wait(2) == -signal.SIGTERM
    assert not os.path.exists(f"/proc/{p.pid}")


def test_stop_driver_gives_up_after_timeout(spawn):
    # A child that ignores SIGTERM: stop_driver still returns True once the timeout passes.
    p = subprocess.Popen(
        [
            PYTHON,
            "-c",
            "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print(1, flush=True); time.sleep(30)",
            "ryuod",
        ],
        stdout=subprocess.PIPE,
    )
    try:
        p.stdout.readline()
        write_pid(p.pid)
        t0 = time.monotonic()
        assert P.stop_driver(timeout=0.3) is True
        assert 0.25 <= time.monotonic() - t0 < 2
        assert p.poll() is None
    finally:
        p.kill()
        p.wait(5)
        p.stdout.close()


def test_write_and_remove_pidfile():
    P.write_pidfile()
    with open(P.PIDFILE) as f:
        assert f.read() == str(os.getpid())
    P.remove_pidfile()
    assert not os.path.exists(P.PIDFILE)
    P.remove_pidfile()  # already gone: no error


def test_remove_pidfile_keeps_another_drivers_pid(spawn):
    p = spawn("ryuod")
    write_pid(p.pid)
    P.remove_pidfile()
    assert os.path.exists(P.PIDFILE)
    with open(P.PIDFILE) as f:
        assert json.loads(f.read()) == p.pid


def test_superseded_after_takeover(spawn):
    P.write_pidfile()
    assert not P.superseded()
    p = spawn("ryuo", "play")
    write_pid(p.pid)
    assert P.superseded()
