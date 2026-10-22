// Live traffic statistics for the metrics panel: wraps the engine's
// getStats() (falling back to what can be computed from `sim` when the engine
// doesn't provide it), keeps a time series sampled in SIMULATED time, and
// derives Level of Service and a plain-language verdict.
import * as engine from '../engine.js';
import { MPH_PER_CELL, ROAD_MILES, N } from '../config.js';
import { sim, cfg, carV0 } from '../state.js';

const SAMPLE_EVERY = 2;      // sim seconds between history samples
const KEEP_S = 600;          // history kept (sim s): 10 min feeds the scatter
export const CHART_WINDOW = 300; // time-series window shown (sim s)

export const history = [];   // { t, avgSpeedMph, flowVphPerLane, ... }
let lastSampleT = -Infinity;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

function mainlineCars() {
  return sim.cars.filter(c => c.lane < sim.lanes);
}

// Fallback for engines without getStats(): everything derivable from sim.
function fallbackStats() {
  const cars = mainlineCars();
  const lanes = Math.max(1, sim.lanes);
  const win = Math.min(60, Math.max(1, sim.time));
  const thru = (sim.evThroughput || []).filter(t => t > sim.time - 60).length;
  const trips = (sim.evTravel || []).filter(e => e.t > sim.time - 120);
  const stops = (sim.evStops || []).filter(t => t > sim.time - 120).length;
  const passed120 = (sim.evThroughput || []).filter(t => t > sim.time - 120).length;
  // Without completed-trip records, estimate travel time / delay from space-
  // mean speeds over the section (length / mean speed vs. length / mean desired speed).
  let tt = trips.length ? mean(trips.map(e => e.travel)) : NaN;
  let dl = trips.length ? mean(trips.map(e => e.delay)) : NaN;
  if (!trips.length && cars.length && sim.time > 20) {
    const v = mean(cars.map(c => c.v)), v0 = mean(cars.map(c => carV0(c)));
    if (v > 0.05) { tt = N / v; dl = Math.max(0, N / v - N / v0); }
  }
  let rampQueue = NaN;
  if (cfg().hasRamp) rampQueue = (sim.rampQueue || 0) + sim.cars.filter(c => c.lane === sim.lanes).length;
  return {
    avgSpeedMph: cars.length ? mean(cars.map(c => c.v)) * MPH_PER_CELL : NaN,
    flowVphPerLane: sim.time > 5 ? thru * (3600 / win) / lanes : NaN,
    densityVpmPerLane: cars.length / ROAD_MILES / lanes,
    meanTravelTimeS: tt,
    meanDelayS: dl,
    stopsPerVeh: passed120 ? stops / Math.max(passed120, cars.length) : NaN,
    vehOnRoad: sim.cars.length,
    laneChangesPerMin: (sim.evLaneChanges || []).filter(t => t > sim.time - 60).length,
    rampQueue,
    throughputPerMin: thru * (60 / win),
    ...(sim.entryQueue !== undefined ? { entryQueue: sim.entryQueue } : {}),
  };
}

export const hasEngineStats = () => typeof engine.getStats === 'function';

export function readStats() {
  if (hasEngineStats()) {
    try {
      const s = engine.getStats();
      if (s && typeof s === 'object') return { ...fallbackStats(), ...s };
    } catch (e) { /* engine mid-change: fall through */ }
  }
  return fallbackStats();
}

// Called after every engine tick (from main.js). Samples on sim time so the
// charts look the same at 1× and 8×.
export function sampleTick() {
  if (sim.time < lastSampleT) clearHistory();          // a reset happened
  if (sim.time - lastSampleT < SAMPLE_EVERY) return;
  lastSampleT = sim.time;
  history.push({ t: sim.time, ...readStats() });
  while (history.length && history[0].t < sim.time - KEEP_S) history.shift();
}

export function clearHistory() { history.length = 0; lastSampleT = -Infinity; }

// Mean of each stat over the last `secs` sim seconds of history.
export function windowMean(secs) {
  const rows = history.filter(r => r.t > sim.time - secs);
  if (!rows.length) return null;
  const out = {};
  for (const k of Object.keys(rows[rows.length - 1])) {
    if (k === 't') continue;
    const vals = rows.map(r => r[k]).filter(Number.isFinite);
    out[k] = vals.length ? mean(vals) : NaN;
  }
  out.n = rows.length;
  return out;
}

// Speed relative to what drivers WANT to do (accounts for weather, trucks,
// driver mix) — the clearest single congestion signal.
export function speedRatio() {
  const cars = mainlineCars();
  if (!cars.length) return NaN;
  let v = 0, v0 = 0, stopped = 0;
  for (const c of cars) {
    const want = carV0(c);
    v += c.v; v0 += want;
    if (c.v < 0.2 * want) stopped++;
  }
  return { ratio: v / v0, stoppedFrac: stopped / cars.length, n: cars.length };
}

// Highway Capacity Manual Level of Service. Freeways are graded by density
// (pc/mi/ln), signalised arterials by control delay per vehicle per signal.
export function levelOfService(stats) {
  if (cfg().lightCells) {
    const per = stats.meanDelayS / cfg().lightCells.length;
    if (!Number.isFinite(per)) return null;
    const cuts = [10, 20, 35, 55, 80];
    const i = cuts.findIndex(c => per <= c);
    return { grade: 'ABCDEF'[i < 0 ? 5 : i], basis: `${per.toFixed(0)} s delay per signal` };
  }
  const k = stats.densityVpmPerLane;
  if (!Number.isFinite(k)) return null;
  const cuts = [11, 18, 26, 35, 45];
  const i = cuts.findIndex(c => k <= c);
  return { grade: 'ABCDEF'[i < 0 ? 5 : i], basis: `${k.toFixed(0)} veh/mi/lane` };
}

// Plain-language one-liner + status level ('good' | 'warn' | 'bad' | 'idle').
export function verdict(stats) {
  if (sim.time < 25 || sim.cars.length < 3) {
    return { level: 'idle', text: 'Warming up: traffic is entering from the left. Give it a minute to settle.' };
  }
  const r = speedRatio();
  if (!r || !Number.isFinite(r.ratio)) return { level: 'idle', text: 'Waiting for traffic…' };
  const tags = [];
  if (sim.incident && cfg().hasIncident) tags.push('incident bottleneck');
  if (Number.isFinite(stats.rampQueue) && stats.rampQueue >= 12) tags.push('ramp queue building');
  const tail = tags.length ? ` (${tags.join(', ')})` : '';

  // Spillback: more vehicles arrive than the section can absorb.
  const eq = stats.entryQueue;
  if (Number.isFinite(eq) && eq >= 15) {
    const old = history.find(h => h.t >= sim.time - 60);
    const growing = old && Number.isFinite(old.entryQueue) && eq > old.entryQueue + 3;
    return { level: 'bad', text: `Demand exceeds capacity: ${Math.round(eq)} vehicles are queued upstream` +
      (growing ? ' and the queue keeps growing.' : '.') + (tags.length ? ` Also: ${tags.join(', ')}.` : '') };
  }

  if (cfg().lightCells) {
    const st = stats.stopsPerVeh;
    if (r.ratio > 0.8 && (!Number.isFinite(st) || st < 0.6)) return { level: 'good', text: 'Platoons are rolling through the signals with few stops.' };
    if (r.stoppedFrac > 0.45 || st > 2) return { level: 'bad', text: 'Queues at every light: cars stop again and again. Try a green wave or more green time.' };
    return { level: 'warn', text: 'Typical city flow: most cars stop at a light or two.' };
  }
  if (r.ratio >= 0.9) return { level: 'good', text: 'Free flow: drivers are cruising at their desired speed.' + tail };
  if (r.stoppedFrac > 0.08 && r.ratio < 0.75) return { level: 'bad', text: 'Flow is breaking down: stop-and-go waves are forming and travelling upstream.' + tail };
  if (r.ratio < 0.45) return { level: 'bad', text: 'Heavy congestion: a queue is spilling back upstream.' + tail };
  if (r.ratio >= 0.75) {
    if (stats.flowVphPerLane > 1600) return { level: 'warn', text: 'Near capacity: flow is high but fragile. One hard brake could start a jam.' + tail };
    return { level: 'good', text: 'Mostly smooth: minor slowdowns from merging and lane changes.' + tail };
  }
  return { level: 'warn', text: 'Slowing down: the road is getting dense and speeds are dropping.' + tail };
}
