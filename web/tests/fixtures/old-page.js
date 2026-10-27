// The old control page's functions that the parity tests compare the Lit page against, copied
// verbatim out of web/index.html at 048e543 (the last commit on main that changed it), before the
// switch to the Lit page deleted that file. Never imported: report.test.ts, display-parity.test.ts,
// upload.test.ts, media-view.test.ts and background-tab.test.js read this file as text, cut out a
// function by name, and run it with stand-ins for the DOM and the globals it reads. Keep each piece
// as it was; the tests find them with the patterns they used on web/index.html.

function report(j, done, extra) {
  const sent = j.sent || [];
  const text = j.heldByStandby ? `${done} saved; applies when the panel turns on`
    : j.heldByDisplay ? `${done} saved; applies when the second display is off`
    : j.applied === false ? `${done} saved; applies when the cooler reconnects`
    : !sent.length ? `${done} saved${extra ? "; " + extra : ""}`
    : !j.acked ? `${done} sent; the cooler did not confirm it`
    : `${done} — cooler confirmed${j.restartsVideo ? ", video restarted" : ""}`;
  say(text, false, sent.length ? "Sent: " + sent.join(", ") : "");
}

function fmtSize(n) {
  if (n == null) return "";
  if (n < 1e6) return Math.max(1, Math.round(n / 1e3)) + " kB";
  return (n < 1e7 ? (n / 1e6).toFixed(1) : String(Math.round(n / 1e6))) + " MB";
}

const liveName = () => (config && config.media.length ? config.media[0] : null);

function renderHero() {
  const s = lastDisplay;
  const mirror = displayWant || (!!s && s.state === "stopping");
  const view = unreachable ? "down" : previewName ? "preview" : panelOn === false ? "standby" : mirror ? "mirror" : "live";
  const live = liveName();
  const liveCustom = !!live && (mediaLists.custom.includes(live) || (newApi && mediaLists.preset.includes(live)));
  setHeroMedia(view === "preview" ? previewName : view === "live" && liveCustom ? live : null);
  $("hero").dataset.view = view;
  $("standbyView").hidden = view !== "down";
  $("panelOffView").hidden = view !== "standby";
  $("mirrorView").hidden = view !== "mirror";
  $("previewBar").hidden = view !== "preview";
  $("heroHint").textContent = view !== "live" || liveCustom ? "" : live ? `${live} · built-in preset, no browser preview` : "video plays here";
  const lost = !!device && !device.connected;
  $("liveChip").hidden = !(view === "live" && (live || lost));
  $("liveDot").className = "dot " + (lost ? "bad" : "ok");
  const more = config && config.media.length > 1 ? ` + ${config.media.length - 1} more` : "";
  $("liveText").textContent = lost ? "Cooler not connected · changes apply on reconnect" : `Live · ${live}${more}`;
  if (view === "preview") {
    $("pvName").textContent = previewName; $("pvName").title = previewName;
    // The visible label is just "Apply"; the name and tooltip say what it applies.
    $("pvApply").setAttribute("aria-label", `Apply: show ${previewName} on the panel`);
    $("pvApply").title = `Apply: show ${previewName} on the panel`;
    const n = config ? config.media.length : 0;
    $("pvAskLong").textContent = `Replace the ${n}-file playlist with this file?`;
    $("pvAskShort").textContent = `Replace ${n} files?`;
    $("previewBar").classList.toggle("asking", applyAsking);
    for (const id of ["pvNote", "pvApply", "pvClose"]) $(id).hidden = applyAsking;
    for (const id of ["pvAsk", "pvReplace", "pvCancel"]) $(id).hidden = !applyAsking;
    $("pvNote").textContent = panelOn === false ? "panel in standby"
      : config && config.media.includes(previewName) ? "in the playlist" : "not on the panel yet";
  }
  $("mirrorHint").hidden = !!s && s.state !== "on";  // only while the virtual monitor exists
  $("mirrorChip").textContent = "Desktop mirror · " + (!s ? "Virtual-RYUO 2240×1080" : {
    on: "Virtual-RYUO 2240×1080", starting: "starting…", stopping: "stopping…",
    retrying: "not running, see the Desktop mirror tab", error: "stopped by an error, see the Desktop mirror tab",
  }[s.state] || s.state);
}

const UP_ACTIVE = new Set(["receiving", "probing", "converting", "pushing", "starting"]);
const UP_DONE = {
  copy: "sent as it was", remux: "repackaged without re-encoding", transcode: "converted", image: "converted to a 2240×1080 PNG",
};
let upXhr = null, upCancelled = false, upWatch = null, upActive = false;
function pct(x) { return Math.round(x * 100) + " %"; }
function renderUpload(u) {
  const active = upActive = !!u && UP_ACTIVE.has(u.state);
  $("upBrowse").disabled = active; $("upCancel").hidden = !active;
  const bar = $("upBar"); bar.hidden = !active;
  if (active) { if (u.progress == null) bar.removeAttribute("value"); else bar.value = u.progress; }
  $("upStatus").classList.toggle("bad", !!u && u.state === "error");
  if (!u) { $("upStatus").textContent = ""; return; }
  const file = u.file || "the file", amount = u.progress != null ? ": " + pct(u.progress) : "…";
  let text = {
    receiving: `Uploading ${file}${amount}`,
    probing: `Checking ${file}…`,
    converting: (u.action === "image" ? "Converting to a 2240×1080 PNG" : u.action === "remux" ? "Repackaging as MP4"
      : `Converting to 2240×1080 HEVC with ${u.encoder}`) + amount + (u.speed ? ` at ${u.speed}` : ""),
    pushing: "Copying to the cooler over adb…",
    starting: "Starting playback…",
    done: (u.heldByStandby ? `Selected ${u.name} (applies when the panel turns on)`
      : u.heldByDisplay ? `Selected ${u.name} (applies when the second display is off)`
      : `Playing ${u.name}${u.applied === false ? " once the cooler reconnects" : ""}`) + `, ${UP_DONE[u.action] || u.action}`,
    error: `Upload failed: ${u.error}`,
    cancelled: "Upload cancelled",
  }[u.state] || u.state;
  // An image's reason only repeats "converted to a PNG".
  if (u.reason && u.action !== "image" && (u.state === "converting" || (u.state === "done" && u.action === "transcode"))) text += `. Reason: ${u.reason}`;
  $("upStatus").textContent = text;
}

function displayText(s) {
  switch (s.state) {
    case "off": return "Off";
    case "starting": return "Starting" + (s.message ? `: ${s.message}` : "…");
    case "on":
      if (s.fps == null) return "On. The frame rate shows after the first 5 s.";
      if (s.fps === 0) return "On. No frames sent in the last 5 s: nothing on the virtual monitor changed.";
      return `On: ${s.fps.toFixed(1)} frames/s at ${s.mbps.toFixed(1)} Mb/s to the panel (average over 5 s)`;
    case "stopping": return "Stopping: removing the virtual monitor, up to about 10 s…";
    case "retrying": return `Not running. Next try in ${s.retryInS ?? 0} s.`;
    case "error": return "Stopped by an error that a retry would hit again. Fix the cause, then press Try again now. It is also tried again when the cooler reconnects.";
    default: return s.state;
  }
}

const MIRROR_IN_STANDBY = "the panel is in standby; turn it on before the second display";
const STANDBY_IN_MIRROR = "the panel shows the second display; turn that off before standby";

function renderDisplaySwitch() {
  const available = !!lastDisplay, blocked = panelOn === false && !displayWant;
  $("modeStats").setAttribute("aria-pressed", displayWant ? "false" : "true");
  $("modeMirror").setAttribute("aria-pressed", displayWant ? "true" : "false");
  $("displaySwitch").setAttribute("aria-checked", displayWant ? "true" : "false");
  $("modeStats").disabled = !available;
  for (const id of ["modeMirror", "displaySwitch"]) {
    $(id).disabled = !available || blocked;
    $(id).title = blocked ? MIRROR_IN_STANDBY : "";
  }
  renderPanelSwitch();
  // The overlay is hidden on the panel while the desktop shows there.
  $("statsOn").disabled = displayWant;
  $("statsOnLabel").classList.toggle("off", displayWant);
  $("statsOnLabel").title = displayWant ? "The panel shows the desktop; the overlay returns when the second display is off."
    : "Stats overlay on the panel. Off hides it and keeps your slot choices.";
}

function renderDisplay(s) {
  lastDisplay = s;
  const failed = !!s && (s.state === "retrying" || s.state === "error");
  if (s && !displaySending) displayWant = s.on;
  renderDisplaySwitch();
  $("displayDot").className = "dot" + (!s ? "" : failed ? " bad" : s.state === "on" ? " ok" : "");
  $("displayText").textContent = s ? displayText(s) : "Not available: this ryuod has no second-display support. Restart it.";
  const p = s && (s.state === "on" || s.state === "starting") ? s.pointer : null;
  $("displayPointer").hidden = !p;
  $("displayPointer").textContent = !p ? "" : p.shown
    ? "Mouse pointer: shown on the panel."
    : `No mouse pointer on the panel: ${p.reason || "unknown reason"}. Turn the switch off and on to choose the screen again.`;
  const bg = s && s.backgroundError;
  $("displayBackground").hidden = !bg;
  $("displayBackground").textContent = bg
    ? `Couldn't put the black background on the cooler: ${bg}. While the panel shows the desktop, HomeUI's video plays under it and uses more of the cooler's decoder.`
    : "";
  $("displayErr").hidden = !failed || !s.error;
  $("displayErr").textContent = failed && s.error ? s.error : "";
  $("displayRetry").hidden = !failed;
  renderHero();
}

function renderPanelSwitch() {
  const sw = $("panelSwitch"), known = panelOn !== null;
  sw.hidden = !known;
  if (!known) return;
  sw.setAttribute("aria-checked", panelOn ? "true" : "false");
  $("panelLabel").textContent = panelOn ? "On" : "Standby";
  const blocked = panelOn && displayWant;
  sw.disabled = blocked || panelSending;
  sw.title = blocked ? STANDBY_IN_MIRROR : "";
  $("panelTurnOn").disabled = panelSending;
}

function renderPanel(p) {
  if (!panelSending) panelOn = p ? p.on : null;
  renderDisplaySwitch(); renderHero();
}

function showDown(message) {
  $("connPill").className = "pill bad"; $("dot").className = "dot bad";
  $("conn").textContent = "Daemon unreachable"; $("connFw").textContent = "";
  $("err").textContent = message; $("errRow").hidden = !message;
  $("standbyText").textContent = message;
  renderHero();
}
