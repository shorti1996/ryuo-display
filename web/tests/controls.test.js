/**
 * Colour, filter and opacity inputs (debounced into POST /api/overlay) and the brightness
 * slider (debounced into POST /api/brightness).
 */
import { describe, expect, it } from "vitest";

import { $, choose, makeDaemon, openPage, setInput, slot, tick } from "./harness.js";

describe("overlay colours and filter", () => {
  it("collects colour, filter and opacity edits into one POST 300 ms after the last", async () => {
    const d = await openPage();
    setInput($("titleColor"), "#00ff00");
    await tick(100);
    $("filterOn").click();
    await tick(100);
    setInput($("opacity"), "35");
    await tick(100);
    setInput($("contentColor"), "#123abc");
    await tick(299);
    expect(d.posts("/api/overlay")).toEqual([]);
    await tick(1);
    expect(d.posts("/api/overlay")).toEqual([{
      items: ["CPU Temperature", "GPU Temperature", "Fan Speed Disk R MB/s", "Date&Time", "", ""],
      statsVisible: true,
      titleColor: "#00FF00",
      contentColor: "#123ABC",
      filter: { on: true, opacity: 35 },
    }]);
  });

  it("merges a slot change and a colour change made inside one debounce window", async () => {
    const d = await openPage();
    choose(slot(4), "GPU Load");
    await tick(150);
    setInput($("titleColor"), "#0000ff");
    await tick(300);
    const posts = d.posts("/api/overlay");
    expect(posts).toHaveLength(1);
    expect(posts[0].items[4]).toBe("GPU Load");
    expect(posts[0].titleColor).toBe("#0000FF");
  });

  it("updates the hex labels, the opacity readout and the slider's enabled state at once", async () => {
    await openPage();
    setInput($("titleColor"), "#a1b2c3");
    expect($("titleHex").textContent).toBe("#A1B2C3");
    setInput($("contentColor"), "#0f0f0f");
    expect($("contentHex").textContent).toBe("#0F0F0F");
    expect($("opacity").disabled).toBe(true);
    $("filterOn").click();
    expect($("opacity").disabled).toBe(false);
    setInput($("opacity"), "42");
    expect($("opacityOut").textContent).toBe("42 %");
  });

  it("sends a colour loaded as #AARRGGBB back as #RRGGBB", async () => {
    const d = await openPage(makeDaemon({ config: { titleColor: "#80E5252B" } }));
    setInput($("opacity"), "50");
    await tick(300);
    expect(d.posts("/api/overlay")[0].titleColor).toBe("#E5252B");
  });

  it("posts JSON with Content-Type application/json, as the daemon requires", async () => {
    const d = await openPage();
    setInput($("titleColor"), "#00ff00");
    await tick(300);
    const post = d.fetch.mock.calls.find(([url]) => url === "/api/overlay");
    expect(post[1].method).toBe("POST");
    expect(post[1].headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(post[1].body).titleColor).toBe("#00FF00");
  });
});

describe("brightness in % (ryuod with config.brightnessPercent)", () => {
  it("shows config.brightnessPercent on a 0–100 slider", async () => {
    await openPage(makeDaemon({ config: { brightness: 90 } }));
    expect([$("brightness").min, $("brightness").max]).toEqual(["0", "100"]);
    expect($("brightness").value).toBe("88");
    expect($("brightOut").textContent).toBe("88 %");
    expect($("brightness").getAttribute("aria-valuetext")).toBe("88 %");
    expect($("brightness").title).toBe("88 % of the full backlight");
  });

  it("sends one POST /api/brightness {percent} 150 ms after the slider stops", async () => {
    const d = await openPage();
    setInput($("brightness"), "60");
    await tick(100);
    setInput($("brightness"), "70");
    await tick(149);
    expect(d.posts("/api/brightness")).toEqual([]);
    await tick(1);
    expect(d.posts("/api/brightness")).toEqual([{ percent: 70 }]);
    expect(d.posts("/api/overlay")).toEqual([]);
    expect(d.config.brightness).toBe(71);
    // 70 % is device value 71, which lights 177/255 = 69 %.
    expect($("result").textContent).toBe("Brightness 69 % — cooler confirmed");
    expect($("toast").title).toBe("Sent: POST brightness");
  });

  it("moves the slider to the % the device scale gives, once it has settled", async () => {
    // 17 % is device value 17, which lights 42/255 = 16 %.
    const d = await openPage();
    setInput($("brightness"), "17");
    await tick(150);
    expect(d.posts("/api/brightness")).toEqual([{ percent: 17 }]);
    expect($("brightness").value).toBe("16");
    expect($("brightOut").textContent).toBe("16 %");
    // The next poll agrees and changes nothing.
    await tick(1000);
    expect($("brightness").value).toBe("16");
  });
});

describe("brightness on the device scale (older ryuod)", () => {
  const legacy = (config) => makeDaemon({ legacy: true, config });

  it.each([
    [0, "0 %", "0/255"],
    [1, "1 %", "2/255"],
    [41, "40 %", "102/255"],
    [90, "88 %", "225/255"],
    [100, "98 %", "250/255"],
    [101, "99 %", "252/255"],
    [102, "100 %", "255/255"],
  ])("labels %i as the share of the backlight's 255 levels, floor(value × 2.5)", async (value, label, level) => {
    await openPage(legacy());
    setInput($("brightness"), String(value));
    expect($("brightOut").textContent).toBe(label);
    expect($("brightness").getAttribute("aria-valuetext")).toBe(label);
    expect($("brightness").title).toBe(`${value} of 102 on the device scale, backlight ${level}`);
  });

  it("keeps the 0–102 range of the device scale, so every device step stays reachable", async () => {
    await openPage(legacy());
    expect([$("brightness").min, $("brightness").max]).toEqual(["0", "102"]);
    setInput($("brightness"), "200");
    expect($("brightOut").textContent).toBe("100 %");
  });

  it("sends one POST /api/brightness {value} 150 ms after the slider stops", async () => {
    const d = await openPage(legacy());
    setInput($("brightness"), "60");
    await tick(100);
    setInput($("brightness"), "70");
    await tick(150);
    expect(d.posts("/api/brightness")).toEqual([{ value: 70 }]);
    expect($("result").textContent).toBe("Brightness 69 % — cooler confirmed");
  });
});
