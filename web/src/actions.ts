/**
 * One function per user action: the API call, the store update, and the message in the toast.
 * Elements call these directly. While a POST runs, its keys are held in `editing`, so a poll
 * that lands meanwhile does not put back the value the POST is replacing.
 */

import {
  postBrightness,
  postOpenSettings,
  postOverlay,
  postPanel,
  postPrefs,
  postResetChoice,
  postTray,
} from "./api.ts";
import type { Config, PrefsBody, TrayBody, TrayClick } from "./api-types.ts";
import { brightnessValue } from "./brightness.ts";
import { OVERLAY_KEYS, overlayBody, rgbHex } from "./overlay.ts";
import { report } from "./report.ts";
import { fail, type Poll, type Store } from "./state.ts";

export const OVERLAY_DEBOUNCE_MS = 300; // overlay edits within this window go out as one POST
export const BRIGHTNESS_DEBOUNCE_MS = 150; // the slider sends once it has rested this long
// Both brightness fields: the slider shows the percent, and a reply carries both.
const BRIGHTNESS_KEYS = ["brightness", "brightnessPercent"] as const;
// What a drag holds: a range under the pointer may rest between input events, and the poll
// must not move it back under the user's finger.
const DRAG_KEYS = { brightness: BRIGHTNESS_KEYS, opacity: ["filter"] } as const;

/** The overlay controls other than the slots, each with the sentence that names its change. */
export type OverlayControl = "statsOn" | "titleColor" | "contentColor" | "filterOn" | "opacity";
const OVERLAY_TEXT: Record<OverlayControl, (config: Config) => string> = {
  statsOn: (config) => (config.statsVisible ? "Stats overlay shown" : "Stats overlay hidden, slot choices kept"),
  titleColor: (config) => `Title colour ${rgbHex(config.titleColor).toUpperCase()}`,
  contentColor: (config) => `Value colour ${rgbHex(config.contentColor).toUpperCase()}`,
  filterOn: (config) => `Coverage animation ${config.filter.on ? "on" : "off"}`,
  opacity: (config) => `Coverage opacity ${config.filter.opacity} %`,
};

export const TRAY_CLICK_LABELS: Record<TrayClick, string> = {
  page: "Open control page",
  menu: "Show menu",
  panel: "Toggle panel on/standby",
  stats: "Toggle stats overlay",
};
export const TRAY_STEPS_MAX = 8; // ryuod.TRAY_STEPS_MAX: entries in the tray's Brightness submenu

/** The tray change in body, for its messages: [done, not done]. */
function trayText(body: TrayBody): [string, string] {
  // ryuo_tray.py reads state.json every 3 s; the autostart entry counts from the next login.
  if (body.autostart !== undefined) {
    return [
      `The tray ${body.autostart ? "starts" : "no longer starts"} with the desktop session, from the next login`,
      "Start with the desktop session not changed",
    ];
  }
  if (body.leftClick !== undefined) {
    return [
      `Tray left-click set to ${TRAY_CLICK_LABELS[body.leftClick] || body.leftClick}; the tray follows within 3 s`,
      "Tray left-click not changed",
    ];
  }
  return [
    `Tray brightness steps set to ${(body.brightnessSteps ?? []).join(", ")} %; the tray menu follows within 3 s`,
    "Tray brightness steps not changed",
  ];
}

/** Why ryuod would refuse `text` as a new tray step (ryuod.check_steps), or null when it is fine. */
export function stepProblem(text: string, steps: readonly number[]): string | null {
  const step = Number(text);
  if (!/^\s*\d+\s*$/.test(text) || step < 1 || step > 100) return "a step must be a whole number from 1 to 100";
  if (steps.includes(step)) return `${step} % is already a step`;
  if (steps.length >= TRAY_STEPS_MAX) return `the tray menu takes at most ${TRAY_STEPS_MAX} steps`;
  return null;
}

export function createActions(store: Store, poll: Poll) {
  /** Hold `keys` in `editing` while `run` is pending. */
  async function holding(keys: readonly string[], run: () => Promise<void>): Promise<void> {
    for (const key of keys) store.edit(key, true);
    try {
      await run();
    } finally {
      for (const key of keys) store.edit(key, false);
    }
  }

  /**
   * A send that waits until the calls stop for `ms`. It holds `keys` from the first call until
   * `send` runs; `send` holds them again itself (holding(), synchronously, before its first
   * await), so the hold covers the timer and the POST with no gap between them.
   */
  function debounced(keys: readonly string[], ms: number, send: () => Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
      schedule(): void {
        if (timer === undefined) for (const key of keys) store.edit(key, true);
        clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          void send();
          for (const key of keys) store.edit(key, false);
        }, ms);
      },
      pending: () => timer !== undefined,
    };
  }

  // What each overlay control changed since the last overlay POST, for that POST's message.
  // Keyed by control, so two edits of one colour count once.
  const overlayEdits = new Map<string, string>();
  // Every overlay key, not only the edited one: the POST carries them all, and a poll during
  // the debounce would otherwise copy another client's colour into the POST (sync.test.js).
  const overlaySend = debounced(OVERLAY_KEYS, OVERLAY_DEBOUNCE_MS, sendOverlay);
  const brightnessSend = debounced(BRIGHTNESS_KEYS, BRIGHTNESS_DEBOUNCE_MS, sendBrightness);
  let dragged: readonly string[] = [];

  /** POST the whole overlay as the controls hold it; the message names what changed. */
  function sendOverlay(): Promise<void> {
    const config = store.state.config;
    const edits = [...overlayEdits.values()];
    overlayEdits.clear();
    if (!config) return Promise.resolve();
    const done = edits.length === 1 ? edits[0] : edits.length ? `${edits.length} overlay changes` : "Overlay";
    const body = overlayBody(config);
    return holding(OVERLAY_KEYS, async () => {
      try {
        const reply = await postOverlay(body);
        const saved = Object.fromEntries(OVERLAY_KEYS.map((key) => [key, reply.config[key]])) as Partial<Config>;
        store.saw("config", saved);
        // A newer edit waiting in the debounce keeps its values; they go out with its POST.
        const now = store.state.config;
        if (now && !overlaySend.pending()) store.patch({ config: { ...now, ...saved } });
        const [text, detail] = report(reply, done);
        store.say(text, false, detail);
      } catch (error) {
        // The controls keep the user's values, and the next overlay edit sends them again.
        fail(store, error, `${done} not saved`);
      }
    });
  }

  /** One overlay edit: the controls and preview show it at once; the POST waits for the debounce. */
  function editOverlay(key: string, change: Partial<Config>, text: (config: Config) => string): void {
    const config = store.state.config;
    if (!config) return;
    const next = { ...config, ...change };
    store.patch({ config: next });
    overlayEdits.set(key, text(next));
    overlaySend.schedule();
  }

  function setOverlay(control: OverlayControl, change: Partial<Config>): void {
    editOverlay(control, change, OVERLAY_TEXT[control]);
  }

  /** Put `item` ("" for none) in slot `index` (0-5). */
  function setSlot(index: number, item: string): void {
    const items = [...(store.state.config?.items ?? [])];
    items[index] = item;
    editOverlay(`slot${index}`, { items }, () => `Slot ${index + 1}: ${item || "empty"}`);
  }

  /** Outline slot `index` in the preview, or none. */
  function showSlot(index: number | null): void {
    if (store.state.hotSlot !== index) store.patch({ hotSlot: index });
  }

  /** The slider moved: show the percent at once, send it once the slider rests. */
  function setBrightness(percent: number): void {
    const config = store.state.config;
    if (!config) return;
    store.patch({ config: { ...config, brightnessPercent: percent, brightness: brightnessValue(percent) } });
    brightnessSend.schedule();
  }

  function sendBrightness(): Promise<void> {
    const percent = store.state.config?.brightnessPercent;
    if (percent === undefined) return Promise.resolve();
    return holding(BRIGHTNESS_KEYS, async () => {
      try {
        const reply = await postBrightness({ percent });
        store.saw("config", { brightness: reply.value, brightnessPercent: reply.percent });
        // Some percentages land 1 % off on the device scale; show what the panel got, unless
        // the slider has moved on since.
        const config = store.state.config;
        if (config && !brightnessSend.pending() && !dragged.includes("brightness")) {
          store.patch({ config: { ...config, brightness: reply.value, brightnessPercent: reply.percent } });
        }
        const [text, detail] = report(reply, `Brightness ${reply.percent ?? percent} %`);
        store.say(text, false, detail);
      } catch (error) {
        fail(store, error, "Brightness not changed");
      }
    });
  }

  /** A pointer went down on a range: hold its keys until the pointer is released (endDrag). */
  function drag(control: keyof typeof DRAG_KEYS): void {
    endDrag();
    dragged = DRAG_KEYS[control];
    for (const key of dragged) store.edit(key, true);
  }

  function endDrag(): void {
    for (const key of dragged) store.edit(key, false);
    dragged = [];
  }

  /**
   * Panel on or standby. The switch shows the click at once; a refusal turns it back, as the
   * old page did, to the opposite of what was asked.
   */
  function sendPanel(on: boolean): Promise<void> {
    store.patch({ panel: { on } });
    return holding(["panel.on"], async () => {
      try {
        const reply = await postPanel(on);
        store.saw("panel", reply.panel);
        store.patch({ panel: reply.panel });
        if (!reply.changed) {
          store.say(`The panel is already ${on ? "on" : "in standby"}`);
        } else {
          const [text, detail] = report(reply, on ? "Panel on" : "Panel in standby");
          store.say(text, false, detail);
        }
      } catch (error) {
        store.patch({ panel: { on: !on } });
        fail(store, error, on ? "Panel not turned on" : "Panel not put in standby");
      }
    });
  }

  /**
   * The tray settings in body. The control shows the new value at once; a refusal puts back
   * the settings ryuod has.
   */
  function sendTray(body: TrayBody): Promise<void> {
    const [done, notDone] = trayText(body);
    const keys = Object.keys(body) as (keyof TrayBody)[];
    const before = store.state.tray;
    if (before) store.patch({ tray: { ...before, ...body } });
    return holding(
      keys.map((key) => `tray.${key}`),
      async () => {
        try {
          const reply = await postTray(body);
          store.saw("tray", reply.tray);
          store.patch({ tray: reply.tray });
          store.say(done);
        } catch (error) {
          const tray = store.state.tray;
          if (before && tray) {
            store.patch({ tray: { ...tray, ...Object.fromEntries(keys.map((key) => [key, before[key]])) } });
          }
          fail(store, error, notDone);
        }
      },
    );
  }

  /**
   * Add a tray brightness step, checked as ryuod checks it so a bad one is refused before it is
   * sent. Returns false, with the reason in the toast, when refused.
   */
  function addTrayStep(text: string): boolean {
    const steps = store.state.tray?.brightnessSteps ?? [];
    const why = stepProblem(text, steps);
    if (why) {
      fail(store, new Error(why), "Step not added");
      return false;
    }
    void sendTray({ brightnessSteps: [...steps, Number(text)].sort((first, second) => first - second) });
    return true;
  }

  /**
   * Temperature unit or memory MHz. The control keeps the user's value even when the POST
   * fails; the next poll leaves it, since ryuod's value has not changed (state.mergeAround).
   */
  function sendPrefs(body: PrefsBody): Promise<void> {
    const done =
      body.tempUnit !== undefined
        ? `Temperature unit ${body.tempUnit === "Fahrenheit" ? "°F" : "°C"}`
        : `Memory MHz ${body.memoryMHz}`;
    const extra =
      body.memoryMHz !== undefined
        ? body.memoryMHz
          ? "the panel shows it from the next sample"
          : "Memory Frequency is hidden from the slot lists"
        : "";
    const config = store.state.config;
    if (config) store.patch({ config: { ...config, ...body } });
    return holding(["tempUnit", "memoryMHz", "sensors"], async () => {
      try {
        const reply = await postPrefs(body);
        // Take only the fields this call owns: j.config.items and colours predate a slot or colour
        // edit still waiting in the overlay debounce, and copying them would revert it.
        const { tempUnit, memoryMHz, sensors } = reply.config;
        store.saw("config", { tempUnit, memoryMHz, sensors });
        const now = store.state.config;
        if (now) store.patch({ config: { ...now, tempUnit, memoryMHz, sensors } });
        const [text, detail] = report(reply, done, extra);
        store.say(text, false, detail);
        void poll.refreshCatalog(); // the catalog's units follow tempUnit
      } catch (error) {
        fail(store, error, `${done} not saved`);
      }
    });
  }

  /** Delete the saved screen-share choice, so the next start of the second display asks again. */
  function resetChoice(): Promise<void> {
    return holding(["desktop.portalTokenSaved"], async () => {
      try {
        const reply = await postResetChoice();
        store.saw("desktop", reply.desktop);
        store.patch({ desktop: reply.desktop });
        store.say(
          reply.removed
            ? "Screen-share choice deleted; the next start of the second display asks again"
            : "No screen-share choice was saved; the next start asks anyway",
        );
      } catch (error) {
        fail(store, error, "Screen-share choice not deleted");
      }
    });
  }

  async function openDisplaySettings(): Promise<void> {
    try {
      const reply = await postOpenSettings();
      store.say(
        "Display Configuration opened; Virtual-RYUO is in the monitor list",
        false,
        `Ran ${reply.command.join(" ")}`,
      );
    } catch (error) {
      fail(store, error, "Display Configuration not opened");
    }
  }

  return {
    setOverlay,
    setSlot,
    showSlot,
    setBrightness,
    drag,
    endDrag,
    sendPanel,
    sendTray,
    addTrayStep,
    sendPrefs,
    resetChoice,
    openDisplaySettings,
    dismissToast: () => store.dismiss(),
  };
}

export type Actions = ReturnType<typeof createActions>;

/** What the elements are given: the store to read and the actions to call. */
export interface App {
  store: Store;
  actions: Actions;
}
