# Demo recording: scenario

What `web/demo/record.py` will play against `npm run demo`, recorded by Playwright. Times are
approximate. The total length is about 65 s.

## Setup

- **Capture:** a 1920×1080 headless Chromium window with the page zoomed to 4/3, so it is laid
  out as at 1440×810 (header, hero and strip fit without scrolling) and drawn at full
  resolution. Frames come from the DevTools screencast and are timed into a 30 fps master.
- **Outputs:** `reddit.mp4` (1920×1080, the whole take), `readme.mp4` (1280×720, the whole take,
  under GitHub's 10 MB upload limit) and `readme.gif` (800 px wide, cropped to the hero and
  strip: shots 3–4, the start of 6, and 7).
- **Cursor:** a white dot with a dark ring, drawn into the page. It moves along eased curves
  (about 0.6–0.9 s per move), shrinks on each click and sends out a ring, and waits in the margin
  right of the column.
- **State:** a fresh demo server for every take, so each recording starts from the same playlist
  (aurora-drift, neon-life and synthwave-spiral, in order) with the second display off.
- **Scrolling:** smooth, never a jump.

## Shots

### 1. Opening (0:00–0:05)

The page at the top: header with "Connected · V1.0.10" and the panel switch on; the hero plays
aurora-drift.mp4 with the six stats changing every second; chip "Live · aurora-drift.mp4 + 2
more". The cursor rests to the right of the column. Nothing moves except the hero.

### 2. Background tab (0:05–0:10)

The cursor goes to the **Background** tab and clicks. The page scrolls down until the tile grid
fills the frame: seven files with thumbnails and sizes, three marked "On panel", the drop zone,
and the built-in presets below.

### 3. Preview a clip (0:10–0:18)

The cursor passes over two tiles, stops on **sunset-bloom.mp4** and clicks its thumbnail. The
page scrolls back up to the hero, which now plays sunset-bloom with the preview bar: "PREVIEW
sunset-bloom.mp4 · not on the panel yet · Apply". Hold 3 s.

### 4. Apply (0:18–0:26)

The cursor clicks **Apply**. The bar asks "Replace the 3-file playlist with this file?". Pause
1.2 s, then click **Replace**. The toast reads "Background sunset-bloom.mp4 — cooler confirmed,
video restarted", and the chip becomes "Live · sunset-bloom.mp4". Hold 2.5 s.

### 5. Upload (0:26–0:42)

The page scrolls down to the drop zone. A file card, "gameplay-highlight.mp4", follows the cursor
in from the right edge and is dropped on the zone. The status line under it steps through
"Checking…", "Converting to 2240×1080 HEVC with hevc_vaapi: 40 % at 3.1x", "Copying to the
cooler over adb…" and "Starting playback…" while the bar fills. A new tile appears with "On
panel". The page scrolls up: the hero plays the uploaded clip. Hold 2 s.

The uploaded clip is a new one rendered by make-media.sh, so it looks different from the seven
already on the cooler.

### 6. Desktop mirror on (0:42–0:54)

The cursor clicks **Desktop mirror** in the strip under the hero. The hero turns into the
sketched desktop with "Desktop mirror · starting…"; 2.5 s later it reads "Virtual-RYUO
2240×1080", with "Protection: active · next shift in 3 min" on the right and the "Position and
scale" caption below. The cursor opens the **Desktop mirror** tab; the page scrolls a little to
show "On: 29.4 frames/s at 11.8 Mb/s to the panel" and the burn-in protection card. Hold 2 s.

### 7. Back to stats (0:54–1:05)

The page scrolls back to the hero. The cursor clicks **Stats & background**. The windows fade
under the spinner and "Switching to Stats & background" for 5 s, then the hero shows the
uploaded clip again with the stats. Hold 3 s; end.

## Files

- `web/demo/record.py`: the script; one command records one take.
- `web/demo/out/`: the recordings, ignored by git.
