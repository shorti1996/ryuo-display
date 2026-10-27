// @vitest-environment node
/**
 * Upload progress (upload.ts): the status line against the old page's renderUpload()
 * (web/index.html, line 1209 at eab6057, kept in fixtures/old-page.js) over every state, and how
 * the POST's events and the state polls move the progress.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { UploadStatus } from "../src/api-types.ts";
import {
  fromPoll,
  NO_UPLOAD,
  percent,
  sendEnded,
  sending,
  type UploadShown,
  uploadActive,
  uploadText,
} from "../src/upload.ts";

const OLD_PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "old-page.js"), "utf8");
const OLD_SOURCE =
  OLD_PAGE.match(/\nconst UP_ACTIVE = [\s\S]*?\nfunction renderUpload\(u\) \{[\s\S]*?\n\}\n/)?.[0] ?? "";

/** The old renderUpload(), run against stand-ins for the elements it writes: [status line, active]. */
function oldRender(shown: UploadShown | null): [string, boolean] {
  const elements = new Map<string, Record<string, unknown>>();
  const byId = (id: string) => {
    if (!elements.has(id)) {
      elements.set(id, { textContent: "", hidden: false, classList: { toggle() {} }, removeAttribute() {} });
    }
    return elements.get(id);
  };
  const run = new Function("$", `${OLD_SOURCE}\nrenderUpload(arguments[1]);\nreturn upActive;`) as (
    lookup: typeof byId,
    shown: UploadShown | null,
  ) => boolean;
  const active = run(byId, shown);
  return [String(byId("upStatus")?.textContent), active];
}

const upload = (change: Partial<UploadStatus> = {}): UploadStatus => ({
  state: "receiving",
  file: "clip.mp4",
  bytes: 1000,
  received: 1000,
  progress: null,
  speed: null,
  action: null,
  reason: null,
  encoder: null,
  name: null,
  error: null,
  applied: null,
  acked: null,
  heldByDisplay: null,
  heldByStandby: null,
  startedAt: 5,
  finishedAt: null,
  ...change,
});

const STATES: UploadStatus["state"][] = [
  "receiving",
  "probing",
  "converting",
  "pushing",
  "starting",
  "done",
  "error",
  "cancelled",
];
const ACTIONS: UploadStatus["action"][] = [null, "copy", "remux", "transcode", "image"];

describe("the status line, as the old page wrote it", () => {
  it("agrees for every state, action, progress, reason and hold", () => {
    expect(OLD_SOURCE).not.toBe("");
    const mismatches: string[] = [];
    for (const state of STATES)
      for (const action of ACTIONS)
        for (const progress of [null, 0, 0.374, 1])
          for (const reason of [null, "the panel cannot decode H.264 High 10"])
            for (const held of [{}, { heldByStandby: true }, { heldByDisplay: true }, { applied: false }]) {
              const shown = upload({
                state,
                action,
                progress,
                reason,
                encoder: "hevc_nvenc",
                speed: progress ? "2.1x" : null,
                name: "2026-10-27_12-00-00-000_clip.mp4",
                error: "ffmpeg exited with 1",
                ...held,
              });
              const [text, active] = oldRender(shown);
              if (text !== uploadText(shown) || active !== uploadActive(shown)) {
                mismatches.push(`${JSON.stringify(shown)}: old ${JSON.stringify([text, active])}`);
              }
            }
    expect(mismatches).toEqual([]);
  });

  it("agrees for the page's own states, which carry only some fields", () => {
    for (const shown of [
      null,
      { state: "receiving", file: "my clip.mp4", progress: 0 },
      { state: "cancelled" },
      { state: "error", error: "the connection to ryuod dropped" },
    ] as (UploadShown | null)[]) {
      expect(uploadText(shown)).toBe(oldRender(shown)[0]);
    }
  });

  it("reads as the user sees it", () => {
    expect(uploadText({ state: "receiving", file: "my clip.mp4", progress: 0.374 })).toBe(
      "Uploading my clip.mp4: 37 %",
    );
    expect(
      uploadText(
        upload({ state: "converting", action: "transcode", encoder: "hevc_nvenc", progress: 0.5, speed: "2.1x" }),
      ),
    ).toBe("Converting to 2240×1080 HEVC with hevc_nvenc: 50 % at 2.1x");
    expect(uploadText(upload({ state: "done", action: "copy", name: "clip.mp4", applied: false }))).toBe(
      "Playing clip.mp4 once the cooler reconnects, sent as it was",
    );
  });
});

describe("percent", () => {
  it("rounds to a whole percentage", () => {
    expect([0, 0.004, 0.005, 0.5, 1].map(percent)).toEqual(["0 %", "0 %", "1 %", "50 %", "100 %"]);
  });
});

describe("the page's POST", () => {
  it("shows its progress and blocks the poll while it sends", () => {
    const progress = sending(NO_UPLOAD, "clip.mp4", 0.25);
    expect(progress).toEqual({
      shown: { state: "receiving", file: "clip.mp4", progress: 0.25 },
      sending: true,
      watch: null,
    });
    expect(uploadActive(progress.shown)).toBe(true);
    expect(fromPoll(progress, upload({ state: "done" }))).toEqual({ progress, finished: null });
  });

  it("watches ryuod's job once ryuod has the file", () => {
    const accepted = upload({ state: "probing", startedAt: 9 });
    const ended = sendEnded(sending(NO_UPLOAD, "clip.mp4", 1), 202, { ok: true, upload: accepted }, false);
    expect(ended).toEqual({ shown: accepted, sending: false, watch: 9 });
  });

  it("says cancelled after Cancel, and gives ryuod's reason or the status otherwise", () => {
    const started = sending(NO_UPLOAD, "clip.mp4", 0.5);
    expect(sendEnded(started, 0, null, true).shown).toEqual({ state: "cancelled" });
    expect(sendEnded(started, 413, { ok: false, error: "the file is larger than 2 GB" }, false).shown).toEqual({
      state: "error",
      error: "the file is larger than 2 GB",
    });
    expect(sendEnded(started, 502, null, false).shown).toEqual({ state: "error", error: "HTTP 502" });
    expect(sendEnded(started, 0, null, false).shown).toEqual({
      state: "error",
      error: "the connection to ryuod dropped",
    });
    expect(sendEnded(started, 0, null, false).sending).toBe(false);
  });
});

describe("the state poll", () => {
  it("keeps the last status when ryuod has none", () => {
    const progress = { shown: { state: "cancelled" }, sending: false, watch: null } as const;
    expect(fromPoll(progress, null)).toEqual({ progress, finished: null });
  });

  it("finishes a watched upload once, on the first poll that finds it done", () => {
    const watched = fromPoll(NO_UPLOAD, upload({ state: "converting", startedAt: 7 })).progress;
    expect(watched.watch).toBe(7);
    const done = upload({ state: "done", startedAt: 7, name: "2026-10-27_clip.mp4" });
    const first = fromPoll(watched, done);
    expect(first).toEqual({ progress: { shown: done, sending: false, watch: null }, finished: "2026-10-27_clip.mp4" });
    expect(fromPoll(first.progress, done).finished).toBeNull();
  });

  it("shows an upload finished before the page loaded without acting on it", () => {
    // docs/007-ui-redesign/GAPS.md: the old page showed this line after every load, too.
    const done = upload({ state: "done", action: "copy", name: "clip.mp4", applied: true });
    const { progress, finished } = fromPoll(NO_UPLOAD, done);
    expect(finished).toBeNull();
    expect(uploadText(progress.shown)).toBe("Playing clip.mp4, sent as it was");
  });

  it("does not finish another job than the one it watches", () => {
    const watched = fromPoll(NO_UPLOAD, upload({ state: "pushing", startedAt: 7 })).progress;
    expect(fromPoll(watched, upload({ state: "done", startedAt: 8, name: "other.mp4" })).finished).toBeNull();
  });
});
