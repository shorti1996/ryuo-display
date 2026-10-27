// @vitest-environment node
/**
 * The Background media's pure parts (media.ts): file sizes against the old page's fmtSize()
 * (web/index.html, line 922 at eab6057), the tiles' badges, and the hero's view, file and hint
 * in the old renderHero's order.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { DisplayStatus } from "../src/api-types.ts";
import {
  type HeroInputs,
  heroFile,
  heroHint,
  heroView,
  isImage,
  liveName,
  livePlayable,
  presetBackground,
  presetLabel,
  sizeText,
  tileMark,
} from "../src/media.ts";

const OLD_PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
const OLD_SIZE = OLD_PAGE.match(/\nfunction fmtSize\(n\) \{[\s\S]*?\n\}\n/)?.[0] ?? "";
const oldSize = new Function(`${OLD_SIZE}\nreturn fmtSize;`)() as (bytes: number | null | undefined) => string;

describe("sizeText", () => {
  it("agrees with the old page from 0 bytes to 10 GB", () => {
    expect(OLD_SIZE).not.toBe("");
    const sizes = [null, undefined, 0, 1, 499, 500, 999_499, 999_500, 1e6, 9_949_999, 9_950_000, 1e7, 98_123_456, 1e10];
    expect(sizes.map(sizeText)).toEqual(sizes.map(oldSize));
  });

  it("reads as the tiles show it", () => {
    expect([sizeText(734512), sizeText(98123456), sizeText(4_200_000), sizeText(100)]).toEqual([
      "735 kB",
      "98 MB",
      "4.2 MB",
      "1 kB",
    ]);
  });
});

describe("file kinds and labels", () => {
  it("previews PNG and JPEG as images, anything else as video", () => {
    expect(["a.png", "b.JPG", "c.jpeg", "d.mp4", "e.webp"].map(isImage)).toEqual([true, true, true, false, false]);
  });

  it("labels a preset without the common prefix and extension", () => {
    expect(presetLabel("RYUO_IV_HW_Info_01.mp4")).toBe("HW_Info_01");
    expect(presetLabel("Other.MP4")).toBe("Other");
  });

  it("cycles the five placeholder backgrounds", () => {
    expect(presetBackground(5)).toBe(presetBackground(0));
    expect(presetBackground(1)).not.toBe(presetBackground(0));
  });
});

describe("tileMark", () => {
  it("badges a file in ryuod's playlist On panel, and the previewed one Previewing", () => {
    expect(tileMark("a.mp4", ["a.mp4"], null)).toEqual({ on: true, pv: false, badge: "On panel" });
    expect(tileMark("a.mp4", ["a.mp4"], "a.mp4")).toEqual({ on: false, pv: true, badge: "Previewing" });
    expect(tileMark("b.mp4", ["a.mp4"], null)).toEqual({ on: false, pv: false, badge: "" });
  });
});

const OFF: DisplayStatus = {
  on: false,
  state: "off",
  fps: null,
  mbps: null,
  message: null,
  error: null,
  pointer: null,
  backgroundError: null,
  retryInS: null,
};
const inputs = (change: Partial<HeroInputs> = {}): HeroInputs => ({
  unreachable: null,
  preview: null,
  panel: { on: true },
  displayWant: false,
  display: OFF,
  ...change,
});

describe("heroView", () => {
  it("is live with nothing else to show", () => {
    expect(heroView(inputs())).toBe("live");
  });

  it("ranks ryuod down, then a preview, then standby, then the mirror", () => {
    const everything = { preview: "a.mp4", panel: { on: false }, displayWant: true };
    expect(heroView(inputs({ ...everything, unreachable: "Failed to fetch" }))).toBe("down");
    expect(heroView(inputs(everything))).toBe("preview");
    expect(heroView(inputs({ ...everything, preview: null }))).toBe("standby");
    expect(heroView(inputs({ displayWant: true }))).toBe("mirror");
  });

  it("shows the mirror while the virtual monitor is still being removed", () => {
    expect(heroView(inputs({ display: { ...OFF, state: "stopping" } }))).toBe("mirror");
  });

  it("is live for a ryuod without the panel switch", () => {
    expect(heroView(inputs({ panel: null }))).toBe("live");
  });
});

describe("the hero's file and hint", () => {
  const lists = { custom: ["clip.mp4"], preset: ["RYUO_IV_HW_Info_04.mp4"] };

  it("plays the first file of ryuod's playlist when ryuod lists it", () => {
    const live = liveName({ media: ["RYUO_IV_HW_Info_04.mp4", "clip.mp4"] });
    expect(live).toBe("RYUO_IV_HW_Info_04.mp4");
    expect(livePlayable(live, lists)).toBe(true);
    expect(heroFile("live", null, live, true)).toBe(live);
    expect(heroHint("live", live, true)).toBe("");
  });

  it("plays the preview in the preview view, and nothing in the others", () => {
    expect(heroFile("preview", "clip.mp4", "RYUO_IV_HW_Info_04.mp4", true)).toBe("clip.mp4");
    for (const view of ["down", "standby", "mirror"] as const) {
      expect(heroFile(view, null, "RYUO_IV_HW_Info_04.mp4", true)).toBeNull();
      expect(heroHint(view, "RYUO_IV_HW_Info_04.mp4", false)).toBe("");
    }
  });

  it("names a live file ryuod does not list instead of playing it", () => {
    expect(livePlayable("gone.mp4", lists)).toBe(false);
    expect(heroFile("live", null, "gone.mp4", false)).toBeNull();
    expect(heroHint("live", "gone.mp4", false)).toBe("gone.mp4 · built-in preset, no browser preview");
  });

  it("says where the video plays before ryuod has sent a playlist", () => {
    expect(liveName(null)).toBeNull();
    expect(heroHint("live", null, false)).toBe("video plays here");
  });
});
