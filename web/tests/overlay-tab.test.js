/**
 * The Overlay tab, the strip (overlay box, brightness, sample time) and the header's panel
 * switch on the Lit page: what the new page does differently from the old one, or what no old
 * test checks. The old tests of these controls (sync, errors and features.test.js) run against
 * this page as they are.
 */
import { describe, expect, it } from "vitest";

import { $, choose, makeDaemon, openPage, preview, setInput, slot, tick } from "./harness-lit.js";

const checkedAttr = (id) => $(id).getAttribute("aria-checked");
const STANDBY_IN_MIRROR = "the panel shows the second display; turn that off before standby";

/**
 * Hold every POST to `path` until the returned `answer()` is called, so a test can look at the
 * page while the POST is pending. The request reaches the fake daemon only on answer().
 */
function holdPosts(path) {
  const serve = window.fetch;
  const waiting = [];
  globalThis.fetch = window.fetch = (url, options = {}) => {
    if (options.method !== "POST" || String(url) !== path) return serve(url, options);
    return new Promise((resolve) => waiting.push(() => resolve(serve(url, options))));
  };
  return async () => {
    for (const release of waiting.splice(0)) release();
    await tick(0);
  };
}

// The old page compared a poll with what it last saw per group of controls, and held a group
// while its debounce or POST was pending; the store holds keys (actions.ts).
describe("the poll and the controls the user is on", () => {
  it("leaves the slider while its POST is pending, and takes ryuod's answer after", async () => {
    const daemon = await openPage();
    const answer = holdPosts("/api/brightness");
    setInput($("brightness"), "17");
    await tick(150);
    daemon.config.brightness = 60; // another client, seen by the poll while the POST waits
    await tick(1000);
    expect($("brightness").value).toBe("17");
    await answer();
    // 17 % is device value 17, which lights 42/255 = 16 %.
    expect(daemon.posts("/api/brightness")).toEqual([{ percent: 17 }]);
    expect($("brightness").value).toBe("16");
  });

  it("leaves the opacity slider while it is dragged", async () => {
    const daemon = await openPage(makeDaemon({ config: { filter: { on: true, opacity: 100 } } }));
    $("opacity").dispatchEvent(new Event("pointerdown"));
    daemon.config.filter = { on: true, opacity: 30 };
    await tick(1000);
    expect($("opacity").value).toBe("100");
    window.dispatchEvent(new Event("pointerup"));
    await tick(1000);
    expect($("opacity").value).toBe("30");
    expect($("opacityOut").textContent).toBe("30 %");
  });

  it("leaves a focused colour input, whose picker may be open, until it loses focus", async () => {
    const daemon = await openPage();
    $("contentColor").focus();
    daemon.config.contentColor = "#00FF00";
    await tick(1000);
    expect($("contentColor").value).toBe("#ffffff");
    $("contentColor").blur();
    await tick(1000);
    expect($("contentColor").value).toBe("#00ff00");
    expect($("contentHex").textContent).toBe("#00FF00");
  });

  it("brings another client's colour once the overlay POST is answered", async () => {
    const daemon = await openPage();
    const answer = holdPosts("/api/overlay");
    choose(slot(4), "GPU Load");
    await tick(300);
    daemon.config.contentColor = "#00FF00";
    await tick(1000);
    expect($("contentColor").value).toBe("#ffffff");
    await answer();
    // The POST carried the page's #FFFFFF and the daemon took it, so there is nothing to bring.
    expect(daemon.config.contentColor).toBe("#FFFFFF");
    daemon.config.contentColor = "#123456";
    await tick(1000);
    expect($("contentColor").value).toBe("#123456");
  });
});

describe("the panel switch on the new page", () => {
  it("is hidden until the first state poll answers", async () => {
    const daemon = makeDaemon();
    daemon.down = true;
    await openPage(daemon);
    expect($("panelSwitch").hidden).toBe(true);
    daemon.down = false;
    await tick(1000);
    expect($("panelSwitch").hidden).toBe(false);
  });

  it("shows the click at once and is disabled until ryuod answers", async () => {
    const daemon = await openPage();
    const answer = holdPosts("/api/panel");
    $("panelSwitch").click();
    expect(checkedAttr("panelSwitch")).toBe("false");
    expect($("panelLabel").textContent).toBe("Standby");
    expect($("panelSwitch").disabled).toBe(true);
    await tick(1000); // ryuod still says on; the poll leaves the switch while the POST runs
    expect(checkedAttr("panelSwitch")).toBe("false");
    await answer();
    expect(daemon.posts("/api/panel")).toEqual([{ on: false }]);
    expect($("panelSwitch").disabled).toBe(false);
    expect($("result").textContent).toBe("Panel in standby — cooler confirmed");
  });

  it("goes back and shows ryuod's refusal", async () => {
    const daemon = await openPage();
    daemon.replyOnce("POST /api/panel", { status: 409, body: { ok: false, error: STANDBY_IN_MIRROR } });
    $("panelSwitch").click();
    await tick(0);
    expect(checkedAttr("panelSwitch")).toBe("true");
    expect($("panelLabel").textContent).toBe("On");
    expect($("result").textContent).toBe(`Panel not put in standby: ${STANDBY_IN_MIRROR}`);
  });

  it("follows a standby set by another client (the tray)", async () => {
    const daemon = await openPage();
    daemon.panel.on = false;
    await tick(1000);
    expect($("panelLabel").textContent).toBe("Standby");
    expect(checkedAttr("panelSwitch")).toBe("false");
  });
});

// No old test covers the outline that links a slot row to its place on the panel.
describe("a slot row under the pointer", () => {
  it("outlines its slot in the preview, and an empty slot shows its number", async () => {
    await openPage();
    $("slotRow4").dispatchEvent(new Event("mouseenter"));
    expect($("slotRow4").classList.contains("hot")).toBe(true);
    expect($("ps5").classList.contains("hot")).toBe(true);
    expect(preview(5).title).toBe("Slot 5");
    $("slotRow4").dispatchEvent(new Event("mouseleave"));
    expect($("ps5").classList.contains("hot")).toBe(false);
    expect(preview(5).title).toBe("");
  });

  it("stays outlined while its select has focus", async () => {
    await openPage();
    slot(0).focus();
    $("slotRow0").dispatchEvent(new Event("mouseenter"));
    $("slotRow0").dispatchEvent(new Event("mouseleave"));
    expect($("ps1").classList.contains("hot")).toBe(true);
    slot(0).blur();
    expect($("ps1").classList.contains("hot")).toBe(false);
  });
});

describe("the strip", () => {
  it("disables the overlay box while the panel shows the second display", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 60, mbps: 9 } }));
    expect($("statsOn").disabled).toBe(true);
    expect($("statsOnLabel").className).toBe("check off");
    expect($("statsOnLabel").title).toBe("The panel shows the desktop; the overlay returns when the second display is off.");
  });

  it("shows the sample time from the stats poll", async () => {
    await openPage();
    expect($("sampled").textContent).toBe(`sampled ${new Date(Date.UTC(2026, 9, 22, 12, 5, 8)).toLocaleTimeString()}`);
  });
});
