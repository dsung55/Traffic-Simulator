// Simulation property tests: run the full tick loop under several seeds and
// scenario settings and assert physical invariants after EVERY tick. These
// catch whole classes of integration/spawning/lane-change bugs without pinning
// exact behaviour, so they survive parameter tuning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, occupiesLane, triggerPhantomBrake } from '../js/engine.js';
import { sim, rampLaneIdx, densityCap, cfg } from '../js/state.js';
import { N } from '../js/config.js';
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
  { label: 'highway/default', over: { demandVph: 1500, rampDemandVph: 600 } },
  { label: 'highway/meter+incident+exit',
    over: { demandVph: 1700, rampDemandVph: 700, meterOn: true, incident: true, exitRamp: true, exitPct: 40 } },
  { label: 'highway/2lanes/fog/trucks',
    over: { demandVph: 1400, rampDemandVph: 400, lanes: 2, weather: 'fog', pctTrucks: 35, pctAgg: 25, pctPas: 25 } },
  { label: 'highway/zipper/aggressive',
    over: { demandVph: 1800, rampDemandVph: 700, mergeShape: 'zipper', pctAgg: 60 } },
  { label: 'highway/overload 2400 + ramp 1200',
    over: { demandVph: 2400, rampDemandVph: 1200, pctTrucks: 15, pctAgg: 15, pctPas: 15 } },
  { label: 'highway/4 lanes, 2-lane incident, rubbernecking',
    over: { lanes: 4, demandVph: 1600, rampDemandVph: 600, incident: true, incidentLanes: 2, pctTrucks: 10 } },
  { label: 'highway/slow reaction 1.8 s + distracted 50%',
    over: { demandVph: 1800, rampDemandVph: 500, reactionTime: 1.8, pctDistracted: 50, pctTrucks: 10 } },
  { label: 'highway/AV 60% + VSL + snow',
    over: { demandVph: 1600, rampDemandVph: 600, pctAV: 60, vslOn: true, weather: 'snow', pctTrucks: 10 } },
  { label: 'highway/truck restriction 30% trucks',
    over: { demandVph: 1600, rampDemandVph: 500, pctTrucks: 30, truckLaneRestriction: true } },
  { label: 'highway/phantom brakes', phantom: true,
    over: { demandVph: 1900, rampDemandVph: 0, reactionTime: 1.2, pctAgg: 15, pctPas: 15 } },
  { label: 'city/default',
    over: { scenario: 'city', lanes: 2, speedMph: 35, demandVph: 700, pctAgg: 15, pctPas: 15 } },
  { label: 'city/1lane/rain/greenwave',
    over: { scenario: 'city', lanes: 1, speedMph: 30, demandVph: 600, weather: 'rain', greenWave: true } },
  { label: 'city/split 0.35, distracted, snow',
    over: { scenario: 'city', lanes: 2, speedMph: 35, demandVph: 600, greenSplit: 0.35, pctDistracted: 40, weather: 'snow' } },
];

for (const { label, over, phantom } of SCENARIOS_UNDER_TEST) {
  for (const seed of [1, 42, 1337]) {
    test(`invariants hold for 300 ticks: ${label} (seed ${seed})`, () => {
      resetWorld({ pctTrucks: 10, pctAgg: 15, pctPas: 15, ...over }, seed);
      // Liveness is judged on the MEAN speed over the last 60 ticks (a full
      // signal cycle), not a single instant: with realistic acceleration a
      // city queue sampled right at the start of green is legitimately still
      // standing, yet traffic flows fine over the cycle.
      const tailAvg = [];
      for (let i = 0; i < 300; i++) {
        if (phantom && i % 40 === 20) triggerPhantomBrake(null);
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
      assert.ok(sim.evTravel.length > 0, 'no trip completed');
    });
  }
}

test('demand-driven fill: road starts empty, inflow matches demand at low load', () => {
  resetWorld({ demandVph: 900, pctTrucks: 0 }, 7);
  assert.equal(sim.cars.length, 0, 'road starts empty');
  for (let i = 0; i < 400; i++) tick();
  // Over the last 2 minutes the right edge should discharge ≈ the demand.
  const done = sim.evTravel.filter(e => e.t > sim.time - 120).length;
  const vph = done * 30;   // per 120 s → per hour
  const want = 900 * sim.lanes;
  assert.ok(Math.abs(vph - want) < want * 0.2, `served ${vph} veh/h vs demand ${want}`);
  assert.ok(sim.entryQueue <= 3, `no queue at low demand (got ${sim.entryQueue})`);
});

test('demand above capacity builds an entry queue instead of vanishing', () => {
  resetWorld({ demandVph: 2400, lanes: 2, pctTrucks: 20, pctAgg: 15, pctPas: 15 }, 3);
  for (let i = 0; i < 300; i++) tick();
  assert.ok(sim.entryQueue > 20, `expected spillback queue, got ${sim.entryQueue}`);
  assert.equal(sim.entryQueue, sim.entryQueues.reduce((a, q) => a + q.length, 0));
});

test('ramp meter throttles accel-lane releases', () => {
  // With the meter on at a long interval, ramp cars trickle out at most one
  // per interval (no queue-flush yet: storage not exceeded in 120 s).
  resetWorld({ demandVph: 1000, rampDemandVph: 600, meterOn: true, meterInterval: 12 }, 3);
  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    tick();
    for (const c of sim.cars) if (c.lane === rampLaneIdx()) seen.add(c.id);
  }
  assert.ok(seen.size <= Math.ceil(120 / 12) + 1,
    `metered ramp released ${seen.size} cars in 120 s at a 12 s interval`);
  assert.ok(sim.rampQueue > 0, 'demand above the metering rate queues on the ramp');
});
