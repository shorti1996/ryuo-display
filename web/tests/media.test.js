/**
 * Background media: the preset and custom groups from GET /api/media, the checked set from
 * config.media, Refresh, and Play (POST /api/media/select).
 */
import { describe, expect, it } from "vitest";

import { $, CUSTOM, PRESET, makeDaemon, openPage, tick } from "./harness.js";

const boxes = () => [...$("media").querySelectorAll("input[type=checkbox]")];
const box = (name) => boxes().find((b) => b.value === name);
const checked = () => boxes().filter((b) => b.checked).map((b) => b.value);

describe("media list", () => {
  it("shows the preset group, then the custom group, in the daemon's order", async () => {
    await openPage();
    expect([...$("media").querySelectorAll("h3")].map((h) => h.textContent)).toEqual([
      "Preset (on the cooler)", "Custom (/sdcard/pcMedia)",
    ]);
    expect(boxes().map((b) => b.value)).toEqual([...PRESET, ...CUSTOM]);
    // Each name sits in the group under its own heading.
    const kids = [...$("media").children];
    const customHeading = kids.findIndex((k) => k.textContent === "Custom (/sdcard/pcMedia)");
    expect(kids.slice(1, customHeading).map((k) => k.textContent)).toEqual(PRESET);
    expect(kids.slice(customHeading + 1).map((k) => k.textContent)).toEqual(CUSTOM);
  });

  it("checks the files in config.media", async () => {
    await openPage(makeDaemon({ config: { media: ["RYUO_IV_HW_Info_01.mp4", CUSTOM[1]] } }));
    expect(checked()).toEqual(["RYUO_IV_HW_Info_01.mp4", CUSTOM[1]]);
  });

  it("says 'none' for an empty group", async () => {
    await openPage(makeDaemon({ media: { custom: [] } }));
    const notes = [...$("media").querySelectorAll(".note")].map((n) => n.textContent);
    expect(notes).toEqual(["none"]);
    expect(boxes().map((b) => b.value)).toEqual(PRESET);
  });

  it("Refresh asks for ?refresh=1, redraws the list and names the source", async () => {
    const d = await openPage();
    d.mediaLists = { source: "adb", fetchedAt: 1, preset: ["RYUO_IV_HW_Info_04.mp4"], custom: ["new.mp4"] };
    $("refresh").click();
    await tick(0);
    expect(d.gets("/api/media").map((c) => c.query)).toEqual(["", "refresh=1"]);
    expect(boxes().map((b) => b.value)).toEqual(["RYUO_IV_HW_Info_04.mp4", "new.mp4"]);
    expect(checked()).toEqual(["RYUO_IV_HW_Info_04.mp4"]);
    expect($("result").textContent).toBe("Media list from adb");
  });

  it("shows a failed refresh as an error", async () => {
    const d = await openPage();
    d.replyOnce("GET /api/media", { status: 504, body: { ok: false, error: "neither the conn reply nor adb gave a media list" } });
    $("refresh").click();
    await tick(0);
    expect($("result").textContent).toBe("Media list: neither the conn reply nor adb gave a media list");
    expect(boxes().map((b) => b.value)).toEqual([...PRESET, ...CUSTOM]);
  });

  it("shows a successful refresh in the normal colour after an earlier error", async () => {
    const d = await openPage();
    d.replyOnce("GET /api/media", { status: 504, body: { ok: false, error: "timeout" } });
    $("refresh").click();
    await tick(0);
    expect($("result").style.color).toBe("var(--bad)");
    $("refresh").click();
    await tick(0);
    expect($("result").textContent).toBe("Media list from conn");
    expect($("result").style.color).toBe("var(--muted)");
  });
});

describe("Play", () => {
  it("posts the checked files in list order with the play mode", async () => {
    const d = await openPage();
    // Click order differs from list order on purpose: the page plays in list order.
    box(CUSTOM[1]).click();
    box("RYUO_IV_HW_Info_01.mp4").click();
    $("playMode").value = "Cycle";
    $("play").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toEqual([{
      media: ["RYUO_IV_HW_Info_01.mp4", "RYUO_IV_HW_Info_04.mp4", CUSTOM[1]],
      playMode: "Cycle",
    }]);
    expect($("result").textContent).toBe("Play: POST waterBlockScreenId — acked by the cooler (video restarted)");
  });

  it("sends a single unchecked-then-rechecked file once", async () => {
    const d = await openPage();
    box("RYUO_IV_HW_Info_04.mp4").click();
    box("RYUO_IV_HW_Info_04.mp4").click();
    $("play").click();
    await tick(0);
    expect(d.posts("/api/media/select")[0].media).toEqual(["RYUO_IV_HW_Info_04.mp4"]);
  });

  it("refuses with nothing checked and sends nothing", async () => {
    const d = await openPage();
    box("RYUO_IV_HW_Info_04.mp4").click();
    $("play").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toEqual([]);
    expect($("result").textContent).toBe("Play: pick at least one file");
    expect($("result").style.color).toBe("var(--bad)");
  });

  it("shows the daemon's refusal", async () => {
    const d = await openPage();
    d.mediaLists.custom = []; // the daemon's list changed since the page loaded
    box(CUSTOM[0]).click();
    $("play").click();
    await tick(0);
    expect($("result").textContent).toBe(
      `Play: not in the device media list: ${CUSTOM[0]} (GET /api/media?refresh=1)`,
    );
  });

  it("keeps the selection after a later Refresh, using the config Play returned", async () => {
    await openPage();
    box("RYUO_IV_HW_Info_01.mp4").click();
    box("RYUO_IV_HW_Info_04.mp4").click();
    $("play").click();
    await tick(0);
    $("refresh").click();
    await tick(0);
    expect(checked()).toEqual(["RYUO_IV_HW_Info_01.mp4"]);
  });
});
