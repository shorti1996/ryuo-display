import { html } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { rgbHex, type SlotCell, slotCell } from "../overlay.ts";
import type { AppState } from "../state.ts";
import { RyuoElement } from "./ryuo-element.ts";

const SLOT_COUNT = 6;
const EMPTY: SlotCell = { title: "", value: "", unit: "" };

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
 * sample's values, and the coverage-animation layer.
 */
export function statsPreview(state: AppState) {
  const filter = state.config
    ? { display: state.config.filter.on ? "block" : "none", opacity: String(state.config.filter.opacity / 100) }
    : {};
  return html`${Array.from({ length: SLOT_COUNT }, (_, index) => previewSlot(state, index))}<div class="filter" id="pfilter"
    style=${styleMap(filter)}></div>`;
}

/**
 * The preview's host inside the hero, which stays the old page's markup until the hero is
 * ported; the hero element then renders statsPreview() itself and this element goes.
 */
export class RyuoStatsPreview extends RyuoElement {
  protected override render() {
    const state = this.app?.store.state;
    return state ? statsPreview(state) : null;
  }
}
