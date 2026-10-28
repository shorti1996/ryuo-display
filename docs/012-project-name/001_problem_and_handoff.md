# Project name: problem and handoff

Status: name not chosen, nothing renamed (2026-10-28). Comes from the session that added the README
hero GIF and the GPL-3.0-or-later licence (`e4d73bc`). The task is to propose a name with the
user, then rename. This doc holds the constraints, the rejected names and every place the current
name appears.

## The short version

1. The current names are wrong: the repo is `rog-ryuo-lcd` (Gitea: `rog-ryuo-lcd-video`) and the
   tray says "RYUO LCD", but the panel is a 2240×1080 **OLED** (`README.md:5`). The user rejected
   any name containing "lcd" for that reason.
2. The project does two things. By default it controls the panel: the stats overlay, video
   playback, brightness, a control page and a tray icon. On demand, it turns the panel into a
   second monitor of the KDE desktop. As far as the two prior projects show, nobody else does the
   second monitor (open question 2). The user wants that to be visible in the name or tagline.
3. Names the user floated, not decided: "ryuo external display", "ryuo secondary display". The
   previous session suggested `ryuo-display`.
4. "lcd" appears in 127 lines across 41 tracked files and 40 tracked file names (2026-10-28,
   commands in §9). Most are docs; the user-facing ones are listed in §7.

## Rejected names (checked, do not re-propose)

| name | why it is out |
|---|---|
| `rog-ryuo-lcd`, `ryuo-lcd` | the panel is OLED, not LCD; rejected by the user |
| `ryuo-screen` | too close to FoxPodZ's `ryuo-iv-screen` (https://github.com/FoxPodZ/ryuo-iv-screen), a separate GPL project for the same cooler |
| any name starting with `rog-` | "ROG" is ASUS's brand line, so it reads as an official ASUS product. The README disclaimer (`README.md`, Disclaimer) says the project is unofficial. The user did not object when this was raised; not formally decided. |

## Constraints on the name

- **Searchability.** Owners search for the cooler model ("ryuo iv linux"), so "ryuo" in the name
  or the first line of the description gets the project found. A name of its own (e.g.
  `pumpview`) must carry "RYUO IV" in the description instead.
- **The default mode is not the second display.** Most of the time the panel shows stats over a
  video. A name built only on "external display" or "secondary display" describes the opt-in
  mode and hides the main one. Weigh that against the user's wish to advertise the unique
  feature; a tagline can carry it instead (draft below).
- **ASUS's own code says LCD** (`fanLCD` in HomeUI's reply, `ryuod.py:946`), so the wrong term is
  the vendor's, not a typo. That string is the protocol's and must stay as it is.
- **The short prefix `ryuo` already works.** The executables (`ryuod`, `ryuo.py`,
  `ryuo_tray.py`, `ryuo_display.py`), the config dir `~/.config/ryuo/` and the unit
  `ryuod.service` contain no "lcd" and need no rename.
- **Licence is settled:** GPL-3.0-or-later (`LICENSE`, `e4d73bc`). The user did not want the
  README to advertise that others may sell it; it says "use, change and share".

Draft tagline, from the previous session, not approved:

> Linux control panel for the OLED screen on the ASUS ROG RYUO IV: live PC stats, your own
> videos, and the only software that turns the screen into a second monitor.

## Candidates still open

| name | for | against |
|---|---|---|
| `ryuo-display` | "display" is right for OLED and hints at the second monitor | shares the word with the internal `ryuo_display.py` (users never see that file) |
| `ryuo-external-display` | says the unique feature outright | long; describes the opt-in mode only |
| `ryuo-secondary-display` | same idea | longer still; same problem |
| `ryuo-oled` | exact | says nothing about what the software does |
| `ryuo-panel` | means both the screen and a control panel | "panel" is KDE's word for the taskbar |
| a name of its own | product-like; survives support for other coolers | needs "RYUO IV" in the description to be found |

The user-visible label (tray, start menu, browser tab) need not equal the repo slug: e.g. repo
`ryuo-display`, label "RYUO Display".

## Files: where the name appears

User-facing, rename with the name:

| path | what |
|---|---|
| `README.md:1` | title `# rog-ryuo-lcd` |
| `README.md:5` | first sentence; the tagline goes here |
| `packaging/ryuo-tray.desktop:3-4,7,11` | `Name=RYUO LCD`, `GenericName=Pump LCD control`, `Icon=ryuo-lcd`, `Keywords=…lcd…` |
| `ryuo_tray.py:70` | icon name `ryuo-lcd-{state}-symbolic` |
| `ryuo_tray.py:190,201,203,222` | notification title and tooltip "RYUO LCD" |
| `web/src/index.html:6` | browser tab `RYUO LCD Stats` |
| `web/src/ui/ryuo-app.ts:95` | page heading `RYUO IV LCD` |
| `packaging/icons/hicolor/*/*/ryuo-lcd*.svg` | 13 icon files; the names are what the tray and launcher ask the icon theme for |
| `Makefile:73` | install message "start RYUO LCD again" |
| `packaging/ryuod.service:2` | unit `Description=` |
| `pyproject.toml:2,4` | `name = "rog-ryuo-lcd"`, description |
| `web/package.json:2` | `"name": "ryuo-lcd-web"` |
| docstrings `ryuo.py:2`, `ryuo_proto.py:1`, `ryuod.py:2` | "pump LCD" |

Do not forget:

| path | why |
|---|---|
| `tests/test_tray.py` | 10 lines assert the `ryuo-lcd-*` icon names; they fail until updated |
| `Makefile:90-94` (`uninstall`) | removes icons by the **current** names from `ICON_FILES`. After a rename, `ryuo-lcd*.svg` already installed in `~/.local/share/icons` is left behind; remove the old names once by hand or in the Makefile |
| `ryuo_display.py:759` `PORTAL_APP_ID = "org.rogryuolcd.Display"` | the desktop portal stores the screen-selection permission under this app id. Changing it makes Plasma ask which screen to share again on the next second-display start. Leave it, or accept one prompt |
| `ryuo_display.py:618-619` D-Bus `org.rogryuolcd.Display` | internal, not shown to users; renaming is optional and must match everything that calls it (`busctl`/`gdbus` lines in `docs/006-second-display-slow-capture/001_problem_and_handoff.md`) |
| `Makefile:27` `70-rog-ryuo-iv.rules` | the udev rule names the device, not the project; renaming forces every user to rerun `make install-udev` with sudo. Leave it |
| `docs/001-lcd-protocol/`, `docs/008-icons/` | historical folder and file names; leave them, they are records |
| `web/dist/` | built output; rebuild after changing `web/src` |

Outside the repo:

- Gitea repo `shorti1996/rog-ryuo-lcd-video` (remote `origin`,
  `ssh://git@wroha.chickenkiller.com:2222/shorti1996/rog-ryuo-lcd-video.git`): rename in the
  Gitea settings, then `git -C <repo> remote set-url origin <new url>`.
- Local checkout `/home/shared/repos/rog-ryuo-lcd`: the installed unit and launchers point at it
  (`@APPDIR@` in `Makefile:64`). Moving it means `make install` again. Memory files under
  `~/.claude/projects/-home-shared-repos-rog-ryuo-lcd/` are keyed on this path and would not
  follow a move.
- `/home/shared/repos/workstation-notes/notes/machine/ryuo-lcd.md` and its changelog name the
  project; update them with `/save-workstation-change` after the rename.

## How to work

- Branch first; `main` is pushed to Gitea.
- `make test` runs the Python tests (one worker per CPU) and the frontend tests.
- `make build-frontend` rebuilds `web/dist/` after any `web/src` change.
- `make install` re-installs the unit, launcher and icons from the checkout; no sudo.
- The user approves the name before any rename, and every commit and push.
- Prose follows `/home/shared/repos/claude-skills/rules/prose-style.md`; the README leaves out
  the serial comma ("use, change and share").

## Commands that established state (run 2026-10-28)

```sh
# lines mentioning lcd, per file, excluding lockfiles: 127 lines in 41 files
git -C /home/shared/repos/rog-ryuo-lcd grep -ciE 'lcd' -- . ':!web/package-lock.json' ':!uv.lock'
# tracked file names containing lcd: 40 (icons in packaging/ and docs/008-icons/, plus docs/001-lcd-protocol/)
git -C /home/shared/repos/rog-ryuo-lcd ls-files | grep -i lcd
# user-facing occurrences in code, the source of the table above
git -C /home/shared/repos/rog-ryuo-lcd grep -nE -i 'lcd|rogryuo|rog-ryuo' -- '*.py' '*.ts' 'web/src/*.html' packaging Makefile pyproject.toml web/package.json receiver
```

The counts include binary GIF and MP4 files whose bytes happen to contain "lcd"; ignore those.

## Success criteria

1. The user has picked a repo slug, a display label and a tagline.
2. After the rename, `git grep -n -i lcd -- '*.py' '*.ts' 'web/src/*' packaging Makefile pyproject.toml`
   shows only `fanLCD` (the protocol string at `ryuod.py:946`) and anything deliberately kept.
3. `make test` passes, `tests/test_tray.py` included.
4. After `make install`, the tray icon, its tooltip and the start-menu entry show the new name,
   and no `ryuo-lcd*.svg` remains in `~/.local/share/icons/hicolor`.
5. The second display still starts without a screen-selection prompt, or the user agreed to one.

## Open questions

1. **Does the name advertise the second display, or does the tagline?** It decides between
   `ryuo-display`-style names and `ryuo-external-display`-style names. Only the user can settle it.
2. **Is it really the only software with a second-display mode?** Checked only against FoxPodZ
   and dragocz95 (`README.md`, Credits). Search GitHub, the ASUS forums and Reddit for "RYUO IV"
   with "second monitor" or "extend display" before the tagline claims "the only".
3. **What does ASUS's marketing call the screen?** Its code says LCD; the hardware is OLED. Using
   ASUS's product-page term in the description helps search. Not looked up.
4. **Rename the local folder or not?** It costs a `make install` and orphans the memory folder;
   keeping it costs nothing but a stale path.
