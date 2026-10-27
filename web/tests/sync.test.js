/**
 * Changes made by another client (a second tab, the tray): the state poll applies them to the
 * controls, group by group, but not to a group the user is editing (an edit in its debounce or
 * POST, a focused select or number field, a range under a drag).
 */
import { describe, expect, it } from "vitest";

import { $, CUSTOM, choose, openPage, preview, setInput, slot, tick } from "./harness.js";

const box = (name) => [...document.querySelectorAll(".tile input[type=checkbox]")].find((b) => b.value === name);
const badge = (name) => {
  const b = [...document.querySelectorAll(".tile")].find((t) => t.dataset.name === name).querySelector(".badge");
  return b.hidden ? "" : b.textContent;
};

describe("another client's change", () => {
  it("reaches the playlist, play mode, live chip and badges on the next poll", async () => {
    const d = await openPage();
    d.config.media = [CUSTOM[1]];
    d.config.playMode = "Cycle";
    await tick(1000);
    expect(box(CUSTOM[1]).checked).toBe(true);
    expect(box("RYUO_IV_HW_Info_04.mp4").checked).toBe(false);
    expect($("playMode").value).toBe("Cycle");
    expect($("liveText").textContent).toBe(`Live · ${CUSTOM[1]}`);
    expect(badge(CUSTOM[1])).toBe("On panel");
    expect(badge("RYUO_IV_HW_Info_04.mp4")).toBe("");
    expect($("heroImage").getAttribute("src")).toBe(`/api/media/preview?name=${encodeURIComponent(CUSTOM[1])}`);
  });

  it("reaches brightness, slots, colours, filter and units", async () => {
    const d = await openPage();
    Object.assign(d.config, {
      brightness: 35, items: ["GPU Load", "", "", "", "", ""], titleColor: "#00FF00", filter: { on: true, opacity: 40 },
      tempUnit: "Fahrenheit", memoryMHz: 6000,
    });
    await tick(1000);
    expect($("brightness").value).toBe("34");  // 35 on the device scale, in %
    expect($("brightOut").textContent).toBe("34 %");
    expect(slot(0).value).toBe("GPU Load");
    expect(preview(1).title).toBe("GPU");
    expect(preview(2).hidden).toBe(true);
    expect($("titleColor").value).toBe("#00ff00");
    expect($("titleHex").textContent).toBe("#00FF00");
    expect($("filterOn").checked).toBe(true);
    expect($("opacityOut").textContent).toBe("40 %");
    expect(document.querySelector("input[name=unit]:checked").value).toBe("Fahrenheit");
    expect($("memMHz").value).toBe("6000");
    // The units come back with the catalog, which is fetched again.
    expect(d.gets("/api/catalog")).toHaveLength(2);
  });

  it("sends nothing back", async () => {
    const d = await openPage();
    d.config.brightness = 35;
    d.config.media = [CUSTOM[0]];
    await tick(3000);
    expect(d.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("is not re-applied over the page's own failed edit", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/brightness", { status: 504, body: { ok: false, error: "device worker did not answer within 3 s" } });
    setInput($("brightness"), "60");
    await tick(2000);
    // The daemon still has 100, as when the page last saw it; the user's 60 stays to be resent.
    expect($("brightness").value).toBe("60");
  });
});

describe("a group the user is editing keeps the user's values", () => {
  it("a playlist tick waiting in its debounce wins over a poll", async () => {
    const d = await openPage();
    await tick(800);
    box(CUSTOM[0]).click();         // posts at 1200 ms
    d.config.playMode = "Random";   // another client, seen by the poll at 1000 ms
    await tick(300);
    expect(box(CUSTOM[0]).checked).toBe(true);
    expect($("playMode").value).toBe("Single");
    await tick(100);
    expect(d.posts("/api/media/select")).toEqual([{ media: [CUSTOM[0], "RYUO_IV_HW_Info_04.mp4"], playMode: "Single" }]);
  });

  it("a focused slot select is left alone until it loses focus", async () => {
    const d = await openPage();
    slot(4).focus();
    d.config.items = ["GPU Load", "", "", "", "", ""];
    await tick(1000);
    expect(slot(0).value).toBe("CPU Temperature");
    slot(4).blur();
    await tick(1000);
    expect(slot(0).value).toBe("GPU Load");
  });

  it("a brightness drag is left alone until the pointer is released", async () => {
    const d = await openPage();
    $("brightness").dispatchEvent(new Event("pointerdown"));
    d.config.brightness = 20;
    await tick(1000);
    expect($("brightness").value).toBe("98");
    window.dispatchEvent(new Event("pointerup"));
    await tick(1000);
    expect($("brightness").value).toBe("20");
  });

  it("a focused memory MHz field is left alone", async () => {
    const d = await openPage();
    $("memMHz").focus();
    $("memMHz").value = "64";       // typing, no change event yet
    d.config.memoryMHz = 3200;
    await tick(1000);
    expect($("memMHz").value).toBe("64");
  });

  it("a slot change in its debounce wins, and the POST answer is not undone by the next poll", async () => {
    const d = await openPage();
    await tick(900);
    choose(slot(4), "GPU Load");    // posts at 1200 ms
    d.config.titleColor = "#00FF00";
    await tick(1100);
    expect(slot(4).value).toBe("GPU Load");
    // The page's POST carried its own title colour, so the daemon has that one now.
    expect(d.config.titleColor).toBe("#E5252B");
    expect($("titleColor").value).toBe("#e5252b");
  });
});
