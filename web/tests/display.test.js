/**
 * The second-display switch: POST /api/display, and the status from GET /api/state
 * (off, starting, on with the frame rate, stopping, retrying, error).
 */
import { describe, expect, it } from "vitest";

import { $, makeDaemon, openPage, tick } from "./harness.js";

const shown = (id) => !$(id).hidden;

function toggle(on) {
  $("displayOn").checked = on;
  $("displayOn").dispatchEvent(new Event("change", { bubbles: true }));
}

describe("second display", () => {
  it("starts off, with the switch unchecked and no error", async () => {
    await openPage();
    expect($("displayOn").checked).toBe(false);
    expect($("displayOn").disabled).toBe(false);
    expect($("displayText").textContent).toBe("Off");
    expect($("displayDot").className).toBe("dot");
    expect(shown("displayErr")).toBe(false);
    expect(shown("displayRetry")).toBe(false);
  });

  it("says what the mode does, with units", async () => {
    await openPage();
    const note = $("displaySection").querySelector(".note").textContent;
    expect(note).toContain("2240×1080 virtual monitor");
    expect(note).toContain("Windows dragged past the right edge of your main monitor appear on the panel");
    expect(note).toContain("stats overlay and background video are hidden");
    expect(note).toContain("up to about 10 s");
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
    expect($("displayOn").checked).toBe(true);
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
    expect($("displayOn").checked).toBe(false);
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
    expect($("displayOn").checked).toBe(false);
    expect($("result").textContent).toBe("Second display: device worker did not answer within 3 s");
  });

  it("disables the switch when the daemon has no second display", async () => {
    await openPage(makeDaemon({ display: null }));
    expect($("displayOn").disabled).toBe(true);
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
    expect($("displayOn").checked).toBe(true);
    release();
    await tick(0);
    expect(d.posts("/api/display")).toEqual([{ on: true }]);
    expect($("displayOn").checked).toBe(true);
  });
});
