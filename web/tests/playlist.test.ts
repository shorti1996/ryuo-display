// @vitest-environment node
/**
 * The playlist's pure parts (playlist.ts): the order the panel plays the ticked files in, what a
 * tick does to the draft, and the messages for a playlist change and a delete.
 */
import { describe, expect, it } from "vitest";

import type { Config, MediaDeleteReply } from "../src/api-types.ts";
import { DISPLAY_BLACK, deleteText, playlistOrder, playlistText, tickFile } from "../src/playlist.ts";

const LISTS = { custom: ["clip.mp4", "photo.png"], preset: ["RYUO_IV_HW_Info_01.mp4", "RYUO_IV_HW_Info_04.mp4"] };

describe("playlistOrder", () => {
  it("plays the ticked files in list order, Custom first, whatever the click order", () => {
    expect(playlistOrder(LISTS, ["RYUO_IV_HW_Info_04.mp4", "photo.png", "RYUO_IV_HW_Info_01.mp4"])).toEqual([
      "photo.png",
      "RYUO_IV_HW_Info_01.mp4",
      "RYUO_IV_HW_Info_04.mp4",
    ]);
  });

  it("leaves out a ticked file the lists no longer hold", () => {
    expect(playlistOrder(LISTS, ["gone.mp4", "clip.mp4"])).toEqual(["clip.mp4"]);
  });

  it("is empty with nothing ticked", () => {
    expect(playlistOrder(LISTS, [])).toEqual([]);
  });
});

describe("tickFile", () => {
  it("adds a ticked file and removes an unticked one", () => {
    expect(tickFile(["clip.mp4"], "photo.png", true)).toEqual(["clip.mp4", "photo.png"]);
    expect(tickFile(["clip.mp4", "photo.png"], "clip.mp4", false)).toEqual(["photo.png"]);
  });

  it("does not add a file twice", () => {
    expect(tickFile(["clip.mp4"], "clip.mp4", true)).toEqual(["clip.mp4"]);
  });

  it("drops the second display's black image, which has no box, on any tick", () => {
    expect(tickFile([DISPLAY_BLACK], "clip.mp4", true)).toEqual(["clip.mp4"]);
    expect(tickFile([DISPLAY_BLACK, "clip.mp4"], "clip.mp4", false)).toEqual([]);
  });
});

describe("playlistText", () => {
  it("names a single file", () => {
    expect(playlistText(["clip.mp4"], "Cycle")).toBe("Background clip.mp4");
  });

  it.each([
    ["Single", "Playlist of 2 files (Single, loop)"],
    ["Cycle", "Playlist of 2 files (Playlist in order)"],
    ["Random", "Playlist of 2 files (Playlist shuffled)"],
  ] as const)("counts several files and names play mode %s as its select does", (mode, text) => {
    expect(playlistText(["clip.mp4", "photo.png"], mode)).toBe(text);
  });
});

describe("deleteText", () => {
  const reply = (change: Partial<MediaDeleteReply> = {}): MediaDeleteReply => ({
    ok: true,
    applied: true,
    acked: true,
    sent: ["POST mediaDelete"],
    restartsVideo: false,
    deleted: ["clip.mp4"],
    remaining: [],
    listedBy: "conn",
    heldByDisplay: false,
    heldByStandby: false,
    config: { media: ["RYUO_IV_HW_Info_01.mp4"] } as Config,
    media: { source: "conn", fetchedAt: 1, preset: [], custom: [] },
    ...change,
  });

  it("names the deleted file, with the commands as the tooltip", () => {
    expect(deleteText(reply())).toEqual({
      text: "Deleted clip.mp4 from the cooler",
      bad: false,
      detail: "Sent: POST mediaDelete",
    });
  });

  it("names the playlist ryuod fell back to when the deleted file was playing", () => {
    expect(deleteText(reply({ restartsVideo: true })).text).toBe(
      "Deleted clip.mp4 from the cooler; the panel plays RYUO_IV_HW_Info_01.mp4 instead",
    );
  });

  it.each([
    [{ heldByStandby: true }, ", from when the panel turns on"],
    [{ heldByDisplay: true }, ", from when the second display is off"],
    [{ restartsVideo: true, applied: false }, ", from when the cooler reconnects"],
  ])("says when the fallback applies: %j", (change, when) => {
    expect(deleteText(reply(change)).text).toBe(
      `Deleted clip.mp4 from the cooler; the panel plays RYUO_IV_HW_Info_01.mp4 instead${when}`,
    );
  });

  it("is an error when the cooler still lists the file", () => {
    expect(deleteText(reply({ deleted: [], remaining: ["clip.mp4"] }))).toEqual({
      text: "clip.mp4 is still on the cooler; the delete did not take",
      bad: true,
      detail: "",
    });
  });
});
