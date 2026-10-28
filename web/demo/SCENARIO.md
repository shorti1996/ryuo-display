# Demo recordings: scenario

What `web/demo/record.py` plays against `npm run demo`, recorded by Playwright: four short clips,
one per feature, each its own take. Lengths are as recorded on 2026-10-28.

## Setup

- **Frame:** the page is laid out 1440 CSS px wide and drawn at 1920 px (root zoom 4/3). The
  window is as tall as the page from its top to just below the part the clip uses, so the hero,
  the strip and the open tab are on screen together and the page never scrolls. The crop is the
  column, 1132 CSS px, plus a margin; the header is outside it.
- **Toast:** pinned 16 px above the window's bottom, so the window's bottom is the crop's bottom
  and the toast lands in the frame.
- **Outputs**, under `web/demo/out/`: `<clip>.mp4` (the crop at full resolution, H.264) and
  `<clip>.gif` (800 px wide, 8 fps, 96 colours). The README's copies are in `docs/demo/`.
- **Cursor:** a white dot with a dark ring, drawn into the page. It moves along eased curves
  (about 0.5–0.9 s per move), shrinks on each click and sends out a ring, and waits in the margin
  right of the column, inside the crop.
- **State:** a fresh demo server for every clip, so each one starts from the same playlist
  (aurora-drift, neon-life and synthwave-spiral, in order) with the second display off. The tab
  the clip uses is open before the take starts.

## Clips

### overlay (13 s, Overlay tab)

The cursor passes over slot rows 1, 3 and 4; each outlines its slot on the hero. It clicks slot 4's
list and GPU Load becomes GPU Speed (the native list does not show in the screencast). It unticks
**Overlay** in the strip, and the stats leave the hero; 1.6 s later it ticks it again.

### preview-apply (14 s, Background tab)

The cursor passes over two tiles and clicks **sunset-bloom.mp4**. The hero plays it with the bar
"PREVIEW sunset-bloom.mp4 · not on the panel yet · Apply". It clicks **Apply**, the bar asks
"Replace the 3-file playlist with this file?", and it clicks **Replace**. The toast confirms and the
chip becomes "Live · sunset-bloom.mp4".

### upload (14 s, Background tab)

A file card, "gameplay-highlight.mp4", follows the cursor in from the right edge and is dropped on
the drop zone. The status line steps through checking, converting to 2240×1080 HEVC, copying over
adb and starting playback while the bar fills. A new tile appears with "On panel" and the hero plays
the uploaded clip. The clip is rendered by `make-media.sh` and looks unlike the seven on the cooler.

### desktop-mirror (22 s, Desktop mirror tab)

The cursor clicks **Desktop mirror** in the strip. The hero turns into the sketched desktop with
"Desktop mirror · starting…", then "Virtual-RYUO 2240×1080"; the tab shows the switch on, "On: …
frames/s at … Mb/s to the panel" and the burn-in protection card active. The cursor clicks **Stats &
background**: the hero shows the spinner and "Switching to Stats & background" for 5 s, then the
background and stats again.

## Files

- `web/demo/record.py`: the script; `record.py [CLIP ...]` records the named clips, all by default.
- `web/demo/out/`: the recordings, ignored by git.
