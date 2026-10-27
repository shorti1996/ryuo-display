/**
 * The playlist's pure parts: the ticked files in the order the panel plays them, what a tick does
 * to the draft, and the sentences that name a playlist change or a delete. No DOM; actions.ts
 * sends and the Background tab renders.
 */
import type { MediaDeleteReply, MediaLists, PlayMode } from "./api-types.ts";

/** The black still image ryuod puts under the second display (ryuod.BLACK_NAME). */
export const DISPLAY_BLACK = "display-black.png";

/** The play mode select's labels, in its order. A playlist message names the mode by these. */
export const PLAY_MODE_LABELS: Record<PlayMode, string> = {
  Single: "Single, loop",
  Cycle: "Playlist in order",
  Random: "Playlist shuffled",
};

/** The ticked files in list order, Custom first and then the presets, as the tiles show them. */
export function playlistOrder(lists: Pick<MediaLists, "custom" | "preset">, ticked: readonly string[]): string[] {
  return [...lists.custom, ...lists.preset].filter((name) => ticked.includes(name));
}

/**
 * The draft after `name` is ticked (`on`) or unticked. The black image has no box, so a draft
 * that holds it came from Apply; ticking any file replaces it.
 */
export function tickFile(ticked: readonly string[], name: string, on: boolean): string[] {
  const rest = ticked.filter((other) => other !== name && other !== DISPLAY_BLACK);
  return on ? [...rest, name] : rest;
}

/** The playlist for a message: the file alone, or the count and the play mode as its select names it. */
export function playlistText(media: readonly string[], mode: PlayMode): string {
  return media.length === 1
    ? `Background ${media[0]}`
    : `Playlist of ${media.length} files (${PLAY_MODE_LABELS[mode] ?? mode})`;
}

/** A delete's message for the toast; `bad` when the cooler still lists the file. */
export function deleteText(reply: MediaDeleteReply): { text: string; bad: boolean; detail: string } {
  if (reply.remaining.length) {
    return {
      text: `${reply.remaining.join(", ")} is still on the cooler; the delete did not take`,
      bad: true,
      detail: "",
    };
  }
  let text = `Deleted ${reply.deleted.join(", ")} from the cooler`;
  const when = reply.heldByStandby
    ? ", from when the panel turns on"
    : reply.heldByDisplay
      ? ", from when the second display is off"
      : reply.applied === false
        ? ", from when the cooler reconnects"
        : "";
  // The deleted file was playing: ryuod fell back to the rest of the playlist, or the first preset.
  if (reply.restartsVideo || reply.heldByDisplay || reply.heldByStandby) {
    text += `; the panel plays ${reply.config.media.join(", ")} instead${when}`;
  }
  const sent = reply.sent || [];
  return { text, bad: false, detail: sent.length ? `Sent: ${sent.join(", ")}` : "" };
}
