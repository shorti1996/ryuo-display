/** The outcome sentences for the result toast. */
import type { Outcome } from "./api-types.ts";

/**
 * A change's outcome in the user's words, as [text, tooltip]. `done` names the change with its
 * value ("Brightness 80 %"); the reply says whether the cooler has it, or why it waits. `extra`
 * follows a change that is only saved and needs no command ("the panel shows it from the next
 * sample"). The tooltip lists the device commands sent.
 */
export function report(reply: Outcome, done: string, extra = ""): [string, string] {
  const sent = reply.sent || [];
  const text = reply.heldByStandby
    ? `${done} saved; applies when the panel turns on`
    : reply.heldByDisplay
      ? `${done} saved; applies when the second display is off`
      : reply.applied === false
        ? `${done} saved; applies when the cooler reconnects`
        : !sent.length
          ? `${done} saved${extra ? `; ${extra}` : ""}`
          : !reply.acked
            ? `${done} sent; the cooler did not confirm it`
            : `${done} — cooler confirmed${reply.restartsVideo ? ", video restarted" : ""}`;
  return [text, sent.length ? `Sent: ${sent.join(", ")}` : ""];
}
