/**
 * The Background media's pure parts: the tiles' labels and badges, and what the hero shows. No
 * DOM; the Background tab and the hero render these.
 */
import type { Config, DisplayStatus, MediaLists } from "./api-types.ts";
import { heroMirror } from "./display.ts";

/** A file size as the tile shows it: whole kB below 1 MB, one decimal below 10 MB. "" when unknown. */
export function sizeText(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
  return `${bytes < 1e7 ? (bytes / 1e6).toFixed(1) : String(Math.round(bytes / 1e6))} MB`;
}

/** ryuod previews a PNG or JPEG as an image and everything else as a video. */
export const isImage = (name: string) => /\.(png|jpe?g)$/i.test(name);

/** A preset's label: its name without the common prefix and the extension. */
export const presetLabel = (name: string) => name.replace(/^RYUO_IV_/, "").replace(/\.mp4$/i, "");

// Placeholder art behind the presets' thumbnails, cycled by position.
const PRESET_ART = [
  ["#2a0a0a", "#0a0a2a"],
  ["#1a0a2a", "#2a0a1a"],
  ["#0a2a2a", "#0a0a1a"],
  ["#2a1a0a", "#0a1a2a"],
  ["#2a0a1a", "#1a1a1a"],
];

/** The background behind the preset at `index`, seen until its thumbnail loads or where it fails. */
export function presetBackground(index: number): string {
  const [first, second] = PRESET_ART[index % PRESET_ART.length];
  return `radial-gradient(ellipse at 30% 40%, ${first} 0%, transparent 60%), radial-gradient(ellipse at 80% 70%, ${second} 0%, transparent 55%), #050506`;
}

/**
 * A tile's border and badge: "Previewing" for the file in the hero's preview, else "On panel"
 * for a file in ryuod's playlist (`onPanel`, config.media), else none.
 */
export function tileMark(
  name: string,
  onPanel: readonly string[],
  preview: string | null,
): { on: boolean; pv: boolean; badge: string } {
  const pv = name === preview;
  const on = onPanel.includes(name) && !pv;
  return { on, pv, badge: pv ? "Previewing" : on ? "On panel" : "" };
}

/** The file the panel plays first, or null before the first poll. */
export function liveName(config: Pick<Config, "media"> | null): string | null {
  return config?.media.length ? config.media[0] : null;
}

export type HeroView = "down" | "preview" | "standby" | "mirror" | "live";

/** What heroView reads from the store (state.ts AppState). */
export interface HeroInputs {
  unreachable: string | null;
  preview: string | null;
  panel: { on: boolean } | null;
  displayWant: boolean;
  display: DisplayStatus | null;
}

/**
 * What the hero shows, most specific first: ryuod down, a preview the user asked for (also
 * during standby), the panel in standby, the desktop mirror, or the live background.
 */
export function heroView(state: HeroInputs): HeroView {
  if (state.unreachable !== null) return "down";
  if (state.preview) return "preview";
  if (state.panel?.on === false) return "standby";
  if (heroMirror(state.displayWant, state.display)) return "mirror";
  return "live";
}

/** The live file has a browser preview: ryuod lists it, as a Custom file or a preset. */
export function livePlayable(live: string | null, lists: Pick<MediaLists, "custom" | "preset">): boolean {
  return !!live && (lists.custom.includes(live) || lists.preset.includes(live));
}

/** The file the hero's <video> or <img> plays: the preview, the live file, or none. */
export function heroFile(
  view: HeroView,
  preview: string | null,
  live: string | null,
  playable: boolean,
): string | null {
  if (view === "preview") return preview;
  return view === "live" && playable ? live : null;
}

/** The text under the media in the live view when nothing plays there. */
export function heroHint(view: HeroView, live: string | null, playable: boolean): string {
  if (view !== "live" || playable) return "";
  return live ? `${live} · built-in preset, no browser preview` : "video plays here";
}
