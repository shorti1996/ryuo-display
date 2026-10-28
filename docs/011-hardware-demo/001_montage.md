# Hardware demo GIF: how it was cut

`hardware-demo.gif` (640 px, 12 fps, 20.7 s, 7.3 MB) shows the cooler's panel on the real PC:
the KDE desktop switching between monitor and panel, cmatrix, the audio visualiser, a terminal,
fastfetch and a cat clip. It is the hero at the top of the README (2026-10-28).

Rebuild it, from this folder, with `/phone-video-montage`'s scripts
(`/home/shared/repos/claude-skills/phone-video-montage/scripts/`):

```bash
python3 ~/.claude/skills/phone-video-montage/scripts/splice.py plan.json hardware-demo
python3 ~/.claude/skills/phone-video-montage/scripts/gif.py out/hardware-demo.mp4
```

Output is byte-identical to the committed GIF (checked 2026-10-28 with `cmp`).

## Sources

Galaxy Z Flip 6 recordings from 2026-10-28, 1080p HEVC Main 10, HDR10. They live in `raw/`
(git-ignored, 140 MB); copies were in `~/Downloads` on the day.

| file | length | what it shows |
|---|---|---|
| `szeroki_20261028_191448.mp4` | 16.4 s | whole PC; desktop switch at ~2.0–2.75 s and back at ~4.25–4.5 s; zooms in from ~12 s |
| `normalny_20261028_191605.mp4` | 20.5 s | panel and monitor edge; window across both screens 0–3.5 s, cmatrix 4.5 s, visualiser 6–9 s, terminal 10–12 s, zoom 12.5–13.75 s, cat 17 s |
| `koncowka_20261028_192344.mp4` | 9.0 s | close-up re-shot because the zoom in `normalny` was unreadable: fastfetch 0–3.5 s, cat 4–9 s |

## Cuts (`plan.json`, variant `hardware-demo`)

1. `szeroki` 0–4.8 s: both desktop switches, cut right after the switch back.
2. `normalny` 5.24–12.4 s: starts with cmatrix already filling the panel. Starting earlier
   showed the window sliding across two screens and the jump from the wide shot read as odd.
   Fills from 4.5 s, but 5.24 s is the first keyframe after that; a stream-copy cut cannot
   start between keyframes.
3. `koncowka` whole: replaces the zoom in `normalny`.

Rejected: variant `after-zoom`, which kept `normalny`'s zoom before the close-up.

## GIF settings

Defaults of `gif.py`: libplacebo HDR→SDR (bt.2390, saturation +10%, contrast +5%), 640 px,
12 fps, 256 colours, bayer5 dither, `hqdn3d=4:3:6:6`, ImageMagick `-fuzz 2%`. The size
comparison against 10 fps / 128 colours / 480 px variants is in the skill.
