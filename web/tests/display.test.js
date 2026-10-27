/**
 * The second-display switch: POST /api/display, and the status from GET /api/state
 * (off, starting, on with the frame rate, stopping, retrying, error). Three controls share the
 * switch: the strip's "Panel shows" segments, the Desktop mirror tab's switch, and the Overlay
 * box, which is disabled while the desktop is on the panel.
 */
import { describe, expect, it } from "vitest";

import { $, makeDaemon, openPage, tick } from "./harness.js";

const shown = (id) => !$(id).hidden;

const switchOn = () => $("displaySwitch").getAttribute("aria-checked") === "true";
const pressed = (id) => $(id).getAttribute("aria-pressed") === "true";

/** What the user does: click the strip segment for the wanted state. */
function toggle(on) {
  $(on ? "modeMirror" : "modeStats").click();
}

describe("second display", () => {
  it("starts off, with the switch unchecked and no error", async () => {
    await openPage();
    expect(switchOn()).toBe(false);
    expect([pressed("modeStats"), pressed("modeMirror")]).toEqual([true, false]);
    expect($("displaySwitch").disabled).toBe(false);
    expect($("statsOn").disabled).toBe(false);
    expect($("displayText").textContent).toBe("Off");
    expect($("displayDot").className).toBe("dot");
    expect(shown("displayErr")).toBe(false);
    expect(shown("displayRetry")).toBe(false);
  });

  it("says what the mode does, with units", async () => {
    await openPage();
    const note = $("displayInfo").textContent;
    expect(note).toContain("a 2240×1080 virtual monitor");
    expect(note).toContain("Windows dragged past its right edge appear on the panel");
    expect(note).toContain("stats overlay and background video are hidden");
    expect(note).toContain("up to about 10 s");
    expect($("displaySection").textContent).toContain("choose Virtual-RYUO and allow restoring");
  });

  it("the tab's switch posts the opposite of its state", async () => {
    const d = await openPage();
    $("displaySwitch").click();
    await tick(0);
    expect(d.posts("/api/display")).toEqual([{ on: true }]);
    expect(switchOn()).toBe(true);
    $("displaySwitch").click();
    await tick(0);
    expect(d.posts("/api/display")).toEqual([{ on: true }, { on: false }]);
    expect(switchOn()).toBe(false);
  });

  it("a click on the segment already pressed sends nothing", async () => {
    const d = await openPage();
    $("modeStats").click();
    await tick(0);
    expect(d.posts("/api/display")).toEqual([]);
  });

  it("disables the Overlay box and shows the mirror in the hero while on", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 59.8, mbps: 9.7 } }));
    expect([pressed("modeStats"), pressed("modeMirror")]).toEqual([false, true]);
    expect($("statsOn").disabled).toBe(true);
    expect($("statsOnLabel").classList.contains("off")).toBe(true);
    expect($("mirrorView").hidden).toBe(false);
    expect($("mirrorChip").textContent).toBe("Desktop mirror · Virtual-RYUO 2240×1080");
    expect($("liveChip").hidden).toBe(true);
    expect($("mirrorHint").hidden).toBe(false);
    expect($("mirrorHint").textContent).toBe(
      "Position and scale: System Settings → Display & Monitor → Display Configuration → Virtual-RYUO",
    );
  });

  it("names a failed start in the hero's mirror chip, without the settings caption", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "retrying", error: "x", retryInS: 3 } }));
    expect($("mirrorChip").textContent).toBe("Desktop mirror · not running, see the Desktop mirror tab");
    expect($("mirrorHint").hidden).toBe(true);
  });

  it("says where KDE moves and scales the virtual monitor", async () => {
    await openPage();
    expect($("displaySettingsHint").textContent).toBe(
      "To move Virtual-RYUO, use Edit Arrangement in System Settings → Display & Monitor → Display Configuration; " +
        "its scale is set there too (Plasma may start it at 200 %). " +
        'Searching "Display Configuration" in KRunner or the app launcher opens that page.',
    );
    expect($("displayInfo").contains($("displaySettingsHint"))).toBe(true);
  });

  it("posts on:true at once and shows starting", async () => {
    const d = await openPage();
    toggle(true);
    await tick(0);
    expect(d.posts("/api/display")).toEqual([{ on: true }]);
    expect($("displayText").textContent).toBe("Starting…");
    expect($("result").textContent).toBe("Second display: starting");
  });

  it("shows the latest status line while starting", async () => {
    const d = await openPage(makeDaemon({ display: { on: true, state: "starting", message: "virtual monitor Virtual-RYUO is up, 2240x1080 at 60 Hz" } }));
    expect(switchOn()).toBe(true);
    expect($("displayText").textContent).toBe("Starting: virtual monitor Virtual-RYUO is up, 2240x1080 at 60 Hz");
    d.display = { ...d.display, state: "on" };
    await tick(1000);
    expect($("displayText").textContent).toBe("On. The frame rate shows after the first 5 s.");
  });

  it("shows the frame rate and bitrate with units, and a green dot", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 59.84, mbps: 9.7 } }));
    expect($("displayText").textContent).toBe("On: 59.8 frames/s at 9.7 Mb/s to the panel (average over 5 s)");
    expect($("displayDot").className).toBe("dot ok");
  });

  it("says when the mouse pointer is shown", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 59.8, mbps: 9.7, pointer: { shown: true, reason: null } } }));
    expect(shown("displayPointer")).toBe(true);
    expect($("displayPointer").textContent).toBe("Mouse pointer: shown on the panel.");
  });

  it("says why there is no mouse pointer and how to get it", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 59.8, mbps: 9.7, pointer: { shown: false, reason: "screen selection was cancelled" } } }));
    expect($("displayPointer").textContent).toBe(
      "No mouse pointer on the panel: screen selection was cancelled. Turn the switch off and on to choose the screen again.",
    );
  });

  it("warns when the black background could not be put on the cooler, until it clears", async () => {
    const error = "adb push exited with 1: adb: error: no devices/emulators found";
    const d = await openPage(makeDaemon({ display: { on: true, state: "on", fps: 59.8, mbps: 9.7, backgroundError: error } }));
    expect(shown("displayBackground")).toBe(true);
    expect($("displayBackground").textContent).toBe(
      `Couldn't put the black background on the cooler: ${error}. While the panel shows the desktop, HomeUI's video plays under it and uses more of the cooler's decoder.`,
    );
    d.display = { ...d.display, backgroundError: null };
    await tick(1000);
    expect(shown("displayBackground")).toBe(false);
    expect($("displayBackground").textContent).toBe("");
  });

  it("shows no background warning normally", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 59.8, mbps: 9.7 } }));
    expect(shown("displayBackground")).toBe(false);
  });

  it("hides the pointer line while off", async () => {
    await openPage(makeDaemon({ display: { on: false, state: "off", pointer: { shown: true, reason: null } } }));
    expect(shown("displayPointer")).toBe(false);
  });

  it("explains 0 frames/s on a still desktop", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 0, mbps: 0 } }));
    expect($("displayText").textContent).toBe("On. No frames sent in the last 5 s: nothing on the virtual monitor changed.");
  });

  it("posts on:false and shows stopping until the child has exited", async () => {
    const d = await openPage(makeDaemon({ display: { on: true, state: "on", fps: 60, mbps: 10 } }));
    toggle(false);
    await tick(0);
    expect(d.posts("/api/display")).toEqual([{ on: false }]);
    expect($("displayText").textContent).toBe("Stopping: removing the virtual monitor, up to about 10 s…");
    d.display = { ...d.display, state: "off" };
    await tick(1000);
    expect($("displayText").textContent).toBe("Off");
    expect(switchOn()).toBe(false);
    expect($("mirrorView").hidden).toBe(true);
    expect($("statsOn").disabled).toBe(false);
  });

  it("shows a failed start with its error lines, the countdown and Try again now", async () => {
    const error = "ryuo_display.py exited with status 1: krfb-virtualmonitor exited (status 1):\n  could not connect to display";
    const d = await openPage(makeDaemon({ display: { on: true, state: "retrying", error, retryInS: 9 } }));
    expect($("displayText").textContent).toBe("Not running. Next try in 9 s.");
    expect($("displayDot").className).toBe("dot bad");
    expect(shown("displayErr")).toBe(true);
    expect($("displayErr").textContent).toBe(error);
    expect(shown("displayRetry")).toBe(true);
    d.display.retryInS = 8;
    await tick(1000);
    expect($("displayText").textContent).toBe("Not running. Next try in 8 s.");

    $("displayRetry").click();
    await tick(0);
    expect(d.posts("/api/display")).toEqual([{ on: true }]);
    expect(shown("displayErr")).toBe(false);
    expect(shown("displayRetry")).toBe(false);
  });

  it("says when an error is not retried by itself", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "error", error: "ryuo_display.py exited with status 1: no cooler on adb" } }));
    expect($("displayText").textContent).toContain("Stopped by an error that a retry would hit again");
    expect($("displayText").textContent).toContain("Try again now");
    expect($("displayErr").textContent).toBe("ryuo_display.py exited with status 1: no cooler on adb");
    expect(shown("displayRetry")).toBe(true);
  });

  it("puts the switch back and reports a refused POST", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/display", { status: 504, body: { ok: false, error: "device worker did not answer within 3 s" } });
    toggle(true);
    await tick(0);
    expect(switchOn()).toBe(false);
    expect(pressed("modeStats")).toBe(true);
    expect($("result").textContent).toBe("Second display: device worker did not answer within 3 s");
  });

  it("disables the switch when the daemon has no second display", async () => {
    await openPage(makeDaemon({ display: null }));
    expect($("displaySwitch").disabled).toBe(true);
    expect($("modeStats").disabled && $("modeMirror").disabled).toBe(true);
    expect($("displayText").textContent).toContain("Not available");
  });

  it("keeps the switch the user just flipped while the POST is in flight", async () => {
    const d = await openPage();
    let release;
    const slow = new Promise((r) => { release = r; });
    const fetch = d.fetch.getMockImplementation();
    d.fetch.mockImplementation(async (url, opt) => {
      if (url === "/api/display") await slow;
      return fetch(url, opt);
    });
    toggle(true);
    await tick(1000);  // a state poll still reports the old "off" meanwhile
    expect(d.gets("/api/state").length).toBeGreaterThan(1);
    expect(switchOn()).toBe(true);
    release();
    await tick(0);
    expect(d.posts("/api/display")).toEqual([{ on: true }]);
    expect(switchOn()).toBe(true);
  });
});
