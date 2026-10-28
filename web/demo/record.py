#!/usr/bin/env python3
"""Record the short per-feature clips in SCENARIO.md: start `npm run demo` on a free port, drive
the page in a headless Chromium with Playwright, and capture it through Chrome's screencast.

Each clip is its own take against a fresh demo server, framed on the page's column from the hero
down to the part of the page the feature uses, so the whole feature is on screen at once and the
page never scrolls.

Playwright's own video recorder captures at CSS resolution and about 1 Mb/s, which blurs the
text, so the frames come from the DevTools screencast instead and ffmpeg times them into a
constant 30 fps master. Writes, under web/demo/out/, for each clip <name>:

    <name>.master.mp4     the whole window, near-lossless, the source for the cuts
    <name>.json           the crop (device px) and each step's start in the master (s)
    <name>.mp4            the column only, H.264 at full resolution
    <name>.gif            the column only, 800 px wide, for the README

Needs the Python playwright package with its Chromium, ffmpeg with libx264, and ImageMagick.
Usage: web/demo/record.py [CLIP ...] [--keep-frames] [--cut-only]
       (CLIP: overlay, preview-apply, upload, desktop-mirror; default all)
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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

DEMO = Path(__file__).resolve().parent
WEB = DEMO.parent
OUT = DEMO / "out"
UPLOAD = DEMO / "media" / "gameplay-highlight.mp4"

# The page is laid out 1440 CSS px wide, where the column is 1132 px, and drawn at 1920 px with
# zoom on the root element. Not a device scale factor: the screencast sends frames at the CSS
# size, which would halve the detail. With the zoom on the root, the DOM, scrolling and
# Playwright's mouse share one coordinate space, in device pixels.
ZOOM = 4 / 3
WIDTH = 1920
# The crop's margin around the column, in device px; the cursor waits in the right one.
MARGIN = 72
FPS = 30
# The hero's background video changes every frame, so a GIF frame re-encodes everything from the
# hero down to the cursor. On the 13 s overlay take: 10 fps 8.7 MB, 8 fps 7.4 MB; 64 colours
# saved more but banded the hero's gradient into rings.
GIF_FPS = 8
GIF_WIDTH = 800

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

    def __init__(self, page: Page, rest_x: float, height: int):
        self.page = page
        self.rest_x = rest_x
        self.height = height
        self.x, self.y = rest_x, height * 0.45
        self.steps: dict[str, float] = {}

    def wait(self, seconds: float) -> None:
        # Not time.sleep: Playwright handles the screencast's frames only while it waits itself.
        self.page.wait_for_timeout(seconds * 1000)

    def step(self, name: str) -> None:
        self.steps[name] = time.time()

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

    def box(self, selector: str) -> dict:
        box = self.page.locator(selector).first.bounding_box()
        if box is None:
            raise RuntimeError(f"{selector} is not on the page")
        return box

    def center(self, selector: str) -> tuple[float, float]:
        box = self.box(selector)
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

    def hover(self, selector: str, seconds: float = 0.75) -> None:
        """Move onto `selector`, a little below and right of its centre, so the cursor does not
        sit on the label."""
        box = self.box(selector)
        x = box["x"] + box["width"] / 2 + min(box["width"] * 0.25, 16)
        y = box["y"] + box["height"] / 2 + min(box["height"] * 0.25, 8)
        self.move(x, y, seconds)

    def rest(self, y_share: float = 0.45, seconds: float = 0.8) -> None:
        """Wait in the margin right of the column, inside the crop."""
        self.move(self.rest_x, self.height * y_share, seconds)

    def click(self, selector: str, seconds: float = 0.75) -> None:
        self.hover(selector, seconds)
        self.wait(0.18)
        self.page.mouse.down()
        self.wait(0.09)
        self.page.mouse.up()


TILE = 'ryuo-background-tab .tile[data-name="{}"] .thumb'.format


def overlay(director: Director) -> None:
    page = director.page
    director.wait(1.0)
    director.step("slots")
    # Hovering a slot row outlines that slot on the hero.
    for index, seconds in ((0, 0.8), (2, 0.5), (3, 0.45)):
        director.hover(f"#slotRow{index}", seconds)
        director.wait(0.6)
    director.step("choose")
    director.click("#slot3", 0.5)
    # The native list does not show in the screencast; the choice lands as the click's result.
    page.select_option("#slot3", label="GPU Speed")
    director.wait(1.6)
    director.step("toggle")
    director.click("#statsOn", 0.9)
    director.wait(1.6)
    director.click("#statsOn", 0.3)
    director.rest(0.4, 0.8)
    director.wait(1.4)


def preview_apply(director: Director) -> None:
    director.wait(1.0)
    director.step("preview")
    director.hover(TILE("aurora-drift.mp4"), 0.8)
    director.wait(0.35)
    director.hover(TILE("neon-life.mp4"), 0.55)
    director.wait(0.35)
    director.click(TILE("sunset-bloom.mp4"), 0.55)
    director.wait(1.4)
    director.hover("#pvApply", 0.9)
    director.wait(1.4)
    director.step("apply")
    director.click("#pvApply", 0.3)
    director.wait(1.3)
    director.click("#pvReplace", 0.6)
    director.rest(0.45, 0.9)
    director.wait(2.6)


def upload(director: Director) -> None:
    page = director.page
    director.wait(0.8)
    director.step("drag")
    zone_x, zone_y = director.center("#dropZone")
    director.move(WIDTH + 30, zone_y - 40, 0.2)
    page.evaluate("name => window.__demo.card(name)", UPLOAD.name)
    director.move(zone_x - 30, zone_y - 10, 1.3)
    page.evaluate(DROP_SCRIPT, [UPLOAD.name, "", "enter"])
    director.wait(0.5)
    page.evaluate("() => window.__demo.card('')")
    director.step("convert")
    page.evaluate(DROP_SCRIPT, [UPLOAD.name, base64.b64encode(UPLOAD.read_bytes()).decode(), "drop"])
    director.rest(0.55, 0.8)
    page.wait_for_function("() => document.querySelector('#upStatus')?.textContent.startsWith('Playing')", timeout=30_000)
    director.step("playing")
    director.wait(2.4)


def desktop_mirror(director: Director) -> None:
    page = director.page
    director.wait(1.0)
    director.step("on")
    director.click("#modeMirror", 0.8)
    director.rest(0.4, 0.8)
    page.wait_for_function("() => document.querySelector('#displayText')?.textContent.startsWith('On:')", timeout=15_000)
    director.wait(2.4)
    director.step("off")
    director.click("#modeStats", 0.8)
    director.rest(0.4, 0.8)
    page.wait_for_function("() => document.querySelector('ryuo-hero')?.dataset.view === 'live'", timeout=15_000)
    director.wait(1.8)


@dataclass
class Clip:
    tab: str  # opened before the take starts
    bottom: str  # the frame ends just below this element
    scenario: Callable[[Director], None]


CLIPS = {
    "overlay": Clip("#tab-overlay", "ryuo-overlay-tab", overlay),
    "preview-apply": Clip("#tab-background", "ryuo-background-tab .card", preview_apply),
    "upload": Clip("#tab-background", "ryuo-background-tab .card", upload),
    "desktop-mirror": Clip("#tab-mirror", "ryuo-mirror-tab", desktop_mirror),
}


def window_height(port: int, clip: Clip) -> int:
    """Device px from the page's top to just below `clip.bottom` with its tab open: the window is
    cut there, so the result toast, pinned 16 px above the window's bottom, lands in the frame."""
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport={"width": WIDTH, "height": 2400})
        context.add_init_script(CURSOR_SCRIPT)
        page = context.new_page()
        page.goto(f"http://127.0.0.1:{port}/")
        page.wait_for_selector(clip.tab)
        page.click(clip.tab)
        page.wait_for_timeout(500)
        bottom = page.evaluate("s => document.querySelector(s).getBoundingClientRect().bottom", clip.bottom)
        browser.close()
    if bottom <= 0:
        raise RuntimeError(f"{clip.bottom} has no box with {clip.tab} open")
    return 2 * math.ceil((bottom + 24 * ZOOM) / 2)


def record(port: int, clip: Clip, frames_dir: Path) -> tuple[list[tuple[Path, float]], dict[str, float], list[int]]:
    """Play one clip; returns the frames with their times, each step's start, and the crop
    (x, y, width, height) in device px: the column from the hero down to the window's bottom."""
    height = window_height(port, clip)
    shutil.rmtree(frames_dir, ignore_errors=True)
    frames_dir.mkdir(parents=True)
    frames: list[tuple[Path, float]] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport={"width": WIDTH, "height": height})
        context.add_init_script(CURSOR_SCRIPT)
        page = context.new_page()
        page.goto(f"http://127.0.0.1:{port}/")
        page.wait_for_function("() => document.querySelector('#heroVideo')?.currentTime > 0.5", timeout=20_000)
        page.click(clip.tab)
        page.wait_for_timeout(1500)
        hero = page.evaluate("() => { const r = document.querySelector('#hero').getBoundingClientRect(); return [r.left, r.top, r.width]; }")
        left, top = hero[0] - MARGIN, hero[1] - MARGIN / 2
        crop = [2 * round(value / 2) for value in (left, top, hero[2] + 2 * MARGIN, height - top)]
        rest_x = hero[0] + hero[2] + MARGIN / 2

        session = context.new_cdp_session(page)

        def keep(event: dict) -> None:
            path = frames_dir / f"{len(frames):06d}.jpg"
            path.write_bytes(base64.b64decode(event["data"]))
            frames.append((path, event["metadata"]["timestamp"]))
            session.send("Page.screencastFrameAck", {"sessionId": event["sessionId"]})

        session.on("Page.screencastFrame", keep)
        session.send(
            "Page.startScreencast",
            {"format": "jpeg", "quality": 92, "maxWidth": WIDTH, "maxHeight": height, "everyNthFrame": 1},
        )
        director = Director(page, rest_x, height)
        page.mouse.move(director.x, director.y)
        director.wait(0.5)
        clip.scenario(director)
        session.send("Page.stopScreencast")
        browser.close()
    return frames, director.steps, crop


def encode_master(frames: list[tuple[Path, float]], target: Path) -> None:
    """Time the screencast's frames into a constant-rate MP4."""
    lines = []
    for (path, stamp), (_, following) in zip(frames, [*frames[1:], (None, frames[-1][1] + 1 / FPS)], strict=True):
        lines += [f"file '{path}'", f"duration {max(following - stamp, 0.001):.4f}"]
    lines.append(f"file '{frames[-1][0]}'")
    listing = target.with_suffix(".txt")
    listing.write_text("\n".join(lines) + "\n")
    h264(["-f", "concat", "-safe", "0", "-i", listing], target, 12, f"fps={FPS}")
    listing.unlink()


def ffmpeg(*args) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], check=True)


def h264(inputs: list, target: Path, crf: int, video_filter: str = "null") -> None:
    """Encode for playback anywhere: H.264 High, 4:2:0, the index at the front."""
    x264 = ["-c:v", "libx264", "-preset", "slow", "-crf", crf, "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    ffmpeg(*inputs, "-vf", video_filter, *x264, target)


def cut(name: str) -> None:
    """The column-only MP4 and GIF from <name>.master.mp4, with the crop in <name>.json."""
    master = OUT / f"{name}.master.mp4"
    x, y, width, height = json.loads((OUT / f"{name}.json").read_text())["crop"]
    crop = f"crop={width}:{height}:{x}:{y}"
    h264(["-i", master], OUT / f"{name}.mp4", 20, crop)
    # Bayer dithering keeps the gradients from banding at 96 colours and compresses better than
    # error diffusion; diff stats spend the palette on what moves.
    graph = (
        f"[0:v]{crop},fps={GIF_FPS},scale={GIF_WIDTH}:-2:flags=lanczos,split[a][b];"
        "[a]palettegen=max_colors=96:stats_mode=diff[pal];"
        "[b][pal]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle"
    )
    raw = OUT / f"{name}-raw.gif"
    ffmpeg("-i", master, "-filter_complex", graph, "-loop", "0", raw)
    # ImageMagick's frame optimisation takes another 10-15 % off.
    optimise = ["-coalesce", "-fuzz", "2%", "-layers", "Optimize"]
    subprocess.run(["magick", raw, *optimise, OUT / f"{name}.gif"], check=True)
    raw.unlink()


def take(name: str, keep_frames: bool) -> None:
    port = free_port()
    server = start_server(port)
    frames_dir = OUT / f"{name}.frames"
    try:
        frames, steps, crop = record(port, CLIPS[name], frames_dir)
    finally:
        os.killpg(server.pid, signal.SIGTERM)
    encode_master(frames, OUT / f"{name}.master.mp4")
    first = frames[0][1]
    starts = {step: round(max(0.0, stamp - first), 2) for step, stamp in steps.items()}
    (OUT / f"{name}.json").write_text(json.dumps({"crop": crop, "steps": starts}, indent=2) + "\n")
    if not keep_frames:
        shutil.rmtree(frames_dir)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("clips", nargs="*", help=f"clips to record: {', '.join(CLIPS)} (default: all)")
    parser.add_argument("--keep-frames", action="store_true", help="keep the screencast's JPEG frames")
    parser.add_argument("--cut-only", action="store_true", help="make the outputs again from the last masters")
    options = parser.parse_args()
    unknown = [name for name in options.clips if name not in CLIPS]
    if unknown:
        parser.error(f"unknown clip {', '.join(unknown)}; choose from {', '.join(CLIPS)}")
    OUT.mkdir(exist_ok=True)
    for name in options.clips or CLIPS:
        if not options.cut_only:
            take(name, options.keep_frames)
        cut(name)
        for suffix in (".mp4", ".gif"):
            path = OUT / f"{name}{suffix}"
            print(f"{path}  {path.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
