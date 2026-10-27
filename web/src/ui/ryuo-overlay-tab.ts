import { html } from "lit";
import type { Config, TempUnit } from "../api-types.ts";
import { rgbHex } from "../overlay.ts";
import { RyuoElement } from "./ryuo-element.ts";

const value = (event: Event) => (event.target as HTMLInputElement).value;

/**
 * The Overlay tab: the slot picker, the colours and coverage animation, and the units. The
 * host is the tab panel. Every overlay edit goes to actions.setOverlay or setSlot, which show
 * it at once and send the whole overlay 300 ms after the last edit.
 *
 * A focused colour or number input holds its key: a colour picker may be open, and a number
 * may be half typed. A range is held only while dragged (actions.drag), as the old page did.
 */
export class RyuoOverlayTab extends RyuoElement {
  /** Focus and blur handlers that hold `key` while the input has focus. */
  #holds(key: string) {
    const store = this.app?.store;
    return { focus: () => store?.edit(key, true), blur: () => store?.edit(key, false) };
  }

  #colourRow(id: "titleColor" | "contentColor", hexId: string, label: string, config: Config | null) {
    const actions = this.app?.actions;
    const colour = config ? rgbHex(config[id]) : "";
    const hold = this.#holds(id);
    // <input type=color> holds lower case; the label and the POST use capitals.
    return html`<label class="color-row"><input type="color" id=${id} .value=${colour.toLowerCase() || "#000000"}
        @focus=${hold.focus} @blur=${hold.blur}
        @input=${(event: Event) => actions?.setOverlay(id, { [id]: value(event).toUpperCase() } as Partial<Config>)}><span class="grow">${label}</span><span
        class="mono" id=${hexId}>${colour.toUpperCase()}</span></label>`;
  }

  #colours(config: Config | null) {
    const actions = this.app?.actions;
    const filter = config?.filter ?? { on: false, opacity: 100 };
    return html`<div class="card stack" style="gap: 10px">
      <h3>Colours</h3>
      ${this.#colourRow("titleColor", "titleHex", "Titles", config)}
      ${this.#colourRow("contentColor", "contentHex", "Values and units", config)}
      <label class="check split"><input type="checkbox" id="filterOn" .checked=${filter.on}
        @input=${(event: Event) => actions?.setOverlay("filterOn", { filter: { ...filter, on: (event.target as HTMLInputElement).checked } })}>Coverage animation over the text</label>
      <div class="range-row"><label for="opacity">Opacity</label><input type="range" id="opacity" min="0" max="100" step="1"
        .value=${String(filter.opacity)} ?disabled=${!!config && !filter.on}
        @pointerdown=${() => actions?.drag("opacity")}
        @input=${(event: Event) => actions?.setOverlay("opacity", { filter: { ...filter, opacity: Number(value(event)) } })}><span
        class="mono" id="opacityOut">${config ? `${filter.opacity} %` : ""}</span></div>
    </div>`;
  }

  #units(config: Config | null) {
    const actions = this.app?.actions;
    const hold = this.#holds("memoryMHz");
    const radio = (unit: TempUnit, label: string) =>
      html`<label><input type="radio" name="unit" value=${unit} .checked=${config?.tempUnit === unit}
        @change=${() => actions?.sendPrefs({ tempUnit: unit })}>${label}</label>`;
    return html`<div class="card stack">
      <h3>Units</h3>
      <div class="kv"><span id="unitLabel">Temperature</span>
        <div class="seg units" role="radiogroup" aria-labelledby="unitLabel">${radio("Celsius", "°C")}${radio("Fahrenheit", "°F")}</div>
      </div>
      <div class="kv"><label for="memMHz">Memory MHz</label><input type="number" id="memMHz" min="0" max="20000" step="1"
        .value=${config ? String(config.memoryMHz) : ""} @focus=${hold.focus} @blur=${hold.blur}
        @change=${(event: Event) => {
          const megahertz = Number.parseInt(value(event), 10);
          if (Number.isInteger(megahertz)) actions?.sendPrefs({ memoryMHz: megahertz });
        }}></div>
      <p class="note">No Linux source without root. 0 hides Memory Frequency.</p>
    </div>`;
  }

  protected override render() {
    const state = this.app?.store.state;
    const config = state?.config ?? null;
    // ryuod saves overlay edits under the second display and sends them when it stops.
    return html`<div class="card main-col" id="slotCard">
        <p class="note mirror-held" id="overlayMirrorNote" ?hidden=${!state?.displayWant}>The panel shows the desktop, with no stats overlay. Changes here are saved and applied when the second display stops.</p>
        <ryuo-slot-picker .app=${this.app}></ryuo-slot-picker>
        <p class="note">Hover a slot to find it on the panel. Positions are fixed by the firmware; choose a stat's position by choosing its slot. "Fan Speed" items draw any label with the unit RPM. The overlay hides for about 2 s every 5 min (device burn-in protection).</p>
        <p class="note" id="geometryNote">Slot geometry from HomeUI's layout; values from the last sample.</p>
      </div>
      <div class="side-col">${this.#colours(config)}${this.#units(config)}</div>`;
  }
}
