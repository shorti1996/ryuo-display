/**
 * ryuod's HTTP API, typed. Every call resolves to the reply on `ok: true` and throws an Error
 * carrying ryuod's own reason otherwise, so a caller can show `error.message` as it is.
 */
import type {
  BrightnessBody,
  BrightnessReply,
  CatalogReply,
  DisplayReply,
  ErrorReply,
  MediaDeleteReply,
  MediaReply,
  MediaSelectBody,
  MediaSelectReply,
  OpenSettingsReply,
  OverlayBody,
  OverlayReply,
  PanelReply,
  PrefsBody,
  PrefsReply,
  ProtectionReply,
  ResetChoiceReply,
  StateReply,
  StatsReply,
  TrayBody,
  TrayReply,
  UploadReply,
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
export const postMediaSelect = (body: MediaSelectBody) => api<MediaSelectReply>("/api/media/select", body);
export const postMediaDelete = (names: string[]) => api<MediaDeleteReply>("/api/media/delete", { names });
export const postUploadCancel = () => api<UploadReply>("/api/media/upload/cancel", {});
export const postOverlay = (body: OverlayBody) => api<OverlayReply>("/api/overlay", body);
export const postBrightness = (body: BrightnessBody) => api<BrightnessReply>("/api/brightness", body);
export const postPanel = (on: boolean) => api<PanelReply>("/api/panel", { on });
export const postDisplay = (on: boolean) => api<DisplayReply>("/api/display", { on });
export const postPrefs = (body: PrefsBody) => api<PrefsReply>("/api/prefs", body);
export const postTray = (body: TrayBody) => api<TrayReply>("/api/tray", body);
export const postResetChoice = () => api<ResetChoiceReply>("/api/display/reset-choice", {});
export const postOpenSettings = () => api<OpenSettingsReply>("/api/display/open-settings", {});
export const postProtection = (enabled: boolean) => api<ProtectionReply>("/api/display/protection", { enabled });

/** A file's thumbnail (a still from ryuod's ffmpeg) or its preview (playable in a browser). */
export const mediaUrl = (kind: "thumb" | "preview", name: string) =>
  `/api/media/${kind}?name=${encodeURIComponent(name)}`;

/**
 * Why the hero's <video> or <img> could not show `name`. The element reports only that it
 * failed, so this asks ryuod for one byte of the preview: an error reply carries ryuod's reason,
 * and a good reply means ryuod served the file and the browser could not play it.
 */
export async function previewError(name: string): Promise<string> {
  try {
    const response = await fetch(mediaUrl("preview", name), { headers: { Range: "bytes=0-0" } });
    if (response.ok) return "this browser cannot play the file";
    let reply: { error?: unknown } | null = null;
    try {
      reply = await response.json();
    } catch {
      // a non-JSON error page
    }
    return (typeof reply?.error === "string" && reply.error) || `HTTP ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** What sendUpload reports: the share of the file sent so far, and ryuod's answer once it ends. */
export interface UploadEvents {
  progress(fraction: number): void;
  /** `status` 0: the connection dropped or was aborted. `reply` null: no JSON body. */
  end(status: number, reply: UploadReply | ErrorReply | null): void;
}

/**
 * POST `file` to /api/media/upload as the raw body. An XMLHttpRequest, not fetch: only it reports
 * upload progress. ryuod answers 202 once it has the file, and the conversion and the copy to the
 * cooler then show in GET /api/state's `upload`. Calls `events.end` synchronously from the
 * request's loadend, so the status line changes in the same task.
 */
export function sendUpload(file: File, fit: string, events: UploadEvents): { abort(): void } {
  const request = new XMLHttpRequest();
  request.open("POST", `/api/media/upload?fit=${encodeURIComponent(fit)}`);
  request.setRequestHeader("Content-Type", "application/octet-stream");
  request.setRequestHeader("X-Filename", encodeURIComponent(file.name));
  request.upload.onprogress = (event) => {
    if (event.lengthComputable) events.progress(event.loaded / event.total);
  };
  request.onloadend = () => {
    let reply: UploadReply | ErrorReply | null = null;
    try {
      reply = JSON.parse(request.responseText);
    } catch {
      // no JSON body: the connection dropped, or a proxy's error page
    }
    events.end(request.status, reply);
  };
  request.send(file);
  return { abort: () => request.abort() };
}
