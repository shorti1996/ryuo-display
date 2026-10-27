import { html, type PropertyDeclarations, type PropertyValues } from "lit";
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
// The old page's markup in index.html, not yet ported to an element, by the selector that finds it.
const STATIC_PARTS = {
  hero: ":scope > #hero",
  strip: ":scope > .strip",
  overlay: ":scope > #tp-overlay",
  background: ":scope > #tp-background",
  mirror: ":scope > #tp-mirror",
} as const;
type StaticPart = keyof typeof STATIC_PARTS;
const KEY_MOVES: Record<string, (index: number) => number> = {
  ArrowRight: (index) => index + 1,
  ArrowLeft: (index) => index - 1,
  Home: () => 0,
  End: () => TABS.length - 1,
};

/** The shell: header with the connection pill, the tabs, the App tab and the result toast. */
export class RyuoApp extends RyuoElement {
  static override properties: PropertyDeclarations = { tab: { state: true } };
  declare tab: Tab;
  #parts: Partial<Record<StaticPart, Element>> = {};
  #focusTab = false;

  constructor() {
    super();
    this.tab = "overlay";
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    // The static parts are taken out before the first render and put back by the template, in
    // the old page's order: Lit renders after an element's existing children, and these sit
    // between parts the template draws (the hero before the tab list, the panels after it).
    // Taken here rather than on connect: an element already defined when its markup is parsed
    // (each test after the first) is connected before its children are.
    if (this.hasUpdated) return;
    for (const [name, selector] of Object.entries(STATIC_PARTS) as [StaticPart, string][]) {
      const part = this.querySelector(selector);
      if (part) this.#parts[name] = part;
    }
    this.replaceChildren();
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
    for (const tab of ["overlay", "background", "mirror"] as const) {
      const panel = this.#parts[tab] as HTMLElement | undefined;
      if (panel) panel.hidden = tab !== this.tab;
    }
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
    return html`<header id="hdr">
      <h1>RYUO IV LCD</h1>
      <div class="grow"></div>
      <button class=${tone ? `pill ${tone}` : "pill"} id="connPill" type="button" aria-label="Connection details"
        aria-live="polite" title=${errorText(state)} @click=${() => this.select("app", true)}>
        <span class=${tone ? `dot ${tone}` : "dot"} id="dot"></span><span id="conn">${conn}</span><span id="connFw">${firmware}</span>
      </button>
      <!-- Ported with the hero; hidden until then. -->
      <button class="pill panel-sw" id="panelSwitch" type="button" role="switch" aria-checked="true" aria-labelledby="panelName panelLabel" hidden>
        <span id="panelName">Panel</span><span class="panel-state" id="panelLabel">On</span><span class="track sm" aria-hidden="true"></span>
      </button>
    </header>`;
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
    const parts = this.#parts;
    return html`${this.#header()}
      <main>
        ${parts.hero} ${parts.strip} ${this.#tabs()} ${parts.overlay} ${parts.background} ${parts.mirror}
        <ryuo-app-tab role="tabpanel" id="tp-app" aria-labelledby="tab-app" class="cols" ?hidden=${this.tab !== "app"}
          .app=${this.app}></ryuo-app-tab>
      </main>
      ${this.#toast()}`;
  }
}
