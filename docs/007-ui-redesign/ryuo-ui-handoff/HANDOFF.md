# Ryuo IV LCD control page — UI redesign handoff

`reference-design.html` is the approved design (canvas variant "B2"). It uses a
canvas runtime (`<x-dc>`, `{{holes}}`, `<sc-if>`, `<sc-for>`, `DCLogic` class), so it
will NOT run standalone. Treat it as a visual + behavioural spec: copy styles,
structure and states; reimplement in the app's own stack. Logic for every state
is in the `renderVals()` script at the bottom.

Goal: restyle the existing browser control page to this design WITHOUT changing
the backend API. Keep every existing feature; only layout, wording and controls change.

## Design tokens
- Fonts: Inter (UI), JetBrains Mono (values, filenames), Roboto Condensed with
  Bahnschrift / Arial Narrow fallback (panel overlay preview only). Google Fonts or bundle locally.
- Ground #0E0F11 · header #121316 · card #16171A · card border #25272C ·
  inner divider #222429 · input bg #1D1F23 · input border #2E3137 · tile bg #121316
- Text #E8E9EB · secondary #C9CBD0 · muted #9A9DA4 · section label #A6A9B0
- Accent #E5252B (buttons, active tab underline, switches, range/checkbox accent-color)
- Accent text on dark #FF8A8E / outline #FF6B70 (Preview badge)
- Success #34D27B dot, #7BE8AA text on #13261B (Connected pill)
- Radii: card 14, hero 16, tile 12, input/button 9, pill 999. Card padding 20. Gap 18–20.
- Section labels: 13px, 600, uppercase, letter-spacing .08em.
- Min control height 40–44px.

## Layout (top → bottom), max-width 1180px centred
1. **Header**: "RYUO IV LCD" · spacer · Connected pill (click → App tab) ·
   **Panel switch** (On / Standby) = existing "Stop (panel goes to standby)".
2. **Hero preview**: 2240:1080 box, `container-type: inline-size`; overlay font sizes in `cqw`.
   - Background = the media playing on the panel (the app already can play these files in the
     browser). Placeholder when nothing: radial-gradient(ellipse at 30% 40%, #2a1015 0%,
     transparent 60%), radial-gradient(ellipse at 80% 70%, #101a2a 0%, transparent 55%), #050506.
   - Stats overlay drawn on top using the HomeUI slot geometry (as today).
   - Top-left chip "● Live · <file>" when showing the live state.
   - **Preview state**: clicking a media tile plays that file in the hero (overlay stays on top).
     Bottom-centre floating bar, single line, never wraps (filename ellipsizes):
     `PREVIEW` badge · filename · "not on the panel yet" · [Show on panel] (accent) · [×] (back to live).
     Replaces the old preview box + "Close preview" button.
   - Mirror mode: show desktop-mirror placeholder + chip "Desktop mirror · Virtual-RYUO 2240×1080".
   - Standby: black, power icon, "Panel in standby", [Turn on].
3. **Control strip** (card): segmented "Stats & background | Desktop mirror"
   (= existing "Panel as monitor" checkbox) · Overlay checkbox (disabled in mirror mode) ·
   brightness slider 0–100 % with value · "sampled <time>".
   Brightness: UI shows % only; map to device scale in backend (device 0–102, 100=250/255, 102=255/255).
4. **Tabs**: Overlay · Background · Desktop mirror · App.

### Overlay tab
- Left card: 6 slot rows: number badge · position label · stat select.
  Hover/focus a row → dashed accent outline around that slot in the hero.
- Right: Colours card (Title, Values swatches + hex; Coverage animation checkbox;
  keep filter opacity slider if supported). Units card (°C/°F segmented; Memory MHz number,
  note "No Linux source without root. 0 hides Memory Frequency.").

### Background tab
- Card "On the cooler /sdcard/pcMedia": header controls Play mode select, [Restart video],
  refresh icon button.
- Tile grid `repeat(auto-fill, minmax(200px, 1fr))`. Tile: thumbnail (click = preview in hero),
  badges "On panel" (accent fill) / "Previewing" (accent outline), filename (mono, ellipsis),
  trash icon (delete — keep existing two-step confirm), "In playlist" checkbox, size.
  Border: accent if on panel, #FF6B70 if previewing.
- **display-black.png is a system file**: lock icon instead of trash, no playlist checkbox,
  label "System · Desktop mirror". Never deletable.
- Last tile = upload drop zone: drag & drop + [Browse] + shape select (Fill crop / Fit black bars).
  Upload converts to 2240×1080 HEVC, no sound (existing behaviour).
- Card "Built-in presets": the 5 RYUO_IV_HW_Info_0N.mp4 as small tiles (preview + playlist checkbox, no delete).

### Desktop mirror tab
- Big switch "Use the panel as a second display" + status line (reuse current status text).
- Three short info lines (virtual monitor right of main; overlay/bg pause, brightness works;
  redraw on change, off takes up to 10 s).
- Mouse pointer row + [Ask again] (reset saved screen-share choice).
- Requirements card with check marks: KDE Plasma on Wayland, krfb, NVIDIA GPU (show real detection results; ✗ if missing).

### App tab (app-level, not panel)
- Tray: Start with desktop session · Left-click action select · editable tray brightness steps
  (chips with ×, "+ Add step"; feeds the tray Brightness submenu).
- Device & connection: model, firmware, hidraw path, heartbeat, HomeUI ack (moved from header).
- New app settings go here in future.

## Notes
- Accessibility: real buttons/inputs/labels, role="switch"/aria-checked on switches,
  role="tablist"/"tab"/aria-selected on tabs, aria-label on icon buttons.
- Responsive: cards are flex-wrap rows; works down to phone width.
- Values in the design (59 °C etc.) are samples; use live data.
