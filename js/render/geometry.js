// World-space layout of both scenes, derived from the canvas size and the
// sim's lane/ramp configuration. Shared by the static painters, the dynamic
// props, and the vehicle pass (ramp entry glides, exit ghosts, queue stacking)
// so every layer agrees on exactly where the asphalt is. Memoised on a small
// signature; recomputed only when the layout changes.
import { N, SENSOR_CELL } from '../config.js';
import {
  sim, cfg, offRampActive, rampStart, rampEnd, decelStart, decelEnd,
} from '../state.js';
import { view, cw, roadTop } from './view.js';
import { bezierLUT } from './util.js';

let memoSig = '', memo = null;

export function geo() {
  const sig = view.W + '|' + view.H + '|' + view.laneH + '|' + sim.scenario + '|' +
              sim.lanes + '|' + sim.mergeShape + '|' + offRampActive();
  if (sig !== memoSig) { memoSig = sig; memo = build(); }
  return memo;
}

function build() {
  const W = view.W, H = view.H, LH = view.laneH, c = cw();
  const top = roadTop(), rh = sim.lanes * LH;
  const g = { W, H, LH, c, top, rh, ry: top + rh, style: cfg().style };
  if (g.style === 'city') return buildCity(g);
  return buildHighway(g);
}

function buildHighway(g) {
  const { W, H, LH, c, top, ry } = g;
  g.ay = ry + LH;                                   // bottom of the aux (accel/decel) row
  g.innerSh = Math.max(4, LH * 0.42);               // paved median-side shoulder
  g.outerSh = Math.max(5, LH * 0.55);               // paved right shoulder
  g.barrierW = Math.max(3, LH * 0.2);               // concrete median barrier
  g.barrierY = top - g.innerSh - g.barrierW;        // barrier top edge
  // Cross roads that bridge over the freeway (a diamond interchange): the
  // on-ramp leaves the western one, the off-ramp joins the eastern one.
  g.crossW = Math.max(12, Math.min(2 * LH, 3.2 * c));
  g.crossX = [4.3 * c, 79.6 * c];
  // Overpass deck vertical extent (spans shoulders, barrier and both rails).
  g.deckY0 = g.barrierY - LH * 0.9;
  g.deckY1 = g.ay + g.outerSh + LH * 0.9;
  // Ramp terminals sit a couple of lanes below the freeway on the cross road.
  const yR = Math.min(H - LH * 1.2, g.ay + g.outerSh + LH * 2.0);
  g.rampY = yR;

  // On-ramp: S-curve from the western cross road to the accel-lane entry.
  g.rsX = rampStart() * c;
  g.reX = (rampEnd() + 1) * c;
  g.taper = Math.min(LH * 2.2, (g.reX - g.rsX) * 0.45);
  const laneMid = ry + LH / 2;
  {
    const sx = g.crossX[0] + g.crossW / 2, ex = g.rsX, k = (ex - sx) * 0.5;
    g.onLUT = bezierLUT({ x: sx, y: yR }, { x: sx + k, y: yR }, { x: ex - k, y: laneMid }, { x: ex, y: laneMid });
  }
  // Off-ramp: deceleration lane (aux row) to the gore, then an S-curve down
  // to the eastern cross road. Exiting cars' ghosts follow this curve.
  g.hasOff = offRampActive();
  g.dsX = decelStart() * c;
  g.ox = decelEnd() * c;
  g.open = Math.min(LH * 2.2, (g.ox - g.dsX) * 0.35);
  {
    const sx = g.ox, ex = g.crossX[1] - g.crossW / 2, k = (ex - sx) * 0.5;
    g.offLUT = bezierLUT({ x: sx, y: laneMid }, { x: sx + k, y: laneMid }, { x: ex - k, y: yR }, { x: ex, y: yR });
  }
  g.sensorX = SENSOR_CELL * c;
  // Light poles on the median barrier.
  g.poleX = [];
  for (let cell = 10; cell < N - 3; cell += 17) g.poleX.push(cell * c);
  return g;
}

function buildCity(g) {
  const { LH, c, top, rh } = g;
  g.parkW = LH * 0.85;                              // parking lane each side
  g.walkW = LH * 1.15;                              // sidewalk each side
  g.curbTop = top - g.parkW;                        // near curb (top side)
  g.curbBot = top + rh + g.parkW;                   // far curb (bottom side)
  g.walkTop = g.curbTop - g.walkW;
  g.walkBot = g.curbBot + g.walkW;
  g.cwW = Math.max(6, LH * 0.7);                    // crosswalk width
  g.csW = Math.max(14, Math.min(2 * LH, 3.4 * c));  // cross-street width
  // Each signalised intersection: stop line at the light cell, a crosswalk,
  // the cross street, then the far crosswalk.
  g.inters = cfg().lightCells.map(lc => {
    const stop = lc * c;
    const cw0 = stop + Math.max(1.5, LH * 0.12);
    const sx0 = cw0 + g.cwW + Math.max(1, LH * 0.08);
    const sx1 = sx0 + g.csW;
    return { lc, stop, cw0, sx0, sx1, cw1: sx1 + Math.max(1, LH * 0.08) };
  });
  return g;
}
