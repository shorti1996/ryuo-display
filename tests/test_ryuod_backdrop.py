"""ryuod's black background during display mode (ryuod.Backdrop) with a fake ryuo_display.py.

The second-display supervisor runs the fake child from fakes.py, the device worker is faked at
Device.submit() (fakes.FakeDevice), and ryuo_media.push is replaced by a recorder, so the tests see
each push and each waterBlockScreenId without adb or the cooler.
"""

import threading

import pytest
from fakes import CUSTOM, PRESET, FakeDevice, FakeDisplayChild, make_display, wait_until

import ryuo_media as M
import ryuo_proto as P
import ryuod

ADB_ERROR = "adb push exited with 1: adb: error: no devices/emulators found"


class Pushes:
    """Stands in for ryuo_media.push: records (name, media_dir, bytes) and raises MediaError for
    the next `fail` calls."""

    def __init__(self):
        self.calls = []
        self.fail = 0

    def __call__(self, src, name, media_dir, cancel=None):
        with open(src, "rb") as f:
            self.calls.append((name, media_dir, f.read()))
        if self.fail:
            self.fail -= 1
            raise M.MediaError(ADB_ERROR)


class Rig:
    def __init__(self, tmp_path, monkeypatch):
        monkeypatch.setattr(P, "local_timezone", lambda: "Europe/Warsaw")
        monkeypatch.setattr(ryuod, "log", lambda msg: None)
        self.pushes = Pushes()
        monkeypatch.setattr(M, "push", self.pushes)
        d = self.d = ryuod.Daemon()
        d.media_lock = threading.Lock()
        d.state = ryuod.State(str(tmp_path / "state.json"))
        d.state.update({"media": [CUSTOM[0], PRESET[1]], "playMode": "Cycle"})
        d.sampler = ryuod.Sampler(d.state)  # never started
        d.device = FakeDevice(d.state, d.sampler)
        self.child = FakeDisplayChild(tmp_path)
        self.child.listen("wayland-0")
        self.child.listen("bus")
        self.display = None

    def start(self, **kw):
        self.display = make_display(self.child, backdrop=self.d.backdrop, **kw)
        return self.display

    def screens(self):
        """The playlists of every waterBlockScreenId sent so far."""
        return [b["media"] for _, c, b in self.d.device.sent if c == "waterBlockScreenId"]

    def user_config(self):
        return ryuod.config_for(self.d.state.get())

    def close(self):
        if self.display is not None:
            assert self.display.stop(10)
        self.child.close()
        self.d.device.close_pipe()


@pytest.fixture
def rig(tmp_path, monkeypatch):
    r = Rig(tmp_path, monkeypatch)
    yield r
    r.close()


def state_is(display, state):
    return lambda: display.status()["state"] == state


def test_streaming_switches_homeui_to_the_pushed_black_image(rig):
    display = rig.start()
    display.set(True)
    wait_until(lambda: rig.screens(), what="a waterBlockScreenId")
    assert display.status()["state"] == "on"
    assert rig.pushes.calls == [(ryuod.BLACK_NAME, P.MEDIA_DIR, M.black_png())]
    ((method, cmd, cfg),) = rig.d.device.sent
    assert (method, cmd) == ("POST", "waterBlockScreenId")
    assert cfg == ryuod.black_config(rig.d.state.get())
    assert (cfg["media"], cfg["playMode"]) == ([ryuod.BLACK_NAME], "Single")
    assert rig.d.device.media["custom"] == [*CUSTOM, ryuod.BLACK_NAME]
    assert rig.d.device.media["sizes"][ryuod.BLACK_NAME] == len(M.black_png())
    # In memory only: the saved selection stays the user's.
    assert rig.d.state.get()["media"] == [CUSTOM[0], PRESET[1]]
    assert display.status()["backgroundError"] is None


def test_every_switch_pushes_again_and_lists_the_name_once(rig):
    display = rig.start()
    display.set(True)
    wait_until(lambda: len(rig.screens()) == 1, what="black")
    display.set(False)
    wait_until(state_is(display, "off"))
    display.set(True)
    wait_until(lambda: len(rig.screens()) == 3, what="black again")
    assert len(rig.pushes.calls) == 2
    assert rig.d.device.media["custom"].count(ryuod.BLACK_NAME) == 1


def test_turning_display_mode_off_restores_the_saved_media(rig):
    display = rig.start()
    display.set(True)
    wait_until(lambda: rig.d.backdrop.on, what="black")
    display.set(False)
    wait_until(state_is(display, "off"))
    assert rig.screens() == [[ryuod.BLACK_NAME], [CUSTOM[0], PRESET[1]]]
    assert rig.d.device.sent[-1][2] == rig.user_config()
    assert rig.d.backdrop.on is False


def test_turning_display_mode_off_restores_before_the_child_is_stopped(rig):
    # The receiver's layer still covers HomeUI then, so the saved video starts out of sight.
    display = rig.start()
    display.set(True)
    wait_until(lambda: rig.d.backdrop.on, what="black")
    child_running = []
    submit = rig.d.device.submit

    def recording_submit(method, cmd, body, wait=0.25):
        child_running.append(display.proc is not None and display.proc.poll() is None)
        return submit(method, cmd, body, wait)

    rig.d.device.submit = recording_submit
    display.set(False)
    wait_until(state_is(display, "off"))
    assert rig.screens()[-1] == [CUSTOM[0], PRESET[1]]
    assert child_running == [True]


def test_a_failure_waiting_for_its_retry_restores_the_saved_media(rig):
    rig.child.mode("die")  # streams, then exits with an error
    display = rig.start(backoff=(30,))
    display.set(True)
    wait_until(state_is(display, "retrying"), what="retrying")
    wait_until(lambda: len(rig.screens()) == 2, what="the restore")
    assert rig.screens() == [[ryuod.BLACK_NAME], [CUSTOM[0], PRESET[1]]]
    assert rig.d.backdrop.on is False


def test_daemon_shutdown_restores_before_the_display_thread_ends(rig):
    # main() stops the device worker, which sends disconn, only after Display.stop() returns.
    display = rig.start()
    display.set(True)
    wait_until(lambda: rig.d.backdrop.on, what="black")
    assert display.stop(10)
    rig.display = None
    assert rig.d.device.sent[-1] == ("POST", "waterBlockScreenId", rig.user_config())
    assert rig.d.backdrop.on is False


def test_failed_push_keeps_the_video_and_reports_it_until_switched_off(rig):
    rig.pushes.fail = 1
    display = rig.start()
    display.set(True)
    wait_until(lambda: display.status()["backgroundError"], what="the push error")
    st = display.status()
    assert st["state"] == "on"
    assert st["backgroundError"] == ADB_ERROR
    assert rig.screens() == []
    assert rig.d.backdrop.on is False
    assert ryuod.BLACK_NAME not in rig.d.device.media["custom"]
    display.set(False)
    wait_until(state_is(display, "off"))
    assert display.status()["backgroundError"] is None
    assert rig.screens() == []  # nothing to restore


def test_push_error_clears_on_the_next_successful_switch(rig):
    rig.pushes.fail = 1
    rig.child.mode("die")
    display = rig.start(backoff=(0.1,))
    display.set(True)
    wait_until(lambda: display.status()["backgroundError"] == ADB_ERROR, what="the push error")
    wait_until(lambda: rig.screens(), what="the second start's switch")
    wait_until(lambda: display.status()["backgroundError"] is None, what="the error to clear")
    assert len(rig.pushes.calls) >= 2


def test_selection_while_held_is_saved_and_sent_on_restore(rig):
    display = rig.start()
    display.set(True)
    wait_until(lambda: rig.d.backdrop.on, what="black")
    cfg, _ = ryuod.select_playlist(rig.d, [PRESET[0]], "Single")
    assert rig.d.backdrop.submit(cfg) == (None, True)
    assert rig.screens() == [[ryuod.BLACK_NAME]]
    display.set(False)
    wait_until(state_is(display, "off"))
    assert rig.screens() == [[ryuod.BLACK_NAME], [PRESET[0]]]


def test_the_black_image_can_be_chosen_as_a_normal_selection(rig):
    display = rig.start()
    display.set(True)
    wait_until(lambda: rig.d.backdrop.on, what="black")
    display.set(False)
    wait_until(state_is(display, "off"))
    cfg, st = ryuod.select_playlist(rig.d, [ryuod.BLACK_NAME], "Single")
    assert st["media"] == [ryuod.BLACK_NAME]
    assert rig.d.backdrop.submit(cfg)[1] is False
