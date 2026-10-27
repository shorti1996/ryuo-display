/**
 * Background tab: the Custom tiles and the preset tiles from GET /api/media, "In playlist" from
 * config.media (applied by POST /api/media/select 400 ms after the last tick), Restart video,
 * Refresh, Delete (POST /api/media/delete), the system file, the hero preview of Custom files
 * and the upload drop zone.
 */
import { describe, expect, it, vi } from "vitest";

import { $, CUSTOM, PRESET, choose, makeDaemon, openPage, tick } from "./harness.js";

const tiles = () => [...document.querySelectorAll(".tile")];
const tile = (name) => tiles().find((t) => t.dataset.name === name);
const boxes = () => [...document.querySelectorAll(".tile input[type=checkbox]")];
const box = (name) => boxes().find((b) => b.value === name);
const checked = () => boxes().filter((b) => b.checked).map((b) => b.value);
const delButton = (name) => tile(name).querySelector("button.del");
const thumb = (name) => tile(name).querySelector("button.thumb");
const badge = (name) => { const b = tile(name).querySelector(".badge"); return b.hidden ? "" : b.textContent; };
const thumbUrl = (name) => `/api/media/thumb?name=${encodeURIComponent(name)}`;
const previewUrl = (name) => `/api/media/preview?name=${encodeURIComponent(name)}`;
const BLACK = "display-black.png";

describe("media list", () => {
  it("shows the Custom tiles, then the presets, each in the daemon's order", async () => {
    await openPage();
    expect([...$("media").children].map((t) => t.dataset.name)).toEqual(CUSTOM);
    expect([...$("presets").children].map((t) => t.dataset.name)).toEqual(PRESET);
    expect(boxes().map((b) => b.value)).toEqual([...CUSTOM, ...PRESET]);
    // Presets are labelled without the common prefix and extension; the full name is the tooltip.
    const label = tile(PRESET[0]).querySelector("label");
    expect(label.textContent).toBe("HW_Info_01");
    expect(label.title).toBe(PRESET[0]);
    // The drop zone stays the grid's last cell.
    expect($("media").nextElementSibling.id).toBe("dropZone");
  });

  it("ticks the files in config.media and badges them On panel", async () => {
    await openPage(makeDaemon({ config: { media: ["RYUO_IV_HW_Info_01.mp4", CUSTOM[1]] } }));
    expect(checked()).toEqual([CUSTOM[1], "RYUO_IV_HW_Info_01.mp4"]);
    expect(badge(CUSTOM[1])).toBe("On panel");
    expect(tile(CUSTOM[1]).classList.contains("on")).toBe(true);
    expect(badge("RYUO_IV_HW_Info_01.mp4")).toBe("On panel");
    expect(badge(CUSTOM[0])).toBe("");
    expect(tile(CUSTOM[0]).classList.contains("on")).toBe(false);
  });

  it("says 'none' for an empty preset group and keeps the drop zone for an empty Custom group", async () => {
    await openPage(makeDaemon({ media: { preset: [], custom: [] } }));
    expect($("presets").textContent).toBe("none");
    expect(tiles()).toEqual([]);
    expect($("dropZone").hidden).toBe(false);
  });

  it("Refresh asks for ?refresh=1, redraws the list and names the source", async () => {
    const d = await openPage();
    d.mediaLists = { source: "adb", fetchedAt: 1, preset: ["RYUO_IV_HW_Info_04.mp4"], custom: ["new.mp4"] };
    $("refresh").click();
    await tick(0);
    expect(d.gets("/api/media").map((c) => c.query)).toEqual(["", "refresh=1"]);
    expect(boxes().map((b) => b.value)).toEqual(["new.mp4", "RYUO_IV_HW_Info_04.mp4"]);
    expect(checked()).toEqual(["RYUO_IV_HW_Info_04.mp4"]);
    expect($("result").textContent).toBe("Media list refreshed: 1 file on the cooler, 1 preset");
  });

  it("shows a failed refresh as an error", async () => {
    const d = await openPage();
    d.replyOnce("GET /api/media", { status: 504, body: { ok: false, error: "neither the conn reply nor adb gave a media list" } });
    $("refresh").click();
    await tick(0);
    expect($("result").textContent).toBe("Media list not refreshed: neither the conn reply nor adb gave a media list");
    expect(boxes().map((b) => b.value)).toEqual([...CUSTOM, ...PRESET]);
  });

  it("shows a successful refresh in the normal colour after an earlier error", async () => {
    const d = await openPage();
    d.replyOnce("GET /api/media", { status: 504, body: { ok: false, error: "timeout" } });
    $("refresh").click();
    await tick(0);
    expect($("result").style.color).toBe("var(--bad)");
    $("refresh").click();
    await tick(0);
    expect($("result").textContent).toBe("Media list refreshed: 2 files on the cooler, 2 presets");
    expect($("result").style.color).toBe("var(--muted)");
  });

  it("names the play modes and keeps the daemon's values", async () => {
    await openPage();
    expect([...$("playMode").options].map((o) => [o.value, o.textContent])).toEqual([
      ["Single", "Single, loop"], ["Cycle", "Playlist in order"], ["Random", "Playlist shuffled"],
    ]);
  });
});

describe("playlist", () => {
  it("posts the ticked files in list order with the play mode, 400 ms after the last tick", async () => {
    const d = await openPage();
    // Click order differs from list order on purpose: the page plays in list order.
    box("RYUO_IV_HW_Info_01.mp4").click();
    await tick(200);
    box(CUSTOM[1]).click();
    await tick(399);
    expect(d.posts("/api/media/select")).toEqual([]);
    await tick(1);
    expect(d.posts("/api/media/select")).toEqual([{
      media: [CUSTOM[1], "RYUO_IV_HW_Info_01.mp4", "RYUO_IV_HW_Info_04.mp4"],
      playMode: "Single",
    }]);
    expect($("result").textContent).toBe("Playlist of 3 files (Single, loop) — cooler confirmed, video restarted");
    expect(badge(CUSTOM[1])).toBe("On panel");
  });

  it("posts a play mode change the same way", async () => {
    const d = await openPage();
    choose($("playMode"), "Cycle");
    await tick(400);
    expect(d.posts("/api/media/select")).toEqual([{ media: ["RYUO_IV_HW_Info_04.mp4"], playMode: "Cycle" }]);
  });

  it("Restart video posts at once and drops the pending tick", async () => {
    const d = await openPage();
    box(CUSTOM[0]).click();
    $("play").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toEqual([{ media: [CUSTOM[0], "RYUO_IV_HW_Info_04.mp4"], playMode: "Single" }]);
    await tick(1000);
    expect(d.posts("/api/media/select")).toHaveLength(1);
  });

  it("sends a single unticked-then-reticked file once", async () => {
    const d = await openPage();
    box("RYUO_IV_HW_Info_04.mp4").click();
    box("RYUO_IV_HW_Info_04.mp4").click();
    await tick(400);
    expect(d.posts("/api/media/select")).toEqual([{ media: ["RYUO_IV_HW_Info_04.mp4"], playMode: "Single" }]);
  });

  it("refuses with nothing ticked, sends nothing and ticks the playing file again", async () => {
    const d = await openPage();
    box("RYUO_IV_HW_Info_04.mp4").click();
    expect(box("RYUO_IV_HW_Info_04.mp4").checked).toBe(false);
    await tick(400);
    expect(d.posts("/api/media/select")).toEqual([]);
    expect($("result").textContent).toBe("Keep at least one file in the playlist");
    expect($("result").style.color).toBe("var(--bad)");
    // The panel still plays the old playlist, and the box and badge say so.
    expect(checked()).toEqual(["RYUO_IV_HW_Info_04.mp4"]);
    expect(badge("RYUO_IV_HW_Info_04.mp4")).toBe("On panel");
    // A later tick builds on the restored playlist.
    box(CUSTOM[0]).click();
    await tick(400);
    expect(d.posts("/api/media/select")).toEqual([{ media: [CUSTOM[0], "RYUO_IV_HW_Info_04.mp4"], playMode: "Single" }]);
  });

  it("shows the daemon's refusal", async () => {
    const d = await openPage();
    d.mediaLists.custom = []; // the daemon's list changed since the page loaded
    box(CUSTOM[0]).click();
    await tick(400);
    expect($("result").textContent).toBe(
      `Playlist not changed: not in the device media list: ${CUSTOM[0]} (GET /api/media?refresh=1)`,
    );
  });

  it("keeps the selection after a later Refresh, using the config Play returned", async () => {
    await openPage();
    box("RYUO_IV_HW_Info_01.mp4").click();
    box("RYUO_IV_HW_Info_04.mp4").click();
    await tick(400);
    $("refresh").click();
    await tick(0);
    expect(checked()).toEqual(["RYUO_IV_HW_Info_01.mp4"]);
  });
});

describe("Custom tiles", () => {
  it("give each Custom file a thumbnail, its size and a Delete button; presets get none", async () => {
    await openPage();
    for (const name of CUSTOM) {
      expect(thumb(name).querySelector("img").getAttribute("src")).toBe(thumbUrl(name));
      expect(delButton(name).getAttribute("aria-label")).toBe(`Delete ${name}`);
      expect(delButton(name).querySelector("svg")).not.toBeNull();
      expect(tile(name).querySelector(".name").textContent).toBe(name);
    }
    expect(tile(CUSTOM[0]).querySelector(".size").textContent).toBe("98 MB");
    expect(tile(CUSTOM[1]).querySelector(".size").textContent).toBe("735 kB");
    // Presets get a thumbnail too, but no Delete: mediaDelete cannot reach their folder.
    for (const name of PRESET) {
      expect(thumb(name).querySelector("img").getAttribute("src")).toBe(thumbUrl(name));
      expect(tile(name).querySelector("button.del")).toBeNull();
    }
    expect(document.querySelectorAll(".tile button.del")).toHaveLength(CUSTOM.length);
  });

  it("are placeholders for presets on an older ryuod, which serves no preset thumbnails", async () => {
    await openPage(makeDaemon({ legacy: true }));
    for (const name of PRESET) {
      expect(tile(name).querySelector("button")).toBeNull();
      expect(tile(name).querySelector("img")).toBeNull();
    }
    expect($("presetSub").textContent).toBe("/sdcard/pcMediaPreset, no browser preview");
  });

  it("leave the size empty when the daemon has none", async () => {
    await openPage(makeDaemon({ media: { sizes: {} } }));
    expect(tile(CUSTOM[0]).querySelector(".size").textContent).toBe("");
  });

  it("say a click previews the file above", async () => {
    await openPage();
    expect(thumb(CUSTOM[0]).title).toBe("Click to preview");
    expect(thumb(CUSTOM[0]).getAttribute("aria-label")).toBe(`Preview ${CUSTOM[0]} above`);
  });

  it("drop a thumbnail that cannot be made, keeping the preview button", async () => {
    await openPage();
    thumb(CUSTOM[0]).querySelector("img").dispatchEvent(new Event("error"));
    expect(thumb(CUSTOM[0]).querySelector("img")).toBeNull();
    thumb(CUSTOM[0]).click();
    expect($("heroVideo").getAttribute("src")).toBe(previewUrl(CUSTOM[0]));
  });
});

describe("Delete", () => {
  it("asks again before deleting, then posts the name and redraws the list", async () => {
    const d = await openPage();
    delButton(CUSTOM[1]).click();
    expect(delButton(CUSTOM[1]).textContent).toBe("Really delete?");
    expect(delButton(CUSTOM[1]).classList.contains("armed")).toBe(true);
    expect(delButton(CUSTOM[1]).getAttribute("aria-label")).toBe(`Really delete ${CUSTOM[1]}? Click again to delete it.`);
    expect(d.posts("/api/media/delete")).toEqual([]);
    delButton(CUSTOM[1]).click();
    await tick(0);
    expect(d.posts("/api/media/delete")).toEqual([{ names: [CUSTOM[1]] }]);
    expect(boxes().map((b) => b.value)).toEqual([CUSTOM[0], ...PRESET]);
    expect($("result").textContent).toBe(`Deleted ${CUSTOM[1]} from the cooler`);
    expect($("result").style.color).toBe("var(--muted)");
  });

  it("drops the second step after 4 s, so a later click only asks again", async () => {
    const d = await openPage();
    delButton(CUSTOM[0]).click();
    await tick(3999);
    expect(delButton(CUSTOM[0]).textContent).toBe("Really delete?");
    await tick(1);
    expect(delButton(CUSTOM[0]).textContent).toBe("");
    expect(delButton(CUSTOM[0]).querySelector("svg")).not.toBeNull();
    expect(delButton(CUSTOM[0]).getAttribute("aria-label")).toBe(`Delete ${CUSTOM[0]}`);
    expect(delButton(CUSTOM[0]).classList.contains("armed")).toBe(false);
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect(delButton(CUSTOM[0]).textContent).toBe("Really delete?");
    expect(d.posts("/api/media/delete")).toEqual([]);
  });

  it("disarms one tile when another tile's Delete is clicked", async () => {
    const d = await openPage();
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[1]).click();
    expect(delButton(CUSTOM[0]).classList.contains("armed")).toBe(false);
    expect(delButton(CUSTOM[1]).textContent).toBe("Really delete?");
    delButton(CUSTOM[1]).click();
    await tick(0);
    expect(d.posts("/api/media/delete")).toEqual([{ names: [CUSTOM[1]] }]);
    expect(tile(CUSTOM[0])).toBeDefined();
  });

  it("shows the playlist the daemon fell back to after deleting the file that plays", async () => {
    await openPage(makeDaemon({ config: { media: [CUSTOM[0]] } }));
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect(checked()).toEqual(["RYUO_IV_HW_Info_01.mp4"]);
    expect(badge("RYUO_IV_HW_Info_01.mp4")).toBe("On panel");
    expect($("result").textContent).toBe(`Deleted ${CUSTOM[0]} from the cooler; the panel plays RYUO_IV_HW_Info_01.mp4 instead`);
  });

  it("says the new playlist waits for the cooler when it is not connected", async () => {
    await openPage(makeDaemon({ config: { media: [CUSTOM[0]] }, device: { connected: false } }));
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect($("result").textContent).toBe(
      `Deleted ${CUSTOM[0]} from the cooler; the panel plays RYUO_IV_HW_Info_01.mp4 instead, from when the cooler reconnects`,
    );
  });

  it("shows the daemon's refusal and keeps the tile", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/media/delete", { status: 503, body: { ok: false, error: "the cooler did not take mediaDelete over HID, and adb: no devices" } });
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    expect(delButton(CUSTOM[0]).disabled).toBe(true);
    expect(delButton(CUSTOM[0]).textContent).toBe("Deleting…");
    await tick(0);
    expect($("result").textContent).toBe(`${CUSTOM[0]} not deleted: the cooler did not take mediaDelete over HID, and adb: no devices`);
    expect($("result").style.color).toBe("var(--bad)");
    expect(delButton(CUSTOM[0]).disabled).toBe(false);
    expect(delButton(CUSTOM[0]).getAttribute("aria-label")).toBe(`Delete ${CUSTOM[0]}`);
  });

  it("reports a file the cooler still lists", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/media/delete", {
      status: 200,
      body: {
        ok: true, deleted: [], remaining: [CUSTOM[0]], listedBy: "conn", sent: ["POST mediaDelete"], applied: true,
        acked: true, restartsVideo: false, config: d.config, media: d.mediaLists,
      },
    });
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect($("result").textContent).toBe(`${CUSTOM[0]} is still on the cooler; the delete did not take`);
    expect($("result").style.color).toBe("var(--bad)");
    expect(tile(CUSTOM[0])).toBeDefined();
  });
});

describe("the second display's black image", () => {
  const withBlack = (config = {}) => makeDaemon({ media: { custom: [...CUSTOM, BLACK] }, config });

  it("is a system file: a lock instead of Delete, no playlist box, and a label that says why", async () => {
    await openPage(withBlack());
    const t = tile(BLACK);
    expect(t.querySelector("button.del")).toBeNull();
    expect(t.querySelector("input[type=checkbox]")).toBeNull();
    expect(t.querySelector(".lock svg").getAttribute("aria-label")).toBe("Can't be deleted: used by the second display");
    expect(t.querySelector(".lock").title).toBe("Used by the second display. Delete it from the stock app if needed.");
    expect(t.querySelector(".meta").textContent).toContain("System · Desktop mirror");
    for (const name of CUSTOM) {
      expect(tile(name).querySelector(".lock")).toBeNull();
      expect(delButton(name).disabled).toBe(false);
      expect(box(name)).toBeDefined();
    }
  });

  it("can still be chosen as the background, from its preview", async () => {
    const d = await openPage(withBlack());
    thumb(BLACK).click();
    expect($("heroImage").getAttribute("src")).toBe(previewUrl(BLACK));
    $("pvApply").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toEqual([{ media: [BLACK], playMode: "Single" }]);
    expect(checked()).toEqual([]);
    expect(badge(BLACK)).toBe("On panel");
  });

  it("leaves the playlist when another file is ticked", async () => {
    const d = await openPage(withBlack({ media: [BLACK] }));
    box(CUSTOM[0]).click();
    await tick(400);
    expect(d.posts("/api/media/select")).toEqual([{ media: [CUSTOM[0]], playMode: "Single" }]);
  });
});

describe("while the second display holds HomeUI on the black image", () => {
  it("a playlist change says it applies when the second display is off", async () => {
    const d = await openPage();
    d.held = true;
    box(CUSTOM[0]).click();
    await tick(400);
    expect($("result").textContent).toBe("Playlist of 2 files (Single, loop) saved; applies when the second display is off");
    expect(checked()).toEqual([CUSTOM[0], "RYUO_IV_HW_Info_04.mp4"]);
  });

  it("Delete says the fallback playlist applies when the second display is off", async () => {
    const d = await openPage(makeDaemon({ config: { media: [CUSTOM[0]] } }));
    d.held = true;
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect($("result").textContent).toBe(
      `Deleted ${CUSTOM[0]} from the cooler; the panel plays RYUO_IV_HW_Info_01.mp4 instead, from when the second display is off`,
    );
  });

  it("a finished upload says it applies when the second display is off", async () => {
    await openPage(makeDaemon({
      upload: {
        state: "done", file: "clip.mp4", name: "2026-10-24_12-00-00-000_clip.mp4", action: "copy", applied: false,
        acked: false, heldByDisplay: true, startedAt: 1, progress: null,
      },
    }));
    expect($("upStatus").textContent).toBe(
      "Selected 2026-10-24_12-00-00-000_clip.mp4 (applies when the second display is off), sent as it was",
    );
  });
});

describe("preview in the hero", () => {
  it("plays a Custom file in the hero, muted and looping, with the preview bar", async () => {
    await openPage();
    expect($("previewBar").hidden).toBe(true);
    thumb(CUSTOM[0]).click();
    const v = $("heroVideo");
    expect($("previewBar").hidden).toBe(false);
    expect($("pvName").textContent).toBe(CUSTOM[0]);
    expect($("pvNote").textContent).toBe("not on the panel yet");
    expect($("pvApply").textContent).toBe("Apply");
    expect($("pvApply").getAttribute("aria-label")).toBe(`Apply: show ${CUSTOM[0]} on the panel`);
    expect($("pvApply").title).toBe(`Apply: show ${CUSTOM[0]} on the panel`);
    expect(v.getAttribute("src")).toBe(previewUrl(CUSTOM[0]));
    expect(v.getAttribute("poster")).toBe(thumbUrl(CUSTOM[0]));
    expect(v.hasAttribute("muted") && v.hasAttribute("loop")).toBe(true);
    expect(v.hidden).toBe(false);
    expect($("heroImage").hidden).toBe(true);
    expect($("liveChip").hidden).toBe(true);
    expect(badge(CUSTOM[0])).toBe("Previewing");
    expect(tile(CUSTOM[0]).classList.contains("pv")).toBe(true);
    // Scrolled into view below the sticky header (happy-dom lays out nothing: 0 px + 12 px gap).
    expect($("hero").style.scrollMarginTop).toBe("12px");
    expect($("heroStatus").textContent).toMatch(/^Preparing the preview/);
    v.dispatchEvent(new Event("loadeddata"));
    expect($("heroStatus").textContent).toBe("");
  });

  it("keeps the overlay drawn over the preview", async () => {
    await openPage();
    thumb(CUSTOM[0]).click();
    expect($("ps1").classList.contains("hidden")).toBe(false);
    expect($("hero").dataset.view).toBe("preview");
  });

  it("shows a PNG in an image instead of the video", async () => {
    await openPage();
    thumb(CUSTOM[1]).click();
    expect($("heroImage").getAttribute("src")).toBe(previewUrl(CUSTOM[1]));
    expect($("heroImage").hidden).toBe(false);
    expect($("heroVideo").hidden).toBe(true);
    expect($("heroVideo").hasAttribute("src")).toBe(false);
  });

  it("× goes back to the live view and drops the video source", async () => {
    await openPage();
    thumb(CUSTOM[0]).click();
    $("pvClose").click();
    expect($("previewBar").hidden).toBe(true);
    // Live is the preset RYUO_IV_HW_Info_04.mp4, which the hero now plays instead.
    expect($("heroVideo").getAttribute("src")).toBe(previewUrl("RYUO_IV_HW_Info_04.mp4"));
    expect($("liveChip").hidden).toBe(false);
    expect($("liveText").textContent).toBe("Live · RYUO_IV_HW_Info_04.mp4");
    expect(badge(CUSTOM[0])).toBe("");
  });

  it("Apply plays the file alone, with the play mode, and the hero goes live on it", async () => {
    const d = await openPage(makeDaemon({ config: { playMode: "Cycle" } }));
    thumb(CUSTOM[0]).click();
    $("pvApply").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toEqual([{ media: [CUSTOM[0]], playMode: "Cycle" }]);
    expect($("previewBar").hidden).toBe(true);
    expect($("liveText").textContent).toBe(`Live · ${CUSTOM[0]}`);
    expect($("heroVideo").getAttribute("src")).toBe(previewUrl(CUSTOM[0]));
    expect(checked()).toEqual([CUSTOM[0]]);
    expect(badge(CUSTOM[0])).toBe("On panel");
  });

  it("keeps the preview when Apply is refused", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/media/select", { status: 504, body: { ok: false, error: "device worker did not answer within 3 s" } });
    thumb(CUSTOM[0]).click();
    $("pvApply").click();
    await tick(0);
    expect($("result").textContent).toBe(`${CUSTOM[0]} not applied: device worker did not answer within 3 s`);
    expect($("previewBar").hidden).toBe(false);
    expect(checked()).toEqual(["RYUO_IV_HW_Info_04.mp4"]);
  });

  it("says when the previewed file is already in the playlist", async () => {
    await openPage(makeDaemon({ config: { media: ["RYUO_IV_HW_Info_04.mp4", CUSTOM[1]] } }));
    expect($("liveText").textContent).toBe("Live · RYUO_IV_HW_Info_04.mp4 + 1 more");
    thumb(CUSTOM[1]).click();
    expect($("pvNote").textContent).toBe("in the playlist");
  });

  it("goes back to live when the tile of the file playing live is clicked", async () => {
    await openPage(makeDaemon({ config: { media: [CUSTOM[0]] } }));
    expect($("heroVideo").getAttribute("src")).toBe(previewUrl(CUSTOM[0]));
    thumb(CUSTOM[1]).click();
    expect($("previewBar").hidden).toBe(false);
    thumb(CUSTOM[0]).click();
    expect($("previewBar").hidden).toBe(true);
    expect($("heroVideo").getAttribute("src")).toBe(previewUrl(CUSTOM[0]));
  });

  it("shows the daemon's reason when the preview fails, asking for one byte", async () => {
    const d = await openPage();
    d.replyOnce("GET /api/media/preview", { status: 502, body: { ok: false, error: "adb pull exited with 1: adb: no devices/emulators found" } });
    thumb(CUSTOM[0]).click();
    $("heroVideo").dispatchEvent(new Event("error"));
    await tick(0);
    expect($("heroStatus").textContent).toBe("Preview failed: adb pull exited with 1: adb: no devices/emulators found");
    const [url, opt] = d.fetch.mock.calls.find(([u]) => String(u).startsWith("/api/media/preview"));
    expect(url).toBe(previewUrl(CUSTOM[0]));
    expect(opt.headers).toEqual({ Range: "bytes=0-0" });
  });

  it("blames the browser when the daemon served the file but it would not play", async () => {
    await openPage();
    thumb(CUSTOM[0]).click();
    $("heroVideo").dispatchEvent(new Event("error"));
    await tick(0);
    expect($("heroStatus").textContent).toBe("Preview failed: this browser cannot play the file");
  });

  it("closes when the previewed file is deleted", async () => {
    await openPage();
    thumb(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect($("previewBar").hidden).toBe(true);
    expect($("heroVideo").getAttribute("src")).toBe(previewUrl("RYUO_IV_HW_Info_04.mp4"));
  });
});

describe("upload drop zone", () => {
  // A stand-in for the XMLHttpRequest that tests/setup.js blocks; the test plays the daemon's reply.
  class FakeXhr {
    constructor() { FakeXhr.last = this; this.headers = {}; this.upload = {}; this.aborted = false; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) { this.body = body; }
    abort() { this.aborted = true; }
  }
  async function withXhr(fn) {
    const blocked = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = window.XMLHttpRequest = FakeXhr;
    try { await fn(); } finally { globalThis.XMLHttpRequest = window.XMLHttpRequest = blocked; }
  }
  function drop(file) {
    const e = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "dataTransfer", { value: { files: [file] } });
    $("dropZone").dispatchEvent(e);
  }

  it("uploads a dropped file with the chosen shape and shows the progress", async () => {
    await withXhr(async () => {
      await openPage();
      choose($("upFit"), "pad");
      const f = new File(["data"], "my clip.mp4");
      drop(f);
      const x = FakeXhr.last;
      expect([x.method, x.url]).toEqual(["POST", "/api/media/upload?fit=pad"]);
      expect(x.headers).toEqual({ "Content-Type": "application/octet-stream", "X-Filename": "my%20clip.mp4" });
      expect(x.body).toBe(f);
      expect($("upStatus").textContent).toBe("Uploading my clip.mp4: 0 %");
      expect($("upBar").hidden).toBe(false);
      expect($("upCancel").hidden).toBe(false);
      expect($("upBrowse").disabled).toBe(true);

      x.status = 202;
      x.responseText = JSON.stringify({ ok: true, upload: { state: "probing", file: "my clip.mp4", startedAt: 5, progress: null } });
      x.onloadend();
      expect($("upStatus").textContent).toBe("Checking my clip.mp4…");
    });
  });

  it("refuses a second file while one is being processed", async () => {
    await withXhr(async () => {
      await openPage();
      drop(new File(["a"], "a.mp4"));
      const first = FakeXhr.last;
      drop(new File(["b"], "b.mp4"));
      expect(FakeXhr.last).toBe(first);
      expect($("result").textContent).toBe("Wait for the current upload to finish first");
    });
  });

  it("Browse opens the file picker", async () => {
    await openPage();
    const pick = vi.spyOn($("upFile"), "click").mockImplementation(() => {});
    $("upBrowse").click();
    expect(pick).toHaveBeenCalledOnce();
  });

  it("takes a video or a still image", async () => {
    await openPage();
    expect($("dropZone").textContent).toContain("Drop a video or image to upload it");
    expect($("upFile").accept).toBe("video/*,image/*,.mp4,.mov,.mkv,.webm,.avi,.m4v,.png,.jpg,.jpeg,.webp,.gif,.bmp");
  });

  it("shows an image's conversion and result", async () => {
    const up = { state: "converting", file: "photo.jpg", action: "image", reason: "still image; converted to a 2240x1080 PNG", startedAt: 9, progress: null };
    const d = await openPage(makeDaemon({ upload: up }));
    expect($("upStatus").textContent).toBe("Converting to a 2240×1080 PNG…");
    d.upload = { ...up, state: "done", name: "2026-10-27_12-00-00-000_photo.png", applied: true, acked: true, heldByDisplay: false, heldByStandby: false };
    await tick(1000);
    expect($("upStatus").textContent).toBe("Playing 2026-10-27_12-00-00-000_photo.png, converted to a 2240×1080 PNG");
  });
});

describe("Apply on a playlist of several files", () => {
  const multi = () => makeDaemon({ config: { media: ["RYUO_IV_HW_Info_04.mp4", CUSTOM[1]], playMode: "Cycle" } });

  it("asks in the bar before replacing the playlist, and sends nothing yet", async () => {
    const d = await openPage(multi());
    thumb(CUSTOM[0]).click();
    $("pvApply").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toEqual([]);
    expect($("pvAsk").hidden).toBe(false);
    expect($("pvAskLong").textContent).toBe("Replace the 2-file playlist with this file?");
    expect($("pvAskShort").textContent).toBe("Replace 2 files?");
    expect($("previewBar").classList.contains("asking")).toBe(true);
    for (const id of ["pvApply", "pvNote", "pvClose"]) expect($(id).hidden).toBe(true);
    for (const id of ["pvReplace", "pvCancel"]) expect($(id).hidden).toBe(false);
  });

  it("Replace sends the file alone", async () => {
    const d = await openPage(multi());
    thumb(CUSTOM[0]).click();
    $("pvApply").click();
    $("pvReplace").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toEqual([{ media: [CUSTOM[0]], playMode: "Cycle" }]);
    expect($("previewBar").hidden).toBe(true);
    expect($("result").textContent).toBe(`Background ${CUSTOM[0]} — cooler confirmed, video restarted`);
  });

  it("Cancel goes back to Apply and keeps the playlist", async () => {
    const d = await openPage(multi());
    thumb(CUSTOM[0]).click();
    $("pvApply").click();
    $("pvCancel").click();
    await tick(400);
    expect(d.posts("/api/media/select")).toEqual([]);
    expect($("pvApply").hidden).toBe(false);
    expect($("pvAsk").hidden).toBe(true);
    expect($("previewBar").classList.contains("asking")).toBe(false);
  });

  it("asks for a file already in the playlist too, since the others would go", async () => {
    const d = await openPage(multi());
    thumb(CUSTOM[1]).click();
    $("pvApply").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toEqual([]);
    expect($("pvAsk").hidden).toBe(false);
  });

  it("stops asking when another file is previewed or the preview closes", async () => {
    await openPage(multi());
    thumb(CUSTOM[0]).click();
    $("pvApply").click();
    thumb(CUSTOM[1]).click();
    expect($("pvAsk").hidden).toBe(true);
    $("pvApply").click();
    $("pvCancel").click();
    $("pvApply").click();
    $("pvClose").click();  // hidden while asking, but closing by any route resets it
    thumb(CUSTOM[0]).click();
    expect($("pvApply").hidden).toBe(false);
  });

  it("sends at once on a playlist of one file", async () => {
    const d = await openPage();
    thumb(CUSTOM[0]).click();
    $("pvApply").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toHaveLength(1);
    expect($("pvAsk").hidden).toBe(true);
  });
});
