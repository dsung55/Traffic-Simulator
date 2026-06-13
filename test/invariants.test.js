// Simulation property tests: run the full tick loop under several seeds and
// scenario settings and assert physical invariants after EVERY tick. These
// catch whole classes of integration/spawning/lane-change bugs without pinning
// exact behaviour, so they survive parameter tuning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, occupiesLane } from '../js/engine.js';
import { sim, rampLaneIdx, densityCap, cfg } from '../js/state.js';
import { N, MERGE_SHAPES } from '../js/config.js';
import { resetWorld } from './helpers.js';

// Deep-clipping tolerance (cells). Brief shallow overlaps can occur while a
// merge pocket collapses mid-manoeuvre (IDM then brakes hard and the abort
// logic steers back) — what must NEVER happen is one body driving through
// another, so we flag anything deeper than half a car length.
const OVERLAP_TOL = 0.75;

function checkInvariants(label) {
  const lanes = cfg().hasRamp ? sim.lanes + 1 : sim.lanes;
  for (const car of sim.cars) {
    const tag = `${label} t=${sim.time} car#${car.id}`;
    assert.ok(car.cell >= 0 && car.cell < N, `${tag}: cell ${car.cell} outside [0,N)`);
    assert.ok(car.v >= 0, `${tag}: negative speed ${car.v}`);
    assert.ok(car.laneT >= 0 && car.laneT <= 1, `${tag}: laneT ${car.laneT}`);
    assert.ok(car.lane >= 0 && car.lane < lanes, `${tag}: lane ${car.lane}`);
    if (car.lane2 != null) {
      assert.ok(car.lane2 >= 0 && car.lane2 < lanes, `${tag}: lane2 ${car.lane2}`);
      assert.notEqual(car.lane2, car.lane, `${tag}: lane2 === lane`);
    }
    const minLC = Math.min(car.laneFrom, car.laneTo) - 0.001;
    const maxLC = Math.max(car.laneFrom, car.laneTo) + 0.001;
    assert.ok(car.laneCoord >= minLC && car.laneCoord <= maxLC,
      `${tag}: laneCoord ${car.laneCoord} outside [${car.laneFrom}, ${car.laneTo}]`);
  }
  // No deep clipping: per occupied lane, consecutive bodies must not overlap
  // by more than OVERLAP_TOL.
  for (let lane = 0; lane < lanes; lane++) {
    const inLane = sim.cars.filter(c => occupiesLane(c, lane))
                           .sort((a, b) => a.cell - b.cell);
    for (let i = 0; i + 1 < inLane.length; i++) {
      const cur = inLane[i], nxt = inLane[i + 1];
      const gap = nxt.cell - cur.cell - cur.len;
      assert.ok(gap >= -OVERLAP_TOL,
        `${label} t=${sim.time} lane ${lane}: car#${nxt.id} clips car#${cur.id} (gap ${gap.toFixed(3)})`);
    }
  }
  assert.ok(sim.cars.length <= densityCap() + 8,
    `${label} t=${sim.time}: population ${sim.cars.length} blew past the cap`);
}

const SCENARIOS_UNDER_TEST = [
  { label: 'highway/default', over: { targetCars: 60 } },
  { label: 'highway/meter+incident+exit',
    over: { targetCars: 80, meterOn: true, incident: true, exitRamp: true, exitPct: 40 } },
  { label: 'highway/2lanes/fog/trucks',
    over: { targetCars: 50, lanes: 2, weather: 'fog', pctTrucks: 35, pctAgg: 25, pctPas: 25 } },
  { label: 'highway/zipper/aggressive',
    over: { targetCars: 70, mergeShape: 'zipper', pctAgg: 60 } },
  { label: 'city/default',
    over: { scenario: 'city', lanes: 2, speedMph: 35, targetCars: 40, pctAgg: 15, pctPas: 15 } },
  { label: 'city/1lane/rain/greenwave',
    over: { scenario: 'city', lanes: 1, speedMph: 30, targetCars: 25, weather: 'rain', greenWave: true } },
];

for (const { label, over } of SCENARIOS_UNDER_TEST) {
  for (const seed of [1, 42, 1337]) {
    test(`invariants hold for 300 ticks: ${label} (seed ${seed})`, () => {
      resetWorld(over, seed);
      // Liveness is judged on the MEAN speed over the last 60 ticks (a full
      // signal cycle), not a single instant: with realistic acceleration a
      // city queue sampled right at the start of green is legitimately still
      // standing, yet traffic flows fine over the cycle.
      const tailAvg = [];
      for (let i = 0; i < 300; i++) {
        tick();
        checkInvariants(label);
        if (i >= 240 && sim.cars.length) {
          tailAvg.push(sim.cars.reduce((a, c) => a + c.v, 0) / sim.cars.length);
        }
      }
      // Liveness: traffic actually flows — cars are present, moving on average,
      // and the throughput sensor has fired within the rolling window.
      assert.ok(sim.cars.length > 0, 'road went empty');
      const avgV = tailAvg.reduce((a, b) => a + b, 0) / Math.max(1, tailAvg.length);
      assert.ok(avgV > 0.2, `traffic ground to a halt (avg v ${avgV.toFixed(3)})`);
      assert.ok(sim.evThroughput.length > 0, 'sensor never fired');
    });
  }
}

test('open-road fill: population ramps from 0 toward the target and holds', () => {
  resetWorld({ targetCars: 60 }, 7);
  assert.equal(sim.cars.length, 0, 'road starts empty');
  const counts = [];
  for (let i = 0; i < 200; i++) { tick(); counts.push(sim.cars.length); }
  assert.ok(counts[10] > 0, 'inflow never started');
  assert.ok(counts[60] > counts[10], 'population not climbing');
  const late = counts.slice(150);
  const avgLate = late.reduce((a, b) => a + b, 0) / late.length;
  assert.ok(avgLate > 40 && avgLate <= 60 + MERGE_SHAPES.taper.len,
    `population should settle near 60, got ~${avgLate.toFixed(1)}`);
});

test('ramp meter throttles accel-lane releases', () => {
  // With the meter on at a long interval, ramp cars trickle out at most one
  // per interval; with it off they release whenever the entry is free.
  resetWorld({ targetCars: 60, meterOn: true, meterInterval: 12 }, 3);
  let releases = 0;
  for (let i = 0; i < 120; i++) {
    const before = sim.cars.filter(c => c.lane === rampLaneIdx()).length;
    tick();
    const after = sim.cars.filter(c => c.lane === rampLaneIdx()).length;
    if (after > before) releases += after - before;
  }
  assert.ok(releases <= Math.ceil(120 / 12) + 1,
    `metered ramp released ${releases} cars in 120 s at a 12 s interval`);
});
