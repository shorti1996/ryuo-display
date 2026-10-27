/**
 * The network guard in tests/setup.js and the fake daemon's routing: a request the fake does
 * not serve throws and is recorded, and the shared afterEach fails the test that made it.
 */
import { expect, it } from "vitest";

import { makeDaemon, openPage } from "./harness-lit.js";

function takeStray() {
  return globalThis.__strayRequests.splice(0);
}

it("refuses a real request before any page is open", async () => {
  await expect(fetch("http://127.0.0.1:8746/api/state")).rejects.toThrow("real network request");
  expect(() => new XMLHttpRequest()).toThrow("real network request");
  expect(takeStray()).toEqual(["fetch http://127.0.0.1:8746/api/state", "XMLHttpRequest undefined"]);
});

it("refuses an absolute URL or an unknown route while a page is open", async () => {
  await openPage();
  await expect(fetch("http://127.0.0.1:8746/api/state")).rejects.toThrow("no route");
  await expect(fetch("/api/reboot", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
    .rejects.toThrow("no route");
  expect(takeStray()).toEqual(["fetch GET http://127.0.0.1:8746/api/state", "fetch POST /api/reboot"]);
});

it("answers 415 to a POST without the JSON content type, as ryuod does", async () => {
  const d = await openPage(makeDaemon());
  const r = await fetch("/api/brightness", { method: "POST", body: JSON.stringify({ value: 5 }) });
  expect(r.status).toBe(415);
  expect(d.config.brightness).toBe(100);
});
