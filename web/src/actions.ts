/**
 * One function per user action: the API call, the store update, and the message in the toast.
 * Elements call these directly. While a POST runs, its keys are held in `editing`, so a poll
 * that lands meanwhile does not put back the value the POST is replacing.
 */

import {
  postBrightness,
  postDisplay,
  postMediaDelete,
  postMediaSelect,
  postOpenSettings,
  postOverlay,
  postPanel,
  postPrefs,
  postResetChoice,
  postTray,
  postUploadCancel,
  sendUpload,
} from "./api.ts";
import type { Config, PlayMode, PrefsBody, TrayBody, TrayClick } from "./api-types.ts";
import { brightnessValue } from "./brightness.ts";
import { liveName } from "./media.ts";
import { OVERLAY_KEYS, overlayBody, rgbHex } from "./overlay.ts";
import { deleteText, playlistOrder, playlistText, tickFile } from "./playlist.ts";
import { report } from "./report.ts";
import { fail, type Poll, type Store } from "./state.ts";
import { sendEnded, sending, uploadActive } from "./upload.ts";

export const OVERLAY_DEBOUNCE_MS = 300; // overlay edits within this window go out as one POST
export const BRIGHTNESS_DEBOUNCE_MS = 150; // the slider sends once it has rested this long
export const PLAY_DEBOUNCE_MS = 400; // playlist ticks and play mode changes within this window go out as one selection
// Both playlist fields: POST /api/media/select carries the files and the play mode together.
const PLAYLIST_KEYS = ["media", "playMode"] as const;
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
      /** Drop the waiting send and its hold: a send that goes out at once replaces it. */
      cancel(): void {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        for (const key of keys) store.edit(key, false);
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
  const playSend = debounced(PLAYLIST_KEYS, PLAY_DEBOUNCE_MS, play);
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
   * Start or stop the second display. The switch shows the click at once and keeps it until the
   * first poll after the POST: the reply's status ("Starting…") shows at once, but displayWant
   * waits for the poll, as the old page's did. A refusal turns the switch to the opposite of
   * what was asked. Nothing here touches the config: the reply's copy predates any overlay or
   * media edit still waiting in its debounce.
   */
  function sendDisplay(on: boolean): Promise<void> {
    store.patch({ displayWant: on });
    return holding(["display.on"], async () => {
      try {
        const reply = await postDisplay(on);
        store.patch({ display: reply.display });
        store.say(
          on
            ? "Second display starting"
            : "Second display stopping; removing the virtual monitor takes up to about 10 s",
        );
      } catch (error) {
        store.patch({ displayWant: !on });
        fail(store, error, on ? "Second display not started" : "Second display not stopped");
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
   * Temperature unit or memory MHz. The store takes the value only from ryuod's reply: a value
   * ryuod refuses (memory MHz above 20000, say) must not reach the slot lists. The control keeps
   * what the user typed or clicked all the same, since its binding writes the DOM only when the
   * store's value changes, and a refusal leaves it as it was.
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

  /**
   * Delete the saved screen-share choice, so the next start of the second display asks again.
   * It holds no key: nothing changes before the reply, so a poll during the POST may show
   * ryuod's choice, and a refusal then leaves that choice showing, as the old page did. The
   * Desktop mirror tab disables Ask again until this resolves.
   */
  async function resetChoice(): Promise<void> {
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
  }

  /** Tick or untick `name` "In playlist". The playlist goes out 400 ms after the last change. */
  function tickMedia(name: string, on: boolean): void {
    store.patch({ ticked: tickFile(store.state.ticked, name, on) });
    playSend.schedule();
  }

  /** The play mode select changed; it goes out with the ticked files, as one selection. */
  function setPlayMode(mode: PlayMode): void {
    const config = store.state.config;
    if (!config) return;
    store.patch({ config: { ...config, playMode: mode } });
    playSend.schedule();
  }

  /**
   * POST `media` with the play mode as the select shows it. Returns the playlist ryuod took, or
   * null when it refused; a refusal leaves the config as it was.
   */
  async function selectMedia(media: string[], playMode: PlayMode, notDone: string): Promise<string[] | null> {
    let taken: string[] | null = null;
    await holding(PLAYLIST_KEYS, async () => {
      try {
        const reply = await postMediaSelect({ media, playMode });
        const saved = { media: reply.config.media, playMode: reply.config.playMode };
        store.saw("config", saved);
        // A newer tick waiting in the debounce keeps the draft; it goes out with its own POST.
        const now = store.state.config;
        if (now && !playSend.pending()) store.patch({ config: { ...now, ...saved } });
        const [text, detail] = report(reply, playlistText(media, playMode));
        store.say(text, false, detail);
        taken = saved.media;
      } catch (error) {
        fail(store, error, notDone);
      }
    });
    return taken;
  }

  /**
   * Send the ticked files in list order with the play mode: Restart video, and the debounce's
   * send. A pending debounce is dropped, since this sends what it would have.
   */
  async function play(): Promise<void> {
    playSend.cancel();
    const config = store.state.config;
    if (!config) return;
    const media = playlistOrder(store.state.media, store.state.ticked);
    if (!media.length) {
      // The panel keeps playing the old playlist, so the boxes go back to it.
      store.patch({ ticked: [...config.media] });
      store.say("Keep at least one file in the playlist", true);
      return;
    }
    await selectMedia(media, config.playMode, "Playlist not changed");
  }

  /** Preview `name` in the hero; a click on the file the hero already plays live goes back to live. */
  function showPreview(name: string): void {
    const { config, displayWant } = store.state;
    store.patch({ applyAsking: false, preview: name === liveName(config) && !displayWant ? null : name });
  }

  function closePreview(): void {
    store.patch({ applyAsking: false, preview: null });
  }

  /**
   * Apply: play the previewed file alone, at once, unless the playlist has other files it would
   * drop; then the preview bar asks first. Returns true when it asks.
   */
  function askApply(): boolean {
    if ((store.state.config?.media.length ?? 0) > 1) {
      store.patch({ applyAsking: true });
      return true;
    }
    void showOnPanel();
    return false;
  }

  function cancelApply(): void {
    store.patch({ applyAsking: false });
  }

  /** Play the previewed file alone, with the play mode; the hero goes live on it. */
  async function showOnPanel(): Promise<void> {
    const name = store.state.preview;
    const config = store.state.config;
    store.patch({ applyAsking: false });
    if (!name || !config) return;
    playSend.cancel();
    const taken = await selectMedia([name], config.playMode, `${name} not applied`);
    if (!taken) return;
    store.patch({ ticked: [...taken], applied: store.state.applied + 1 });
    if (store.state.preview === name) closePreview();
  }

  /** Delete `name` from the cooler; the tiles and the playlist follow ryuod's reply. */
  async function deleteMedia(name: string): Promise<void> {
    try {
      const reply = await postMediaDelete([name]);
      // Only the playlist: the rest of reply.config may predate an overlay edit still in its debounce.
      const media = reply.config.media;
      store.saw("config", { media });
      const config = store.state.config;
      store.patch({ media: reply.media, ...(config ? { config: { ...config, media }, ticked: [...media] } : {}) });
      const preview = store.state.preview;
      if (preview !== null && reply.deleted.includes(preview)) closePreview();
      const { text, bad, detail } = deleteText(reply);
      store.say(text, bad, detail);
    } catch (error) {
      fail(store, error, `${name} not deleted`);
    }
  }

  // The upload's POST while it sends the file, and whether Cancel ended it, for its last status.
  let uploadRequest: { abort(): void } | null = null;
  let uploadCancelled = false;

  /**
   * Upload `file`, converted to the panel's shape with `fit` (crop or pad). Refused while another
   * upload runs, from this page or another: ryuod converts one at a time.
   */
  function upload(file: File | undefined, fit: string): void {
    if (!file) return;
    const progress = store.state.upload;
    if (progress.sending || uploadActive(progress.shown)) {
      store.say("Wait for the current upload to finish first", true);
      return;
    }
    uploadCancelled = false;
    store.patch({ upload: sending(progress, file.name, 0) });
    uploadRequest = sendUpload(file, fit, {
      progress: (fraction) => store.patch({ upload: sending(store.state.upload, file.name, fraction) }),
      end: (status, reply) => {
        uploadRequest = null;
        store.patch({ upload: sendEnded(store.state.upload, status, reply, uploadCancelled) });
      },
    });
  }

  /** Cancel the upload: ryuod stops its job, and the POST stops if it is still sending. */
  async function cancelUpload(): Promise<void> {
    uploadCancelled = true;
    try {
      await postUploadCancel();
    } catch {
      // the upload had already finished
    }
    uploadRequest?.abort();
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
    sendDisplay,
    sendTray,
    addTrayStep,
    sendPrefs,
    resetChoice,
    openDisplaySettings,
    tickMedia,
    setPlayMode,
    play,
    refreshMedia: () => poll.loadMedia(true),
    showPreview,
    closePreview,
    askApply,
    cancelApply,
    showOnPanel,
    deleteMedia,
    upload,
    cancelUpload,
    dismissToast: () => store.dismiss(),
  };
}

export type Actions = ReturnType<typeof createActions>;

/** What the elements are given: the store to read and the actions to call. */
export interface App {
  store: Store;
  actions: Actions;
}
