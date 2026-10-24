/**
 * Background media: the preset and custom groups from GET /api/media, the checked set from
 * config.media, Refresh, Play (POST /api/media/select), Delete (POST /api/media/delete), and the
 * thumbnails and preview of Custom files.
 */
import { describe, expect, it } from "vitest";

import { $, CUSTOM, PRESET, makeDaemon, openPage, tick } from "./harness.js";

const boxes = () => [...$("media").querySelectorAll("input[type=checkbox]")];
const box = (name) => boxes().find((b) => b.value === name);
const checked = () => boxes().filter((b) => b.checked).map((b) => b.value);
const row = (name) => box(name).closest(".mrow");
const delButton = (name) => row(name).querySelector("button.del");
const thumb = (name) => row(name).querySelector("button.thumb");
const thumbUrl = (name) => `/api/media/thumb?name=${encodeURIComponent(name)}`;
const previewUrl = (name) => `/api/media/preview?name=${encodeURIComponent(name)}`;

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
    const names = (rows) => rows.map((k) => k.querySelector(".mono").textContent);
    expect(names(kids.slice(1, customHeading))).toEqual(PRESET);
    // The Custom group opens with the preview hint, then one row per file.
    expect(kids[customHeading + 1].textContent).toBe("Click a thumbnail to preview the file below this list.");
    expect(names(kids.slice(customHeading + 2))).toEqual(CUSTOM);
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

describe("Custom rows", () => {
  it("give each Custom file a thumbnail, its size and a Delete button; presets get none", async () => {
    await openPage();
    for (const name of CUSTOM) {
      expect(thumb(name).querySelector("img").getAttribute("src")).toBe(thumbUrl(name));
      expect(delButton(name).textContent).toBe("Delete");
    }
    expect(row(CUSTOM[0]).querySelector(".size").textContent).toBe("98 MB");
    expect(row(CUSTOM[1]).querySelector(".size").textContent).toBe("735 kB");
    for (const name of PRESET) expect(box(name).closest(".mrow")).toBeNull();
    expect($("media").querySelectorAll("button.del")).toHaveLength(CUSTOM.length);
    expect($("media").querySelectorAll("img")).toHaveLength(CUSTOM.length);
  });

  it("leave the size empty when the daemon has none", async () => {
    await openPage(makeDaemon({ media: { sizes: {} } }));
    expect(row(CUSTOM[0]).querySelector(".size").textContent).toBe("");
  });

  it("say a click previews the file", async () => {
    await openPage();
    expect(thumb(CUSTOM[0]).title).toBe("Click to preview");
    expect(thumb(CUSTOM[0]).getAttribute("aria-label")).toBe(`Preview ${CUSTOM[0]}`);
  });

  it("drop a thumbnail that cannot be made, keeping the preview button", async () => {
    await openPage();
    thumb(CUSTOM[0]).querySelector("img").dispatchEvent(new Event("error"));
    expect(thumb(CUSTOM[0]).querySelector("img")).toBeNull();
    thumb(CUSTOM[0]).click();
    expect($("mpVideo").getAttribute("src")).toBe(previewUrl(CUSTOM[0]));
  });
});

describe("Delete", () => {
  it("asks again before deleting, then posts the name and redraws the list", async () => {
    const d = await openPage();
    delButton(CUSTOM[1]).click();
    expect(delButton(CUSTOM[1]).textContent).toBe("Really delete?");
    expect(delButton(CUSTOM[1]).classList.contains("armed")).toBe(true);
    expect(d.posts("/api/media/delete")).toEqual([]);
    delButton(CUSTOM[1]).click();
    await tick(0);
    expect(d.posts("/api/media/delete")).toEqual([{ names: [CUSTOM[1]] }]);
    expect(boxes().map((b) => b.value)).toEqual([...PRESET, CUSTOM[0]]);
    expect($("result").textContent).toBe(`Deleted ${CUSTOM[1]}`);
    expect($("result").style.color).toBe("var(--muted)");
  });

  it("drops the second step after 4 s, so a later click only asks again", async () => {
    const d = await openPage();
    delButton(CUSTOM[0]).click();
    await tick(3999);
    expect(delButton(CUSTOM[0]).textContent).toBe("Really delete?");
    await tick(1);
    expect(delButton(CUSTOM[0]).textContent).toBe("Delete");
    expect(delButton(CUSTOM[0]).classList.contains("armed")).toBe(false);
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect(delButton(CUSTOM[0]).textContent).toBe("Really delete?");
    expect(d.posts("/api/media/delete")).toEqual([]);
  });

  it("disarms one row when another row's Delete is clicked", async () => {
    const d = await openPage();
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[1]).click();
    expect(delButton(CUSTOM[0]).textContent).toBe("Delete");
    expect(delButton(CUSTOM[1]).textContent).toBe("Really delete?");
    delButton(CUSTOM[1]).click();
    await tick(0);
    expect(d.posts("/api/media/delete")).toEqual([{ names: [CUSTOM[1]] }]);
    expect(box(CUSTOM[0])).toBeDefined();
  });

  it("shows the playlist the daemon fell back to after deleting the file that plays", async () => {
    await openPage(makeDaemon({ config: { media: [CUSTOM[0]] } }));
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect(checked()).toEqual(["RYUO_IV_HW_Info_01.mp4"]);
    expect($("result").textContent).toBe(`Deleted ${CUSTOM[0]}; playlist now RYUO_IV_HW_Info_01.mp4`);
  });

  it("says the new playlist waits for the cooler when it is not connected", async () => {
    await openPage(makeDaemon({ config: { media: [CUSTOM[0]] }, device: { connected: false } }));
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect($("result").textContent).toBe(
      `Deleted ${CUSTOM[0]}; playlist now RYUO_IV_HW_Info_01.mp4, sent when the cooler reconnects`,
    );
  });

  it("shows the daemon's refusal and keeps the row", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/media/delete", { status: 503, body: { ok: false, error: "the cooler did not take mediaDelete over HID, and adb: no devices" } });
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    expect(delButton(CUSTOM[0]).disabled).toBe(true);
    await tick(0);
    expect($("result").textContent).toBe("Delete: the cooler did not take mediaDelete over HID, and adb: no devices");
    expect($("result").style.color).toBe("var(--bad)");
    expect(delButton(CUSTOM[0]).disabled).toBe(false);
    expect(delButton(CUSTOM[0]).textContent).toBe("Delete");
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
    expect($("result").textContent).toBe(`Delete: ${CUSTOM[0]} is still on the cooler`);
    expect($("result").style.color).toBe("var(--bad)");
    expect(box(CUSTOM[0])).toBeDefined();
  });
});

describe("the second display's black image", () => {
  const BLACK = "display-black.png";

  it("is listed with a second display tag and a disabled Delete that says why", async () => {
    await openPage(makeDaemon({ media: { custom: [...CUSTOM, BLACK] } }));
    expect(row(BLACK).querySelector(".tag").textContent).toBe("second display");
    expect(delButton(BLACK).disabled).toBe(true);
    expect(delButton(BLACK).title).toBe("Used by the second display. Delete it from the stock app if needed.");
    for (const name of CUSTOM) {
      expect(row(name).querySelector(".tag")).toBeNull();
      expect(delButton(name).disabled).toBe(false);
    }
  });

  it("can be chosen as a normal background", async () => {
    const d = await openPage(makeDaemon({ media: { custom: [...CUSTOM, BLACK] } }));
    box("RYUO_IV_HW_Info_04.mp4").click();
    box(BLACK).click();
    $("play").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toEqual([{ media: [BLACK], playMode: "Single" }]);
    expect(checked()).toEqual([BLACK]);
  });
});

describe("while the second display holds HomeUI on the black image", () => {
  it("Play says the selection applies when the second display is off", async () => {
    const d = await openPage();
    d.held = true;
    box(CUSTOM[0]).click();
    $("play").click();
    await tick(0);
    expect($("result").textContent).toBe("Play: nothing sent — saved; applies when the second display is off");
    expect(checked()).toEqual(["RYUO_IV_HW_Info_04.mp4", CUSTOM[0]]);
  });

  it("Delete says the fallback playlist applies when the second display is off", async () => {
    const d = await openPage(makeDaemon({ config: { media: [CUSTOM[0]] } }));
    d.held = true;
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect($("result").textContent).toBe(
      `Deleted ${CUSTOM[0]}; playlist now RYUO_IV_HW_Info_01.mp4, applies when the second display is off`,
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

describe("Preview", () => {
  it("plays a Custom file in a muted, looping video when its thumbnail is clicked", async () => {
    await openPage();
    expect($("mediaPreview").hidden).toBe(true);
    thumb(CUSTOM[0]).click();
    const v = $("mpVideo");
    expect($("mediaPreview").hidden).toBe(false);
    expect($("mpName").textContent).toBe(CUSTOM[0]);
    expect(v.getAttribute("src")).toBe(previewUrl(CUSTOM[0]));
    expect(v.hasAttribute("muted") && v.hasAttribute("loop")).toBe(true);
    expect(v.hidden).toBe(false);
    expect($("mpImage").hidden).toBe(true);
    expect($("mpStatus").textContent).toMatch(/^Preparing the preview/);
    v.dispatchEvent(new Event("loadeddata"));
    expect($("mpStatus").textContent).toBe("");
  });

  it("shows a PNG in an image instead of the video", async () => {
    await openPage();
    thumb(CUSTOM[1]).click();
    expect($("mpImage").getAttribute("src")).toBe(previewUrl(CUSTOM[1]));
    expect($("mpImage").hidden).toBe(false);
    expect($("mpVideo").hidden).toBe(true);
    expect($("mpVideo").hasAttribute("src")).toBe(false);
  });

  it("Close hides the preview and drops the video source", async () => {
    await openPage();
    thumb(CUSTOM[0]).click();
    $("mpClose").click();
    expect($("mediaPreview").hidden).toBe(true);
    expect($("mpVideo").hasAttribute("src")).toBe(false);
  });

  it("shows the daemon's reason when the preview fails, asking for one byte", async () => {
    const d = await openPage();
    d.replyOnce("GET /api/media/preview", { status: 502, body: { ok: false, error: "adb pull exited with 1: adb: no devices/emulators found" } });
    thumb(CUSTOM[0]).click();
    $("mpVideo").dispatchEvent(new Event("error"));
    await tick(0);
    expect($("mpStatus").textContent).toBe("Preview failed: adb pull exited with 1: adb: no devices/emulators found");
    const [url, opt] = d.fetch.mock.calls.find(([u]) => String(u).startsWith("/api/media/preview"));
    expect(url).toBe(previewUrl(CUSTOM[0]));
    expect(opt.headers).toEqual({ Range: "bytes=0-0" });
  });

  it("blames the browser when the daemon served the file but it would not play", async () => {
    await openPage();
    thumb(CUSTOM[0]).click();
    $("mpVideo").dispatchEvent(new Event("error"));
    await tick(0);
    expect($("mpStatus").textContent).toBe("Preview failed: this browser cannot play the file");
  });

  it("closes when the previewed file is deleted", async () => {
    await openPage();
    thumb(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect($("mediaPreview").hidden).toBe(true);
    expect($("mpVideo").hasAttribute("src")).toBe(false);
  });
});
