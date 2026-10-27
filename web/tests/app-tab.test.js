/**
 * The shell and the App tab of the Lit page (tests/harness-lit.js): the header pill, the tabs,
 * the tray settings and the device details. The first five describe blocks are cases copied
 * unchanged from features, layout, load and errors.test.js, which stay on the old harness until
 * their other tabs are ported; the copies run the same assertions against the new page now.
 * The last two cover what the new page does differently or what no old test checks.
 */
import { describe, expect, it } from "vitest";

import { $, choose, makeDaemon, openPage, tick } from "./harness-lit.js";

const checkedAttr = (id) => $(id).getAttribute("aria-checked");
const chips = () => [...$("traySteps").querySelectorAll(".step")].map((c) => c.textContent);
const TABS = ["overlay", "background", "mirror", "app"];
const selectedTab = () => TABS.filter((t) => $("tab-" + t).getAttribute("aria-selected") === "true");
const shownPanels = () => TABS.filter((t) => !$("tp-" + t).hidden);
const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

// From features.test.js. Its legacy case ("is hidden for an older ryuod") is not copied: the
// new page drops legacy-ryuod mode (design Q3).
describe("tray settings", () => {
  it("show the saved settings in the App tab", async () => {
    await openPage();
    expect($("trayCard").hidden).toBe(false);
    expect(checkedAttr("trayAutostart")).toBe("true");
    expect([...$("trayClick").options].map((o) => [o.value, o.textContent])).toEqual([
      ["page", "Open control page"], ["menu", "Show menu"], ["panel", "Toggle panel on/standby"], ["stats", "Toggle stats overlay"],
    ]);
    expect($("trayClick").value).toBe("page");
    expect(chips()).toEqual(["25 %", "50 %", "75 %", "100 %"]);
    expect($("traySteps").querySelector(".step button").getAttribute("aria-label")).toBe("Remove 25 %");
  });

  it("Start with the desktop session posts the opposite of its state", async () => {
    const d = await openPage();
    $("trayAutostart").click();
    await tick(0);
    expect(d.posts("/api/tray")).toEqual([{ autostart: false }]);
    expect(checkedAttr("trayAutostart")).toBe("false");
    expect($("result").textContent).toBe("The tray no longer starts with the desktop session, from the next login");
  });

  it("posts the left-click action", async () => {
    const d = await openPage();
    choose($("trayClick"), "panel");
    await tick(0);
    expect(d.posts("/api/tray")).toEqual([{ leftClick: "panel" }]);
    expect(d.tray.leftClick).toBe("panel");
  });

  it("removes a step with its ×", async () => {
    const d = await openPage();
    $("traySteps").querySelectorAll(".step button")[1].click();
    await tick(0);
    expect(d.posts("/api/tray")).toEqual([{ brightnessSteps: [25, 75, 100] }]);
    expect(chips()).toEqual(["25 %", "75 %", "100 %"]);
  });

  it("keeps the last step: its × is disabled", async () => {
    await openPage(makeDaemon({ tray: { brightnessSteps: [40] } }));
    const x = $("traySteps").querySelector(".step button");
    expect(x.disabled).toBe(true);
    expect(x.title).toBe("The tray menu needs at least one step");
  });

  it("adds a step, sorted, from the field + Add step opens", async () => {
    const d = await openPage();
    $("trayStepPlus").click();
    const n = $("trayStepNew");
    n.value = "60";
    n.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick(0);
    expect(d.posts("/api/tray")).toEqual([{ brightnessSteps: [25, 50, 60, 75, 100] }]);
    expect(chips()).toEqual(["25 %", "50 %", "60 %", "75 %", "100 %"]);
    expect($("trayStepNew")).toBeNull();
  });

  it.each([
    ["50", "Step not added: 50 % is already a step"],
    ["0", "Step not added: a step must be a whole number from 1 to 100"],
    ["101", "Step not added: a step must be a whole number from 1 to 100"],
    ["12.5", "Step not added: a step must be a whole number from 1 to 100"],
    ["", "Step not added: a step must be a whole number from 1 to 100"],
  ])("refuses %j before sending, as ryuod would", async (value, message) => {
    const d = await openPage();
    $("trayStepPlus").click();
    $("trayStepNew").value = value;
    $("trayStepAdd").click();
    await tick(0);
    expect(d.posts("/api/tray")).toEqual([]);
    expect($("result").textContent).toBe(message);
    expect($("trayStepNew")).not.toBeNull();
  });

  it("disables + Add step at 8 steps", async () => {
    await openPage(makeDaemon({ tray: { brightnessSteps: [10, 20, 30, 40, 50, 60, 70, 80] } }));
    expect($("trayStepPlus").disabled).toBe(true);
    expect($("trayStepPlus").title).toBe("The tray menu takes at most 8 steps");
  });

  it("goes back to ryuod's settings when a POST fails", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/tray", { status: 500, body: { ok: false, error: "cannot remove /home/u/.config/autostart/ryuo-tray.desktop: Permission denied" } });
    $("trayAutostart").click();
    await tick(0);
    expect(checkedAttr("trayAutostart")).toBe("true");
    expect($("result").textContent).toBe("Start with the desktop session not changed: cannot remove /home/u/.config/autostart/ryuo-tray.desktop: Permission denied");
  });

  it("follows a change made elsewhere", async () => {
    const d = await openPage();
    d.tray.leftClick = "stats";
    d.tray.brightnessSteps = [30, 60];
    await tick(1000);
    expect($("trayClick").value).toBe("stats");
    expect(chips()).toEqual(["30 %", "60 %"]);
  });
});

// From features.test.js, "messages".
describe("messages", () => {
  it("name the tray change and when the tray follows", async () => {
    await openPage();
    choose($("trayClick"), "menu");
    await tick(0);
    expect($("result").textContent).toBe("Tray left-click set to Show menu; the tray follows within 3 s");
    $("traySteps").querySelector(".step button").click();
    await tick(0);
    expect($("result").textContent).toBe("Tray brightness steps set to 50, 75, 100 %; the tray menu follows within 3 s");
  });
});

// From layout.test.js.
describe("tabs", () => {
  it("open on Overlay, with one panel shown and one tab in the tab order", async () => {
    await openPage();
    expect(selectedTab()).toEqual(["overlay"]);
    expect(shownPanels()).toEqual(["overlay"]);
    expect(TABS.map((t) => $("tab-" + t).tabIndex)).toEqual([0, -1, -1, -1]);
    expect(TABS.map((t) => $("tab-" + t).getAttribute("aria-controls"))).toEqual(TABS.map((t) => "tp-" + t));
  });

  it("switch panels on click", async () => {
    await openPage();
    $("tab-background").click();
    expect(selectedTab()).toEqual(["background"]);
    expect(shownPanels()).toEqual(["background"]);
    expect($("tab-background").tabIndex).toBe(0);
    expect($("tab-overlay").tabIndex).toBe(-1);
  });

  it("move with the arrow keys, Home and End, wrapping at the ends", async () => {
    await openPage();
    $("tab-overlay").focus();
    key("ArrowRight");
    expect(selectedTab()).toEqual(["background"]);
    expect(document.activeElement.id).toBe("tab-background");
    key("End");
    expect(selectedTab()).toEqual(["app"]);
    key("ArrowRight");
    expect(selectedTab()).toEqual(["overlay"]);
    key("ArrowLeft");
    expect(selectedTab()).toEqual(["app"]);
    key("Home");
    expect(shownPanels()).toEqual(["overlay"]);
  });

  it("the connection pill opens the App tab", async () => {
    await openPage();
    $("connPill").click();
    expect(selectedTab()).toEqual(["app"]);
    expect(document.activeElement.id).toBe("tab-app");
  });
});

// From load.test.js: the requests at startup, the header pill and the device details.
describe("initial load", () => {
  it("asks for catalog, state, media and stats, in that order", async () => {
    const d = await openPage();
    expect(d.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/catalog", "GET /api/state", "GET /api/media", "GET /api/stats",
    ]);
  });

  it("then polls state and stats every second and the catalog every 15 s", async () => {
    const d = await openPage();
    await tick(1000);
    expect(d.gets("/api/state")).toHaveLength(2);
    expect(d.gets("/api/stats")).toHaveLength(2);
    await tick(2000);
    expect(d.gets("/api/state")).toHaveLength(4);
    expect(d.gets("/api/catalog")).toHaveLength(1);
    await tick(12000);
    expect(d.gets("/api/catalog")).toHaveLength(2);
    expect(d.gets("/api/media")).toHaveLength(1);
  });

  it("shows the connection in the header pill and the details in the App tab", async () => {
    await openPage();
    expect($("connPill").className).toBe("pill ok");
    expect($("dot").className).toBe("dot ok");
    expect($("conn").textContent).toBe("Connected");
    expect($("connFw").textContent).toBe(" · V1.0.10");
    expect($("model").textContent).toBe("Ryuo IV Standard");
    expect($("fw").textContent).toBe("V1.0.10");
    expect($("hidraw").textContent).toBe("/dev/hidraw4");
    expect($("hb").textContent).toBe("0.4 s ago");
    expect($("ack").textContent).toBe("0.4 s ago");
    expect($("rec").textContent).toBe("0");
    expect($("err").textContent).toBe("");
    expect($("errRow").hidden).toBe(true);
  });

  it("formats ages over 10 s in whole seconds and missing ages as a dash", async () => {
    await openPage(makeDaemon({ device: { lastHeartbeatMs: 12345, lastHomeuiAckMs: null, recoveries: 2 } }));
    expect($("hb").textContent).toBe("12 s ago");
    expect($("ack").textContent).toBe("— ago");
    expect($("rec").textContent).toBe("2");
  });

  it("shows a cooler that is not connected, with the daemon's last error", async () => {
    await openPage(makeDaemon({ device: { connected: false, firmware: null, hidraw: null, lastError: "no RYUO IV hidraw found" } }));
    expect($("connPill").className).toBe("pill bad");
    expect($("dot").className).toBe("dot bad");
    expect($("conn").textContent).toBe("Not connected");
    expect($("connFw").textContent).toBe("");
    expect($("fw").textContent).toBe("—");
    expect($("hidraw").textContent).toBe("—");
    expect($("err").textContent).toBe("no RYUO IV hidraw found");
    expect($("errRow").hidden).toBe(false);
    expect($("connPill").title).toBe("no RYUO IV hidraw found");
  });

  it("hides a stale last error while the cooler is connected", async () => {
    await openPage(makeDaemon({ device: { lastError: "open /dev/hidraw8: Permission denied" } }));
    expect($("err").textContent).toBe("");
    expect($("errRow").hidden).toBe(true);
  });
});

// From errors.test.js: the header cases. Its other daemon-down cases read the hero, slots and media.
describe("daemon down", () => {
  it("shows the daemon as unreachable and keeps polling every second", async () => {
    const d = await openPage();
    d.down = true;
    await tick(1000);
    expect($("dot").className).toBe("dot bad");
    expect($("conn").textContent).toBe("Daemon unreachable");
    expect($("err").textContent).toBe("Failed to fetch");
    const before = d.gets("/api/state").length;
    await tick(3000);
    expect(d.gets("/api/state").length).toBe(before + 3);
    expect(d.gets("/api/stats").length).toBeGreaterThanOrEqual(before + 3);
  });

  it("reconnects in the header when the daemon comes back", async () => {
    const d = await openPage();
    d.down = true;
    await tick(2000);
    d.down = false;
    await tick(1000);
    expect($("dot").className).toBe("dot ok");
    expect($("conn").textContent).toBe("Connected");
    expect($("err").textContent).toBe("");
  });
});

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
