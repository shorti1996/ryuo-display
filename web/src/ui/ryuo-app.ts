import { html, nothing, type PropertyDeclarations, type PropertyValues } from "lit";
import { brightnessLabel } from "../brightness.ts";
import { MIRROR_IN_STANDBY, mirrorSwitch, STANDBY_IN_MIRROR, standbyBlocked } from "../display.ts";
import { errorText } from "../state.ts";
import { RyuoElement } from "./ryuo-element.ts";

const TABS = ["overlay", "background", "mirror", "app"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overlay: "Overlay",
  background: "Background",
  mirror: "Desktop mirror",
  app: "App",
};
const SUN = html`<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#A6A9B0" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const KEY_MOVES: Record<string, (index: number) => number> = {
  ArrowRight: (index) => index + 1,
  ArrowLeft: (index) => index - 1,
  Home: () => 0,
  End: () => TABS.length - 1,
};

/**
 * The shell: header with the connection pill and the panel switch, the hero, the strip under it
 * ("Panel shows" segments, overlay box, brightness, sample time), the tabs and their panels, and
 * the toast.
 */
export class RyuoApp extends RyuoElement {
  static override properties: PropertyDeclarations = { tab: { state: true } };
  declare tab: Tab;
  #focusTab = false;
  // A drag ends wherever the pointer is released, often off the slider.
  #endDrag = () => this.app?.actions.endDrag();

  constructor() {
    super();
    this.tab = "overlay";
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("pointerup", this.#endDrag);
    window.addEventListener("pointercancel", this.#endDrag);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("pointerup", this.#endDrag);
    window.removeEventListener("pointercancel", this.#endDrag);
    super.disconnectedCallback();
  }

  /** Show tab `id`, and give it focus when the user moved there from the keyboard or the pill. */
  select(id: Tab, focus = false): void {
    this.tab = id;
    this.#focusTab = focus;
    this.flush();
  }

  #tabKeys(event: KeyboardEvent): void {
    const index = TABS.indexOf((event.target as HTMLElement).id.slice(4) as Tab);
    const move = KEY_MOVES[event.key];
    if (!move || index < 0) return;
    event.preventDefault();
    this.select(TABS[(move(index) + TABS.length) % TABS.length], true);
  }

  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (this.#focusTab) {
      this.#focusTab = false;
      this.querySelector<HTMLElement>(`#tab-${this.tab}`)?.focus();
    }
  }

  #header() {
    const state = this.app?.store.state;
    const device = state?.device ?? null;
    const down = state ? state.unreachable !== null : false;
    // Before the first poll the pill is neither good nor bad.
    const tone = down ? "bad" : device ? (device.connected ? "ok" : "bad") : "";
    const conn = down
      ? "Daemon unreachable"
      : device
        ? device.connected
          ? "Connected"
          : "Not connected"
        : "connecting…";
    const firmware = !down && device?.connected && device.firmware ? ` · ${device.firmware}` : "";
    const panel = state?.panel ?? null;
    // ryuod refuses standby while the second display runs, so the switch is locked out then.
    // displayWant, not ryuod's display.on: the lock follows a click on the mirror switch at once.
    const blocked = standbyBlocked(state);
    const sending = state?.editing.has("panel.on") ?? false;
    return html`<header id="hdr">
      <h1>RYUO Display</h1>
      <div class="grow"></div>
      <button class=${tone ? `pill ${tone}` : "pill"} id="connPill" type="button" aria-label="Connection details"
        aria-live="polite" title=${errorText(state)} @click=${() => this.select("app", true)}>
        <span class=${tone ? `dot ${tone}` : "dot"} id="dot"></span><span id="conn">${conn}</span><span id="connFw">${firmware}</span>
      </button>
      <!-- Hidden until a state poll has carried the panel's state. -->
      <button class="pill panel-sw" id="panelSwitch" type="button" role="switch" aria-checked=${panel?.on ? "true" : "false"}
        aria-labelledby="panelName panelLabel" ?hidden=${!panel} ?disabled=${blocked || sending} title=${blocked ? STANDBY_IN_MIRROR : ""}
        @click=${() => panel && this.app?.actions.sendPanel(!panel.on)}>
        <span id="panelName">Panel</span><span class="panel-state" id="panelLabel">${panel?.on === false ? "Standby" : "On"}</span><span class="track sm" aria-hidden="true"></span>
      </button>
    </header>`;
  }

  #strip() {
    const state = this.app?.store.state;
    const actions = this.app?.actions;
    const config = state?.config ?? null;
    // The panel shows the desktop: the overlay is hidden there until the second display is off.
    const mirror = state?.displayWant ?? false;
    const { available, blocked } = mirrorSwitch(state);
    const label = config ? brightnessLabel(config.brightnessPercent) : null;
    const sampledAt = state?.stats?.sampledAt;
    const checked = (event: Event) => (event.target as HTMLInputElement).checked;
    // A click on the segment already pressed sends nothing.
    return html`<div class="card strip">
      <div class="seg" role="group" aria-label="Panel shows">
        <button id="modeStats" type="button" aria-pressed=${mirror ? "false" : "true"} ?disabled=${!available}
          @click=${() => mirror && actions?.sendDisplay(false)}>Stats &amp; background</button>
        <button id="modeMirror" type="button" aria-pressed=${mirror ? "true" : "false"} ?disabled=${!available || blocked}
          title=${blocked ? MIRROR_IN_STANDBY : ""} @click=${() => !mirror && actions?.sendDisplay(true)}>Desktop mirror</button>
      </div>
      <label class=${mirror ? "check off" : "check"} id="statsOnLabel"
        title=${mirror ? "The panel shows the desktop; the overlay returns when the second display is off." : "Stats overlay on the panel. Off hides it and keeps your slot choices."}><input
        type="checkbox" id="statsOn" .checked=${config ? config.statsVisible !== false : false} ?disabled=${mirror}
        @input=${(event: Event) => actions?.setOverlay("statsOn", { statsVisible: checked(event) })}>Overlay</label>
      <div class="bright">
        ${SUN}
        <label for="brightness" class="sr-only">Brightness</label>
        <!-- In % of the full backlight; ryuod maps it to the device scale, 0-102. 50 is a range's own default. -->
        <input type="range" id="brightness" min="0" max="100" step="1" .value=${String(config?.brightnessPercent ?? 50)}
          aria-valuetext=${label?.text ?? nothing} title=${label?.title ?? nothing}
          @pointerdown=${() => actions?.drag("brightness")}
          @input=${(event: Event) => actions?.setBrightness(Number((event.target as HTMLInputElement).value))}>
        <span id="brightOut">${label?.text ?? ""}</span>
      </div>
      <span id="sampled">${sampledAt ? `sampled ${new Date(sampledAt).toLocaleTimeString()}` : ""}</span>
    </div>`;
  }

  #tabs() {
    return html`<div role="tablist" aria-label="Settings" id="tabs" @keydown=${this.#tabKeys}>
      ${TABS.map((tab) => {
        const on = tab === this.tab;
        return html`<button role="tab" type="button" id="tab-${tab}" aria-controls="tp-${tab}" aria-selected=${on ? "true" : "false"}
          tabindex=${on ? "0" : "-1"} @click=${() => this.select(tab)}>${TAB_LABELS[tab]}</button>`;
      })}
    </div>`;
  }

  #toast() {
    const toast = this.app?.store.state.toast;
    return html`<div class=${toast?.bad ? "toast bad" : "toast"} id="toast" title=${toast?.detail ?? ""} ?hidden=${!toast?.shown}>
      <span id="result" aria-live="polite" style="color: ${toast?.bad ? "var(--bad)" : "var(--muted)"}">${toast?.text ?? ""}</span>
      <button class="btn icon" id="resultClose" type="button" aria-label="Dismiss message" @click=${() => this.app?.actions.dismissToast()}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`;
  }

  protected override render() {
    return html`${this.#header()}
      <main>
        <ryuo-hero class="hero" id="hero" role="region" aria-label="Panel preview" .app=${this.app}></ryuo-hero>
        ${this.#strip()} ${this.#tabs()}
        <ryuo-overlay-tab role="tabpanel" id="tp-overlay" aria-labelledby="tab-overlay" class="cols" ?hidden=${this.tab !== "overlay"}
          .app=${this.app}></ryuo-overlay-tab>
        <ryuo-background-tab role="tabpanel" id="tp-background" aria-labelledby="tab-background" class="stack" style="gap: 20px"
          ?hidden=${this.tab !== "background"} .app=${this.app}></ryuo-background-tab>
        <ryuo-mirror-tab role="tabpanel" id="tp-mirror" aria-labelledby="tab-mirror" class="cols" ?hidden=${this.tab !== "mirror"}
          .app=${this.app}></ryuo-mirror-tab>
        <ryuo-app-tab role="tabpanel" id="tp-app" aria-labelledby="tab-app" class="cols" ?hidden=${this.tab !== "app"}
          .app=${this.app}></ryuo-app-tab>
      </main>
      ${this.#toast()}`;
  }
}
