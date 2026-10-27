/**
 * The Overlay tab, the strip (overlay box, brightness, sample time) and the header's panel
 * switch on the Lit page (tests/harness-lit.js). The first four describe blocks are cases copied
 * unchanged from sync, errors and features.test.js, which stay on the old harness until the
 * Background and Mirror tabs are ported; the copies run the same assertions against the new
 * page now, and go when their source file moves. The rest cover what the new page does
 * differently or what no old test checks.
 */
import { describe, expect, it } from "vitest";

import { $, CUSTOM, choose, makeDaemon, openPage, option, preview, setInput, slot, tick } from "./harness-lit.js";

const checkedAttr = (id) => $(id).getAttribute("aria-checked");
const STANDBY_IN_MIRROR = "the panel shows the second display; turn that off before standby";

// From sync.test.js, all but its two playlist cases.
describe("another client's change", () => {
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

// From errors.test.js, all but the cases that read the hero's standby view, the Background tab's
// Restart video button or its media tiles. Its header cases were copied in step 1 (app-tab.test.js).
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

  it("keeps the last preview when a stats poll fails", async () => {
    const d = await openPage();
    d.replyOnce("GET /api/stats", { status: 500, text: "" });
    await tick(1000);
    expect($("ps1").children[1].textContent).toBe("50");
  });
});

describe("daemon down", () => {
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
});

// From features.test.js: the cases that read only the header switch, the strip and the toast.
describe("panel switch", () => {
  it("shows On in the header", async () => {
    await openPage();
    expect($("panelSwitch").hidden).toBe(false);
    expect(checkedAttr("panelSwitch")).toBe("true");
    expect($("panelLabel").textContent).toBe("On");
    expect($("panelSwitch").disabled).toBe(false);
  });

  it("is disabled while the panel shows the second display, with ryuod's reason", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 60, mbps: 9 } }));
    expect($("panelSwitch").disabled).toBe(true);
    expect($("panelSwitch").title).toBe(STANDBY_IN_MIRROR);
  });
});

describe("changes during standby", () => {
  const STANDBY = { panel: { on: false } };

  it("brightness says it is saved for when the panel turns on, not an error", async () => {
    const d = await openPage(makeDaemon(STANDBY));
    setInput($("brightness"), "50");
    await tick(150);
    expect(d.posts("/api/brightness")).toEqual([{ percent: 50 }]);
    expect($("result").textContent).toBe("Brightness 50 % saved; applies when the panel turns on");
    expect($("result").style.color).toBe("var(--muted)");
  });

  it("an overlay edit says the same", async () => {
    await openPage(makeDaemon(STANDBY));
    choose($("slot4"), "GPU Load");
    await tick(300);
    expect($("result").textContent).toBe("Slot 5: GPU Load saved; applies when the panel turns on");
  });
});

describe("messages", () => {
  it("say when the cooler took a command without confirming it", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/brightness", {
      status: 200, body: { ok: true, applied: true, acked: false, sent: ["POST brightness"], restartsVideo: false, value: 51, percent: 50 },
    });
    setInput($("brightness"), "50");
    await tick(150);
    expect($("result").textContent).toBe("Brightness 50 % sent; the cooler did not confirm it");
    expect($("toast").title).toBe("Sent: POST brightness");
  });

  it("say a panel switch already there is already there", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/panel", { status: 200, body: { ok: true, applied: false, acked: false, changed: false, sent: [], restartsVideo: false, panel: { on: false } } });
    $("panelSwitch").click();
    await tick(0);
    expect($("result").textContent).toBe("The panel is already in standby");
  });

  it("say the panel switch waits for a cooler that is not connected", async () => {
    await openPage(makeDaemon({ device: { connected: false } }));
    $("panelSwitch").click();
    await tick(0);
    expect($("result").textContent).toBe("Panel in standby saved; applies when the cooler reconnects");
  });

  it("say what a hidden Memory Frequency means", async () => {
    await openPage(makeDaemon({ config: { memoryMHz: 6000 } }));
    $("memMHz").value = "0";
    $("memMHz").dispatchEvent(new Event("change"));
    await tick(0);
    expect($("result").textContent).toBe("Memory MHz 0 saved; Memory Frequency is hidden from the slot lists");
  });

  it("name the overlay change", async () => {
    await openPage();
    $("statsOn").click();
    await tick(300);
    expect($("result").textContent).toBe("Stats overlay hidden, slot choices kept — cooler confirmed");
    expect($("toast").title).toBe("Sent: POST preset");
  });
});

/**
 * Hold every POST to `path` until the returned `answer()` is called, so a test can look at the
 * page while the POST is pending. The request reaches the fake daemon only on answer().
 */
function holdPosts(path) {
  const serve = window.fetch;
  const waiting = [];
  globalThis.fetch = window.fetch = (url, options = {}) => {
    if (options.method !== "POST" || String(url) !== path) return serve(url, options);
    return new Promise((resolve) => waiting.push(() => resolve(serve(url, options))));
  };
  return async () => {
    for (const release of waiting.splice(0)) release();
    await tick(0);
  };
}

// The old page compared a poll with what it last saw per group of controls, and held a group
// while its debounce or POST was pending; the store holds keys (actions.ts).
describe("the poll and the controls the user is on", () => {
  it("leaves the slider while its POST is pending, and takes ryuod's answer after", async () => {
    const daemon = await openPage();
    const answer = holdPosts("/api/brightness");
    setInput($("brightness"), "17");
    await tick(150);
    daemon.config.brightness = 60; // another client, seen by the poll while the POST waits
    await tick(1000);
    expect($("brightness").value).toBe("17");
    await answer();
    // 17 % is device value 17, which lights 42/255 = 16 %.
    expect(daemon.posts("/api/brightness")).toEqual([{ percent: 17 }]);
    expect($("brightness").value).toBe("16");
  });

  it("leaves the opacity slider while it is dragged", async () => {
    const daemon = await openPage(makeDaemon({ config: { filter: { on: true, opacity: 100 } } }));
    $("opacity").dispatchEvent(new Event("pointerdown"));
    daemon.config.filter = { on: true, opacity: 30 };
    await tick(1000);
    expect($("opacity").value).toBe("100");
    window.dispatchEvent(new Event("pointerup"));
    await tick(1000);
    expect($("opacity").value).toBe("30");
    expect($("opacityOut").textContent).toBe("30 %");
  });

  it("leaves a focused colour input, whose picker may be open, until it loses focus", async () => {
    const daemon = await openPage();
    $("contentColor").focus();
    daemon.config.contentColor = "#00FF00";
    await tick(1000);
    expect($("contentColor").value).toBe("#ffffff");
    $("contentColor").blur();
    await tick(1000);
    expect($("contentColor").value).toBe("#00ff00");
    expect($("contentHex").textContent).toBe("#00FF00");
  });

  it("brings another client's colour once the overlay POST is answered", async () => {
    const daemon = await openPage();
    const answer = holdPosts("/api/overlay");
    choose(slot(4), "GPU Load");
    await tick(300);
    daemon.config.contentColor = "#00FF00";
    await tick(1000);
    expect($("contentColor").value).toBe("#ffffff");
    await answer();
    // The POST carried the page's #FFFFFF and the daemon took it, so there is nothing to bring.
    expect(daemon.config.contentColor).toBe("#FFFFFF");
    daemon.config.contentColor = "#123456";
    await tick(1000);
    expect($("contentColor").value).toBe("#123456");
  });
});

describe("the panel switch on the new page", () => {
  it("is hidden until the first state poll answers", async () => {
    const daemon = makeDaemon();
    daemon.down = true;
    await openPage(daemon);
    expect($("panelSwitch").hidden).toBe(true);
    daemon.down = false;
    await tick(1000);
    expect($("panelSwitch").hidden).toBe(false);
  });

  it("shows the click at once and is disabled until ryuod answers", async () => {
    const daemon = await openPage();
    const answer = holdPosts("/api/panel");
    $("panelSwitch").click();
    expect(checkedAttr("panelSwitch")).toBe("false");
    expect($("panelLabel").textContent).toBe("Standby");
    expect($("panelSwitch").disabled).toBe(true);
    await tick(1000); // ryuod still says on; the poll leaves the switch while the POST runs
    expect(checkedAttr("panelSwitch")).toBe("false");
    await answer();
    expect(daemon.posts("/api/panel")).toEqual([{ on: false }]);
    expect($("panelSwitch").disabled).toBe(false);
    expect($("result").textContent).toBe("Panel in standby — cooler confirmed");
  });

  it("goes back and shows ryuod's refusal", async () => {
    const daemon = await openPage();
    daemon.replyOnce("POST /api/panel", { status: 409, body: { ok: false, error: STANDBY_IN_MIRROR } });
    $("panelSwitch").click();
    await tick(0);
    expect(checkedAttr("panelSwitch")).toBe("true");
    expect($("panelLabel").textContent).toBe("On");
    expect($("result").textContent).toBe(`Panel not put in standby: ${STANDBY_IN_MIRROR}`);
  });

  it("follows a standby set by another client (the tray)", async () => {
    const daemon = await openPage();
    daemon.panel.on = false;
    await tick(1000);
    expect($("panelLabel").textContent).toBe("Standby");
    expect(checkedAttr("panelSwitch")).toBe("false");
  });
});

// No old test covers the outline that links a slot row to its place on the panel.
describe("a slot row under the pointer", () => {
  it("outlines its slot in the preview, and an empty slot shows its number", async () => {
    await openPage();
    $("slotRow4").dispatchEvent(new Event("mouseenter"));
    expect($("slotRow4").classList.contains("hot")).toBe(true);
    expect($("ps5").classList.contains("hot")).toBe(true);
    expect(preview(5).title).toBe("Slot 5");
    $("slotRow4").dispatchEvent(new Event("mouseleave"));
    expect($("ps5").classList.contains("hot")).toBe(false);
    expect(preview(5).title).toBe("");
  });

  it("stays outlined while its select has focus", async () => {
    await openPage();
    slot(0).focus();
    $("slotRow0").dispatchEvent(new Event("mouseenter"));
    $("slotRow0").dispatchEvent(new Event("mouseleave"));
    expect($("ps1").classList.contains("hot")).toBe(true);
    slot(0).blur();
    expect($("ps1").classList.contains("hot")).toBe(false);
  });
});

describe("the strip", () => {
  it("disables the overlay box while the panel shows the second display", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 60, mbps: 9 } }));
    expect($("statsOn").disabled).toBe(true);
    expect($("statsOnLabel").className).toBe("check off");
    expect($("statsOnLabel").title).toBe("The panel shows the desktop; the overlay returns when the second display is off.");
  });

  it("shows the sample time from the stats poll", async () => {
    await openPage();
    expect($("sampled").textContent).toBe(`sampled ${new Date(Date.UTC(2026, 9, 22, 12, 5, 8)).toLocaleTimeString()}`);
  });
});
