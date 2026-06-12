/*
 * Traffic Simulator — continuous microsimulation (IDM + MOBIL).
 *
 * Units (fixed): 1 cell = 7.5 m; 1 tick = 1 simulated second.
 * Positions (car.cell) and speeds (car.v, cells/second) are now FLOATS:
 *   1 cell/s = 7.5 m/s ≈ 16.8 mph. Vehicles have physical lengths (car.len,
 *   ~1.5 cells for cars, ~3.75 for trucks) used by every gap computation.
 * Longitudinal motion is the Intelligent Driver Model (IDM); lane changes are
 * MOBIL-motivated but run a realistic phase machine (signal → wait for a safe
 * gap, with cooperative yielding → smooth ~4.5 s steer-over, abortable). Each tick
 * integrates IDM over SUBSTEPS sub-steps (dt = 1/SUBSTEPS s) for stability and
 * advances sim.time by 1 (= one simulated second). The sim advances on a fixed
 * 200 ms wall-clock interval; rendering runs at 60 fps via requestAnimationFrame
 * and lerps car positions between ticks.
 */

import { TICK_MS } from './config.js';
import { sim } from './state.js';
import { tick, resetSim, setEngineHooks } from './engine.js';
import { render, resizeCanvas, invalidateScene } from './render.js';
import {
  bindUI, syncControls, updateMetrics, updateInspector, selectCar, updateLabels,
} from './ui.js';

//──────────────────────────── Loops ────────────────────────────
function start() {
  // Wire the engine's presentation hooks to the real UI/render callbacks. The
  // engine itself imports neither layer (no cycle, no DOM dependency); this is
  // the single seam where they meet.
  setEngineHooks({ selectCar, updateLabels, invalidateScene });
  bindUI();
  syncControls();
  resizeCanvas();
  resetSim();
  // Fixed-interval sim tick (200 ms = 1 simulated second), independent of rendering.
  setInterval(() => { if (!sim.paused) tick(); }, TICK_MS);
  // Metrics refresh every 500 ms (continues while paused so UI stays live).
  setInterval(updateMetrics, 500);
  // Inspector refresh once per sim tick; cheap no-op when nothing is selected.
  setInterval(updateInspector, 200);
  // 60 fps render loop with interpolation.
  (function frame() { render(); requestAnimationFrame(frame); })();
}
start();
