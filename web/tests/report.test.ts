// @vitest-environment node
/**
 * The outcome sentences (report.ts) against the old page's report() (web/index.html, line 645
 * at eab6057, kept in fixtures/old-page.js). Each reply is given to both; the old one shows its
 * sentence through say(), the new one returns it. The expected text is also written out, so the
 * table says what the user reads without running the old code.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Outcome } from "../src/api-types.ts";
import { report } from "../src/report.ts";

const OLD_PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "old-page.js"), "utf8");
const OLD_SOURCE = OLD_PAGE.match(/\nfunction report\(j, done, extra\) \{[\s\S]*?\n\}\n/)?.[0] ?? "";

/** The old report(), run with a say() that hands back what it was told to show. */
function oldReport(reply: Partial<Outcome>, done: string, extra?: string): [string, string] {
  let shown: [string, string] = ["", ""];
  const say = (text: string, _bad: boolean, detail: string) => {
    shown = [text, detail];
  };
  const build = new Function("say", `${OLD_SOURCE}\nreturn report;`) as (
    sayFunction: typeof say,
  ) => (reply: Partial<Outcome>, done: string, extra?: string) => void;
  build(say)(reply, done, extra);
  return shown;
}

const confirmed = { applied: true, acked: true, sent: ["POST brightness"], restartsVideo: false };

// [what the reply says, the reply, extra, the toast's text, its tooltip]
const CASES: [string, Partial<Outcome>, string | undefined, string, string][] = [
  [
    "held by standby, whatever else it says",
    { ...confirmed, applied: false, heldByStandby: true, heldByDisplay: true, sent: [] },
    undefined,
    "Brightness 80 % saved; applies when the panel turns on",
    "",
  ],
  [
    "held by the second display",
    { ...confirmed, applied: false, heldByDisplay: true, sent: [] },
    undefined,
    "Brightness 80 % saved; applies when the second display is off",
    "",
  ],
  [
    "not applied: the cooler is not connected",
    { ...confirmed, applied: false, acked: false, sent: ["POST brightness"] },
    undefined,
    "Brightness 80 % saved; applies when the cooler reconnects",
    "Sent: POST brightness",
  ],
  [
    "nothing sent, with an extra",
    { ...confirmed, acked: false, sent: [] },
    "the panel shows it from the next sample",
    "Brightness 80 % saved; the panel shows it from the next sample",
    "",
  ],
  ["nothing sent, no extra", { ...confirmed, acked: false, sent: [] }, undefined, "Brightness 80 % saved", ""],
  // A reply with no `sent` at all reads as nothing sent; ryuod always sends it, the old page coped.
  ["no sent key", { applied: true, acked: true }, undefined, "Brightness 80 % saved", ""],
  [
    "sent, not confirmed",
    { ...confirmed, acked: false },
    undefined,
    "Brightness 80 % sent; the cooler did not confirm it",
    "Sent: POST brightness",
  ],
  ["confirmed", confirmed, undefined, "Brightness 80 % — cooler confirmed", "Sent: POST brightness"],
  [
    "confirmed, video restarted, two commands",
    { ...confirmed, sent: ["POST waterBlockScreen", "POST waterBlockScreenId"], restartsVideo: true },
    "ignored once something was sent",
    "Brightness 80 % — cooler confirmed, video restarted",
    "Sent: POST waterBlockScreen, POST waterBlockScreenId",
  ],
];

describe("report", () => {
  it("finds the old report() in fixtures/old-page.js", () => {
    expect(OLD_SOURCE).toContain("cooler confirmed");
  });

  it.each(CASES)("%s", (_name, reply, extra, text, tooltip) => {
    expect(report(reply as Outcome, "Brightness 80 %", extra)).toEqual([text, tooltip]);
    expect(oldReport(reply, "Brightness 80 %", extra)).toEqual([text, tooltip]);
  });
});
