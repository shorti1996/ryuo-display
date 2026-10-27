/**
 * What ryuod's HTTP API sends and takes, written by hand from ryuod.py. Each type names the
 * function whose output it mirrors; a change there must be copied here, since nothing checks
 * the two against each other at runtime.
 */

/** Every JSON reply: ryuod.Handler.reply() with ok true, or Handler.error() with the reason. */
export interface Ok {
  ok: true;
}
export interface ErrorReply {
  ok: false;
  error: string;
}

/** ryuod.Device.status(): GET /api/state's "device". */
export interface Device {
  connected: boolean;
  hidraw: string | null;
  vid: string | null;
  pid: string | null;
  firmware: string | null;
  product: string | null;
  lastHeartbeatMs: number | null;
  lastHomeuiAckMs: number | null;
  recoveries: number;
  lastError: string | null;
  heartbeat: string;
}

export type PlayMode = "Single" | "Cycle" | "Random";
export type TempUnit = "Celsius" | "Fahrenheit";

/** ryuod.public_config(): the saved settings, in GET /api/state and every reply that changes them. */
export interface Config {
  media: string[];
  playMode: PlayMode;
  ratio: string;
  /** Six slots; "" is an empty slot. */
  items: string[];
  statsVisible: boolean;
  /** #RRGGBB or #AARRGGBB. */
  titleColor: string;
  contentColor: string;
  filter: { on: boolean; opacity: number };
  /** The device scale, 0-102. */
  brightness: number;
  /** ryuod.brightness_percent(brightness), 0-100. */
  brightnessPercent: number;
  tempUnit: TempUnit;
  memoryMHz: number;
  sensors: { motherboard: string };
  secondDisplay: boolean;
}

/** ryuod.Display.status(): GET /api/state's "display"; null for a ryuod run without it. */
export interface DisplayStatus {
  on: boolean;
  state: "off" | "starting" | "on" | "stopping" | "retrying" | "error";
  fps: number | null;
  mbps: number | null;
  message: string | null;
  error: string | null;
  /** ryuod.display_pointer(): whether the capture shows the pointer, and why not. */
  pointer: { shown: boolean; reason: string | null } | null;
  backgroundError: string | null;
  retryInS: number | null;
}

/** ryuod.Upload.snapshot(): GET /api/state's "upload"; null before the first upload. */
export interface UploadStatus {
  state: "receiving" | "probing" | "converting" | "pushing" | "starting" | "done" | "error" | "cancelled";
  file: string | null;
  bytes: number;
  received: number;
  progress: number | null;
  speed: string | null;
  action: "copy" | "remux" | "transcode" | "image" | null;
  reason: string | null;
  encoder: string | null;
  name: string | null;
  error: string | null;
  applied: boolean | null;
  acked: boolean | null;
  heldByDisplay: boolean | null;
  heldByStandby: boolean | null;
  startedAt: number;
  finishedAt: number | null;
}

export type TrayClick = "page" | "menu" | "panel" | "stats";

/** The tray settings saved in state.json (ryuod.check_tray), as POST /api/tray takes them. */
export interface TraySettings {
  autostart: boolean;
  leftClick: TrayClick;
  /** Sorted, 1 to ryuod.TRAY_STEPS_MAX distinct integers 1-100 (ryuod.check_steps). */
  brightnessSteps: number[];
}

/** ryuod.tray_status(): GET /api/state's "tray". */
export interface TrayStatus extends TraySettings {
  brightnessStepValues: number[];
  leftClickOptions: TrayClick[];
}

/** ryuod.desktop_status(): GET /api/state's "desktop". */
export interface DesktopStatus {
  portalTokenSaved: boolean;
  /** The program that opens Display Configuration, or null when neither is installed. */
  displaySettings: string | null;
}

/** ryuod.Handler.get_state(): GET /api/state. */
export interface StateReply extends Ok {
  device: Device;
  config: Config;
  limits: { slots: number; brightnessMax: number; frameMax: number; lastHeartbeatBytes: number; uploadMax: number };
  media: { preset: string[]; custom: string[] };
  upload: UploadStatus | null;
  display: DisplayStatus | null;
  panel: { on: boolean };
  tray: TrayStatus;
  desktop: DesktopStatus;
}

/** One entry of ryuod.Handler.get_stats()'s "values". */
export interface StatValue {
  value: number | string;
  unit: string;
  available: boolean;
  /** ryuod.panel_text(): the value as HomeUI draws it. */
  panel: string;
}

/** ryuod.Handler.get_stats(): GET /api/stats. */
export interface StatsReply extends Ok {
  /** Milliseconds since the epoch; null before the first sample. */
  sampledAt: number | null;
  values: Record<string, StatValue>;
  lastPcInfo: unknown;
}

/** One entry of ryuod.Sampler.catalog(). */
export interface CatalogItem {
  item: string;
  title: string;
  unit: string;
  group: "CPU" | "GPU" | "Memory" | "Storage" | "Board" | "Clock" | "Custom";
  available: boolean;
  source: string | null;
  note: string | null;
  /** ryuod.clips_in(): the slots (1-6) where the title runs past the panel's right edge. */
  clipsIn: number[];
}

/** ryuod.Handler.get_catalog(): GET /api/catalog. */
export interface CatalogReply extends Ok {
  items: CatalogItem[];
}

/** ryuod.Device.media, as ryuod.refresh_media() and ryuod.adb_media() set it. */
export interface MediaLists {
  /** How the lists were read: the cooler's HID reply or adb; null before the first read. */
  source: "conn" | "adb" | null;
  fetchedAt: number | null;
  preset: string[];
  custom: string[];
  /** Bytes by file name, for the files in custom whose size is known. */
  sizes?: Record<string, number>;
}

/** ryuod.Handler.get_media(): GET /api/media. */
export type MediaReply = Ok & MediaLists;

/**
 * ryuod.Handler.result(): how a command fared. applied false: the cooler is disconnected and
 * the change applies on reconnect. heldByStandby: saved while the panel is in standby.
 */
export interface Outcome {
  applied: boolean;
  acked: boolean;
  heldByStandby?: boolean;
  heldByDisplay?: boolean;
  /** The device commands sent, for the toast's tooltip. */
  sent: string[];
  restartsVideo: boolean;
}

/** ryuod.Handler.post_overlay(): POST /api/overlay. */
export interface OverlayReply extends Ok, Outcome {
  config: Config;
}
export type OverlayBody = Partial<Pick<Config, "items" | "statsVisible" | "titleColor" | "contentColor">> & {
  filter?: Partial<Config["filter"]>;
};

/** ryuod.Handler.post_brightness(): POST /api/brightness. */
export interface BrightnessReply extends Ok, Outcome {
  deviceLevel: number;
  value: number;
  percent: number;
}
export type BrightnessBody = { value: number } | { percent: number };

/** ryuod.Handler.post_media_select(): POST /api/media/select. */
export interface MediaSelectReply extends Ok, Outcome {
  heldByDisplay: boolean;
  config: Config;
}
export interface MediaSelectBody {
  media: string[];
  playMode?: PlayMode;
}

/** ryuod.delete_media(), via ryuod.Handler.post_media_delete(): POST /api/media/delete. */
export interface MediaDeleteReply extends Ok, Outcome {
  deleted: string[];
  remaining: string[];
  /** ryuod.refresh_media(): which re-list ran, or null when neither did. */
  listedBy: "conn" | "adb" | null;
  heldByDisplay: boolean;
  heldByStandby: boolean;
  config: Config;
  media: MediaLists;
}

/** ryuod.Handler.post_upload() (202) and post_upload_cancel(): POST /api/media/upload[/cancel]. */
export interface UploadReply extends Ok {
  upload: UploadStatus;
}

/** ryuod.Handler.post_display(): POST /api/display. */
export interface DisplayReply extends Ok {
  display: DisplayStatus;
  config: Config;
}

/** ryuod.Handler.post_panel(): POST /api/panel. */
export interface PanelReply extends Ok, Outcome {
  changed: boolean;
  panel: { on: boolean };
}

/** ryuod.Handler.post_tray(): POST /api/tray. Any subset of the settings. */
export interface TrayReply extends Ok {
  tray: TrayStatus;
}
export type TrayBody = Partial<TraySettings>;

/** ryuod.Handler.post_display_reset_choice(): POST /api/display/reset-choice. */
export interface ResetChoiceReply extends Ok {
  /** A saved choice existed and was deleted. */
  removed: boolean;
  desktop: DesktopStatus;
}

/** ryuod.Handler.post_display_open_settings(): POST /api/display/open-settings. */
export interface OpenSettingsReply extends Ok {
  /** The command ryuod ran. */
  command: string[];
}

/** ryuod.Handler.post_prefs(): POST /api/prefs. */
export interface PrefsReply extends Ok, Outcome {
  config: Config;
}
export type PrefsBody = Partial<Pick<Config, "tempUnit" | "memoryMHz" | "sensors">>;
