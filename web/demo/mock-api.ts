/**
 * A stand-in for ryuod's HTTP API, for recording the control page without a cooler: `npm run demo`
 * serves the page with this plugin answering /api/* from memory instead of proxying to ryuod.
 * Nothing reaches the device or ryuod; every change lives until the dev server stops.
 *
 * The media are the clips make-media.sh renders into demo/media/. Uploads are kept in memory and
 * walk through ryuod's upload states on a timer; the second display walks through starting, on
 * and stopping the same way. The replies follow the types in src/api-types.ts.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import type {
  CatalogItem,
  Config,
  DisplayStatus,
  MediaLists,
  ProtectionStatus,
  StatValue,
  TrayClick,
  TrayStatus,
  UploadStatus,
} from "../src/api-types.ts";

const MEDIA_DIR = fileURLToPath(new URL("./media/", import.meta.url));
const CATALOG: CatalogItem[] = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url), "utf8"));
const TEMP_ITEMS = new Set(["CPU Temperature", "GPU Temperature", "Hard Disk Temperature", "Motherboard Temperature"]);
const BLACK = "display-black.png";
const PRESETS = [1, 2, 3, 4, 5].map((number) => `RYUO_IV_HW_Info_0${number}.mp4`);
const TRAY_CLICKS: TrayClick[] = ["page", "menu", "panel", "stats"];

/** The sizes the tiles show: what the full-size 2240×1080 files would weigh, not the demo clips. */
const SIZES: Record<string, number> = {
  "aurora-drift.mp4": 18_420_113,
  "sunset-bloom.mp4": 9_874_552,
  "neon-life.mp4": 42_118_904,
  "synthwave-spiral.mp4": 24_310_552,
  "plasma-flow.mp4": 6_502_771,
  "rog-red-glow.png": 1_384_220,
  [BLACK]: 7_126,
};

/** A file uploaded during the demo: its bytes, served as both its preview and its thumbnail source. */
interface Uploaded {
  bytes: Buffer;
  type: string;
  thumb: Buffer | null;
}

// ---------------------------------------------------------------- state

const config: Config = {
  media: ["aurora-drift.mp4", "neon-life.mp4", "synthwave-spiral.mp4"],
  playMode: "Cycle",
  ratio: "2:1",
  items: ["CPU Temperature", "CPU Load", "GPU Temperature", "GPU Load", "Memory Utilization", "Date&Time"],
  statsVisible: true,
  titleColor: "#E5252B",
  contentColor: "#FFFFFF",
  filter: { on: false, opacity: 100 },
  brightness: 87,
  brightnessPercent: brightnessPercent(87),
  tempUnit: "Celsius",
  memoryMHz: 0,
  sensors: { motherboard: "auto" },
  secondDisplay: false,
  burnInProtection: true,
};

const media: MediaLists = {
  source: "conn",
  fetchedAt: Date.now(),
  preset: [...PRESETS],
  custom: Object.keys(SIZES),
  sizes: { ...SIZES },
};

const uploads = new Map<string, Uploaded>();
let panelOn = true;
let upload: UploadStatus | null = null;
let uploadTimer: ReturnType<typeof setTimeout> | undefined;

const tray = { autostart: true, leftClick: "page" as TrayClick, brightnessSteps: [25, 50, 75, 85, 100] };
const desktop = { portalTokenSaved: true, displaySettings: "kcmshell6" };

/** The second display: its state, and when it entered it, for the fake frame rate and protection report. */
let displayState: DisplayStatus["state"] = "off";
let displaySince = Date.now();
let displayTimer: ReturnType<typeof setTimeout> | undefined;

// ---------------------------------------------------------------- derived replies

/** ryuod.brightness_percent: the device scale (0-102) as a share of the 255 backlight levels. */
function brightnessPercent(value: number): number {
  return Math.round((Math.min(255, Math.trunc(value * 2.5)) * 100) / 255);
}

/** ryuod.brightness_value: the lowest device value whose percentage reaches `percent`. */
function brightnessValue(percent: number): number {
  for (let value = 0; value <= 102; value++) if (brightnessPercent(value) >= percent) return value;
  return 102;
}

const publicConfig = (): Config => ({
  ...structuredClone(config),
  brightnessPercent: brightnessPercent(config.brightness),
});

function trayStatus(): TrayStatus {
  return {
    ...structuredClone(tray),
    brightnessStepValues: tray.brightnessSteps.map(brightnessValue),
    leftClickOptions: TRAY_CLICKS,
  };
}

function protectionStatus(): ProtectionStatus {
  const streaming = displayState === "on";
  if (!config.burnInProtection || !streaming) {
    return { enabled: !!config.burnInProtection, state: null, idleS: null, nextShiftS: null, frames: null };
  }
  const seconds = (Date.now() - displaySince) / 1000;
  return {
    enabled: true,
    state: "active",
    idleS: Math.round(seconds % 40),
    nextShiftS: 180 - Math.round(seconds % 180),
    frames: null,
  };
}

function displayStatus(): DisplayStatus {
  const on = displayState === "on";
  const wobble = Math.sin(Date.now() / 1700);
  return {
    on: displayState === "starting" || on,
    state: displayState,
    fps: on && Date.now() - displaySince > 5000 ? 29.4 + wobble * 0.5 : null,
    mbps: on && Date.now() - displaySince > 5000 ? 11.8 + wobble * 2.1 : null,
    message: displayState === "starting" ? "creating the virtual monitor" : null,
    error: null,
    pointer: on ? { shown: true, reason: null } : null,
    backgroundError: null,
    retryInS: null,
    protection: protectionStatus(),
  };
}

function setDisplay(on: boolean): void {
  clearTimeout(displayTimer);
  displayState = on ? "starting" : "stopping";
  displaySince = Date.now();
  displayTimer = setTimeout(
    () => {
      displayState = on ? "on" : "off";
      displaySince = Date.now();
    },
    on ? 2500 : 5000,
  );
}

/** ryuod.panel_text: the value as HomeUI draws it. */
function panelText(item: string, value: number | string): string {
  if (typeof value === "string") return value;
  if (TEMP_ITEMS.has(item)) return String(Math.trunc(config.tempUnit === "Fahrenheit" ? value * 1.8 + 32 : value));
  if (item.endsWith("Voltage")) return String(Math.round(value * 1000) / 1000);
  return String(Math.round(value));
}

/** Plausible readings that drift smoothly over time, for a gaming PC under a moderate load. */
function readings(now: number): Record<string, number | string | null> {
  const seconds = now / 1000;
  const drift = (period: number, phase = 0) => Math.sin(seconds / period + phase);
  const jitter = () => Math.random() - 0.5;
  const gpuLoad = 71 + 18 * drift(9) + 4 * jitter();
  const gpuPower = 180 + 90 * drift(9) + 6 * jitter();
  const time = new Date(now);
  return {
    "CPU Load": 24 + 11 * drift(7) + 3 * jitter(),
    "CPU Usage": 46 + 20 * drift(5, 1) + 5 * jitter(),
    "CPU Temperature": 58 + 7 * drift(13) + jitter(),
    "CPU Speed Average": 4650 + 300 * drift(4) + 40 * jitter(),
    "CPU Voltage": null,
    "GPU Load": gpuLoad,
    "GPU Usage": gpuLoad,
    "GPU Temperature": 63 + 6 * drift(15, 2) + jitter(),
    "GPU Speed": 2610 + 120 * drift(6) + 15 * jitter(),
    "GPU Power": gpuPower,
    "GPU Voltage": null,
    "Memory Utilization": 47 + 3 * drift(30),
    "Memory Frequency": config.memoryMHz || null,
    "Hard Disk Temperature": 39 + drift(40),
    "Motherboard Temperature": 36 + drift(50),
    "Date&Time": `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`,
    "Fan Speed Disk R MB/s": Math.max(0, 40 + 60 * drift(3) + 20 * jitter()),
    "Fan Speed Disk W MB/s": Math.max(0, 6 + 8 * drift(4) + 3 * jitter()),
    "Fan Speed Net Down KB/s": Math.max(0, 850 + 700 * drift(2.5) + 120 * jitter()),
    "Fan Speed Net Up KB/s": Math.max(0, 95 + 60 * drift(3.5) + 20 * jitter()),
    "Fan Speed GPU W": gpuPower,
  };
}

function stats() {
  const now = Date.now();
  const values: Record<string, StatValue> = {};
  for (const [item, reading] of Object.entries(readings(now))) {
    const unit = catalog().find((entry) => entry.item === item)?.unit ?? "";
    const value = reading ?? 0;
    const rounded = typeof value === "number" ? Math.round(value * 10) / 10 : value;
    values[item] = { value: rounded, unit, available: reading !== null, panel: panelText(item, rounded) };
  }
  return { sampledAt: now, values, lastPcInfo: null };
}

/** The catalog as ryuod reports it: °C units follow tempUnit, and Memory Frequency needs memoryMHz. */
function catalog(): CatalogItem[] {
  const degrees = config.tempUnit === "Fahrenheit" ? "°F" : "°C";
  return CATALOG.map((entry) => ({
    ...entry,
    unit: entry.unit === "°C" ? degrees : entry.unit,
    available: entry.item === "Memory Frequency" ? config.memoryMHz > 0 : entry.available,
    source: entry.item === "Memory Frequency" && config.memoryMHz > 0 ? "entered under Units" : entry.source,
  }));
}

const outcome = (sent: string[], restartsVideo = false) => ({
  applied: panelOn,
  acked: panelOn,
  ...(panelOn ? {} : { heldByStandby: true }),
  heldByDisplay: false,
  sent: panelOn ? sent : [],
  restartsVideo: panelOn && restartsVideo,
});

// ---------------------------------------------------------------- uploads

const contentType = (name: string) =>
  /\.png$/i.test(name)
    ? "image/png"
    : /\.jpe?g$/i.test(name)
      ? "image/jpeg"
      : /\.webm$/i.test(name)
        ? "video/webm"
        : "video/mp4";

/** The first frame of an uploaded video as a JPEG, from ffmpeg; null when ffmpeg cannot read it. */
function grabThumb(bytes: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=448:-2",
      "-f",
      "mjpeg",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.on("error", () => resolve(null));
    ffmpeg.on("close", (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    ffmpeg.stdin.on("error", () => {
      // ffmpeg stops reading once it has its frame
    });
    ffmpeg.stdin.end(bytes);
  });
}

/** ryuod's name for an upload: the time it arrived, then the original name. */
function uploadName(original: string): string {
  const now = new Date();
  const two = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, "0")}`;
  const image = /\.(png|jpe?g)$/i.test(original);
  const base = original.replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "_") || "upload";
  return `${stamp}_${base}.${image ? "png" : "mp4"}`;
}

/** Walk the upload through probing, converting, pushing and starting, then play it alone. */
function runUpload(job: UploadStatus, stored: Uploaded): void {
  const image = job.action === "image";
  const steps: [UploadStatus["state"], number][] = [
    ["probing", 700],
    ...Array.from({ length: 11 }, (): [UploadStatus["state"], number] => ["converting", image ? 120 : 450]),
    ["pushing", 1400],
    ["starting", 700],
  ];
  let step = 0;
  let converted = 0;
  const next = () => {
    if (upload !== job) return;
    if (step === steps.length) {
      const name = job.name as string;
      uploads.set(name, stored);
      media.custom.push(name);
      media.sizes = { ...media.sizes, [name]: image ? 2_100_000 : Math.round(job.bytes * 0.6) };
      media.fetchedAt = Date.now();
      config.media = [name];
      config.playMode = "Single";
      Object.assign(job, {
        state: "done",
        progress: 1,
        applied: panelOn,
        acked: panelOn,
        heldByStandby: !panelOn,
        heldByDisplay: false,
        finishedAt: Date.now(),
      });
      return;
    }
    const [state, wait] = steps[step++];
    job.state = state;
    if (state === "converting") {
      job.progress = converted++ / 10;
      job.speed = image ? null : `${(2.6 + Math.random()).toFixed(1)}x`;
    } else {
      job.progress = null;
      job.speed = null;
    }
    uploadTimer = setTimeout(next, wait);
  };
  next();
}

// ---------------------------------------------------------------- HTTP

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(response: ServerResponse, status: number, body: object): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** Serve `bytes` whole, or the byte range a <video> asks for. */
function sendFile(request: IncomingMessage, response: ServerResponse, bytes: Buffer, type: string): void {
  response.setHeader("Content-Type", type);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "no-store");
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (!range) {
    response.setHeader("Content-Length", bytes.length);
    response.end(bytes);
    return;
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
  response.statusCode = 206;
  response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
  response.setHeader("Content-Length", end - start + 1);
  response.end(bytes.subarray(start, end + 1));
}

function known(name: string): boolean {
  return media.custom.includes(name) || media.preset.includes(name);
}

async function mediaFile(kind: "thumb" | "preview", name: string): Promise<{ bytes: Buffer; type: string }> {
  if (!known(name)) throw new Refused(404, `${name} is not on the cooler`);
  const stored = uploads.get(name);
  if (stored) {
    if (kind === "preview") return { bytes: stored.bytes, type: stored.type };
    if (stored.type.startsWith("image/")) return { bytes: stored.bytes, type: stored.type };
    if (stored.thumb) return { bytes: stored.thumb, type: "image/jpeg" };
    throw new Refused(500, "ffmpeg could not read the file");
  }
  const file = kind === "thumb" ? `${name}.jpg` : name;
  return { bytes: readFileSync(MEDIA_DIR + file), type: kind === "thumb" ? "image/jpeg" : contentType(name) };
}

type Body = Record<string, unknown>;
const bool = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") throw new Refused(400, `${name} must be true or false`);
  return value;
};

const POSTS: Record<string, (body: Body) => object> = {
  "/api/overlay": (body) => {
    for (const key of ["items", "titleColor", "contentColor", "statsVisible"] as const) {
      if (key in body) (config as unknown as Body)[key] = body[key];
    }
    if (body.filter) config.filter = { ...config.filter, ...(body.filter as Partial<Config["filter"]>) };
    return { ...outcome(["POST preset"]), config: publicConfig() };
  },
  "/api/brightness": (body) => {
    const value = "percent" in body ? brightnessValue(Number(body.percent)) : Number(body.value);
    config.brightness = value;
    return {
      ...outcome(["POST brightness"]),
      deviceLevel: Math.min(255, Math.trunc(value * 2.5)),
      value,
      percent: brightnessPercent(value),
    };
  },
  "/api/media/select": (body) => {
    const chosen = body.media as string[];
    if (!Array.isArray(chosen) || !chosen.length) throw new Refused(400, "media must name at least one file");
    const missing = chosen.find((name) => !known(name));
    if (missing) throw new Refused(400, `${missing} is not on the cooler`);
    config.media = [...chosen];
    if (body.playMode) config.playMode = body.playMode as Config["playMode"];
    return { ...outcome(["POST waterBlockScreenId"], true), config: publicConfig() };
  },
  "/api/media/delete": (body) => {
    const names = body.names as string[];
    for (const name of names) {
      if (name === BLACK) throw new Refused(400, `${BLACK} is used by the second display`);
      if (!media.custom.includes(name)) throw new Refused(400, `${name} is not on the cooler`);
    }
    media.custom = media.custom.filter((name) => !names.includes(name));
    for (const name of names) {
      delete media.sizes?.[name];
      uploads.delete(name);
    }
    media.fetchedAt = Date.now();
    const playing = config.media.filter((name) => !names.includes(name));
    const changed = playing.length !== config.media.length;
    config.media = playing.length ? playing : [media.custom.find((name) => name !== BLACK) ?? PRESETS[0]];
    return {
      ...outcome(changed ? ["POST mediaDelete", "POST waterBlockScreenId"] : ["POST mediaDelete"], changed),
      deleted: names,
      remaining: [],
      listedBy: "conn",
      heldByStandby: !panelOn,
      config: publicConfig(),
      media: structuredClone(media),
    };
  },
  "/api/media/upload/cancel": () => {
    if (!upload || ["done", "error", "cancelled"].includes(upload.state))
      throw new Refused(409, "no upload in progress");
    clearTimeout(uploadTimer);
    Object.assign(upload, { state: "cancelled", finishedAt: Date.now() });
    return { upload };
  },
  "/api/display": (body) => {
    const on = bool(body.on, "on");
    if (on && !panelOn) throw new Refused(409, "the panel is in standby; turn it on before the second display");
    config.secondDisplay = on;
    setDisplay(on);
    return { display: displayStatus(), config: publicConfig() };
  },
  "/api/display/protection": (body) => {
    config.burnInProtection = bool(body.enabled, "enabled");
    return { protection: protectionStatus(), config: publicConfig() };
  },
  "/api/panel": (body) => {
    const on = bool(body.on, "on");
    if (!on && displayState !== "off")
      throw new Refused(409, "the panel shows the second display; turn that off before standby");
    const changed = on !== panelOn;
    panelOn = on;
    const sent = on
      ? ["POST waterBlockScreen", "POST waterBlockScreenId", "POST power", "POST brightness"]
      : ["POST disconn"];
    return { applied: true, acked: true, changed, sent, restartsVideo: on, panel: { on } };
  },
  "/api/tray": (body) => {
    if ("autostart" in body) tray.autostart = bool(body.autostart, "autostart");
    if ("leftClick" in body) tray.leftClick = body.leftClick as TrayClick;
    if ("brightnessSteps" in body) tray.brightnessSteps = [...(body.brightnessSteps as number[])].sort((a, b) => a - b);
    return { tray: trayStatus() };
  },
  "/api/display/reset-choice": () => {
    if (displayState === "starting")
      throw new Refused(409, "the second display is starting; try again once it is on or off");
    const removed = desktop.portalTokenSaved;
    desktop.portalTokenSaved = false;
    return { removed, desktop: { ...desktop } };
  },
  "/api/display/open-settings": () => ({ command: ["kcmshell6", "kcm_kscreen"] }),
  "/api/prefs": (body) => {
    const changed = "tempUnit" in body && body.tempUnit !== config.tempUnit;
    if ("tempUnit" in body) config.tempUnit = body.tempUnit as Config["tempUnit"];
    if ("memoryMHz" in body) config.memoryMHz = Number(body.memoryMHz);
    if ("sensors" in body) config.sensors = body.sensors as Config["sensors"];
    return {
      ...outcome(changed ? ["POST temperature"] : []),
      acked: changed && panelOn,
      config: publicConfig(),
    };
  },
};

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://demo");
  const path = url.pathname;
  if (request.method === "GET") {
    switch (path) {
      case "/api/state":
        return send(response, 200, {
          ok: true,
          device: {
            connected: true,
            hidraw: "/dev/hidraw3",
            vid: "0b05",
            pid: "1c76",
            firmware: "V1.0.10",
            product: "Ryuo IV Standard",
            lastHeartbeatMs: 12 + Math.round(Math.random() * 10),
            lastHomeuiAckMs: 14 + Math.round(Math.random() * 10),
            recoveries: 0,
            lastError: null,
            heartbeat: "post",
          },
          config: publicConfig(),
          limits: { slots: 6, brightnessMax: 102, frameMax: 1024, lastHeartbeatBytes: 342, uploadMax: 4294967296 },
          media: { preset: media.preset, custom: media.custom },
          upload,
          display: displayStatus(),
          panel: { on: panelOn },
          tray: trayStatus(),
          desktop,
        });
      case "/api/stats":
        return send(response, 200, { ok: true, ...stats() });
      case "/api/catalog":
        return send(response, 200, { ok: true, items: catalog() });
      case "/api/media":
        if (url.searchParams.get("refresh")) media.fetchedAt = Date.now();
        return send(response, 200, { ok: true, ...structuredClone(media) });
      case "/api/media/thumb":
      case "/api/media/preview": {
        const { bytes, type } = await mediaFile(
          path.endsWith("thumb") ? "thumb" : "preview",
          url.searchParams.get("name") ?? "",
        );
        return sendFile(request, response, bytes, type);
      }
    }
    throw new Refused(404, `no such endpoint: ${path}`);
  }
  if (request.method !== "POST") throw new Refused(405, `${request.method} is not supported`);
  if (path === "/api/media/upload") {
    if (upload && !["done", "error", "cancelled"].includes(upload.state)) {
      throw new Refused(409, "another video is still being processed");
    }
    const original = decodeURIComponent(String(request.headers["x-filename"] ?? "upload.mp4"));
    const bytes = await readBody(request);
    const type = contentType(original);
    const image = type.startsWith("image/");
    const job: UploadStatus = {
      state: "probing",
      file: original,
      bytes: bytes.length,
      received: bytes.length,
      progress: null,
      speed: null,
      action: image ? "image" : "transcode",
      reason: image ? null : "the panel plays HEVC only",
      encoder: image ? null : "hevc_vaapi",
      name: uploadName(original),
      error: null,
      applied: null,
      acked: null,
      heldByDisplay: null,
      heldByStandby: null,
      startedAt: Date.now(),
      finishedAt: null,
    };
    upload = job;
    runUpload(job, { bytes, type, thumb: image ? null : await grabThumb(bytes) });
    return send(response, 202, { ok: true, upload: job });
  }
  const post = POSTS[path];
  if (!post) throw new Refused(404, `no such endpoint: ${path}`);
  const text = (await readBody(request)).toString("utf8");
  let body: Body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Refused(400, "body must be JSON");
  }
  send(response, 200, { ok: true, ...post(body) });
}

/** The Vite plugin: answers /api/* before Vite's own middleware sees it. */
export function mockApi(): Plugin {
  return {
    name: "ryuo-mock-api",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith("/api/")) return next();
        handle(request, response).catch((error: unknown) => {
          const status = error instanceof Refused ? error.status : 500;
          send(response, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
        });
      });
    },
  };
}
