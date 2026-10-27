// @vitest-environment node
/**
 * The brightness scales (brightness.ts) against ryuod's brightness_percent() and
 * brightness_value(). The expected values were computed with Python's round(), which ryuod uses.
 */
import { describe, expect, it } from "vitest";

import { backlightLevel, brightnessLabel, brightnessPercent, brightnessValue, pythonRound } from "../src/brightness.ts";
// @ts-expect-error The harness is plain JavaScript with no type declarations.
import * as fake from "./harness.js";

describe("pythonRound", () => {
  it.each([
    [0.5, 0],
    [1.5, 2],
    [2.5, 2],
    [25.5, 26],
    [76.5, 76],
    [2.4, 2],
    [2.6, 3],
  ])("rounds %f to %i, halves to the even neighbour", (number, rounded) => {
    expect(pythonRound(number)).toBe(rounded);
  });
});

describe("the device scale to percent", () => {
  it.each([
    [0, 0, 0],
    [1, 2, 1],
    [17, 42, 16],
    [35, 87, 34],
    [41, 102, 40],
    [71, 177, 69],
    [77, 192, 75],
    [90, 225, 88],
    [100, 250, 98],
    [101, 252, 99],
    [102, 255, 100],
  ])("value %i lights %i/255, %i %", (value, level, percent) => {
    expect(backlightLevel(value)).toBe(level);
    expect(brightnessPercent(value)).toBe(percent);
  });

  it("caps the backlight at 255 above the scale's top", () => {
    expect(backlightLevel(200)).toBe(255);
    expect(brightnessPercent(200)).toBe(100);
  });
});

describe("percent to the device scale", () => {
  it.each([
    [0, 0],
    [17, 17],
    [25, 26],
    [50, 51],
    [60, 61],
    [70, 71],
    [75, 76],
    [100, 102],
  ])("%i % is value %i", (percent, value) => {
    expect(brightnessValue(percent)).toBe(value);
  });

  it("never passes the top of the device scale", () => {
    expect(brightnessValue(101)).toBe(102);
  });

  it("maps every percent to a value whose percent is at most 1 off", () => {
    for (let percent = 0; percent <= 100; percent++) {
      expect(Math.abs(brightnessPercent(brightnessValue(percent)) - percent)).toBeLessThanOrEqual(1);
    }
  });

  it("maps a percent the device scale can give back to itself", () => {
    for (let value = 0; value <= 102; value++) {
      const percent = brightnessPercent(value);
      expect(brightnessPercent(brightnessValue(percent))).toBe(percent);
    }
  });
});

// The page tests' fake ryuod has its own copy of the two mappings; a page test that passes only
// holds for ryuod if the page and the fake agree on every input.
describe("agreement with the fake ryuod's mappings (tests/harness.js)", () => {
  it("brightnessPercent matches for every device value 0-102", () => {
    for (let value = 0; value <= 102; value++) {
      expect(brightnessPercent(value), `value ${value}`).toBe(fake.brightnessPercent(value));
    }
  });

  it("brightnessValue matches for every percent 0-100", () => {
    for (let percent = 0; percent <= 100; percent++) {
      expect(brightnessValue(percent), `${percent} %`).toBe(fake.brightnessValue(percent));
    }
  });
});

describe("brightnessLabel", () => {
  it("reads the percent of the full backlight", () => {
    expect(brightnessLabel(88)).toEqual({ text: "88 %", title: "88 % of the full backlight" });
  });
});
