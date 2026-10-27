/**
 * The shell and the App tab of the Lit page: what the new page does differently from the old
 * one, or what no old test checks. The old tests of the tabs, the tray settings and the header
 * (features, layout, load and errors.test.js) run against this page as they are.
 */
import { describe, expect, it } from "vitest";

import { $, choose, makeDaemon, openPage, tick } from "./harness-lit.js";

const checkedAttr = (id) => $(id).getAttribute("aria-checked");
const chips = () => [...$("traySteps").querySelectorAll(".step")].map((c) => c.textContent);

/**
 * Hold every POST /api/tray until the returned `answer()` is called, so a test can look at the
 * page while the POST is pending. The request reaches the fake daemon only on answer().
 */
function holdTrayPosts() {
  const serve = window.fetch;
  const waiting = [];
  globalThis.fetch = window.fetch = (url, options = {}) => {
    if (options.method !== "POST" || String(url) !== "/api/tray") return serve(url, options);
    return new Promise((resolve) => waiting.push(() => resolve(serve(url, options))));
  };
  return async () => {
    for (const release of waiting.splice(0)) release();
    await tick(0);
  };
}

// The old page drew a tray change only from POST /api/tray's reply; the new one draws it at the
// click and puts back ryuod's value when the POST fails (actions.sendTray).
describe("a tray change", () => {
  it("shows at the click, before ryuod answers, and a poll meanwhile does not undo it", async () => {
    const daemon = await openPage();
    const answer = holdTrayPosts();
    $("trayAutostart").click();
    expect(checkedAttr("trayAutostart")).toBe("false");
    // ryuod still says true: the poll leaves the key while its POST is pending.
    await tick(1000);
    expect(daemon.tray.autostart).toBe(true);
    expect(checkedAttr("trayAutostart")).toBe("false");
    await answer();
    expect(daemon.posts("/api/tray")).toEqual([{ autostart: false }]);
    expect(checkedAttr("trayAutostart")).toBe("false");
    await tick(1000);
    expect(checkedAttr("trayAutostart")).toBe("false");
  });

  it("removes a step's chip at the click, and puts it back when the POST fails", async () => {
    const daemon = await openPage();
    const answer = holdTrayPosts();
    $("traySteps").querySelectorAll(".step button")[1].click();
    expect(chips()).toEqual(["25 %", "75 %", "100 %"]);
    daemon.replyOnce("POST /api/tray", { status: 500, body: { ok: false, error: "state.json: No space left on device" } });
    await answer();
    expect(chips()).toEqual(["25 %", "50 %", "75 %", "100 %"]);
    expect($("result").textContent).toBe("Tray brightness steps not changed: state.json: No space left on device");
  });

  it("puts back the left-click choice when ryuod refuses it", async () => {
    const daemon = await openPage();
    const answer = holdTrayPosts();
    choose($("trayClick"), "stats");
    expect($("trayClick").value).toBe("stats");
    daemon.replyOnce("POST /api/tray", { status: 400, body: { ok: false, error: "leftClick must be one of page, menu" } });
    await answer();
    expect($("trayClick").value).toBe("page");
    // The poll after the failure agrees with what the page shows.
    await tick(1000);
    expect($("trayClick").value).toBe("page");
  });

  it("that failed does not hide a change another client made while it was pending", async () => {
    const daemon = await openPage();
    const answer = holdTrayPosts();
    $("trayAutostart").click();
    daemon.tray.leftClick = "menu"; // the tray's own settings window, say
    daemon.tray.autostart = false;
    await tick(1000);
    daemon.replyOnce("POST /api/tray", { status: 500, body: { ok: false, error: "Permission denied" } });
    await answer();
    // The failure put back the value from before the click; ryuod has false from the other
    // client, which differs from what the page last saw, so the next poll brings it.
    expect(checkedAttr("trayAutostart")).toBe("true");
    expect($("trayClick").value).toBe("menu");
    await tick(1000);
    expect(checkedAttr("trayAutostart")).toBe("false");
  });
});

// The old page's three tray checks (traySending, stepAdding, the focused select) are now keys
// held in the store's editing set. No old test covers the last two.
describe("the poll and the tray controls the user is on", () => {
  it("leaves the steps while + Add step is open, and brings another client's steps once it closes", async () => {
    const daemon = await openPage();
    $("trayStepPlus").click();
    daemon.tray.brightnessSteps = [30, 60];
    await tick(1000);
    expect(chips()).toEqual(["25 %", "50 %", "75 %", "100 %"]);
    expect($("trayStepNew")).not.toBeNull();
    $("trayStepNew").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($("trayStepNew")).toBeNull();
    await tick(1000);
    expect(chips()).toEqual(["30 %", "60 %"]);
  });

  it("leaves a focused left-click select until it loses focus", async () => {
    const daemon = await openPage();
    $("trayClick").focus();
    daemon.tray.leftClick = "stats";
    await tick(1000);
    expect($("trayClick").value).toBe("page");
    $("trayClick").blur();
    await tick(1000);
    expect($("trayClick").value).toBe("stats");
  });
});

// The old page left the pill's tooltip at the last good poll's value while ryuod was down.
describe("the connection pill's tooltip", () => {
  it("shows why ryuod does not answer, and clears when it is back", async () => {
    const daemon = await openPage();
    expect($("connPill").title).toBe("");
    daemon.down = true;
    await tick(1000);
    expect($("connPill").title).toBe("Failed to fetch");
    daemon.down = false;
    await tick(1000);
    expect($("connPill").title).toBe("");
  });

  it("shows ryuod's own error for a state reply it refused", async () => {
    const daemon = await openPage(makeDaemon({ device: { connected: false, lastError: "no RYUO IV hidraw found" } }));
    daemon.replyOnce("GET /api/state", { status: 200, body: { ok: false, error: "state unreadable" } });
    await tick(1000);
    expect($("connPill").title).toBe("state unreadable");
    expect($("err").textContent).toBe("state unreadable");
    // Back to the cooler's last error while it is not connected.
    await tick(1000);
    expect($("connPill").title).toBe("no RYUO IV hidraw found");
  });
});
