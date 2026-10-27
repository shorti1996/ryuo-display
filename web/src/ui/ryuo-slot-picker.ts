import { html, nothing, type PropertyValues } from "lit";
import { clipWarning, SLOT_NAMES, SLOT_POSITIONS, type SlotOption, slotChoices } from "../overlay.ts";
import { RyuoElement } from "./ryuo-element.ts";

const option = (choice: SlotOption, current: string) =>
  html`<option value=${choice.value} ?disabled=${choice.disabled} ?selected=${choice.value === current}>${choice.text}</option>`;

/**
 * The six slot selects and the note on titles that clip. Hovering or focusing a row outlines
 * its slot in the preview (store.hotSlot); a focused select holds `items`, since its list may be
 * open, and the poll leaves the slots until it loses focus.
 */
export class RyuoSlotPicker extends RyuoElement {
  protected override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    // Each select shows the store's item. Lit sets a select's value before it renders the
    // options, so a value bound in the template would miss them on the first render.
    const items = this.app?.store.state.config?.items;
    if (!items) return;
    this.querySelectorAll<HTMLSelectElement>("#slots select").forEach((select, index) => {
      const want = items[index] ?? "";
      if (select.value !== want) select.value = want;
    });
  }

  #row(index: number) {
    const app = this.app;
    const state = app?.store.state;
    const config = state?.config ?? null;
    const items = config?.items ?? [];
    const current = items[index] ?? "";
    const choices = config ? slotChoices(state?.catalog ?? [], items, index, config.memoryMHz) : null;
    const leave = () => app?.actions.showSlot(document.activeElement?.id === `slot${index}` ? index : null);
    return html`<div class="slot-row${state?.hotSlot === index ? " hot" : ""}" id="slotRow${index}"
        @mouseenter=${() => app?.actions.showSlot(index)} @mouseleave=${leave}>
      <span class="num" aria-hidden="true">${index + 1}</span><label for="slot${index}">${SLOT_POSITIONS[index]}</label><select
        id="slot${index}" aria-label="Slot ${SLOT_NAMES[index]}" ?disabled=${config?.statsVisible === false}
        @focus=${() => {
          app?.store.edit("items", true);
          app?.actions.showSlot(index);
        }}
        @blur=${() => {
          app?.store.edit("items", false);
          app?.actions.showSlot(null);
        }}
        @change=${(event: Event) => app?.actions.setSlot(index, (event.target as HTMLSelectElement).value)}>
        ${
          choices
            ? html`<option value="" ?selected=${current === ""}>(empty)</option>${choices.groups.map(
                (group) =>
                  html`<optgroup label=${group.label}>${group.options.map((choice) => option(choice, current))}</optgroup>`,
              )}${choices.unknown ? option(choices.unknown, current) : nothing}`
            : nothing
        }
      </select>
    </div>`;
  }

  protected override render() {
    const state = this.app?.store.state;
    const warning = state?.config ? clipWarning(state.catalog, state.config.items) : "";
    return html`<div id="slots">${SLOT_NAMES.map((_, index) => this.#row(index))}</div>
      <p class="note" id="clipWarn" aria-live="polite">${warning}</p>`;
  }
}
