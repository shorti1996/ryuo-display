// Loads web/index.html into the happy-dom document and runs its inline <script> against a
// fake ryuod. The fake follows ryuod.py's Handler (do_GET, do_POST, post_*): same routes,
// same validation messages for the cases the tests use, same response shapes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

// A path, not new URL(): happy-dom replaces the global URL, and readFileSync wants Node's.
const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const HEAD = HTML.match(/<head>([\s\S]*?)<\/head>/)[1];
const BODY = HTML.match(/<body>([\s\S]*?)<\/body>/)[1].replace(/<script>[\s\S]*?<\/script>/, "");

// Captured before any test fakes the timers: one real macrotask drains every pending
// microtask, which is how long a chain of awaited fake fetches takes to finish.
const realSetImmediate = globalThis.setImmediate;
export const settle = async () => {
  await new Promise((r) => realSetImmediate(r));
  await new Promise((r) => realSetImmediate(r));
};

// happy-dom 20 has no `Option` constructor; the page uses `new Option(text, value)`.
if (typeof globalThis.Option !== "function") {
  globalThis.Option = function Option(text = "", value) {
    const o = document.createElement("option");
    o.textContent = text;
    if (value !== undefined) o.value = value;
    return o;
  };
}

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// [item, title, unit, group, clipsIn, available]; clipsIn computed with ryuod.clips_in.
const CATALOG = [
  ["CPU Load", "CPU", "%", "CPU", [], true],
  ["CPU Usage", "CPU", "%", "CPU", [], true],
  ["CPU Temperature", "CPU", "°C", "CPU", [], true],
  ["CPU Speed Average", "CPU", "MHZ", "CPU", [], true],
  ["CPU Voltage", "CPU", "V", "CPU", [], false],
  ["GPU Load", "GPU", "%", "GPU", [], true],
  ["GPU Usage", "GPU", "%", "GPU", [], true],
  ["GPU Temperature", "GPU", "°C", "GPU", [], true],
  ["GPU Speed", "GPU", "MHZ", "GPU", [], true],
  ["GPU Power", "GPU", "°C", "GPU", [], true],
  ["GPU Voltage", "GPU", "V", "GPU", [], false],
  ["Memory Utilization", "Memory Utilization", "%", "Memory", [4], true],
  ["Memory Frequency", "Memory Frequency", "MHZ", "Memory", [4], true],
  ["Hard Disk Temperature", "Hard Disk Temperature", "°C", "Storage", [3, 4, 5], true],
  ["Motherboard Temperature", "Motherboard", "°C", "Board", [], true],
  ["Date&Time", "", "ss", "Clock", [], true],
  ["Fan Speed Disk R MB/s", "Disk R MB/s", "RPM", "Custom", [], true],
  ["Fan Speed Disk W MB/s", "Disk W MB/s", "RPM", "Custom", [], true],
  ["Fan Speed Net Down KB/s", "Net Down KB/s", "RPM", "Custom", [], true],
  ["Fan Speed Net Up KB/s", "Net Up KB/s", "RPM", "Custom", [], true],
  ["Fan Speed GPU W", "GPU W", "RPM", "Custom", [], true],
  // An hwmon fan whose label is too wide for the right column.
  ["Fan Speed Pump Header", "Pump Header", "RPM", "Custom", [3, 4, 5], true],
];
const NOTES = {
  "GPU Usage": "same value as GPU Load (firmware reads gpu.load)",
  "GPU Power": "firmware draws a °C unit; Fan Speed GPU W shows RPM instead",
};
const TEMP_ITEMS = new Set(["CPU Temperature", "GPU Temperature", "Hard Disk Temperature", "Motherboard Temperature"]);
const COLOR_RE = /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;

export const PRESET = ["RYUO_IV_HW_Info_01.mp4", "RYUO_IV_HW_Info_04.mp4"];
export const CUSTOM = ["2026-01-26_22-07-49-639.mp4", "2026-01-26_20-04-35-774.png"];

export function defaultConfig() {
  return {
    media: ["RYUO_IV_HW_Info_04.mp4"], playMode: "Single", ratio: "2:1",
    items: ["CPU Temperature", "GPU Temperature", "Fan Speed Disk R MB/s", "Date&Time", "", ""],
    statsVisible: true, titleColor: "#E5252B", contentColor: "#FFFFFF", filter: { on: false, opacity: 100 },
    brightness: 100, tempUnit: "Celsius", memoryMHz: 0, sensors: { motherboard: "auto" },
  };
}

export function defaultDevice() {
  return {
    connected: true, hidraw: "/dev/hidraw4", vid: "0b05", pid: "1c76", firmware: "V1.0.10",
    product: "Ryuo IV Standard", lastHeartbeatMs: 420, lastHomeuiAckMs: 430, recoveries: 0,
    lastError: null, heartbeat: "post",
  };
}

class Invalid extends Error {}

/**
 * A fake ryuod. Tests change `config`, `device`, `stats`, `mediaLists` directly, queue one-off
 * replies with `replyOnce`, and read what the page sent from `calls`.
 */
export function makeDaemon({ config = {}, device = {}, stats = {}, media } = {}) {
  const d = {
    config: { ...defaultConfig(), ...clone(config) },
    device: { ...defaultDevice(), ...clone(device) },
    // Sampled values by item: {value, panel}; unit and available come from the catalog.
    stats: {
      "CPU Temperature": { value: 50.4, panel: "50" },
      "GPU Temperature": { value: 37, panel: "37" },
      "Fan Speed Disk R MB/s": { value: 12, panel: "12" },
      ...clone(stats),
    },
    sampledAt: Date.UTC(2026, 9, 22, 12, 5, 8),
    mediaLists: {
      source: "conn", fetchedAt: 1792771200000, preset: [...PRESET], custom: [...CUSTOM],
      sizes: { [CUSTOM[0]]: 98123456, [CUSTOM[1]]: 734512 }, ...clone(media),
    },
    down: false,
    closed: false,
    calls: [],
    queued: {},

    /** The next request to `route` ("GET /api/state") gets this reply instead: {status, body} or {status, text}. */
    replyOnce(route, reply) { (this.queued[route] ||= []).push(reply); },
    posts(path) { return this.calls.filter((c) => c.method === "POST" && c.path === path).map((c) => c.body); },
    gets(path) { return this.calls.filter((c) => c.method === "GET" && c.path === path); },

    catalog() {
      const deg = this.config.tempUnit === "Fahrenheit" ? "°F" : "°C";
      return CATALOG.map(([item, title, unit, group, clipsIn, available]) => ({
        item, title, unit: unit === "°C" ? deg : unit, group, available,
        source: available ? "fake" : null, note: NOTES[item] ?? null, clipsIn: [...clipsIn],
      }));
    },
  };

  const reply = (status, body) => ({ status, body });
  const err = (status, msg) => reply(status, { ok: false, error: msg });
  const applied = () => ({ applied: d.device.connected, acked: d.device.connected });

  const routes = {
    "GET /api/state": () => reply(200, {
      ok: true, device: clone(d.device), config: clone(d.config),
      limits: { slots: 6, brightnessMax: 102, frameMax: 1024, lastHeartbeatBytes: 548 },
      media: { preset: [...d.mediaLists.preset], custom: [...d.mediaLists.custom] },
    }),
    "GET /api/stats": () => {
      const values = {};
      for (const c of d.catalog()) {
        const s = d.stats[c.item] || { value: 0, panel: "0" };
        values[c.item] = { value: s.value, unit: c.unit, available: c.available, panel: s.panel };
      }
      return reply(200, { ok: true, sampledAt: d.sampledAt, values, lastPcInfo: { timestamp: d.sampledAt } });
    },
    "GET /api/catalog": () => reply(200, { ok: true, items: d.catalog() }),
    "GET /api/media": () => reply(200, { ok: true, ...clone(d.mediaLists) }),
    "POST /api/overlay": (body) => {
      const ch = {};
      if ("items" in body) {
        const items = body.items;
        if (!Array.isArray(items) || items.length > 6 || !items.every((i) => typeof i === "string")) {
          throw new Invalid("items must be a list of at most 6 strings");
        }
        const padded = [...items, "", "", "", "", "", ""].slice(0, 6);
        const used = padded.filter(Boolean);
        if (new Set(used).size !== used.length) throw new Invalid("the same item in two slots only feeds the last one");
        ch.items = padded;
      }
      for (const k of ["titleColor", "contentColor"]) {
        if (k in body) {
          if (typeof body[k] !== "string" || !COLOR_RE.test(body[k])) throw new Invalid(`${k} must be #RRGGBB or #AARRGGBB`);
          ch[k] = body[k];
        }
      }
      if ("filter" in body) ch.filter = { ...d.config.filter, ...body.filter };
      if ("statsVisible" in body) {
        if (typeof body.statsVisible !== "boolean") throw new Invalid("statsVisible must be true or false");
        ch.statsVisible = body.statsVisible;
      }
      Object.assign(d.config, ch);
      return reply(200, { ok: true, ...applied(), sent: ["POST preset"], restartsVideo: false, config: clone(d.config) });
    },
    "POST /api/brightness": (body) => {
      const v = body.value;
      if (!Number.isInteger(v) || v < 0 || v > 102) throw new Invalid("value must be an integer 0-102");
      d.config.brightness = v;
      return reply(200, { ok: true, ...applied(), sent: ["POST brightness"], restartsVideo: false, deviceLevel: Math.min(255, Math.floor(v * 2.5)) });
    },
    "POST /api/media/select": (body) => {
      const { media } = body, mode = body.playMode ?? d.config.playMode;
      if (!Array.isArray(media) || media.length < 1 || media.length > 20) throw new Invalid("media must be a list of 1-20 file names");
      const known = new Set([...d.mediaLists.preset, ...d.mediaLists.custom]);
      const missing = media.filter((m) => !known.has(m));
      if (missing.length) throw new Invalid(`not in the device media list: ${missing.join(", ")} (GET /api/media?refresh=1)`);
      if (!["Single", "Cycle", "Random"].includes(mode)) throw new Invalid("playMode must be Single, Cycle or Random");
      Object.assign(d.config, { media: [...media], playMode: mode });
      return reply(200, { ok: true, ...applied(), sent: ["POST waterBlockScreenId"], restartsVideo: true, config: clone(d.config) });
    },
    "POST /api/media/delete": (body) => {
      const { names } = body;
      if (!Array.isArray(names) || names.length < 1 || names.length > 100 || !names.every((n) => typeof n === "string")) {
        throw new Invalid("names must be a list of 1-100 file names");
      }
      for (const n of names) {
        if (!n || n === "." || n === ".." || /[/\\\0]/.test(n)) throw new Invalid(`'${n}' is not a bare file name`);
        if (d.mediaLists.preset.includes(n)) throw new Invalid(`${n} is a preset; only files in /sdcard/pcMedia can be deleted`);
        if (!d.mediaLists.custom.includes(n)) throw new Invalid(`not in /sdcard/pcMedia: ${n} (GET /api/media?refresh=1)`);
      }
      const gone = new Set(names);
      d.mediaLists.custom = d.mediaLists.custom.filter((n) => !gone.has(n));
      d.mediaLists.sizes = Object.fromEntries(Object.entries(d.mediaLists.sizes || {}).filter(([n]) => !gone.has(n)));
      const sent = ["POST mediaDelete"];
      const playlist = d.config.media.filter((m) => !gone.has(m));
      const restartsVideo = playlist.length !== d.config.media.length;
      if (restartsVideo) {
        d.config.media = playlist.length ? playlist : [[...d.mediaLists.preset].sort()[0]];
        sent.push("POST waterBlockScreenId");
      }
      return reply(200, {
        ok: true, deleted: [...names], remaining: [], listedBy: "conn", sent, ...applied(), restartsVideo,
        config: clone(d.config), media: clone(d.mediaLists),
      });
    },
    // The page only fetches this after its <video> or <img> reports an error.
    "GET /api/media/preview": () => reply(206, null),
    "POST /api/prefs": (body) => {
      const ch = {};
      if ("tempUnit" in body) {
        if (!["Celsius", "Fahrenheit"].includes(body.tempUnit)) throw new Invalid("tempUnit must be Celsius or Fahrenheit");
        ch.tempUnit = body.tempUnit;
      }
      if ("memoryMHz" in body) {
        const v = body.memoryMHz;
        if (!Number.isInteger(v) || v < 0 || v > 20000) throw new Invalid("memoryMHz must be an integer 0-20000");
        ch.memoryMHz = v;
      }
      const unitChanged = "tempUnit" in ch && ch.tempUnit !== d.config.tempUnit;
      Object.assign(d.config, ch);
      const res = unitChanged ? applied() : { applied: true, acked: false };
      return reply(200, { ok: true, ...res, sent: unitChanged ? ["POST temperature"] : [], restartsVideo: false, config: clone(d.config) });
    },
  };

  d.fetch = vi.fn(async (url, opt = {}) => {
    if (d.closed) return new Promise(() => {}); // a page from a finished test: never answer
    const method = opt.method || "GET";
    const [path, query = ""] = String(url).split("?");
    const route = `${method} ${path}`;
    if (!String(url).startsWith("/api/") || !(route in routes)) {
      globalThis.__strayRequests.push(`fetch ${method} ${url}`);
      throw new Error(`fake daemon has no route for ${method} ${url}`);
    }
    let body;
    if (method === "POST") {
      const ctype = (opt.headers || {})["Content-Type"];
      body = JSON.parse(opt.body);
      d.calls.push({ method, path, query, body });
      if (ctype !== "application/json") return respond(err(415, "Content-Type must be application/json"));
    } else {
      d.calls.push({ method, path, query });
    }
    if (d.down) throw new TypeError("Failed to fetch");
    const queued = d.queued[route]?.shift();
    if (queued) return respond(queued);
    try {
      return respond(routes[route](body, query));
    } catch (e) {
      if (e instanceof Invalid) return respond(err(400, e.message));
      throw e;
    }
  });
  return d;
}

function respond({ status, body, text }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (text !== undefined ? JSON.parse(text) : clone(body)),
  };
}

// 2026-10-22 was a Thursday.
export const NOW = new Date(2026, 9, 22, 14, 5, 9);

/**
 * Fresh document from index.html, fake timers at NOW, fetch served by `daemon`, then the
 * page script, then wait for the startup sequence (catalog, state, media, stats).
 */
export async function openPage(daemon = makeDaemon()) {
  vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  globalThis.fetch = window.fetch = daemon.fetch;
  document.head.innerHTML = HEAD;
  document.body.innerHTML = BODY;
  globalThis.__closePage = () => { daemon.closed = true; };
  new Function(SCRIPT)();
  await settle();
  return daemon;
}

/** Advance the fake clock by `ms`, running timers and the fetches they start. */
export async function tick(ms) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

export const $ = (id) => document.getElementById(id);
export const slot = (i) => $("slot" + i);
export const slotSelects = () => [...document.querySelectorAll("#slots select")];

/** What the user does: set the value and fire the event the page listens for. */
export function choose(sel, value) {
  sel.value = value;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
}
export function setInput(el, value) {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function option(sel, value) {
  return [...sel.options].find((o) => o.value === value);
}

export function preview(n) {
  const d = $("ps" + n);
  return {
    el: d,
    hidden: d.classList.contains("hidden"),
    title: d.children[0].textContent,
    value: d.children[1].textContent,
    unit: d.children[2].textContent,
  };
}
