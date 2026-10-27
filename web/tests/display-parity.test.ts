// @vitest-environment node
/**
 * display.ts against the old page's second-display code (web/index.html at eab6057): displayText,
 * renderDisplaySwitch, renderDisplay, renderPanelSwitch and renderHero, run over every display
 * status ryuod can report, with the panel on, in standby or unknown, and the switch either way.
 * The old functions write the DOM through $(); here $() hands out plain records, and the test
 * reads what they were given. display-status.test.ts writes the expected sentences out; this file
 * only checks that the two pages agree, so the switch commit deletes it with web/index.html.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { DisplayStatus } from "../src/api-types.ts";
import {
  backgroundText,
  displayDot,
  displayFailed,
  displayText,
  heroMirror,
  MIRROR_IN_STANDBY,
  mirrorChipText,
  mirrorHintShown,
  mirrorSwitch,
  NOT_AVAILABLE,
  pointerText,
  STANDBY_IN_MIRROR,
  standbyBlocked,
} from "../src/display.ts";

const OLD_PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");

/** The old page's top-level function `name`, as source. */
function oldFunction(name: string): string {
  const source = OLD_PAGE.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0];
  if (!source) throw new Error(`web/index.html has no function ${name}`);
  return source;
}
const OLD_CONSTANTS =
  OLD_PAGE.match(/\nconst MIRROR_IN_STANDBY = [^\n]*\nconst STANDBY_IN_MIRROR = [^\n]*\n/)?.[0] ?? "";

/** What an old render function wrote to one element. */
interface Written {
  hidden: boolean;
  disabled: boolean;
  title: string;
  textContent: string;
  className: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  classList: { toggle(name: string, on: boolean): void };
}

function written(): Written {
  const classes = new Set<string>();
  return {
    hidden: false,
    disabled: false,
    title: "",
    textContent: "",
    className: "",
    dataset: {},
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
  };
}

interface OldPage {
  displayText(status: DisplayStatus): string;
  /** One poll's renderDisplay, with the panel as `panelOn` and the switch held at `want`. */
  render(status: DisplayStatus | null, panelOn: boolean | null, want: boolean): (id: string) => Written;
}

/**
 * The old functions in one scope with the globals they read. renderHero's preview, live media
 * and upload parts get the values of a page with no preview open and the cooler unknown.
 */
function loadOldPage(): OldPage {
  const elements = new Map<string, Written>();
  const element = (id: string) => {
    let found = elements.get(id);
    if (!found) {
      found = written();
      elements.set(id, found);
    }
    return found;
  };
  const source = `
    let displaySending = false, displayWant = false, lastDisplay = null, panelOn = null, panelSending = false;
    let unreachable = false, previewName = null, device = null, config = null, applyAsking = false, newApi = true;
    const mediaLists = { preset: [], custom: [] };
    const liveName = () => null;
    const setHeroMedia = () => {};
    ${OLD_CONSTANTS}
    ${["displayText", "renderDisplaySwitch", "renderDisplay", "renderPanelSwitch", "renderHero"].map(oldFunction).join("")}
    return {
      displayText,
      render(status, panel, want) {
        clear();
        panelOn = panel;
        // A POST in flight keeps displayWant as clicked; renderDisplay leaves it alone then.
        displaySending = true;
        displayWant = want;
        renderDisplay(status);
        return $;
      },
    };`;
  const build = new Function("$", "clear", source) as (lookup: (id: string) => Written, clear: () => void) => OldPage;
  return build(element, () => elements.clear());
}

const oldPage = loadOldPage();

const STATES = ["off", "starting", "on", "stopping", "retrying", "error", "paused"] as DisplayStatus["state"][];
const POINTERS: DisplayStatus["pointer"][] = [
  null,
  { shown: true, reason: null },
  { shown: false, reason: "cancelled" },
  { shown: false, reason: null },
];
// ryuod sets fps and mbps together (ryuod.py Display: both None, or both from one log line).
const RATES: [number | null, number | null][] = [
  [null, null],
  [0, 0],
  [59.84, 9.71],
];

/** Every status in the matrix: each state with and without each optional field. */
function allStatuses(): DisplayStatus[] {
  const statuses: DisplayStatus[] = [];
  for (const state of STATES)
    for (const on of [false, true])
      for (const message of [null, "virtual monitor is up"])
        for (const retryInS of [null, 0, 9])
          for (const pointer of POINTERS)
            for (const backgroundError of [null, "adb push exited with 1"])
              for (const [fps, mbps] of RATES)
                for (const error of [null, "ryuo_display.py exited with status 1: no cooler on adb"])
                  statuses.push({
                    on,
                    state,
                    fps,
                    mbps,
                    message,
                    error,
                    pointer,
                    backgroundError,
                    retryInS,
                  });
  return statuses;
}

const STATUSES = allStatuses();
// The lock matrix needs each state once, with the switch's own value, and a ryuod without it.
const LOCK_STATUSES: (DisplayStatus | null)[] = [
  null,
  ...STATES.flatMap((state) => [false, true].map((on) => ({ ...STATUSES[0], state, on }))),
];

/** Each mismatch as "what, for which input: old → new", so a failure names the input. */
function mismatches(check: (record: (what: string, old: unknown, now: unknown) => void) => void): string[] {
  const found: string[] = [];
  check((what, old, now) => {
    if (JSON.stringify(old) !== JSON.stringify(now))
      found.push(`${what}: ${JSON.stringify(old)} → ${JSON.stringify(now)}`);
  });
  return found;
}

describe("the status line and the notes under the switch, as the old page wrote them", () => {
  it("runs the old functions for real: they write what the old page showed", () => {
    // Without this, a stub that swallowed every write would make each comparison below vacuous.
    expect(STATUSES.length).toBe(4032);
    const $ = oldPage.render({ ...STATUSES[0], on: true, state: "on", fps: 60, mbps: 9 }, false, true);
    expect($("displayDot").className).toBe("dot ok");
    expect($("displayText").textContent).toBe("On: 60.0 frames/s at 9.0 Mb/s to the panel (average over 5 s)");
    expect($("panelSwitch").attributes["aria-checked"]).toBe("false");
    expect($("hero").dataset.view).toBe("standby");
    expect(oldPage.render(STATUSES[0], false, false)("modeMirror").title).toBe(MIRROR_IN_STANDBY);
  });

  it("displayText gives the old sentence for every status", () => {
    const found = mismatches((record) => {
      for (const status of STATUSES) record(JSON.stringify(status), oldPage.displayText(status), displayText(status));
    });
    expect(found).toEqual([]);
  });

  it("the dot, the error lines, Try again now, the pointer and background notes match", () => {
    const found = mismatches((record) => {
      for (const status of [null, ...STATUSES]) {
        const $ = oldPage.render(status, true, status?.on ?? false);
        const input = JSON.stringify(status);
        const failed = displayFailed(status);
        const error = failed ? (status?.error ?? "") : "";
        record(`dot ${input}`, $("displayDot").className, displayDot(status));
        record(`text ${input}`, $("displayText").textContent, status ? displayText(status) : NOT_AVAILABLE);
        record(`error ${input}`, [$("displayErr").hidden, $("displayErr").textContent], [!error, error]);
        record(`retry ${input}`, $("displayRetry").hidden, !failed);
        record(
          `pointer ${input}`,
          [$("displayPointer").hidden, $("displayPointer").textContent],
          [!pointerText(status), pointerText(status)],
        );
        record(
          `background ${input}`,
          [$("displayBackground").hidden, $("displayBackground").textContent],
          [!backgroundText(status), backgroundText(status)],
        );
      }
    });
    expect(found).toEqual([]);
  });
});

describe("the locks between standby and the second display, as the old page set them", () => {
  it("the switch, the segments and the panel switch agree for every panel and switch state", () => {
    const found = mismatches((record) => {
      for (const status of LOCK_STATUSES)
        for (const panelOn of [null, true, false])
          for (const want of [false, true]) {
            const $ = oldPage.render(status, panelOn, want);
            const input = `${JSON.stringify(status?.state ?? null)} on=${status?.on} panel=${panelOn} want=${want}`;
            const panel = panelOn === null ? null : { on: panelOn };
            const { available, blocked } = mirrorSwitch({
              device: {},
              display: status,
              panel,
              displayWant: want,
            });
            for (const id of ["displaySwitch", "modeMirror"]) {
              record(
                `${id} ${input}`,
                [$(id).disabled, $(id).title],
                [!available || blocked, blocked ? MIRROR_IN_STANDBY : ""],
              );
            }
            record(`modeStats ${input}`, $("modeStats").disabled, !available);
            record(`statsOn ${input}`, $("statsOn").disabled, want);
            const locked = standbyBlocked({ panel, displayWant: want });
            record(
              `panelSwitch ${input}`,
              [$("panelSwitch").hidden, $("panelSwitch").disabled, $("panelSwitch").title],
              [panel === null, panel === null ? false : locked, panel === null ? "" : locked ? STANDBY_IN_MIRROR : ""],
            );
          }
    });
    expect(found).toEqual([]);
  });
});

describe("the hero's mirror view, as the old renderHero drew it", () => {
  it("shows for the same panel, switch and status, with the same chip and caption", () => {
    const found = mismatches((record) => {
      for (const status of LOCK_STATUSES)
        for (const panelOn of [null, true, false])
          for (const want of [false, true]) {
            const $ = oldPage.render(status, panelOn, want);
            const input = `${JSON.stringify(status?.state ?? null)} panel=${panelOn} want=${want}`;
            // ui/ryuo-mirror-view.ts: standby outranks the mirror; ryuod answers in this matrix.
            record(`mirrorView ${input}`, $("mirrorView").hidden, !(panelOn !== false && heroMirror(want, status)));
            record(`chip ${input}`, $("mirrorChip").textContent, mirrorChipText(status));
            record(`caption ${input}`, $("mirrorHint").hidden, !mirrorHintShown(status));
          }
    });
    expect(found).toEqual([]);
  });
});
