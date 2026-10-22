// Shared renderer state: canvas size, device pixel ratio, adaptive lane height,
// the camera, and the per-frame clock. Every render/* module reads these from
// here so there is exactly one source of truth (render.js writes them).
import { N, TICK_MS } from '../config.js';
import { sim, cfg } from '../state.js';

export const view = {
  W: 0, H: 380, dpr: 1,
  laneH: 26,          // lane height in CSS px (adaptive to the canvas width)
  nowMs: performance.now(),
  frameDt: 16,
};

// Camera: `cam` is what is DRAWN each frame; `camT` is the target the controls
// write. Screen→world: w = s / z + cam.
export const cam = { z: 1, x: 0, y: 0 };
export const camT = { z: 1, x: 0, y: 0 };

// Cell width in CSS px (the road always spans the full canvas width at 1×).
export function cw() { return view.W / N; }

// Lane height scales with the cell width so a lane is ~1.5 cells tall on
// desktop (26 px) but doesn't balloon into a mostly-empty band on phones.
export function computeLaneH() {
  const c = view.W / N;
  return Math.max(14, Math.min(26, Math.round(c * 1.5)));
}

// Vertically centre the road band. Highway scenarios add the auxiliary
// (accel/decel) row below the mainline.
export function roadTop() {
  const rows = sim.lanes + (cfg().hasRamp ? 1 : 0);
  return Math.max(40, Math.round((view.H - rows * view.laneH) / 2));
}

// Effective wall-clock length of one sim tick at the current speed multiplier.
export function tickMs() { return TICK_MS / (sim.timeScale || 1); }

// Visible world rectangle (with optional padding in world px).
export function viewRect(pad = 0) {
  return {
    x0: cam.x - pad, y0: cam.y - pad,
    x1: cam.x + view.W / cam.z + pad, y1: cam.y + view.H / cam.z + pad,
  };
}
