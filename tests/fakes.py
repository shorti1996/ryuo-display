"""Test doubles for the HID side: a Ryuo on a socket instead of /dev/hidraw, and a fake cooler.

A SOCK_SEQPACKET socketpair keeps report boundaries the way hidraw does: every os.write of
1 + 1024 bytes arrives as one message, and every reply report is read back whole.
"""

import contextlib
import json
import os
import select
import socket
import threading
import time
from unittest import mock

import ryuo_proto as P

FAKE_PATH = "/fake/ryuo-hidraw"


class SocketRyuo(P.Ryuo):
    """ryuo_proto.Ryuo on a socket fd. close() runs once, so a test's cleanup can never close a
    reused fd number that now belongs to something else."""

    closed = False

    def close(self):
        if not self.closed:
            self.closed = True
            super().close()


def make_ryuo(fd, path=FAKE_PATH):
    """A real ryuo_proto.Ryuo whose fd is `fd`; runs the real __init__ with os.open stubbed."""
    with mock.patch.object(P.os, "open", return_value=fd):
        return SocketRyuo(path)


def parse_request(report):
    """(method, cmd, headers, body) of one host->device report (report-ID byte first)."""
    assert len(report) == P.REPORT_LEN + 1, len(report)
    assert report[0] == 0
    text = P.decode(report[1:])
    head, _, rest = text.partition("\r\n\r\n")
    lines = head.split("\r\n")
    method, cmd, version = lines[0].split(" ")
    assert version == "1"
    headers = dict(line.split("=", 1) for line in lines[1:])
    body = json.loads(rest) if rest else None
    return method, cmd, headers, body


def reply_reports(text):
    """Device->host reports carrying one framed reply, split at 1024 bytes and zero-padded."""
    frame = P.encode(text.encode())
    return [frame[i : i + P.REPORT_LEN].ljust(P.REPORT_LEN, b"\x00") for i in range(0, len(frame), P.REPORT_LEN)]


def ack_text(seq, body=None):
    text = "" if body is None else json.dumps(body, separators=(",", ":"))
    return f"1 200\r\nAckNumber={seq + 1}\r\nContentLength={len(text.encode())}\r\nContentType=json\r\n\r\n{text}"


CONN_BODY = {
    "product": "Ryuo IV Standard",
    "version": {"firmware": "V1.0.10"},
    "sn": "TEST",
    # Long enough that the conn reply spans two reports, as FoxPodZ saw on hardware.
    "media": {
        "preset": [f"RYUO_IV_HW_Info_{i:02d}.mp4" for i in (4, 2, 1, 3)],
        "custom": [f"2026-01-26_22-07-{i:02d}-639-a-rather-long-custom-file-name.mp4" for i in range(20)],
    },
}


class FakeCooler(threading.Thread):
    """Plays SerialService + HomeUI on the far end of the socketpair.

    Every request is recorded as (method, cmd, body). Replies: the conn body for `conn`,
    {"status":{"fanLCD":...}} for `POST all` (HomeUI's ack), a plain `1 200` ack otherwise.
    `delay` maps cmd -> seconds before its ack; `silent` is a set of cmds that get no reply.
    """

    def __init__(self, sock, *, delay=None, silent=(), homeui_ack=True, conn_body=CONN_BODY):
        super().__init__(daemon=True, name="fake-cooler")
        self.sock = sock
        self.delay = dict(delay or {})
        self.silent = set(silent)
        self.homeui_ack = homeui_ack
        self.conn_body = conn_body
        self.received = []
        self.headers = []
        self.times = []
        self.cond = threading.Condition()
        self.closed = threading.Event()
        self.timers = []

    def run(self):
        try:
            while True:
                try:
                    r, _, _ = select.select([self.sock], [], [], 0.05)
                except (OSError, ValueError):  # the test closed our end to simulate USB loss
                    break
                if not r:
                    continue
                try:
                    data = self.sock.recv(4096)
                except OSError:
                    break
                if not data:
                    break
                method, cmd, headers, body = parse_request(data)
                with self.cond:
                    self.received.append((method, cmd, body))
                    self.headers.append(headers)
                    self.times.append(time.monotonic())
                    self.cond.notify_all()
                self.answer(method, cmd, int(headers["SeqNumber"]))
        finally:
            self.closed.set()

    def answer(self, method, cmd, seq):
        if cmd in self.silent:
            return
        if cmd == "conn":
            text = ack_text(seq, self.conn_body)
        elif cmd == "all" and method == "POST":
            if not self.homeui_ack:
                return
            text = ack_text(seq, {"status": {"fanLCD": "off"}})
        else:
            text = ack_text(seq)
        reports = reply_reports(text)
        wait = self.delay.get(cmd, 0)
        if wait:
            t = threading.Timer(wait, self.send_reports, (reports,))
            t.daemon = True
            self.timers.append(t)
            t.start()
        else:
            self.send_reports(reports)

    def send_reports(self, reports):
        for rep in reports:
            try:
                self.sock.send(rep)
            except OSError:
                return

    def cmds(self):
        with self.cond:
            return [c for _, c, _ in self.received]

    def wait_for(self, pred, timeout=5.0):
        """Block until pred(list of received) is true; returns the list."""
        end = time.monotonic() + timeout
        with self.cond:
            while not pred(self.received):
                left = end - time.monotonic()
                if left <= 0:
                    raise AssertionError(f"timed out; received {[c for _, c, _ in self.received]}")
                self.cond.wait(left)
            return list(self.received)

    def clear(self):
        with self.cond:
            self.received.clear()
            self.headers.clear()
            self.times.clear()

    def stop(self):
        for t in self.timers:
            t.cancel()
        with contextlib.suppress(OSError):
            self.sock.close()
        self.join(2)


def hid_pair():
    """(host fd owned by the caller, device-side socket)."""
    host, dev = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    return host.detach(), dev


def close_fd(fd):
    with contextlib.suppress(OSError):
        os.close(fd)
