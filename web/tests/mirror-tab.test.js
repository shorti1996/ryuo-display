/**
 * The Desktop mirror tab and the controls bound to the second-display switch on the Lit page
 * (tests/harness-lit.js). The first three describe blocks are cases copied unchanged from
 * features.test.js, which stays on the old harness until the Background tab and the hero are
 * ported; the copies go when it moves. The last block covers what step 3 changed: the header's
 * panel switch and the strip's overlay box follow the mirror switch's click, not ryuod's
 * display.on.
 */
import { describe, expect, it } from "vitest";

import { $, makeDaemon, openPage, tick } from "./harness-lit.js";

const STANDBY_IN_MIRROR = "the panel shows the second display; turn that off before standby";

describe("panel switch", () => {
  it("is disabled while the panel shows the second display, with ryuod's reason", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 60, mbps: 9 } }));
    expect($("panelSwitch").disabled).toBe(true);
    expect($("panelSwitch").title).toBe(STANDBY_IN_MIRROR);
  });
});

describe("screen-share choice", () => {
  it("Ask again deletes the saved choice", async () => {
    const d = await openPage();
    expect($("askAgain").hidden).toBe(false);
    expect($("askAgain").disabled).toBe(false);
    expect($("choiceText").textContent).toBe("A screen-share choice is saved, so starts skip the question. Ask again deletes it.");
    $("askAgain").click();
    await tick(0);
    expect(d.posts("/api/display/reset-choice")).toEqual([{}]);
    expect($("result").textContent).toBe("Screen-share choice deleted; the next start of the second display asks again");
    expect($("askAgain").disabled).toBe(true);
    expect($("choiceText").textContent).toBe("No screen-share choice is saved; the next start asks which screen to share.");
  });

  it("is disabled with nothing saved", async () => {
    await openPage(makeDaemon({ desktop: { portalTokenSaved: false } }));
    expect($("askAgain").disabled).toBe(true);
  });

  it("is disabled while the second display starts, with ryuod's reason", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "starting" } }));
    expect($("askAgain").disabled).toBe(true);
    expect($("askAgain").title).toBe("the second display is starting; try again once it is on or off");
  });
});

describe("Open Display Configuration", () => {
  it("opens from the Desktop mirror tab and from the hero caption", async () => {
    const d = await openPage(makeDaemon({ display: { on: true, state: "on", fps: 60, mbps: 9 } }));
    expect($("displaySettingsRow").hidden).toBe(false);
    expect($("mirrorSettings").hidden).toBe(false);
    expect($("mirrorSettings").getAttribute("aria-label")).toBe("Open Display Configuration");
    $("displaySettingsOpen").click();
    await tick(0);
    $("mirrorSettings").click();
    await tick(0);
    expect(d.posts("/api/display/open-settings")).toEqual([{}, {}]);
    expect($("result").textContent).toBe("Display Configuration opened; Virtual-RYUO is in the monitor list");
  });

  it("shows ryuod's reason when it cannot", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/display/open-settings", { status: 503, body: { ok: false, error: "no Wayland session yet" } });
    $("displaySettingsOpen").click();
    await tick(0);
    expect($("result").textContent).toBe("Display Configuration not opened: no Wayland session yet");
  });

  it("is hidden when neither kcmshell6 nor systemsettings is installed", async () => {
    await openPage(makeDaemon({ desktop: { displaySettings: null } }));
    expect($("displaySettingsRow").hidden).toBe(true);
    expect($("mirrorSettings").hidden).toBe(true);
  });
});

/**
 * Hold every POST /api/display until the returned `answer()` is called, so a test can look at
 * the page while the POST is pending. The request reaches the fake daemon only on answer().
 */
function holdDisplayPosts(daemon) {
  const serve = daemon.fetch.getMockImplementation();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  daemon.fetch.mockImplementation(async (url, options) => {
    if (url === "/api/display") await held;
    return serve(url, options);
  });
  return () => release();
}

describe("the mirror switch's click, before ryuod answers", () => {
  it("locks the panel switch and the overlay box at once, and a poll meanwhile does not undo it", async () => {
    const daemon = await openPage();
    const answer = holdDisplayPosts(daemon);
    $("modeMirror").click();
    expect($("panelSwitch").disabled).toBe(true);
    expect($("panelSwitch").title).toBe(STANDBY_IN_MIRROR);
    expect($("statsOn").disabled).toBe(true);
    expect($("mirrorView").hidden).toBe(false);
    await tick(1000); // a poll still reports display.on false
    expect($("panelSwitch").disabled).toBe(true);
    expect($("statsOn").disabled).toBe(true);
    answer();
    await tick(0);
    expect(daemon.posts("/api/display")).toEqual([{ on: true }]);
    expect($("panelSwitch").disabled).toBe(true);
  });

  it("unlocks them again when ryuod refuses, with the overlay box as it was", async () => {
    const daemon = await openPage();
    daemon.replyOnce("POST /api/display", { status: 409, body: { ok: false, error: "the panel is in standby" } });
    $("displaySwitch").click();
    await tick(0);
    expect($("panelSwitch").disabled).toBe(false);
    expect($("panelSwitch").title).toBe("");
    expect($("statsOn").disabled).toBe(false);
    expect($("statsOn").checked).toBe(true);
    expect($("mirrorView").hidden).toBe(true);
    expect($("result").textContent).toBe("Second display not started: the panel is in standby");
  });

  it("stopping unlocks standby at the click, while the hero still shows the virtual monitor going", async () => {
    const daemon = await openPage(makeDaemon({ display: { on: true, state: "on", fps: 60, mbps: 9 } }));
    $("modeStats").click();
    expect($("panelSwitch").disabled).toBe(false);
    expect($("statsOn").disabled).toBe(false);
    await tick(0);
    expect(daemon.posts("/api/display")).toEqual([{ on: false }]);
    expect($("mirrorView").hidden).toBe(false);
    expect($("mirrorChip").textContent).toBe("Desktop mirror · stopping…");
    daemon.display = { ...daemon.display, state: "off" };
    await tick(1000);
    expect($("mirrorView").hidden).toBe(true);
  });

  it("is refused for standby: the mirror controls are locked while the panel is off", async () => {
    await openPage(makeDaemon({ panel: { on: false } }));
    expect($("modeMirror").disabled).toBe(true);
    expect($("displaySwitch").disabled).toBe(true);
    expect($("displaySwitch").title).toBe("the panel is in standby; turn it on before the second display");
    expect($("modeStats").disabled).toBe(false);
    expect($("mirrorView").hidden).toBe(true);
  });
});
