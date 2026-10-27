/**
 * Upload progress as the drop zone and the status line under it show it, and how it moves: the
 * page's own POST while it sends the file, then GET /api/state's `upload` while ryuod converts it
 * and copies it to the cooler. No DOM; actions.ts and the poll feed it, the Background tab renders it.
 */
import type { ErrorReply, UploadReply, UploadStatus } from "./api-types.ts";

/** An upload as shown: ryuod's snapshot, or what the page knows while its own POST runs. */
export type UploadShown = Pick<UploadStatus, "state"> & Partial<UploadStatus>;

export interface UploadProgress {
  /** What the status line and the drop zone show; null until the page has seen an upload. */
  shown: UploadShown | null;
  /** The page's POST is sending the file: its progress events drive `shown`, the poll does not. */
  sending: boolean;
  /**
   * startedAt of the upload whose end reloads the media list and ticks the new file. Set by the
   * POST's reply, and by a poll that finds an upload running, which may have started before this
   * page loaded. null when the page waits for none.
   */
  watch: number | null;
}

export const NO_UPLOAD: UploadProgress = { shown: null, sending: false, watch: null };

const ACTIVE = new Set<UploadStatus["state"]>(["receiving", "probing", "converting", "pushing", "starting"]);
const DONE_HOW: Record<string, string> = {
  copy: "sent as it was",
  remux: "repackaged without re-encoding",
  transcode: "converted",
  image: "converted to a 2240×1080 PNG",
};

/** An upload still running: the drop zone takes no second file, and shows the bar and Cancel. */
export function uploadActive(shown: UploadShown | null): boolean {
  return !!shown && ACTIVE.has(shown.state);
}

/** A share (0-1) as a whole percentage, "37 %". */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

/** The status line under the drop zone; "" before any upload. */
export function uploadText(shown: UploadShown | null): string {
  if (!shown) return "";
  const file = shown.file || "the file";
  const amount = shown.progress != null ? `: ${percent(shown.progress)}` : "…";
  let text: string;
  switch (shown.state) {
    case "receiving":
      text = `Uploading ${file}${amount}`;
      break;
    case "probing":
      text = `Checking ${file}…`;
      break;
    case "converting":
      text =
        (shown.action === "image"
          ? "Converting to a 2240×1080 PNG"
          : shown.action === "remux"
            ? "Repackaging as MP4"
            : `Converting to 2240×1080 HEVC with ${shown.encoder}`) +
        amount +
        (shown.speed ? ` at ${shown.speed}` : "");
      break;
    case "pushing":
      text = "Copying to the cooler over adb…";
      break;
    case "starting":
      text = "Starting playback…";
      break;
    case "done":
      text = `${
        shown.heldByStandby
          ? `Selected ${shown.name} (applies when the panel turns on)`
          : shown.heldByDisplay
            ? `Selected ${shown.name} (applies when the second display is off)`
            : `Playing ${shown.name}${shown.applied === false ? " once the cooler reconnects" : ""}`
      }, ${(shown.action && DONE_HOW[shown.action]) || shown.action}`;
      break;
    case "error":
      text = `Upload failed: ${shown.error}`;
      break;
    case "cancelled":
      text = "Upload cancelled";
      break;
    default:
      // A state this page does not know yet: ryuod's own word for it beats nothing.
      text = (shown as { state: string }).state;
  }
  // An image's reason only repeats "converted to a PNG".
  const converted = shown.state === "converting" || (shown.state === "done" && shown.action === "transcode");
  if (shown.reason && shown.action !== "image" && converted) text += `. Reason: ${shown.reason}`;
  return text;
}

/** The POST is sending `file`, `fraction` (0-1) of it so far. */
export function sending(progress: UploadProgress, file: string, fraction: number): UploadProgress {
  return { ...progress, sending: true, shown: { state: "receiving", file, progress: fraction } };
}

/**
 * The POST ended: ryuod has the file (202) and its job is watched from here on, or the upload
 * was cancelled, or it failed with ryuod's reason or the HTTP status.
 */
export function sendEnded(
  progress: UploadProgress,
  status: number,
  reply: UploadReply | ErrorReply | null,
  cancelled: boolean,
): UploadProgress {
  if (status === 202 && reply?.ok) {
    return { shown: reply.upload, sending: false, watch: reply.upload.startedAt };
  }
  if (cancelled) return { ...progress, sending: false, shown: { state: "cancelled" } };
  const reason = (reply && !reply.ok && reply.error) || (status ? `HTTP ${status}` : "the connection to ryuod dropped");
  return { ...progress, sending: false, shown: { state: "error", error: reason } };
}

/**
 * A state poll's `upload`. Ignored while the page's own POST sends the file, and when null, so
 * the last status stays: a finished upload's line stays after a page load too, as on the old
 * page (docs/007-ui-redesign/GAPS.md). `finished` names the file of the watched upload when this
 * poll is the first to find it done.
 */
export function fromPoll(
  progress: UploadProgress,
  polled: UploadStatus | null,
): { progress: UploadProgress; finished: string | null } {
  if (progress.sending || !polled) return { progress, finished: null };
  let watch = progress.watch;
  if (ACTIVE.has(polled.state)) watch = polled.startedAt;
  let finished: string | null = null;
  if (polled.state === "done" && watch === polled.startedAt) {
    watch = null;
    finished = polled.name;
  }
  return { progress: { shown: polled, sending: false, watch }, finished };
}
