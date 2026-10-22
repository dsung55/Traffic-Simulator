/*
 * Traffic Simulator — continuous microsimulation (IDM + MOBIL).
 *
 * Units (fixed): 1 cell = 7.5 m; 1 tick = 1 simulated second.
 * The sim advances on a wall-clock interval of TICK_MS / sim.timeScale
 * (200 ms at 1×, 25 ms at 8×); rendering runs at 60 fps via
 * requestAnimationFrame and interpolates car positions between ticks.
 */

import { TICK_MS } from './config.js';
import { sim } from './state.js';
import { tick, resetSim, setEngineHooks } from './engine.js';
import { render, resizeCanvas, invalidateScene } from './render.js';
import {
  bindUI, syncControls, updateMetrics, updateInspector, selectCar, updateLabels, onTick,
} from './ui.js';
import { applyDeviceClass } from './device.js';

//──────────────────────────── Sim clock ────────────────────────────
let tickTimer = 0;
function step() {
  if (sim.paused) return;
  tick();
  onTick();
}
// (Re)start the fixed-interval tick at the current sim speed. Called once at
// start-up and again whenever the user changes sim.timeScale.
function scheduleTicks() {
  clearInterval(tickTimer);
  const scale = sim.timeScale || 1;
  tickTimer = setInterval(step, TICK_MS / scale);
}

//──────────────────────────── Start-up ────────────────────────────
function start() {
  // Wire the engine's presentation hooks to the real UI/render callbacks. The
  // engine itself imports neither layer; this is the single seam where they meet.
  setEngineHooks({ selectCar, updateLabels, invalidateScene });
  // Tag the body mobile/desktop before building the UI so collapsible bars
  // start in the right state for the device.
  applyDeviceClass();
  bindUI({ rescheduleTicks: scheduleTicks, invalidateScene });
  syncControls();
  resizeCanvas();
  resetSim();
  scheduleTicks();
  // Metrics + charts refresh every 500 ms (continues while paused so the UI stays live).
  setInterval(updateMetrics, 500);
  updateMetrics();
  // Inspector refresh; cheap no-op when nothing is selected.
  setInterval(updateInspector, 200);
  // 60 fps render loop with interpolation.
  (function frame() { render(); requestAnimationFrame(frame); })();
}
start();
