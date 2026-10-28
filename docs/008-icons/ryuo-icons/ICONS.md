# Ryuo IV LCD icons — integration notes for ryuo_tray

Design: "D1" pump block (3/4 view, sharp back corners, rounded front-right wrap).
Follows KDE HIG: native 16 and 22 px drawings on the pixel grid (1 px lines on half
pixels, 2/3 px top-bottom margins), monochrome via Plasma's color-scheme stylesheet,
red only for error (ColorScheme-NegativeText emblem, bottom-right, 1 px clearance).

## Files (drop into packaging/icons/, installed to /usr/share/icons/ or ~/.local/share/icons/)
hicolor/scalable/apps/ryuo-lcd.svg                 colour app icon (48 px baseline) — .desktop Icon=ryuo-lcd
hicolor/{16x16,22x22,scalable}/status/
  ryuo-lcd-live-symbolic.svg      ryuod running, cooler connected, stats/background
  ryuo-lcd-mirror-symbolic.svg    panel used as second display
  ryuo-lcd-standby-symbolic.svg   panel turned off from the app (dimmed, empty)
  ryuo-lcd-offline-symbolic.svg   ryuod down or cooler missing (dimmed + red badge)
scalable/status = copy of the 22 px design (fallback for other sizes).
Symbolic SVGs contain <style id="current-color-scheme"> with .ColorScheme-Text /
.ColorScheme-NegativeText and fill/stroke="currentColor"; Plasma swaps the colours to
match the panel theme. Default colour in the file is Breeze light text #232629.

## Code changes (replace make_icon())
1. Load icons by THEME NAME, not by file path or drawn pixmap:
       QIcon.setThemeSearchPaths(QIcon.themeSearchPaths() + [str(repo / "packaging/icons")])  # dev runs
       icon = QIcon.fromTheme("ryuo-lcd-live-symbolic")
   A pixmap/file icon reaches Plasma as raw pixels (no recolouring, no pixel-perfect
   sizes). A theme-named QIcon lets Qt pass the icon *name* over StatusNotifierItem, so
   Plasma loads the SVG itself, picks the 16/22 px drawing and applies its colours.
   VERIFY on Plasma: dark panel -> white icon, light panel -> dark icon. If it stays dark
   on a dark panel, the name isn't being passed; fall back to QIcon(path) per size
   (icon.addFile(path16, QSize(16,16)); icon.addFile(path22, QSize(22,22))) and recolour
   in code from the panel's text colour.
2. State mapping in refresh() (every 3 s from /api/state):
       daemon down or cooler missing        -> offline
       panel off / standby                  -> standby
       second-display (mirror) mode active  -> mirror
       otherwise                            -> live
   (Today there are only on/off; standby and mirror need the fields from /api/state.)
3. Tooltip should name the state ("Ryuo IV — live", "— offline: cooler not found").
4. packaging/ryuo-tray.desktop: Icon=ryuo-lcd (theme name, not path); install the
   hicolor tree; run `gtk-update-icon-cache -f -t <prefix>/share/icons/hicolor` or
   `kbuildsycoca6` after install if the icon doesn't show.
5. Tests: replace the pixel check in test_make_icon with asserting the icon name chosen
   per state (e.g. state->name mapping function) and that every referenced file exists.
6. Qt SVG plugin: Fedora `qt6-qtsvg` (PySide6 wheel bundles it). Missing plugin =
   blank icon; log a warning if QIcon.fromTheme(...).isNull().

Note on line weight: Breeze monochrome icons use 1 px lines at 16/22 px; the
"2 px lines" rule of thumb applies to scaled-down 64 px art, not native-size drawings.
