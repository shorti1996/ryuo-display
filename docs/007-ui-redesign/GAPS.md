# UI redesign — open gaps

Spec: `ryuo-ui-handoff/HANDOFF.md`. Page: `web/index.html`.

## Missing: needs backend
- **Requirements detection (KDE Wayland, krfb, NVIDIA)** — card shows static bullets + "ryuod does not check these yet". Needs a `requirements` field in `/api/state` display status.

## Known minor bugs
- Two clients editing tray brightness steps overwrite each other: `/api/tray` takes the whole list, so a page sending before its poll catches up drops the other's change (seen live). Fix: add/remove ops or a version check.

Found by reading the code, not reproduced:
- A state poll sent just before a brightness POST can come back after it; the slider then shows the old value for one poll (~1 s). Needs a request sequence check.
- The finished-upload status line ("Playing …, converted") stays on the Background tab after every page load, even after another file has replaced it. The old page did the same.

## Deviations from the mock (by choice)
- Preview bar button is "Apply" (mock: "Show on panel"); user's choice.
- Apply plays the previewed file alone. When the playlist has more than one file, the bar first asks "Replace the N-file playlist with this file?" [Replace] [Cancel] ("Replace N files?" at phone width); with a one-file playlist Apply sends at once.
- Header is sticky (mock: static). Toast, "+ N more" on live chip, top-right status line added.
- A preview the user asks for shows over the hero's standby view (mock: no preview while in standby); the preview bar then says "panel in standby".
- The hero has two dark views: "Panel in standby" with Turn on (POST /api/panel), and "ryuod is not answering" when the state poll fails.
- Against a ryuod without `config.brightnessPercent` the brightness slider falls back to the device scale 0–102 with a % label; the panel switch, Tray card, Ask again, Open Display Configuration and preset previews are hidden for a ryuod without the `panel`, `tray` and `desktop` keys in `/api/state`.
- The mirror hero caption's button reads "Open" (aria-label and tooltip "Open Display Configuration"), so the caption fits at phone width.

## Behaviour changed vs old page (review)
- "In playlist" checkbox and play mode send `/api/media/select` 400 ms after the last change, and each send restarts the video. Before, nothing went out until "Play".
- Upload starts as soon as a file is chosen/dropped; no "Upload and play" button.
- Playlist order is now custom files first, then presets (was presets first).
- `display-black.png` has no playlist checkbox; reachable only via preview → "Apply".
- Overlay checkbox is disabled while the second display is on.
- Light theme removed (dark only). Previewed video has no player controls.
- Brightness tick marks and visible device-scale note gone.
- First page load requests a preview of the live file, which converts large HEVC once per cache; presets included now.
