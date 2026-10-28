// @vitest-environment node
/**
 * The second display's pure parts (display.ts): the status line and dot, the notes under the
 * switch, the hero's mirror chip, and which controls standby and the mirror lock out.
 */
import { describe, expect, it } from "vitest";

import type { DisplayStatus } from "../src/api-types.ts";
import {
  backgroundText,
  choiceText,
  displayDot,
  displayFailed,
  displayText,
  heroMirror,
  mirrorChipText,
  mirrorHintShown,
  mirrorLeaving,
  mirrorSwitch,
  pointerText,
  standbyBlocked,
} from "../src/display.ts";

/** ryuod.Display.status() with the switch off, changed by `change`. */
function status(change: Partial<DisplayStatus> = {}): DisplayStatus {
  return {
    on: false,
    state: "off",
    fps: null,
    mbps: null,
    message: null,
    error: null,
    pointer: null,
    backgroundError: null,
    retryInS: null,
    ...change,
  };
}

describe("displayText", () => {
  it("names each state in the user's words", () => {
    expect(displayText(status())).toBe("Off");
    expect(displayText(status({ state: "starting" }))).toBe("Starting…");
    expect(displayText(status({ state: "starting", message: "virtual monitor is up" }))).toBe(
      "Starting: virtual monitor is up",
    );
    expect(displayText(status({ state: "stopping" }))).toBe(
      "Stopping: removing the virtual monitor, up to about 10 s…",
    );
    expect(displayText(status({ state: "retrying", retryInS: 9 }))).toBe("Not running. Next try in 9 s.");
    expect(displayText(status({ state: "retrying" }))).toBe("Not running. Next try in 0 s.");
    expect(displayText(status({ state: "error" }))).toContain("Fix the cause, then press Try again now.");
  });

  it("gives the frame rate and bitrate with units once ryuod has measured them", () => {
    expect(displayText(status({ on: true, state: "on" }))).toBe("On. The frame rate shows after the first 5 s.");
    expect(displayText(status({ on: true, state: "on", fps: 0, mbps: 0 }))).toBe(
      "On. No frames sent in the last 5 s: nothing on the virtual monitor changed.",
    );
    expect(displayText(status({ on: true, state: "on", fps: 59.84, mbps: 9.71 }))).toBe(
      "On: 59.8 frames/s at 9.7 Mb/s to the panel (average over 5 s)",
    );
  });

  it("shows a state it does not know as ryuod's own word", () => {
    expect(displayText(status({ state: "paused" as DisplayStatus["state"] }))).toBe("paused");
  });
});

describe("the dot and the failure lines", () => {
  it("is red for a failed start, green while on, grey otherwise", () => {
    expect(displayDot(null)).toBe("dot");
    expect(displayDot(status())).toBe("dot");
    expect(displayDot(status({ state: "starting" }))).toBe("dot");
    expect(displayDot(status({ state: "on" }))).toBe("dot ok");
    expect(displayDot(status({ state: "retrying" }))).toBe("dot bad");
    expect(displayDot(status({ state: "error" }))).toBe("dot bad");
  });

  it("counts only retrying and error as failed", () => {
    expect(displayFailed(null)).toBe(false);
    expect(displayFailed(status({ state: "stopping" }))).toBe(false);
    expect(displayFailed(status({ state: "retrying" }))).toBe(true);
    expect(displayFailed(status({ state: "error" }))).toBe(true);
  });
});

describe("the notes under the switch", () => {
  it("say whether the pointer is shown, only while starting or on", () => {
    const shown = { shown: true, reason: null };
    expect(pointerText(status({ state: "on", pointer: shown }))).toBe("Mouse pointer: shown on the panel.");
    expect(pointerText(status({ state: "starting", pointer: shown }))).toBe("Mouse pointer: shown on the panel.");
    expect(pointerText(status({ state: "off", pointer: shown }))).toBe("");
    expect(pointerText(status({ state: "on" }))).toBe("");
    expect(pointerText(null)).toBe("");
  });

  it("say why there is no pointer, or that the reason is unknown", () => {
    expect(pointerText(status({ state: "on", pointer: { shown: false, reason: "cancelled" } }))).toBe(
      "No mouse pointer on the panel: cancelled. Turn the switch off and on to choose the screen again.",
    );
    expect(pointerText(status({ state: "on", pointer: { shown: false, reason: null } }))).toContain("unknown reason");
  });

  it("warn about the black background only when ryuod reports an error", () => {
    expect(backgroundText(status())).toBe("");
    expect(backgroundText(null)).toBe("");
    expect(backgroundText(status({ backgroundError: "adb push exited with 1" }))).toMatch(
      /^Couldn't put the black background on the cooler: adb push exited with 1\. /,
    );
  });

  it("say whether a screen-share choice is saved", () => {
    expect(choiceText({ portalTokenSaved: true, displaySettings: null })).toContain("Ask again deletes it.");
    expect(choiceText({ portalTokenSaved: false, displaySettings: null })).toBe(
      "No screen-share choice is saved; the next start asks which screen to share.",
    );
  });
});

describe("the hero's mirror view", () => {
  it("names the display's state in its chip", () => {
    expect(mirrorChipText(null)).toBe("Desktop mirror · Virtual-RYUO 2240×1080");
    expect(mirrorChipText(status({ state: "on" }))).toBe("Desktop mirror · Virtual-RYUO 2240×1080");
    expect(mirrorChipText(status({ state: "starting" }))).toBe("Desktop mirror · starting…");
    expect(mirrorChipText(status({ state: "error" }))).toBe(
      "Desktop mirror · stopped by an error, see the Desktop mirror tab",
    );
  });

  it("shows the settings caption only while the virtual monitor exists", () => {
    expect(mirrorHintShown(status({ state: "on" }))).toBe(true);
    expect(mirrorHintShown(status({ state: "starting" }))).toBe(false);
    expect(mirrorHintShown(null)).toBe(true);
  });

  it("shows for the switch as clicked, and while the virtual monitor is removed", () => {
    expect(heroMirror(true, status())).toBe(true);
    expect(heroMirror(false, status({ on: true, state: "on" }))).toBe(true);
    expect(heroMirror(false, status({ state: "stopping" }))).toBe(true);
    expect(heroMirror(false, status({ state: "off" }))).toBe(false);
    expect(heroMirror(false, null)).toBe(false);
  });

  it("notes the switch back from the click until the virtual monitor is gone", () => {
    expect(mirrorLeaving(false, status({ on: true, state: "on" }))).toBe(true);
    expect(mirrorLeaving(false, status({ state: "stopping" }))).toBe(true);
    expect(mirrorLeaving(true, status({ on: true, state: "on" }))).toBe(false);
    expect(mirrorLeaving(true, status({ state: "starting" }))).toBe(false);
    expect(mirrorLeaving(false, status({ state: "off" }))).toBe(false);
    expect(mirrorLeaving(false, null)).toBe(false);
  });
});

describe("the locks between standby and the second display", () => {
  const polled = { device: {}, display: status(), panel: { on: true }, displayWant: false };

  it("leaves the mirror controls enabled before the first poll", () => {
    expect(mirrorSwitch(undefined)).toEqual({ available: true, blocked: false });
    expect(mirrorSwitch({ ...polled, device: null, display: null })).toEqual({ available: true, blocked: false });
  });

  it("disables them for a ryuod without the second display", () => {
    expect(mirrorSwitch({ ...polled, display: null }).available).toBe(false);
  });

  it("refuses a start in standby, but not a stop", () => {
    expect(mirrorSwitch({ ...polled, panel: { on: false } }).blocked).toBe(true);
    expect(mirrorSwitch({ ...polled, panel: { on: false }, displayWant: true }).blocked).toBe(false);
    expect(mirrorSwitch({ ...polled, panel: null }).blocked).toBe(false);
  });

  it("refuses standby while the switch is on", () => {
    expect(standbyBlocked({ panel: { on: true }, displayWant: true })).toBe(true);
    expect(standbyBlocked({ panel: { on: true }, displayWant: false })).toBe(false);
    expect(standbyBlocked({ panel: { on: false }, displayWant: true })).toBe(false);
    expect(standbyBlocked(undefined)).toBe(false);
  });
});
