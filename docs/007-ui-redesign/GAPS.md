# UI redesign — open gaps

Spec: `ryuo-ui-handoff/HANDOFF.md`. Page: `web/index.html`. Each item below is in the mock and missing from the page because the backend has no support for it yet.

## Missing: needs backend
- **Panel On/Standby switch (header) + hero "Turn on"** — not built. Standby is only the tray's "Stop" (`systemctl --user stop ryuod`). Needs e.g. `POST /api/panel {on}` that blanks/resumes HomeUI with the daemon still running.
- **"Ask again" (reset screen-share choice)** — not built. Needs an endpoint that deletes `~/.config/ryuo/display-portal-token`.
- **Requirements detection (KDE Wayland, krfb, NVIDIA)** — card shows static bullets + "ryuod does not check these yet". Needs a `requirements` field in `/api/state` display status.
- **App tab → Tray card** (start with session, left-click action, brightness steps chips) — not built. Needs tray settings in config + POST endpoint, and `ryuo_tray.py` reading them (today `BRIGHTNESS_STEPS` is hard-coded).
- **Preset preview/thumbnails** — preset tiles are placeholders that can't be clicked. `/api/media/thumb` and `/api/media/preview` only serve `/sdcard/pcMedia`, they'd also need `/sdcard/pcMediaPreset`.

- **"Open Display Configuration" button (mirror view)** — page only shows a text hint (System Settings → Display & Monitor → Display Configuration → Virtual-RYUO). A button needs an endpoint that runs `kcmshell6 kcm_kscreen` (or `systemsettings kcm_kscreen`) in the user session.

- **Image upload** — drop zone accepts video only; mock says "video or image". Upload endpoint refuses stills.

## Known minor bugs (found by reading the code, not reproduced)
- A state poll sent just before a brightness POST can come back after it; the slider then shows the old value for one poll (~1 s). Needs a request sequence check.
- The finished-upload status line ("Playing …, converted") stays on the Background tab after every page load, even after another file has replaced it. The old page did the same.

## Open questions
- "Apply" sends playlist `[name]`: applying a file that is already in a multi-file playlist drops the others. Intended?

## Deviations from the mock (by choice)
- Preview bar button is "Apply" (mock: "Show on panel"); user's choice.
- Brightness slider still on device scale 0–102, label shows % of 255. Mock: 0–100 % slider, mapping in backend.
- Header is sticky (mock: static). Toast, "+ N more" on live chip, top-right status line added.
- Hero "standby" view means "ryuod not answering", not panel standby.
- Drop zone says "Drop a video" — upload refuses still images.
- Brightness % mapped in the page (slider stays on device 0–102 scale), not in backend as HANDOFF says.

## Behaviour changed vs old page (review)
- "In playlist" checkbox and play mode send `/api/media/select` 400 ms after the last change, and each send restarts the video. Before, nothing went out until "Play".
- Upload starts as soon as a file is chosen/dropped; no "Upload and play" button.
- Playlist order is now custom files first, then presets (was presets first).
- `display-black.png` has no playlist checkbox; reachable only via preview → "Apply".
- Overlay checkbox is disabled while the second display is on.
- Light theme removed (dark only). Previewed video has no player controls.
- Brightness tick marks and visible device-scale note gone (level only in tooltip).
- First page load requests a preview of the live file, which converts large HEVC once per cache.
