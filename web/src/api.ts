/**
 * ryuod's HTTP API, typed. Every call resolves to the reply on `ok: true` and throws an Error
 * carrying ryuod's own reason otherwise, so a caller can show `error.message` as it is.
 */
import type {
  BrightnessBody,
  BrightnessReply,
  CatalogReply,
  MediaReply,
  OpenSettingsReply,
  OverlayBody,
  OverlayReply,
  PanelReply,
  PrefsBody,
  PrefsReply,
  ResetChoiceReply,
  StateReply,
  StatsReply,
  TrayBody,
  TrayReply,
} from "./api-types.ts";

/**
 * GET `path`, or POST `body` to it as JSON. Throws ryuod's `error` when the reply has one, else
 * "HTTP <status>" (a non-JSON error page, or a reply without `ok`). A failed fetch throws as is
 * ("Failed to fetch").
 */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const options: RequestInit =
    body === undefined
      ? {}
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(path, options);
  let reply: { ok?: unknown; error?: unknown } | null = null;
  try {
    reply = await response.json();
  } catch {
    // a non-JSON error page
  }
  if (!response.ok || !reply?.ok) {
    throw new Error((typeof reply?.error === "string" && reply.error) || `HTTP ${response.status}`);
  }
  return reply as T;
}

export const getState = () => api<StateReply>("/api/state");
export const getStats = () => api<StatsReply>("/api/stats");
export const getCatalog = () => api<CatalogReply>("/api/catalog");
/** `refresh`: ryuod asks the cooler (or adb) again instead of answering from its cached list. */
export const getMedia = (refresh = false) => api<MediaReply>(`/api/media${refresh ? "?refresh=1" : ""}`);
export const postOverlay = (body: OverlayBody) => api<OverlayReply>("/api/overlay", body);
export const postBrightness = (body: BrightnessBody) => api<BrightnessReply>("/api/brightness", body);
export const postPanel = (on: boolean) => api<PanelReply>("/api/panel", { on });
export const postPrefs = (body: PrefsBody) => api<PrefsReply>("/api/prefs", body);
export const postTray = (body: TrayBody) => api<TrayReply>("/api/tray", body);
export const postResetChoice = () => api<ResetChoiceReply>("/api/display/reset-choice", {});
export const postOpenSettings = () => api<OpenSettingsReply>("/api/display/open-settings", {});
