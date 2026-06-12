// Mutable simulation state plus the small derived helpers everything reads.
import { SCENARIOS, MERGE_SHAPES, N, MPH_PER_CELL, TRUCK_OVERRIDE } from './config.js';
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
function rampLaneIdx() { return sim.lanes; }                  // accel lane sits below mainline
function rampLen() { return MERGE_SHAPES[sim.mergeShape].len; }
function rampStart() { return cfg().onRampCell; }
function rampEnd() { return cfg().onRampCell + rampLen() - 1; } // last usable accel-lane cell
// Jam spacing per vehicle is now len (≈1.5 cells) + s0 (≈1.4), so the road
// physically holds ~N/3 vehicles per lane; cap a little under that.
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
// Weather stiffens following: longer headway + stronger braking in rain/fog.
function weatherTfactor() { return sim.weather === 'clear' ? 1 : sim.weather === 'rain' ? 1.15 : 1.3; }
function weatherS0add() { return sim.weather === 'clear' ? 0 : sim.weather === 'rain' ? 0.3 : 0.5; }

export {
  sim, cfg, offRampActive, rampLaneIdx, rampLen, rampStart, rampEnd,
  densityCap, effTarget, vmaxFloat, rollSpeedFactor, carV0,
  weatherTfactor, weatherS0add,
};
