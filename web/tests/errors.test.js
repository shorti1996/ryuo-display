/**
 * Error paths: {ok:false,error} replies, non-JSON error pages, and a daemon that is down
 * (fetch rejects). The page reports the problem and keeps polling.
 */
import { describe, expect, it } from "vitest";

import { $, CUSTOM, PRESET, choose, makeDaemon, openPage, option, setInput, slot, tick } from "./harness.js";

describe("API errors", () => {
  it("shows a 400 from POST /api/overlay and recovers on the next edit", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/overlay", { status: 400, body: { ok: false, error: "titleColor must be #RRGGBB or #AARRGGBB" } });
    setInput($("titleColor"), "#00ff00");
    await tick(300);
    expect($("result").textContent).toBe("Title colour #00FF00 not saved: titleColor must be #RRGGBB or #AARRGGBB");
    expect($("result").style.color).toBe("var(--bad)");

    setInput($("titleColor"), "#0000ff");
    await tick(300);
    expect(d.posts("/api/overlay")).toHaveLength(2);
    expect($("result").textContent).toBe("Title colour #0000FF — cooler confirmed");
    expect($("result").style.color).toBe("var(--muted)");
  });

  it("shows 'HTTP <status>' for an error page that is not JSON", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/brightness", { status: 502, text: "<html>Bad Gateway</html>" });
    setInput($("brightness"), "50");
    await tick(150);
    expect($("result").textContent).toBe("Brightness not changed: HTTP 502");
  });

  it("treats a 200 with ok:false as an error", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/media/select", { status: 200, body: { ok: false, error: "playlist too long for one HID report" } });
    $("play").click();
    await tick(0);
    expect($("result").textContent).toBe("Playlist not changed: playlist too long for one HID report");
  });

  it("shows a 504 from the device worker", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/overlay", { status: 504, body: { ok: false, error: "device worker did not answer within 3 s" } });
    choose(slot(4), "GPU Load");
    await tick(300);
    expect($("result").textContent).toBe("Slot 5: GPU Load not saved: device worker did not answer within 3 s");
    // The edit stays in the UI, so the next change resends it.
    expect(slot(4).value).toBe("GPU Load");
    setInput($("opacity"), "50");
    await tick(300);
    expect(d.posts("/api/overlay")[1].items[4]).toBe("GPU Load");
  });

  it("shows a failed GET /api/state in the header and clears it on the next good poll", async () => {
    const d = await openPage();
    d.replyOnce("GET /api/state", { status: 200, body: { ok: false, error: "state unreadable" } });
    await tick(1000);
    expect($("dot").className).toBe("dot bad");
    expect($("conn").textContent).toBe("Daemon unreachable");
    expect($("err").textContent).toBe("state unreadable");
    expect($("standbyView").hidden).toBe(false);
    expect($("standbyText").textContent).toBe("state unreadable");
    await tick(1000);
    expect($("conn").textContent).toBe("Connected");
    expect($("standbyView").hidden).toBe(true);
    expect($("err").textContent).toBe("");
  });

  it("keeps the last preview when a stats poll fails", async () => {
    const d = await openPage();
    d.replyOnce("GET /api/stats", { status: 500, text: "" });
    await tick(1000);
    expect($("ps1").children[1].textContent).toBe("50");
  });
});

describe("daemon down", () => {
  it("shows the daemon as unreachable and keeps polling every second", async () => {
    const d = await openPage();
    d.down = true;
    await tick(1000);
    expect($("dot").className).toBe("dot bad");
    expect($("conn").textContent).toBe("Daemon unreachable");
    expect($("err").textContent).toBe("Failed to fetch");
    const before = d.gets("/api/state").length;
    await tick(3000);
    expect(d.gets("/api/state").length).toBe(before + 3);
    expect(d.gets("/api/stats").length).toBeGreaterThanOrEqual(before + 3);
  });

  it("reconnects in the header when the daemon comes back", async () => {
    const d = await openPage();
    d.down = true;
    await tick(2000);
    d.down = false;
    await tick(1000);
    expect($("dot").className).toBe("dot ok");
    expect($("conn").textContent).toBe("Connected");
    expect($("err").textContent).toBe("");
  });

  it("reports a failed edit while down, and the controls still work", async () => {
    const d = await openPage();
    d.down = true;
    choose(slot(4), "GPU Load");
    await tick(300);
    expect($("result").textContent).toBe("Slot 5: GPU Load not saved: Failed to fetch");
    d.down = false;
    choose(slot(5), "GPU Speed");
    await tick(300);
    expect(d.config.items.slice(4)).toEqual(["GPU Load", "GPU Speed"]);
  });

  it("starts with the daemon down, then fills the controls once it answers", async () => {
    const d = makeDaemon({ config: { brightness: 77 } });
    d.down = true;
    await openPage(d);
    expect($("conn").textContent).toBe("Daemon unreachable");
    expect($("result").textContent).toBe("Media list not loaded: Failed to fetch");
    expect($("brightOut").textContent).toBe("");

    d.down = false;
    await tick(1000);
    expect($("conn").textContent).toBe("Connected");
    expect($("brightness").value).toBe("75");  // 77 on the device scale, in %
    expect(slot(0).value).toBe("CPU Temperature");
    expect($("ps1").classList.contains("hidden")).toBe(false);
    // The catalog is retried every 15 s; by then the options are grouped normally.
    await tick(15000);
    expect(option(slot(0), "CPU Temperature").textContent).toBe("CPU Temperature");
  });

  it("labels the saved items normally as soon as the daemon answers", async () => {
    const d = makeDaemon();
    d.down = true;
    await openPage(d);
    d.down = false;
    await tick(1000);
    expect(option(slot(0), "CPU Temperature").textContent).toBe("CPU Temperature");
    expect(option(slot(4), "GPU Load")).toBeDefined();
  });

  it("loads the media list once the daemon answers", async () => {
    const d = makeDaemon();
    d.down = true;
    await openPage(d);
    d.down = false;
    await tick(5000);
    const names = [...document.querySelectorAll(".tile")].map((t) => t.dataset.name);
    expect(names).toEqual([...CUSTOM, ...PRESET]);
  });
});
