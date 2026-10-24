#!/usr/bin/env python3
"""Measures KWin's capture rate of Virtual-RYUO under different interventions.

A 60 fps test pattern (ffplay, window title ryuo-probe) is moved around by KWin scripts while
ryuo_display.py runs with RYUO_FRAME_LOG set, so every frame sent to the panel is timestamped.
"""
import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request

REPO = "/home/shared/repos/rog-ryuo-lcd"
OUT = sys.argv[1]
TRIALS = int(sys.argv[2]) if len(sys.argv) > 2 else 4
PROBE = sys.argv[3] if len(sys.argv) > 3 else "ffplay"
API = "http://127.0.0.1:8746"
VX, VY, VW, VH = 3440, 471, 1120, 540  # Virtual-RYUO, logical px
PW, PH = 800, 400                       # probe window, logical px
ON_OUTPUT = (VX + (VW - PW) // 2, VY + (VH - PH) // 2)
STRADDLE = (VX - PW // 2, VY + (VH - PH) // 2)
FRAMES = os.path.join(OUT, "frames.log")
script_n = 0


def log(msg):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(os.path.join(OUT, "harness.log"), "a") as f:
        f.write(line + "\n")


def api(path, body=None):
    req = urllib.request.Request(API + path, json.dumps(body).encode() if body is not None else None,
                                 {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=10))


def gdbus(dest, path, method, *args):
    return subprocess.run(["gdbus", "call", "--session", "--dest", dest, "--object-path", path, "--method", method, *args],
                          capture_output=True, text=True, timeout=10).stdout.strip()


def kwin(js):
    """Run a one-off KWin script."""
    global script_n
    script_n += 1
    name = f"ryuo-probe-{os.getpid()}-{script_n}"
    path = os.path.join(OUT, name + ".js")
    with open(path, "w") as f:
        f.write(js)
    out = gdbus("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", path, name)
    sid = out.strip("()").split(",")[0].split()[-1]
    gdbus("org.kde.KWin", f"/Scripting/Script{sid}", "org.kde.kwin.Script.run")
    time.sleep(0.2)
    gdbus("org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", name)


def move_probe(x, y):
    kwin(f"""const w = workspace.windowList().find(c => c.caption.indexOf("ryuo-probe") >= 0);
if (w) {{ w.frameGeometry = {{x: {x}, y: {y}, width: {PW}, height: {PH}}}; }}
print("ryuo-probe at " + (w ? JSON.stringify(w.frameGeometry) + " on " + (w.output ? w.output.name : "?") : "missing"));
""")


def report_probe():
    kwin("""const w = workspace.windowList().find(c => c.caption.indexOf("ryuo-probe") >= 0);
print("ryuo-probe at " + (w ? JSON.stringify(w.frameGeometry) + " on " + (w.output ? w.output.name : "?") : "missing"));
""")


def frames_between(t0, t1):
    with open(FRAMES) as f:
        ts = [float(line.split()[0]) for line in f if line.strip()]
    ts = [t for t in ts if t0 <= t < t1]
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    return {"fps": round(len(ts) / (t1 - t0), 1), "max_gap_ms": round(max(gaps) * 1000) if gaps else None,
            "burst_share": round(sum(1 for g in gaps if g < 0.004) / len(gaps), 2) if gaps else None}


def phase(name, seconds, results):
    t0 = time.monotonic()
    time.sleep(seconds)
    r = frames_between(t0, time.monotonic())
    results[name] = r
    log(f"  {name:20s} {r}")


class Display:
    def __init__(self, trial):
        self.lines = []
        env = dict(os.environ, RYUO_FRAME_LOG=FRAMES)
        self.out = open(os.path.join(OUT, f"display-{trial}.log"), "w")
        self.proc = subprocess.Popen([sys.executable, "-u", os.path.join(REPO, "ryuo_display.py")], env=env,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            self.lines.append((time.monotonic(), line.rstrip()))
            self.out.write(f"{time.monotonic():.3f} {line}")
            self.out.flush()

    def wait_streaming(self, timeout=40):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if any(line.startswith("streaming to the panel") for _, line in self.lines):
                return next(t for t, line in self.lines if line.startswith("streaming to the panel"))
            if self.proc.poll() is not None:
                raise SystemExit(f"ryuo_display.py exited: {self.lines[-5:]}")
            time.sleep(0.1)
        raise SystemExit("no 'streaming to the panel'")

    def restart(self):
        gdbus(f"org.rogryuolcd.Display.pid{self.proc.pid}", "/org/rogryuolcd/Display",
              "org.rogryuolcd.Display.WindowEvent", "enter", "harness")

    def restarts_since(self, t):
        return [line for ts, line in self.lines if ts >= t and "restarted the capture" in line]

    def stop(self):
        self.proc.send_signal(signal.SIGTERM)
        self.proc.wait(60)
        self.out.close()


def main():
    os.makedirs(OUT, exist_ok=True)
    was_on = api("/api/state")["config"]["secondDisplay"]
    log(f"ryuod second display was {'on' if was_on else 'off'}; turning it off")
    api("/api/display", {"on": False})
    while api("/api/state")["display"]["state"] != "off":
        time.sleep(0.5)
    if PROBE == "mpv":
        # Waits for KWin's frame callbacks before each frame, like most applications.
        cmd = ["mpv", "--no-config", "--title=ryuo-probe", f"--geometry={PW}x{PH}", "--loop=inf",
               f"av://lavfi:testsrc2=size={PW}x{PH}:rate=60"]
    else:
        cmd = ["ffplay", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
               "-i", f"testsrc2=s={PW}x{PH}:r=60", "-window_title", "ryuo-probe"]
    probe = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    all_results = []
    try:
        for trial in range(1, TRIALS + 1):
            log(f"trial {trial}")
            d = Display(trial)
            t_stream = d.wait_streaming()
            res = {}
            report_probe()
            time.sleep(max(0, t_stream + 1 - time.monotonic()))
            phase("start", 4, res)
            t = time.monotonic()
            move_probe(*ON_OUTPUT)
            time.sleep(1.5)
            res["auto_restarts"] = len(d.restarts_since(t))
            phase("after_arrival", 6, res)
            t = time.monotonic()
            d.restart()
            time.sleep(1)
            res["dbus_restarts"] = len(d.restarts_since(t))
            phase("after_dbus_restart", 6, res)
            move_probe(*STRADDLE)
            time.sleep(0.5)
            phase("straddling", 6, res)
            t = time.monotonic()
            move_probe(*ON_OUTPUT)
            time.sleep(0.5)
            res["back_restarts"] = len(d.restarts_since(t))
            phase("back_on_output", 6, res)
            d.stop()
            all_results.append(res)
            time.sleep(2)
    finally:
        probe.terminate()
        if was_on:
            log("turning ryuod's second display back on")
            api("/api/display", {"on": True})
    with open(os.path.join(OUT, "results.json"), "w") as f:
        json.dump(all_results, f, indent=1)
    log("RESULTS " + json.dumps(all_results))


main()
