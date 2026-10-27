/**
 * Burn-in protection's pure parts: the switch and receiver state the page shows, taken from a
 * poll, and the status line. The receiver on the cooler protects the OLED panel while it shows
 * the desktop; ryuod saves the switch (config.burnInProtection) and reports the receiver's state
 * in display.protection. No DOM; the Desktop mirror tab's card and the hero's chip render these.
 */
import type { Config, DisplayStatus, ProtectionStatus } from "./api-types.ts";

/** The switch and the receiver's last report, as the card and the hero chip show them. */
export interface Protection {
  enabled: boolean;
  state: ProtectionStatus["state"];
  idleS: number | null;
  nextShiftS: number | null;
}

/** The receiver's report without the switch: what a poll or a POST reply adds to `enabled`. */
function receiverReport(status: Partial<ProtectionStatus> | null | undefined): Omit<Protection, "enabled"> {
  return { state: status?.state ?? null, idleS: status?.idleS ?? null, nextShiftS: status?.nextShiftS ?? null };
}

/**
 * The protection section from a poll: null for a ryuod without config.burnInProtection, which
 * hides the card and the chip. `held`: a POST of the switch is running, so the switch keeps
 * `current`'s value and only the receiver's report is taken.
 */
export function protectionFrom(
  config: Pick<Config, "burnInProtection"> | null,
  display: Pick<DisplayStatus, "protection"> | null,
  current: Protection | null,
  held: boolean,
): Protection | null {
  const saved = config?.burnInProtection;
  if (typeof saved !== "boolean") return null;
  const enabled = held && current ? current.enabled : saved;
  return { ...receiverReport(display?.protection), enabled };
}

/** `current` with the report in a POST /api/display/protection reply and the switch ryuod saved. */
export function protectionReplied(current: Protection, status: ProtectionStatus, saved: boolean): Protection {
  return { ...current, ...receiverReport(status), enabled: saved };
}

/** Whole minutes, or seconds under 1 min. */
export function formatDuration(seconds: number): string {
  return seconds < 60 ? `${Math.max(0, Math.round(seconds))} s` : `${Math.round(seconds / 60)} min`;
}

/** The receiver's state in a few words, e.g. "active · next shift in 2 min". */
export function protectionText(current: Protection): string {
  if (!current.enabled) return "off";
  const idle = current.idleS == null ? "" : ` · idle ${formatDuration(current.idleS)}`;
  switch (current.state) {
    case null:
      // Not streaming, or no report from the receiver yet.
      return "starts with the mirror";
    case "active":
      return `active${current.nextShiftS == null ? "" : ` · next shift in ${formatDuration(current.nextShiftS)}`}`;
    case "dimmed":
      return `dimmed${idle}`;
    case "black":
      return `black${idle}`;
    case "refresh":
      return "refreshing";
    default:
      // A state this page does not know yet: the receiver's own word for it beats nothing.
      return current.state;
  }
}

/** The status line in the card, and the hero chip while protection is on. */
export const protectionStatus = (current: Protection) => `Protection: ${protectionText(current)}`;

/** The hero chip: the status, or the warning while protection is off. */
export const protectionChip = (current: Protection) =>
  current.enabled ? protectionStatus(current) : "Burn-in protection off";
