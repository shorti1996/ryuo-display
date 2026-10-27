import { html, nothing, type PropertyDeclarations, type PropertyValues } from "lit";
import { TRAY_CLICK_LABELS, TRAY_STEPS_MAX } from "../actions.ts";
import type { TrayClick, TrayStatus } from "../api-types.ts";
import { errorText } from "../state.ts";
import { RyuoElement } from "./ryuo-element.ts";

const ICON_X = html`<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

/** A heartbeat or ack age: tenths of a second under 10 s, whole seconds above, a dash when unknown. */
function age(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** The App tab: the tray settings and the device details. The host is the tab panel. */
export class RyuoAppTab extends RyuoElement {
  static override properties: PropertyDeclarations = { adding: { state: true } };
  /** The "+ Add step" field is open. */
  declare adding: boolean;

  constructor() {
    super();
    this.adding = false;
  }

  /** Open or close the new-step field. While it is open, the poll leaves the steps alone. */
  #setAdding(open: boolean): void {
    if (open === this.adding) return;
    this.adding = open;
    this.app?.store.edit("tray.brightnessSteps", open);
    this.flush();
  }

  #addStep(): void {
    const field = this.querySelector<HTMLInputElement>("#trayStepNew");
    if (!field || !this.app) return;
    // A refused step keeps the field open with the user's text, to be corrected.
    if (this.app.actions.addTrayStep(field.value)) this.#setAdding(false);
  }

  override disconnectedCallback(): void {
    this.#setAdding(false);
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (changed.has("adding") && this.adding) this.querySelector<HTMLInputElement>("#trayStepNew")?.focus();
    // The select shows the store's choice. Lit sets a select's value before it renders the
    // options, so a value bound in the template would miss them on the first render.
    const select = this.querySelector<HTMLSelectElement>("#trayClick");
    const want = this.app?.store.state.tray?.leftClick;
    if (select && want && select.value !== want) select.value = want;
  }

  #steps(tray: TrayStatus) {
    const actions = this.app?.actions;
    const chips = tray.brightnessSteps.map((step) => {
      const last = tray.brightnessSteps.length <= 1;
      // One line: whitespace inside the chip would be part of its text.
      return html`<span class="step">${step} %<button type="button" aria-label="Remove ${step} %" ?disabled=${last} title=${last ? "The tray menu needs at least one step" : `Remove ${step} %`} @click=${() => actions?.sendTray({ brightnessSteps: tray.brightnessSteps.filter((kept) => kept !== step) })}>${ICON_X}</button></span>`;
    });
    if (this.adding) {
      return html`${chips}<input type="number" id="trayStepNew" min="1" max="100" step="1" aria-label="New brightness step in %"
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              this.#addStep();
            }
            if (event.key === "Escape") this.#setAdding(false);
          }}><button class="btn" type="button" id="trayStepAdd" @click=${() => this.#addStep()}>Add</button><button class="btn" type="button" @click=${() => this.#setAdding(false)}>Cancel</button>`;
    }
    const full = tray.brightnessSteps.length >= TRAY_STEPS_MAX;
    return html`${chips}<button class="add-step" type="button" id="trayStepPlus" ?disabled=${full}
        title=${full ? `The tray menu takes at most ${TRAY_STEPS_MAX} steps` : ""} @click=${() => this.#setAdding(true)}>+ Add step</button>`;
  }

  #trayCard() {
    const store = this.app?.store;
    const tray = store?.state.tray ?? null;
    const options = tray?.leftClickOptions ?? (Object.keys(TRAY_CLICK_LABELS) as TrayClick[]);
    // A focused select may have its list open; the poll leaves its value until it loses focus.
    return html`<div class="card main-col" id="trayCard" ?hidden=${!tray}>
      <h3 style="margin: 12px 0 4px">Tray</h3>
      <button class="set-row" id="trayAutostart" type="button" role="switch" aria-checked=${tray?.autostart ? "true" : "false"}
        @click=${() => tray && this.app?.actions.sendTray({ autostart: !tray.autostart })}>
        <span class="lbl"><span>Start with the desktop session</span><span class="note">Starts the tray icon at login (~/.config/autostart/ryuo-tray.desktop)</span></span>
        <span class="track" aria-hidden="true"></span>
      </button>
      <div class="set-row"><label for="trayClick" class="grow">Left-click on the tray icon</label><select id="trayClick"
        @focus=${() => store?.edit("tray.leftClick", true)} @blur=${() => store?.edit("tray.leftClick", false)}
        @change=${(event: Event) => this.app?.actions.sendTray({ leftClick: (event.target as HTMLSelectElement).value as TrayClick })}>
        ${options.map((option) => html`<option value=${option} ?selected=${option === tray?.leftClick}>${TRAY_CLICK_LABELS[option] || option}</option>`)}
      </select></div>
      <div class="steps">
        <span id="stepsLabel">Brightness steps in the tray menu</span>
        <div class="chips" id="traySteps" role="group" aria-labelledby="stepsLabel">${tray ? this.#steps(tray) : nothing}</div>
        <p class="note">In % of the full backlight: 1 to 8 steps, each a whole number from 1 to 100.</p>
      </div>
    </div>`;
  }

  #about() {
    const state = this.app?.store.state;
    const device = state?.device ?? null;
    const error = errorText(state);
    return html`<div class="card stack" style="flex: 1 1 300px; gap: 4px">
      <h3 style="margin-bottom: 8px">Device &amp; connection</h3>
      <dl class="about">
        <div><dt>Model</dt><dd id="model">${device?.product || "—"}</dd></div>
        <div><dt>Firmware</dt><dd id="fw">${device?.firmware || "—"}</dd></div>
        <div><dt>Device</dt><dd id="hidraw">${device?.hidraw || "—"}</dd></div>
        <div><dt>Heartbeat</dt><dd id="hb">${device ? `${age(device.lastHeartbeatMs)} ago` : "—"}</dd></div>
        <div><dt>HomeUI ack</dt><dd id="ack">${device ? `${age(device.lastHomeuiAckMs)} ago` : "—"}</dd></div>
        <div><dt>Reconnects</dt><dd id="rec">${device ? String(device.recoveries || 0) : "—"}</dd></div>
        <div id="errRow" ?hidden=${!error}><dt>Last error</dt><dd id="err">${error}</dd></div>
      </dl>
    </div>`;
  }

  protected override render() {
    return html`${this.#trayCard()}${this.#about()}`;
  }
}
