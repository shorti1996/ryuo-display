/**
 * Step 2 review cases on the Lit page (tests/harness-lit.js): what a poll may and may not change
 * while an overlay edit waits in its debounce or a colour input has focus, a colour saved as
 * #AARRGGBB, and the header's panel switch around a poll with no `panel` and a POST that fails.
 */
import { describe, expect, it } from "vitest";

import { $, choose, makeDaemon, openPage, option, preview, slot, tick } from "./harness-lit.js";

const checkedAttr = (id) => $(id).getAttribute("aria-checked");

/** The next GET /api/state reply as ryuod would send it, without `panel`. */
async function stateWithoutPanel(daemon) {
  const reply = await (await daemon.fetch("/api/state")).json();
  delete reply.panel;
  return reply;
}

describe("another client's colour during the overlay debounce", () => {
  it("is left out of the POST body, which carries the page's own colour", async () => {
    const daemon = await openPage();
    await tick(900);
    choose(slot(4), "GPU Load"); // the debounce fires at 1200 ms
    daemon.config.titleColor = "#00FF00"; // seen by the poll at 1000 ms, inside the debounce
    await tick(100);
    expect(daemon.gets("/api/state")).toHaveLength(2);
    expect($("titleColor").value).toBe("#e5252b");
    await tick(200);
    expect(daemon.posts("/api/overlay")).toEqual([
      {
        items: ["CPU Temperature", "GPU Temperature", "Fan Speed Disk R MB/s", "Date&Time", "GPU Load", ""],
        statsVisible: true,
        titleColor: "#E5252B",
        contentColor: "#FFFFFF",
        filter: { on: false, opacity: 100 },
      },
    ]);
  });

  it("arrives with the first poll after the debounce, when the POST was refused", async () => {
    const daemon = await openPage();
    await tick(900);
    choose(slot(4), "GPU Load");
    daemon.config.titleColor = "#00FF00";
    // Refused, so ryuod keeps the other client's colour and the page's last-seen one differs.
    daemon.replyOnce("POST /api/overlay", { status: 504, body: { ok: false, error: "device worker did not answer" } });
    await tick(300);
    expect(daemon.posts("/api/overlay")[0].titleColor).toBe("#E5252B");
    expect($("titleColor").value).toBe("#e5252b");
    await tick(800); // the poll at 2000 ms
    expect($("titleColor").value).toBe("#00ff00");
    expect($("titleHex").textContent).toBe("#00FF00");
    // The user's unsaved slot is a different key: ryuod's items have not changed, so it stays.
    // The old page applied the whole overlay group here and lost the slot; the new page keeps it.
    expect(slot(4).value).toBe("GPU Load");
  });
});

// Design doc, open question "Step 2: a focused control holds only its own key". The old page
// held the whole overlay group while any of its controls had focus, so it kept the slots too;
// this pins the new behaviour.
describe("a focused colour input with no debounce pending", () => {
  it("holds its colour, and another client's slots reach the selects and the preview", async () => {
    const daemon = await openPage();
    $("titleColor").focus();
    daemon.config.items = ["GPU Load", "", "", "", "", ""];
    daemon.config.titleColor = "#00FF00";
    await tick(1000);
    expect(slot(0).value).toBe("GPU Load");
    expect(preview(1).title).toBe("GPU");
    expect($("titleColor").value).toBe("#e5252b");
    $("titleColor").blur();
    await tick(1000);
    expect($("titleColor").value).toBe("#00ff00");
  });
});

describe("a colour saved as #AARRGGBB", () => {
  it("shows without its alpha in the input, the hex label and the preview", async () => {
    await openPage(makeDaemon({ config: { titleColor: "#80E5252B", contentColor: "#FF00FF00" } }));
    expect($("titleColor").value).toBe("#e5252b");
    expect($("titleHex").textContent).toBe("#E5252B");
    expect($("contentColor").value).toBe("#00ff00");
    expect($("contentHex").textContent).toBe("#00FF00");
    expect($("ps1").children[0].style.color).toBe("#e5252b");
    expect($("ps1").children[1].style.color).toBe("#00ff00");
  });
});

describe("the panel switch and the state poll", () => {
  it("hides for a poll without `panel` and shows again with the next one that has it", async () => {
    const daemon = await openPage();
    daemon.replyOnce("GET /api/state", { status: 200, body: await stateWithoutPanel(daemon) });
    await tick(1000);
    expect($("panelSwitch").hidden).toBe(true);
    daemon.panel.on = false;
    await tick(1000);
    expect($("panelSwitch").hidden).toBe(false);
    expect($("panelLabel").textContent).toBe("Standby");
  });

  it("goes back to standby when turning on fails, and the next poll agrees", async () => {
    const daemon = await openPage(makeDaemon({ panel: { on: false } }));
    daemon.replyOnce("POST /api/panel", { status: 500, body: { ok: false, error: "state.json: No space left on device" } });
    $("panelSwitch").click();
    expect($("panelLabel").textContent).toBe("On");
    await tick(0);
    expect(daemon.posts("/api/panel")).toEqual([{ on: true }]);
    expect(checkedAttr("panelSwitch")).toBe("false");
    expect($("panelLabel").textContent).toBe("Standby");
    expect($("panelSwitch").disabled).toBe(false);
    expect($("result").textContent).toBe("Panel not turned on: state.json: No space left on device");
    await tick(1000);
    expect($("panelLabel").textContent).toBe("Standby");
  });

  it("goes back when ryuod cannot be reached", async () => {
    const daemon = await openPage();
    daemon.down = true;
    $("panelSwitch").click();
    await tick(0);
    expect($("panelLabel").textContent).toBe("On");
    expect($("result").textContent).toBe("Panel not put in standby: Failed to fetch");
    daemon.down = false;
    await tick(1000);
    expect($("panelLabel").textContent).toBe("On");
  });

  it("shows ryuod's standby on the next poll when the POST failed but ryuod applied it", async () => {
    const daemon = await openPage();
    // A timeout the page sees as a failure, after which ryuod has in fact gone to standby.
    daemon.replyOnce("POST /api/panel", { status: 504, body: { ok: false, error: "device worker did not answer within 3 s" } });
    $("panelSwitch").click();
    daemon.panel.on = false;
    await tick(0);
    expect($("panelLabel").textContent).toBe("On");
    await tick(1000);
    expect($("panelLabel").textContent).toBe("Standby");
    expect(checkedAttr("panelSwitch")).toBe("false");
  });
});

describe("a memory MHz ryuod refuses", () => {
  it("keeps the typed value in the field and does not offer Memory Frequency", async () => {
    const daemon = await openPage();
    $("memMHz").value = "25000"; // ryuod.post_prefs takes 0-20000
    $("memMHz").dispatchEvent(new Event("change"));
    await tick(0);
    expect($("result").textContent).toBe("Memory MHz 25000 not saved: memoryMHz must be an integer 0-20000");
    expect(daemon.config.memoryMHz).toBe(0);
    expect($("memMHz").value).toBe("25000");
    expect(option(slot(0), "Memory Frequency")).toBeUndefined();
    await tick(1000);
    expect($("memMHz").value).toBe("25000");
    expect(option(slot(0), "Memory Frequency")).toBeUndefined();
  });
});
