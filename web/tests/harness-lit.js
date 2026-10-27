// Loads the Lit page (src/index.html and src/main.ts) into the happy-dom document, against the
// same fake ryuod as tests/harness.js. Everything but openPage comes from there unchanged, so a
// test file moves to the new page by changing its import line only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

import { makeDaemon, NOW, settle } from "./harness.js";

export {
  $,
  brightnessPercent,
  brightnessValue,
  CUSTOM,
  choose,
  defaultConfig,
  defaultDesktop,
  defaultDevice,
  defaultDisplay,
  defaultTray,
  makeDaemon,
  NOW,
  option,
  PRESET,
  preview,
  setInput,
  settle,
  slot,
  slotSelects,
  tick,
} from "./harness.js";

// A path, not new URL(): happy-dom replaces the global URL, and readFileSync wants Node's.
const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.html"), "utf8");
const BODY = HTML.match(/<body>([\s\S]*?)<\/body>/)[1];

/**
 * Fresh document from src/index.html, fake timers at NOW, fetch served by `daemon`, then a fresh
 * import of main.ts (a new store and poll), then wait for the startup sequence (catalog, state,
 * media, stats) and the first render.
 */
export async function openPage(daemon = makeDaemon()) {
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  globalThis.fetch = window.fetch = daemon.fetch;
  document.head.innerHTML = "";
  document.body.innerHTML = BODY;
  globalThis.__closePage = () => {
    daemon.closed = true;
  };
  vi.resetModules();
  await import("../src/main.ts");
  await settle();
  return daemon;
}
