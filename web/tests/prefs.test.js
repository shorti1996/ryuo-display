/**
 * Units: °C/°F and memory MHz go to POST /api/prefs. A prefs reply carries the whole config,
 * and the page must take only the fields prefs owns from it.
 */
import { describe, expect, it } from "vitest";

import { $, choose, makeDaemon, openPage, option, preview, setInput, slot, tick } from "./harness.js";

const unitRadio = (v) => document.querySelector(`input[name=unit][value=${v}]`);

describe("temperature unit", () => {
  it("posts the new unit, reports the send and reloads the catalog", async () => {
    const d = await openPage();
    unitRadio("Fahrenheit").click();
    await tick(0);
    expect(d.posts("/api/prefs")).toEqual([{ tempUnit: "Fahrenheit" }]);
    expect($("result").textContent).toBe("Units: POST temperature — acked by the cooler");
    expect(d.gets("/api/catalog")).toHaveLength(2);
    expect(unitRadio("Fahrenheit").checked).toBe(true);
    expect(unitRadio("Celsius").checked).toBe(false);
  });

  it("shows °F in the preview from the next stats poll", async () => {
    const d = await openPage();
    expect(preview(1).unit).toBe("°C");
    unitRadio("Fahrenheit").click();
    d.stats["CPU Temperature"] = { value: 122.7, panel: "122" };
    await tick(1000);
    expect(preview(1).value).toBe("122");
    expect(preview(1).unit).toBe("°F");
  });

  it("shows the daemon's error when the unit change fails", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/prefs", { status: 504, body: { ok: false, error: "device worker did not answer within 3 s" } });
    unitRadio("Fahrenheit").click();
    await tick(0);
    expect($("result").textContent).toBe("Units: device worker did not answer within 3 s");
    // The radio keeps the user's click; the config still says Celsius.
    expect(unitRadio("Fahrenheit").checked).toBe(true);
  });
});

describe("memory MHz", () => {
  it("posts an integer on change and offers Memory Frequency afterwards", async () => {
    const d = await openPage();
    expect(option(slot(0), "Memory Frequency")).toBeUndefined();
    $("memMHz").value = "6400";
    $("memMHz").dispatchEvent(new Event("change"));
    await tick(0);
    expect(d.posts("/api/prefs")).toEqual([{ memoryMHz: 6400 }]);
    expect($("memMHz").value).toBe("6400");
    expect(option(slot(0), "Memory Frequency")).toBeDefined();
  });

  it("sends nothing for an empty field", async () => {
    const d = await openPage();
    $("memMHz").value = "";
    $("memMHz").dispatchEvent(new Event("change"));
    await tick(0);
    expect(d.posts("/api/prefs")).toEqual([]);
  });

  it("shows the daemon's range error", async () => {
    await openPage();
    $("memMHz").value = "25000";
    $("memMHz").dispatchEvent(new Event("change"));
    await tick(0);
    expect($("result").textContent).toBe("Units: memoryMHz must be an integer 0-20000");
    expect($("result").style.color).toBe("var(--bad)");
  });

  it("does not claim a send when the daemon sent nothing", async () => {
    await openPage();
    $("memMHz").value = "6400";
    $("memMHz").dispatchEvent(new Event("change"));
    await tick(0);
    expect($("result").textContent).toContain("nothing sent");
    expect($("result").textContent).not.toContain("sent, no ack");
  });
});

describe("prefs reply does not overwrite a pending overlay edit", () => {
  // Regression: sendPrefs used to call applyConfig(j.config). The prefs reply's items and
  // colours predate an edit still waiting in the 300 ms overlay debounce, so it reverted it.
  it("keeps a slot change made just before switching unit", async () => {
    const d = await openPage();
    choose(slot(4), "GPU Load");
    unitRadio("Fahrenheit").click();
    await tick(0);
    expect(d.posts("/api/prefs")).toHaveLength(1);
    expect(d.posts("/api/overlay")).toHaveLength(0);
    expect(slot(4).value).toBe("GPU Load");
    expect(preview(5).hidden).toBe(false);

    await tick(300);
    expect(d.posts("/api/overlay")).toHaveLength(1);
    expect(d.posts("/api/overlay")[0].items[4]).toBe("GPU Load");
  });

  it("keeps a colour change made just before editing memory MHz", async () => {
    const d = await openPage();
    setInput($("titleColor"), "#00ff00");
    $("memMHz").value = "6000";
    $("memMHz").dispatchEvent(new Event("change"));
    await tick(0);
    expect($("titleColor").value).toBe("#00ff00");
    expect($("titleHex").textContent).toBe("#00FF00");
    await tick(300);
    expect(d.posts("/api/overlay")[0].titleColor).toBe("#00FF00");
  });

  it("keeps the show-stats toggle and filter edits too", async () => {
    const d = await openPage();
    $("statsOn").click();
    $("filterOn").click();
    unitRadio("Fahrenheit").click();
    await tick(0);
    expect($("statsOn").checked).toBe(false);
    expect($("filterOn").checked).toBe(true);
    await tick(300);
    const post = d.posts("/api/overlay")[0];
    expect(post.statsVisible).toBe(false);
    expect(post.filter.on).toBe(true);
  });

  it("does not touch brightness or play mode either", async () => {
    const d = await openPage(makeDaemon({ config: { brightness: 50 } }));
    setInput($("brightness"), "90");
    $("playMode").value = "Random";
    unitRadio("Fahrenheit").click();
    await tick(0);
    expect($("brightness").value).toBe("90");
    expect($("playMode").value).toBe("Random");
  });
});
