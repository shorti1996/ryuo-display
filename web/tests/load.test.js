/**
 * Startup: the order of the first requests, the status header, and every control set from
 * GET /api/state's config.
 */
import { describe, expect, it } from "vitest";

import { $, makeDaemon, openPage, option, slot, slotSelects, tick } from "./harness-lit.js";

describe("initial load", () => {
  it("asks for catalog, state, media and stats, in that order", async () => {
    const d = await openPage();
    expect(d.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/catalog", "GET /api/state", "GET /api/media", "GET /api/stats",
    ]);
  });

  it("then polls state and stats every second and the catalog every 15 s", async () => {
    const d = await openPage();
    await tick(1000);
    expect(d.gets("/api/state")).toHaveLength(2);
    expect(d.gets("/api/stats")).toHaveLength(2);
    await tick(2000);
    expect(d.gets("/api/state")).toHaveLength(4);
    expect(d.gets("/api/catalog")).toHaveLength(1);
    await tick(12000);
    expect(d.gets("/api/catalog")).toHaveLength(2);
    expect(d.gets("/api/media")).toHaveLength(1);
  });

  it("shows the connection in the header pill and the details in the App tab", async () => {
    await openPage();
    expect($("connPill").className).toBe("pill ok");
    expect($("dot").className).toBe("dot ok");
    expect($("conn").textContent).toBe("Connected");
    expect($("connFw").textContent).toBe(" · V1.0.10");
    expect($("model").textContent).toBe("Ryuo IV Standard");
    expect($("fw").textContent).toBe("V1.0.10");
    expect($("hidraw").textContent).toBe("/dev/hidraw4");
    expect($("hb").textContent).toBe("0.4 s ago");
    expect($("ack").textContent).toBe("0.4 s ago");
    expect($("rec").textContent).toBe("0");
    expect($("err").textContent).toBe("");
    expect($("errRow").hidden).toBe(true);
  });

  it("formats ages over 10 s in whole seconds and missing ages as a dash", async () => {
    await openPage(makeDaemon({ device: { lastHeartbeatMs: 12345, lastHomeuiAckMs: null, recoveries: 2 } }));
    expect($("hb").textContent).toBe("12 s ago");
    expect($("ack").textContent).toBe("— ago");
    expect($("rec").textContent).toBe("2");
  });

  it("shows a cooler that is not connected, with the daemon's last error", async () => {
    await openPage(makeDaemon({ device: { connected: false, firmware: null, hidraw: null, lastError: "no RYUO IV hidraw found" } }));
    expect($("connPill").className).toBe("pill bad");
    expect($("dot").className).toBe("dot bad");
    expect($("conn").textContent).toBe("Not connected");
    expect($("connFw").textContent).toBe("");
    expect($("fw").textContent).toBe("—");
    expect($("hidraw").textContent).toBe("—");
    expect($("err").textContent).toBe("no RYUO IV hidraw found");
    expect($("errRow").hidden).toBe(false);
    expect($("connPill").title).toBe("no RYUO IV hidraw found");
  });

  it("hides a stale last error while the cooler is connected", async () => {
    await openPage(makeDaemon({ device: { lastError: "open /dev/hidraw8: Permission denied" } }));
    expect($("err").textContent).toBe("");
    expect($("errRow").hidden).toBe(true);
  });

  it("builds six slot selects with catalog options grouped CPU to Custom", async () => {
    await openPage();
    const sels = slotSelects();
    expect(sels.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Slot 1 · left, upper", "Slot 2 · left, lower", "Slot 3 · right, top",
      "Slot 4 · right, middle", "Slot 5 · right, bottom", "Slot 6 · centre-right, lower",
    ]);
    const groups = [...sels[0].querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual(["CPU", "GPU", "Memory", "Storage", "Board", "Clock", "Custom (unit RPM)"]);
    expect(sels[0].options[0].value).toBe("");
    expect(sels[0].options[0].textContent).toBe("(empty)");
    const custom = [...sels[0].querySelector('optgroup[label="Custom (unit RPM)"]').children].map((o) => o.value);
    expect(custom).toContain("Fan Speed Disk R MB/s");
  });

  it("marks unavailable items, GPU Usage and GPU Power in the option text", async () => {
    await openPage();
    expect(option(slot(4), "CPU Voltage").textContent).toBe("CPU Voltage (no source)");
    expect(option(slot(4), "GPU Usage").textContent).toBe("GPU Usage (same as GPU Load)");
    expect(option(slot(4), "GPU Power").textContent).toBe("GPU Power (drawn with °C unit)");
    expect(option(slot(4), "CPU Voltage").disabled).toBe(false);
  });

  it("selects each slot's item from the config", async () => {
    await openPage();
    expect(slotSelects().map((s) => s.value)).toEqual([
      "CPU Temperature", "GPU Temperature", "Fan Speed Disk R MB/s", "Date&Time", "", "",
    ]);
    expect(slotSelects().every((s) => !s.disabled)).toBe(true);
    expect($("statsOn").checked).toBe(true);
  });

  it("sets colours, filter, brightness, play mode, unit and memory MHz from the config", async () => {
    await openPage(makeDaemon({
      config: {
        titleColor: "#FF112233", contentColor: "#00FF80", filter: { on: true, opacity: 60 },
        brightness: 41, playMode: "Cycle", tempUnit: "Fahrenheit", memoryMHz: 6000,
      },
    }));
    // #AARRGGBB loses its alpha: <input type=color> holds #rrggbb only.
    expect($("titleColor").value).toBe("#112233");
    expect($("titleHex").textContent).toBe("#112233");
    expect($("contentColor").value).toBe("#00ff80");
    expect($("contentHex").textContent).toBe("#00FF80");
    expect($("filterOn").checked).toBe(true);
    expect($("opacity").value).toBe("60");
    expect($("opacity").disabled).toBe(false);
    expect($("opacityOut").textContent).toBe("60 %");
    expect($("brightness").value).toBe("40");  // % of the 255 levels: 41 lights 102/255
    expect($("brightOut").textContent).toBe("40 %");
    expect($("playMode").value).toBe("Cycle");
    const unit = [...document.querySelectorAll("input[name=unit]")].filter((r) => r.checked).map((r) => r.value);
    expect(unit).toEqual(["Fahrenheit"]);
    expect($("memMHz").value).toBe("6000");
  });

  it("disables the opacity slider while the filter is off", async () => {
    await openPage();
    expect($("filterOn").checked).toBe(false);
    expect($("opacity").disabled).toBe(true);
  });

  it("starts with the slots disabled when the saved config hides the stats", async () => {
    await openPage(makeDaemon({ config: { statsVisible: false } }));
    expect($("statsOn").checked).toBe(false);
    expect(slotSelects().every((s) => s.disabled)).toBe(true);
    // The saved choices are still shown, ready for re-enabling.
    expect(slot(0).value).toBe("CPU Temperature");
  });

  it("treats a config without statsVisible (older daemon) as visible", async () => {
    const d = makeDaemon();
    delete d.config.statsVisible;
    await openPage(d);
    expect($("statsOn").checked).toBe(true);
  });
});
