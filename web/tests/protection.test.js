/**
 * Burn-in protection for the desktop mirror: the switch (POST /api/display/protection), the
 * inline question before it goes off, the warning while it is off, the receiver's state from
 * display.protection in the card and the hero, and the overlay edits ryuod holds while mirroring.
 */
import { describe, expect, it } from "vitest";

import { $, choose, makeDaemon, openPage, tick } from "./harness.js";

const switchChecked = () => $("protSwitch").getAttribute("aria-checked");
const MIRRORING = { display: { on: true, state: "on", fps: 30, mbps: 4 } };

describe("burn-in protection switch", () => {
  it("is on by default, with no warning", async () => {
    await openPage();
    expect($("protCard").hidden).toBe(false);
    expect(switchChecked()).toBe("true");
    expect($("protWarn").hidden).toBe(true);
    expect($("protAsk").hidden).toBe(true);
    expect($("protStatus").textContent).toBe("Protection: starts with the mirror");
  });

  it("explains what it does, with units", async () => {
    await openPage();
    expect($("protCard").querySelector(".lines").textContent.replace(/\s+/g, " ").trim()).toBe(
      "Only while the panel shows the desktop. The picture shifts by up to 4 px every 3 min, and goes black for 2 s every 5 min. "
        + "After 3 min without a change on the desktop the panel dims to 40 % of your brightness, at most 15 % of full; after 10 min it goes black. "
        + "A window, video or pointer move wakes it at once; a blinking cursor or a clock does not. Your windows and the virtual monitor stay as they are.",
    );
  });

  it("asks in the card before turning off, and sends nothing until Turn off", async () => {
    const daemon = await openPage();
    $("protSwitch").click();
    await tick(0);
    expect(daemon.posts("/api/display/protection")).toEqual([]);
    expect($("protAsk").hidden).toBe(false);
    expect($("protAsk").querySelector("p").textContent).toBe(
      "Turn off burn-in protection? Windows left on screen for hours can leave a permanent mark on the OLED panel.",
    );
    expect(switchChecked()).toBe("true");
    $("protTurnOff").click();
    await tick(0);
    expect(daemon.posts("/api/display/protection")).toEqual([{ enabled: false }]);
    expect(daemon.config.burnInProtection).toBe(false);
    expect(switchChecked()).toBe("false");
    expect($("protAsk").hidden).toBe(true);
    expect($("result").textContent).toBe("Burn-in protection off; applies from the next start of the second display");
  });

  it("Cancel keeps it on", async () => {
    const daemon = await openPage();
    $("protSwitch").click();
    $("protCancel").click();
    await tick(0);
    expect(daemon.posts("/api/display/protection")).toEqual([]);
    expect($("protAsk").hidden).toBe(true);
    expect(switchChecked()).toBe("true");
  });

  it("turns on at once, and says it reaches a running mirror within 1 s", async () => {
    const daemon = await openPage(makeDaemon({ ...MIRRORING, config: { burnInProtection: false } }));
    $("protSwitch").click();
    await tick(0);
    expect(daemon.posts("/api/display/protection")).toEqual([{ enabled: true }]);
    expect($("protAsk").hidden).toBe(true);
    expect(switchChecked()).toBe("true");
    expect($("result").textContent).toBe("Burn-in protection on — applies to the panel within 1 s");
  });

  it("goes back and shows ryuod's refusal", async () => {
    const daemon = await openPage(makeDaemon({ config: { burnInProtection: false } }));
    daemon.replyOnce("POST /api/display/protection", { status: 400, body: { ok: false, error: "enabled must be true or false" } });
    $("protSwitch").click();
    await tick(0);
    expect(switchChecked()).toBe("false");
    expect($("result").textContent).toBe("Burn-in protection not turned on: enabled must be true or false");
  });

  it("follows a change made elsewhere", async () => {
    const daemon = await openPage();
    daemon.config.burnInProtection = false;
    await tick(1000);
    expect(switchChecked()).toBe("false");
  });
});

describe("while protection is off", () => {
  it("keeps a red warning in the card and the hero", async () => {
    await openPage(makeDaemon({ ...MIRRORING, config: { burnInProtection: false } }));
    expect($("protWarn").hidden).toBe(false);
    expect($("protWarn").textContent).toBe(
      "Burn-in protection is off. Windows left on screen for hours can leave a permanent mark on the OLED panel.",
    );
    expect($("protStatus").textContent).toBe("Protection: off");
    expect($("protChip").hidden).toBe(false);
    expect($("protChip").textContent).toBe("Burn-in protection off");
    expect($("protChip").classList.contains("warn")).toBe(true);
  });
});

describe("receiver state", () => {
  it.each([
    [{ state: "active", idleS: 5, nextShiftS: 118 }, "active · next shift in 2 min"],
    [{ state: "active", idleS: 5, nextShiftS: 42 }, "active · next shift in 42 s"],
    [{ state: "dimmed", idleS: 250, nextShiftS: 30 }, "dimmed · idle 4 min"],
    [{ state: "black", idleS: 725, nextShiftS: 30 }, "black · idle 12 min"],
    [{ state: "refresh", idleS: 20, nextShiftS: 60 }, "refreshing"],
    [{ state: "off", idleS: null, nextShiftS: null }, "off"],
    [{ state: null, idleS: null, nextShiftS: null }, "starts with the mirror"],
  ])("shows %j as %j, in the card and the hero chip", async (report, text) => {
    await openPage(makeDaemon({ ...MIRRORING, protection: report }));
    expect($("protStatus").textContent).toBe(`Protection: ${text}`);
    expect($("protChip").textContent).toBe(`Protection: ${text}`);
    expect($("protChip").classList.contains("warn")).toBe(false);
  });

  it("follows each report", async () => {
    const daemon = await openPage(makeDaemon({ ...MIRRORING, protection: { state: "active", idleS: 0, nextShiftS: 170 } }));
    daemon.protection = { ...daemon.protection, state: "dimmed", idleS: 185 };
    await tick(1000);
    expect($("protStatus").textContent).toBe("Protection: dimmed · idle 3 min");
  });
});

describe("overlay while the desktop is mirrored", () => {
  it("says edits wait for the mirror to stop, and the message says so too", async () => {
    const daemon = await openPage(makeDaemon(MIRRORING));
    expect($("overlayMirrorNote").hidden).toBe(false);
    expect($("overlayMirrorNote").textContent).toBe(
      "The panel shows the desktop, with no stats overlay. Changes here are saved and applied when the second display stops.",
    );
    choose($("slot4"), "GPU Load");
    await tick(300);
    expect(daemon.config.items[4]).toBe("GPU Load");
    expect($("result").textContent).toBe("Slot 5: GPU Load saved; applies when the second display is off");
  });

  it("hides the note while the panel shows stats", async () => {
    await openPage();
    expect($("overlayMirrorNote").hidden).toBe(true);
  });
});

describe("older ryuod", () => {
  it("hides the protection card and the hero chip", async () => {
    await openPage(makeDaemon({ ...MIRRORING, legacy: true }));
    expect($("protCard").hidden).toBe(true);
    expect($("protChip").hidden).toBe(true);
  });

  it("shows them once ryuod is replaced by one with protection", async () => {
    const daemon = await openPage(makeDaemon({ legacy: true }));
    daemon.legacy = false;
    await tick(1000);
    expect($("protCard").hidden).toBe(false);
  });
});
