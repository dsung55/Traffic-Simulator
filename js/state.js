// Mutable simulation state plus the small derived helpers everything reads.
import {
  SCENARIOS, MERGE_SHAPES, DECEL_LANE_LEN, N, MPH_PER_CELL, TRUCK_OVERRIDE,
} from './config.js';
import { rng } from './rng.js';

//──────────────────────────── State ────────────────────────────
const sim = {
  scenario: 'highway',
  lanes: 3,            // main lanes
  speedMph: 65,
  targetCars: 60,
  pctTrucks: 10, pctAgg: 15, pctPas: 15,
  meterOn: false, meterInterval: 8, mergeShape: 'taper',
  incident: false,
  exitRamp: false, exitPct: 20,  // off-ramp toggle + mean share of drivers exiting
  weather: 'clear',
  cycleLen: 60, greenWave: false,
  paused: false,

  time: 0,             // sim ticks (= simulated seconds)
  cars: [],
  selected: null,      // car reference shown in the click-to-inspect panel
  rampQueue: 0,        // cars waiting at the meter (not yet on the accel lane)
  meterTimer: 0,
  nextId: 1,
  buildings: [],       // city backdrop, generated per reset

  // rolling event logs (sim-time stamps) for windowed metrics
  evThroughput: [], evLaneChanges: [], evStops: [],
  speedHistory: [],    // sparkline samples (mph), one per metrics update
  lastTickWall: performance.now(),
};

function cfg() { return SCENARIOS[sim.scenario]; }
// Off-ramp is a user toggle on scenarios whose geometry supports one.
function offRampActive() { return sim.exitRamp && cfg().offRampCell !== undefined; }
// One auxiliary grid row sits BELOW the mainline (index === sim.lanes). It hosts
// BOTH speed-change lanes — the on-ramp ACCELERATION lane upstream and the
// off-ramp DECELERATION lane downstream. They live in disjoint cell ranges far
// apart on the road, so the single row never serves both at the same place.
function rampLaneIdx() { return sim.lanes; }
function rampLen() { return MERGE_SHAPES[sim.mergeShape].len; }
function rampStart() { return cfg().onRampCell; }
function rampEnd() { return cfg().onRampCell + rampLen() - 1; } // last usable accel-lane cell
// Off-ramp deceleration lane: opens DECEL_LANE_LEN cells upstream of the gore
// (offRampCell) and runs to it. Exit-bound drivers move into it EARLY and shed
// speed gradually toward the advisory before peeling off at the gore.
function decelStart() { return cfg().offRampCell - DECEL_LANE_LEN; } // where it opens
function decelEnd() { return cfg().offRampCell; }                    // gore / departure point
// Is `cell` within the on-ramp acceleration-lane footprint on the aux row?
function inAccelLane(cell) { return cfg().hasRamp && cell >= rampStart() - 0.5 && cell <= rampEnd() + 0.5; }
// Is `cell` within the off-ramp deceleration-lane footprint on the aux row?
function inDecelLane(cell) { return offRampActive() && cell >= decelStart() - 0.5 && cell <= decelEnd() + 0.5; }
// Jam spacing per vehicle is len (≈1.5 cells ≈ 11 m) + s0 (≈0.4 cells ≈ 3 m),
// matching real stopped-queue spacing of ~7–8 m per car-length-equivalent;
// the road could physically hold ~N/2 vehicles per lane, but we cap density
// well below jam so the simulation stays in the interesting flowing regimes.
function densityCap() { return Math.floor(sim.lanes * N * 0.30); }
function effTarget() { return Math.min(sim.targetCars, densityCap()); }

/*
 * Continuous speed-limit model (cells/second).
 * vmaxFloat() returns the real-valued posted limit in cells/s; weather
 * subtracts a fractional amount (rain ≈ −8 mph, fog ≈ −17 mph). This is the
 * BASE desired speed v0; each car scales it by its profile v0Mult and a stable
 * personal speedFactor, so aggressive drivers run a few mph over the limit and
 * passive a few under. Trucks are governed at TRUCK_OVERRIDE.v0Cap.
 */
function vmaxFloat() {
  let v = sim.speedMph / MPH_PER_CELL;
  if (sim.weather === 'rain') v -= 0.5;       // ≈ 8 mph slower in rain
  else if (sim.weather === 'fog') v -= 1.0;   // ≈ 17 mph slower in fog
  return Math.max(1, v);
}
// Stable per-car desired-speed multiplier, drawn once per profile assignment.
function rollSpeedFactor(profName) {
  if (profName === 'aggressive') return 1.02 + rng() * 0.06; // a touch over
  if (profName === 'passive')    return 0.94 + rng() * 0.05; // a touch under
  return 0.98 + rng() * 0.04;                                // ≈ at the limit
}
// Per-car desired free-flow speed v0 (cells/s): posted limit × profile × personal,
// capped for trucks. Weather already folded into vmaxFloat().
function carV0(car) {
  let v0 = vmaxFloat() * car.prof.v0Mult * car.speedFactor;
  if (car.isTruck) v0 = Math.min(v0, TRUCK_OVERRIDE.v0Cap);
  return Math.max(0.5, v0);
}
// Weather stiffens following: longer headway + a larger minimum gap in
// rain/fog. Empirically drivers add ~10–30% headway in rain/low visibility
// (often less than they should); +0.13 cells ≈ 1 m, +0.27 cells ≈ 2 m of
// extra standstill buffer, in scale with the calibrated s0 of 2–4 m.
function weatherTfactor() { return sim.weather === 'clear' ? 1 : sim.weather === 'rain' ? 1.15 : 1.3; }
function weatherS0add() { return sim.weather === 'clear' ? 0 : sim.weather === 'rain' ? 0.13 : 0.27; }

export {
  sim, cfg, offRampActive, rampLaneIdx, rampLen, rampStart, rampEnd,
  decelStart, decelEnd, inAccelLane, inDecelLane,
  densityCap, effTarget, vmaxFloat, rollSpeedFactor, carV0,
  weatherTfactor, weatherS0add,
};
