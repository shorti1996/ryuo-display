/**
 * The Desktop mirror tab and the controls bound to the second-display switch on the Lit page:
 * what step 3 changed (the header's panel switch and the strip's overlay box follow the mirror
 * switch's click, not ryuod's display.on), and the refusal paths no old test checks. The old
 * tests of the tab (display and features.test.js) run against this page as they are.
 */
import { describe, expect, it } from "vitest";

import { $, makeDaemon, openPage, tick } from "./harness.js";

const STANDBY_IN_MIRROR = "the panel shows the second display; turn that off before standby";

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

/**
 * Hold each POST to `path` until the returned function is called, one POST per call, oldest
 * first. A held request reaches the fake daemon only when released, so ryuod's state changes then.
 */
function holdEach(daemon, path) {
  const serve = daemon.fetch.getMockImplementation();
  const gates = [];
  daemon.fetch.mockImplementation(async (url, options) => {
    if (url === path) await new Promise((resolve) => gates.push(resolve));
    return serve(url, options);
  });
  return () => gates.shift()();
}

const switchOn = () => $("displaySwitch").getAttribute("aria-checked") === "true";

describe("the mirror switch's POSTs, compared with the old page", () => {
  // The old page kept one displaySending flag, which the first POST to finish cleared; a poll
  // then put ryuod's value on the switch while the second POST still ran. The Lit page counts
  // the holds, so the switch shows the last click until every POST has answered.
  it("a second click while the first POST runs keeps the switch at the second click until both answer", async () => {
    const daemon = await openPage();
    const answerNext = holdEach(daemon, "/api/display");
    $("displaySwitch").click();
    $("displaySwitch").click();
    expect(switchOn()).toBe(false);
    answerNext(); // the start reaches ryuod, which now reports display.on true
    await tick(0);
    expect($("displayText").textContent).toBe("Starting…");
    await tick(1000);
    expect(switchOn()).toBe(false);
    expect($("panelSwitch").disabled).toBe(false);
    expect($("statsOn").disabled).toBe(false);
    answerNext();
    await tick(1000);
    expect(daemon.posts("/api/display")).toEqual([{ on: true }, { on: false }]);
    expect(switchOn()).toBe(false);
    expect($("displayText").textContent).toBe("Stopping: removing the virtual monitor, up to about 10 s…");
  });

  it("a start that cannot reach ryuod puts the switch back off, and it stays off once ryuod is back", async () => {
    const daemon = await openPage();
    daemon.down = true;
    $("modeMirror").click();
    expect(switchOn()).toBe(true);
    await tick(0);
    expect(switchOn()).toBe(false);
    expect($("panelSwitch").disabled).toBe(false);
    expect($("mirrorView").hidden).toBe(true);
    expect($("result").textContent).toBe("Second display not started: Failed to fetch");
    daemon.down = false;
    await tick(1000);
    expect(switchOn()).toBe(false);
  });

  it("a start ryuod answers with 400 puts the switch back off", async () => {
    const daemon = await openPage();
    daemon.replyOnce("POST /api/display", { status: 400, body: { ok: false, error: "on must be true or false" } });
    $("modeMirror").click();
    await tick(0);
    expect(switchOn()).toBe(false);
    expect($("modeStats").getAttribute("aria-pressed")).toBe("true");
    expect($("result").textContent).toBe("Second display not started: on must be true or false");
    await tick(1000);
    expect(switchOn()).toBe(false);
  });

  it("a 504 after the display did start puts the switch back off, and the next poll turns it on", async () => {
    const daemon = await openPage();
    const serve = daemon.fetch.getMockImplementation();
    daemon.fetch.mockImplementation(async (url, options) => {
      if (url !== "/api/display") return serve(url, options);
      await serve(url, options); // ryuod switched it on; a proxy in between gave up waiting
      return { ok: false, status: 504, json: async () => ({ ok: false, error: "gateway timeout" }) };
    });
    $("modeMirror").click();
    await tick(0);
    expect(switchOn()).toBe(false);
    expect($("displayText").textContent).toBe("Off");
    expect($("result").textContent).toBe("Second display not started: gateway timeout");
    await tick(1000);
    expect(switchOn()).toBe(true);
    expect($("displayText").textContent).toBe("Starting…");
    expect($("panelSwitch").disabled).toBe(true);
    expect($("mirrorView").hidden).toBe(false);
  });

  it("a refused stop puts the switch back on, with standby still locked", async () => {
    const daemon = await openPage(makeDaemon({ display: { on: true, state: "on", fps: 60, mbps: 9 } }));
    daemon.replyOnce("POST /api/display", { status: 400, body: { ok: false, error: "on must be true or false" } });
    $("modeStats").click();
    expect($("panelSwitch").disabled).toBe(false);
    await tick(0);
    expect(switchOn()).toBe(true);
    expect($("panelSwitch").disabled).toBe(true);
    expect($("panelSwitch").title).toBe(STANDBY_IN_MIRROR);
    expect($("result").textContent).toBe("Second display not stopped: on must be true or false");
  });

  it("leaves the mirror controls enabled when the first poll finds ryuod down", async () => {
    const daemon = makeDaemon();
    daemon.down = true;
    await openPage(daemon);
    expect($("displaySwitch").disabled).toBe(false);
    expect($("modeMirror").disabled).toBe(false);
    expect($("modeStats").disabled).toBe(false);
    expect($("displayText").textContent).toBe("…");
  });

  it("locks the mirror at the standby click, before ryuod answers", async () => {
    const daemon = await openPage();
    const answerNext = holdEach(daemon, "/api/panel");
    $("panelSwitch").click();
    expect($("modeMirror").disabled).toBe(true);
    expect($("displaySwitch").title).toBe("the panel is in standby; turn it on before the second display");
    expect($("modeStats").disabled).toBe(false);
    answerNext();
    await tick(0);
    expect(daemon.posts("/api/panel")).toEqual([{ on: false }]);
    expect($("modeMirror").disabled).toBe(true);
  });
});

describe("Ask again while its POST runs", () => {
  // As on the old page, a poll during the POST shows ryuod's choice: Ask again changes nothing
  // before its reply, so it holds no key, and only its button is disabled meanwhile.
  it("a refused Ask again shows the choice a poll reported during its POST", async () => {
    const daemon = await openPage(); const serve = daemon.fetch.getMockImplementation();
    let release; const held = new Promise((resolve) => { release = resolve; });
    daemon.fetch.mockImplementation(async (url, options) => {
      if (url !== "/api/display/reset-choice") return serve(url, options);
      await held; return { ok: false, status: 409, json: async () => ({ ok: false, error: "the second display is starting" }) };
    });
    $("askAgain").click(); daemon.desktop.portalTokenSaved = false; await tick(1000); release(); await tick(0);
    expect($("choiceText").textContent).toBe("No screen-share choice is saved; the next start asks which screen to share.");
    expect($("askAgain").disabled).toBe(true);
  });

  it("keeps the button disabled until the POST answers, and enabled again after a refusal", async () => {
    const daemon = await openPage();
    daemon.replyOnce("POST /api/display/reset-choice", { status: 500, body: { ok: false, error: "disk full" } });
    const answerNext = holdEach(daemon, "/api/display/reset-choice");
    $("askAgain").click();
    expect($("askAgain").disabled).toBe(true);
    await tick(1000);
    expect($("askAgain").disabled).toBe(true);
    answerNext();
    await tick(0);
    expect($("askAgain").disabled).toBe(false);
  });

  it("after a refusal, the next poll shows ryuod's choice", async () => {
    const daemon = await openPage();
    daemon.replyOnce("POST /api/display/reset-choice", { status: 500, body: { ok: false, error: "disk full" } });
    $("askAgain").click();
    await tick(0);
    expect($("result").textContent).toBe("Screen-share choice not deleted: disk full");
    expect($("askAgain").disabled).toBe(false);
    daemon.desktop.portalTokenSaved = false;
    await tick(1000);
    expect($("choiceText").textContent).toBe("No screen-share choice is saved; the next start asks which screen to share.");
    expect($("askAgain").disabled).toBe(true);
  });
});
