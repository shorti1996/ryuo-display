"""ryuo_display: argument checks, the commands it runs, PipeWire graph lookups, GDP framing, the
delimiter-ahead framing the receiver relies on, and the teardown order. Nothing here runs adb,
krfb-virtualmonitor, PipeWire tools or GStreamer.
"""

import contextlib
import os
import re
import signal
import socket
import struct
import types

import pytest

import ryuo_display as D

# ---------------------------------------------------------------- arguments


def test_defaults():
    a = D.parse_args([])
    assert (a.bitrate, a.scale, a.name, a.port, a.serial, a.verbose) == (10, None, "RYUO", 27183, None, False)
    assert (a.no_pointer, a.dialog_timeout) == (False, D.DIALOG_TIMEOUT)


@pytest.mark.parametrize(
    "argv",
    [
        ["--bitrate", "1"],
        ["--bitrate", "41"],
        ["--scale", "0.5"],
        ["--scale", "1.3"],
        ["--scale", "3.25"],
        ["--name", "has space"],
        ["--name", "a/b"],
        ["--name", ""],
        ["--name", "x" * 33],
        ["--port", "80"],
        ["--port", "70000"],
        ["--dialog-timeout", "0"],
    ],
)
def test_bad_arguments_exit_2(argv, capsys):
    with pytest.raises(SystemExit) as e:
        D.parse_args(argv)
    assert e.value.code == 2
    assert "error:" in capsys.readouterr().err


@pytest.mark.parametrize(
    "argv, attr, value",
    [
        (["--bitrate", "15"], "bitrate", 15),
        (["--bitrate", "8.5"], "bitrate", 8.5),
        (["--scale", "1.75"], "scale", 1.75),
        (["--scale", "2"], "scale", 2),
        (["--name", "Pump_LCD-2"], "name", "Pump_LCD-2"),
        (["-s", "TC25"], "serial", "TC25"),
    ],
)
def test_good_arguments(argv, attr, value):
    assert getattr(D.parse_args(argv), attr) == value


# ---------------------------------------------------------------- commands


def test_adb_cmd_adds_serial_only_when_given():
    assert D.adb_cmd(None, "forward", "--list") == ["adb", "forward", "--list"]
    assert D.adb_cmd("TC25", "shell", "true") == ["adb", "-s", "TC25", "shell", "true"]


def test_receiver_shell_execs_the_receiver_in_the_shell_that_printed_its_pid():
    line = D.receiver_shell()
    assert line.startswith("echo pid=$$;")
    assert "export CLASSPATH=/data/local/tmp/receiver.jar" in line
    assert line.endswith("exec app_process / RyuoDisplay")


@pytest.mark.parametrize("line, pid", [("pid=4242", 4242), ("pid=17\r", 17), ("ryuo-display: pid=1", None), ("", None)])
def test_receiver_pid(line, pid):
    assert D.receiver_pid(line) == pid


def test_is_listening():
    assert D.is_listening("ryuo-display: listening on localabstract:ryuo-display")
    assert not D.is_listening("ryuo-display: client connected")


def test_stale_receiver_kill_matches_the_receiver_but_not_its_own_shell():
    cmd = D.stale_receiver_kill()
    pattern = re.fullmatch(r"pkill -f '(.*)'", cmd).group(1)
    assert re.search(pattern, "app_process / RyuoDisplay")
    assert not re.search(pattern, f"sh -c {cmd}")


def test_krfb_runs_in_its_own_network_namespace_at_panel_size():
    cmd = D.krfb_cmd("RYUO", "pw")
    assert cmd[:4] == ["unshare", "--user", "--net", "krfb-virtualmonitor"]
    assert cmd[cmd.index("--resolution") + 1] == "2240x1080"
    assert cmd[cmd.index("--name") + 1] == "RYUO"
    assert cmd[cmd.index("--password") + 1] == "pw"


@pytest.mark.parametrize("scale, arg", [(2.0, "output.Virtual-RYUO.scale.2"), (1.5, "output.Virtual-RYUO.scale.1.5")])
def test_scale_cmd(scale, arg):
    assert D.scale_cmd("RYUO", scale) == ["kscreen-doctor", arg]


def test_gst_pipeline_is_low_latency_hevc_with_delimiters():
    cmd = D.gst_cmd("ryuo-display-1", 7, 12.5)
    assert cmd[:2] == ["gst-launch-1.0", "-q"]
    for arg in (
        "autoconnect=false",
        "client-name=ryuo-display-1",
        "nvh265enc",
        "bframes=0",
        "zerolatency=true",
        "tune=ultra-low-latency",
        "rc-mode=cbr",
        "bitrate=12500",
        "aud=true",
        "gdppay",
        "fd=7",
        "sync=false",
    ):
        assert arg in cmd
    caps = next(x for x in cmd if x.startswith("video/x-h265"))
    assert "stream-format=byte-stream" in caps and "alignment=au" in caps and "profile=main" in caps
    elements = [cmd[i + 1] for i, x in enumerate(cmd) if x == "!"]
    assert elements[-2:] == ["gdppay", "fdsink"]
    assert elements.index("nvh265enc") < elements.index("gdppay")


# ---------------------------------------------------------------- PipeWire graph

KRFB_PID = 859701


def node(id_, client, cls, name, media=None):
    return {
        "id": id_,
        "type": "PipeWire:Interface:Node",
        "info": {"props": {"client.id": client, "media.class": cls, "node.name": name, "media.name": media}},
    }


def port(id_, node_id, direction):
    return {"id": id_, "type": "PipeWire:Interface:Port", "info": {"direction": direction, "props": {"node.id": node_id}}}


def link(id_, out_node, out_port, in_node, in_port):
    return {
        "id": id_,
        "type": "PipeWire:Interface:Link",
        "info": {
            "output-node-id": out_node,
            "output-port-id": out_port,
            "input-node-id": in_node,
            "input-port-id": in_port,
            "state": "active",
        },
    }


def client(id_, pid, name):
    return {
        "id": id_,
        "type": "PipeWire:Interface:Client",
        "info": {"props": {"pipewire.sec.pid": pid, "application.process.id": pid, "application.name": name}},
    }


# Trimmed from `pw-dump` with krfb-virtualmonitor running on Plasma 6.7.5, plus an unrelated
# screen share and this tool's own consumer.
GRAPH = [
    client(74, 3443, "kwin_wayland"),
    node(92, 74, "Stream/Output/Video", "kwin_wayland", "kwin-screencast-Virtual-RYUO"),
    port(111, 92, "output"),
    client(93, KRFB_PID, "krfb-virtualmonitor"),
    node(104, 93, "Stream/Input/Video", "krfb-virtualmonitor", "plasma-screencast-node-92"),
    port(110, 104, "input"),
    link(123, 92, 111, 104, 110),
    node(200, 74, "Stream/Output/Video", "kwin_wayland", "kwin-screencast-DP-3"),
    port(201, 200, "output"),
    client(300, 4000, "chromium"),
    node(301, 300, "Stream/Input/Video", "chromium", None),
    port(302, 301, "input"),
    link(303, 200, 201, 301, 302),
    client(400, 5000, "gst-launch-1.0"),
    node(401, 400, "Stream/Input/Video", "ryuo-display-77", None),
    port(402, 401, "input"),
    node(500, 1, "Audio/Sink", "alsa_output.analog"),
    port(501, 500, "input"),
]


def test_kwin_output_port_follows_krfb_link():
    assert D.kwin_output_port(GRAPH, KRFB_PID) == (111, 123)


def test_kwin_output_port_is_none_before_krfb_is_linked():
    assert D.kwin_output_port([o for o in GRAPH if o["id"] != 123], KRFB_PID) is None
    assert D.kwin_output_port(GRAPH, 1234) is None


def test_input_port_by_node_name():
    assert D.input_port(GRAPH, "ryuo-display-77") == 402
    assert D.input_port(GRAPH, "ryuo-display-78") is None
    assert D.input_port(GRAPH, "alsa_output.analog") is None


def test_running_monitors_by_output_name():
    cmdlines = {
        10: ["krfb-virtualmonitor", "--resolution", "2240x1080", "--name", "RYUO", "--port", "5900"],
        11: ["unshare", "--user", "--net", "/usr/bin/krfb-virtualmonitor", "--name", "RYUO"],
        12: ["krfb-virtualmonitor", "--name", "Other"],
        13: ["vim", "--name", "RYUO"],
        14: ["krfb-virtualmonitor", "--name"],
    }
    assert D.running_monitors(cmdlines, "RYUO") == [10, 11]


# ---------------------------------------------------------------- GDP and framing


def gdp(kind, payload):
    head = bytes([1, 0, 0, 0]) + struct.pack(">HI", kind, len(payload))
    return head + bytes(D.GDP_HEADER - len(head)) + payload


AU1 = b"\0\0\0\1\x46\x01\x10" + b"\0\0\0\1\x40\x01VPS" + b"\0\0\0\1\x26\x01" + bytes(range(200))
AU2 = b"\0\0\0\1\x46\x01\x30" + b"\0\0\0\1\x02\x01" + b"\x55" * 50


def test_gdp_reader_handles_any_chunking():
    stream = gdp(2, b"video/x-h265") + gdp(D.GDP_BUFFER, AU1) + gdp(D.GDP_BUFFER, AU2)
    for size in (1, 7, 62, 63, 1000):
        r = D.GdpReader()
        got = []
        for i in range(0, len(stream), size):
            got += r.feed(stream[i : i + size])
        assert got == [(2, b"video/x-h265"), (D.GDP_BUFFER, AU1), (D.GDP_BUFFER, AU2)]


def test_gdp_reader_rejects_other_data():
    with pytest.raises(ValueError):
        D.GdpReader().feed(AU1 * 2)


@pytest.mark.parametrize(
    "au, rest",
    [
        (AU1, AU1[7:]),  # 4-byte start codes
        (b"\0\0\1\x46\x01\x50\0\0\1\x02\x01xyz", b"\0\0\1\x02\x01xyz"),  # 3-byte start codes
        (b"\0\0\0\1\x02\x01xyz", b"\0\0\0\1\x02\x01xyz"),  # no delimiter
        (b"\0\0\0\1\x46\x01\x50", b""),  # delimiter only
        (b"", b""),
    ],
)
def test_strip_leading_aud(au, rest):
    assert D.strip_leading_aud(au) == rest


def test_aud_is_nal_type_35():
    assert D.AUD[:4] == b"\0\0\0\1"
    assert (D.AUD[4] >> 1) & 0x3F == 35


class ReceiverSplitter:
    """Python copy of RyuoDisplay.AccessUnitReader: an access unit is cut off when the next
    delimiter has arrived."""

    def __init__(self):
        self.buf = b""

    def feed(self, data):
        self.buf += data
        out = []
        while (cut := self.next_cut()) is not None:
            out.append(self.buf[:cut])
            self.buf = self.buf[cut:]
        return out

    def next_cut(self):
        for i in range(len(self.buf) - 3):
            if self.buf[i : i + 3] == b"\0\0\1" and (self.buf[i + 3] >> 1) & 0x3F == 35:
                cut = i - 1 if i > 0 and self.buf[i - 1] == 0 else i
                if cut > 0:
                    return cut
        return None


def test_each_frame_reaches_the_decoder_before_the_next_one_exists():
    rx = ReceiverSplitter()
    assert rx.feed(D.AUD) == []
    assert rx.feed(D.panel_frame(AU1)) == [D.AUD + AU1[7:]]
    assert rx.feed(D.panel_frame(AU2)) == [D.AUD + AU2[7:]]


def test_rate_reports_fps_and_mbps():
    clock = iter([0.0, 5.0, 10.0])
    stats = D.Stats()
    rate = D.Rate(stats, now=lambda: next(clock))
    for _ in range(300):
        stats.add(20_000)
    assert rate.sample() == pytest.approx((60.0, 9.6))
    assert rate.sample() == (0.0, 0.0)


def received(sock):
    with contextlib.closing(sock):
        return b"".join(iter(lambda: sock.recv(65536), b""))


def test_relay_sends_frames_with_delimiter_ahead_and_switches_encoders_at_once():
    first_r, first_w = os.pipe()
    second_r, second_w = os.pipe()
    a, b = socket.socketpair()
    stats = D.Stats()
    errors = []
    relay = D.Relay(a, stats, errors.append)
    relay.start()
    relay.use(first_r)
    os.write(first_w, gdp(2, b"caps") + gdp(D.GDP_BUFFER, AU1))
    assert relay.first_frame.wait(5)
    # The old encoder has not exited and its pipe is still open: the relay must not wait for it.
    relay.use(second_r)
    assert not relay.first_frame.is_set()
    os.write(second_w, gdp(2, b"caps") + gdp(D.GDP_BUFFER, AU2))
    assert relay.first_frame.wait(5)
    with pytest.raises(BrokenPipeError):  # the old pipe was closed by the switch
        for _ in range(100):
            os.write(first_w, gdp(D.GDP_BUFFER, AU1))
    os.close(first_w)
    os.close(second_w)
    relay.close()
    a.close()
    assert received(b) == D.AUD + AU1[7:] + D.AUD + AU2[7:] + D.AUD
    assert (stats.frames, errors) == (2, [])


def test_relay_reports_a_closed_connection():
    read_fd, write_fd = os.pipe()
    a, b = socket.socketpair()
    b.close()
    errors = []
    relay = D.Relay(a, D.Stats(), errors.append)
    relay.start()
    relay.use(read_fd)
    os.write(write_fd, gdp(D.GDP_BUFFER, AU1))
    relay.thread.join(5)
    os.close(write_fd)
    relay.close()
    a.close()
    assert len(errors) == 1 and errors[0].startswith("stream to the panel failed")


# ---------------------------------------------------------------- windows arriving on the output


def test_links_from_lists_every_link_leaving_the_port():
    graph = [*GRAPH, link(124, 92, 111, 401, 402)]
    assert D.links_from(graph, 111) == [123, 124]
    assert D.links_from(graph, 999) == []


def test_kwin_script_calls_back_this_process_for_the_output():
    js = D.kwin_script("Virtual-RYUO", "org.rogryuolcd.Display.pid42")
    assert 'const OUTPUT = "Virtual-RYUO";' in js
    call = 'callDBus("org.rogryuolcd.Display.pid42", "/org/rogryuolcd/Display", "org.rogryuolcd.Display", "WindowEvent"'
    assert call in js
    assert "workspace.windowAdded.connect" in js and "frameGeometryChanged.connect" in js
    assert "workspace.windowRemoved.connect" in js
    assert 'send("enter", w)' in js and 'send("leave", w)' in js and 'send("move", w)' in js


def test_restart_waits_for_quiet_after_an_arrival():
    clock = [0.0]
    timer = D.RestartTimer(now=lambda: clock[0])
    timer.event("move", "a")
    clock[0] = 5
    assert not timer.due()  # moves alone never restart
    timer.event("enter", "a")
    clock[0] += 0.2
    timer.event("move", "a")  # still being dragged
    clock[0] += D.RESTART_QUIET - 0.1
    assert not timer.due()
    clock[0] += 0.2
    assert timer.due()
    assert not timer.due()  # once per arrival


def test_no_restart_for_a_window_that_left_again():
    clock = [0.0]
    timer = D.RestartTimer(now=lambda: clock[0])
    timer.event("enter", "tooltip")
    clock[0] += 0.1
    timer.event("leave", "tooltip")
    clock[0] += 5
    assert not timer.due()
    timer.event("enter", "menu")
    timer.event("enter", "tooltip")
    timer.event("leave", "tooltip")
    clock[0] += 5
    assert timer.due()  # the menu stayed


# ---------------------------------------------------------------- pointer: desktop portal capture


def test_token_path_follows_xdg_config_home():
    assert D.token_path({"XDG_CONFIG_HOME": "/c", "HOME": "/h"}) == "/c/ryuo/display-portal-token"
    assert D.token_path({"HOME": "/h"}) == "/h/.config/ryuo/display-portal-token"


def test_token_is_private_and_none_removes_it(tmp_path):
    path = str(tmp_path / "ryuo" / "display-portal-token")
    assert D.read_token(path) is None
    D.write_token(path, "abc-123")
    assert D.read_token(path) == "abc-123"
    assert os.stat(path).st_mode & 0o777 == 0o600
    D.write_token(path, "def-456")  # tokens are single-use: each start stores the new one
    assert D.read_token(path) == "def-456"
    D.write_token(path, None)
    assert not os.path.exists(path)
    D.write_token(path, None)  # already gone


def test_select_sources_asks_for_one_monitor_with_the_pointer_drawn_in():
    opts = D.select_sources_options(None)
    assert opts == {
        "types": ("u", 1),
        "multiple": ("b", False),
        "cursor_mode": ("u", 2),
        "persist_mode": ("u", 2),
    }
    assert D.select_sources_options("tok")["restore_token"] == ("s", "tok")


def test_stream_node_takes_the_one_stream():
    assert D.stream_node({"streams": [(97, {"source_type": 1})]}) == 97
    for results in ({}, {"streams": []}, {"streams": [(1, {}), (2, {})]}):
        with pytest.raises(D.PortalError):
            D.stream_node(results)


def test_cancel_and_failure_reasons():
    assert D.RESPONSE_REASONS[1] == "screen selection was cancelled"
    assert "could not start" in D.RESPONSE_REASONS[2]


def test_node_output_port_and_link_state():
    graph = [*GRAPH, link(130, 92, 111, 401, 402)]
    graph[-1]["info"]["state"] = "negotiating"
    assert D.node_output_port(graph, 92) == ("kwin-screencast-Virtual-RYUO", 111)
    assert D.node_output_port(graph, 999) is None
    assert D.node_output_port([o for o in graph if o["id"] != 111], 92) is None
    assert D.link_active(graph, 111, 110)  # krfb's link
    assert not D.link_active(graph, 111, 402)  # still negotiating
    assert not D.link_active(graph, 201, 110)


# ---------------------------------------------------------------- main


def test_main_exits_when_a_program_is_missing(monkeypatch):
    monkeypatch.setattr(D.shutil, "which", lambda name: None if name == "pw-link" else f"/usr/bin/{name}")
    with pytest.raises(SystemExit) as e:
        D.main([])
    assert "pw-link" in str(e.value.code)


def test_missing_tools_asks_for_kscreen_doctor_only_with_scale(monkeypatch):
    monkeypatch.setattr(D.shutil, "which", lambda name: None if name == "kscreen-doctor" else name)
    assert D.missing_tools(None) == []
    assert D.missing_tools(2.0) == ["kscreen-doctor"]


@pytest.fixture
def fake_session(monkeypatch):
    monkeypatch.setattr(D.shutil, "which", lambda name: name)
    events = []

    class FakeSession:
        outcome = None

        def __init__(self, a, stack):
            self.stack = stack

        def check_free(self):
            events.append("output free")

        def start_receiver(self):
            events.append("receiver up")
            self.stack.callback(events.append, "receiver stopped")
            self.stack.callback(events.append, "forward removed")

        def start_monitor(self):
            events.append("monitor up")
            self.stack.callback(events.append, "monitor removed")
            return 111, 123

        def pointer_source(self, source):
            assert source == (111, 123)
            events.append("portal capture up")
            self.stack.callback(events.append, "portal session closed")
            return 222, None

        def start_stream(self, source):
            assert source == (222, None)
            self.stack.callback(events.append, "encoder stopped")

        def watch(self):
            raise FakeSession.outcome

    monkeypatch.setattr(D, "Session", FakeSession)
    return types.SimpleNamespace(cls=FakeSession, events=events)


@pytest.mark.parametrize("outcome, status", [(KeyboardInterrupt(), 0), (D.Stop(), 0), (D.DisplayError("gone"), 1)])
def test_main_tears_down_in_reverse_order(fake_session, outcome, status, capsys):
    fake_session.cls.outcome = outcome
    before = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    assert D.main([]) == status
    assert fake_session.events == [
        "output free",
        "receiver up",
        "monitor up",
        "portal capture up",
        "encoder stopped",
        "portal session closed",
        "monitor removed",
        "forward removed",
        "receiver stopped",
    ]
    assert {s: signal.getsignal(s) for s in before} == before
    if status:
        assert "error: gone" in capsys.readouterr().out


def test_sigterm_handler_raises_stop():
    with pytest.raises(D.Stop):
        D._raise_stop(signal.SIGTERM, None)
