/**
 * Burn-in protection on the Lit page: the old page's behaviour (da82253, web/index.html
 * renderProtection, syncProtection, protectionClick and sendProtection) that
 * protection.test.js does not pin. protection.test.js stays as the burn-in-protection branch
 * wrote it; these cases are the port's. Every case was also run, unchanged, against the old page
 * and its harness at da82253, and passed there.
 */
import { describe, expect, it } from "vitest";

import { $, makeDaemon, openPage, setInput, tick } from "./harness.js";

const switchChecked = () => $("protSwitch").getAttribute("aria-checked");
const MIRRORING = { display: { on: true, state: "on", fps: 30, mbps: 4 } };

/**
 * Hold every POST /api/display/protection until the returned `answer()` is called, so a test can
 * look at the page, and let polls run, while the POST is pending.
 */
function holdProtectionPosts(daemon) {
  const serve = daemon.fetch.getMockImplementation();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  daemon.fetch.mockImplementation(async (url, options) => {
    if (url === "/api/display/protection") await held;
    return serve(url, options);
  });
  return () => release();
}

describe("the card's focus", () => {
  // The old protectionClick focused Turn off after showing the question, and Cancel gave the
  // focus back to the switch, so a keyboard user lands on the next control they need.
  it("moves to Turn off when the card asks, and back to the switch on Cancel", async () => {
    await openPage();
    $("protSwitch").click();
    expect($("protAsk").hidden).toBe(false);
    expect(document.activeElement).toBe($("protTurnOff"));
    $("protCancel").click();
    expect(document.activeElement).toBe($("protSwitch"));
  });

  it("does not move when the switch turns protection on", async () => {
    await openPage(makeDaemon({ config: { burnInProtection: false } }));
    $("protSwitch").focus();
    $("protSwitch").click();
    expect(document.activeElement).toBe($("protSwitch"));
    await tick(0);
  });
});

describe("the question before protection goes off", () => {
  // The old syncProtection never touched protectionAsking: a poll leaves an open question open.
  it("stays open through a poll", async () => {
    const daemon = await openPage();
    $("protSwitch").click();
    await tick(1000);
    expect($("protAsk").hidden).toBe(false);
    expect(daemon.posts("/api/display/protection")).toEqual([]);
  });
});

describe("the switch while its POST runs", () => {
  it("is disabled, keeps the click through a poll, and follows ryuod after", async () => {
    const daemon = await openPage(makeDaemon({ config: { burnInProtection: false } }));
    const answer = holdProtectionPosts(daemon);
    $("protSwitch").click();
    expect(switchChecked()).toBe("true");
    expect($("protSwitch").disabled).toBe(true);
    expect($("protWarn").hidden).toBe(true);
    await tick(1000); // a poll still reports burnInProtection false
    expect(daemon.gets("/api/state").length).toBeGreaterThan(1);
    expect(switchChecked()).toBe("true");
    expect($("protSwitch").disabled).toBe(true);
    answer();
    await tick(0);
    expect(daemon.posts("/api/display/protection")).toEqual([{ enabled: true }]);
    expect(switchChecked()).toBe("true");
    expect($("protSwitch").disabled).toBe(false);
    daemon.config.burnInProtection = false; // another client turns it off again
    await tick(1000);
    expect(switchChecked()).toBe("false");
  });

  it("keeps Turn off's click through a poll", async () => {
    const daemon = await openPage();
    const answer = holdProtectionPosts(daemon);
    $("protSwitch").click();
    $("protTurnOff").click();
    expect($("protAsk").hidden).toBe(true);
    expect(switchChecked()).toBe("false");
    expect($("protSwitch").disabled).toBe(true);
    await tick(1000);
    expect(switchChecked()).toBe("false");
    expect($("protWarn").hidden).toBe(false);
    answer();
    await tick(0);
    expect($("protSwitch").disabled).toBe(false);
    expect(switchChecked()).toBe("false");
  });

  // syncProtection kept only the switch while sending; the receiver's report still came in.
  it("still shows each receiver report", async () => {
    const daemon = await openPage(makeDaemon({ ...MIRRORING, protection: { state: "active", idleS: 0, nextShiftS: 170 } }));
    const answer = holdProtectionPosts(daemon);
    $("protSwitch").click();
    $("protTurnOff").click();
    daemon.protection = { ...daemon.protection, state: "dimmed", idleS: 185 };
    await tick(1000);
    // Off while the POST runs: the line reads "off" whatever the receiver says.
    expect($("protStatus").textContent).toBe("Protection: off");
    expect($("protChip").textContent).toBe("Burn-in protection off");
    answer();
    await tick(0);
    expect($("result").textContent).toBe("Burn-in protection off — applies to the panel within 1 s");
  });
});

describe("a refused switch", () => {
  it("goes back on when Turn off is refused, and a poll agrees", async () => {
    const daemon = await openPage(makeDaemon(MIRRORING));
    daemon.replyOnce("POST /api/display/protection", { status: 503, body: { ok: false, error: "config not saved" } });
    $("protSwitch").click();
    $("protTurnOff").click();
    await tick(0);
    expect(switchChecked()).toBe("true");
    expect($("protSwitch").disabled).toBe(false);
    expect($("protWarn").hidden).toBe(true);
    expect($("protChip").classList.contains("warn")).toBe(false);
    expect($("result").textContent).toBe("Burn-in protection not turned off: config not saved");
    expect(daemon.config.burnInProtection).toBe(true);
    await tick(1000);
    expect(switchChecked()).toBe("true");
  });

  it("stays off after a refused turn-on, through the next poll", async () => {
    const daemon = await openPage(makeDaemon({ config: { burnInProtection: false } }));
    daemon.replyOnce("POST /api/display/protection", { status: 503, body: { ok: false, error: "config not saved" } });
    $("protSwitch").click();
    await tick(1000);
    expect(switchChecked()).toBe("false");
    expect($("protWarn").hidden).toBe(false);
  });
});

describe("the toast after the switch", () => {
  // displayWant, not display.on: the old page said "within 1 s" for a mirror still starting too.
  it.each([
    [true, false, "Burn-in protection on — applies to the panel within 1 s"],
    [true, true, "Burn-in protection on; applies from the next start of the second display"],
    [false, false, "Burn-in protection off — applies to the panel within 1 s"],
    [false, true, "Burn-in protection off; applies from the next start of the second display"],
  ])("turning on %j, mirror off %j: %j", async (turnOn, mirrorOff, text) => {
    const display = mirrorOff ? {} : MIRRORING.display;
    await openPage(makeDaemon({ display, config: { burnInProtection: !turnOn } }));
    $("protSwitch").click();
    if (!turnOn) $("protTurnOff").click();
    await tick(0);
    expect($("result").textContent).toBe(text);
  });

  it("says within 1 s while the mirror is still starting", async () => {
    const daemon = await openPage(makeDaemon({ config: { burnInProtection: false } }));
    $("modeMirror").click();
    await tick(0);
    expect(daemon.display.state).toBe("starting");
    $("protSwitch").click();
    await tick(0);
    expect($("result").textContent).toBe("Burn-in protection on — applies to the panel within 1 s");
  });
});

describe("the hero chip", () => {
  it("turns red when protection goes off and back when it comes on", async () => {
    await openPage(makeDaemon(MIRRORING));
    expect($("protChip").textContent).toBe("Protection: starts with the mirror");
    expect($("protChip").className).toBe("chip prot");
    $("protSwitch").click();
    $("protTurnOff").click();
    expect($("protChip").textContent).toBe("Burn-in protection off");
    expect($("protChip").className).toBe("chip prot warn");
    await tick(0);
    $("protSwitch").click();
    expect($("protChip").textContent).toBe("Protection: starts with the mirror");
    expect($("protChip").className).toBe("chip prot");
    await tick(0);
    expect($("protChip").className).toBe("chip prot");
  });

  // The old renderProtection showed the chip whenever the card showed; the mirror view around it
  // hides it while the panel shows stats.
  it("is not hidden itself while the panel shows stats; the mirror view around it is", async () => {
    await openPage();
    expect($("protChip").hidden).toBe(false);
    expect($("mirrorView").hidden).toBe(true);
  });
});

describe("the receiver report on the page", () => {
  // Each state the old protectionText knew, in both duration forms (seconds under 1 min, whole
  // minutes from 1 min), and the fields it leaves out when null.
  it.each([
    [{ state: "active", idleS: 0, nextShiftS: 0 }, "active · next shift in 0 s"],
    [{ state: "active", idleS: 0, nextShiftS: 59 }, "active · next shift in 59 s"],
    [{ state: "active", idleS: 0, nextShiftS: 60 }, "active · next shift in 1 min"],
    [{ state: "active", idleS: 0, nextShiftS: null }, "active"],
    [{ state: "dimmed", idleS: 42, nextShiftS: 30 }, "dimmed · idle 42 s"],
    [{ state: "dimmed", idleS: null, nextShiftS: 30 }, "dimmed"],
    [{ state: "black", idleS: 59.4, nextShiftS: 30 }, "black · idle 59 s"],
    [{ state: "black", idleS: 600, nextShiftS: 30 }, "black · idle 10 min"],
    [{ state: "black", idleS: null, nextShiftS: null }, "black"],
    [{ state: "refresh", idleS: 400, nextShiftS: 0 }, "refreshing"],
    [{ state: "sleeping", idleS: 5, nextShiftS: 5 }, "sleeping"],
  ])("shows %j as %j in the card and the chip", async (report, text) => {
    await openPage(makeDaemon({ ...MIRRORING, protection: report }));
    expect($("protStatus").textContent).toBe(`Protection: ${text}`);
    expect($("protChip").textContent).toBe(`Protection: ${text}`);
  });

  it("reads off for any report while the switch is off", async () => {
    await openPage(makeDaemon({ ...MIRRORING, config: { burnInProtection: false }, protection: { state: "dimmed", idleS: 300 } }));
    expect($("protStatus").textContent).toBe("Protection: off");
  });

  it("takes the report in Turn on's reply", async () => {
    const daemon = await openPage(makeDaemon({ ...MIRRORING, config: { burnInProtection: false } }));
    daemon.protection = { state: "active", idleS: 1, nextShiftS: 179 };
    $("protSwitch").click();
    await tick(0);
    expect($("protStatus").textContent).toBe("Protection: active · next shift in 3 min");
  });
});

describe("the card for each ryuod", () => {
  // syncProtection read the switch from config alone: a ryuod without the second display still
  // has the setting, and the card shows it with no report.
  it("shows for a ryuod with the setting and no second display", async () => {
    await openPage(makeDaemon({ display: null }));
    expect($("protCard").hidden).toBe(false);
    expect($("protStatus").textContent).toBe("Protection: starts with the mirror");
  });

  it("hides again when ryuod is replaced by an older one", async () => {
    const daemon = await openPage(makeDaemon(MIRRORING));
    daemon.legacy = true;
    await tick(1000);
    expect($("protCard").hidden).toBe(true);
    expect($("protChip").hidden).toBe(true);
  });
});

describe("the overlay note", () => {
  // The old renderDisplaySwitch set the note from displayWant, which follows the click before
  // ryuod answers.
  it("follows the mirror switch's click", async () => {
    const daemon = await openPage();
    expect($("overlayMirrorNote").hidden).toBe(true);
    $("modeMirror").click();
    expect($("overlayMirrorNote").hidden).toBe(false);
    await tick(0);
    daemon.display = { ...daemon.display, state: "on" };
    await tick(1000);
    $("modeStats").click();
    expect($("overlayMirrorNote").hidden).toBe(true);
    await tick(0);
  });

  it("follows a mirror started elsewhere", async () => {
    const daemon = await openPage();
    daemon.display = { ...daemon.display, ...MIRRORING.display };
    await tick(1000);
    expect($("overlayMirrorNote").hidden).toBe(false);
  });
});

describe("an overlay edit under the mirror", () => {
  it("says a colour is saved for when the second display is off", async () => {
    const daemon = await openPage(makeDaemon(MIRRORING));
    setInput($("titleColor"), "#00ff00");
    await tick(300);
    expect(daemon.config.titleColor).toBe("#00FF00");
    expect($("result").textContent).toMatch(/ saved; applies when the second display is off$/);
  });

  // A ryuod before burn-in protection still sent overlay edits while mirroring.
  it("is confirmed by an older ryuod", async () => {
    await openPage(makeDaemon({ ...MIRRORING, legacy: true }));
    setInput($("titleColor"), "#00ff00");
    await tick(300);
    expect($("result").textContent).toMatch(/ — cooler confirmed$/);
  });
});
