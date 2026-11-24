/* Soundscape Loudness panel - frontend */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------------------------------------------------------------- state
const DEFAULTS = {
  tab: "timeline", scope: "all", fileId: null, day: null, metric: "band", weighting: "A",
  res: "auto", offset: 0, thrOn: false, thr: -45, overlay: false, ovMetric: "leq",
  group: "file", hmMetric: "leq", hmSlot: "300", theme: "auto", specOn: true, fscale: "log",
  place: "", compare: true, hmRows: "day",
};
const st = Object.assign({}, DEFAULTS, (() => {
  try { return JSON.parse(localStorage.getItem("slp-state") || "{}"); } catch { return {}; }
})());
const save = () => { try { localStorage.setItem("slp-state", JSON.stringify(st)); } catch {} };

let catalog = { files: [], days: [], places: [], folder: null };
let filesById = {};
let current = null;        // last /api/series (or overlay) response, display-ready
let plots = { main: null, ndsi: null };
let suppressScale = false;
let lastDone = -1;
let bands = { anthro: [1000, 2000], bio: [2000, 11000] };
let defaultBands = bands;
let spec = null;           // last /api/spectrogram response (+ decoded bytes)

// ---------------------------------------------------------------- helpers
async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
});

function toast(msg, ms = 4000) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const pad = (n) => String(n).padStart(2, "0");
function fmtClock(epoch, sec = true) {      // naive recorder time, encoded as UTC
  const d = new Date(epoch * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${sec ? ":" + pad(d.getUTCSeconds()) : ""}`;
}
function fmtDay(epoch) { const d = new Date(epoch * 1000); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; }
function fmtTod(s, sec = false) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return `${pad(h)}:${pad(m)}${sec ? ":" + pad(x) : ""}`;
}
const dayEpoch = (day) => Date.parse(day + "T00:00:00Z") / 1000;
const unit = () => (Number(st.offset) ? "dB SPL≈" : "dBFS");
const off = () => Number(st.offset) || 0;
const fmtDb = (v) => (v == null ? "–" : (v + off()).toFixed(1));
const fmtHz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`);
const fmtHzRange = ([lo, hi]) => (lo >= 1000 && hi >= 1000 ? `${+(lo / 1000).toFixed(2)}–${+(hi / 1000).toFixed(2)} kHz` : `${fmtHz(lo)}–${fmtHz(hi)}`);
const bandLabel = (k) => (k === "anthro" ? `Anthrophony ${fmtHzRange(bands.anthro)}` : `Biophony ${fmtHzRange(bands.bio)}`);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- places: each sub-folder of the loaded folder is a place
const placeNames = () => (catalog.places || []).map((p) => p.name);
const multiPlace = () => placeNames().length > 1;
const curPlace = () => (multiPlace() && placeNames().includes(st.place) ? st.place : "");
const allPlacesView = () => multiPlace() && !curPlace();
function placeColor(p) {
  const i = Math.max(0, placeNames().indexOf(p));
  return css(`--series-${(i % 8) + 1}`);
}
const placeChip = (p) => (p ? `<span class="place-chip" title="${esc(p)}"><i style="background:${placeColor(p)}"></i>${esc(p)}</span>` : "");
const compareMode = () => allPlacesView() && st.scope !== "file" && st.compare;
const withPlace = (q, place = curPlace()) => { if (place) q.set("place", place); return q; };
const resLabel = (r) => ({ 0.125: "125 ms", 1: "1 s", 10: "10 s", 60: "1 min", 300: "5 min" }[r] || r + " s");

// ---------------------------------------------------------------- controls
function bindSeg(id, key, onChange) {
  const el = $(id);
  const sync = () => el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === st[key]));
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    st[key] = b.dataset.v; save(); sync(); onChange && onChange();
  });
  sync();
}

function initControls() {
  $$(".tab").forEach((b) => b.addEventListener("click", () => { st.tab = b.dataset.tab; save(); showTab(); }));
  bindSeg("#weightingSeg", "weighting", refreshView);
  bindSeg("#scopeSeg", "scope", () => { fillScopeSelect(); syncScopeUi(); loadTimeline(); });
  bindSeg("#metricSeg", "metric", () => loadTimeline());
  bindSeg("#groupSeg", "group", loadSummary);
  bindSeg("#hmRowsSeg", "hmRows", loadSummary);
  $("#placeSelect").addEventListener("change", (e) => {
    st.place = e.target.value; st.fileId = null; st.day = null; save();
    fillScopeSelect(); syncScopeUi(); destroyPlots(); refreshView();
  });
  $("#compareOn").checked = st.compare;
  $("#compareOn").addEventListener("change", (e) => { st.compare = e.target.checked; save(); syncScopeUi(); destroyPlots(); loadTimeline(); });
  bindSeg("#fscaleSeg", "fscale", () => { if (plots.spec) { plots.spec.destroy(); plots.spec = null; } drawSpectro(); });
  $("#specOn").checked = st.specOn;
  $("#specOn").addEventListener("change", (e) => {
    st.specOn = e.target.checked; save();
    if (!st.specOn && plots.spec) { plots.spec.destroy(); plots.spec = null; }
    loadSpectro(plots.main && current && current.kind === "concat" ? [plots.main.scales.x.min, plots.main.scales.x.max] : null);
  });
  initBands();

  const num = (id, key, fn) => {
    const el = $(id); el.value = st[key];
    el.addEventListener("change", () => { st[key] = Number(el.value) || 0; save(); fn(); });
  };
  num("#offsetInput", "offset", refreshView);
  num("#thrInput", "thr", () => { if (st.thrOn) refreshView(); });
  $("#thrOn").checked = st.thrOn;
  $("#thrOn").addEventListener("change", (e) => { st.thrOn = e.target.checked; save(); refreshView(); });

  const sel = (id, key, fn) => {
    const el = $(id); el.value = st[key];
    el.addEventListener("change", () => { st[key] = el.value; save(); fn(); });
  };
  sel("#resSelect", "res", () => loadTimeline());
  sel("#ovMetric", "ovMetric", () => loadTimeline());
  sel("#hmMetric", "hmMetric", loadSummary);
  sel("#hmSlot", "hmSlot", loadSummary);
  $("#overlayOn").checked = st.overlay;
  $("#overlayOn").addEventListener("change", (e) => { st.overlay = e.target.checked; save(); syncScopeUi(); loadTimeline(); });

  $("#scopeSelect").addEventListener("change", (e) => {
    if (st.scope === "file") st.fileId = e.target.value; else st.day = e.target.value;
    save(); loadTimeline();
  });
  $("#prevBtn").addEventListener("click", () => stepScope(-1));
  $("#nextBtn").addEventListener("click", () => stepScope(1));
  $("#resetZoom").addEventListener("click", () => loadTimeline());

  $("#pickBtn").addEventListener("click", pickFolder);
  $("#loadBtn").addEventListener("click", () => loadPath($("#pathInput").value));
  $("#pathInput").addEventListener("keydown", (e) => { if (e.key === "Enter") loadPath(e.target.value); });
  $("#themeBtn").addEventListener("click", () => {
    st.theme = { auto: "light", light: "dark", dark: "auto" }[st.theme]; save(); applyTheme(); rebuildPlots();
    toast(`Theme: ${st.theme}`, 1500);
  });
  $("#exportSeries").addEventListener("click", (e) => {
    e.preventDefault();
    const { scope, id } = scopeParams();
    const res = st.res === "auto" ? (current && current.res ? String(current.res) : "60") : st.res;
    const q = withPlace(new URLSearchParams({ kind: "series", scope, id: id || "", res, weighting: st.weighting, offset: off() }));
    location.href = `/api/export.csv?${q}`;
  });
  $("#exportSummary").addEventListener("click", (e) => {
    e.preventDefault();
    const q = withPlace(new URLSearchParams({ kind: "summary", group: st.group, weighting: st.weighting, offset: off() }));
    if (st.thrOn) q.set("threshold", st.thr - off());
    location.href = `/api/export.csv?${q}`;
  });
  window.addEventListener("resize", () => { clearTimeout(window._rs); window._rs = setTimeout(resizePlots, 120); });
  initDrop();
  initPlayer();
}

function applyTheme() {
  if (st.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", st.theme);
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => rebuildPlots());

function showTab() {
  $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === st.tab));
  $("#timelineView").classList.toggle("hidden", st.tab !== "timeline" || !catalog.files.length);
  $("#summaryView").classList.toggle("hidden", st.tab !== "summary" || !catalog.files.length);
  refreshView();
}
function refreshView() {
  if (!readyFiles().length) return;
  if (st.tab === "timeline") loadTimeline(); else loadSummary();
}

// ---------------------------------------------------------------- folder & status
async function pickFolder() {
  try {
    toast("Choose a folder in the dialog…", 2500);
    const r = await post("/api/pick-folder");
    if (r.cancelled) return;
    onFolderLoaded();
  } catch (e) { toast(e.message); }
}
async function loadPath(p) {
  p = (p || "").trim().replace(/^['"]|['"]$/g, "").replace(/\\ /g, " ");
  if (!p) return;
  try { await post("/api/folder", { path: p }); onFolderLoaded(); } catch (e) { toast(e.message); }
}
function onFolderLoaded() {
  lastDone = -1; st.fileId = null; st.day = null; save();
  destroyPlots(); pollStatus(true);
}

async function pollStatus(once) {
  clearTimeout(pollStatus._t);
  let s;
  try { s = await api("/api/status"); } catch { pollStatus._t = setTimeout(pollStatus, 3000); return; }
  $("#folderLabel").textContent = s.folder || "No folder loaded";
  $("#folderLabel").title = s.folder || "";
  const busy = s.pending > 0;
  $("#progress").classList.toggle("hidden", !busy && !s.error);
  $("#progressFill").style.width = s.total ? `${(100 * (s.done + s.error)) / s.total}%` : "0";
  $("#progressText").textContent = busy
    ? `Analysing ${s.done + s.error}/${s.total} files… (${Math.round(s.elapsed)} s)`
    : s.error ? `${s.error} file(s) failed: ${Object.values(s.errors)[0]}` : "";
  if (s.bands && JSON.stringify(s.bands) !== JSON.stringify(bands)) { bands = s.bands; updateBandLabels(); }
  if (s.default_bands) defaultBands = s.default_bands;
  if (s.done !== lastDone) {
    const first = lastDone <= 0;
    lastDone = s.done;
    await refreshCatalog();
    if (first || !busy) refreshView();
    else { const now = Date.now(); if (!pollStatus._lr || now - pollStatus._lr > 4000) { pollStatus._lr = now; refreshView(); } }
  }
  pollStatus._t = setTimeout(pollStatus, busy ? 1000 : 5000);
}

async function refreshCatalog() {
  catalog = await api("/api/catalog");
  filesById = Object.fromEntries(catalog.files.map((f) => [f.id, f]));
  const empty = !catalog.files.length;
  $("#empty").classList.toggle("hidden", !empty);
  $("#timelineView").classList.toggle("hidden", empty || st.tab !== "timeline");
  $("#summaryView").classList.toggle("hidden", empty || st.tab !== "summary");
  fillPlaceSelect(); fillScopeSelect(); syncScopeUi();
}
const placeFiles = () => { const p = curPlace(); return p ? catalog.files.filter((f) => f.place === p) : catalog.files; };
const readyFiles = () => placeFiles().filter((f) => f.status === "done");
const readyDays = () => [...new Set(readyFiles().map((f) => f.day))];

function fillPlaceSelect() {
  const multi = multiPlace();
  $("#placeCtl").classList.toggle("hidden", !multi);
  $("#groupPlaceBtn").classList.toggle("hidden", !multi);
  $("#hmRowsCtl").classList.toggle("hidden", !multi);
  if (!multi && st.group === "place") { st.group = "day"; $$("#groupSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === st.group)); }
  if (!multi) return;
  if (st.place && !placeNames().includes(st.place)) { st.place = ""; save(); }
  const sel = $("#placeSelect");
  sel.innerHTML = `<option value="">All places (${catalog.places.length})</option>` +
    catalog.places.map((p) => `<option value="${esc(p.name)}">${esc(p.name)} · ${p.files} files</option>`).join("");
  sel.value = st.place;
}

function fillScopeSelect() {
  const sel = $("#scopeSelect");
  if (st.scope === "file") {
    // list every file (keeps the selection while files are being (re)analysed)
    const fs = placeFiles();
    if (!fs.find((f) => f.id === st.fileId)) st.fileId = (readyFiles()[0] || fs[0] || {}).id || null;
    const pre = (f) => (allPlacesView() ? `${esc(f.place)} · ` : "");
    sel.innerHTML = fs.map((f) => `<option value="${f.id}">${pre(f)}${fmtDay(f.start_epoch)} ${fmtClock(f.start_epoch, false)} · ${esc(f.name.split("/").pop())}${f.status === "done" ? "" : " (analysing…)"}</option>`).join("");
    sel.value = st.fileId || "";
  } else if (st.scope === "day") {
    const ds = [...new Set(placeFiles().map((f) => f.day))].sort();
    if (!ds.includes(st.day)) st.day = readyDays()[0] || ds[0] || null;
    sel.innerHTML = ds.map((d) => {
      const all = placeFiles().filter((f) => f.day === d).length;
      const n = readyFiles().filter((f) => f.day === d).length;
      return `<option value="${d}">${fmtDay(dayEpoch(d))} ${d.slice(0, 4)} · ${all} files${n < all ? ` (${n} analysed)` : ""}</option>`;
    }).join("");
    sel.value = st.day || "";
  }
}
function syncScopeUi() {
  const ovAvail = st.scope === "day" && !allPlacesView();  // overlay days = one place along time
  const ov = ovAvail && st.overlay;
  const cmp = compareMode();
  $("#scopePick").classList.toggle("hidden", st.scope === "all" || ov);
  $("#overlayCtl").classList.toggle("hidden", !ovAvail);
  $("#compareCtl").classList.toggle("hidden", !allPlacesView() || st.scope === "file");
  $("#metricCtl").classList.toggle("hidden", ov || cmp);
  $("#ovMetricCtl").classList.toggle("hidden", !(ov || cmp));
  $("#eventsCard").classList.toggle("hidden", ov);
  $("#specCtl").classList.toggle("hidden", ov || cmp);
}
const overlayActive = () => st.scope === "day" && st.overlay && !allPlacesView();
function stepScope(d) {
  const sel = $("#scopeSelect");
  const i = sel.selectedIndex + d;
  if (i < 0 || i >= sel.options.length) return;
  sel.selectedIndex = i; sel.dispatchEvent(new Event("change"));
}
function scopeParams() {
  if (st.scope === "file") return { scope: "file", id: st.fileId, place: curPlace() };
  if (st.scope === "day") return { scope: "day", id: st.day, place: curPlace() };
  return { scope: "all", id: null, place: curPlace() };
}

// ---------------------------------------------------------------- timeline
let loadSeq = 0;
async function loadTimeline(range) {
  if (!readyFiles().length) return;
  if (overlayActive()) return loadOverlay();
  const { scope, id } = scopeParams();
  if (scope !== "all" && !id) return;
  if (compareMode()) return loadCompare(range);
  const q = withPlace(new URLSearchParams({ scope, res: st.res, weighting: st.weighting }));
  if (id) q.set("id", id);
  if (range) { q.set("x0", range[0]); q.set("x1", range[1]); }
  const seq = ++loadSeq;
  let d;
  try { d = await api("/api/series?" + q); } catch (e) {
    $("#plotMsg").textContent = e.message.includes("Nothing analysed") ? "This selection is still being analysed - it will appear shortly." : e.message;
    return;
  }
  if (seq !== loadSeq) return;
  d.kind = "concat";
  current = d;
  $("#resNote").textContent = st.res === "auto" ? `(${resLabel(d.res)})` : "";
  $("#plotMsg").textContent = d.coarsened
    ? `Too many points at ${resLabel(d.requested_res)} for this span - showing ${resLabel(d.res)}. Zoom in for finer detail.`
    : d.res === 0.125 && st.metric === "band" ? "At 125 ms each bin is one frame, so there is no L10–L90 range." : "";
  const title = scope === "file" ? filesById[id]?.name : scope === "day" ? `${fmtDay(dayEpoch(id))} - all files` : "All recordings";
  const where = multiPlace() ? `${curPlace() || "All places, one after another"} · ` : "";
  $("#chartTitle").textContent = `${where}${title} · ${st.weighting}-weighted ${unit()}`;
  drawConcat(d, range);
  loadSpectro(range);
  if (!range) loadEvents();
}

async function loadCompare(range) {
  const { scope, id } = scopeParams();
  const q = new URLSearchParams({ scope, res: st.res, weighting: st.weighting, metric: st.ovMetric });
  if (id) q.set("id", id);
  if (range) { q.set("x0", range[0]); q.set("x1", range[1]); }
  const seq = ++loadSeq;
  let d;
  try { d = await api("/api/compare?" + q); } catch (e) { $("#plotMsg").textContent = e.message; return; }
  if (seq !== loadSeq) return;
  d.kind = "compare";
  current = d;
  $("#resNote").textContent = st.res === "auto" ? `(${resLabel(d.res)})` : "";
  $("#plotMsg").textContent = (d.coarsened ? `Too many points at ${resLabel(d.requested_res)} - showing ${resLabel(d.res)}. Zoom in for finer detail. ` : "") +
    (d.places.length > 8 ? "More than 8 places: colours repeat. " : "") +
    "Shared clock-time axis: recording periods of all places merged and laid end to end.";
  const name = $("#ovMetric").selectedOptions[0].textContent;
  const what = scope === "day" ? fmtDay(dayEpoch(id)) : "All recordings";
  $("#chartTitle").textContent = `Places compared · ${what} · ${name}` + (d.metric === "ndsi" ? "" : ` · ${st.weighting}-weighted ${unit()}`);
  $("#specWrap").classList.add("hidden");
  drawCompare(d, range);
  if (!range) loadEvents();
}

function drawCompare(d, range) {
  const ndsi = d.metric === "ndsi";
  const data = [d.x, ...d.values.map((v) => (ndsi ? v : shift(v)))];
  const key = `compare|${d.metric}|${d.places.join("|")}|${unit()}`;
  const xr = range ? { min: range[0], max: range[1] } : { min: 0, max: d.total };
  $("#ndsiWrap").classList.add("hidden");
  if (plots.main && plots.main._key === key) {
    suppressScale = true; plots.main.setData(data, true); plots.main.setScale("x", xr); suppressScale = false;
    return;
  }
  destroyPlots();
  const el = $("#mainPlot");
  plots.main = new uPlot({
    width: el.clientWidth, height: 360,
    scales: { x: { time: false }, ...(ndsi ? { y: { range: [-1, 1] } } : {}) },
    series: [{ label: "Time" }, ...d.places.map((p) => ({ label: p, stroke: placeColor(p), width: 1.5, spanGaps: false, points: { show: false } }))],
    axes: [concatXAxis(), yAxis(ndsi ? "NDSI" : unit(), ndsi ? { values: (u, s) => s.map((v) => v.toFixed(1)) } : {})],
    cursor: { drag: { x: true, y: false }, focus: { prox: 30 }, bind: { dblclick: () => () => { loadTimeline(); return null; } } },
    focus: { alpha: 0.3 },
    legend: { live: false },
    hooks: { draw: [drawSeparators, ...(ndsi ? [drawZero] : [drawThresholdLine])], setScale: [onScale], setCursor: [showTip] },
  }, data, el);
  plots.main._key = key;
  suppressScale = true; plots.main.setScale("x", xr); suppressScale = false;
  attachPlotUi(plots.main);
}

// concatenated x of a recorder-clock epoch (inverse of clockAt)
function xAtEpoch(ep) {
  for (const s of (current && current.segments) || []) {
    if (ep >= s.start_epoch - 1e-6 && ep <= s.start_epoch + (s.x1 - s.x0)) return s.x0 + (ep - s.start_epoch);
  }
  return null;
}

async function loadOverlay() {
  const q = withPlace(new URLSearchParams({ res: st.res, weighting: st.weighting, metric: st.ovMetric }));
  const seq = ++loadSeq;
  const d = await api("/api/overlay?" + q);
  if (seq !== loadSeq) return;
  d.kind = "overlay";
  current = d;
  $("#resNote").textContent = st.res === "auto" ? `(${resLabel(d.res)})` : "";
  $("#plotMsg").textContent = d.days.length > 8 ? "Showing the first 8 days (one color per day)." : "";
  const name = $("#ovMetric").selectedOptions[0].textContent;
  $("#chartTitle").textContent = `${curPlace() ? curPlace() + " · " : ""}Days overlaid by time of day · ${name}` + (d.metric === "ndsi" ? "" : ` · ${st.weighting}-weighted ${unit()}`);
  drawOverlay(d);
}

const shift = (a) => a.map((v) => (v == null ? null : v + off()));

function seriesSpec() {
  const c1 = css("--series-1"), c2 = css("--series-2"), c3 = css("--series-3");
  if (st.metric === "simple") return { keys: ["leq"], series: [{ label: "Leq", stroke: c1, width: 1.5 }] };
  if (st.metric === "band") return {
    keys: ["l10", "l90", "leq"],
    series: [
      { label: "L10–L90 range", stroke: css("--band-fill"), width: 0, points: { show: false } },
      { label: "L90 (background)", stroke: c2, width: 1.5 },
      { label: "Leq", stroke: c1, width: 1.5 },
    ],
    bands: [{ series: [1, 2], fill: css("--band-fill") }],
  };
  return {
    keys: ["anthro", "bio"],
    series: [
      { label: bandLabel("anthro"), stroke: c2, width: 1.5 },
      { label: bandLabel("bio"), stroke: c3, width: 1.5 },
    ],
  };
}

function clockAt(x) {
  const segs = current && current.segments; if (!segs || !segs.length) return null;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].x0 <= x) lo = m; else hi = m - 1; }
  const s = segs[lo];
  return { seg: s, epoch: s.start_epoch + Math.max(0, x - s.x0) };
}

const X_INCRS = [0.125, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];

function axisStyle() {
  return { stroke: css("--text-secondary"), grid: { stroke: css("--grid"), width: 1 }, ticks: { stroke: css("--axis"), width: 1 }, font: "12px system-ui, sans-serif" };
}

function concatXAxis() {
  return {
    ...axisStyle(), incrs: X_INCRS, space: 70, size: 44,
    // ticks on round clock times inside each file (x itself is concatenated time)
    splits: (u, ai, min, max, incr) => {
      const segs = (current && current.segments) || [];
      const minGap = ((max - min) / Math.max(1, u.bbox.width / (devicePixelRatio || 1))) * 55;
      const out = [];
      for (const s of segs) {
        if (s.x1 < min || s.x0 > max) continue;
        const a = Math.max(min, s.x0), b = Math.min(max, s.x1);
        let t = Math.ceil((s.start_epoch + (a - s.x0)) / incr - 1e-9) * incr;
        for (; s.x0 + (t - s.start_epoch) <= b; t += incr) {
          const x = s.x0 + (t - s.start_epoch);
          if (!out.length || x - out[out.length - 1] >= minGap) out.push(x);
        }
      }
      if (out.length < 2) {   // span too coarse for round clock ticks: use day starts
        const fb = [];
        let pd = null;
        for (const s of segs) {
          if (s.day !== pd && s.x0 >= min && s.x0 <= max && (!fb.length || s.x0 - fb[fb.length - 1] >= minGap)) fb.push(s.x0);
          pd = s.day;
        }
        if (fb.length > out.length) return fb;
      }
      return out;
    },
    values: (u, splits) => {
      const span = u.scales.x.max - u.scales.x.min;
      let prevDay = null;
      return splits.map((x) => {
        const c = clockAt(x); if (!c) return "";
        const day = fmtDay(c.epoch), t = fmtClock(c.epoch, span < 900);
        const showDay = day !== prevDay; prevDay = day;
        return showDay && (st.scope === "all" || splits.indexOf(x) === 0) ? `${t}\n${day}` : t;
      });
    },
  };
}

function yAxis(label, fixed) {
  return { ...axisStyle(), label, labelSize: 18, labelFont: "12px system-ui, sans-serif", size: 52, ...(fixed || {}) };
}

function drawConcat(d, range) {
  const spec = seriesSpec();
  const x = d.x;
  const data = [x, ...spec.keys.map((k) => shift(d[k]))];
  const key = `concat|${st.metric}|${unit()}`;
  const xr = range ? { min: range[0], max: range[1] } : { min: 0, max: d.total };
  if (plots.main && plots.main._key === key) {
    suppressScale = true;
    plots.main.setData(data, true);
    plots.main.setScale("x", xr);
    suppressScale = false;
  } else {
    destroyPlots();
    const el = $("#mainPlot");
    const opts = {
      width: el.clientWidth, height: 360,
      scales: { x: { time: false } },
      series: [{ label: "Time" }, ...spec.series.map((s) => ({ spanGaps: false, points: { show: false }, ...s }))],
      bands: spec.bands,
      axes: [concatXAxis(), yAxis(unit())],
      cursor: { drag: { x: true, y: false }, sync: { key: "slp" }, bind: { dblclick: () => () => { loadTimeline(); return null; } } },
      legend: { live: false },
      hooks: {
        drawClear: [drawThresholdShade],
        draw: [drawSeparators, drawThresholdLine],
        setScale: [onScale],
        setCursor: [showTip],
      },
    };
    plots.main = new uPlot(opts, data, el);
    plots.main._key = key;
    suppressScale = true; plots.main.setScale("x", xr); suppressScale = false;
    attachPlotUi(plots.main);
  }
  // NDSI sub-plot (bands mode) - its own chart, never a second y-axis
  $("#ndsiWrap").classList.toggle("hidden", st.metric !== "bands");
  if (st.metric === "bands") {
    const nd = [x, d.ndsi];
    if (plots.ndsi) { suppressScale = true; plots.ndsi.setData(nd, true); plots.ndsi.setScale("x", xr); suppressScale = false; }
    else {
      const el = $("#ndsiPlot");
      plots.ndsi = new uPlot({
        width: el.clientWidth, height: 150,
        scales: { x: { time: false }, y: { range: [-1, 1] } },
        series: [{}, { label: "NDSI", stroke: css("--text-secondary"), width: 1.25, fill: ndsiFill, fillTo: 0, points: { show: false } }],
        axes: [concatXAxis(), yAxis("NDSI", { values: (u, s) => s.map((v) => v.toFixed(1)) })],
        cursor: { drag: { x: false, y: false }, sync: { key: "slp" } },
        legend: { show: false },
        hooks: { draw: [drawSeparators, drawZero], setCursor: [showTip] },
      }, nd, el);
      suppressScale = true; plots.ndsi.setScale("x", xr); suppressScale = false;
      attachPlotUi(plots.ndsi);
    }
  } else if (plots.ndsi) { plots.ndsi.destroy(); plots.ndsi = null; }
}

function drawOverlay(d) {
  destroyPlots();
  $("#ndsiWrap").classList.add("hidden");
  $("#specWrap").classList.add("hidden");
  const days = d.days.slice(0, 8);
  const ndsi = d.metric === "ndsi";
  const data = [d.x, ...days.map((_, i) => (ndsi ? d.values[i] : shift(d.values[i])))];
  const el = $("#mainPlot");
  plots.main = new uPlot({
    width: el.clientWidth, height: 360,
    scales: { x: { time: false }, ...(ndsi ? { y: { range: [-1, 1] } } : {}) },
    series: [{ label: "Time of day" }, ...days.map((day, i) => ({
      label: fmtDay(dayEpoch(day)), stroke: css(`--series-${i + 1}`), width: 1.5, spanGaps: true, points: { show: false },
    }))],
    axes: [
      { ...axisStyle(), incrs: X_INCRS, space: 70, values: (u, s) => s.map((v) => fmtTod(v, u.scales.x.max - u.scales.x.min < 900)) },
      yAxis(ndsi ? "NDSI" : unit()),
    ],
    cursor: { drag: { x: true, y: false }, focus: { prox: 30 } },
    focus: { alpha: 0.3 },
    legend: { live: false },
    hooks: { draw: [drawThresholdLine, ...(ndsi ? [drawZero] : [])], setCursor: [showTip] },
  }, data, el);
  plots.main._key = "overlay";
  attachPlotUi(plots.main);
  $("#eventsList").innerHTML = "";
}

function destroyPlots() {
  for (const k of Object.keys(plots)) if (plots[k]) { plots[k].destroy(); plots[k] = null; }
}
function rebuildPlots() { destroyPlots(); refreshView(); }
function resizePlots() {
  const els = { main: "#mainPlot", ndsi: "#ndsiPlot", spec: "#specPlot" };
  for (const k of Object.keys(els)) {
    const p = plots[k]; if (!p) continue;
    p.setSize({ width: $(els[k]).clientWidth, height: p.height });
  }
  if (plots.spec) loadSpectro([plots.spec.scales.x.min, plots.spec.scales.x.max]);
  if (st.tab === "summary") loadSummary();
}

// zoom -> refetch the visible range at a finer resolution
function onScale(u, key) {
  if (key !== "x" || suppressScale || u._key === "overlay") return;
  const { min, max } = u.scales.x;
  suppressScale = true;
  for (const p of [plots.main, plots.ndsi, plots.spec]) if (p && p !== u) p.setScale("x", { min, max });
  suppressScale = false;
  clearTimeout(onScale._t);
  onScale._t = setTimeout(() => loadTimeline([min, max]), 200);
}

// ---- canvas decorations
function drawSeparators(u) {
  if (!current || (current.kind !== "concat" && current.kind !== "compare")) return;
  const { ctx, bbox } = u, dpr = devicePixelRatio || 1;
  const { min, max } = u.scales.x;
  ctx.save();
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = "top"; ctx.textAlign = "left";
  let prevDay = null, prevPlace, lastLabelX = -1e9;
  const showLabels = u === plots.main;
  const places = current.kind === "concat" && new Set(current.segments.map((s) => s.place)).size > 1;
  for (const s of current.segments) {
    const newPlace = places && s.place !== prevPlace; prevPlace = s.place;
    const newDay = s.day !== prevDay || newPlace; prevDay = s.day;
    if (s.x1 < min || s.x0 > max) continue;
    const px = Math.round(u.valToPos(Math.max(s.x0, min), "x", true));
    const pxPerSeg = ((s.x1 - s.x0) / (max - min)) * bbox.width;
    if (s.x0 >= min && s.x0 > 0 && (newDay || pxPerSeg > 8 * dpr)) {
      ctx.strokeStyle = newPlace ? placeColor(s.place) : newDay ? css("--text-secondary") : css("--axis");
      ctx.lineWidth = (newPlace ? 3 : newDay ? 2 : 1) * dpr;
      ctx.setLineDash(newDay ? [] : [4 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(px, bbox.top); ctx.lineTo(px, bbox.top + bbox.height); ctx.stroke();
    }
    if (showLabels && (s.x0 >= min || newPlace)) {
      const segW = u.valToPos(Math.min(s.x1, max), "x", true) - px;
      let lbl = newDay && st.scope === "all" ? `${fmtDay(s.start_epoch)} ${fmtClock(s.start_epoch, false)}` : fmtClock(s.start_epoch, false);
      if (newPlace) lbl = `${s.place} · ${lbl}`;
      if ((segW > 46 * dpr || newPlace) && px - lastLabelX > 60 * dpr && px >= bbox.left) {
        ctx.fillStyle = newPlace ? placeColor(s.place) : newDay ? css("--text-primary") : css("--text-muted");
        ctx.fillText(lbl, px + 4 * dpr, bbox.top + 3 * dpr);
        lastLabelX = px;
      }
    }
  }
  ctx.restore();
}

function thrValueKey() { return st.metric === "bands" ? null : "leq"; }
function drawThresholdShade(u) {
  if (!st.thrOn || !current || current.kind !== "concat" || u !== plots.main) return;
  const k = thrValueKey(); if (!k) return;
  const vals = current[k], xs = current.x, thr = st.thr - off();
  const { ctx, bbox } = u;
  ctx.save();
  ctx.fillStyle = css("--serious"); ctx.globalAlpha = 0.22;
  const step = current.res;
  let runStart = null;
  const flush = (endX) => {
    if (runStart == null) return;
    const a = u.valToPos(runStart, "x", true), b = u.valToPos(endX, "x", true);
    ctx.fillRect(a, bbox.top, Math.max(1, b - a), bbox.height); runStart = null;
  };
  for (let i = 0; i < xs.length; i++) {
    const v = vals[i];
    if (v != null && v > thr) { if (runStart == null) runStart = xs[i]; }
    else flush(xs[i]);
  }
  if (xs.length) flush(xs[xs.length - 1] + step);
  ctx.restore();
}
function drawThresholdLine(u) {
  if (!st.thrOn) return;
  if (current && current.kind === "overlay" && current.metric === "ndsi") return;
  const y = u.valToPos(Number(st.thr), "y", true);
  const { ctx, bbox } = u, dpr = devicePixelRatio || 1;
  if (y < bbox.top || y > bbox.top + bbox.height) return;
  ctx.save();
  ctx.strokeStyle = css("--serious"); ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(bbox.left, y); ctx.lineTo(bbox.left + bbox.width, y); ctx.stroke();
  ctx.fillStyle = css("--text-secondary"); ctx.font = `${11 * dpr}px system-ui, sans-serif`; ctx.textAlign = "right";
  ctx.fillText(`threshold ${st.thr} ${unit()}`, bbox.left + bbox.width - 4 * dpr, y - 4 * dpr);
  ctx.restore();
}
function drawZero(u) {
  const y = u.valToPos(0, "y", true), { ctx, bbox } = u;
  ctx.save(); ctx.strokeStyle = css("--axis"); ctx.lineWidth = devicePixelRatio || 1;
  ctx.beginPath(); ctx.moveTo(bbox.left, y); ctx.lineTo(bbox.left + bbox.width, y); ctx.stroke(); ctx.restore();
}
function ndsiFill(u) {
  const { ctx, bbox } = u;
  const y0 = u.valToPos(0, "y", true);
  const g = ctx.createLinearGradient(0, bbox.top, 0, bbox.top + bbox.height);
  const stop = Math.min(1, Math.max(0, (y0 - bbox.top) / bbox.height));
  const pos = hexA(css("--series-3"), 0.35), neg = hexA(css("--series-2"), 0.35);
  g.addColorStop(0, pos); g.addColorStop(stop, pos); g.addColorStop(stop, neg); g.addColorStop(1, neg);
  return g;
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---- tooltip, click-to-play, playhead
let hoverPlot = null;
function showTip(u) {
  if (u !== hoverPlot) return;
  const tip = $("#tooltip");
  const idx = u.cursor.idx;
  if (idx == null || u.cursor.left < 0 || !current) { tip.classList.add("hidden"); return; }
  const x = u.data[0][idx];
  let head;
  if (current.kind === "overlay") head = fmtTod(x, true);
  else {
    const c = clockAt(x); if (!c) return;
    head = `${fmtDay(c.epoch)} ${fmtClock(c.epoch)} · ${resLabel(current.res)} bin`;
    if (current.kind === "concat" && multiPlace() && c.seg.place) head = `${esc(c.seg.place)}<br>${head}`;
  }
  const rows = [];
  const src = u === plots.ndsi ? [[1, "NDSI"]] : u.series.slice(1).map((s, i) => [i + 1, s.label]);
  for (const [i, label] of src) {
    const s = u.series[i]; if (!s.show) continue;
    const v = u.data[i][idx];
    const isNd = label === "NDSI" || (current.kind !== "concat" && current.metric === "ndsi");
    const sw = s.stroke && typeof s.stroke === "function" ? s.stroke(u, i) : s.stroke;
    rows.push(`<div class="r"><span class="sw" style="background:${sw}"></span>${label === "L10–L90 range" ? "L10" : esc(label)}<b>${v == null ? "–" : isNd ? v.toFixed(2) : v.toFixed(1)}</b></div>`);
  }
  if (current.kind === "concat" && u === plots.main && st.metric !== "bands") {
    const l50 = current.l50[idx], lmax = current.lmax[idx];
    if (l50 != null) rows.push(`<div class="r"><span class="sw"></span>L50<b>${fmtDb(l50)}</b></div>`);
    if (lmax != null) rows.push(`<div class="r"><span class="sw"></span>Lmax (125 ms)<b>${fmtDb(lmax)}</b></div>`);
  }
  tip.innerHTML = `<div class="t">${head}</div>${rows.join("")}`;
  const r = u.over.getBoundingClientRect();
  const px = r.left + u.cursor.left, py = r.top + u.cursor.top;
  tip.classList.remove("hidden");
  const w = tip.offsetWidth;
  tip.style.left = (px + 14 + w > innerWidth ? px - 14 - w : px + 14) + "px";
  tip.style.top = Math.max(8, py - 10) + "px";
}

function attachPlotUi(u) {
  const over = u.over;
  over.addEventListener("mouseenter", () => { hoverPlot = u; });
  over.addEventListener("mouseleave", () => { if (hoverPlot === u) hoverPlot = null; $("#tooltip").classList.add("hidden"); });
  let down = null;
  over.addEventListener("mousedown", (e) => { down = [e.clientX, e.clientY]; });
  over.addEventListener("mouseup", (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down[0], e.clientY - down[1]); down = null;
    if (moved > 4) return;
    const x = u.posToVal(e.offsetX, "x");
    if (current.kind === "concat") {
      const c = clockAt(x); if (!c) return;
      playAt(c.seg.file_id, Math.max(0, x - c.seg.x0));
    } else {
      // overlay / compare: pick the line closest to the click
      const idx = u.posToIdx(e.offsetX), yv = u.posToVal(e.offsetY, "y");
      let best = null;
      u.series.forEach((s, i) => {
        if (!i || !s.show) return;
        const v = u.data[i][idx]; if (v == null) return;
        if (!best || Math.abs(v - yv) < best.d) best = { d: Math.abs(v - yv), i: i - 1 };
      });
      if (!best) return;
      if (current.kind === "overlay") playDayTod(current.days[best.i], x, curPlace());
      else {
        const c = clockAt(x); if (!c) return;
        const place = current.places[best.i];
        const f = catalog.files.find((f) => f.place === place && c.epoch >= f.start_epoch && c.epoch < f.start_epoch + f.duration);
        if (!f) return toast(`No recording at ${place} at that time`);
        playAt(f.id, c.epoch - f.start_epoch);
      }
    }
  });
  const ph = document.createElement("div"); ph.className = "playhead"; over.appendChild(ph); u._ph = ph;
}

// day null = first day with a recording at that time of day
function playDayTod(day, tod, place) {
  const f = catalog.files.find((f) => (!day || f.day === day) && (!place || f.place === place) && tod >= todOf(f) && tod < todOf(f) + f.duration);
  if (!f) return toast("No recording at that time");
  playAt(f.id, tod - todOf(f));
}
const todOf = (f) => f.start_epoch - dayEpoch(f.day);

// ---------------------------------------------------------------- spectrogram
let specSeq = 0;
async function loadSpectro(range) {
  const wrap = $("#specWrap");
  if (!st.specOn || !current || current.kind !== "concat") { wrap.classList.add("hidden"); return; }
  wrap.classList.remove("hidden");
  const { scope, id } = scopeParams();
  const width = Math.round($("#specPlot").clientWidth - 60) || 1000;
  const q = withPlace(new URLSearchParams({ scope, cols: Math.max(100, width) }));
  if (id) q.set("id", id);
  const xr = range || [0, current.total];
  q.set("x0", xr[0]); q.set("x1", xr[1]);
  const seq = ++specSeq;
  $("#specNote").textContent = "loading…";
  let d;
  try { d = await api("/api/spectrogram?" + q); } catch (e) { $("#specNote").textContent = e.message; return; }
  if (seq !== specSeq) return;
  const raw = atob(d.data), bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  d.bytes = bytes;
  // auto contrast: 2nd..99.8th percentile of the shown values
  const hist = new Uint32Array(256); let n = 0;
  for (const b of bytes) if (b) { hist[b]++; n++; }
  const pct = (p) => { let c = 0; for (let i = 1; i < 256; i++) { c += hist[i]; if (c >= p * n) return i; } return 255; };
  d.qlo = pct(0.25); d.qhi = Math.max(d.qlo + 1, pct(0.999));
  d.toDb = (b) => d.vmin + ((b - 1) / 254) * (d.vmax - d.vmin);
  spec = d;
  buildSpecImage();
  const span = d.x1 - d.x0;
  $("#specNote").textContent = d.mode === "detail"
    ? `Detailed: 2048-pt FFT (~${Math.round(filesById[readyFiles()[0].id].samplerate / 2048)} Hz resolution) · darker = louder`
    : `Overview: per-second 1/6-octave spectrum · zoom below ${d.detail_max_span / 60} min for full detail · darker = louder`;
  if (document.documentElement.matches(":root[data-theme=dark]") || (st.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches))
    $("#specNote").textContent = $("#specNote").textContent.replace("darker = louder", "brighter = louder");
  drawSpectro([d.x0, d.x1], span);
}

function buildSpecImage() {
  const d = spec; if (!d) return;
  const stops = seqStops();
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 1; i < 256; i++) {
    const t = Math.min(1, Math.max(0, (i - d.qlo) / (d.qhi - d.qlo)));
    const m = lerpColor(stops, t).match(/\d+/g).map(Number);
    lut.set([m[0], m[1], m[2], 255], i * 4);
  }
  const cv = document.createElement("canvas");
  cv.width = d.cols; cv.height = d.rows;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(d.cols, d.rows);
  for (let r = 0; r < d.rows; r++) {
    const dst = (d.rows - 1 - r) * d.cols; // canvas row 0 = highest frequency
    for (let c = 0; c < d.cols; c++) img.data.set(lut.subarray(d.bytes[r * d.cols + c] * 4, d.bytes[r * d.cols + c] * 4 + 4), (dst + c) * 4);
  }
  ctx.putImageData(img, 0, 0);
  d.canvas = cv;
}

function specYAxis() {
  const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  return yAxis("Hz", {
    grid: { show: false },
    filter: (u, sp) => sp,
    splits: (u, ai, min, max) => (st.fscale === "log" ? ticks.filter((t) => t >= min && t <= max)
      : [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000, 22000].filter((t) => t >= min && t <= max)),
    values: (u, sp) => sp.map((v) => (v >= 1000 ? `${v / 1000}k` : `${v}`)),
  });
}

function drawSpectro(xr) {
  if (!spec || !current || current.kind !== "concat") return;
  xr = xr || [spec.x0, spec.x1];
  const fmin = st.fscale === "log" ? spec.edges[0] : 0, fmax = spec.edges[spec.edges.length - 1];
  if (plots.spec) {
    suppressScale = true; plots.spec.setScale("x", { min: xr[0], max: xr[1] }); suppressScale = false;
    plots.spec.redraw(false);
    return;
  }
  const el = $("#specPlot");
  plots.spec = new uPlot({
    width: el.clientWidth, height: 240,
    scales: { x: { time: false }, y: st.fscale === "log" ? { distr: 3, log: 10, range: [fmin, fmax] } : { range: [fmin, fmax] } },
    series: [{}, { label: "", stroke: "transparent", points: { show: false } }],
    axes: [{ ...concatXAxis(), grid: { show: false } }, specYAxis()],
    cursor: { drag: { x: true, y: false }, sync: { key: "slp" }, points: { show: false },
      bind: { dblclick: () => () => { loadTimeline(); return null; } } },
    legend: { show: false },
    hooks: { drawClear: [drawSpecImage], draw: [drawSeparators, drawBandLines], setScale: [onScale], setCursor: [specTip] },
  }, [[xr[0], xr[1]], [fmin, fmax]], el);
  plots.spec._key = "spec";
  suppressScale = true; plots.spec.setScale("x", { min: xr[0], max: xr[1] }); suppressScale = false;
  attachPlotUi(plots.spec);
}

function drawSpecImage(u) {
  const d = spec; if (!d || !d.canvas) return;
  const { ctx, bbox } = u;
  ctx.save();
  ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();
  ctx.imageSmoothingEnabled = false;
  const xa = u.valToPos(d.x0, "x", true), xb = u.valToPos(d.x1, "x", true);
  for (let r = 0; r < d.rows; r++) {
    const lo = Math.max(d.edges[r], u.scales.y.min), hi = d.edges[r + 1];
    if (hi <= u.scales.y.min) continue;
    const yTop = u.valToPos(hi, "y", true), yBot = u.valToPos(lo, "y", true);
    ctx.drawImage(d.canvas, 0, d.rows - 1 - r, d.cols, 1, xa, yTop, xb - xa, Math.max(1, yBot - yTop));
  }
  ctx.restore();
}

function drawBandLines(u) {
  const { ctx, bbox } = u, dpr = devicePixelRatio || 1;
  ctx.save();
  ctx.font = `${11 * dpr}px system-ui, sans-serif`; ctx.textAlign = "right";
  const lines = [[bands.anthro[0], "--series-2", ""], [bands.anthro[1], "--series-2", bandLabel("anthro")],
    [bands.bio[0], "--series-3", ""], [bands.bio[1], "--series-3", bandLabel("bio")]];
  for (const [f, col, label] of lines) {
    if (f < u.scales.y.min || f > u.scales.y.max) continue;
    const y = Math.round(u.valToPos(f, "y", true));
    ctx.strokeStyle = css(col); ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(bbox.left, y); ctx.lineTo(bbox.left + bbox.width, y); ctx.stroke();
    if (label) {
      const w = ctx.measureText(label).width;
      ctx.fillStyle = hexA(css("--surface-1"), 0.8);
      ctx.fillRect(bbox.left + bbox.width - w - 8 * dpr, y - 15 * dpr, w + 6 * dpr, 13 * dpr);
      ctx.fillStyle = css("--text-primary");
      ctx.fillText(label, bbox.left + bbox.width - 5 * dpr, y - 4 * dpr);
    }
  }
  ctx.restore();
}

function specTip(u) {
  if (u !== hoverPlot) return;
  const tip = $("#tooltip"), d = spec;
  if (!d || u.cursor.left == null || u.cursor.left < 0) { tip.classList.add("hidden"); return; }
  const x = u.posToVal(u.cursor.left, "x"), f = u.posToVal(u.cursor.top, "y");
  const c = clockAt(x); if (!c) return;
  const col = Math.floor(((x - d.x0) / (d.x1 - d.x0)) * d.cols);
  let row = d.edges.findIndex((e) => e > f) - 1; if (row < 0) row = d.rows - 1;
  const b = col >= 0 && col < d.cols ? d.bytes[row * d.cols + col] : 0;
  tip.innerHTML = `<div class="t">${fmtDay(c.epoch)} ${fmtClock(c.epoch)}</div>` +
    `<div class="r">Frequency<b>${fmtHz(f)}</b></div>` +
    `<div class="r">PSD<b>${b ? d.toDb(b).toFixed(1) + " dB/Hz" : "–"}</b></div>`;
  const r = u.over.getBoundingClientRect();
  const px = r.left + u.cursor.left, py = r.top + u.cursor.top;
  tip.classList.remove("hidden");
  const w = tip.offsetWidth;
  tip.style.left = (px + 14 + w > innerWidth ? px - 14 - w : px + 14) + "px";
  tip.style.top = Math.max(8, py - 10) + "px";
}

// ---------------------------------------------------------------- bands settings
function updateBandLabels() {
  $("#bandsLabel").textContent = `${fmtHzRange(bands.anthro)} / ${fmtHzRange(bands.bio)}`;
  for (const sel of ["#ovMetric", "#hmMetric"]) {
    $(`${sel} option[value=anthro]`).textContent = bandLabel("anthro");
    $(`${sel} option[value=bio]`).textContent = bandLabel("bio");
  }
  $('#metricSeg button[data-v="bands"]').title = `${bandLabel("anthro")} vs ${bandLabel("bio")} + NDSI`;
  if (plots.main && plots.main._key && plots.main._key.startsWith("concat|bands")) { destroyPlots(); }
}

function initBands() {
  const pop = $("#bandsPop");
  const fill = (b) => { $("#anLo").value = b.anthro[0]; $("#anHi").value = b.anthro[1]; $("#bioLo").value = b.bio[0]; $("#bioHi").value = b.bio[1]; };
  $("#bandsBtn").addEventListener("click", () => { fill(bands); $("#bandsErr").textContent = ""; pop.classList.toggle("hidden"); });
  $("#bandsCancel").addEventListener("click", () => pop.classList.add("hidden"));
  pop.querySelectorAll("[data-p]").forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.p.split(",").map(Number); fill({ anthro: v.slice(0, 2), bio: v.slice(2) });
  }));
  document.addEventListener("mousedown", (e) => { if (!e.target.closest(".pop-anchor")) pop.classList.add("hidden"); });
  $("#bandsApply").addEventListener("click", async () => {
    const v = ["#anLo", "#anHi", "#bioLo", "#bioHi"].map((id) => Number($(id).value));
    if (v.some((x) => !(x >= 0)) || v[0] >= v[1] || v[2] >= v[3]) { $("#bandsErr").textContent = "Each band needs low < high"; return; }
    try {
      await post("/api/bands", { anthro: v.slice(0, 2), bio: v.slice(2) });
      pop.classList.add("hidden");
      bands = { anthro: v.slice(0, 2), bio: v.slice(2) }; updateBandLabels();
      lastDone = -1; destroyPlots(); pollStatus();
      toast("Re-analysing with the new bands…", 3000);
    } catch (e) { $("#bandsErr").textContent = e.message; }
  });
  updateBandLabels();
}

// ---------------------------------------------------------------- loudest events
async function loadEvents() {
  const { scope, id } = scopeParams();
  const q = withPlace(new URLSearchParams({ scope, weighting: st.weighting, n: 20 }));
  if (id) q.set("id", id);
  let ev;
  try { ev = await api("/api/events?" + q); } catch { return; }
  const showPlace = multiPlace();
  $("#eventsList").innerHTML = ev.map((e, i) =>
    `<li data-i="${i}"><span class="rank">${i + 1}</span><span class="lvl">${fmtDb(e.level)} ${unit()}</span>` +
    `<span>${fmtDay(e.clock_epoch)} ${fmtClock(e.clock_epoch)}</span>${showPlace ? placeChip(e.place) : ""}` +
    `<span class="file" title="${esc(e.name)}">${esc(e.name.split("/").pop())}</span></li>`).join("");
  $$("#eventsList li").forEach((li) => li.addEventListener("click", () => {
    const e = ev[+li.dataset.i];
    playAt(e.file_id, Math.max(0, e.offset - 2));
    const x = current && current.kind === "compare" ? xAtEpoch(e.clock_epoch) : e.x;
    if (x == null) return;
    const span = 60;
    loadTimeline([Math.max(0, x - span), x + span]);
  }));
}

// ---------------------------------------------------------------- player
const audio = new Audio();
audio.preload = "metadata";
let playing = { fileId: null };

function initPlayer() {
  $("#playBtn").addEventListener("click", togglePlay);
  $("#backBtn").addEventListener("click", () => { if (playing.fileId) audio.currentTime = Math.max(0, audio.currentTime - 10); });
  $("#fwdBtn").addEventListener("click", () => { if (playing.fileId) audio.currentTime += 10; });
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); togglePlay(); }
  });
  audio.addEventListener("play", () => { $("#playBtn").textContent = "❚❚"; tick(); });
  audio.addEventListener("pause", () => { $("#playBtn").textContent = "▶"; });
  audio.addEventListener("ended", () => {
    const fs = catalog.files, i = fs.findIndex((f) => f.id === playing.fileId);
    if (i >= 0 && i + 1 < fs.length && fs[i + 1].place === fs[i].place) playAt(fs[i + 1].id, 0);
  });
  audio.addEventListener("error", () => toast("Could not play this file in the browser"));
}
function togglePlay() {
  if (!playing.fileId) return toast("Click on a plot to choose where to listen");
  audio.paused ? audio.play() : audio.pause();
}
function playAt(fid, offset) {
  const go = () => { audio.currentTime = offset; audio.play().catch(() => {}); };
  if (playing.fileId === fid && audio.readyState >= 1) go();
  else {
    playing.fileId = fid;
    audio.src = `/api/audio/${fid}`;
    audio.addEventListener("loadedmetadata", go, { once: true });
  }
  updateNow();
}
function updateNow() {
  const f = filesById[playing.fileId]; if (!f) return;
  const ep = f.start_epoch + audio.currentTime;
  $("#nowTime").textContent = `${fmtDay(ep)} ${fmtClock(ep)}`;
  $("#nowFile").textContent = `${multiPlace() ? f.place + " · " : ""}${f.name.split("/").pop()} · ${fmtTod(audio.currentTime, true)} / ${fmtTod(f.duration, true)}`;
  // playhead
  for (const p of [plots.main, plots.ndsi, plots.spec]) {
    if (!p || !p._ph || !current) continue;
    let x = null;
    if (current.kind === "concat") {
      const s = current.segments.find((s) => s.file_id === f.id);
      if (s) x = s.x0 + audio.currentTime;
    } else if (current.kind === "compare") x = xAtEpoch(ep);
    else if (!curPlace() || f.place === curPlace()) x = todOf(f) + audio.currentTime;
    const { min, max } = p.scales.x;
    if (x == null || x < min || x > max) { p._ph.style.display = "none"; continue; }
    p._ph.style.display = "block";
    p._ph.style.left = p.valToPos(x, "x") + "px";
  }
}
function tick() { updateNow(); if (!audio.paused) requestAnimationFrame(tick); }

// ---------------------------------------------------------------- summary view
let sumRows = [], sumSort = { key: null, asc: true };

async function loadSummary() {
  if (!readyFiles().length) return;
  const q = withPlace(new URLSearchParams({ group: st.group, weighting: st.weighting }));
  if (st.thrOn) q.set("threshold", st.thr - off());
  const hq = withPlace(new URLSearchParams({ metric: st.hmMetric, weighting: st.weighting, slot: st.hmSlot,
    rows: multiPlace() ? st.hmRows : "day" }));
  const [rows, hm] = await Promise.all([api("/api/summary?" + q), api("/api/heatmap?" + hq)]);
  sumRows = rows;
  renderHeatmap(hm);
  renderRange(rows);
  renderTable();
}

function lerpColor(stops, t) {
  t = Math.min(1, Math.max(0, t));
  const p = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), f = p - i;
  const a = parseInt(stops[i].slice(1), 16), b = parseInt(stops[i + 1].slice(1), 16);
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - f) + ((b >> s) & 255) * f);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
const seqStops = () => css("--seq").split(",").map((s) => s.trim());

function renderHeatmap(hm) {
  const el = $("#heatmap");
  const rows = hm.rows;
  const placeRows = rows.some((r) => !r.day);                 // one "typical day" row per place
  const groups = !placeRows && new Set(rows.map((r) => r.place)).size > 1;  // place headers
  $("#hmNote").textContent = placeRows ? "Place × time of day (all days pooled) · click a cell to play"
    : groups ? "Place · day × time of day · click a cell to play" : "Day × time of day · click a cell to play";
  const rowText = (r) => (placeRows ? r.label : fmtDay(dayEpoch(r.day)));
  const W = el.clientWidth || 900, top = 6, rowH = 30, hdrH = 22, axisH = 28, legendH = 34;
  const labelW = placeRows ? Math.min(240, Math.max(64, 40 + 7 * Math.max(...rows.map((r) => r.label.length)))) : 64;
  const nC = hm.slots.length;
  if (!nC) { el.innerHTML = '<p class="muted">No data yet</p>'; return; }
  const cw = (W - labelW - 8) / nC;
  // vertical layout: optional place header, then its rows
  const ys = []; let yy = top, prevP;
  rows.forEach((r, i) => { if (groups && r.place !== prevP) { yy += hdrH; prevP = r.place; } ys[i] = yy; yy += rowH; });
  const gridBottom = yy;
  const H = gridBottom + axisH + legendH;
  const vals = hm.values.flat().filter((v) => v != null);
  const nd = hm.metric === "ndsi";
  const lo = nd ? -1 : Math.min(...vals), hi = nd ? 1 : Math.max(...vals);
  const color = (v) => {
    if (v == null) return "transparent";
    if (nd) { // diverging: red (anthro-dominated) <-> gray <-> blue
      return v < 0 ? lerpColor([css("--div-mid"), css("--div-neg")], -v) : lerpColor([css("--div-mid"), css("--div-pos")], v);
    }
    return lerpColor(seqStops(), (v - lo) / (hi - lo || 1));
  };
  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Heatmap of ${hm.metric} by ${placeRows ? "place" : "day"} and time of day">`;
  prevP = undefined;
  rows.forEach((row, r) => {
    if (groups && row.place !== prevP) {
      prevP = row.place;
      s += `<circle cx="8" cy="${ys[r] - hdrH / 2 + 1}" r="4" fill="${placeColor(row.place)}"/>` +
        `<text x="16" y="${ys[r] - hdrH / 2 + 5}" font-size="12" font-weight="600" fill="${css("--text-primary")}">${esc(row.place)}</text>`;
    }
    const sw = placeRows && multiPlace() ? `<circle cx="8" cy="${ys[r] + rowH / 2}" r="4" fill="${placeColor(row.place)}"/>` : "";
    const lbl = rowText(row), maxCh = Math.floor((labelW - (sw ? 26 : 8)) / 7);
    s += sw + `<text x="${labelW - 8}" y="${ys[r] + rowH / 2 + 4}" text-anchor="end" font-size="12" fill="${css("--text-secondary")}"><title>${esc(lbl)}</title>${esc(lbl.length > maxCh ? lbl.slice(0, maxCh - 1) + "…" : lbl)}</text>`;
    hm.values[r].forEach((v, c) => {
      if (v == null) return;
      s += `<rect class="cell" data-r="${r}" data-c="${c}" x="${labelW + c * cw + 0.5}" y="${ys[r] + 1}" width="${Math.max(1, cw - 1)}" height="${rowH - 2}" rx="2" fill="${color(v)}"/>`;
    });
  });
  // x ticks: every hour (or fewer)
  const y0 = gridBottom + 16;
  let lastX = -1e9;
  hm.slots.forEach((t, c) => {
    if (t % 1800 !== 0) return;
    const x = labelW + c * cw;
    if (x - lastX < 48) return; lastX = x;
    s += `<text x="${x}" y="${y0}" font-size="11" fill="${css("--text-muted")}">${fmtTod(t)}</text>`;
  });
  // legend
  const ly = gridBottom + axisH + 4, lw = Math.min(260, W - labelW - 120);
  s += `<defs><linearGradient id="hmg">` +
    (nd ? [0, 0.5, 1].map((p) => `<stop offset="${p}" stop-color="${color(-1 + 2 * p)}"/>`).join("")
        : seqStops().map((c, i, a) => `<stop offset="${i / (a.length - 1)}" stop-color="${c}"/>`).join("")) +
    `</linearGradient></defs>`;
  s += `<rect x="${labelW}" y="${ly}" width="${lw}" height="10" rx="2" fill="url(#hmg)"/>`;
  const fv = (v) => (nd ? v.toFixed(1) : (v + off()).toFixed(0));
  s += `<text x="${labelW}" y="${ly + 24}" font-size="11" fill="${css("--text-secondary")}">${fv(lo)}${nd ? " human noise" : ""}</text>`;
  s += `<text x="${labelW + lw}" y="${ly + 24}" font-size="11" text-anchor="end" fill="${css("--text-secondary")}">${fv(hi)} ${nd ? "biophony" : unit()}</text>`;
  s += `</svg>`;
  el.innerHTML = s;
  el.querySelectorAll("rect.cell").forEach((rc) => {
    const r = +rc.dataset.r, c = +rc.dataset.c, v = hm.values[r][c], t = hm.slots[c], row = rows[r];
    const head = placeRows ? `${esc(row.label)} · typical day` : `${multiPlace() && row.place ? esc(row.place) + " · " : ""}${fmtDay(dayEpoch(row.day))}`;
    rc.addEventListener("mousemove", (e) => tipAt(e, `<div class="t">${head} ${fmtTod(t)}–${fmtTod(t + hm.slot)}</div>` +
      `<div class="r">${$("#hmMetric").selectedOptions[0].textContent}<b>${nd ? v.toFixed(2) : fmtDb(v) + " " + unit()}</b></div>`));
    rc.addEventListener("mouseleave", hideTip);
    rc.addEventListener("click", () => playDayTod(row.day, t + 1, row.place));
    rc.style.cursor = "pointer";
  });
}

function tipAt(e, html) {
  const tip = $("#tooltip"); tip.innerHTML = html; tip.classList.remove("hidden");
  const w = tip.offsetWidth;
  tip.style.left = (e.clientX + 14 + w > innerWidth ? e.clientX - 14 - w : e.clientX + 14) + "px";
  tip.style.top = e.clientY - 10 + "px";
}
const hideTip = () => $("#tooltip").classList.add("hidden");

function renderRange(rows) {
  const el = $("#rangeChart");
  $("#rangeTitle").textContent = `Level per ${st.group === "all" ? "dataset" : st.group} · ${st.weighting}-weighted ${unit()}`;
  const rp = [...new Set(rows.map((r) => r.place).filter(Boolean))];
  $("#rangeLegend").innerHTML = multiPlace() && rp.length ? rp.map(placeChip).join(" ") : "";
  el.closest(".chart-card").classList.toggle("by-place", multiPlace() && rp.length > 0);
  if (!rows.length) { el.innerHTML = ""; return; }
  if (st.group === "day" && rp.length > 1) return renderRangeDodged(rows, rp);
  const W = el.clientWidth || 900, H = 240, L = 52, R = 10, T = 10, B = 40;
  const lo = Math.floor(Math.min(...rows.map((r) => r.l90)) / 5) * 5 - 2;
  const hi = Math.ceil(Math.max(...rows.map((r) => r.l10)) / 5) * 5 + 2;
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const cw = (W - L - R) / rows.length;
  const c1 = css("--series-1");
  const colOf = (r) => (multiPlace() && r.place ? placeColor(r.place) : c1);
  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Leq and L90–L10 range per group">`;
  for (let v = Math.ceil(lo / 5) * 5; v <= hi; v += 5) {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${css("--grid")}"/>` +
      `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${css("--text-muted")}">${(v + off()).toFixed(0)}</text>`;
  }
  if (st.thrOn) {
    const ty = y(st.thr - off());
    if (ty > T && ty < H - B) s += `<line x1="${L}" x2="${W - R}" y1="${ty}" y2="${ty}" stroke="${css("--serious")}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  }
  let prevDay = null, prevPlace = rows[0].place, lastLbl = -1e9;
  rows.forEach((r, i) => {
    const cx = L + i * cw + cw / 2;
    const newPlace = r.place !== prevPlace;
    if (st.group === "file" && (r.day !== prevDay || newPlace) && i > 0)
      s += `<line x1="${L + i * cw}" x2="${L + i * cw}" y1="${T}" y2="${H - B}" stroke="${newPlace ? colOf(r) : css("--axis")}" stroke-width="${newPlace ? 2 : 1}"/>`;
    s += `<rect class="hit" data-i="${i}" x="${L + i * cw}" y="${T}" width="${cw}" height="${H - T - B}" fill="transparent" style="cursor:pointer"/>`;
    s += `<g pointer-events="none"><line x1="${cx}" x2="${cx}" y1="${y(r.l90)}" y2="${y(r.l10)}" stroke="${colOf(r)}" stroke-opacity=".5" stroke-width="${Math.min(10, Math.max(3, cw * 0.4))}" stroke-linecap="round"/>` +
      `<circle cx="${cx}" cy="${y(r.leq)}" r="4.5" fill="${colOf(r)}" stroke="${css("--surface-1")}" stroke-width="2"/></g>`;
    let lbl = null;
    if (st.group === "file") { if (r.day !== prevDay || newPlace) lbl = fmtDay(Date.parse(r.start + "Z") / 1000); }
    else lbl = st.group === "day" ? fmtDay(dayEpoch(r.label)) : r.label;
    const maxCh = Math.max(4, Math.floor(cw / 6.5));
    if (st.group === "place" && lbl.length > maxCh) lbl = lbl.slice(0, maxCh - 1) + "…";
    if (lbl && cx - lastLbl > 50) { s += `<text x="${st.group === "file" ? L + i * cw + 2 : cx}" y="${H - B + 16}" ${st.group === "file" ? "" : 'text-anchor="middle"'} font-size="11" fill="${css("--text-secondary")}">${esc(lbl)}</text>`; lastLbl = cx; }
    prevDay = r.day; prevPlace = r.place;
  });
  s += `</svg>`;
  el.innerHTML = s;
  el.querySelectorAll(".hit").forEach((h) => {
    const r = rows[+h.dataset.i];
    h.addEventListener("mousemove", (e) => tipAt(e, rowTip(r)));
    h.addEventListener("mouseleave", hideTip);
    h.addEventListener("click", () => openRow(r));
  });
}
// Group = Day with several places: one cluster per day, one bar per place,
// and a faint line joining each place's Leq across days (same place along time)
function renderRangeDodged(rows, places) {
  const el = $("#rangeChart");
  const W = el.clientWidth || 900, H = 260, L = 52, R = 10, T = 10, B = 40;
  const lo = Math.floor(Math.min(...rows.map((r) => r.l90)) / 5) * 5 - 2;
  const hi = Math.ceil(Math.max(...rows.map((r) => r.l10)) / 5) * 5 + 2;
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  const days = [...new Set(rows.map((r) => r.label))].sort();
  const cw = (W - L - R) / days.length, bw = cw / (places.length + 1);
  const xOf = (r) => L + days.indexOf(r.label) * cw + bw * (places.indexOf(r.place) + 1);
  let s = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Leq and L90–L10 range per day and place">`;
  for (let v = Math.ceil(lo / 5) * 5; v <= hi; v += 5) {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${css("--grid")}"/>` +
      `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="${css("--text-muted")}">${(v + off()).toFixed(0)}</text>`;
  }
  if (st.thrOn) {
    const ty = y(st.thr - off());
    if (ty > T && ty < H - B) s += `<line x1="${L}" x2="${W - R}" y1="${ty}" y2="${ty}" stroke="${css("--serious")}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  }
  days.forEach((d, i) => {
    if (i) s += `<line x1="${L + i * cw}" x2="${L + i * cw}" y1="${T}" y2="${H - B}" stroke="${css("--axis")}"/>`;
    s += `<text x="${L + i * cw + cw / 2}" y="${H - B + 16}" text-anchor="middle" font-size="11" fill="${css("--text-secondary")}">${fmtDay(dayEpoch(d))}</text>`;
  });
  for (const p of places) {
    const pts = rows.filter((r) => r.place === p).sort((a, b) => (a.label < b.label ? -1 : 1)).map((r) => `${xOf(r)},${y(r.leq)}`);
    if (pts.length > 1) s += `<polyline points="${pts.join(" ")}" fill="none" stroke="${placeColor(p)}" stroke-opacity=".45" stroke-width="1.5"/>`;
  }
  rows.forEach((r, i) => {
    const cx = xOf(r), c = placeColor(r.place);
    s += `<rect class="hit" data-i="${i}" x="${cx - bw / 2}" y="${T}" width="${bw}" height="${H - T - B}" fill="transparent" style="cursor:pointer"/>`;
    s += `<g pointer-events="none"><line x1="${cx}" x2="${cx}" y1="${y(r.l90)}" y2="${y(r.l10)}" stroke="${c}" stroke-opacity=".5" stroke-width="${Math.min(10, Math.max(3, bw * 0.5))}" stroke-linecap="round"/>` +
      `<circle cx="${cx}" cy="${y(r.leq)}" r="4.5" fill="${c}" stroke="${css("--surface-1")}" stroke-width="2"/></g>`;
  });
  s += `</svg>`;
  el.innerHTML = s;
  el.querySelectorAll(".hit").forEach((h) => {
    const r = rows[+h.dataset.i];
    h.addEventListener("mousemove", (e) => tipAt(e, rowTip(r)));
    h.addEventListener("mouseleave", hideTip);
    h.addEventListener("click", () => openRow(r));
  });
}

function rowTip(r) {
  const line = (k, v) => `<div class="r">${k}<b>${v}</b></div>`;
  const lbl = st.group === "day" ? fmtDay(dayEpoch(r.label)) : r.label;
  const head = r.place && multiPlace() && r.place !== r.label ? `${esc(r.place)} · ${esc(lbl)}` : esc(lbl);
  return `<div class="t">${head}</div>` + line("Leq", fmtDb(r.leq)) + line("L10", fmtDb(r.l10)) +
    line("L90", fmtDb(r.l90)) + line("Lmax", fmtDb(r.lmax)) + line("NDSI", r.ndsi == null ? "–" : r.ndsi.toFixed(2));
}
function openRow(r) {
  hideTip();
  if (multiPlace()) st.place = r.place || "";
  if (st.group === "file") { st.scope = "file"; st.fileId = r.file_ids[0]; }
  else if (st.group === "day") { st.scope = "day"; st.day = r.label; st.overlay = false; $("#overlayOn").checked = false; }
  else st.scope = "all";
  st.tab = "timeline"; save();
  if (multiPlace()) $("#placeSelect").value = st.place;
  destroyPlots();
  $$("#scopeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === st.scope));
  fillScopeSelect(); syncScopeUi(); showTab();
}

const COLS = [
  ["place", "Place"], ["label", "Group"], ["start", "Start"], ["duration", "Duration"], ["leq", "Leq"], ["l10", "L10"], ["l50", "L50"],
  ["l90", "L90"], ["lmax", "Lmax"], ["anthro", "Anthro"], ["bio", "Bio"], ["ndsi", "NDSI"], ["pct_above", "% > thr"],
];
function renderTable() {
  const showPlace = multiPlace() && sumRows.some((r) => r.place);
  const cols = COLS.filter(([k]) => (k !== "pct_above" || st.thrOn) && (k !== "place" || showPlace) && !(k === "label" && st.group === "place"));
  let rows = sumRows.slice();
  if (sumSort.key) rows.sort((a, b) => ((a[sumSort.key] > b[sumSort.key] ? 1 : -1) * (sumSort.asc ? 1 : -1)));
  const fmt = (k, v) => {
    if (v == null) return "–";
    if (k === "start") return `${fmtDay(Date.parse(v + "Z") / 1000)} ${fmtClock(Date.parse(v + "Z") / 1000, false)}`;
    if (k === "duration") return fmtTod(v, true);
    if (k === "ndsi") return v.toFixed(2);
    if (k === "pct_above") return v.toFixed(1) + " %";
    if (k === "place") return placeChip(v);
    if (k === "label") return esc(v);
    return fmtDb(v);
  };
  const t = $("#sumTable");
  const nameOf = (k, n) => (k === "anthro" ? `Anthro ${fmtHzRange(bands.anthro)}` : k === "bio" ? `Bio ${fmtHzRange(bands.bio)}` : n);
  t.innerHTML = `<thead><tr>${cols.map(([k, n0]) => [k, nameOf(k, n0)]).map(([k, n]) => `<th data-k="${k}" class="${sumSort.key === k ? "sorted" + (sumSort.asc ? " asc" : "") : ""}">${n}${["place", "label", "start", "duration", "ndsi", "pct_above"].includes(k) ? "" : ` <span class="muted small">${unit()}</span>`}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.map((r, i) => `<tr data-i="${sumRows.indexOf(r)}">${cols.map(([k]) => `<td class="${k === "ndsi" && r.ndsi < 0 ? "neg" : ""}">${fmt(k, r[k])}</td>`).join("")}</tr>`).join("")}</tbody>`;
  t.querySelectorAll("th").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.k;
    sumSort = { key: k, asc: sumSort.key === k ? !sumSort.asc : false };
    renderTable();
  }));
  t.querySelectorAll("tbody tr").forEach((tr) => tr.addEventListener("click", () => openRow(sumRows[+tr.dataset.i])));
}

// ---------------------------------------------------------------- drag & drop
function initDrop() {
  let depth = 0;
  const ov = $("#dropOverlay");
  window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; ov.classList.remove("hidden"); });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; ov.classList.add("hidden"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault(); depth = 0; ov.classList.add("hidden");
    const items = [...(e.dataTransfer.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!items.length) return;
    try {
      let body;
      const dir = items.find((i) => i.isDirectory);
      if (dir) {
        const entries = await new Promise((res, rej) => dir.createReader().readEntries(res, rej));
        const fileEntries = entries.filter((x) => x.isFile && !x.name.startsWith(".")).slice(0, 12);
        const files = await Promise.all(fileEntries.map((fe) => new Promise((res) => fe.file((f) => res({ name: f.name, size: f.size }), () => res(null)))));
        body = { name: dir.name, is_dir: true, files: files.filter(Boolean) };
      } else {
        const files = [...e.dataTransfer.files].slice(0, 12).map((f) => ({ name: f.name, size: f.size }));
        body = { name: files[0].name, is_dir: false, files };
      }
      toast(`Locating “${body.name}”…`, 3000);
      await post("/api/resolve-drop", body);
      onFolderLoaded();
    } catch (err) { toast(err.message, 6000); }
  });
}

// ---------------------------------------------------------------- boot
applyTheme();
initControls();
$$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === st.tab));
pollStatus();
