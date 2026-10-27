import { html, nothing, type PropertyDeclarations, type PropertyValues } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { styleMap } from "lit/directives/style-map.js";
import { mediaUrl } from "../api.ts";
import type { MediaLists, PlayMode } from "../api-types.ts";
import { presetBackground, presetLabel, sizeText, tileMark } from "../media.ts";
import { DISPLAY_BLACK, PLAY_MODE_LABELS } from "../playlist.ts";
import type { AppState } from "../state.ts";
import { uploadText } from "../upload.ts";
import { RyuoElement } from "./ryuo-element.ts";
import type { RyuoHero } from "./ryuo-hero.ts";

const DELETE_ARMED_MS = 4000; // how long "Really delete?" waits for the second click
const TRASH_ICON = html`<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`;
const LOCK_ICON = html`<svg role="img" aria-label="Can't be deleted: used by the second display" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const PLAY_ICON = html`<span class="play-ic" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span>`;
const REFRESH_ICON = html`<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`;
const PLAY_MODES = Object.keys(PLAY_MODE_LABELS) as PlayMode[];

/**
 * The Background tab: the files on the cooler as tiles, with "In playlist", Delete and a
 * thumbnail that previews the file in the hero; the play mode, Restart video and Refresh; the
 * upload drop zone and its status line; and the built-in presets. The host is the tab panel.
 *
 * A tick or a play mode change goes to actions.tickMedia or setPlayMode, which send the
 * playlist 400 ms after the last change. Delete needs a second click within 4 s: the viewer
 * refuses confirm() dialogs, and there is no undo.
 */
export class RyuoBackgroundTab extends RyuoElement {
  static override properties: PropertyDeclarations = { armed: { state: true }, deleting: { state: true } };
  /** The file whose Delete waits for its second click, or null. */
  declare armed: string | null;
  /** The file whose delete POST runs, or null. */
  declare deleting: string | null;
  #armTimer: ReturnType<typeof setTimeout> | undefined;
  /** Thumbnails ryuod could not make (no adb, or ffmpeg could not read the file), until the next media list. */
  #noThumb = new Set<string>();
  #lists: MediaLists | undefined;
  #applied = 0;

  constructor() {
    super();
    this.armed = null;
    this.deleting = null;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    // A new media list redraws the tiles, as the old page's renderMedia did: it drops a pending
    // second click, since the file it named may be gone, and asks again for the thumbnails that
    // failed, since adb may be back.
    const state = this.app?.store.state;
    const lists = state?.media;
    if (lists !== this.#lists) {
      this.#lists = lists;
      this.#disarm();
      this.#noThumb.clear();
    }
    // Apply and Replace rebuilt the old page's tiles too, dropping a pending second click, so a
    // click meant before the playlist changed cannot delete after it. Failed thumbnails stay
    // failed: playing a file does not bring adb back.
    const applied = state?.applied ?? 0;
    if (applied !== this.#applied) {
      this.#applied = applied;
      this.#disarm();
    }
  }

  #disarm(): void {
    clearTimeout(this.#armTimer);
    this.armed = null;
  }

  async #deleteClick(name: string): Promise<void> {
    if (this.armed !== name) {
      this.#disarm();
      this.armed = name;
      this.#armTimer = setTimeout(() => {
        this.#disarm();
        this.flush();
      }, DELETE_ARMED_MS);
      this.flush();
      return;
    }
    this.#disarm();
    this.deleting = name;
    this.flush();
    try {
      await this.app?.actions.deleteMedia(name);
    } finally {
      this.deleting = null;
      this.flush();
    }
  }

  #preview(name: string): void {
    this.app?.actions.showPreview(name);
    document.querySelector<RyuoHero>("ryuo-hero")?.reveal();
  }

  #thumbFailed(name: string): void {
    this.#noThumb.add(name);
    this.requestUpdate();
    this.flush();
  }

  /** A tile's thumbnail: a button that previews the file in the hero, with its badge. */
  #thumb(name: string, className: string, mark: { pv: boolean; on: boolean; badge: string }, background = "") {
    // No adb, or ffmpeg could not read the file: the play sign alone instead of a broken image.
    const image = this.#noThumb.has(name)
      ? nothing
      : html`<img alt="" loading="lazy" src=${mediaUrl("thumb", name)} @error=${() => this.#thumbFailed(name)}>`;
    return html`<button class=${className} type="button" title="Click to preview" aria-label="Preview ${name} above"
      style=${styleMap(background ? { background } : {})} @click=${() => this.#preview(name)}>${image}${PLAY_ICON}<span
      class=${mark.pv ? "badge pv" : "badge"} ?hidden=${!mark.pv && !mark.on}>${mark.badge}</span></button>`;
  }

  #box(name: string, state: AppState) {
    return html`<input type="checkbox" .value=${name} .checked=${live(state.ticked.includes(name))}
      @change=${(event: Event) => this.app?.actions.tickMedia(name, (event.target as HTMLInputElement).checked)}>`;
  }

  #deleteButton(name: string) {
    const armed = this.armed === name;
    const deleting = this.deleting === name;
    const label = armed ? `Really delete ${name}? Click again to delete it.` : `Delete ${name}`;
    const content = deleting ? "Deleting…" : armed ? "Really delete?" : TRASH_ICON;
    return html`<button class=${armed ? "del armed" : "del"} type="button" aria-label=${label} title="Delete" ?disabled=${deleting}
      @click=${() => this.#deleteClick(name)}>${content}</button>`;
  }

  #customTile(name: string, state: AppState) {
    const black = name === DISPLAY_BLACK;
    const mark = tileMark(name, state.config?.media ?? [], state.preview);
    const sizes = state.media.sizes ?? {};
    const tile = `tile${mark.on ? " on" : ""}${mark.pv ? " pv" : ""}`;
    // The black image is the second display's: it gets a lock instead of Delete and no playlist
    // box, and is chosen only through its preview's Apply.
    const action = black
      ? html`<span class="lock" title="Used by the second display. Delete it from the stock app if needed.">${LOCK_ICON}</span>`
      : this.#deleteButton(name);
    const playlist = black
      ? html`<span class="tag">System · Desktop mirror</span>`
      : html`<label>${this.#box(name, state)} In playlist</label>`;
    return html`<div class=${tile} data-name=${name}>${this.#thumb(name, black ? "thumb black" : "thumb", mark)}<div
      class="tile-row"><span class="name" title=${name}>${name}</span>${action}</div><div
      class="tile-row meta">${playlist}<span class="size">${sizeText(sizes[name])}</span></div></div>`;
  }

  // Presets live in /sdcard/pcMediaPreset, which mediaDelete cannot reach: no Delete.
  #presetTile(name: string, index: number, state: AppState) {
    const mark = tileMark(name, state.config?.media ?? [], state.preview);
    const tile = `tile preset${mark.on ? " on" : ""}${mark.pv ? " pv" : ""}`;
    return html`<div class=${tile} data-name=${name}>${this.#thumb(name, "thumb", mark, presetBackground(index))}<label
      title=${name}>${this.#box(name, state)}<span>${presetLabel(name)}</span></label></div>`;
  }

  #head(state: AppState) {
    const store = this.app?.store;
    const actions = this.app?.actions;
    // A focused select holds the play mode: its list may be open. Its value binding writes the
    // DOM only when the store's value changes, as the old page set it only from a config.
    return html`<div class="card-head">
      <h3>On the cooler</h3><span class="sub mono">/sdcard/pcMedia</span>
      <div class="grow"></div>
      <div class="head-controls">
        <label for="playMode">Play</label>
        <select id="playMode" .value=${state.config?.playMode ?? PLAY_MODES[0]}
          @focus=${() => store?.edit("playMode", true)} @blur=${() => store?.edit("playMode", false)}
          @change=${(event: Event) => actions?.setPlayMode((event.target as HTMLSelectElement).value as PlayMode)}><option
          value="Single">Single, loop</option><option value="Cycle">Playlist in order</option><option value="Random">Playlist shuffled</option></select>
        <button class="btn" id="play" type="button" @click=${() => actions?.play()}>Restart video</button>
        <button class="btn icon" id="refresh" type="button" aria-label="Refresh the list from the cooler" title="Refresh the list from the cooler"
          @click=${() => actions?.refreshMedia()}>${REFRESH_ICON}</button>
      </div>
    </div>`;
  }

  protected override render() {
    const state = this.app?.store.state;
    if (!state) return null;
    const { custom, preset } = state.media;
    const shown = state.upload.shown;
    const status = uploadText(shown);
    return html`<div class="card stack" style="gap: 16px">
        ${this.#head(state)}
        <div class="tiles">
          <div id="media">${repeat(
            custom,
            (name) => name,
            (name) => this.#customTile(name, state),
          )}</div>
          <ryuo-upload-zone class="drop" id="dropZone" .app=${this.app}></ryuo-upload-zone>
        </div>
        <p class=${shown?.state === "error" ? "note bad" : "note"} id="upStatus" aria-live="polite">${status || nothing}</p>
        <p class="note">Click a thumbnail to preview it above. Ticking or unticking "In playlist" applies at once and restarts the video; the playlist plays in list order. Delete needs a second click and cannot be undone. A video the panel can't play as it is gets converted to 2240×1080 HEVC first, without sound; a still image always becomes a 2240×1080 PNG. Shape applies to both conversions. A finished upload plays on a loop.</p>
      </div>
      <div class="card stack" style="gap: 14px">
        <div class="card-head"><h3>Built-in presets</h3><span class="sub mono" id="presetSub">/sdcard/pcMediaPreset</span></div>
        <div class="tiles small" id="presets">${
          preset.length
            ? repeat(
                preset,
                (name) => name,
                (name, index) => this.#presetTile(name, index, state),
              )
            : html`<p class="note">none</p>`
        }</div>
      </div>`;
  }
}
