// Loads the control page (src/index.html and src/main.ts) into the happy-dom document against a
// fake ryuod, and the helpers the tests drive the page with. The fake follows ryuod.py's Handler
// (do_GET, do_POST, post_*): same routes, same validation messages for the cases the tests use,
// same response shapes.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

// Captured before any test fakes the timers: one real macrotask drains every pending
// microtask, which is how long a chain of awaited fake fetches takes to finish.
const realSetImmediate = globalThis.setImmediate;
export const settle = async () => {
  await new Promise((r) => realSetImmediate(r));
  await new Promise((r) => realSetImmediate(r));
};

// happy-dom 20 has no `Option` constructor. The old page built its slot lists with
// `new Option(text, value)`; the Lit page does not, but the polyfill stays for code that does.
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
    brightness: 100, tempUnit: "Celsius", memoryMHz: 0, sensors: { motherboard: "auto" }, secondDisplay: false,
  };
}

/** ryuod.Display.status() with the switch off. */
export function defaultDisplay() {
  return {
    on: false, state: "off", fps: null, mbps: null, message: null, error: null, pointer: null, backgroundError: null,
    retryInS: null,
  };
}

export function defaultDevice() {
  return {
    connected: true, hidraw: "/dev/hidraw4", vid: "0b05", pid: "1c76", firmware: "V1.0.10",
    product: "Ryuo IV Standard", lastHeartbeatMs: 420, lastHomeuiAckMs: 430, recoveries: 0,
    lastError: null, heartbeat: "post",
  };
}

/** ryuod's tray settings in GET /api/state, before brightnessStepValues and leftClickOptions are added. */
export function defaultTray() {
  return { autostart: true, leftClick: "page", brightnessSteps: [25, 50, 75, 100] };
}

/** ryuod.desktop_status(). */
export function defaultDesktop() {
  return { portalTokenSaved: true, displaySettings: "kcmshell6" };
}

// Python's round(): halves go to the even neighbour, as in ryuod's brightness mappings.
function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}
/** ryuod.brightness_percent and ryuod.brightness_value. */
export const brightnessPercent = (v) => pyRound(Math.min(255, Math.floor(v * 2.5)) * 100 / 255);
export const brightnessValue = (p) => Math.min(102, pyRound(p * 255 / 250));
const TRAY_CLICKS = ["page", "menu", "panel", "stats"];

class Invalid extends Error {}
// A refusal with a status other than 400.
class Refused extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/**
 * A fake ryuod. Tests change `config`, `device`, `stats`, `mediaLists` directly, queue one-off
 * replies with `replyOnce`, and read what the page sent from `calls`.
 */
export function makeDaemon({
  config = {}, device = {}, stats = {}, media, display = {}, upload = null, panel = {}, tray = {}, desktop = {},
} = {}) {
  const d = {
    panel: { on: true, ...clone(panel) },
    tray: { ...defaultTray(), ...clone(tray) },
    desktop: { ...defaultDesktop(), ...clone(desktop) },
    config: { ...defaultConfig(), ...clone(config) },
    device: { ...defaultDevice(), ...clone(device) },
    // The second-display status in GET /api/state; null stands for a ryuod without the feature.
    display: display === null ? null : { ...defaultDisplay(), ...clone(display) },
    // ryuod.Upload.snapshot() in GET /api/state, or null before the first upload.
    upload: clone(upload),
    // ryuod.Backdrop.on: HomeUI is held on the black image, so a new selection is saved, not sent.
    held: false,
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
  // public_config(): what every reply that carries the config sends.
  const pub = () => ({ ...clone(d.config), brightnessPercent: brightnessPercent(d.config.brightness) });
  const trayStatus = () => ({
    ...clone(d.tray), brightnessStepValues: d.tray.brightnessSteps.map(brightnessValue), leftClickOptions: [...TRAY_CLICKS],
  });
  // Device.held(): while the panel is in standby, brightness, preset and config are saved, not sent.
  const standby = () => !d.panel.on;
  const heldReply = { applied: false, acked: false, heldByStandby: true };
  const err = (status, msg) => reply(status, { ok: false, error: msg });
  const applied = () => ({ applied: d.device.connected, acked: d.device.connected });

  const routes = {
    "GET /api/state": () => reply(200, {
      ok: true, device: clone(d.device), config: pub(),
      limits: { slots: 6, brightnessMax: 102, frameMax: 1024, lastHeartbeatBytes: 548 },
      media: { preset: [...d.mediaLists.preset], custom: [...d.mediaLists.custom] },
      display: clone(d.display), upload: clone(d.upload),
      panel: clone(d.panel), tray: trayStatus(), desktop: clone(d.desktop),
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
      if (standby()) return reply(200, { ok: true, ...heldReply, sent: [], restartsVideo: false, config: pub() });
      return reply(200, { ok: true, ...applied(), sent: ["POST preset"], restartsVideo: false, config: pub() });
    },
    "POST /api/brightness": (body) => {
      let v = body.value;
      if ("percent" in body) {
        const p = body.percent;
        if (!Number.isInteger(p) || p < 0 || p > 100) throw new Invalid("percent must be an integer 0-100");
        v = brightnessValue(p);
      } else if (!Number.isInteger(v) || v < 0 || v > 102) throw new Invalid("value must be an integer 0-102");
      d.config.brightness = v;
      const level = Math.min(255, Math.floor(v * 2.5));
      const res = standby() ? { ...heldReply, sent: [] } : { ...applied(), sent: ["POST brightness"] };
      return reply(200, { ok: true, ...res, restartsVideo: false, deviceLevel: level, value: v, percent: brightnessPercent(v) });
    },
    "POST /api/media/select": (body) => {
      const { media } = body, mode = body.playMode ?? d.config.playMode;
      if (!Array.isArray(media) || media.length < 1 || media.length > 20) throw new Invalid("media must be a list of 1-20 file names");
      const known = new Set([...d.mediaLists.preset, ...d.mediaLists.custom]);
      const missing = media.filter((m) => !known.has(m));
      if (missing.length) throw new Invalid(`not in the device media list: ${missing.join(", ")} (GET /api/media?refresh=1)`);
      if (!["Single", "Cycle", "Random"].includes(mode)) throw new Invalid("playMode must be Single, Cycle or Random");
      Object.assign(d.config, { media: [...media], playMode: mode });
      if (!d.held && standby()) {
        return reply(200, { ok: true, ...heldReply, heldByDisplay: false, sent: [], restartsVideo: false, config: pub() });
      }
      if (d.held) {
        return reply(200, { ok: true, applied: false, acked: false, heldByDisplay: true, sent: [], restartsVideo: false, config: pub() });
      }
      return reply(200, {
        ok: true, ...applied(), heldByDisplay: false, sent: ["POST waterBlockScreenId"], restartsVideo: true, config: pub(),
      });
    },
    "POST /api/media/delete": (body) => {
      const { names } = body;
      if (!Array.isArray(names) || names.length < 1 || names.length > 100 || !names.every((n) => typeof n === "string")) {
        throw new Invalid("names must be a list of 1-100 file names");
      }
      for (const n of names) {
        if (!n || n === "." || n === ".." || /[/\\\0]/.test(n)) throw new Invalid(`'${n}' is not a bare file name`);
        if (n === "display-black.png") throw new Invalid(`${n} is used by the second display; delete it from the stock app if needed`);
        if (d.mediaLists.preset.includes(n)) throw new Invalid(`${n} is a preset; only files in /sdcard/pcMedia can be deleted`);
        if (!d.mediaLists.custom.includes(n)) throw new Invalid(`not in /sdcard/pcMedia: ${n} (GET /api/media?refresh=1)`);
      }
      const gone = new Set(names);
      d.mediaLists.custom = d.mediaLists.custom.filter((n) => !gone.has(n));
      d.mediaLists.sizes = Object.fromEntries(Object.entries(d.mediaLists.sizes || {}).filter(([n]) => !gone.has(n)));
      const sent = ["POST mediaDelete"];
      const playlist = d.config.media.filter((m) => !gone.has(m));
      const changed = playlist.length !== d.config.media.length;
      if (changed) {
        d.config.media = playlist.length ? playlist : [[...d.mediaLists.preset].sort()[0]];
        if (!d.held) sent.push("POST waterBlockScreenId");
      }
      return reply(200, {
        ok: true, deleted: [...names], remaining: [], listedBy: "conn", sent, ...applied(), restartsVideo: changed && !d.held,
        heldByDisplay: changed && d.held, config: pub(), media: clone(d.mediaLists),
      });
    },
    // The page only fetches this after its <video> or <img> reports an error.
    "GET /api/media/preview": () => reply(206, null),
    // Like ryuod: answers at once; the child goes through starting/stopping in later polls.
    "POST /api/display": (body) => {
      if (typeof body.on !== "boolean") throw new Invalid("on must be true or false");
      if (d.display === null) return err(503, "second display is not available in this ryuod");
      if (body.on && standby()) return err(409, "the panel is in standby; turn it on before the second display");
      d.config.secondDisplay = body.on;
      d.display = { ...defaultDisplay(), on: body.on, state: body.on ? "starting" : "stopping" };
      return reply(200, { ok: true, display: clone(d.display), config: pub() });
    },
    "POST /api/panel": (body) => {
      if (typeof body.on !== "boolean") throw new Invalid("on must be true or false");
      if (!body.on && d.display && d.display.on) {
        throw new Refused(409, "the panel shows the second display; turn that off before standby");
      }
      const changed = body.on !== d.panel.on;
      d.panel.on = body.on;
      const sent = !changed ? [] : body.on ? ["POST waterBlockScreen", "POST waterBlockScreenId", "POST power", "POST brightness"] : ["POST disconn"];
      const res = changed ? applied() : { applied: false, acked: false };
      return reply(200, { ok: true, ...res, changed, sent, restartsVideo: changed && body.on, panel: clone(d.panel) });
    },
    // ryuod.post_tray, check_tray and check_steps.
    "POST /api/tray": (body) => {
      const t = clone(d.tray);
      if ("leftClick" in body) {
        if (!TRAY_CLICKS.includes(body.leftClick)) throw new Invalid(`leftClick must be one of ${TRAY_CLICKS.join(", ")}`);
        t.leftClick = body.leftClick;
      }
      if ("brightnessSteps" in body) {
        const v = body.brightnessSteps;
        if (!Array.isArray(v) || v.length < 1 || v.length > 8) throw new Invalid("brightnessSteps must be a list of 1-8 integers 1-100");
        for (const x of v) if (!Number.isInteger(x) || x < 1 || x > 100) throw new Invalid("each brightness step must be an integer 1-100");
        if (new Set(v).size !== v.length) throw new Invalid("brightnessSteps has the same value twice");
        t.brightnessSteps = [...v].sort((a, b) => a - b);
      }
      if ("autostart" in body) {
        if (typeof body.autostart !== "boolean") throw new Invalid("autostart must be true or false");
        t.autostart = body.autostart;
      }
      d.tray = t;
      return reply(200, { ok: true, tray: trayStatus() });
    },
    "POST /api/display/reset-choice": () => {
      if (d.display && d.display.state === "starting") throw new Refused(409, "the second display is starting; try again once it is on or off");
      const removed = d.desktop.portalTokenSaved;
      d.desktop.portalTokenSaved = false;
      return reply(200, { ok: true, removed, desktop: clone(d.desktop) });
    },
    "POST /api/display/open-settings": () => {
      if (!d.desktop.displaySettings) throw new Refused(501, "neither kcmshell6 nor systemsettings is installed (KDE Plasma's display settings)");
      return reply(200, { ok: true, command: [d.desktop.displaySettings, "kcm_kscreen"] });
    },
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
      return reply(200, { ok: true, ...res, sent: unitChanged ? ["POST temperature"] : [], restartsVideo: false, config: pub() });
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
      if (e instanceof Refused) return respond(err(e.status, e.message));
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
