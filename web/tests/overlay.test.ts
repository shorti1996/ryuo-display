// @vitest-environment node
/**
 * The overlay's pure parts (overlay.ts): each slot's options, the clipping note, the preview's
 * cells and the POST body. The catalog is a few entries shaped like ryuod.Sampler.catalog().
 */
import { describe, expect, it } from "vitest";

import type { CatalogItem, Config } from "../src/api-types.ts";
import { clipWarning, overlayBody, rgbHex, slotCell, slotChoices, titleFor } from "../src/overlay.ts";

function entry(
  item: string,
  title: string,
  group: CatalogItem["group"],
  change: Partial<CatalogItem> = {},
): CatalogItem {
  return { item, title, unit: "%", group, available: true, source: "fake", note: null, clipsIn: [], ...change };
}

const CATALOG: CatalogItem[] = [
  entry("CPU Load", "CPU", "CPU"),
  entry("CPU Temperature", "CPU", "CPU", { unit: "°C" }),
  entry("CPU Voltage", "CPU", "CPU", { available: false }),
  entry("GPU Load", "GPU", "GPU"),
  entry("GPU Usage", "GPU", "GPU", { note: "same value as GPU Load" }),
  entry("GPU Power", "GPU", "GPU", { unit: "°C" }),
  entry("Memory Frequency", "Memory Frequency", "Memory", { unit: "MHZ", clipsIn: [4] }),
  entry("Hard Disk Temperature", "Hard Disk Temperature", "Storage", { unit: "°C", clipsIn: [3, 4, 5] }),
  entry("Date&Time", "", "Clock", { unit: "ss" }),
  entry("Fan Speed Pump Header", "Pump Header", "Custom", { unit: "RPM", clipsIn: [3, 4, 5] }),
];
const EMPTY = ["", "", "", "", "", ""];
// 2026-10-22 was a Thursday.
const NOW = new Date(2026, 9, 22, 14, 5, 9);

const options = (choices: ReturnType<typeof slotChoices>) => choices.groups.flatMap((group) => group.options);
const find = (choices: ReturnType<typeof slotChoices>, item: string) =>
  options(choices).find((option) => option.value === item);

describe("slotChoices", () => {
  it("groups the catalog in the firmware's order and leaves out empty groups", () => {
    const choices = slotChoices(CATALOG, EMPTY, 0, 6000);
    expect(choices.groups.map((group) => group.label)).toEqual([
      "CPU",
      "GPU",
      "Memory",
      "Storage",
      "Clock",
      "Custom (unit RPM)",
    ]);
    expect(choices.unknown).toBeNull();
  });

  it("marks GPU Usage, GPU Power and an item with no source", () => {
    const choices = slotChoices(CATALOG, EMPTY, 0, 0);
    expect(find(choices, "GPU Usage")?.text).toBe("GPU Usage (same as GPU Load)");
    expect(find(choices, "GPU Power")?.text).toBe("GPU Power (drawn with °C unit)");
    expect(find(choices, "CPU Voltage")?.text).toBe("CPU Voltage (no source)");
    expect(find(choices, "CPU Voltage")?.disabled).toBe(false);
  });

  it("disables an item another slot uses, but not in the slot that holds it", () => {
    const items = ["CPU Load", "", "", "", "", ""];
    expect(find(slotChoices(CATALOG, items, 1, 0), "CPU Load")?.disabled).toBe(true);
    expect(find(slotChoices(CATALOG, items, 0, 0), "CPU Load")?.disabled).toBe(false);
  });

  it("allows a firmware title that clips and marks it", () => {
    const option = find(slotChoices(CATALOG, EMPTY, 2, 0), "Hard Disk Temperature");
    expect(option).toEqual({
      value: "Hard Disk Temperature",
      text: "Hard Disk Temperature (title cut off here)",
      disabled: false,
    });
    expect(find(slotChoices(CATALOG, EMPTY, 0, 0), "Hard Disk Temperature")?.text).toBe("Hard Disk Temperature");
  });

  it("disables a custom label where it clips, unless the slot already holds it", () => {
    expect(find(slotChoices(CATALOG, EMPTY, 3, 0), "Fan Speed Pump Header")).toEqual({
      value: "Fan Speed Pump Header",
      text: "Fan Speed Pump Header (too wide for this slot)",
      disabled: true,
    });
    const items = ["", "", "", "Fan Speed Pump Header", "", ""];
    expect(find(slotChoices(CATALOG, items, 3, 0), "Fan Speed Pump Header")?.disabled).toBe(false);
    expect(find(slotChoices(CATALOG, EMPTY, 5, 0), "Fan Speed Pump Header")?.disabled).toBe(false);
  });

  it("leaves out Memory Frequency while memory MHz is 0, except in the slot that holds it", () => {
    expect(find(slotChoices(CATALOG, EMPTY, 0, 0), "Memory Frequency")).toBeUndefined();
    expect(find(slotChoices(CATALOG, EMPTY, 0, 6000), "Memory Frequency")).toBeDefined();
    const items = ["Memory Frequency", "", "", "", "", ""];
    expect(find(slotChoices(CATALOG, items, 0, 0), "Memory Frequency")).toBeDefined();
    expect(find(slotChoices(CATALOG, items, 1, 0), "Memory Frequency")).toBeUndefined();
  });

  it("offers a saved item the catalog does not list as a custom label", () => {
    const choices = slotChoices(CATALOG, ["Fan Speed Pump", "", "", "", "", ""], 0, 0);
    expect(choices.unknown).toEqual({
      value: "Fan Speed Pump",
      text: "Fan Speed Pump (custom label)",
      disabled: false,
    });
    expect(slotChoices(CATALOG, ["Fan Speed Pump", "", "", "", "", ""], 1, 0).unknown).toBeNull();
  });

  it("lists every saved item as a custom label while the catalog is empty", () => {
    const choices = slotChoices([], ["CPU Load", "", "", "", "", ""], 0, 0);
    expect(choices.groups).toEqual([]);
    expect(choices.unknown?.text).toBe("CPU Load (custom label)");
  });
});

describe("clipWarning", () => {
  it("is empty when no slot's title clips", () => {
    expect(clipWarning(CATALOG, ["Hard Disk Temperature", "", "", "", "", ""])).toBe("");
  });

  it("names every slot whose title clips", () => {
    expect(clipWarning(CATALOG, ["", "", "Hard Disk Temperature", "Memory Frequency", "", ""])).toBe(
      "Title runs past the panel's right edge: slot 3 (Hard Disk Temperature), slot 4 (Memory Frequency). Slots 1, 2 and 6 have room for it.",
    );
  });
});

describe("the preview's cells", () => {
  it("titles an item from the catalog, a custom label by its label, and Date&Time by the day", () => {
    expect(titleFor("Hard Disk Temperature", CATALOG, NOW)).toBe("Hard Disk Temperature");
    expect(titleFor("Fan Speed Pump", CATALOG, NOW)).toBe("Pump");
    expect(titleFor("Date&Time", CATALOG, NOW)).toBe("THU 22");
    expect(titleFor("Not In The Catalog", CATALOG, NOW)).toBe("");
  });

  it("draws the sample's panel text and unit", () => {
    const values = { "CPU Temperature": { value: 50.4, unit: "°C", available: true, panel: "50" } };
    expect(slotCell("CPU Temperature", CATALOG, values, NOW)).toEqual({ title: "CPU", value: "50", unit: "°C" });
  });

  it("draws 0 for an item the sample lacks, with RPM for a custom label", () => {
    expect(slotCell("CPU Load", CATALOG, {}, NOW)).toEqual({ title: "CPU", value: "0", unit: "" });
    expect(slotCell("Fan Speed Pump", CATALOG, {}, NOW)).toEqual({ title: "Pump", value: "0", unit: "RPM" });
  });

  it("draws Date&Time from the clock, HH:MM over the seconds", () => {
    expect(slotCell("Date&Time", CATALOG, {}, NOW)).toEqual({ title: "THU 22", value: "14:05", unit: "09" });
  });
});

describe("colours and the POST body", () => {
  it("drops the alpha of #AARRGGBB, as <input type=color> does", () => {
    expect(rgbHex("#80E5252B")).toBe("#E5252B");
    expect(rgbHex("#e5252b")).toBe("#e5252b");
  });

  it("sends every overlay field, colours as #RRGGBB in capitals", () => {
    const config = {
      items: ["CPU Load", "", "", "", "", ""],
      statsVisible: true,
      titleColor: "#80e5252b",
      contentColor: "#ffffff",
      filter: { on: true, opacity: 35 },
    } as Config;
    expect(overlayBody(config)).toEqual({
      items: ["CPU Load", "", "", "", "", ""],
      statsVisible: true,
      titleColor: "#E5252B",
      contentColor: "#FFFFFF",
      filter: { on: true, opacity: 35 },
    });
  });
});
