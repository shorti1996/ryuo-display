/**
 * Features of a ryuod with the panel switch: POST /api/panel and the standby it holds commands
 * in, the tray settings (POST /api/tray), the screen-share reset and Display Configuration
 * buttons, and preset previews. A ryuod without them (legacy) gets none of these controls.
 */
import { describe, expect, it } from "vitest";

import { $, CUSTOM, PRESET, choose, makeDaemon, openPage, setInput, tick } from "./harness.js";

const checkedAttr = (id) => $(id).getAttribute("aria-checked");
const MIRROR_IN_STANDBY = "the panel is in standby; turn it on before the second display";
const STANDBY_IN_MIRROR = "the panel shows the second display; turn that off before standby";
const tile = (name) => [...document.querySelectorAll(".tile")].find((t) => t.dataset.name === name);
const box = (name) => tile(name).querySelector("input[type=checkbox]");
const chips = () => [...$("traySteps").querySelectorAll(".step")].map((c) => c.textContent);

describe("panel switch", () => {
  it("shows On in the header", async () => {
    await openPage();
    expect($("panelSwitch").hidden).toBe(false);
    expect(checkedAttr("panelSwitch")).toBe("true");
    expect($("panelLabel").textContent).toBe("On");
    expect($("panelSwitch").disabled).toBe(false);
  });

  it("sends the panel to standby: the hero goes black with Turn on, and the mirror is locked out", async () => {
    const d = await openPage();
    $("panelSwitch").click();
    await tick(0);
    expect(d.posts("/api/panel")).toEqual([{ on: false }]);
    expect(checkedAttr("panelSwitch")).toBe("false");
    expect($("panelLabel").textContent).toBe("Standby");
    expect($("hero").dataset.view).toBe("standby");
    expect($("panelOffView").hidden).toBe(false);
    expect($("standbyView").hidden).toBe(true);
    expect($("heroVideo").hasAttribute("src")).toBe(false);
    expect($("result").textContent).toBe("Panel: standby — acked by the cooler");
    for (const id of ["modeMirror", "displaySwitch"]) {
      expect($(id).disabled).toBe(true);
      expect($(id).title).toBe(MIRROR_IN_STANDBY);
    }
    expect($("modeStats").disabled).toBe(false);
  });

  it("Turn on in the hero brings the panel back", async () => {
    const d = await openPage(makeDaemon({ panel: { on: false } }));
    expect($("panelOffView").hidden).toBe(false);
    $("panelTurnOn").click();
    await tick(0);
    expect(d.posts("/api/panel")).toEqual([{ on: true }]);
    expect($("panelOffView").hidden).toBe(true);
    expect($("hero").dataset.view).toBe("live");
    expect($("modeMirror").disabled).toBe(false);
    expect($("result").textContent).toBe("Panel: on — acked by the cooler");
  });

  it("follows a standby set by another client (the tray)", async () => {
    const d = await openPage();
    d.panel.on = false;
    await tick(1000);
    expect($("panelLabel").textContent).toBe("Standby");
    expect($("panelOffView").hidden).toBe(false);
  });

  it("is disabled while the panel shows the second display, with ryuod's reason", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "on", fps: 60, mbps: 9 } }));
    expect($("panelSwitch").disabled).toBe(true);
    expect($("panelSwitch").title).toBe(STANDBY_IN_MIRROR);
  });

  it("goes back and shows ryuod's refusal", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/panel", { status: 409, body: { ok: false, error: STANDBY_IN_MIRROR } });
    $("panelSwitch").click();
    await tick(0);
    expect(checkedAttr("panelSwitch")).toBe("true");
    expect($("panelOffView").hidden).toBe(true);
    expect($("result").textContent).toBe(`Panel: ${STANDBY_IN_MIRROR}`);
  });

  it("keeps ryuod-not-answering apart from standby", async () => {
    const d = await openPage(makeDaemon({ panel: { on: false } }));
    d.down = true;
    await tick(1000);
    expect($("standbyView").hidden).toBe(false);
    expect($("panelOffView").hidden).toBe(true);
  });

  it("is hidden for an older ryuod, which has no panel switch", async () => {
    await openPage(makeDaemon({ legacy: true }));
    expect($("panelSwitch").hidden).toBe(true);
    expect($("panelOffView").hidden).toBe(true);
    expect($("modeMirror").disabled).toBe(false);
  });
});

describe("changes during standby", () => {
  const STANDBY = { panel: { on: false } };

  it("brightness says it is saved for when the panel turns on, not an error", async () => {
    const d = await openPage(makeDaemon(STANDBY));
    setInput($("brightness"), "50");
    await tick(150);
    expect(d.posts("/api/brightness")).toEqual([{ percent: 50 }]);
    expect($("result").textContent).toBe("Brightness: nothing sent — saved; applies when the panel turns on");
    expect($("result").style.color).toBe("var(--muted)");
  });

  it("an overlay edit says the same", async () => {
    await openPage(makeDaemon(STANDBY));
    choose($("slot4"), "GPU Load");
    await tick(300);
    expect($("result").textContent).toBe("Overlay: nothing sent — saved; applies when the panel turns on");
  });

  it("a playlist change says the same and restarts nothing", async () => {
    await openPage(makeDaemon(STANDBY));
    box(CUSTOM[0]).click();
    await tick(400);
    expect($("result").textContent).toBe("Play: nothing sent — saved; applies when the panel turns on");
  });

  it("a preview still shows, and says the panel is in standby", async () => {
    await openPage(makeDaemon(STANDBY));
    tile(CUSTOM[0]).querySelector("button.thumb").click();
    expect($("hero").dataset.view).toBe("preview");
    expect($("panelOffView").hidden).toBe(true);
    expect($("pvNote").textContent).toBe("panel in standby");
  });

  it("a finished upload says it applies when the panel turns on", async () => {
    await openPage(makeDaemon({
      ...STANDBY,
      upload: {
        state: "done", file: "clip.mp4", name: "2026-10-27_12-00-00-000_clip.mp4", action: "copy", applied: false,
        acked: false, heldByDisplay: false, heldByStandby: true, startedAt: 1, progress: null,
      },
    }));
    expect($("upStatus").textContent).toBe("Selected 2026-10-27_12-00-00-000_clip.mp4 (applies when the panel turns on), sent as it was");
  });
});

describe("tray settings", () => {
  it("show the saved settings in the App tab", async () => {
    await openPage();
    expect($("trayCard").hidden).toBe(false);
    expect(checkedAttr("trayAutostart")).toBe("true");
    expect([...$("trayClick").options].map((o) => [o.value, o.textContent])).toEqual([
      ["page", "Open control page"], ["menu", "Show menu"], ["panel", "Toggle panel on/standby"], ["stats", "Toggle stats overlay"],
    ]);
    expect($("trayClick").value).toBe("page");
    expect(chips()).toEqual(["25 %", "50 %", "75 %", "100 %"]);
    expect($("traySteps").querySelector(".step button").getAttribute("aria-label")).toBe("Remove 25 %");
  });

  it("Start with the desktop session posts the opposite of its state", async () => {
    const d = await openPage();
    $("trayAutostart").click();
    await tick(0);
    expect(d.posts("/api/tray")).toEqual([{ autostart: false }]);
    expect(checkedAttr("trayAutostart")).toBe("false");
    expect($("result").textContent).toBe("Tray: saved; the tray picks it up within 3 s");
  });

  it("posts the left-click action", async () => {
    const d = await openPage();
    choose($("trayClick"), "panel");
    await tick(0);
    expect(d.posts("/api/tray")).toEqual([{ leftClick: "panel" }]);
    expect(d.tray.leftClick).toBe("panel");
  });

  it("removes a step with its ×", async () => {
    const d = await openPage();
    $("traySteps").querySelectorAll(".step button")[1].click();
    await tick(0);
    expect(d.posts("/api/tray")).toEqual([{ brightnessSteps: [25, 75, 100] }]);
    expect(chips()).toEqual(["25 %", "75 %", "100 %"]);
  });

  it("keeps the last step: its × is disabled", async () => {
    await openPage(makeDaemon({ tray: { brightnessSteps: [40] } }));
    const x = $("traySteps").querySelector(".step button");
    expect(x.disabled).toBe(true);
    expect(x.title).toBe("The tray menu needs at least one step");
  });

  it("adds a step, sorted, from the field + Add step opens", async () => {
    const d = await openPage();
    $("trayStepPlus").click();
    const n = $("trayStepNew");
    n.value = "60";
    n.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick(0);
    expect(d.posts("/api/tray")).toEqual([{ brightnessSteps: [25, 50, 60, 75, 100] }]);
    expect(chips()).toEqual(["25 %", "50 %", "60 %", "75 %", "100 %"]);
    expect($("trayStepNew")).toBeNull();
  });

  it.each([
    ["50", "Tray: 50 % is already a step"],
    ["0", "Tray: a step must be a whole number from 1 to 100"],
    ["101", "Tray: a step must be a whole number from 1 to 100"],
    ["12.5", "Tray: a step must be a whole number from 1 to 100"],
    ["", "Tray: a step must be a whole number from 1 to 100"],
  ])("refuses %j before sending, as ryuod would", async (value, message) => {
    const d = await openPage();
    $("trayStepPlus").click();
    $("trayStepNew").value = value;
    $("trayStepAdd").click();
    await tick(0);
    expect(d.posts("/api/tray")).toEqual([]);
    expect($("result").textContent).toBe(message);
    expect($("trayStepNew")).not.toBeNull();
  });

  it("disables + Add step at 8 steps", async () => {
    await openPage(makeDaemon({ tray: { brightnessSteps: [10, 20, 30, 40, 50, 60, 70, 80] } }));
    expect($("trayStepPlus").disabled).toBe(true);
    expect($("trayStepPlus").title).toBe("The tray menu takes at most 8 steps");
  });

  it("goes back to ryuod's settings when a POST fails", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/tray", { status: 500, body: { ok: false, error: "cannot remove /home/u/.config/autostart/ryuo-tray.desktop: Permission denied" } });
    $("trayAutostart").click();
    await tick(0);
    expect(checkedAttr("trayAutostart")).toBe("true");
    expect($("result").textContent).toBe("Tray: cannot remove /home/u/.config/autostart/ryuo-tray.desktop: Permission denied");
  });

  it("follows a change made elsewhere", async () => {
    const d = await openPage();
    d.tray.leftClick = "stats";
    d.tray.brightnessSteps = [30, 60];
    await tick(1000);
    expect($("trayClick").value).toBe("stats");
    expect(chips()).toEqual(["30 %", "60 %"]);
  });

  it("is hidden for an older ryuod", async () => {
    await openPage(makeDaemon({ legacy: true }));
    expect($("trayCard").hidden).toBe(true);
  });
});

describe("screen-share choice", () => {
  it("Ask again deletes the saved choice", async () => {
    const d = await openPage();
    expect($("askAgain").hidden).toBe(false);
    expect($("askAgain").disabled).toBe(false);
    expect($("choiceText").textContent).toBe("A screen-share choice is saved, so starts skip the question. Ask again deletes it.");
    $("askAgain").click();
    await tick(0);
    expect(d.posts("/api/display/reset-choice")).toEqual([{}]);
    expect($("result").textContent).toBe("Screen-share choice deleted; the next start of the second display asks again");
    expect($("askAgain").disabled).toBe(true);
    expect($("choiceText").textContent).toBe("No screen-share choice is saved; the next start asks which screen to share.");
  });

  it("is disabled with nothing saved", async () => {
    await openPage(makeDaemon({ desktop: { portalTokenSaved: false } }));
    expect($("askAgain").disabled).toBe(true);
  });

  it("is disabled while the second display starts, with ryuod's reason", async () => {
    await openPage(makeDaemon({ display: { on: true, state: "starting" } }));
    expect($("askAgain").disabled).toBe(true);
    expect($("askAgain").title).toBe("the second display is starting; try again once it is on or off");
  });

  it("is hidden for an older ryuod", async () => {
    await openPage(makeDaemon({ legacy: true }));
    expect($("askAgain").hidden).toBe(true);
    expect($("choiceText").hidden).toBe(true);
  });
});

describe("Open Display Configuration", () => {
  it("opens from the Desktop mirror tab and from the hero caption", async () => {
    const d = await openPage(makeDaemon({ display: { on: true, state: "on", fps: 60, mbps: 9 } }));
    expect($("displaySettingsRow").hidden).toBe(false);
    expect($("mirrorSettings").hidden).toBe(false);
    expect($("mirrorSettings").getAttribute("aria-label")).toBe("Open Display Configuration");
    $("displaySettingsOpen").click();
    await tick(0);
    $("mirrorSettings").click();
    await tick(0);
    expect(d.posts("/api/display/open-settings")).toEqual([{}, {}]);
    expect($("result").textContent).toBe("Opened Display Configuration (kcmshell6 kcm_kscreen)");
  });

  it("shows ryuod's reason when it cannot", async () => {
    const d = await openPage();
    d.replyOnce("POST /api/display/open-settings", { status: 503, body: { ok: false, error: "no Wayland session yet" } });
    $("displaySettingsOpen").click();
    await tick(0);
    expect($("result").textContent).toBe("Display Configuration: no Wayland session yet");
  });

  it("is hidden when neither kcmshell6 nor systemsettings is installed", async () => {
    await openPage(makeDaemon({ desktop: { displaySettings: null } }));
    expect($("displaySettingsRow").hidden).toBe(true);
    expect($("mirrorSettings").hidden).toBe(true);
  });

  it("is hidden for an older ryuod", async () => {
    await openPage(makeDaemon({ legacy: true }));
    expect($("displaySettingsRow").hidden).toBe(true);
  });
});

describe("preset previews", () => {
  it("preview a preset in the hero and apply it", async () => {
    const d = await openPage();
    tile(PRESET[0]).querySelector("button.thumb").click();
    expect($("heroVideo").getAttribute("src")).toBe(`/api/media/preview?name=${PRESET[0]}`);
    expect($("pvName").textContent).toBe(PRESET[0]);
    expect(tile(PRESET[0]).querySelector(".badge").textContent).toBe("Previewing");
    $("pvApply").click();
    await tick(0);
    expect(d.posts("/api/media/select")).toEqual([{ media: [PRESET[0]], playMode: "Single" }]);
    expect($("liveText").textContent).toBe(`Live · ${PRESET[0]}`);
    expect(box(PRESET[0]).checked).toBe(true);
  });

  it("drop to the old placeholders when ryuod is replaced by an older one", async () => {
    const d = await openPage();
    expect(tile(PRESET[0]).querySelector("button.thumb")).not.toBeNull();
    d.legacy = true;
    await tick(1000);
    expect(tile(PRESET[0]).querySelector("button")).toBeNull();
    expect($("panelSwitch").hidden).toBe(true);
    expect($("trayCard").hidden).toBe(true);
  });
});
