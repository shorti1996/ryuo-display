#!/usr/bin/env python3
"""Record the demo in SCENARIO.md: start `npm run demo` on a free port, drive the page in a
headless Chromium with Playwright, and capture it through Chrome's screencast at 1920x1080.

Playwright's own video recorder captures at CSS resolution and about 1 Mb/s, which blurs the
text, so the frames come from the DevTools screencast instead and ffmpeg times them into a
constant 30 fps master. Writes, under web/demo/out/:

    master.mp4            1920x1080, near-lossless, the source for every cut
    shots.json            each shot's start in master.mp4 (s), and the GIF's crop
    reddit.mp4            1920x1080, the whole take
    readme.mp4            1280x720, the whole take, under GitHub's 10 MB upload limit
    readme.gif            800 px wide, the hero only: preview → Apply and the mirror on → off

Needs the Python playwright package with its Chromium, ffmpeg with libx264, and ImageMagick.
Usage: web/demo/record.py [--keep-frames] [--cut-only]
"""

import argparse
import base64
import json
import math
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

DEMO = Path(__file__).resolve().parent
WEB = DEMO.parent
OUT = DEMO / "out"
FRAMES = OUT / "frames"
UPLOAD = DEMO / "media" / "gameplay-highlight.mp4"

# A 1920x1080 window with the page zoomed to 4/3: laid out as at 1440x810, where the header,
# the hero and the strip under it fit without scrolling, and drawn at 1920x1080. Not a device
# scale factor: the screencast sends frames at the CSS size, which would halve the detail. With
# the zoom on the root element, the DOM, scrolling and Playwright's mouse share one coordinate
# space, in device pixels.
VIEWPORT = {"width": 1920, "height": 1080}
ZOOM = 4 / 3
# Where the cursor waits between moves: the margin right of the column, clear of any text.
REST_X = VIEWPORT["width"] - 86
FPS = 30
GIF_FPS = 10

# The cursor, and the file card that follows it during the drag, drawn into the page. Both
# follow the mouse events Playwright sends; a click shrinks the cursor and sends out a ring.
CURSOR_SCRIPT = """
(() => {
  const zoom = 4 / 3;
  const style = document.createElement("style");
  style.textContent = `
    html { zoom: ${zoom}; scrollbar-width: none; }
    #demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
      width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;
      background: rgba(255, 255, 255, .92); border: 2px solid rgba(10, 10, 12, .85);
      box-shadow: 0 2px 10px rgba(0, 0, 0, .55); transition: transform .12s ease-out; }
    #demo-cursor.down { transform: scale(.72); }
    .demo-ring { position: fixed; z-index: 2147483646; pointer-events: none; width: 18px; height: 18px;
      margin: -9px 0 0 -9px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, .9);
      animation: demo-ring .5s ease-out forwards; }
    @keyframes demo-ring { to { transform: scale(2.6); opacity: 0; } }
    #demo-card { position: fixed; left: 0; top: 0; z-index: 2147483645; pointer-events: none; display: none;
      align-items: center; gap: 10px; padding: 10px 14px; margin: 14px 0 0 14px; border-radius: 10px;
      background: #1d2028; border: 1px solid #3a3f4b; box-shadow: 0 10px 28px rgba(0, 0, 0, .6);
      font: 500 13px Inter, system-ui, sans-serif; color: #e8e9eb; white-space: nowrap; }
    #demo-card i { width: 26px; height: 32px; border-radius: 4px; background: linear-gradient(135deg, #6a2cff, #e5252b); }
  `;
  const cursor = document.createElement("div");
  cursor.id = "demo-cursor";
  const card = document.createElement("div");
  card.id = "demo-card";
  card.innerHTML = "<i></i><span></span>";
  // Mouse coordinates are in device pixels; the elements sit under the root's zoom.
  const place = (element, x, y) => { element.style.translate = `${x / zoom}px ${y / zoom}px`; };
  addEventListener("mousemove", (event) => {
    place(cursor, event.clientX, event.clientY);
    place(card, event.clientX, event.clientY);
  }, true);
  addEventListener("mousedown", (event) => {
    cursor.classList.add("down");
    const ring = document.createElement("div");
    ring.className = "demo-ring";
    place(ring, event.clientX, event.clientY);
    document.body.append(ring);
    setTimeout(() => ring.remove(), 600);
  }, true);
  addEventListener("mouseup", () => cursor.classList.remove("down"), true);
  addEventListener("DOMContentLoaded", () => {
    document.head.append(style);
    document.body.append(cursor, card);
    place(cursor, -40, -40);
  });
  window.__demo = {
    card(name) {
      card.querySelector("span").textContent = name || "";
      card.style.display = name ? "flex" : "none";
    },
    scrollTo(top, ms) {
      const start = scrollY, change = top - start, began = performance.now();
      const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      return new Promise((done) => {
        const step = (now) => {
          const t = Math.min(1, (now - began) / ms);
          scrollTo(0, start + change * ease(t));
          t < 1 ? requestAnimationFrame(step) : done();
        };
        requestAnimationFrame(step);
      });
    },
  };
})();
"""

# Drop `bytes` (base64) on the upload zone as a file named `name`, as a real drag would.
DROP_SCRIPT = """
async ([name, data, phase]) => {
  const zone = document.querySelector("#dropZone");
  if (phase === "enter") {
    const transfer = new DataTransfer();
    zone.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    zone.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    return;
  }
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const transfer = new DataTransfer();
  transfer.items.add(new File([bytes], name, { type: "video/mp4" }));
  zone.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
}
"""


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def start_server(port: int) -> subprocess.Popen:
    """A fresh `npm run demo`, so every take starts from the mock's initial state."""
    server = subprocess.Popen(
        ["npm", "run", "demo", "--", "--port", str(port), "--strictPort"],
        cwd=WEB,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    for _ in range(100):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=1)
            return server
        except OSError:
            time.sleep(0.2)
    server.kill()
    sys.exit(f"the demo server did not answer on port {port}")


class Director:
    """Moves the cursor and the page with the pacing a person would use."""

    def __init__(self, page: Page):
        self.page = page
        self.x, self.y = VIEWPORT["width"] + 40.0, VIEWPORT["height"] * 0.55
        self.shots: dict[str, float] = {}

    def wait(self, seconds: float) -> None:
        # Not time.sleep: Playwright handles the screencast's frames only while it waits itself.
        self.page.wait_for_timeout(seconds * 1000)

    def shot(self, name: str) -> None:
        self.shots[name] = time.time()

    def move(self, x: float, y: float, seconds: float = 0.75) -> None:
        """Glide to (x, y) along an eased, slightly bowed path."""
        start_x, start_y = self.x, self.y
        distance = math.hypot(x - start_x, y - start_y)
        bow = min(60.0, distance * 0.12)
        steps = max(8, int(seconds * 60))
        began = time.time()
        for index in range(1, steps + 1):
            progress = index / steps
            eased = 3 * progress**2 - 2 * progress**3
            lift = math.sin(progress * math.pi) * bow
            self.page.mouse.move(start_x + (x - start_x) * eased, start_y + (y - start_y) * eased - lift)
            behind = began + seconds * progress - time.time()
            if behind > 0:
                self.wait(behind)
        self.x, self.y = x, y

    def center(self, selector: str) -> tuple[float, float]:
        box = self.page.locator(selector).first.bounding_box()
        if box is None:
            raise RuntimeError(f"{selector} is not on the page")
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    def hover(self, selector: str, seconds: float = 0.75) -> None:
        """Move onto `selector`, a little below and right of its centre, so the cursor does not
        sit on the label."""
        box = self.page.locator(selector).first.bounding_box()
        if box is None:
            raise RuntimeError(f"{selector} is not on the page")
        x = box["x"] + box["width"] / 2 + min(box["width"] * 0.25, 16)
        y = box["y"] + box["height"] / 2 + min(box["height"] * 0.25, 8)
        self.move(x, y, seconds)

    def rest(self, y_share: float = 0.5, seconds: float = 0.8) -> None:
        self.move(REST_X, VIEWPORT["height"] * y_share, seconds)

    def click(self, selector: str, seconds: float = 0.75) -> None:
        self.hover(selector, seconds)
        self.wait(0.18)
        self.page.mouse.down()
        self.wait(0.09)
        self.page.mouse.up()

    def scroll(self, top: float, seconds: float = 0.9) -> None:
        self.page.evaluate("([top, ms]) => window.__demo.scrollTo(top, ms)", [top, seconds * 1000])

    def scroll_to(self, selector: str, offset: float, seconds: float = 0.9) -> None:
        """Scroll so `selector`'s top sits `offset` pixels below the window's top."""
        top = self.page.evaluate(
            "([selector, offset]) => document.querySelector(selector).getBoundingClientRect().top + scrollY - offset",
            [selector, offset],
        )
        self.scroll(max(0, top), seconds)


def scenario(director: Director) -> None:
    page = director.page
    tile = 'ryuo-background-tab .tile[data-name="{}"] .thumb'.format

    director.shot("opening")
    director.wait(4.5)

    director.shot("background")
    director.click("#tab-background", 0.9)
    director.wait(0.5)
    director.scroll_to("ryuo-background-tab", 100, 1.1)
    director.wait(1.4)

    director.shot("preview")
    director.hover(tile("aurora-drift.mp4"), 0.8)
    director.wait(0.35)
    director.hover(tile("neon-life.mp4"), 0.55)
    director.wait(0.35)
    director.click(tile("sunset-bloom.mp4"), 0.55)
    director.wait(1.0)  # the hero scrolls into view by itself
    # It stops just below the header; the rest of the take frames the page from its top.
    director.scroll(0, 0.3)
    director.wait(0.3)
    director.shot("previewing")
    director.hover("#pvApply", 0.9)
    director.wait(2.0)

    director.shot("apply")
    director.click("#pvApply", 0.3)
    director.wait(1.4)
    director.click("#pvReplace", 0.6)
    director.rest(0.45, 0.9)
    director.wait(2.4)

    director.shot("upload")
    director.scroll_to("#dropZone", 340, 1.0)
    director.wait(0.4)
    zone_x, zone_y = director.center("#dropZone")
    director.move(VIEWPORT["width"] + 30, zone_y - 40, 0.2)
    page.evaluate("name => window.__demo.card(name)", UPLOAD.name)
    director.move(zone_x - 30, zone_y - 10, 1.3)
    page.evaluate(DROP_SCRIPT, [UPLOAD.name, "", "enter"])
    director.wait(0.5)
    page.evaluate("() => window.__demo.card('')")
    page.evaluate(DROP_SCRIPT, [UPLOAD.name, base64.b64encode(UPLOAD.read_bytes()).decode(), "drop"])
    director.rest(0.55, 0.8)
    page.wait_for_function("() => document.querySelector('#upStatus')?.textContent.startsWith('Playing')", timeout=30_000)
    director.wait(1.6)
    director.scroll(0, 1.1)
    director.wait(2.4)

    director.shot("mirror")
    director.click("#modeMirror", 0.8)
    director.rest(0.4, 0.8)
    director.wait(3.0)
    director.shot("mirror-tab")
    director.click("#tab-mirror", 0.8)
    director.wait(0.4)
    director.scroll_to("#tabs", 100, 0.9)
    director.rest(0.4, 0.8)
    page.wait_for_function("() => document.querySelector('#displayText')?.textContent.startsWith('On:')", timeout=15_000)
    director.wait(2.2)

    director.shot("back")
    director.scroll(0, 1.0)
    director.wait(0.3)
    director.shot("back-click")
    director.click("#modeStats", 0.8)
    director.rest(0.4, 0.8)
    page.wait_for_function("() => document.querySelector('ryuo-hero')?.dataset.view === 'live'", timeout=15_000)
    director.wait(3.0)
    director.shot("end")


def record(port: int) -> tuple[list[tuple[Path, float]], dict[str, float], list[int]]:
    """Play the scenario; returns the frames with their times, each shot's start, and the
    hero-and-strip rectangle in device pixels (x, y, width, height) for the GIF."""
    shutil.rmtree(FRAMES, ignore_errors=True)
    FRAMES.mkdir(parents=True)
    frames: list[tuple[Path, float]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport=VIEWPORT)
        context.add_init_script(CURSOR_SCRIPT)
        page = context.new_page()
        page.goto(f"http://127.0.0.1:{port}/")
        page.wait_for_function("() => document.querySelector('#heroVideo')?.currentTime > 0.5", timeout=20_000)
        page.wait_for_timeout(1500)
        box = page.evaluate(
            """() => {
              const hero = document.querySelector("#hero").getBoundingClientRect();
              const strip = document.querySelector(".strip").getBoundingClientRect();
              return [hero.left - 14, hero.top - 14, hero.width + 28, strip.bottom - hero.top + 28];
            }"""
        )
        crop = [2 * round(value / 2) for value in box]

        session = context.new_cdp_session(page)

        def keep(event: dict) -> None:
            path = FRAMES / f"{len(frames):06d}.jpg"
            path.write_bytes(base64.b64decode(event["data"]))
            frames.append((path, event["metadata"]["timestamp"]))
            session.send("Page.screencastFrameAck", {"sessionId": event["sessionId"]})

        session.on("Page.screencastFrame", keep)
        session.send(
            "Page.startScreencast",
            {"format": "jpeg", "quality": 92, "maxWidth": 1920, "maxHeight": 1080, "everyNthFrame": 1},
        )
        director = Director(page)
        page.mouse.move(director.x, director.y)
        director.wait(0.5)
        scenario(director)
        session.send("Page.stopScreencast")
        browser.close()
    return frames, director.shots, crop


def encode_master(frames: list[tuple[Path, float]]) -> None:
    """Time the screencast's frames into a constant-rate MP4."""
    lines = []
    for (path, stamp), (_, following) in zip(frames, [*frames[1:], (None, frames[-1][1] + 1 / FPS)], strict=True):
        lines += [f"file '{path}'", f"duration {max(following - stamp, 0.001):.4f}"]
    lines.append(f"file '{frames[-1][0]}'")
    listing = OUT / "frames.txt"
    listing.write_text("\n".join(lines) + "\n")
    h264(["-f", "concat", "-safe", "0", "-i", listing], OUT / "master.mp4", 12, f"fps={FPS}")


def ffmpeg(*args) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def h264(inputs: list, target: Path, crf: int, video_filter: str = "null") -> None:
    """Encode for playback anywhere: H.264 High, 4:2:0, the index at the front."""
    x264 = ["-c:v", "libx264", "-preset", "slow", "-crf", crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    ffmpeg(*inputs, "-vf", video_filter, *x264, target)


def cut(take: dict) -> None:
    """The three outputs from master.mp4, with the shot times and crop in shots.json."""
    master = OUT / "master.mp4"
    starts = take["shots"]
    h264(["-i", master], OUT / "reddit.mp4", 20)
    h264(["-i", master], OUT / "readme.mp4", 22, "scale=1280:-2:flags=lanczos")
    # The GIF: the hero and the strip only, over preview → Apply, the mirror starting, and the
    # switch back with 2 s of the result; one palette for all three parts. Bayer dithering keeps
    # the gradients from banding at 96 colours and compresses better than error diffusion.
    x, y, width, height = take["crop"]
    parts = [
        (starts["previewing"], starts["upload"]),
        (starts["mirror"], starts["mirror-tab"]),
        (starts["back-click"], min(starts["end"], starts["back-click"] + 7)),
    ]
    trims = ";".join(
        f"[0:v]trim={begin}:{end},setpts=PTS-STARTPTS,crop={width}:{height}:{x}:{y},"
        f"fps={GIF_FPS},scale=800:-2:flags=lanczos[p{index}]"
        for index, (begin, end) in enumerate(parts)
    )
    joined = "".join(f"[p{index}]" for index in range(len(parts)))
    graph = (
        f"{trims};{joined}concat=n={len(parts)}:v=1[v];[v]split[a][b];"
        "[a]palettegen=max_colors=96:stats_mode=diff[pal];"
        "[b][pal]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle"
    )
    ffmpeg("-i", master, "-filter_complex", graph, "-loop", "0", OUT / "readme-raw.gif")
    # ImageMagick's frame optimisation takes another 10-15 % off.
    optimise = ["-coalesce", "-fuzz", "2%", "-layers", "Optimize"]
    subprocess.run(["magick", OUT / "readme-raw.gif", *optimise, OUT / "readme.gif"], check=True)
    (OUT / "readme-raw.gif").unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keep-frames", action="store_true", help="keep the screencast's JPEG frames")
    parser.add_argument("--cut-only", action="store_true", help="make the outputs again from the last master.mp4")
    options = parser.parse_args()
    OUT.mkdir(exist_ok=True)
    if not options.cut_only:
        port = free_port()
        server = start_server(port)
        try:
            frames, shots, crop = record(port)
        finally:
            os.killpg(server.pid, signal.SIGTERM)
        encode_master(frames)
        first = frames[0][1]
        starts = {name: round(max(0.0, stamp - first), 2) for name, stamp in shots.items()}
        (OUT / "shots.json").write_text(json.dumps({"shots": starts, "crop": crop}, indent=2) + "\n")
        if not options.keep_frames:
            shutil.rmtree(FRAMES)
    take = json.loads((OUT / "shots.json").read_text())
    cut(take)
    for name in ("master.mp4", "reddit.mp4", "readme.mp4", "readme.gif"):
        print(f"{OUT / name}  {(OUT / name).stat().st_size / 1e6:.1f} MB")
    print(json.dumps(take))


if __name__ == "__main__":
    main()
