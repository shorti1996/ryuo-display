// @vitest-environment node
/**
 * The editing guard and the poll's merge rule in the store (state.ts), past what
 * state.test.ts covers: holds that are released more often than taken, and the cases that
 * decide whether comparing with ryuod's last value can hide a change ryuod made.
 */
import { describe, expect, it } from "vitest";

import type { Config } from "../src/api-types.ts";
import { Store } from "../src/state.ts";

const config = (change: Partial<Config> = {}): Config => ({
  media: ["RYUO_IV_HW_Info_04.mp4"],
  playMode: "Single",
  ratio: "2:1",
  items: ["CPU Temperature", "", "", "", "", ""],
  statsVisible: true,
  titleColor: "#E5252B",
  contentColor: "#FFFFFF",
  filter: { on: false, opacity: 100 },
  brightness: 100,
  brightnessPercent: 100,
  tempUnit: "Celsius",
  memoryMHz: 0,
  sensors: { motherboard: "auto" },
  secondDisplay: false,
  ...change,
});

describe("editing holds", () => {
  it("are counted per key: releasing one key leaves another held", () => {
    const store = new Store();
    store.edit("tempUnit", true);
    store.edit("memoryMHz", true);
    store.edit("tempUnit", false);
    expect([...store.state.editing]).toEqual(["memoryMHz"]);
  });

  it("do not go below zero: a release with no hold does not cancel the next hold", () => {
    // A blur without a focus before it (the element was focused before the page loaded).
    const store = new Store();
    store.edit("tray.leftClick", false);
    store.edit("tray.leftClick", false);
    store.edit("tray.leftClick", true);
    expect(store.state.editing.has("tray.leftClick")).toBe(true);
    store.edit("tray.leftClick", false);
    expect(store.state.editing.has("tray.leftClick")).toBe(false);
  });
});

describe("the poll's merge", () => {
  it("brings a change ryuod made while the key was held, once the hold ends", () => {
    const store = new Store();
    store.merge("config", config());
    store.edit("brightness", true);
    expect(store.merge("config", config({ brightness: 40 }))).toEqual([]);
    expect(store.state.config?.brightness).toBe(100);
    store.edit("brightness", false);
    expect(store.merge("config", config({ brightness: 40 }))).toEqual(["brightness"]);
    expect(store.state.config?.brightness).toBe(40);
  });

  it("keeps the user's value after a failed save, until another client changes the key", () => {
    // sync.test.js, "is not re-applied over the page's own failed edit": the POST failed, so
    // ryuod still has 100 and the page keeps 60 to send again with the next edit.
    const store = new Store();
    store.merge("config", config());
    store.patch({ config: config({ brightness: 60 }) });
    expect(store.merge("config", config())).toEqual([]);
    expect(store.state.config?.brightness).toBe(60);
    // ryuod's value moved, so it is news, and it replaces the unsaved 60.
    expect(store.merge("config", config({ brightness: 20 }))).toEqual(["brightness"]);
    expect(store.state.config?.brightness).toBe(20);
  });

  it("brings another client's change even when it equals the user's unsaved value", () => {
    const store = new Store();
    store.merge("config", config());
    store.patch({ config: config({ tempUnit: "Fahrenheit" }) }); // its POST failed
    expect(store.merge("config", config({ tempUnit: "Fahrenheit" }))).toEqual(["tempUnit"]);
    // ryuod has Fahrenheit now, and a later change back to Celsius arrives as well.
    expect(store.merge("config", config())).toEqual(["tempUnit"]);
    expect(store.state.config?.tempUnit).toBe("Celsius");
  });

  it("compares per key: another key's change does not drop an unsaved edit", () => {
    // The old page compared per group (GROUP_FIELDS), so a change to tempUnit from another
    // client also put back memoryMHz; the store copies only the key that changed.
    const store = new Store();
    store.merge("config", config());
    store.patch({ config: config({ memoryMHz: 6000 }) });
    expect(store.merge("config", config({ tempUnit: "Fahrenheit" }))).toEqual(["tempUnit"]);
    expect(store.state.config?.memoryMHz).toBe(6000);
  });

  it("takes a section whole again after a reply that lacked it", () => {
    const store = new Store();
    store.merge("config", config());
    store.patch({ config: config({ brightness: 60 }) });
    store.merge("config", null);
    expect(store.merge("config", config())).toEqual(Object.keys(config()));
    expect(store.state.config?.brightness).toBe(100);
  });
});
