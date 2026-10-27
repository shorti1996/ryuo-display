/**
 * The Background tab, the hero and the upload zone on the Lit page: the behaviour step 4 changed
 * on purpose (design doc, "Step 4:" open questions), and what no old test pins. Each case that
 * names the old page was run against web/index.html too, with the same steps, before it was
 * written down here.
 *
 * "the hero, as the old renderHero drew it" runs the old page's renderHero, showDown and
 * renderPanel, kept in fixtures/old-page.js, as display-parity.test.ts does.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  $,
  CUSTOM,
  choose,
  defaultDevice,
  defaultDisplay,
  makeDaemon,
  openPage,
  PRESET,
  slot,
  tick,
} from "./harness.js";

const tiles = () => [...document.querySelectorAll(".tile")];
const tile = (name) => tiles().find((found) => found.dataset.name === name);
const boxes = () => [...document.querySelectorAll(".tile input[type=checkbox]")];
const box = (name) => boxes().find((found) => found.value === name);
const checked = () => boxes().filter((found) => found.checked).map((found) => found.value);
const thumb = (name) => tile(name).querySelector("button.thumb");
const thumbImage = (name) => thumb(name).querySelector("img");
const delButton = (name) => tile(name).querySelector("button.del");
const store = () => document.querySelector("ryuo-app").app.store;
const LIVE = "RYUO_IV_HW_Info_04.mp4"; // harness.js defaultConfig().media[0]

/** The old page's top-level code, for the parity block at the end. */
const OLD_PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "old-page.js"), "utf8");

describe("the play mode select", () => {
  // The old page held the whole media group while the select had focus, so another client's
  // playlist waited for the blur, and a mode picked meanwhile went out with the page's stale
  // playlist and put the other client's change back. The Lit page holds only playMode.
  it("takes another client's playlist while it has focus, and the mode picked next keeps that playlist", async () => {
    const daemon = await openPage();
    $("playMode").focus();
    daemon.config.media = [CUSTOM[0]];
    await tick(1000);
    expect(checked()).toEqual([CUSTOM[0]]);
    expect($("liveText").textContent).toBe(`Live · ${CUSTOM[0]}`);
    choose($("playMode"), "Cycle");
    await tick(400);
    expect(daemon.posts("/api/media/select")).toEqual([{ media: [CUSTOM[0]], playMode: "Cycle" }]);
    expect(daemon.config.media).toEqual([CUSTOM[0]]);
  });

  it("keeps another client's play mode out until it loses focus, as the old page did", async () => {
    const daemon = await openPage();
    $("playMode").focus();
    daemon.config.playMode = "Random";
    await tick(1000);
    expect($("playMode").value).toBe("Single");
    $("playMode").blur();
    await tick(1000);
    expect($("playMode").value).toBe("Random");
  });
});

describe("a playlist change in its 400 ms debounce", () => {
  it("holds the ticks and the play mode against a poll that brings another client's", async () => {
    const daemon = await openPage();
    // Line the tick up so the 1 s poll lands inside the debounce.
    await tick(800);
    box(CUSTOM[0]).click();
    daemon.config.media = [CUSTOM[1]];
    daemon.config.playMode = "Random";
    await tick(200);
    expect(daemon.gets("/api/state").length).toBeGreaterThan(1);
    expect(checked()).toEqual([CUSTOM[0], LIVE]);
    expect($("playMode").value).toBe("Single");
    await tick(200);
    expect(daemon.posts("/api/media/select")).toEqual([{ media: [CUSTOM[0], LIVE], playMode: "Single" }]);
  });

  it("keeps the user's ticks when ryuod refuses the selection, as the old page did", async () => {
    // Only an empty playlist puts the ticks back (media.test.js); a refusal leaves them, so the
    // next tick sends them again with its own change.
    const daemon = await openPage();
    daemon.replyOnce("POST /api/media/select", { status: 503, body: { ok: false, error: "cooler busy" } });
    box(CUSTOM[0]).click();
    await tick(400);
    expect($("result").textContent).toBe("Playlist not changed: cooler busy");
    expect(checked()).toEqual([CUSTOM[0], LIVE]);
    await tick(1000);
    expect(checked()).toEqual([CUSTOM[0], LIVE]);
    box(CUSTOM[1]).click();
    await tick(400);
    expect(daemon.posts("/api/media/select").at(-1)).toEqual({ media: [...CUSTOM, LIVE], playMode: "Single" });
  });
});

describe("a playlist POST's reply", () => {
  // The reply's config predates an overlay edit still in its 300 ms debounce. Only media and
  // playMode are taken from it; the old page replaced its whole config too, but its overlay
  // controls never read the config, so neither page loses the edit.
  it("leaves a slot edit waiting in the overlay debounce: Restart video", async () => {
    const daemon = await openPage();
    choose(slot(4), "CPU Load");
    $("play").click();
    await tick(0);
    expect(slot(4).value).toBe("CPU Load");
    await tick(300);
    expect(daemon.posts("/api/overlay").map((body) => body.items[4])).toEqual(["CPU Load"]);
    await tick(1000);
    expect(slot(4).value).toBe("CPU Load");
  });

  it("leaves a colour edit waiting in the overlay debounce: Apply", async () => {
    const daemon = await openPage();
    $("titleColor").value = "#00ff00";
    $("titleColor").dispatchEvent(new Event("input", { bubbles: true }));
    thumb(CUSTOM[0]).click();
    $("pvApply").click();
    await tick(0);
    expect(daemon.posts("/api/media/select")).toEqual([{ media: [CUSTOM[0]], playMode: "Single" }]);
    expect($("titleColor").value).toBe("#00ff00");
    await tick(300);
    expect(daemon.posts("/api/overlay").map((body) => body.titleColor)).toEqual(["#00FF00"]);
  });
});

describe("a thumbnail that failed to load", () => {
  // The old page rebuilt every tile on Apply and on a refused delete too, which asked again for
  // a thumbnail that had failed. Neither can bring adb back, so the Lit page waits for a new list.
  it("is asked for again on a new media list, not after a tick, Apply or a refused delete", async () => {
    const daemon = await openPage();
    const fail = () => thumbImage(CUSTOM[0])?.dispatchEvent(new Event("error"));
    fail();
    expect(thumbImage(CUSTOM[0])).toBeNull();
    // A play mode change, not a tick: Apply below must find a one-file playlist and send at once.
    choose($("playMode"), "Cycle");
    await tick(400);
    expect(thumbImage(CUSTOM[0])).toBeNull();
    thumb(PRESET[0]).click();
    $("pvApply").click();
    await tick(0);
    expect(daemon.posts("/api/media/select")).toHaveLength(2);
    expect(thumbImage(CUSTOM[0])).toBeNull();
    daemon.replyOnce("POST /api/media/delete", { status: 503, body: { ok: false, error: "adb: no devices" } });
    delButton(CUSTOM[1]).click();
    delButton(CUSTOM[1]).click();
    await tick(0);
    expect(thumbImage(CUSTOM[0])).toBeNull();
    $("refresh").click();
    await tick(0);
    expect(thumbImage(CUSTOM[0]).getAttribute("src")).toBe(`/api/media/thumb?name=${encodeURIComponent(CUSTOM[0])}`);
  });
});

describe("the hero's <video> and <img>", () => {
  /** The src and poster changes on the hero's media, as "id.attribute=value", since the last call. */
  function watchMedia() {
    const changes = [];
    const observer = new MutationObserver((records) => {
      for (const change of records) {
        changes.push(`${change.target.id}.${change.attributeName}=${change.target.getAttribute(change.attributeName)}`);
      }
    });
    observer.observe($("hero"), { attributes: true, subtree: true, attributeFilter: ["src", "poster"] });
    return () => changes.splice(0);
  }
  const preview = (name) => `/api/media/preview?name=${encodeURIComponent(name)}`;
  const thumbUrl = (name) => `/api/media/thumb?name=${encodeURIComponent(name)}`;

  // The template has no binding on them; updated() sets the source only when the file changes,
  // so the video does not restart on every poll. The old page's setHeroMedia had the same guard;
  // these steps gave the same changes on both pages.
  it("change source only when the hero's file changes", async () => {
    const daemon = await openPage(makeDaemon({ config: { media: [CUSTOM[0]] } }));
    const video = $("heroVideo");
    // happy-dom's media element has no play(); count the calls the page makes.
    video.play = vi.fn(() => Promise.resolve());
    const changes = watchMedia();
    await tick(3000);
    choose(slot(4), "CPU Load");
    thumb(CUSTOM[0]).click(); // the live file: the hero stays live
    await tick(0);
    expect(changes()).toEqual([]);
    expect(video.play).not.toHaveBeenCalled();

    thumb(CUSTOM[1]).click();
    await tick(1000);
    expect(changes()).toEqual(["heroVideo.src=null", "heroVideo.poster=null", `heroImage.src=${preview(CUSTOM[1])}`]);
    expect([video.hidden, $("heroImage").hidden]).toEqual([true, false]);

    $("pvClose").click();
    await tick(0);
    expect(changes()).toEqual([
      "heroImage.src=null",
      `heroVideo.poster=${thumbUrl(CUSTOM[0])}`,
      `heroVideo.src=${preview(CUSTOM[0])}`,
    ]);
    expect(video.play).toHaveBeenCalledOnce();
    expect($("heroStatus").textContent).toMatch(/^Preparing the preview/);
    video.dispatchEvent(new Event("loadeddata"));
    expect($("heroStatus").textContent).toBe("");

    daemon.panel.on = false;
    await tick(1000);
    expect(changes()).toEqual(["heroVideo.src=null", "heroVideo.poster=null"]);
    daemon.panel.on = true;
    await tick(1000);
    expect(changes()).toEqual([`heroVideo.poster=${thumbUrl(CUSTOM[0])}`, `heroVideo.src=${preview(CUSTOM[0])}`]);
    await tick(2000);
    expect(changes()).toEqual([]);
    expect(video.play).toHaveBeenCalledTimes(2);
  });
});

describe("upload zone", () => {
  // A stand-in for the XMLHttpRequest that tests/setup.js blocks; the test plays ryuod's reply.
  class FakeXhr {
    constructor() {
      FakeXhr.last = this;
      this.headers = {};
      this.upload = {};
      this.aborted = false;
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    send(body) {
      this.body = body;
    }
    abort() {
      this.aborted = true;
    }
    /** The request ends: what the browser's loadend reports. */
    end(status, responseText = "") {
      this.status = status;
      this.responseText = responseText;
      this.onloadend();
    }
  }
  async function withXhr(run) {
    const blocked = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = window.XMLHttpRequest = FakeXhr;
    try {
      await run();
    } finally {
      globalThis.XMLHttpRequest = window.XMLHttpRequest = blocked;
    }
  }
  /** Serve POST /api/media/upload/cancel, which the fake ryuod does not; returns the calls. */
  function serveCancel() {
    const inner = globalThis.fetch;
    const calls = [];
    globalThis.fetch = window.fetch = async (url, options = {}) => {
      if (url !== "/api/media/upload/cancel") return inner(url, options);
      calls.push(options.method);
      // ryuod.post_upload_cancel: the job's snapshot, or 409 once it has finished.
      return { ok: true, status: 200, json: async () => ({ ok: true, upload: { state: "receiving" } }) };
    };
    return calls;
  }
  function dragEvent(type, extra = {}) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    for (const [name, value] of Object.entries(extra)) Object.defineProperty(event, name, { value });
    return event;
  }
  const drop = (file) => $("dropZone").dispatchEvent(dragEvent("drop", { dataTransfer: { files: [file] } }));
  /** The drop zone and status line as the user sees them. */
  const zone = () => ({
    status: $("upStatus").textContent,
    bad: $("upStatus").classList.contains("bad"),
    bar: $("upBar").hidden ? "hidden" : $("upBar").getAttribute("value"),
    cancel: !$("upCancel").hidden,
    browse: !$("upBrowse").disabled,
  });

  // ryuod.Upload.snapshot(): every field, as the job sets them.
  const SNAPSHOT = {
    file: "clip.mov", bytes: 100, received: 100, progress: null, speed: null, action: null, reason: null,
    encoder: null, name: null, error: null, applied: null, acked: null, heldByDisplay: null, heldByStandby: null,
    startedAt: 7, finishedAt: null,
  };
  // Each state ryuod's Upload reports, in the order a job goes through them, with what the old
  // page showed for it. A running job shows the bar (busy without a share) and Cancel, and
  // disables Browse; an ended one shows none of them.
  const STATES = [
    [{ state: "receiving", received: 42, progress: 0.42 }, "Uploading clip.mov: 42 %", "0.42"],
    [{ state: "probing" }, "Checking clip.mov…", null],
    [
      { state: "converting", action: "transcode", encoder: "hevc_vaapi", progress: 0.5, speed: "2.1x", reason: "h264" },
      "Converting to 2240×1080 HEVC with hevc_vaapi: 50 % at 2.1x. Reason: h264",
      "0.5",
    ],
    [
      { state: "converting", action: "transcode", encoder: "libx265" },
      "Converting to 2240×1080 HEVC with libx265…",
      null,
    ],
    [{ state: "converting", action: "remux", progress: 0.1 }, "Repackaging as MP4: 10 %", "0.1"],
    [{ state: "converting", action: "image", reason: "still image" }, "Converting to a 2240×1080 PNG…", null],
    [{ state: "pushing", action: "copy", name: "x.mp4" }, "Copying to the cooler over adb…", null],
    [{ state: "starting", action: "copy", name: "x.mp4" }, "Starting playback…", null],
  ];
  const ENDED = [
    [{ state: "done", action: "copy", name: "x.mp4", applied: true, acked: true }, "Playing x.mp4, sent as it was", false],
    [{ state: "error", error: "ffprobe could not read clip.mov" }, "Upload failed: ffprobe could not read clip.mov", true],
    [{ state: "cancelled" }, "Upload cancelled", false],
  ];

  it("shows each state of ryuod's job from the state poll", async () => {
    const daemon = await openPage(makeDaemon({ upload: { ...SNAPSHOT, ...STATES[0][0] } }));
    for (const [state, status, bar] of STATES) {
      daemon.upload = { ...SNAPSHOT, ...state };
      await tick(1000);
      expect(zone(), status).toEqual({ status, bad: false, bar, cancel: true, browse: false });
    }
    for (const [state, status, bad] of ENDED) {
      daemon.upload = { ...SNAPSHOT, ...state };
      await tick(1000);
      expect(zone(), status).toEqual({ status, bad, bar: "hidden", cancel: false, browse: true });
    }
  });

  it("refuses a second file while ryuod still converts one from another page", async () => {
    await withXhr(async () => {
      await openPage(makeDaemon({ upload: { ...SNAPSHOT, state: "converting", action: "remux", progress: 0.3 } }));
      FakeXhr.last = undefined;
      drop(new File(["b"], "b.mp4"));
      expect(FakeXhr.last).toBeUndefined();
      expect($("result").textContent).toBe("Wait for the current upload to finish first");
    });
  });

  it("shows the POST's own progress, keeping the last share when the browser cannot tell", async () => {
    await withXhr(async () => {
      await openPage();
      drop(new File(["data"], "a.mp4"));
      const request = FakeXhr.last;
      request.upload.onprogress({ lengthComputable: true, loaded: 1, total: 4 });
      expect(zone()).toEqual({ status: "Uploading a.mp4: 25 %", bad: false, bar: "0.25", cancel: true, browse: false });
      request.upload.onprogress({ lengthComputable: false, loaded: 2, total: 0 });
      expect(zone().status).toBe("Uploading a.mp4: 25 %");
    });
  });

  it("Cancel asks ryuod to stop the job, aborts the POST and says it was cancelled", async () => {
    await withXhr(async () => {
      await openPage();
      const cancels = serveCancel();
      drop(new File(["data"], "a.mp4"));
      const request = FakeXhr.last;
      $("upCancel").click();
      await tick(0);
      expect(cancels).toEqual(["POST"]);
      expect(request.aborted).toBe(true);
      // An aborted XMLHttpRequest ends with status 0 and no body.
      request.end(0);
      expect(zone()).toEqual({ status: "Upload cancelled", bad: false, bar: "hidden", cancel: false, browse: true });
    });
  });

  it.each([
    // ryuod.post_media_upload refuses a body over MAX_UPLOAD (4 GiB) before reading it.
    [413, JSON.stringify({ ok: false, error: "file over 4 GiB" }), "Upload failed: file over 4 GiB"],
    [0, "", "Upload failed: the connection to ryuod dropped"],
    [502, "<html>bad gateway</html>", "Upload failed: HTTP 502"],
  ])("shows a POST that ends with %i as a failure", async (status, body, message) => {
    await withXhr(async () => {
      await openPage();
      drop(new File(["data"], "big.mkv"));
      FakeXhr.last.end(status, body);
      expect(zone()).toEqual({ status: message, bad: true, bar: "hidden", cancel: false, browse: true });
      // The zone takes the next file.
      drop(new File(["data"], "small.mkv"));
      expect(zone().status).toBe("Uploading small.mkv: 0 %");
    });
  });

  it("marks the zone while a file is dragged over it, until the drag leaves it or drops", async () => {
    await withXhr(async () => {
      await openPage();
      const dropZone = $("dropZone");
      const enter = dragEvent("dragenter");
      dropZone.dispatchEvent(enter);
      // Without preventDefault the browser refuses the drop.
      expect(enter.defaultPrevented).toBe(true);
      expect(dropZone.classList.contains("over")).toBe(true);
      // Moving onto a child of the zone fires dragleave on the zone; it stays marked.
      dropZone.dispatchEvent(dragEvent("dragleave", { relatedTarget: $("upBrowse") }));
      expect(dropZone.classList.contains("over")).toBe(true);
      dropZone.dispatchEvent(dragEvent("dragleave", { relatedTarget: document.body }));
      expect(dropZone.classList.contains("over")).toBe(false);
      dropZone.dispatchEvent(dragEvent("dragover"));
      expect(dropZone.classList.contains("over")).toBe(true);
      const file = new File(["data"], "clip.mp4");
      const dropped = dragEvent("drop", { dataTransfer: { files: [file] } });
      dropZone.dispatchEvent(dropped);
      expect(dropped.defaultPrevented).toBe(true);
      expect(dropZone.classList.contains("over")).toBe(false);
      expect(FakeXhr.last.body).toBe(file);
      expect(FakeXhr.last.url).toBe("/api/media/upload?fit=crop");
    });
  });

  it("keeps a file dropped beside the zone from replacing the page, and does not upload it", async () => {
    await withXhr(async () => {
      await openPage();
      FakeXhr.last = undefined;
      for (const type of ["dragover", "drop"]) {
        const event = dragEvent(type, { dataTransfer: { files: [new File(["data"], "clip.mp4")] } });
        $("hero").dispatchEvent(event);
        expect(event.defaultPrevented, type).toBe(true);
      }
      expect(FakeXhr.last).toBeUndefined();
      expect($("dropZone").classList.contains("over")).toBe(false);
    });
  });

  it("plays the finished file alone: the list is fetched again, the file ticked, the mode Single", async () => {
    const daemon = await openPage(
      makeDaemon({
        config: { media: [LIVE, CUSTOM[0]], playMode: "Cycle" },
        upload: { ...SNAPSHOT, state: "pushing" },
      }),
    );
    const name = "2026-10-27_12-00-00-000_clip.mp4";
    // What ryuod's Upload.process does at the end: the list gains the file, which plays alone.
    daemon.mediaLists.custom.push(name);
    daemon.config.media = [name];
    daemon.config.playMode = "Single";
    daemon.upload = { ...SNAPSHOT, state: "done", action: "copy", name, applied: true, acked: true };
    await tick(1000);
    expect(daemon.gets("/api/media").map((call) => call.query)).toEqual(["", ""]);
    expect(checked()).toEqual([name]);
    expect($("playMode").value).toBe("Single");
    expect($("upStatus").textContent).toBe(`Playing ${name}, sent as it was`);
  });
});

describe("Apply on a playlist of several files", () => {
  const multi = () => makeDaemon({ config: { media: [LIVE, CUSTOM[1]], playMode: "Cycle" } });

  it("moves the focus to Replace when it asks, and back to Apply on Cancel, as the old page did", async () => {
    await openPage(multi());
    thumb(CUSTOM[0]).click();
    $("pvApply").click();
    expect(document.activeElement).toBe($("pvReplace"));
    $("pvCancel").click();
    expect(document.activeElement).toBe($("pvApply"));
  });

  it("keeps the preview and the ticks when ryuod refuses Replace", async () => {
    const daemon = await openPage(multi());
    thumb(CUSTOM[0]).click();
    $("pvApply").click();
    daemon.replyOnce("POST /api/media/select", { status: 503, body: { ok: false, error: "cooler busy" } });
    $("pvReplace").click();
    await tick(0);
    expect($("result").textContent).toBe(`${CUSTOM[0]} not applied: cooler busy`);
    expect(checked()).toEqual([CUSTOM[1], LIVE]);
    expect([$("previewBar").hidden, $("pvApply").hidden, $("pvAsk").hidden]).toEqual([false, false, true]);
    $("pvApply").click();
    $("pvReplace").click();
    await tick(0);
    expect(checked()).toEqual([CUSTOM[0]]);
    expect($("previewBar").hidden).toBe(true);
    expect($("liveText").textContent).toBe(`Live · ${CUSTOM[0]}`);
  });
});

describe("Delete", () => {
  const state = (name) => {
    const button = delButton(name);
    return [button.textContent, button.className, button.getAttribute("aria-label")];
  };

  it("drops a pending second click on a new media list, and keeps it through a state poll", async () => {
    const daemon = await openPage();
    delButton(CUSTOM[0]).click();
    $("refresh").click();
    await tick(0);
    expect(state(CUSTOM[0])).toEqual(["", "del", `Delete ${CUSTOM[0]}`]);
    delButton(CUSTOM[0]).click();
    await tick(1000);
    const armed = `Really delete ${CUSTOM[0]}? Click again to delete it.`;
    expect(state(CUSTOM[0])).toEqual(["Really delete?", "del armed", armed]);
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect(daemon.posts("/api/media/delete")).toEqual([{ names: [CUSTOM[0]] }]);
    expect(tile(CUSTOM[0])).toBeUndefined();
  });

  // The old page rebuilt every tile when Apply or Replace played a file, which dropped a pending
  // second click; a click meant for the old tiles must not delete from the new ones.
  it.each([
    ["Apply", [LIVE], ["pvApply"]],
    ["Replace", [LIVE, CUSTOM[1]], ["pvApply", "pvReplace"]],
  ])("drops a pending second click when %s plays a file", async (_name, media, clicks) => {
    const daemon = await openPage(makeDaemon({ config: { media } }));
    delButton(CUSTOM[0]).click();
    expect(state(CUSTOM[0])[0]).toBe("Really delete?");
    thumb(PRESET[0]).click();
    for (const id of clicks) $(id).click();
    await tick(0);
    expect(daemon.posts("/api/media/select")).toEqual([{ media: [PRESET[0]], playMode: "Single" }]);
    expect(state(CUSTOM[0])).toEqual(["", "del", `Delete ${CUSTOM[0]}`]);
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect(daemon.posts("/api/media/delete")).toEqual([]);
    expect(state(CUSTOM[0])[0]).toBe("Really delete?");
  });

  // The old page's showOnPanel rebuilt the tiles only after ryuod took the file, so a refused
  // Apply left the armed button as it was; the second click still deletes.
  it("keeps a pending second click when ryuod refuses Apply", async () => {
    const daemon = await openPage();
    delButton(CUSTOM[0]).click();
    thumb(PRESET[0]).click();
    daemon.replyOnce("POST /api/media/select", { status: 503, body: { ok: false, error: "cooler busy" } });
    $("pvApply").click();
    await tick(0);
    expect($("result").textContent).toBe(`${PRESET[0]} not applied: cooler busy`);
    expect(state(CUSTOM[0])[0]).toBe("Really delete?");
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect(daemon.posts("/api/media/delete")).toEqual([{ names: [CUSTOM[0]] }]);
  });

  // Only Apply and Replace raise AppState.applied. A playlist tick and Restart video post the
  // same route, but the old page did not rebuild its tiles for them, so the armed button stays.
  it("keeps a pending second click through a playlist tick and Restart video", async () => {
    const daemon = await openPage();
    delButton(CUSTOM[0]).click();
    box(CUSTOM[1]).click();
    await tick(400);
    $("play").click();
    await tick(0);
    expect(daemon.posts("/api/media/select")).toHaveLength(2);
    expect(state(CUSTOM[0])[0]).toBe("Really delete?");
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect(daemon.posts("/api/media/delete")).toEqual([{ names: [CUSTOM[0]] }]);
  });

  it("drops a Delete armed during another file's failed delete", async () => {
    const daemon = await openPage();
    daemon.replyOnce("POST /api/media/delete", { status: 503, body: { ok: false, error: "adb: no devices" } });
    delButton(CUSTOM[0]).click(); delButton(CUSTOM[0]).click(); delButton(CUSTOM[1]).click();
    await tick(0);
    expect(state(CUSTOM[1])).toEqual(["", "del", `Delete ${CUSTOM[1]}`]);
  });

  // The old deleteMedia's renderMedia after a failure rebuilt the failed file's tile too: a plain,
  // enabled Delete whose next click only arms it.
  it("leaves the failed file's own Delete plain, so the next click asks again", async () => {
    const daemon = await openPage();
    daemon.replyOnce("POST /api/media/delete", { status: 503, body: { ok: false, error: "adb: no devices" } });
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    expect(state(CUSTOM[0])[0]).toBe("Deleting…");
    expect(delButton(CUSTOM[0]).disabled).toBe(true);
    await tick(0);
    expect($("result").textContent).toBe(`${CUSTOM[0]} not deleted: adb: no devices`);
    expect(state(CUSTOM[0])).toEqual(["", "del", `Delete ${CUSTOM[0]}`]);
    expect(delButton(CUSTOM[0]).disabled).toBe(false);
    delButton(CUSTOM[0]).click();
    await tick(0);
    expect(state(CUSTOM[0])[0]).toBe("Really delete?");
    expect(daemon.posts("/api/media/delete")).toHaveLength(1);
  });

  // The success path disarms through the new media list in willUpdate, not through the fix's
  // `false`; the old page's renderMedia after the delete dropped it the same way.
  it("drops a Delete armed during another file's delete that went through", async () => {
    const daemon = await openPage();
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[1]).click();
    expect(state(CUSTOM[1])[0]).toBe("Really delete?");
    await tick(0);
    expect(tile(CUSTOM[0])).toBeUndefined();
    expect(state(CUSTOM[1])).toEqual(["", "del", `Delete ${CUSTOM[1]}`]);
    delButton(CUSTOM[1]).click();
    await tick(0);
    expect(daemon.posts("/api/media/delete")).toEqual([{ names: [CUSTOM[0]] }]);
  });

  // ryuod down is a fetch that throws, not a refusal; deleteMedia's catch returns false for both.
  it("drops a Delete armed during a delete ryuod never answered", async () => {
    const daemon = await openPage();
    delButton(CUSTOM[0]).click();
    daemon.down = true;
    delButton(CUSTOM[0]).click();
    delButton(CUSTOM[1]).click();
    await tick(0);
    expect($("result").textContent).toBe(`${CUSTOM[0]} not deleted: Failed to fetch`);
    expect(state(CUSTOM[1])).toEqual(["", "del", `Delete ${CUSTOM[1]}`]);
  });
});

describe("the hero, as the old renderHero drew it", () => {
  /** The old page's top-level function `name`, as source. */
  function oldFunction(name) {
    const source = OLD_PAGE.match(new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0];
    if (!source) throw new Error(`fixtures/old-page.js has no function ${name}`);
    return source;
  }
  function oldLine(start) {
    const source = OLD_PAGE.match(new RegExp(`\\n${start}[^\\n]*\\n`))?.[0];
    if (!source) throw new Error(`fixtures/old-page.js has no line starting ${start}`);
    return source;
  }

  /** What an old render function wrote to one element. */
  function written() {
    const classes = new Set();
    return {
      hidden: false,
      disabled: false,
      title: "",
      textContent: "",
      className: "",
      dataset: {},
      attributes: {},
      classes,
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      getAttribute(name) {
        return this.attributes[name] ?? null;
      },
      classList: {
        toggle(name, on) {
          if (on) classes.add(name);
          else classes.delete(name);
        },
      },
    };
  }

  /**
   * The old renderHero with the functions that call it on a poll (renderPanel, and showDown while
   * ryuod is down) and the globals they read, set from one store state. setHeroMedia is replaced
   * by a recorder: the media elements themselves are checked in "the hero's <video> and <img>".
   */
  function loadOldHero() {
    const elements = new Map();
    const lookup = (id) => {
      if (!elements.has(id)) elements.set(id, written());
      return elements.get(id);
    };
    const source = `
      let displaySending = false, displayWant = false, lastDisplay = null, panelOn = null, panelSending = false;
      let unreachable = false, previewName = null, device = null, config = null, applyAsking = false, newApi = true;
      let mediaLists = { preset: [], custom: [] }, heroName = null;
      const setHeroMedia = (name) => { heroName = name; };
      ${oldLine("const liveName = ")}
      ${oldLine("const MIRROR_IN_STANDBY = ")}
      ${oldLine("const STANDBY_IN_MIRROR = ")}
      ${["renderHero", "showDown", "renderPanel", "renderPanelSwitch", "renderDisplaySwitch"].map(oldFunction).join("")}
      return (state) => {
        clear();
        unreachable = state.unreachable !== null;
        previewName = state.preview;
        applyAsking = state.applyAsking;
        displayWant = state.displayWant;
        lastDisplay = state.display;
        device = state.device;
        config = state.config;
        mediaLists = state.media;
        heroName = null;
        // pollState: renderPanel on every answer; while ryuod is down, showDown and nothing else.
        renderPanel(state.panel);
        if (unreachable) showDown(state.unreachable);
        return { $, heroName };
      };`;
    return new Function("$", "clear", source)(lookup, () => elements.clear());
  }

  /** The file a media src names, or null. */
  const fileOf = (element) => {
    const src = element.getAttribute("src");
    return src ? new URLSearchParams(src.split("?")[1]).get("name") : null;
  };

  /** What the hero shows, read the same way from the old records and the Lit page's DOM. */
  function shown(lookup, file) {
    const view = lookup("hero").dataset.view;
    const hidden = (id) => lookup(id).hidden;
    const seen = {
      view,
      hidden: ["standbyView", "panelOffView", "mirrorView", "previewBar", "liveChip"].map(hidden),
      liveDot: lookup("liveDot").className,
      liveText: lookup("liveText").textContent,
      hint: lookup("heroHint").textContent,
      file,
      turnOn: lookup("panelTurnOn").disabled,
    };
    // The old page wrote these only in the view that shows them.
    if (view === "down") seen.standbyText = lookup("standbyText").textContent;
    if (view === "preview") {
      const bar = lookup("previewBar");
      seen.preview = {
        name: [lookup("pvName").textContent, lookup("pvName").title],
        apply: [lookup("pvApply").getAttribute("aria-label"), lookup("pvApply").title],
        ask: [lookup("pvAskLong").textContent, lookup("pvAskShort").textContent],
        asking: bar.classes ? bar.classes.has("asking") : bar.classList.contains("asking"),
        hidden: ["pvNote", "pvApply", "pvClose", "pvAsk", "pvReplace", "pvCancel"].map(hidden),
        note: lookup("pvNote").textContent,
      };
    }
    return seen;
  }

  const display = (state, on) => ({ ...defaultDisplay(), state, on });
  const DISPLAYS = [
    null,
    display("off", false),
    display("starting", true),
    display("on", true),
    display("stopping", false),
    display("retrying", true),
    display("error", false),
  ];

  /** Every input in `matrix` against both pages; each mismatch names its input. */
  async function compare(matrix) {
    const daemon = await openPage();
    const oldHero = loadOldHero();
    const media = store().state.media;
    const mismatches = [];
    const views = new Set();
    for (const input of matrix) {
      const state = { ...input, media };
      store().patch(state);
      const lit = shown($, fileOf($("heroVideo")) ?? fileOf($("heroImage")));
      const old = oldHero(state);
      const before = shown(old.$, old.heroName);
      views.add(before.view);
      if (JSON.stringify(before) !== JSON.stringify(lit)) {
        mismatches.push(`${JSON.stringify(input)}\n  old ${JSON.stringify(before)}\n  new ${JSON.stringify(lit)}`);
      }
    }
    // Stray polls would mix ryuod's state into the matrix's.
    expect(daemon.gets("/api/state")).toHaveLength(1);
    return { mismatches, views };
  }

  it("agrees on the view and the preview bar over ryuod down, panel, mirror, preview and Apply's question", async () => {
    const config = { ...makeDaemon().config, media: [LIVE, CUSTOM[1]] };
    const device = defaultDevice();
    const matrix = [];
    for (const unreachable of [null, "Failed to fetch"])
      for (const panel of [null, { on: true }, { on: false }])
        for (const status of DISPLAYS)
          for (const displayWant of [false, true])
            for (const preview of [null, CUSTOM[0], CUSTOM[1]])
              for (const applyAsking of [false, true])
                matrix.push({ unreachable, panel, display: status, displayWant, preview, applyAsking, config, device });
    const { mismatches, views } = await compare(matrix);
    expect(matrix).toHaveLength(504);
    // Without this, a stub that drew nothing would agree with a page that drew nothing.
    expect([...views].sort()).toEqual(["down", "live", "mirror", "preview", "standby"]);
    expect(mismatches).toEqual([]);
  });

  it("agrees on the live chip, the hint and the file for each playlist and cooler connection", async () => {
    const base = makeDaemon().config;
    const matrix = [];
    for (const media of [[LIVE], [CUSTOM[0]], [CUSTOM[1], PRESET[0]], ["gone.mp4"], []])
      for (const connected of [true, false])
        for (const preview of [null, CUSTOM[0]])
          for (const panel of [{ on: true }, { on: false }])
            for (const unreachable of [null, "Failed to fetch"])
              matrix.push({
                unreachable,
                panel,
                display: DISPLAYS[1],
                displayWant: false,
                preview,
                applyAsking: false,
                config: { ...base, media },
                device: { ...defaultDevice(), connected },
              });
    const { mismatches, views } = await compare(matrix);
    expect([...views].sort()).toEqual(["down", "live", "preview", "standby"]);
    expect(mismatches).toEqual([]);
  });
});
