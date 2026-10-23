// Runs before every test file. A request that the fake daemon in tests/harness.js does not
// serve fails the test, so no test can reach the real ryuod on 127.0.0.1:8746.
import { afterEach, expect, vi } from "vitest";

const stray = (globalThis.__strayRequests = []);

function refuse(kind) {
  // A plain function, so `new XMLHttpRequest()` reaches the body and is recorded.
  const blocked = function (...args) {
    stray.push(`${kind} ${String(args[0])}`);
    throw new Error(`test made a real network request: ${kind} ${String(args[0])}`);
  };
  // fetch rejects rather than throws, like a real failed request.
  return kind === "fetch" ? async (...args) => blocked(...args) : blocked;
}

globalThis.fetch = window.fetch = refuse("fetch");
for (const name of ["XMLHttpRequest", "WebSocket", "EventSource"]) {
  globalThis[name] = window[name] = refuse(name);
}
if (navigator.sendBeacon) navigator.sendBeacon = refuse("sendBeacon");

afterEach(() => {
  globalThis.__closePage?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = window.fetch = refuse("fetch");
  const seen = stray.splice(0);
  expect(seen, "requests the fake daemon does not serve").toEqual([]);
});
