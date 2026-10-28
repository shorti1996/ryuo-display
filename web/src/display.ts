/**
 * The second display's pure parts: the status line, the dot, the notes under the switch, the
 * hero's mirror chip, and which controls ryuod would refuse. No DOM; the Desktop mirror tab, the
 * strip, the header and the hero's mirror view render these.
 */
import type { DesktopStatus, DisplayStatus } from "./api-types.ts";

// ryuod's 409 reasons. The page disables the control that would get one and shows it as the tooltip.
export const MIRROR_IN_STANDBY = "the panel is in standby; turn it on before the second display";
export const STANDBY_IN_MIRROR = "the panel shows the second display; turn that off before standby";
export const ASK_WHILE_STARTING = "the second display is starting; try again once it is on or off";

/** The status line for a ryuod without the second display (GET /api/state's display is null). */
export const NOT_AVAILABLE = "Not available: this ryuod has no second-display support. Restart it.";

/** The status line beside the switch, in the user's words, with units. */
export function displayText(status: DisplayStatus): string {
  switch (status.state) {
    case "off":
      return "Off";
    case "starting":
      return `Starting${status.message ? `: ${status.message}` : "…"}`;
    case "on":
      if (status.fps == null) return "On. The frame rate shows after the first 5 s.";
      if (status.fps === 0) return "On. No frames sent in the last 5 s: nothing on the virtual monitor changed.";
      return `On: ${status.fps.toFixed(1)} frames/s at ${(status.mbps ?? 0).toFixed(1)} Mb/s to the panel (average over 5 s)`;
    case "stopping":
      return "Stopping: removing the virtual monitor, up to about 10 s…";
    case "retrying":
      return `Not running. Next try in ${status.retryInS ?? 0} s.`;
    case "error":
      return "Stopped by an error that a retry would hit again. Fix the cause, then press Try again now. It is also tried again when the cooler reconnects.";
    default:
      // A state this page does not know yet: ryuod's own word for it beats nothing.
      return (status as { state: string }).state;
  }
}

/** A start that failed: the error lines and Try again now show. */
export function displayFailed(status: DisplayStatus | null): boolean {
  return !!status && (status.state === "retrying" || status.state === "error");
}

/** The status dot's class: red for a failed start, green while on, grey otherwise. */
export function displayDot(status: DisplayStatus | null): string {
  if (!status) return "dot";
  if (displayFailed(status)) return "dot bad";
  return status.state === "on" ? "dot ok" : "dot";
}

/** The mouse-pointer note, or "" while the display is not starting or on, or ryuod has not said. */
export function pointerText(status: DisplayStatus | null): string {
  const pointer = status && (status.state === "on" || status.state === "starting") ? status.pointer : null;
  if (!pointer) return "";
  return pointer.shown
    ? "Mouse pointer: shown on the panel."
    : `No mouse pointer on the panel: ${pointer.reason || "unknown reason"}. Turn the switch off and on to choose the screen again.`;
}

/** The warning when ryuod could not put the black background on the cooler, or "". */
export function backgroundText(status: DisplayStatus | null): string {
  const error = status?.backgroundError;
  return error
    ? `Couldn't put the black background on the cooler: ${error}. While the panel shows the desktop, HomeUI's video plays under it and uses more of the cooler's decoder.`
    : "";
}

/** What the screen-share note says about the saved choice. */
export function choiceText(desktop: DesktopStatus): string {
  return desktop.portalTokenSaved
    ? "A screen-share choice is saved, so starts skip the question. Ask again deletes it."
    : "No screen-share choice is saved; the next start asks which screen to share.";
}

const CHIP_STATES: Partial<Record<DisplayStatus["state"], string>> = {
  on: "Virtual-RYUO 2240×1080",
  starting: "starting…",
  stopping: "stopping…",
  retrying: "not running, see the Desktop mirror tab",
  error: "stopped by an error, see the Desktop mirror tab",
};

/** The chip in the hero's mirror view. */
export function mirrorChipText(status: DisplayStatus | null): string {
  return `Desktop mirror · ${status ? (CHIP_STATES[status.state] ?? status.state) : "Virtual-RYUO 2240×1080"}`;
}

/** The hero's "Position and scale" caption shows only while the virtual monitor exists. */
export function mirrorHintShown(status: DisplayStatus | null): boolean {
  return !status || status.state === "on";
}

/** What mirrorSwitch reads: GET /api/state's parts and the switch as shown (state.ts AppState). */
export interface SwitchInputs {
  device: unknown;
  display: DisplayStatus | null;
  panel: { on: boolean } | null;
  displayWant: boolean;
}

/**
 * Whether the second-display controls can be used (`available`), and whether standby locks out
 * starting it (`blocked`, with MIRROR_IN_STANDBY as the tooltip). Before the first poll
 * (`device` still null) they stay enabled, as the old page left its markup until ryuod answered.
 */
export function mirrorSwitch(state: SwitchInputs | undefined): { available: boolean; blocked: boolean } {
  if (!state?.device) return { available: true, blocked: false };
  // ryuod refuses to start the second display during standby; stopping it is always allowed.
  const blocked = state.panel?.on === false && !state.displayWant;
  return { available: !!state.display, blocked };
}

/** Standby is refused while the second display runs: the header's panel switch is locked out then. */
export function standbyBlocked(state: Pick<SwitchInputs, "panel" | "displayWant"> | undefined): boolean {
  return !!state?.panel?.on && state.displayWant;
}

/**
 * The switch is off but the virtual monitor is still there: from the click until ryuod answers
 * (still "on"), then while it is removed ("stopping", up to about 10 s). The panel shows the
 * desktop until then, so the hero keeps the mirror view with a note that the switch is under way.
 */
export function mirrorLeaving(displayWant: boolean, status: DisplayStatus | null): boolean {
  return !displayWant && (status?.state === "on" || status?.state === "stopping");
}

/**
 * The hero shows the desktop mirror: the switch is on (the user's click, before ryuod has
 * answered), or the virtual monitor is still being removed.
 */
export function heroMirror(displayWant: boolean, status: DisplayStatus | null): boolean {
  return displayWant || mirrorLeaving(displayWant, status);
}
