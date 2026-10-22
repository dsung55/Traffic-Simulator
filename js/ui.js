// UI orchestration: control dock, run controls, live metrics + charts,
// baseline comparison, guided experiments, vehicle inspector, keyboard
// shortcuts and first-run onboarding. The pieces live in js/ui/*.js; this
// module wires them to `sim` and the engine.
import { MPH_PER_CELL, N } from './config.js';
import { sim, cfg, rampLaneIdx, carV0 } from './state.js';
import * as engine from './engine.js';
import { rng } from './rng.js';
import { $, fmt } from './dom.js';
import {
  CONTROL_BY_KEY, TRACKED, defaultsFor, fmtValue,
} from './ui/spec.js';
import { buildControls, syncControls as syncDock, showTab } from './ui/controls.js';
import { initPopover, attachInfo, hidePopover } from './ui/popover.js';
import {
  readStats, sampleTick, history, windowMean, clearHistory, levelOfService, verdict,
} from './ui/stats.js';
import { drawTimeSeries, drawFD } from './ui/charts.js';
import { EXPERIMENTS, WARMUP_S } from './ui/experiments.js';

const { resetSim, applyLaneCount, leaderInLane } = engine;
const SPEEDS = [1, 2, 4, 8];
let opts = { rescheduleTicks() {}, invalidateScene() {} };

//──────────────────────────── small helpers ────────────────────────────
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const isMobile = () => document.body.classList.contains('is-mobile');

let toastT = 0;
function toast(msg, level = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + level;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// Fill in any contract fields the engine hasn't defined yet so every control
// has a sane value to display (no-op once state.js provides them).
function ensureSimDefaults() {
  const d = defaultsFor(sim.scenario);
  for (const [k, v] of Object.entries(d)) if (sim[k] === undefined) sim[k] = v;
  if (!SPEEDS.includes(sim.timeScale)) sim.timeScale = 1;
}

//──────────────────────────── settings changes ────────────────────────────
let lastChangeT = 0;            // sim time of the last settings change / reset
function markChange() { lastChangeT = sim.time; }

function setSim(key, v, { quiet = false } = {}) {
  const c = CONTROL_BY_KEY[key];
  switch (key) {
    case 'lanes':
      applyLaneCount(+v);
      if (sim.incidentLanes > sim.lanes - 1) sim.incidentLanes = Math.max(1, sim.lanes - 1);
      break;
    case 'meterOn':
      sim.meterOn = !!v; sim.meterTimer = 0; break;
    case 'exitRamp': setExitRamp(!!v); break;
    case 'mergeShape':
      sim.mergeShape = v; resetSim(); break;
    default:
      sim[key] = v;
  }
  if (!quiet) markChange();
  if (c && c.reset && !quiet) toast(`${c.label} changed: the run restarted.`);
  syncAll();
}

// Exit ramp toggles IN PLACE (no reset). On enable, cars still upstream of the
// gore get an immediate exit decision so the effect shows within seconds.
function setExitRamp(on) {
  sim.exitRamp = on;
  const ox = cfg().offRampCell;
  for (const car of sim.cars) {
    if (on && ox !== undefined && car.cell < ox - 5 && car.lane < sim.lanes) {
      car.exitChance = Math.min(0.9, (sim.exitPct / 100) * (0.75 + rng() * 0.5));
      car.exiting = rng() < car.exitChance;
      car.exitDecided = true;
    } else if (!on) {
      car.exiting = false;
    }
  }
}

function setScenario(scn) {
  if (scn === sim.scenario) return;
  const d = defaultsFor(scn);
  sim.scenario = scn;
  // Scenario-scaled settings snap to the new layout's defaults.
  sim.lanes = d.lanes; sim.speedMph = d.speedMph; sim.demandVph = d.demandVph;
  if (sim.incidentLanes > sim.lanes - 1) sim.incidentLanes = Math.max(1, sim.lanes - 1);
  resetSim();
  opts.invalidateScene();
  markChange();
  syncAll();
}

// Apply many settings at once (experiments, restore-defaults).
function applySettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'scenario') continue;
    if (k === 'lanes') { if (v !== sim.lanes) applyLaneCount(v); continue; }
    if (k === 'exitRamp') { setExitRamp(!!v); continue; }
    sim[k] = v;
  }
}

function restoreDefaults() {
  const d = defaultsFor(sim.scenario);
  const needsReset = d.mergeShape !== sim.mergeShape;
  applySettings(d);
  if (needsReset) resetSim();
  markChange();
  syncAll();
  toast('All settings restored to defaults.');
}

function settingsSnapshot() {
  const o = {};
  for (const k of TRACKED) o[k] = sim[k];
  return o;
}

//──────────────────────────── run controls ────────────────────────────
const ICON_PAUSE = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">' +
  '<rect x="3" y="2.5" width="3.5" height="11" rx="1.2"/><rect x="9.5" y="2.5" width="3.5" height="11" rx="1.2"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">' +
  '<path d="M5 3.2a1 1 0 0 1 1.53-.85l7 4.3a1 1 0 0 1 0 1.7l-7 4.3A1 1 0 0 1 5 11.8z"/></svg>';

function updatePauseUI() {
  const b = $('btnPause');
  b.classList.toggle('paused', sim.paused);
  b.setAttribute('aria-pressed', String(sim.paused));
  b.setAttribute('aria-label', sim.paused ? 'Play' : 'Pause');
  b.innerHTML = sim.paused ? ICON_PLAY + '<span>Play</span>' : ICON_PAUSE + '<span>Pause</span>';
  $('statusChip').classList.toggle('paused', sim.paused);
}
function togglePause() { sim.paused = !sim.paused; updatePauseUI(); }

function setTimeScale(n) {
  if (!SPEEDS.includes(n)) return;
  sim.timeScale = n;
  opts.rescheduleTicks();
  syncSpeedUI();
}
function syncSpeedUI() {
  for (const b of $('speedSeg').querySelectorAll('button')) {
    const on = +b.dataset.v === sim.timeScale;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const c = $('btnSpeedCycle');
  c.textContent = sim.timeScale + '×';
  c.setAttribute('aria-label', `Simulation speed ${sim.timeScale}×, tap to change`);
  c.classList.toggle('on', sim.timeScale > 1);
}

function doReset() {
  resetSim();
  markChange();
  syncAll();
  toast('Run restarted. Settings kept.');
}

function phantomBrake() {
  const mainline = sim.cars.filter(c => c.lane < sim.lanes);
  if (!mainline.length) { toast('No traffic on the road yet.'); return; }
  let car = sim.selected && sim.cars.includes(sim.selected) ? sim.selected : null;
  let res = null;
  if (typeof engine.triggerPhantomBrake === 'function') {
    try { res = engine.triggerPhantomBrake(car); } catch (e) { console.warn('triggerPhantomBrake failed', e); }
  } else {
    // Fallback for engines without the API: knock one mid-road car's speed down.
    if (!car) {
      const mid = mainline.filter(c => c.cell > N * 0.3 && c.cell < N * 0.75 && c.v > 0.8);
      const pool = mid.length ? mid : mainline;
      car = pool[Math.floor(rng() * pool.length)];
    }
    car.v *= 0.3;
    res = car;
  }
  const who = res && res.id != null ? res : car;
  toast(`${who ? 'Car #' + who.id : 'A driver'} braked hard. Watch the slowdown travel backward.`, 'warn');
}

function toggleHeatmap() { setSim('showHeatmap', !sim.showHeatmap, { quiet: true }); }

//──────────────────────────── metrics + baseline ────────────────────────────
const METRICS = [
  { key: 'avgSpeedMph', label: 'Avg speed', unit: 'mph', d: 0, better: 1, primary: true,
    what: 'Mean speed of the vehicles on the mainline right now.',
    why: 'The gap between this and the speed limit is congestion. It is what drivers feel first.' },
  { key: 'flowVphPerLane', label: 'Flow', unit: 'veh/h/ln', d: 0, better: 1, primary: true,
    what: 'Vehicles per hour per lane passing the detector (rolling window).',
    why: 'Flow = speed × density. It peaks at capacity (~2,000 veh/h/lane) and FALLS once traffic breaks down: congested roads carry fewer cars, not more.' },
  { key: 'densityVpmPerLane', label: 'Density', unit: 'veh/mi/ln', d: 0, better: 0,
    what: 'Vehicles per mile per lane on the mainline.',
    why: 'Below a critical density (~30–45 veh/mi/lane) traffic flows freely; above it speeds collapse. Freeway Level of Service A–F is graded on density.' },
  { key: 'meanTravelTimeS', label: 'Travel time', unit: 's', d: 0, better: -1, primary: true,
    what: 'Average time to drive the whole section, for vehicles that finished in the last ~2 minutes.',
    why: 'The bottom line for drivers. Comparing it before/after a change is the fairest single verdict.' },
  { key: 'meanDelayS', label: 'Delay / veh', unit: 's', d: 0, better: -1,
    what: 'Extra time per trip compared with driving the section at the driver’s own desired speed.',
    why: 'Delay is the standard measure of congestion cost; the Highway Capacity Manual grades signalised intersections on it.' },
  { key: 'stopsPerVeh', label: 'Stops / veh', unit: '', d: 2, better: -1,
    what: 'Average number of times a vehicle came to (nearly) a stop.',
    why: 'Each stop costs fuel, emissions and rear-end crash risk. Stop-and-go waves and uncoordinated signals drive it up.' },
  { key: 'rampQueue', label: 'Ramp queue', unit: 'veh', d: 0, better: -1, scenario: 'highway',
    what: 'Vehicles waiting on the on-ramp to merge or for the meter.',
    why: 'Ramp metering deliberately trades a longer ramp queue for a faster mainline. If it grows without limit it would spill onto local streets.' },
  { key: 'entryQueue', label: 'Entry queue', unit: 'veh', d: 0, better: -1,
    what: 'Vehicles that have arrived upstream but cannot enter the section yet because there is no room.',
    why: 'This is spillback: demand exceeds what the road can absorb, so the queue extends beyond what you see. Real jams grow the same way, backwards into earlier junctions.' },
];

let baseline = null;   // { stats, settings, t }

function buildKpis() {
  const wrap = $('kpis');
  for (const m of METRICS) {
    const el = document.createElement('div');
    el.className = 'kpi' + (m.primary ? ' primary' : '');
    el.id = 'k-' + m.key;
    el.tabIndex = 0;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', m.label);
    el.innerHTML = `<span class="kLabel">${m.label}</span>` +
      `<span class="kVal"><b>–</b><small>${m.unit}</small></span>` +
      `<span class="kDelta" aria-live="off"></span>`;
    attachInfo(el, () => ({
      title: m.label, what: m.what, why: m.why,
      extra: baseline && Number.isFinite(baseline.stats[m.key])
        ? `Baseline: ${fmt(baseline.stats[m.key], m.d)} ${m.unit}` +
          (m.better ? (m.better > 0 ? ' (higher is better)' : ' (lower is better)') : '') : '',
    }));
    wrap.append(el);
  }
  attachInfo($('los'), () => {
    const city = !!cfg().lightCells;
    return {
      title: 'Level of Service (LOS)',
      what: city
        ? 'The Highway Capacity Manual grade for signalised streets, from average control delay per vehicle at each signal: A ≤ 10 s, B ≤ 20, C ≤ 35, D ≤ 55, E ≤ 80, F above.'
        : 'The Highway Capacity Manual grade for freeways, from density: A ≤ 11 veh/mi/lane, B ≤ 18, C ≤ 26, D ≤ 35, E ≤ 45, F above (breakdown).',
      why: 'Engineers design roads to reach about LOS C–D at peak hour. E means running at capacity; F means demand exceeds it and queues form.',
    };
  });
}

function saveBaseline() {
  const w = windowMean(60);
  if (!w) { toast('Let the simulation run a little first.'); return; }
  baseline = { stats: w, settings: settingsSnapshot(), t: sim.time };
  toast(sim.time - lastChangeT < 45
    ? 'Baseline saved, though traffic had not settled yet. Re-save after ~1 min for a fairer comparison.'
    : 'Baseline saved. Now change one thing and watch the deltas.', 'good');
  updateMetrics();
}
function clearBaseline() { baseline = null; updateMetrics(); }

function settingChanges() {
  if (!baseline) return [];
  const out = [];
  for (const k of TRACKED) {
    const a = baseline.settings[k], b = sim[k];
    if (a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9)) continue;
    if (k === 'scenario') { out.push({ label: 'Road layout', from: a, to: b }); continue; }
    const c = CONTROL_BY_KEY[k];
    if (!c) continue;
    out.push({ label: c.label, from: fmtValue(c, a), to: fmtValue(c, b) });
  }
  return out;
}

// Delta badge text + polarity class for one metric.
function deltaFor(m, cur, base) {
  if (!Number.isFinite(cur) || !Number.isFinite(base)) return null;
  const diff = cur - base;
  const queue = m.key === 'rampQueue' || m.key === 'entryQueue';
  const scale = Math.max(Math.abs(base), m.key === 'stopsPerVeh' ? 0.25 : queue ? 3 : 1e-6);
  const rel = diff / scale;
  if (Math.abs(rel) < 0.03) return { text: '≈ same', cls: 'same' };
  const arrow = diff > 0 ? '▲' : '▼';
  const txt = Math.abs(base) > 1e-6 && !queue
    ? `${arrow} ${Math.round(Math.abs(diff / base) * 100)}%`
    : `${arrow} ${fmt(Math.abs(diff), Math.abs(diff) < 10 ? 1 : 0)}`;
  const cls = !m.better ? 'neutral' : (diff * m.better > 0 ? 'better' : 'worse');
  return { text: txt, cls };
}

function compareSentence(cur, base) {
  const tt0 = base.meanTravelTimeS, tt1 = cur.meanTravelTimeS;
  if (Number.isFinite(tt0) && Number.isFinite(tt1) && tt0 > 0) {
    const d = (tt1 - tt0) / tt0;
    if (Math.abs(d) < 0.03) return { level: 'same', text: `Trips take about the same time as the baseline (${tt0.toFixed(0)} s).` };
    return { level: d < 0 ? 'better' : 'worse',
      text: `Trips are ${Math.round(Math.abs(d) * 100)}% ${d < 0 ? 'faster' : 'slower'} than the baseline (${tt0.toFixed(0)} s → ${tt1.toFixed(0)} s).` };
  }
  const v0 = base.avgSpeedMph, v1 = cur.avgSpeedMph;
  if (Number.isFinite(v0) && Number.isFinite(v1) && v0 > 0) {
    const d = (v1 - v0) / v0;
    if (Math.abs(d) < 0.03) return { level: 'same', text: `Average speed is about the same as the baseline (${v0.toFixed(0)} mph).` };
    return { level: d > 0 ? 'better' : 'worse',
      text: `Average speed is ${Math.round(Math.abs(d) * 100)}% ${d > 0 ? 'higher' : 'lower'} than the baseline (${v0.toFixed(0)} → ${v1.toFixed(0)} mph).` };
  }
  return { level: 'same', text: 'Collecting data to compare…' };
}

// Experiment-specific comparison: the metrics that experiment is about.
const METRIC_BY_KEY = Object.fromEntries(METRICS.map(m => [m.key, m]));
function compareFocus(keys, cur, base) {
  const parts = [];
  let level = null;
  for (const k of keys) {
    const m = METRIC_BY_KEY[k];
    if (!m) continue;
    const a = base[k], b = cur[k];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const dd = deltaFor(m, b, a);
    const unit = m.unit ? ' ' + m.unit : '';
    parts.push(`${m.label}: ${fmt(a, m.d)} → ${fmt(b, m.d)}${unit}` + (dd && dd.cls !== 'same' ? ` (${dd.text.replace(/[▲▼] /, b > a ? '+' : '−')})` : ''));
    if (level === null && dd) level = dd.cls === 'better' ? 'better' : dd.cls === 'worse' ? 'worse' : 'same';
  }
  if (!parts.length) return compareSentence(cur, base);
  return { level: level || 'same', text: parts.join(' · ') };
}

let tsHover = null, fdHover = null;
function bindChartHover(id, set) {
  const cv = $(id);
  cv.addEventListener('pointermove', e => {
    const r = cv.getBoundingClientRect();
    set({ x: e.clientX - r.left, y: e.clientY - r.top });
    drawCharts();
  });
  cv.addEventListener('pointerleave', () => { set(null); drawCharts(); });
}

function drawCharts() {
  if (isMobile() && !document.body.classList.contains('metrics-open')) return;
  const base = baseline ? baseline.stats : null;
  drawTimeSeries($('tsChart'), history, base, tsHover);
  drawFD($('fdChart'), history, base, fdHover);
}

let compareState = null;   // latest { level, text } for the guide card
function updateMetrics() {
  if (sim.time < lastChangeT) lastChangeT = 0;   // a reset happened elsewhere
  const s = readStats();
  const hwy = !!cfg().hasRamp;
  const recent = windowMean(30) || s;
  const settling = sim.time - lastChangeT < 60;

  for (const m of METRICS) {
    const el = $('k-' + m.key);
    const show = (!m.scenario || (m.scenario === 'highway') === hwy) && s[m.key] !== undefined;
    el.hidden = !show;
    if (!show) continue;
    el.querySelector('b').textContent = fmt(s[m.key], m.d);
    el.querySelector('small').hidden = !Number.isFinite(s[m.key]);
    const dEl = el.querySelector('.kDelta');
    const dd = baseline ? deltaFor(m, recent[m.key], baseline.stats[m.key]) : null;
    dEl.textContent = dd ? dd.text : '';
    dEl.className = 'kDelta' + (dd ? ' ' + dd.cls : '') + (settling ? ' settling' : '');
    el.setAttribute('aria-label', `${m.label}: ${fmt(s[m.key], m.d)} ${m.unit}` +
      (dd ? `, ${dd.cls === 'better' ? 'better than' : dd.cls === 'worse' ? 'worse than' : 'versus'} baseline ${dd.text}` : ''));
  }

  const v = verdict(s);
  $('verdict').textContent = v.text;
  $('verdictDot').className = 'vDot ' + v.level;
  const los = sim.time > 25 ? levelOfService(s) : null;
  const losEl = $('los');
  losEl.textContent = los ? `LOS ${los.grade}` : 'LOS –';
  losEl.className = 'los' + (los ? ' g' + los.grade : '');
  losEl.setAttribute('aria-label', los ? `Level of service ${los.grade}, ${los.basis}` : 'Level of service not available yet');

  // Baseline row
  $('btnBaseline').querySelector('span').textContent = baseline ? 'Update baseline' : 'Save baseline';
  $('baseHint').hidden = !!baseline;
  $('baseInfo').hidden = !baseline;
  compareState = null;
  if (baseline) {
    const changes = settingChanges();
    const ch = $('baseChanges');
    if (!changes.length) {
      ch.innerHTML = '<span class="chg none">nothing yet. Change one factor to test it.</span>';
    } else {
      ch.innerHTML = changes.slice(0, 3).map(c =>
        `<span class="chg"><em>${c.label}</em> ${c.from} <span aria-hidden="true">→</span><span class="sr"> to </span> <b>${c.to}</b></span>`).join('') +
        (changes.length > 3 ? `<span class="chg more">+${changes.length - 3} more</span>` : '');
      ch.title = changes.map(c => `${c.label}: ${c.from} → ${c.to}`).join('\n');
    }
    const sum = $('baseSummary');
    if (settling && changes.length) {
      sum.textContent = `Settling after your change (${Math.max(0, Math.round(sim.time - lastChangeT))} s)… judge after ~1–2 min.`;
      sum.className = 'baseSummary same';
    } else {
      compareState = compareSentence(recent, baseline.stats);
      sum.textContent = compareState.text;
      sum.className = 'baseSummary ' + compareState.level;
    }
  }

  $('statusClock').textContent = clock(sim.time);
  updateGuide();
  syncAll();
  drawCharts();
}

//──────────────────────────── experiments ────────────────────────────
let exp = null;          // active experiment
let stepDone = new Set();

function buildExperimentMenu() {
  const grid = $('expGrid');
  EXPERIMENTS.forEach((e, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'expCard';
    b.innerHTML = `<span class="expNum">${i + 1}</span>` +
      `<span class="expScn ${e.scenario}">${e.scenario === 'city' ? 'City' : 'Highway'}</span>` +
      `<b>${e.title}</b><span class="expTeaser">${e.teaser}</span>`;
    b.addEventListener('click', () => { $('expMenu').close(); startExperiment(e); });
    grid.append(b);
  });
}

function openDialog(id) {
  hidePopover();
  const d = $(id);
  if (!d.open) d.showModal();
}

function startExperiment(e) {
  exp = e; stepDone = new Set();
  const d = defaultsFor(e.scenario);
  const scnChanged = sim.scenario !== e.scenario;
  sim.scenario = e.scenario;
  applySettings({ ...d, ...e.setup });
  baseline = null;
  resetSim();
  if (scnChanged) opts.invalidateScene();
  clearHistory();
  markChange();
  sim.paused = false; updatePauseUI();
  const g = $('guide');
  g.hidden = false;
  g.classList.remove('collapsed');
  $('gCollapse').setAttribute('aria-expanded', 'true');
  $('gKicker').textContent = `Experiment ${EXPERIMENTS.indexOf(e) + 1} of ${EXPERIMENTS.length}`;
  $('gTitle').textContent = e.title;
  $('gWatch').textContent = e.watch;
  $('gWhy').textContent = e.why;
  const ol = $('gSteps');
  ol.innerHTML = '';
  e.steps.forEach((st, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn sm gStep'; b.id = 'gStep' + i;
    b.innerHTML = `<span class="gNum">${i + 1}</span><span>${st.label}</span>`;
    b.addEventListener('click', () => runStep(i));
    li.append(b);
    ol.append(li);
  });
  if (isMobile()) { setSheet('metrics-open', false); setSheet('controls-open', false); }
  syncAll();
  updateMetrics();
  toast(`Experiment: ${e.title}`);
}

function runStep(i) {
  const st = exp && exp.steps[i];
  if (!st) return;
  if (st.action === 'brake') { phantomBrake(); stepDone.add(i); updateGuide(); return; }
  if (st.baseline) saveBaseline();
  const needsReset = st.apply && 'mergeShape' in st.apply && st.apply.mergeShape !== sim.mergeShape;
  if (st.apply) applySettings(st.apply);
  if (needsReset) { resetSim(); }
  markChange();
  stepDone.add(i);
  syncAll();
  updateMetrics();
  if (st.then) toast(st.then);
}

function endExperiment() { exp = null; $('guide').hidden = true; }

function updateGuide() {
  if (!exp) return;
  const since = sim.time - lastChangeT;
  const warm = since >= WARMUP_S;
  const anyBaselineDone = exp.steps.some((s, i) => s.baseline && stepDone.has(i));
  const prog = $('gProgress');
  if (!warm) {
    prog.hidden = false;
    $('gBarFill').style.width = Math.min(100, since / WARMUP_S * 100) + '%';
    $('gProgText').textContent = `${anyBaselineDone ? 'Settling after the change' : 'Warming up'}… ${Math.floor(since)} / ${WARMUP_S} s` +
      (sim.timeScale < 4 ? ' (press 4 to fast-forward)' : '');
  } else {
    prog.hidden = true;
  }
  exp.steps.forEach((st, i) => {
    const b = $('gStep' + i);
    if (!b) return;
    const done = stepDone.has(i);
    b.classList.toggle('done', done && !st.repeat);
    // Baseline steps wait for warm-up and run once; the brake step is always live.
    const prevBaselinePending = exp.steps.slice(0, i).some((s, j) => s.baseline && !stepDone.has(j));
    b.disabled = st.repeat ? false : (done || prevBaselinePending || (st.baseline && !warm));
    b.title = st.baseline && !warm && !done ? 'Wait for traffic to settle first' : '';
  });
  const res = $('gResult');
  if (anyBaselineDone) {
    if (!warm) { res.textContent = 'Give traffic a minute or two to respond, then read the deltas: green = better, red = worse.'; res.className = 'gResult'; }
    else if (baseline) {
      const r = compareFocus(exp.focus || ['meanTravelTimeS'], windowMean(30) || readStats(), baseline.stats);
      res.textContent = r.text; res.className = 'gResult ' + r.level;
    }
  } else {
    res.textContent = warm && exp.steps.some(s => s.baseline) ? 'Traffic has settled. Run the next step to compare.' : '';
    res.className = 'gResult';
  }
  res.hidden = !res.textContent;
}

//──────────────────────────── inspector ────────────────────────────
function selectCar(car) {
  sim.selected = car || null;
  $('inspector').classList.toggle('show', !!car);
  if (!car) return;
  $('insSwatch').style.background = car.color;
  updateInspector();
}

function vehLabel(car) {
  const t = car.vehType || (car.isTruck ? 'truck' : 'car');
  return t === 'suv' ? 'SUV' : t.charAt(0).toUpperCase() + t.slice(1);
}

function updateInspector() {
  const car = sim.selected;
  if (!car) return;
  if (!sim.cars.includes(car)) { selectCar(null); return; }
  const toMph = v => v * MPH_PER_CELL;
  $('insName').textContent = `${vehLabel(car)} #${car.id}`;
  $('insProf').textContent = car.isAV ? 'Automated driving' : `${car.profName} driver`;
  const chips = [];
  chips.push(car.isAV ? '<span class="ichip av">Automated</span>' : '<span class="ichip">Human</span>');
  if (!car.isAV) chips.push(`<span class="ichip p-${car.profName}">${car.profName}</span>`);
  if (car.isTruck) chips.push('<span class="ichip">Heavy vehicle</span>');
  if (car.distracted) chips.push('<span class="ichip warn">On phone</span>');
  if (car.exiting) chips.push('<span class="ichip">Exiting</span>');
  const html = chips.join('');
  if ($('insChips').innerHTML !== html) $('insChips').innerHTML = html;

  $('insSpeed').textContent = fmt(toMph(car.v), 0) + ' mph';
  $('insV0').textContent = fmt(toMph(carV0(car)), 0) + ' mph';
  $('insAcc').textContent = fmt((car.accel || 0) * 7.5, 1) + ' m/s²';
  const lead = leaderInLane(car, car.lane, N);
  $('insGap').textContent = lead.lead ? fmt(lead.gap * 7.5, 0) + ' m' : 'open road';
  $('insHeadway').textContent = lead.lead && car.v > 0.05 ? fmt(lead.gap / car.v, 1) + ' s' : '–';
  const rt = car.isAV ? 0 : (Number.isFinite(car.reactionTime) ? car.reactionTime : sim.reactionTime);
  $('insReact').textContent = car.isAV ? '≈0 s' : fmt(rt, 1) + ' s';
  $('insLane').textContent = cfg().hasRamp && car.lane === rampLaneIdx() ? 'Ramp' : 'Lane ' + (car.lane + 1);
  let st = car.distracted ? 'Distracted: not reacting'
    : car.lc ? (car.lc.phase === 'signal' ? 'Signalling, waiting for a gap'
      : car.lc.phase === 'abort' ? 'Aborting lane change' : 'Changing lanes')
    : car.braking ? 'Braking'
    : car.v < 0.05 ? 'Stopped'
    : (car.accel || 0) > 0.05 ? 'Accelerating' : 'Cruising';
  if (car.exiting && !st.includes('xit')) st += ' · exiting';
  $('insStatus').textContent = st;
  $('insStatus').className = 'insStatus' + (car.distracted ? ' warnTxt' : car.braking ? ' badTxt' : '');
  $('insAge').textContent = clock(car.age || 0);
}

//──────────────────────────── sync + layout ────────────────────────────
function syncAll() {
  syncDock(sim);
  for (const b of $('scenarioSeg').querySelectorAll('button')) {
    const on = b.dataset.v === sim.scenario;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const q = $('qHeat');
  q.setAttribute('aria-pressed', String(!!sim.showHeatmap));
  q.classList.toggle('on', !!sim.showHeatmap);
  document.body.classList.toggle('scn-city', !!cfg().lightCells);
  document.body.classList.toggle('scn-highway', !cfg().lightCells);
}

// Floating cards are positioned between the docked bars; publish their sizes.
function trackBarHeights() {
  const root = document.documentElement.style;
  const upd = () => {
    root.setProperty('--top-h', $('topbar').offsetHeight + 'px');
    root.setProperty('--bot-h', $('bottombar').offsetHeight + 'px');
  };
  upd();
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(upd);
    ro.observe($('topbar')); ro.observe($('bottombar'));
  } else {
    window.addEventListener('resize', upd);
  }
}

// Mobile sheets: the metrics drawer (top) and the control sheet (bottom) are
// mutually exclusive so the road always stays visible between them.
const SHEETS = { 'controls-open': 'ctlToggle', 'metrics-open': 'metricsToggle' };
function setSheet(cls, open) {
  document.body.classList.toggle(cls, open);
  $(SHEETS[cls]).setAttribute('aria-expanded', String(open));
  if (open) {
    for (const other of Object.keys(SHEETS)) if (other !== cls) setSheet(other, false);
  }
  if (cls === 'metrics-open') {
    $('metricsToggle').setAttribute('aria-label', open ? 'Hide extra metrics' : 'Show all metrics and charts');
    if (open) requestAnimationFrame(drawCharts);
  }
}
function bindBarToggle(btnId, cls) {
  $(btnId).addEventListener('click', () => setSheet(cls, !document.body.classList.contains(cls)));
}

function segKeys(seg) {
  seg.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    const btns = [...seg.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    const n = btns[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + btns.length) % btns.length];
    n.focus(); n.click();
  });
}

function simPanelExtras() {
  const wrap = document.createElement('div');
  wrap.className = 'ctl t-extra';
  wrap.innerHTML = `<div class="ctlHead"><span class="ctlLabel">Settings</span></div>
    <div class="btnRow">
      <button type="button" class="btn sm" id="btnDefaults">Restore defaults</button>
      <button type="button" class="btn sm ghost" id="btnShortcuts">Shortcuts</button>
      <button type="button" class="btn sm ghost" id="btnWelcome">Welcome tip</button>
    </div>
    <p class="ctlHint">Restore puts every control back to this layout's default (the run keeps going). Sim speed: header buttons or keys 1–4.</p>`;
  return wrap;
}

//──────────────────────────── keyboard ────────────────────────────
function bindKeys() {
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = document.activeElement;
    if (el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return;
    if (document.querySelector('dialog[open]')) return;   // dialogs handle their own keys
    const k = e.key;
    if (k === ' ' || e.code === 'Space') {
      if (el && el.tagName === 'BUTTON') return;          // let Space press the focused button
      togglePause();
    } else if (k === 'r' || k === 'R') doReset();
    else if (k === 'b' || k === 'B') phantomBrake();
    else if (k === 'h' || k === 'H') toggleHeatmap();
    else if (k === 's' || k === 'S') saveBaseline();
    else if (k === 'e' || k === 'E') openDialog('expMenu');
    else if (k === '?') openDialog('helpDlg');
    else if (k >= '1' && k <= '4') setTimeScale(SPEEDS[+k - 1]);
    else if (k === 'Escape') { selectCar(null); hidePopover(); }
    else return;
    e.preventDefault();
  });
}

//──────────────────────────── onboarding ────────────────────────────
function showOnboarding(force = false) {
  if (!force && store.get('ts-onboarded') === '1') return;
  $('onboard').hidden = false;
  requestAnimationFrame(() => $('onboard').classList.add('show'));
}
function dismissOnboarding() {
  store.set('ts-onboarded', '1');
  const o = $('onboard');
  o.classList.remove('show');
  setTimeout(() => { o.hidden = true; }, 250);
}

//──────────────────────────── wiring ────────────────────────────
function bindUI(o = {}) {
  opts = { ...opts, ...o };
  ensureSimDefaults();
  initPopover();
  buildControls({
    sim,
    onSet: (k, v) => setSim(k, v),
    onAction: k => { if (k === 'phantomBrake') phantomBrake(); },
    extraPanel: { sim: simPanelExtras() },
  });
  buildKpis();
  buildExperimentMenu();

  for (const b of $('scenarioSeg').querySelectorAll('button')) {
    b.addEventListener('click', () => setScenario(b.dataset.v));
  }
  segKeys($('scenarioSeg'));
  for (const b of $('speedSeg').querySelectorAll('button')) {
    b.addEventListener('click', () => setTimeScale(+b.dataset.v));
  }
  segKeys($('speedSeg'));
  $('btnSpeedCycle').addEventListener('click', () =>
    setTimeScale(SPEEDS[(SPEEDS.indexOf(sim.timeScale) + 1) % SPEEDS.length]));

  $('btnPause').addEventListener('click', togglePause);
  $('btnReset').addEventListener('click', doReset);
  $('qBrake').addEventListener('click', phantomBrake);
  $('insBrake').addEventListener('click', phantomBrake);
  $('qHeat').addEventListener('click', toggleHeatmap);
  $('btnExperiments').addEventListener('click', () => openDialog('expMenu'));
  $('btnHelp').addEventListener('click', () => openDialog('helpDlg'));
  $('btnBaseline').addEventListener('click', saveBaseline);
  $('btnBaseClear').addEventListener('click', clearBaseline);
  $('btnDefaults').addEventListener('click', restoreDefaults);
  $('btnShortcuts').addEventListener('click', () => openDialog('helpDlg'));
  $('btnWelcome').addEventListener('click', () => showOnboarding(true));
  $('gClose').addEventListener('click', endExperiment);
  $('gCollapse').addEventListener('click', () => {
    const c = $('guide').classList.toggle('collapsed');
    $('gCollapse').setAttribute('aria-expanded', String(!c));
    $('gCollapse').setAttribute('aria-label', c ? 'Expand guide' : 'Collapse guide');
  });
  $('gWhyBtn').addEventListener('click', () => {
    const on = $('guide').classList.toggle('showWhy');
    $('gWhyBtn').setAttribute('aria-expanded', String(on));
  });
  $('onExp').addEventListener('click', () => { dismissOnboarding(); openDialog('expMenu'); });
  $('onClose').addEventListener('click', dismissOnboarding);

  // Dialogs: close buttons + click on the backdrop.
  for (const d of document.querySelectorAll('dialog')) {
    d.querySelector('[data-close]').addEventListener('click', () => d.close());
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
  }

  bindBarToggle('ctlToggle', 'controls-open');
  bindBarToggle('metricsToggle', 'metrics-open');
  bindChartHover('tsChart', v => { tsHover = v; });
  bindChartHover('fdChart', v => { fdHover = v; });
  bindKeys();
  trackBarHeights();
  window.addEventListener('resize', () => requestAnimationFrame(drawCharts));

  updatePauseUI();
  syncSpeedUI();
  syncAll();
  setTimeout(() => showOnboarding(), 700);
}

// Legacy entry points kept for the engine hooks / main.js.
function syncControls() { ensureSimDefaults(); syncAll(); }
function updateLabels() { syncAll(); }
function onTick() { sampleTick(); }

export {
  updateMetrics, selectCar, updateInspector, updatePauseUI, syncControls,
  updateLabels, bindUI, onTick, setTimeScale, showTab,
};
