// Mutable simulation state plus the small derived helpers everything reads.
import {
  SCENARIOS, MERGE_SHAPES, DECEL_LANE_LEN, N, MPH_PER_CELL, TRUCK_OVERRIDE,
  WEATHER, INCIDENT_CELL,
} from './config.js';
import { rng } from './rng.js';

//──────────────────────────── State ────────────────────────────
const sim = {
  scenario: 'highway',
  lanes: 3,            // main lanes
  speedMph: 65,
  // Demand-driven inflow (veh/h). demandVph is PER MAIN LANE at the left edge;
  // rampDemandVph feeds the on-ramp. The number of cars on the road is no
  // longer set directly — density emerges from demand vs. what the road can
  // carry. targetCars survives only for backwards compatibility (unused).
  demandVph: 1500,
  rampDemandVph: 600,
  targetCars: 60,
  pctTrucks: 10, pctAgg: 15, pctPas: 15,
  pctAV: 0,            // % automated vehicles (ACC control, no reaction delay)
  pctDistracted: 0,    // % of HUMAN drivers prone to attention lapses
  reactionTime: 0.8,   // s, human perception–response delay
  meterOn: false, meterInterval: 8, mergeShape: 'taper',
  incident: false,
  incidentLanes: 1,    // lanes blocked (from the right) when incident is on
  rubbernecking: true, // open-lane drivers slow down passing an incident
  truckLaneRestriction: false, // trucks banned from the leftmost lane (lane 0)
  vslOn: false,        // variable speed limit / speed harmonisation
  vslMph: 65,          // ENGINE-WRITTEN: limit currently posted on the VSL zone
  vslZone: null,       // ENGINE-WRITTEN: { start, end } cells while VSL is on
  exitRamp: false, exitPct: 20,  // off-ramp toggle + mean share of drivers exiting
  weather: 'clear',    // 'clear' | 'rain' | 'fog' | 'snow'
  cycleLen: 60, greenWave: false,
  greenSplit: 0.5,     // city: fraction of the cycle that is green for the arterial
  timeScale: 1,        // UI speed multiplier (main.js ticks faster); engine-agnostic
  paused: false,

  time: 0,             // sim ticks (= simulated seconds)
  cars: [],
  selected: null,      // car reference shown in the click-to-inspect panel
  rampQueue: 0,        // cars waiting at the meter (not yet on the accel lane)
  rampQueueTimes: [],  // arrival time of each queued ramp car (FIFO)
  rampNextArrival: null,
  meterTimer: 0,
  entryQueue: 0,       // total vehicles waiting upstream of the left edge
  entryQueues: [],     // per-lane FIFO of pre-rolled vehicles waiting to enter
  nextArrival: [],     // per-lane next arrival time (s)
  nextId: 1,
  buildings: [],       // city backdrop, generated per reset

  // rolling event logs (sim-time stamps) for windowed metrics
  evThroughput: [], evLaneChanges: [], evStops: [],
  evTravel: [],        // completed trips { t, travel, delay, stops } (last ~120 s)
  statSamples: [],     // per-tick { t, sumV, n, nMain } for rolling speed/density
  speedHistory: [],    // sparkline samples (mph), one per metrics update
  lastTickWall: (typeof performance !== 'undefined' ? performance : Date).now(),
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
// Hard population ceiling (performance guard). Physical jam spacing is
// len (≈1.5 cells) + s0 (≈0.4 cells) ≈ 1.9 cells per vehicle, i.e. ~0.53
// vehicles per cell per lane; demand-driven insertion already refuses to place
// a car where it does not fit, so this cap only binds at near-jam density.
function densityCap() {
  return Math.floor(sim.lanes * N * 0.55) + (cfg().hasRamp ? 12 : 0);
}
// Legacy: the old target-count slider, capped. Nothing in the engine uses it.
function effTarget() { return Math.min(sim.targetCars, densityCap()); }

// Active weather parameter set (falls back to clear for unknown values).
function weatherParams() { return WEATHER[sim.weather] || WEATHER.clear; }

// Incident geometry: blocked lanes are sim.lanes-1 down to
// sim.lanes - incidentLanes, at INCIDENT_CELL. At least one lane stays open.
function incidentActive() { return !!(sim.incident && cfg().hasIncident); }
function incidentLaneCount() {
  const n = Math.round(sim.incidentLanes || 1);
  return Math.max(1, Math.min(sim.lanes - 1, n));
}
function laneBlocked(lane) {
  if (!incidentActive() || lane >= sim.lanes) return false;
  return lane >= sim.lanes - incidentLaneCount();
}
function incidentCell() { return INCIDENT_CELL; }

/*
 * Continuous speed-limit model (cells/second).
 * vmaxFloat() returns the real-valued posted limit in cells/s scaled by the
 * weather free-speed factor (rain ≈ −10 %, fog ≈ −18 %, snow ≈ −28 %). This is
 * the BASE desired speed v0; each car scales it by its profile v0Mult and a
 * stable personal speedFactor, so aggressive drivers run a few mph over the
 * limit and passive a few under. Trucks are governed at TRUCK_OVERRIDE.v0Cap.
 */
function vmaxFloat() {
  const v = (sim.speedMph / MPH_PER_CELL) * weatherParams().vMul;
  return Math.max(1, v);
}
// Stable per-car desired-speed multiplier, drawn once per profile assignment.
function rollSpeedFactor(profName) {
  if (profName === 'aggressive') return 1.02 + rng() * 0.06; // a touch over
  if (profName === 'passive')    return 0.94 + rng() * 0.05; // a touch under
  if (profName === 'av')         return 1.0;                 // exactly the limit
  return 0.98 + rng() * 0.04;                                // ≈ at the limit
}
// Per-car desired free-flow speed v0 (cells/s): posted limit × profile × personal,
// capped for trucks. Weather already folded into vmaxFloat(). Location effects
// (VSL zone, rubbernecking) are applied on top by the engine (effV0).
function carV0(car) {
  let v0 = vmaxFloat() * car.prof.v0Mult * car.speedFactor;
  if (car.isTruck) v0 = Math.min(v0, car.prof.v0Cap || TRUCK_OVERRIDE.v0Cap);
  return Math.max(0.5, v0);
}
// Ideal (clear-weather, posted-limit) desired speed — the yardstick for delay.
function carV0Ideal(car) {
  let v0 = (sim.speedMph / MPH_PER_CELL) * car.prof.v0Mult * car.speedFactor;
  if (car.isTruck) v0 = Math.min(v0, car.prof.v0Cap || TRUCK_OVERRIDE.v0Cap);
  return Math.max(0.5, v0);
}
// Weather stiffens following: longer headway + a larger minimum gap.
function weatherTfactor() { return weatherParams().Tmul; }
function weatherS0add() { return weatherParams().s0add; }

export {
  sim, cfg, offRampActive, rampLaneIdx, rampLen, rampStart, rampEnd,
  decelStart, decelEnd, inAccelLane, inDecelLane,
  densityCap, effTarget, vmaxFloat, rollSpeedFactor, carV0, carV0Ideal,
  weatherTfactor, weatherS0add, weatherParams,
  incidentActive, incidentLaneCount, laneBlocked, incidentCell,
};
