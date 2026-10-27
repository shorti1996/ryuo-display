/**
 * Panel preview: slot titles from the catalog, values and units from GET /api/stats, the
 * Date&Time slot from the browser clock, the chosen colours and the filter overlay.
 */
import { describe, expect, it } from "vitest";

import { $, choose, makeDaemon, openPage, preview, setInput, slot, tick } from "./harness-lit.js";

describe("preview slots", () => {
  it("draws each chosen item with its panel title, value and unit", async () => {
    await openPage();
    expect(preview(1)).toMatchObject({ hidden: false, title: "CPU", value: "50", unit: "°C" });
    expect(preview(2)).toMatchObject({ hidden: false, title: "GPU", value: "37", unit: "°C" });
    expect(preview(3)).toMatchObject({ hidden: false, title: "Disk R MB/s", value: "12", unit: "RPM" });
    expect(preview(5).hidden).toBe(true);
    expect(preview(6).hidden).toBe(true);
  });

  it("titles long firmware items with the catalog title, not the item string", async () => {
    await openPage(makeDaemon({ config: { items: ["Hard Disk Temperature", "Motherboard Temperature", "", "", "", ""] } }));
    expect(preview(1).title).toBe("Hard Disk Temperature");
    expect(preview(2).title).toBe("Motherboard");
  });

  it("draws Date&Time as weekday and day over HH:MM and seconds", async () => {
    await openPage();
    // NOW in the harness is Thursday 2026-10-22 14:05:09 local time.
    expect(preview(4)).toMatchObject({ title: "THU 22", value: "14:05", unit: "09" });
    await tick(2000);
    expect(preview(4)).toMatchObject({ value: "14:05", unit: "11" });
  });

  it("shows 0 for an item the stats do not cover yet", async () => {
    const d = makeDaemon();
    d.stats = {};
    await openPage(d);
    expect(preview(1)).toMatchObject({ value: "0", unit: "°C" });
  });

  it("shows 0 and RPM for a custom label the daemon has no value for", async () => {
    await openPage(makeDaemon({ config: { items: ["Fan Speed Pump", "", "", "", "", ""] } }));
    expect(preview(1)).toMatchObject({ title: "Pump", value: "0", unit: "RPM" });
  });

  it("uses the daemon's panel text, not the raw value", async () => {
    await openPage(makeDaemon({ stats: { "CPU Temperature": { value: 50.4, panel: "50" } } }));
    expect(preview(1).value).toBe("50");
  });

  it("follows each stats poll and shows when it was sampled", async () => {
    const d = await openPage();
    expect($("sampled").textContent).toMatch(/^sampled /);
    d.stats["GPU Temperature"] = { value: 61, panel: "61" };
    await tick(1000);
    expect(preview(2).value).toBe("61");
  });

  it("leaves the sampled time empty before the first sample", async () => {
    const d = makeDaemon();
    d.sampledAt = null;
    await openPage(d);
    expect($("sampled").textContent).toBe("");
  });

  it("colours titles with the title colour and values and units with the content colour", async () => {
    await openPage();
    const s = preview(1).el;
    expect(s.children[0].style.color).toBe($("titleColor").value);
    expect(s.children[1].style.color).toBe($("contentColor").value);
    expect(s.children[2].style.color).toBe($("contentColor").value);
    setInput($("titleColor"), "#00ff00");
    expect($("titleColor").value).toBe("#00ff00");
    expect(preview(1).el.children[0].style.color).toBe($("titleColor").value);
    expect(preview(1).el.children[1].style.color).not.toBe($("titleColor").value);
  });

  it("moves an item between preview slots when its slot changes", async () => {
    await openPage();
    choose(slot(0), "");
    choose(slot(5), "CPU Temperature");
    expect(preview(1).hidden).toBe(true);
    expect(preview(6)).toMatchObject({ hidden: false, title: "CPU", value: "50" });
  });
});

describe("filter overlay", () => {
  it("is hidden while the filter is off", async () => {
    await openPage();
    expect($("pfilter").style.display).toBe("none");
  });

  it("shows at the configured opacity when on", async () => {
    await openPage(makeDaemon({ config: { filter: { on: true, opacity: 60 } } }));
    expect($("pfilter").style.display).toBe("block");
    expect(Number($("pfilter").style.opacity)).toBeCloseTo(0.6);
  });

  it("follows the checkbox and the slider immediately", async () => {
    await openPage();
    $("filterOn").click();
    expect($("pfilter").style.display).toBe("block");
    expect(Number($("pfilter").style.opacity)).toBe(1);
    setInput($("opacity"), "25");
    expect(Number($("pfilter").style.opacity)).toBeCloseTo(0.25);
    $("filterOn").click();
    expect($("pfilter").style.display).toBe("none");
  });
});
