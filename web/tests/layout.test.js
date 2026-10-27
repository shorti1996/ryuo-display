/**
 * Page structure: the tabs, the hero's live and standby states, the slot rows that outline
 * their slot in the hero, and the result toast.
 */
import { describe, expect, it } from "vitest";

import { $, CUSTOM, makeDaemon, openPage, preview, tick } from "./harness.js";

const TABS = ["overlay", "background", "mirror", "app"];
const selectedTab = () => TABS.filter((t) => $("tab-" + t).getAttribute("aria-selected") === "true");
const shownPanels = () => TABS.filter((t) => !$("tp-" + t).hidden);
const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

describe("tabs", () => {
  it("open on Overlay, with one panel shown and one tab in the tab order", async () => {
    await openPage();
    expect(selectedTab()).toEqual(["overlay"]);
    expect(shownPanels()).toEqual(["overlay"]);
    expect(TABS.map((t) => $("tab-" + t).tabIndex)).toEqual([0, -1, -1, -1]);
    expect(TABS.map((t) => $("tab-" + t).getAttribute("aria-controls"))).toEqual(TABS.map((t) => "tp-" + t));
  });

  it("switch panels on click", async () => {
    await openPage();
    $("tab-background").click();
    expect(selectedTab()).toEqual(["background"]);
    expect(shownPanels()).toEqual(["background"]);
    expect($("tab-background").tabIndex).toBe(0);
    expect($("tab-overlay").tabIndex).toBe(-1);
  });

  it("move with the arrow keys, Home and End, wrapping at the ends", async () => {
    await openPage();
    $("tab-overlay").focus();
    key("ArrowRight");
    expect(selectedTab()).toEqual(["background"]);
    expect(document.activeElement.id).toBe("tab-background");
    key("End");
    expect(selectedTab()).toEqual(["app"]);
    key("ArrowRight");
    expect(selectedTab()).toEqual(["overlay"]);
    key("ArrowLeft");
    expect(selectedTab()).toEqual(["app"]);
    key("Home");
    expect(shownPanels()).toEqual(["overlay"]);
  });

  it("the connection pill opens the App tab", async () => {
    await openPage();
    $("connPill").click();
    expect(selectedTab()).toEqual(["app"]);
    expect(document.activeElement.id).toBe("tab-app");
  });
});

describe("hero", () => {
  it("shows a preset that plays live as a hint, since presets have no browser preview", async () => {
    await openPage();
    expect($("hero").dataset.view).toBe("live");
    expect($("liveChip").hidden).toBe(false);
    expect($("liveDot").className).toBe("dot ok");
    expect($("liveText").textContent).toBe("Live · RYUO_IV_HW_Info_04.mp4");
    expect($("heroHint").textContent).toBe("RYUO_IV_HW_Info_04.mp4 · built-in preset, no browser preview");
    expect($("heroVideo").hasAttribute("src")).toBe(false);
  });

  it("plays a Custom file that plays live behind the overlay", async () => {
    await openPage(makeDaemon({ config: { media: [CUSTOM[0]] } }));
    expect($("heroVideo").getAttribute("src")).toBe(`/api/media/preview?name=${encodeURIComponent(CUSTOM[0])}`);
    expect($("heroHint").textContent).toBe("");
    expect($("previewBar").hidden).toBe(true);
    expect(preview(1).hidden).toBe(false);
  });

  it("does not reload the live video on every state poll", async () => {
    await openPage(makeDaemon({ config: { media: [CUSTOM[0]] } }));
    $("heroVideo").dispatchEvent(new Event("loadeddata"));
    await tick(3000);
    expect($("heroStatus").textContent).toBe("");
  });

  it("says when the cooler is not connected", async () => {
    await openPage(makeDaemon({ device: { connected: false } }));
    expect($("liveDot").className).toBe("dot bad");
    expect($("liveText").textContent).toBe("Cooler not connected · changes apply on reconnect");
  });

  it("goes to standby while ryuod does not answer, and stops the video", async () => {
    const d = await openPage(makeDaemon({ config: { media: [CUSTOM[0]] } }));
    d.down = true;
    await tick(1000);
    expect($("hero").dataset.view).toBe("down");
    expect($("standbyView").hidden).toBe(false);
    expect($("standbyText").textContent).toBe("Failed to fetch");
    expect($("heroVideo").hasAttribute("src")).toBe(false);
    d.down = false;
    await tick(1000);
    expect($("standbyView").hidden).toBe(true);
    expect($("heroVideo").getAttribute("src")).toBe(`/api/media/preview?name=${encodeURIComponent(CUSTOM[0])}`);
  });
});

describe("slot rows", () => {
  const row = (i) => $("slotRow" + i);

  it("number each row and label it with its position", async () => {
    await openPage();
    expect([...document.querySelectorAll(".slot-row .num")].map((n) => n.textContent)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(row(0).querySelector("label").textContent).toBe("Left, upper");
    expect(row(0).querySelector("label").htmlFor).toBe("slot0");
  });

  it("outline their slot in the hero on hover and on focus", async () => {
    await openPage();
    row(1).dispatchEvent(new Event("mouseenter"));
    expect(row(1).classList.contains("hot")).toBe(true);
    expect($("ps2").classList.contains("hot")).toBe(true);
    expect($("ps1").classList.contains("hot")).toBe(false);
    row(1).dispatchEvent(new Event("mouseleave"));
    expect($("ps2").classList.contains("hot")).toBe(false);
    $("slot2").dispatchEvent(new Event("focus"));
    expect($("ps3").classList.contains("hot")).toBe(true);
    $("slot2").dispatchEvent(new Event("blur"));
    expect($("ps3").classList.contains("hot")).toBe(false);
  });

  it("outline an empty slot too, labelled with its number", async () => {
    await openPage();
    row(4).dispatchEvent(new Event("mouseenter"));
    expect(preview(5)).toMatchObject({ hidden: true, title: "Slot 5" });
    expect($("ps5").classList.contains("hot")).toBe(true);
    row(4).dispatchEvent(new Event("mouseleave"));
    expect(preview(5).title).toBe("");
  });
});

describe("result toast", () => {
  it("hides a success after 6 s and keeps its text", async () => {
    const d = await openPage();
    $("refresh").click();
    await tick(0);
    expect($("toast").hidden).toBe(false);
    await tick(6000);
    expect($("toast").hidden).toBe(true);
    expect($("result").textContent).toBe("Media list from conn");
    expect(d.gets("/api/media")).toHaveLength(2);
  });

  it("keeps an error until it is dismissed", async () => {
    const d = await openPage();
    d.replyOnce("GET /api/media", { status: 504, body: { ok: false, error: "timeout" } });
    $("refresh").click();
    await tick(10000);
    expect($("toast").hidden).toBe(false);
    expect($("toast").classList.contains("bad")).toBe(true);
    $("resultClose").click();
    expect($("toast").hidden).toBe(true);
  });
});

describe("Desktop mirror requirements", () => {
  it("lists them and says they are not checked", async () => {
    await openPage();
    const text = $("tp-mirror").textContent;
    for (const r of ["KDE Plasma on Wayland", "krfb installed", "NVIDIA GPU"]) expect(text).toContain(r);
    expect(text).toContain("ryuod does not check these yet");
  });
});

describe("notes kept from the old page", () => {
  it("the Overlay box says off keeps the slot choices", async () => {
    await openPage();
    expect($("statsOnLabel").title).toBe("Stats overlay on the panel. Off hides it and keeps your slot choices.");
  });

  it("the Overlay tab says where the slot geometry and values come from", async () => {
    await openPage();
    expect($("geometryNote").textContent).toBe("Slot geometry from HomeUI's layout; values from the last sample.");
    expect($("tp-overlay").contains($("geometryNote"))).toBe(true);
  });
});
