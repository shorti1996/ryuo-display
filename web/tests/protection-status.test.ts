// @vitest-environment node
/**
 * Burn-in protection's pure parts (protection.ts): the section a poll or a POST reply gives, the
 * durations, and the status line and chip. The page's card and chip are in protection.test.js.
 */
import { describe, expect, it } from "vitest";

import type { ProtectionStatus } from "../src/api-types.ts";
import {
  formatDuration,
  type Protection,
  protectionChip,
  protectionFrom,
  protectionReplied,
  protectionStatus,
  protectionText,
} from "../src/protection.ts";

/** Protection on, with no report from the receiver, changed by `change`. */
function protection(change: Partial<Protection> = {}): Protection {
  return { enabled: true, state: null, idleS: null, nextShiftS: null, ...change };
}

/** ryuod.Display.status()["protection"], changed by `change`. */
function report(change: Partial<ProtectionStatus> = {}): ProtectionStatus {
  return { enabled: true, state: "active", idleS: 5, nextShiftS: 118, frames: { floor: 900 }, ...change };
}

describe("formatDuration", () => {
  it("gives seconds under 1 min and whole minutes from 1 min", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(42.4)).toBe("42 s");
    expect(formatDuration(59)).toBe("59 s");
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(118)).toBe("2 min");
    expect(formatDuration(725)).toBe("12 min");
  });

  it("never shows a negative time", () => {
    expect(formatDuration(-3)).toBe("0 s");
  });
});

describe("protectionText", () => {
  it.each([
    [protection({ enabled: false, state: "active", nextShiftS: 30 }), "off"],
    [protection(), "starts with the mirror"],
    [protection({ state: "active", idleS: 5, nextShiftS: 118 }), "active · next shift in 2 min"],
    [protection({ state: "active", idleS: 5 }), "active"],
    [protection({ state: "dimmed", idleS: 250 }), "dimmed · idle 4 min"],
    [protection({ state: "dimmed" }), "dimmed"],
    [protection({ state: "black", idleS: 725 }), "black · idle 12 min"],
    [protection({ state: "refresh", idleS: 20 }), "refreshing"],
    [protection({ state: "off" }), "off"],
    [protection({ state: "sleeping" }), "sleeping"],
  ])("reads %j as %j", (current, text) => {
    expect(protectionText(current)).toBe(text);
  });
});

describe("protectionStatus and protectionChip", () => {
  it("share the status line while protection is on", () => {
    const current = protection({ state: "dimmed", idleS: 185 });
    expect(protectionStatus(current)).toBe("Protection: dimmed · idle 3 min");
    expect(protectionChip(current)).toBe("Protection: dimmed · idle 3 min");
  });

  it("warn in the chip while protection is off", () => {
    const current = protection({ enabled: false });
    expect(protectionStatus(current)).toBe("Protection: off");
    expect(protectionChip(current)).toBe("Burn-in protection off");
  });
});

describe("protectionFrom", () => {
  it("is null for a ryuod without config.burnInProtection", () => {
    expect(protectionFrom({}, { protection: report() }, protection(), false)).toBeNull();
    expect(protectionFrom(null, null, null, false)).toBeNull();
  });

  it("takes the saved switch and the receiver's report, without the frame sizes", () => {
    expect(protectionFrom({ burnInProtection: false }, { protection: report() }, null, false)).toEqual({
      enabled: false,
      state: "active",
      idleS: 5,
      nextShiftS: 118,
    });
  });

  it("has no report without a second display or before the receiver's first", () => {
    expect(protectionFrom({ burnInProtection: true }, null, null, false)).toEqual(protection());
    expect(protectionFrom({ burnInProtection: true }, {}, null, false)).toEqual(protection());
  });

  it("keeps the page's switch while its POST runs, and still takes the report", () => {
    const current = protection({ enabled: false });
    const held = protectionFrom({ burnInProtection: true }, { protection: report({ state: "dimmed" }) }, current, true);
    expect(held).toEqual({ enabled: false, state: "dimmed", idleS: 5, nextShiftS: 118 });
  });

  it("takes ryuod's switch once the POST is done", () => {
    const current = protection({ enabled: false });
    expect(protectionFrom({ burnInProtection: true }, null, current, false)?.enabled).toBe(true);
  });
});

describe("protectionReplied", () => {
  it("takes the reply's report and the switch ryuod saved", () => {
    const current = protection({ enabled: true, state: "black", idleS: 700 });
    const reply = report({ enabled: false, state: "off", idleS: 0, nextShiftS: null });
    expect(protectionReplied(current, reply, false)).toEqual({
      enabled: false,
      state: "off",
      idleS: 0,
      nextShiftS: null,
    });
  });
});
