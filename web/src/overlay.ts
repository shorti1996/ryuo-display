/**
 * The stats overlay's pure parts: what each slot's list offers, which titles clip, and what the
 * preview draws in a slot. No DOM; the Overlay tab, the slot picker and the preview render these.
 */
import type { CatalogItem, Config, StatValue } from "./api-types.ts";

/** The six slots, in HomeUI's order: their position on the panel, for the labels and aria. */
export const SLOT_POSITIONS = [
  "Left, upper",
  "Left, lower",
  "Right, top",
  "Right, middle",
  "Right, bottom",
  "Centre-right, lower",
];
export const SLOT_NAMES = [
  "1 · left, upper",
  "2 · left, lower",
  "3 · right, top",
  "4 · right, middle",
  "5 · right, bottom",
  "6 · centre-right, lower",
];
const GROUPS: CatalogItem["group"][] = ["CPU", "GPU", "Memory", "Storage", "Board", "Clock", "Custom"];
const WEEKS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const CUSTOM_PREFIX = "Fan Speed "; // HomeUI draws any "Fan Speed <label>" item as <label> with the unit RPM

/** The fields POST /api/overlay takes; the overlay debounce holds them all (actions.ts). */
export const OVERLAY_KEYS = ["items", "statsVisible", "titleColor", "contentColor", "filter"] as const;

export interface SlotOption {
  value: string;
  text: string;
  disabled: boolean;
}
export interface SlotGroup {
  label: string;
  options: SlotOption[];
}
/** One slot's list: "(empty)", the catalog by group, and a saved item the catalog does not list. */
export interface SlotChoices {
  groups: SlotGroup[];
  /** The slot's own item when the catalog has no entry for it, offered as "(custom label)". */
  unknown: SlotOption | null;
}

const isCustom = (item: string) => item.startsWith(CUSTOM_PREFIX);

/**
 * The options of slot `index` (0-5) for `items` as the controls hold them. An item another slot
 * uses is disabled: two slots with one item only feed the last one. Memory Frequency is left out
 * while memory MHz is 0, unless this slot holds it.
 */
export function slotChoices(
  catalog: readonly CatalogItem[],
  items: readonly string[],
  index: number,
  memoryMHz: number,
): SlotChoices {
  const current = items[index] ?? "";
  const groups: SlotGroup[] = [];
  for (const group of GROUPS) {
    const options: SlotOption[] = [];
    for (const entry of catalog.filter((candidate) => candidate.group === group)) {
      if (entry.item === "Memory Frequency" && !memoryMHz && current !== entry.item) continue;
      let text = entry.item;
      if (entry.note && entry.item === "GPU Usage") text += " (same as GPU Load)";
      if (entry.item === "GPU Power") text += " (drawn with °C unit)";
      if (!entry.available) text += " (no source)";
      // Custom labels that clip are refused by the daemon; firmware titles are fixed and allowed.
      const clips = entry.clipsIn.includes(index + 1);
      const custom = isCustom(entry.item);
      if (clips) text += custom ? " (too wide for this slot)" : " (title cut off here)";
      const usedElsewhere = items.some((other, otherIndex) => otherIndex !== index && other === entry.item);
      options.push({
        value: entry.item,
        text,
        disabled: usedElsewhere || (clips && custom && current !== entry.item),
      });
    }
    if (options.length) groups.push({ label: group === "Custom" ? "Custom (unit RPM)" : group, options });
  }
  const known = catalog.some((entry) => entry.item === current);
  const unknown = current && !known ? { value: current, text: `${current} (custom label)`, disabled: false } : null;
  return { groups, unknown };
}

/** The note under the slots naming each slot whose title runs past the panel's edge, or "". */
export function clipWarning(catalog: readonly CatalogItem[], items: readonly string[]): string {
  const cut = items.flatMap((item, index) => {
    const entry = catalog.find((candidate) => candidate.item === item);
    return entry?.clipsIn.includes(index + 1) ? [`slot ${index + 1} (${item})`] : [];
  });
  return cut.length
    ? `Title runs past the panel's right edge: ${cut.join(", ")}. Slots 1, 2 and 6 have room for it.`
    : "";
}

/** The title HomeUI draws for `item`: the catalog's, a custom label, or Date&Time's weekday and day. */
export function titleFor(item: string, catalog: readonly CatalogItem[], now: Date): string {
  if (item === "Date&Time") return `${WEEKS[now.getDay()]} ${now.getDate()}`;
  if (isCustom(item)) return item.slice(CUSTOM_PREFIX.length);
  return catalog.find((entry) => entry.item === item)?.title ?? "";
}

/** What the preview draws in one slot: title, value and unit, as HomeUI would. */
export interface SlotCell {
  title: string;
  value: string;
  unit: string;
}

/**
 * The cell for `item` from the last stats sample. An item the sample does not cover shows 0, as
 * the panel does; Date&Time comes from the browser clock, HH:MM over the seconds.
 */
export function slotCell(
  item: string,
  catalog: readonly CatalogItem[],
  values: Readonly<Record<string, StatValue>>,
  now: Date,
): SlotCell {
  const title = titleFor(item, catalog, now);
  if (item === "Date&Time") {
    return { title, value: now.toTimeString().slice(0, 5), unit: String(now.getSeconds()).padStart(2, "0") };
  }
  const stat: Partial<StatValue> = values[item] ?? {};
  return { title, value: stat.panel ?? "0", unit: stat.unit ?? (isCustom(item) ? "RPM" : "") };
}

/** A colour as `<input type=color>` holds it: #RRGGBB, so #AARRGGBB loses its alpha. */
export function rgbHex(color: string): string {
  return color.length === 9 ? `#${color.slice(3)}` : color;
}

/** The overlay's fields as POST /api/overlay takes them: colours as #RRGGBB in capitals. */
export function overlayBody(config: Config) {
  return {
    items: [...config.items],
    statsVisible: config.statsVisible !== false,
    titleColor: rgbHex(config.titleColor).toUpperCase(),
    contentColor: rgbHex(config.contentColor).toUpperCase(),
    filter: { on: config.filter.on, opacity: Number(config.filter.opacity) },
  };
}
