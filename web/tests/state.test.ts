// @vitest-environment node
/**
 * The store: patch and subscribe, the editing holds, and the poll's merge around the keys the
 * user is editing. No DOM, no fetch: the merge is fed the replies a poll would get.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TrayStatus } from "../src/api-types.ts";
import { errorText, mergeAround, Store, TOAST_MS } from "../src/state.ts";

const tray = (change: Partial<TrayStatus> = {}): TrayStatus => ({
  autostart: true,
  leftClick: "page",
  brightnessSteps: [25, 50, 75, 100],
  brightnessStepValues: [26, 51, 77, 102],
  leftClickOptions: ["page", "menu", "panel", "stats"],
  ...change,
});

describe("patch and subscribe", () => {
  it("merges the change into the state and calls every listener once", () => {
    const store = new Store();
    const listener = vi.fn();
    store.subscribe(listener);
    store.patch({ unreachable: "Failed to fetch" });
    expect(store.state.unreachable).toBe("Failed to fetch");
    expect(store.state.device).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops calling a listener that unsubscribed", () => {
    const store = new Store();
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    stop();
    store.patch({ unreachable: null });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("editing holds", () => {
  it("keep a key in editing until every holder has released it", () => {
    const store = new Store();
    store.edit("tray.leftClick", true); // the select has focus
    store.edit("tray.leftClick", true); // its POST runs
    store.edit("tray.leftClick", false); // the POST answered
    expect(store.state.editing.has("tray.leftClick")).toBe(true);
    store.edit("tray.leftClick", false); // the select lost focus
    expect(store.state.editing.has("tray.leftClick")).toBe(false);
  });

  it("notify the listeners, so the controls can show the hold", () => {
    const store = new Store();
    const listener = vi.fn();
    store.subscribe(listener);
    store.edit("tempUnit", true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("mergeAround", () => {
  it("copies the keys ryuod changed and records them as seen", () => {
    const seen = new Map([
      ["memoryMHz", "0"],
      ["tempUnit", '"Celsius"'],
    ]);
    const current = { memoryMHz: 0, tempUnit: "Celsius" };
    const copied = mergeAround(current, { memoryMHz: 6000, tempUnit: "Celsius" }, seen, new Set());
    expect(copied).toEqual(["memoryMHz"]);
    expect(current).toEqual({ memoryMHz: 6000, tempUnit: "Celsius" });
    expect(seen.get("memoryMHz")).toBe("6000");
  });

  it("leaves a key the user is editing, and copies it once the edit ends", () => {
    const seen = new Map([["memoryMHz", "0"]]);
    const current = { memoryMHz: 64 }; // typed, not sent yet
    expect(mergeAround(current, { memoryMHz: 3200 }, seen, new Set(["memoryMHz"]))).toEqual([]);
    expect(current.memoryMHz).toBe(64);
    expect(mergeAround(current, { memoryMHz: 3200 }, seen, new Set())).toEqual(["memoryMHz"]);
    expect(current.memoryMHz).toBe(3200);
  });

  it("keeps the user's value after a failed save, while ryuod's value has not moved", () => {
    const seen = new Map([["brightness", "100"]]);
    const current = { brightness: 60 }; // the POST failed; 60 waits to be sent again
    expect(mergeAround(current, { brightness: 100 }, seen, new Set())).toEqual([]);
    expect(current.brightness).toBe(60);
  });

  it("compares objects and lists by value", () => {
    const seen = new Map([["filter", '{"on":false,"opacity":100}']]);
    const current = { filter: { on: true, opacity: 40 } };
    expect(mergeAround(current, { filter: { on: false, opacity: 100 } }, seen, new Set())).toEqual([]);
    expect(mergeAround(current, { filter: { on: false, opacity: 90 } }, seen, new Set())).toEqual(["filter"]);
    expect(current.filter).toEqual({ on: false, opacity: 90 });
  });

  it("matches editing keys with the section's prefix", () => {
    const seen = new Map([["tray.leftClick", '"page"']]);
    const current = { leftClick: "page" };
    expect(mergeAround(current, { leftClick: "stats" }, seen, new Set(["leftClick"]), "tray.")).toEqual(["leftClick"]);
    current.leftClick = "page";
    seen.set("tray.leftClick", '"page"');
    expect(mergeAround(current, { leftClick: "stats" }, seen, new Set(["tray.leftClick"]), "tray.")).toEqual([]);
  });
});

describe("Store.merge", () => {
  it("takes the first poll whole and reports every key", () => {
    const store = new Store();
    expect(store.merge("tray", tray())).toEqual(Object.keys(tray()));
    expect(store.state.tray).toEqual(tray());
  });

  it("then merges around the keys in editing", () => {
    const store = new Store();
    store.merge("tray", tray());
    store.edit("tray.leftClick", true);
    const changed = store.merge("tray", tray({ leftClick: "stats", brightnessSteps: [30, 60] }));
    expect(changed).toEqual(["brightnessSteps"]);
    expect(store.state.tray?.leftClick).toBe("page");
    expect(store.state.tray?.brightnessSteps).toEqual([30, 60]);
  });

  it("does not undo a POST reply the poll has not caught up with", () => {
    const store = new Store();
    store.merge("tray", tray());
    // The POST's reply is recorded as ryuod's value...
    store.saw("tray", { leftClick: "menu" });
    store.patch({ tray: tray({ leftClick: "menu" }) });
    // ...so a poll that still carries it changes nothing, and a later change still arrives.
    expect(store.merge("tray", tray({ leftClick: "menu" }))).toEqual([]);
    expect(store.merge("tray", tray({ leftClick: "panel" }))).toEqual(["leftClick"]);
  });

  it("drops a section the reply no longer has", () => {
    const store = new Store();
    store.merge("tray", tray());
    store.merge("tray", null);
    expect(store.state.tray).toBeNull();
  });

  it("leaves the state object alone when nothing changed", () => {
    const store = new Store();
    store.merge("tray", tray());
    const before = store.state.tray;
    const listener = vi.fn();
    store.subscribe(listener);
    store.merge("tray", tray());
    expect(store.state.tray).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("toast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides a message after TOAST_MS and keeps its text", () => {
    vi.useFakeTimers();
    const store = new Store();
    store.say("Saved", false, "Sent: POST preset");
    expect(store.state.toast).toEqual({ text: "Saved", bad: false, detail: "Sent: POST preset", shown: true });
    vi.advanceTimersByTime(TOAST_MS);
    expect(store.state.toast).toEqual({ text: "Saved", bad: false, detail: "Sent: POST preset", shown: false });
  });

  it("keeps an error until it is dismissed", () => {
    vi.useFakeTimers();
    const store = new Store();
    store.say("Not saved: timeout", true);
    vi.advanceTimersByTime(TOAST_MS * 2);
    expect(store.state.toast.shown).toBe(true);
    store.dismiss();
    expect(store.state.toast.shown).toBe(false);
  });
});

describe("errorText", () => {
  const device = { connected: false, lastError: "no RYUO IV hidraw found" };

  it("is ryuod's failure first, then the cooler's last error while it is not connected", () => {
    expect(errorText({ unreachable: "Failed to fetch", device: null })).toBe("Failed to fetch");
    expect(errorText({ unreachable: null, device })).toBe("no RYUO IV hidraw found");
    expect(errorText({ unreachable: null, device: { ...device, connected: true } })).toBe("");
  });
});
