/**
 * The page's state, the store that holds it, and the poll that feeds it from ryuod. Elements
 * read `store.state` and re-render on every change (ui/ryuo-element.ts); actions.ts writes it.
 */

import { getCatalog, getMedia, getState, getStats } from "./api.ts";
import type {
  CatalogItem,
  Config,
  DesktopStatus,
  Device,
  DisplayStatus,
  MediaLists,
  StatsReply,
  TrayStatus,
} from "./api-types.ts";
import { fromPoll, NO_UPLOAD, type UploadProgress } from "./upload.ts";

/** The result toast. Hiding it keeps the text, as the old page did. */
export interface Toast {
  text: string;
  bad: boolean;
  /** The device commands sent, for debugging; the toast's tooltip, not its text. */
  detail: string;
  shown: boolean;
}

export interface AppState {
  /** The error of the last state poll when it failed, null while ryuod answers. */
  unreachable: string | null;
  /** GET /api/state's parts as last polled; null before the first poll answers. */
  device: Device | null;
  /** The settings as the controls show them: ryuod's, plus the user's edits not yet saved. */
  config: Config | null;
  tray: TrayStatus | null;
  desktop: DesktopStatus | null;
  panel: { on: boolean } | null;
  display: DisplayStatus | null;
  /**
   * The second-display switch as the strip, the Desktop mirror tab, the header and the hero show
   * it: ryuod's display.on, or the user's click while its POST runs ("display.on" in `editing`).
   * A poll copies display.on into it except while that key is held.
   */
  displayWant: boolean;
  /** The upload as the drop zone and its status line show it (upload.ts). */
  upload: UploadProgress;
  stats: StatsReply | null;
  catalog: CatalogItem[];
  media: MediaLists;
  /**
   * The files ticked "In playlist": the playlist draft, sent 400 ms after the last tick. A poll
   * that brings a new config.media from ryuod sets it to that playlist.
   */
  ticked: string[];
  /** The file previewed in the hero, or null for the hero's live view. */
  preview: string | null;
  /** The preview bar asks before Apply replaces a playlist of several files. */
  applyAsking: boolean;
  /**
   * How many times Apply or Replace has played a file. The Background tab drops a Delete waiting
   * for its second click when this changes, as the old page did by rebuilding its tiles then.
   */
  applied: number;
  toast: Toast;
  /**
   * The slot (0-5) whose row is under the pointer or has focus, or null. The slot picker sets it
   * and the preview outlines that slot on the panel, labelled with its number when it is empty.
   */
  hotSlot: number | null;
  /**
   * Keys the user is changing: a focused select, a dragged slider, a debounce or POST still
   * pending. The poll leaves these keys as they are. Config keys are bare ("tempUnit"); the
   * other sections' carry their section ("tray.leftClick", "panel.on").
   */
  editing: ReadonlySet<string>;
}

export const TOAST_MS = 6000; // how long a message that is not an error stays on screen

function initialState(): AppState {
  return {
    unreachable: null,
    device: null,
    config: null,
    tray: null,
    desktop: null,
    panel: null,
    display: null,
    displayWant: false,
    upload: NO_UPLOAD,
    stats: null,
    catalog: [],
    media: { source: null, fetchedAt: null, preset: [], custom: [] },
    ticked: [],
    preview: null,
    applyAsking: false,
    applied: 0,
    toast: { text: "", bad: false, detail: "", shown: false },
    hotSlot: null,
    editing: new Set(),
  };
}

const json = (value: unknown) => JSON.stringify(value) ?? "undefined";

/**
 * Copy into `current` each key of `fresh` whose value ryuod changed since `seen`, except the
 * keys in `editing`; record the copied values in `seen`. Returns the keys copied.
 *
 * A key is compared with ryuod's last value, not with `current`: after an edit the page could
 * not save, `current` keeps the user's value (to be sent again with the next edit) while ryuod
 * still has the old one, and copying that back would undo the edit. A key skipped while the
 * user edits it keeps its old `seen`, so another client's change still arrives once the edit ends.
 */
export function mergeAround<T extends object>(
  current: T,
  fresh: T,
  seen: Map<string, string>,
  editing: ReadonlySet<string>,
  prefix = "",
): (keyof T & string)[] {
  const copied: (keyof T & string)[] = [];
  for (const name of Object.keys(fresh) as (keyof T & string)[]) {
    const key = prefix + name;
    const value = json(fresh[name]);
    if (editing.has(key) || seen.get(key) === value) continue;
    current[name] = fresh[name];
    seen.set(key, value);
    copied.push(name);
  }
  return copied;
}

type Section = "config" | "tray" | "desktop" | "panel";
const PREFIX: Record<Section, string> = { config: "", tray: "tray.", desktop: "desktop.", panel: "panel." };

export class Store {
  state: AppState = initialState();
  #listeners = new Set<() => void>();
  /** Per key, ryuod's value as the page last saw or sent it, as JSON (see mergeAround). */
  #seen = new Map<string, string>();
  /** Per editing key, how many holders have it: a select can stay focused while its POST runs. */
  #holds = new Map<string, number>();
  #toastTimer: ReturnType<typeof setTimeout> | undefined;

  patch(change: Partial<AppState>): void {
    Object.assign(this.state, change);
    for (const listener of this.#listeners) listener();
  }

  /** Call `listener` after every change. Returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Add (`on`) or release one hold on an editing key. */
  edit(key: string, on: boolean): void {
    const holders = (this.#holds.get(key) ?? 0) + (on ? 1 : -1);
    if (holders > 0) this.#holds.set(key, holders);
    else this.#holds.delete(key);
    this.patch({ editing: new Set(this.#holds.keys()) });
  }

  /** Record `values` as ryuod's: from a POST reply, for the keys that POST saved. */
  saw<S extends Section>(section: S, values: Partial<NonNullable<AppState[S]>>): void {
    for (const [name, value] of Object.entries(values)) this.#seen.set(PREFIX[section] + name, json(value));
  }

  /**
   * A poll's copy of a section: taken whole the first time, then merged around the keys the
   * user is editing (mergeAround). Returns the keys that changed.
   */
  merge<S extends Section>(section: S, fresh: NonNullable<AppState[S]> | null): string[] {
    const current = this.state[section];
    if (!fresh || !current) {
      if (fresh) this.saw(section, fresh);
      this.patch({ [section]: fresh });
      return fresh ? Object.keys(fresh) : [];
    }
    const next = { ...current };
    const copied = mergeAround(next, fresh, this.#seen, this.state.editing, PREFIX[section]);
    if (copied.length) this.patch({ [section]: next });
    return copied;
  }

  /** Show `text` in the toast; a message that is not an error hides after TOAST_MS. */
  say(text: string, bad = false, detail = ""): void {
    clearTimeout(this.#toastTimer);
    this.patch({ toast: { text, bad, detail, shown: !!text } });
    if (text && !bad) this.#toastTimer = setTimeout(() => this.dismiss(), TOAST_MS);
  }

  dismiss(): void {
    this.patch({ toast: { ...this.state.toast, shown: false } });
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A refusal or failure: what did not happen, then ryuod's reason. */
export function fail(store: Store, error: unknown, what: string): void {
  store.say(`${what}: ${message(error)}`, true);
}

/**
 * The error the header pill's tooltip and the App tab's "Last error" show: why ryuod does not
 * answer, else the cooler's last error while it is not connected.
 */
export function errorText(
  state: { unreachable: string | null; device: Pick<Device, "connected" | "lastError"> | null } | undefined,
): string {
  if (!state) return "";
  if (state.unreachable !== null) return state.unreachable;
  const device = state.device;
  return device && !device.connected && device.lastError ? device.lastError : "";
}

const count = (amount: number, noun: string) => `${amount} ${noun}${amount === 1 ? "" : "s"}`;
// The config keys whose change alters the catalog: its units follow tempUnit.
const UNIT_KEYS = ["tempUnit", "memoryMHz", "sensors"];

/**
 * The transport: GET /api/state and /api/stats every second, the catalog every 15 s. Kept in
 * one place so server push can replace it without touching the elements.
 */
export function createPoll(store: Store) {
  async function refreshCatalog(): Promise<void> {
    try {
      store.patch({ catalog: (await getCatalog()).items });
    } catch {
      // retried by the 15 s interval
    }
  }

  /** The media lists; `refresh` asks the cooler again and says what it found. */
  async function loadMedia(refresh: boolean): Promise<void> {
    try {
      const { ok: _, ...media } = await getMedia(refresh);
      store.patch({ media });
      if (refresh) {
        store.say(
          `Media list refreshed: ${count(media.custom.length, "file")} on the cooler, ${count(media.preset.length, "preset")}`,
          false,
          `Listed by ${media.source === "adb" ? "adb" : "the cooler's HID reply"}`,
        );
      }
    } catch (error) {
      fail(store, error, refresh ? "Media list not refreshed" : "Media list not loaded");
    }
  }

  async function pollState(): Promise<void> {
    let reply: Awaited<ReturnType<typeof getState>>;
    try {
      reply = await getState();
    } catch (error) {
      store.patch({ unreachable: message(error) });
      return;
    }
    if (store.state.unreachable !== null) {
      // The daemon is back: the catalog and media list fetched while it was down failed, and
      // without them the saved items read "(custom label)" and the media groups stay empty.
      store.patch({ unreachable: null });
      await refreshCatalog();
      void loadMedia(false);
    }
    const first = !store.state.config;
    // displayWant follows ryuod on every poll, as the old page's did, not only when ryuod's value
    // changed: it is a status, not a setting the page saves. A ryuod without the second display
    // leaves it as it was.
    const display = reply.display;
    const want = display && !store.state.editing.has("display.on") ? { displayWant: display.on } : {};
    const { progress, finished } = fromPoll(store.state.upload, reply.upload);
    store.patch({ device: reply.device, display, upload: progress, ...want });
    const changed = store.merge("config", reply.config);
    // A playlist from ryuod (the first poll, or another client's change) replaces the draft.
    const config = store.state.config;
    if (config && changed.includes("media")) store.patch({ ticked: [...config.media] });
    store.merge("tray", reply.tray);
    store.merge("desktop", reply.desktop);
    // Merged like the settings, so the switch keeps the user's click while its POST runs.
    store.merge("panel", reply.panel);
    // A unit change from another client: the catalog's units follow tempUnit. The first poll
    // needs no refetch; the startup sequence fetched the catalog just before it.
    if (!first && changed.some((key) => UNIT_KEYS.includes(key))) void refreshCatalog();
    if (finished) void uploadFinished(finished);
  }

  /**
   * A watched upload is done: ryuod has added the file to its cached list and plays it alone, on
   * a loop. The list is fetched without asking the cooler again.
   */
  async function uploadFinished(name: string): Promise<void> {
    await loadMedia(false);
    const config = store.state.config;
    if (config) store.patch({ config: { ...config, media: [name], playMode: "Single" }, ticked: [name] });
  }

  async function pollStats(): Promise<void> {
    try {
      store.patch({ stats: await getStats() });
    } catch {
      // the state poll reports it
    }
  }

  /** The startup sequence, in the old page's order (catalog, state, media, stats), then the intervals. */
  async function start(): Promise<void> {
    await refreshCatalog();
    await pollState();
    await loadMedia(false);
    await pollStats();
    setInterval(pollState, 1000);
    setInterval(pollStats, 1000);
    setInterval(refreshCatalog, 15000);
  }

  return { refreshCatalog, loadMedia, pollState, pollStats, start };
}

export type Poll = ReturnType<typeof createPoll>;
