# Control page rewrite: Lit + TypeScript + Vite

Status: designed, nothing implemented. 2026-10-27, from a design interview in a Claude Code
session. Work happens in the `frontend-lit` branch, worktree
`/home/shared/repos/rog-ryuo-lcd-frontend-lit`, while `burn-in-protection` continues in the main
checkout.

## The short version

1. `web/index.html` is one 1 638-line file: 375 lines of CSS (lines 10 to 385) and 1 038 lines
   of inline JavaScript (598 to 1636) with 76 top-level functions. It works and is hard to change.
2. State is 15 module-level `let`s; every render writes the DOM by id, and each feature carries a
   `renderX` plus a `syncX` that must agree with the 1 s poll (`pollState`, line 1520).
3. "The user is editing, do not overwrite" is five separate checks: `dragging` (788, 824, 882),
   `traySending` and `stepAdding` (1422, 1423, 1507), `document.activeElement` (823, 1507).
4. There are no types. A renamed key in `GET /api/state` fails at runtime only.
5. The tests are the asset to keep: 2 500 lines over 11 files, 262 `describe`/`it` blocks, driving
   the page through element ids against a fake ryuod (`web/tests/harness.js`, 451 lines, mirroring
   `ryuod.py`'s Handler) with a guard that fails any request the fake does not serve
   (`web/tests/setup.js`).

The rewrite moves the page to Lit 3 + TypeScript + Vite + Vitest, keeps the tests, and changes
one thing in ryuod: it serves `web/dist/` instead of `web/index.html`.

## Checked, do not re-investigate

- **The README claim "no external requests" is false today.** `web/index.html:7-9` loads Inter,
  JetBrains Mono and Roboto Condensed from fonts.googleapis.com. The rewrite bundles the fonts
  (Q17) and makes the claim true.
- **ryuod's Host check** (`ryuod.py:1954`, `host_ok`) accepts only `127.0.0.1:8746` and
  `localhost:8746`. A dev proxy must rewrite Host or every `/api` call gets 403.
- **Legacy-ryuod mode** (`newApi` in the page, `legacy` in the harness) exists for a page talking
  to a ryuod from before the panel switch. 12 test cases use it: `controls.test.js:115-141`,
  `features.test.js:90, 242, 273, 308, 330`, `layout.test.js:65`, `media.test.js:195`. Page and
  daemon ship from one checkout, so the new page drops it (Q3).
- **Nothing else references `web/index.html`**: `ryuod.py:46` (`INDEX`), `ryuod.py:1970-1981`
  (`do_GET`), `tests/test_ryuod_http.py:258-270` (two tests that monkeypatch `INDEX`),
  `Makefile:145` (`test-frontend`), `README.md:262`. The tray opens the URL, never the file.
- **Toolchain present**: node 22.22.2, npm 10.9.7, vitest 5.0.5 and happy-dom 20.14.5 already in
  `web/package.json`. happy-dom 20 has no `Option` constructor; the harness polyfills it
  (`harness.js:23-31`). Keep the polyfill.

## Design agreed

Every item below was put to the user as a question and accepted. "Q" numbers are the interview
order, kept so a later reader can find the discussion.

### Stack (Q4, Q12, Q21)

- Lit 3, TypeScript `strict`, Vite 7, Vitest 5, Biome for lint and format. No decorators: Lit
  properties use `static properties`. No Vite plugins.
- **Light DOM.** Every element overrides `createRenderRoot()` to return itself. This is a page we
  own, not an embedded card: the stylesheet stays one global file, tests keep querying
  `document`, and the existing element ids keep working.
- A hand-written store, about 40 lines: one `AppState` object, `patch()`, `subscribe()`, and a Lit
  reactive controller that re-renders a subscribed element. No signals library.

### Architecture (Q5, Q6, Q7, Q8, Q14, Q16)

- Vite root is `web/src/`, so the entry is `web/src/index.html` and the old `web/index.html`
  stays untouched during the port.
- Layout:

  ```
  web/src/
    index.html         Vite entry; the page markup shell
    main.ts            defines the elements, starts the poll
    styles.css         the old <style> block, moved verbatim
    api.ts             typed fetch wrappers for /api/*
    api-types.ts       hand-written types, each commented with the ryuod function it mirrors
    state.ts           AppState, the store, the poll loop
    actions.ts         one function per user action: API call + outcome message + debounce
    report.ts          the outcome sentences (today report(), index.html:645)
    brightness.ts      the 0-102 / percent mappings
    playlist.ts        playlist text and ordering
    upload.ts          upload progress state
    ui/ryuo-app.ts            header, tabs, toast, connection pill
    ui/ryuo-overlay-tab.ts
    ui/ryuo-background-tab.ts
    ui/ryuo-mirror-tab.ts
    ui/ryuo-app-tab.ts
    ui/ryuo-hero.ts           preview / standby / unreachable views
    ui/ryuo-upload-zone.ts
    ui/ryuo-slot-picker.ts
  ```

- **Polling stays.** The store is fed by the same 1 s polls of `/api/state` and `/api/stats` and
  the 15 s catalog refresh (`index.html:1626-1634`). Transport is one module so server push can
  replace it later without touching components.
- **Editing guard.** The store keeps `editing: Set<string>` of config keys the user is changing: a
  focused select, a dragged slider, a debounce still pending. The poll merges fresh config into
  the store except those keys. The 400 ms debounces for overlay and media select and the slider
  send live in `actions.ts` and add or remove their key. This replaces the five checks listed in
  "The short version" item 3.
- **Children call actions directly.** Tab elements read the store and call `actions.ts`. No
  CustomEvent plumbing up to the shell.
- Component cut: the shell, one element per tab, and the three pieces complex enough to test
  alone (hero, upload zone, slot picker). Everything else is a template function inside its tab.

### Build and serving (Q9, Q10, Q11, Q13, Q17)

- `vite build` writes `web/dist/`: `index.html`, one JS, one CSS, the woff2 files. Fixed names,
  no content hashes. `web/dist/` is committed so `make install` needs no node, the same rule as
  the committed `receiver/receiver.jar`.
- Fonts from the pinned `@fontsource` packages, only the weights the stylesheet uses: Inter 400
  to 700, JetBrains Mono 400 and 500, Roboto Condensed 400 to 600.
- ryuod maps `/` to `dist/index.html` and serves only files that exist in `dist/`, with a small
  mime table and the existing `Cache-Control: no-store`. No path traversal, no directory listing.
- `npm run dev` runs Vite on its default port 5173 with `/api` proxied to `127.0.0.1:8746` and the
  Host header rewritten. Dev only; users keep opening http://127.0.0.1:8746/.
- `make build-frontend` builds. `make test-frontend` typechecks, runs the tests, builds, and fails
  if `git diff` shows `web/dist/` changed. Biome joins `make lint` and `make format` beside ruff.

### Tests (Q2, Q3, Q15, Q22)

- The existing `tests/*.test.js` and `harness.js` keep their names and language. Element ids are
  frozen until the port is done so the tests keep passing unchanged.
- The harness changes in one place: instead of extracting the inline `<script>` (`harness.js:
  10-14`) it sets the body from `web/src/index.html` and does `await import("../src/main.ts")`
  after `vi.resetModules()`, so each test gets a fresh store.
- **Two harnesses during the port.** A test file keeps loading the old `web/index.html` until
  every case in it passes against the new page, then it switches to the new harness. No test is
  skipped at any commit. The old harness is deleted in the switch commit.
- The 12 legacy cases are deleted. New unit tests for the pure modules are written in
  TypeScript and run in node, no DOM.

### Process (Q1, Q18, Q19, Q20)

- Branch `frontend-lit` in its own worktree. One commit per step. Merge to main at parity.
- Order: shell + App tab, then Overlay, then Mirror, then Background (the largest: media, upload,
  hero). Each step ends with its old tests green against the new page.
- `web/dist/`, the ryuod change, the deletion of `web/index.html` and the old harness, the README
  update and this doc's status line land together in the final switch commit, so earlier
  commits carry no bundle churn.

## Recommended order of work

| step | delivers | ships alone? |
|---|---|---|
| 1 | Scaffold: `web/src/`, Vite, tsconfig, Biome, store, poll, `api.ts`, `api-types.ts`, shell element, App tab. `app`/`harness`/`prefs`/`sync` tests moved to the new harness where they pass. | no, old page still serves |
| 2 | Overlay tab, slot picker, `report.ts`, `brightness.ts` with node tests. `controls`, `slots`, `preview`, `errors` tests moved. | no |
| 3 | Mirror tab, `display` and the display cases of `features` moved. | no |
| 4 | Background tab, hero, upload zone, `playlist.ts`, `upload.ts`. `media`, `load`, `layout` tests moved. | no |
| 5 | Switch: ryuod serves `dist/`, old page and harness deleted, Makefile targets, README, `dist/` committed. | yes, this is the merge point |

Before the merge, diff `web/index.html` against `main`: the `burn-in-protection` branch may have
changed it, and those changes must be ported into the new page.

## Files

| path | why |
|---|---|
| `web/index.html` | the page being replaced; CSS 10-385, JS 598-1636, wire-up 1570-1636 |
| `web/tests/harness.js:10-14` | the script extraction the new harness replaces |
| `web/tests/setup.js` | the stray-request guard; keep as is |
| `web/vitest.config.js` | happy-dom options; `include` must also pick up `*.test.ts` |
| `web/package.json` | add lit, vite, typescript, biome, @fontsource/*; add `dev`, `build`, `typecheck`, `lint` scripts |
| `ryuod.py:46` | `INDEX` becomes a `DIST` directory |
| `ryuod.py:1970-1981` | `do_GET` static branch; add the existence allowlist and mime table |
| `tests/test_ryuod_http.py:258-270` | `test_get_index` and `test_get_index_missing` monkeypatch `INDEX`; update with the ryuod change |
| `Makefile:145-147` | `test-frontend`; add `build-frontend`, extend `lint` and `format` |
| `README.md:262` | files table entry for `web/`; the test section |
| `docs/007-ui-redesign/GAPS.md` | known bugs in the old page; the port must not lose or hide them |

## How to work

- Worktree `/home/shared/repos/rog-ryuo-lcd-frontend-lit`, branch `frontend-lit`, based on
  `main` at eab6057.
- Web tests: `npm test` in `web/` (vitest run). A filtered run that matches nothing prints
  "No test files found" and exits 1, so a typo in a filter does fail.
- Python tests: `uv run pytest` from the repo root.
- Do not touch the main checkout at `/home/shared/repos/rog-ryuo-lcd`; another session works
  there.
- Vite dev needs a running ryuod on 8746 (`systemctl --user status ryuod`) for the proxy to answer.

## Success criteria

1. Every pre-existing web test passes against the new page, minus the 12 legacy cases, with no
   change to the assertions. A test that needed an assertion change is listed in the commit
   message with the reason.
2. `npm run typecheck` passes with `strict`.
3. `grep -c "googleapis" web/dist/index.html` is 0, and the page loads with no request outside
   127.0.0.1:8746 (check the Network panel).
4. `make test-frontend` fails when `web/dist/` is stale: edit a source file, do not rebuild, run
   it, see it fail; rebuild, see it pass.
5. Every id-based control the old tests touch still exists; the editing guard is the only
   mechanism that suppresses a poll merge.
6. The page at http://127.0.0.1:8746/ looks the same as before the port on the four tabs, at
   desktop and at 400 px width.

## Open questions

- None at design time. Anything found during the port goes here with the step it belongs to.
