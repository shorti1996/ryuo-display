/**
 * One function per user action: the API call, the store update, and the message in the toast.
 * Elements call these directly. While a POST runs, its keys are held in `editing`, so a poll
 * that lands meanwhile does not put back the value the POST is replacing.
 */

import { postOpenSettings, postPrefs, postResetChoice, postTray } from "./api.ts";
import type { PrefsBody, TrayBody, TrayClick } from "./api-types.ts";
import { report } from "./report.ts";
import { fail, type Poll, type Store } from "./state.ts";

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
  async function holding(keys: string[], run: () => Promise<void>): Promise<void> {
    for (const key of keys) store.edit(key, true);
    try {
      await run();
    } finally {
      for (const key of keys) store.edit(key, false);
    }
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
