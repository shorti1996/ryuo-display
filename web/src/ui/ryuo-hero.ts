import { html, type PropertyValues } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import type { Actions } from "../actions.ts";
import { mediaUrl, previewError } from "../api.ts";
import { mirrorChipText, mirrorHintShown } from "../display.ts";
import { heroFile, heroHint, heroView, isImage, liveName, livePlayable } from "../media.ts";
import { rgbHex, type SlotCell, slotCell } from "../overlay.ts";
import { protectionChip } from "../protection.ts";
import type { AppState } from "../state.ts";
import { RyuoElement } from "./ryuo-element.ts";

const SLOT_COUNT = 6;
const EMPTY: SlotCell = { title: "", value: "", unit: "" };
const PREPARING =
  "Preparing the preview. The file is copied from the cooler first, and an HEVC file is then converted, which takes a few seconds.";
const POWER_ICON = html`<svg aria-hidden="true" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#7C8088" stroke-width="2" stroke-linecap="round"><path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>`;

/** One preview slot: drawn when it holds an item and the overlay is shown, else hidden. */
function previewSlot(state: AppState, index: number) {
  const config = state.config;
  const item = config?.items[index] ?? "";
  const hot = state.hotSlot === index;
  const shown = !!config && !!item && config.statsVisible !== false;
  let cell = EMPTY;
  if (shown) cell = slotCell(item, state.catalog, state.stats?.values ?? {}, new Date());
  // An empty slot under the pointer still gets its outline, labelled with its number.
  else if (config && hot) cell = { ...EMPTY, title: `Slot ${index + 1}` };
  // Before the first poll the slots are drawn empty, not hidden, as the old page drew them.
  const hidden = !!config && !shown;
  // The colours as the colour inputs hold them (#rrggbb), so the two compare equal.
  const title = shown && config ? { color: rgbHex(config.titleColor).toLowerCase() } : {};
  const content = shown && config ? { color: rgbHex(config.contentColor).toLowerCase() } : {};
  return html`<div class="slot s${index + 1}${hidden ? " hidden" : ""}${hot ? " hot" : ""}" id="ps${index + 1}" aria-hidden="true"><span
    class="t" style=${styleMap(title)}>${cell.title}</span><span class="v" style=${styleMap(content)}>${cell.value}</span><span
    class="n" style=${styleMap(content)}>${cell.unit}</span></div>`;
}

/**
 * The overlay drawn over the hero: the six slots where HomeUI places them, with the last
 * sample's values, and the coverage-animation layer. Drawn in every view; the standby, down and
 * mirror views cover it.
 */
function statsPreview(state: AppState) {
  const filter = state.config
    ? { display: state.config.filter.on ? "block" : "none", opacity: String(state.config.filter.opacity / 100) }
    : {};
  return html`${Array.from({ length: SLOT_COUNT }, (_, index) => previewSlot(state, index))}<div class="filter" id="pfilter"
    style=${styleMap(filter)}></div>`;
}

/**
 * The desktop-mirror view: two sketched windows, the chip naming the display's state, burn-in
 * protection's chip (red while protection is off), and the caption saying where KDE places and
 * scales Virtual-RYUO.
 */
function mirrorView(state: AppState, actions: Actions | undefined, shown: boolean) {
  const status = state.display;
  const protection = state.protection;
  const open = !!state.desktop?.displaySettings;
  return html`<div class="mirror-view" id="mirrorView" ?hidden=${!shown}>
    <div class="win" aria-hidden="true" style="left: 8%; top: 14%; width: 46%; height: 60%; background: #181B22; border: 1px solid #2A2E38"></div>
    <div class="win" aria-hidden="true" style="left: 44%; top: 30%; width: 44%; height: 56%; background: #1B1F27; border: 1px solid #2E3340"></div>
    <div class="chip" id="mirrorChip">${mirrorChipText(status)}</div>
    <div class=${protection && !protection.enabled ? "chip prot warn" : "chip prot"} id="protChip" ?hidden=${!protection}>${protection ? protectionChip(protection) : ""}</div>
    <p class="caption" id="mirrorHint" ?hidden=${!mirrorHintShown(status)}><span id="mirrorHintText">Position and scale: System Settings → Display &amp; Monitor → Display Configuration → Virtual-RYUO</span><button
      class="btn mini" id="mirrorSettings" type="button" aria-label="Open Display Configuration" title="Open Display Configuration"
      ?hidden=${!open} @click=${() => actions?.openDisplaySettings()}>Open</button></p>
  </div>`;
}

/**
 * The hero: the panel as it looks, 2240×1080 mapped onto the box. The host is the hero box
 * (#hero, class "hero"), and `data-view` names the view shown: "down" while ryuod does not
 * answer, "preview" for a file the user clicked, "standby" with Turn on, "mirror" for the
 * desktop mirror, or "live" for the background playing on the panel. The stats overlay is drawn
 * over the preview and the live view.
 */
export class RyuoHero extends RyuoElement {
  /** The file loaded into the <video> or <img>, or null. */
  #file: string | null = null;

  /**
   * Scroll the hero into view below the sticky header, whose height grows when it wraps. The
   * Background tab calls this when a tile's thumbnail is clicked.
   */
  reveal(): void {
    const header = document.getElementById("hdr");
    this.style.scrollMarginTop = `${(header?.offsetHeight ?? 0) + 12}px`;
    // Not every DOM has it (happy-dom in the tests).
    if (this.scrollIntoView) this.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  #video(): HTMLVideoElement | null {
    return this.querySelector<HTMLVideoElement>("#heroVideo");
  }

  #status(text: string): void {
    const status = this.querySelector("#heroStatus");
    if (status) status.textContent = text;
  }

  /**
   * Load `name` into the <video> or <img>, or empty both. The media elements are driven here,
   * not by the template, so their source changes only when the file does: setting it again
   * would restart the video on every poll.
   */
  #setFile(name: string | null): void {
    if (name === this.#file) return;
    this.#file = name;
    const video = this.#video();
    const image = this.querySelector<HTMLImageElement>("#heroImage");
    if (!video || !image) return;
    this.#stopVideo(video);
    image.removeAttribute("src");
    video.removeAttribute("poster");
    video.hidden = image.hidden = true;
    this.#status("");
    if (!name) return;
    if (isImage(name)) {
      image.hidden = false;
      image.src = mediaUrl("preview", name);
      return;
    }
    video.hidden = false;
    // The thumbnail shows while ryuod prepares the preview.
    video.setAttribute("poster", mediaUrl("thumb", name));
    this.#status(PREPARING);
    video.src = mediaUrl("preview", name);
    const playing = video.play?.() as Promise<void> | undefined;
    playing?.catch(() => {
      // autoplay refused; the poster stays
    });
  }

  #stopVideo(video: HTMLVideoElement): void {
    // pause and load are missing from happy-dom's media element in the tests.
    video.pause?.();
    video.removeAttribute("src");
    // Drops the connection still streaming the old file.
    video.load?.();
  }

  async #previewFailed(): Promise<void> {
    const name = this.#file;
    if (!name) return;
    const why = await previewError(name);
    if (this.#file === name) this.#status(`Preview failed: ${why}`);
  }

  // An element without a source reports an error too, when its source is removed.
  #mediaError(event: Event): void {
    if ((event.target as Element).getAttribute("src")) void this.#previewFailed();
  }

  /** Apply in the preview bar: at once, or the bar asks first and Replace takes the focus. */
  #apply(): void {
    if (this.app?.actions.askApply()) this.querySelector<HTMLElement>("#pvReplace")?.focus();
  }

  #cancelApply(): void {
    this.app?.actions.cancelApply();
    this.querySelector<HTMLElement>("#pvApply")?.focus();
  }

  #previewBar(state: AppState, shown: boolean) {
    const actions = this.app?.actions;
    const name = state.preview ?? "";
    const asking = state.applyAsking;
    const count = state.config?.media.length ?? 0;
    const note =
      state.panel?.on === false
        ? "panel in standby"
        : state.config?.media.includes(name)
          ? "in the playlist"
          : "not on the panel yet";
    // The visible label is just "Apply"; the name and tooltip say what it applies.
    const applyLabel = `Apply: show ${name} on the panel`;
    return html`<div class=${asking ? "pvbar asking" : "pvbar"} id="previewBar" ?hidden=${!shown}>
      <span class="pv-badge">PREVIEW</span>
      <span id="pvName" title=${name}>${name}</span>
      <span id="pvNote" ?hidden=${asking}>${note}</span>
      <button class="btn primary" id="pvApply" type="button" ?hidden=${asking} aria-label=${applyLabel} title=${applyLabel}
        @click=${() => this.#apply()}>Apply</button>
      <!-- Shown in place of the note and Apply when Apply would replace a playlist of several files. -->
      <span id="pvAsk" ?hidden=${!asking}><span class="ask-long" id="pvAskLong">Replace the ${count}-file playlist with this file?</span><span
        class="ask-short" id="pvAskShort">Replace ${count} files?</span></span>
      <button class="btn primary" id="pvReplace" type="button" ?hidden=${!asking} @click=${() => actions?.showOnPanel()}>Replace</button>
      <button class="btn" id="pvCancel" type="button" ?hidden=${!asking} @click=${() => this.#cancelApply()}>Cancel</button>
      <button class="btn icon" id="pvClose" type="button" aria-label="Back to live view" ?hidden=${asking} @click=${() => actions?.closePreview()}>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`;
  }

  protected override render() {
    const state = this.app?.store.state;
    if (!state) return null;
    const actions = this.app?.actions;
    const view = heroView(state);
    const live = liveName(state.config);
    const playable = livePlayable(live, state.media);
    const lost = !!state.device && !state.device.connected;
    const count = state.config?.media.length ?? 0;
    const more = count > 1 ? ` + ${count - 1} more` : "";
    // The media elements and the status line carry no bindings: #setFile drives them.
    return html`<div class="hint" id="heroHint" aria-hidden="true">${heroHint(view, live, playable)}</div>
      <img class="media" id="heroImage" alt="Preview of the selected file" hidden @error=${this.#mediaError}>
      <video id="heroVideo" muted loop playsinline hidden @loadeddata=${() => this.#status("")} @error=${this.#mediaError}></video>
      ${statsPreview(state)}
      <div class="chip" id="liveChip" ?hidden=${!(view === "live" && (live || lost))}><span class=${lost ? "dot bad" : "dot ok"}
        id="liveDot"></span><span id="liveText">${lost ? "Cooler not connected · changes apply on reconnect" : `Live · ${live}${more}`}</span></div>
      <p class="hero-status" id="heroStatus" aria-live="polite"></p>
      ${this.#previewBar(state, view === "preview")}
      ${mirrorView(state, actions, view === "mirror")}
      <div class="standby-view" id="standbyView" ?hidden=${view !== "down"}>
        ${POWER_ICON}
        <b>ryuod is not answering</b>
        <span>Without ryuod the panel goes to standby after 5 s. <span id="standbyText">${state.unreachable ?? ""}</span></span>
      </div>
      <div class="standby-view" id="panelOffView" ?hidden=${view !== "standby"}>
        ${POWER_ICON}
        <b>Panel in standby</b>
        <span>The cooler shows its standby video. Changes are saved and shown when it turns on.</span>
        <button class="btn" id="panelTurnOn" type="button" ?disabled=${state.editing.has("panel.on")}
          @click=${() => actions?.sendPanel(true)}>Turn on</button>
      </div>`;
  }

  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    const state = this.app?.store.state;
    if (!state) return;
    const view = heroView(state);
    const live = liveName(state.config);
    this.dataset.view = view;
    this.#setFile(heroFile(view, state.preview, live, livePlayable(live, state.media)));
  }
}
