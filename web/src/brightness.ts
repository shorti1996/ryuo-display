/**
 * The brightness scales. The cooler takes 0-102 (ryuod's "device scale"); HomeUI lights the
 * backlight at floor(value × 2.5) of 255 levels, so 100 gives 250/255 and 102 gives 255/255.
 * The page shows and sends a percentage of the full backlight (0-100), which ryuod maps to the
 * device scale with brightness_value() and back with brightness_percent().
 */

export const BRIGHTNESS_MAX = 102; // ryuod's P.BRIGHTNESS_MAX: the top of the device scale

/**
 * Python's round(): a half goes to the even neighbour. ryuod rounds this way, and
 * brightnessValue(75) is 76 under it but 77 under Math.round.
 */
export function pythonRound(number: number): number {
  const floor = Math.floor(number);
  if (Math.abs(number - floor - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(number);
}

/** The backlight level (0-255) a device-scale value lights: HomeUI's (int)(value * 2.5). */
export function backlightLevel(value: number): number {
  return Math.min(255, Math.floor(value * 2.5));
}

/** ryuod.brightness_percent(): a device-scale value as the share of the 255 levels it lights. */
export function brightnessPercent(value: number): number {
  return pythonRound((backlightLevel(value) * 100) / 255);
}

/**
 * ryuod.brightness_value(): the device-scale value ryuod picks for a percentage. The 103 device
 * values give 92 distinct percentages, so some percentages come back from the cooler 1 % off.
 */
export function brightnessValue(percent: number): number {
  return Math.min(BRIGHTNESS_MAX, pythonRound((percent * 255) / 250));
}

/** The slider's readout and tooltip for a percentage. */
export function brightnessLabel(percent: number): { text: string; title: string } {
  return { text: `${percent} %`, title: `${percent} % of the full backlight` };
}
