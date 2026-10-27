/**
 * Slot selects: the debounced POST /api/overlay, duplicate and clip rules, custom
 * "Fan Speed" labels, Memory Frequency hiding, and the show-stats toggle.
 */
import { describe, expect, it } from "vitest";

import { $, choose, makeDaemon, openPage, option, preview, slot, slotSelects, tick } from "./harness-lit.js";

describe("changing a slot", () => {
  it("sends one POST /api/overlay 300 ms after the last change, with the full overlay", async () => {
    const d = await openPage();
    choose(slot(4), "GPU Load");
    await tick(200);
    choose(slot(5), "Fan Speed Net Up KB/s");
    await tick(299);
    expect(d.posts("/api/overlay")).toEqual([]);
    await tick(1);
    expect(d.posts("/api/overlay")).toEqual([{
      items: ["CPU Temperature", "GPU Temperature", "Fan Speed Disk R MB/s", "Date&Time", "GPU Load", "Fan Speed Net Up KB/s"],
      statsVisible: true,
      titleColor: "#E5252B",
      contentColor: "#FFFFFF",
      filter: { on: false, opacity: 100 },
    }]);
    expect($("result").textContent).toBe("2 overlay changes — cooler confirmed");
  });

  it("sends an emptied slot as an empty string", async () => {
    const d = await openPage();
    choose(slot(0), "");
    await tick(300);
    expect(d.posts("/api/overlay")[0].items).toEqual(["", "GPU Temperature", "Fan Speed Disk R MB/s", "Date&Time", "", ""]);
    expect(preview(1).hidden).toBe(true);
  });

  it("disables an item in every other slot once one slot uses it", async () => {
    await openPage();
    for (const i of [1, 2, 3, 4, 5]) expect(option(slot(i), "CPU Temperature").disabled).toBe(true);
    expect(option(slot(0), "CPU Temperature").disabled).toBe(false);
    expect(option(slot(4), "GPU Load").disabled).toBe(false);

    choose(slot(4), "GPU Load");
    expect(option(slot(5), "GPU Load").disabled).toBe(true);
    expect(option(slot(4), "GPU Load").disabled).toBe(false);

    choose(slot(0), "CPU Load");
    expect(option(slot(5), "CPU Temperature").disabled).toBe(false);
    expect(option(slot(5), "CPU Load").disabled).toBe(true);
  });

  it("updates the preview at once, before the POST", async () => {
    const d = await openPage();
    choose(slot(4), "GPU Load");
    expect(preview(5).hidden).toBe(false);
    expect(preview(5).title).toBe("GPU");
    expect(d.posts("/api/overlay")).toEqual([]);
  });

  it("keeps the edit after the POST answers with the saved config", async () => {
    const d = await openPage();
    choose(slot(4), "GPU Load");
    await tick(300);
    await tick(1000);
    expect(slot(4).value).toBe("GPU Load");
    expect(d.config.items[4]).toBe("GPU Load");
  });

  it("says the change waits for reconnect when the cooler is not connected", async () => {
    await openPage(makeDaemon({ device: { connected: false } }));
    choose(slot(4), "GPU Load");
    await tick(300);
    expect($("result").textContent).toBe("Slot 5: GPU Load saved; applies when the cooler reconnects");
  });
});

describe("clipping", () => {
  // The page trusts the catalog's clipsIn (ryuod.clips_in, measured on the panel font).
  it("allows a firmware title that clips, marks it, and warns", async () => {
    const d = await openPage();
    const o = option(slot(3), "Memory Utilization");
    expect(o.textContent).toBe("Memory Utilization (title cut off here)");
    expect(o.disabled).toBe(false);
    expect(option(slot(0), "Memory Utilization").textContent).toBe("Memory Utilization");
    expect($("clipWarn").textContent).toBe("");

    choose(slot(3), "Memory Utilization");
    expect($("clipWarn").textContent).toBe(
      "Title runs past the panel's right edge: slot 4 (Memory Utilization). Slots 1, 2 and 6 have room for it.",
    );
    await tick(300);
    expect(d.posts("/api/overlay")[0].items[3]).toBe("Memory Utilization");

    choose(slot(3), "");
    expect($("clipWarn").textContent).toBe("");
  });

  it("lists every clipping slot in the warning", async () => {
    await openPage(makeDaemon({ config: { items: ["", "", "Hard Disk Temperature", "Memory Utilization", "", ""] } }));
    expect($("clipWarn").textContent).toBe(
      "Title runs past the panel's right edge: slot 3 (Hard Disk Temperature), slot 4 (Memory Utilization). Slots 1, 2 and 6 have room for it.",
    );
  });

  it("disables a custom label in the slots where it clips, since the daemon refuses it there", async () => {
    await openPage();
    for (const i of [2, 3, 4]) {
      const o = option(slot(i), "Fan Speed Pump Header");
      expect(o.textContent).toBe("Fan Speed Pump Header (too wide for this slot)");
      expect(o.disabled).toBe(true);
    }
    for (const i of [0, 1, 5]) {
      const o = option(slot(i), "Fan Speed Pump Header");
      expect(o.textContent).toBe("Fan Speed Pump Header");
      expect(o.disabled).toBe(false);
    }
  });

  it("keeps a clipping custom label selectable in the slot that already holds it, and warns", async () => {
    await openPage(makeDaemon({ config: { items: ["", "", "Fan Speed Pump Header", "", "", ""] } }));
    expect(slot(2).value).toBe("Fan Speed Pump Header");
    expect(option(slot(2), "Fan Speed Pump Header").disabled).toBe(false);
    expect(option(slot(3), "Fan Speed Pump Header").disabled).toBe(true);
    expect($("clipWarn").textContent).toContain("slot 3 (Fan Speed Pump Header)");
  });
});

describe("custom Fan Speed labels", () => {
  it("adds a saved label the catalog does not list as a '(custom label)' option", async () => {
    const d = await openPage(makeDaemon({ config: { items: ["Fan Speed Pump", "", "", "", "", ""] } }));
    const o = option(slot(0), "Fan Speed Pump");
    expect(o.textContent).toBe("Fan Speed Pump (custom label)");
    expect(slot(0).value).toBe("Fan Speed Pump");
    expect(option(slot(1), "Fan Speed Pump")).toBeUndefined();
    // Drawn with the label as title and RPM as unit, like the firmware does.
    expect(preview(1).title).toBe("Pump");
    expect(preview(1).unit).toBe("RPM");

    choose(slot(1), "GPU Load");
    await tick(300);
    expect(d.posts("/api/overlay")[0].items).toEqual(["Fan Speed Pump", "GPU Load", "", "", "", ""]);
  });

  it("drops the custom option once the slot is changed away from it", async () => {
    await openPage(makeDaemon({ config: { items: ["Fan Speed Pump", "", "", "", "", ""] } }));
    choose(slot(0), "CPU Load");
    expect(option(slot(0), "Fan Speed Pump")).toBeUndefined();
  });
});

describe("Memory Frequency", () => {
  it("is hidden from the picker while memory MHz is 0", async () => {
    await openPage();
    expect(option(slot(0), "Memory Frequency")).toBeUndefined();
  });

  it("is offered once memory MHz is set", async () => {
    await openPage(makeDaemon({ config: { memoryMHz: 6000 } }));
    expect(option(slot(0), "Memory Frequency")).toBeDefined();
  });

  it("stays in the slot that holds it while memory MHz is 0", async () => {
    await openPage(makeDaemon({ config: { items: ["Memory Frequency", "", "", "", "", ""] } }));
    expect(slot(0).value).toBe("Memory Frequency");
    expect(option(slot(1), "Memory Frequency")).toBeUndefined();
  });
});

describe("show stats toggle", () => {
  function toggleStats() {
    $("statsOn").click(); // fires input, which the page listens for
  }

  it("unchecking sends statsVisible:false with the kept items, disables the slots and hides the preview", async () => {
    const d = await openPage();
    toggleStats();
    expect($("statsOn").checked).toBe(false);
    expect(slotSelects().every((s) => s.disabled)).toBe(true);
    for (let n = 1; n <= 6; n++) expect(preview(n).hidden).toBe(true);

    await tick(300);
    const posts = d.posts("/api/overlay");
    expect(posts).toHaveLength(1);
    expect(posts[0].statsVisible).toBe(false);
    expect(posts[0].items).toEqual(["CPU Temperature", "GPU Temperature", "Fan Speed Disk R MB/s", "Date&Time", "", ""]);
  });

  it("keeps the preview hidden while stats keep arriving", async () => {
    await openPage();
    toggleStats();
    await tick(3000);
    for (let n = 1; n <= 6; n++) expect(preview(n).hidden).toBe(true);
  });

  it("re-checking restores the slots and the preview and sends statsVisible:true", async () => {
    const d = await openPage();
    toggleStats();
    await tick(300);
    toggleStats();
    expect(slotSelects().every((s) => !s.disabled)).toBe(true);
    expect([1, 2, 3, 4].map((n) => preview(n).hidden)).toEqual([false, false, false, false]);
    expect([5, 6].map((n) => preview(n).hidden)).toEqual([true, true]);
    await tick(300);
    const posts = d.posts("/api/overlay");
    expect(posts).toHaveLength(2);
    expect(posts[1].statsVisible).toBe(true);
    expect(posts[1].items).toEqual(posts[0].items);
  });

  it("off and on within 300 ms sends a single POST with the final state", async () => {
    const d = await openPage();
    toggleStats();
    await tick(100);
    toggleStats();
    await tick(300);
    expect(d.posts("/api/overlay").map((b) => b.statsVisible)).toEqual([true]);
  });

  it("keeps the slots disabled across a catalog refresh", async () => {
    await openPage();
    toggleStats();
    await tick(15000);
    expect(slotSelects().every((s) => s.disabled)).toBe(true);
  });
});
