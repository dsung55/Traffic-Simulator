// The traffic "factors" a learner can toggle: each must push the system in
// the direction the traffic-engineering literature says it does. These are
// qualitative, seeded, multi-seed comparisons — they assert DIRECTION, not
// exact values, so they survive parameter tuning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, getStats, triggerPhantomBrake, sampleHeadway, INCIDENT_SPAN } from '../js/engine.js';
import { sim, laneBlocked } from '../js/state.js';
import { INCIDENT_CELL, SCENARIOS } from '../js/config.js';
import { resetWorld } from './helpers.js';

const MIX = { pctTrucks: 10, pctAgg: 15, pctPas: 15 };

// Run a configuration and return time-averaged indicators after a warm-up.
function run(over, { seeds = [1, 2], T = 500, warm = 200, every = 0 } = {}) {
  let spd = 0, sd = 0, n = 0, trips = 0;
  for (const seed of seeds) {
    resetWorld({ ...MIX, ...over }, seed);
    for (let i = 0; i < T; i++) {
      if (every && i > 100 && i % every === 0) triggerPhantomBrake(null);
      tick();
      if (i >= warm) {
        const main = sim.cars.filter(c => c.lane < sim.lanes);
        if (!main.length) continue;
        const m = main.reduce((a, c) => a + c.v, 0) / main.length;
        spd += m;
        sd += Math.sqrt(main.reduce((a, c) => a + (c.v - m) ** 2, 0) / main.length);
        n++;
      }
    }
    trips += sim.evTravel.filter(e => e.t > sim.time - 120).length;
  }
  return { spd: spd / n, sd: sd / n, trips: trips / seeds.length };
}

test('getStats returns every contract field as a number', () => {
  resetWorld({ demandVph: 1200, rampDemandVph: 500, vslOn: true });
  const keys = ['avgSpeedMph', 'flowVphPerLane', 'densityVpmPerLane', 'meanTravelTimeS',
    'meanDelayS', 'stopsPerVeh', 'vehOnRoad', 'laneChangesPerMin', 'rampQueue', 'throughputPerMin',
    'entryQueue', 'meanEntryWaitS', 'meanRampWaitS', 'vslMph', 'meanWaitS', 'meanTotalTimeS', 'hardBrakePct'];
  const s0 = getStats();
  for (const k of keys) assert.equal(typeof s0[k], 'number', `${k} at t=0`);
  assert.ok(Number.isNaN(s0.meanTravelTimeS), 'unknown before any trip completes');
  for (let i = 0; i < 150; i++) tick();
  const s = getStats();
  for (const k of keys) assert.ok(Number.isFinite(s[k]), `${k} finite after 150 s (got ${s[k]})`);
  assert.ok(s.avgSpeedMph > 40 && s.avgSpeedMph < 80);
  assert.ok(s.meanTravelTimeS > 15 && s.meanTravelTimeS < 60, `travel ${s.meanTravelTimeS}`);
  assert.ok(s.meanDelayS >= 0 && s.meanDelayS < s.meanTravelTimeS);
  assert.ok(s.meanTotalTimeS >= s.meanTravelTimeS - 1e-9, 'total time includes the queue wait');
  assert.equal(s.vehOnRoad, sim.cars.length);
  assert.ok(Array.isArray(sim.evTravel) && sim.evTravel.every(e => 'travel' in e && 'delay' in e && 't' in e));
  assert.ok(sim.vslZone && sim.vslZone.end > sim.vslZone.start, 'vslZone set while VSL is on');
});

test('defaults sit below capacity: queues stay bounded over 600 s', () => {
  const H = SCENARIOS.highway;
  resetWorld({ ...MIX, demandVph: H.defaultDemandVph, rampDemandVph: H.defaultRampDemandVph }, 5);
  for (let i = 0; i < 600; i++) tick();
  const s = getStats();
  assert.ok(sim.entryQueue < 10, `entry queue ${sim.entryQueue}`);
  assert.ok(sim.rampQueue < 10, `ramp queue ${sim.rampQueue}`);
  assert.ok(s.avgSpeedMph > 50, `default speed ${s.avgSpeedMph}`);
  // Trip time is measured from entering the road: ≈ free-flow traversal.
  assert.ok(s.meanTravelTimeS < 35, `travel ${s.meanTravelTimeS}`);
});

test('shifted-exponential headways: mean matches demand, none below t_min', () => {
  resetWorld({}, 9);
  const hs = Array.from({ length: 4000 }, () => sampleHeadway(3, 1));
  const mean = hs.reduce((a, b) => a + b, 0) / hs.length;
  assert.ok(Math.abs(mean - 3) < 0.15, `mean ${mean}`);
  assert.ok(Math.min(...hs) >= 1);
});

test('travel time excludes the entry-queue wait, which is reported separately', () => {
  resetWorld({ ...MIX, demandVph: 2400, lanes: 2 }, 4);
  for (let i = 0; i < 400; i++) tick();
  const s = getStats();
  assert.ok(sim.entryQueue > 10, 'oversaturated: queue upstream');
  assert.ok(s.meanEntryWaitS > 10, `queue wait reported (${s.meanEntryWaitS})`);
  assert.ok(s.meanTravelTimeS < s.meanEntryWaitS + 60);
  assert.ok(sim.evTravel.every(e => e.travel < 200), 'on-road trip times stay bounded');
});

test('long reaction time destabilises traffic; AVs damp the waves (phantom-brake demo)', () => {
  const base = { demandVph: 1800, rampDemandVph: 0, reactionTime: 1.2 };
  const human = run(base, { every: 60 });
  const mixed = run({ ...base, pctAV: 50 }, { every: 60 });
  const quick = run({ ...base, reactionTime: 0.3 }, { every: 60 });
  assert.ok(mixed.spd > human.spd + 0.3, `AV 50% faster (${mixed.spd} vs ${human.spd})`);
  assert.ok(mixed.sd < human.sd, `AV 50% smoother (sd ${mixed.sd} vs ${human.sd})`);
  assert.ok(quick.spd > human.spd + 0.3, `short reaction faster (${quick.spd} vs ${human.spd})`);
});

test('ramp metering keeps the mainline moving at high demand', () => {
  const base = { demandVph: 1900, rampDemandVph: 900 };
  const off = run(base, { T: 600 });
  const on = run({ ...base, meterOn: true, meterInterval: 4 }, { T: 600 });
  assert.ok(on.spd > off.spd, `metered mainline faster (${on.spd} vs ${off.spd})`);
});

test('weather: speeds fall clear > rain > snow', () => {
  const base = { demandVph: 1000, rampDemandVph: 0 };
  const clear = run(base, { seeds: [1], T: 300, warm: 120 });
  const rain = run({ ...base, weather: 'rain' }, { seeds: [1], T: 300, warm: 120 });
  const snow = run({ ...base, weather: 'snow' }, { seeds: [1], T: 300, warm: 120 });
  assert.ok(clear.spd > rain.spd && rain.spd > snow.spd, `${clear.spd} > ${rain.spd} > ${snow.spd}`);
});

test('incident: no vehicle ever drives through the wreck in a blocked lane', () => {
  for (const lanesBlocked of [1, 2]) {
    resetWorld({ ...MIX, lanes: 4, demandVph: 900, rampDemandVph: 300, incident: true, incidentLanes: lanesBlocked }, 11);
    for (let i = 0; i < 300; i++) {
      tick();
      for (const c of sim.cars) {
        for (const l of [c.lane, c.lane2]) {
          if (l == null || !laneBlocked(l)) continue;
          const overlaps = c.cell + c.len > INCIDENT_CELL + 0.05 && c.cell < INCIDENT_CELL + INCIDENT_SPAN;
          assert.ok(!overlaps, `car#${c.id} inside the wreck in lane ${l} at t=${sim.time}`);
        }
      }
    }
  }
});

test('incident cuts throughput well beyond the blocked lane share', () => {
  const base = { demandVph: 1200, rampDemandVph: 0 };
  const clear = run(base, { T: 400 });
  const inc = run({ ...base, incident: true }, { T: 400 });
  // One of three lanes closed, yet speeds collapse far more than a third.
  assert.ok(inc.spd < clear.spd * 0.67, `incident speed ${inc.spd} vs ${clear.spd}`);
});

test('truck lane restriction keeps heavy vehicles out of lane 0', () => {
  resetWorld({ demandVph: 1200, rampDemandVph: 400, pctTrucks: 40, truckLaneRestriction: true }, 6);
  let trucksSeen = 0;
  for (let i = 0; i < 300; i++) {
    tick();
    for (const c of sim.cars) {
      if (!c.isTruck) continue;
      trucksSeen++;
      assert.notEqual(c.lane, 0, `truck #${c.id} in the left lane at t=${sim.time}`);
      assert.notEqual(c.lane2, 0);
    }
  }
  assert.ok(trucksSeen > 0);
});

test('distraction: prone drivers have lapses; AVs never do', () => {
  resetWorld({ demandVph: 1000, pctDistracted: 50, pctAV: 30 }, 8);
  let lapses = 0;
  for (let i = 0; i < 200; i++) {
    tick();
    for (const c of sim.cars) {
      if (c.distracted) { lapses++; assert.ok(!c.isAV && c.distractProne); }
    }
  }
  assert.ok(lapses > 0, 'some attention lapses occurred');
});

test('phantom brake: chosen car brakes hard for ~2 s, then recovers', () => {
  resetWorld({ demandVph: 1000, rampDemandVph: 0 }, 2);
  for (let i = 0; i < 80; i++) tick();
  const car = triggerPhantomBrake(null);
  assert.ok(car, 'a mid-road car was chosen');
  const v0 = car.v;
  tick(); tick();
  assert.ok(car.v < v0 - 0.7, `slowed by > 12 mph (from ${v0} to ${car.v})`);
  assert.ok(car.braking);
  for (let i = 0; i < 3; i++) tick();
  assert.equal(car.phantom, false, 'phantom episode over');
  assert.equal(triggerPhantomBrake(car), car, 'explicit car accepted');
});

test('VSL posts a lower limit when the bottleneck congests and restores it later', () => {
  resetWorld({ ...MIX, demandVph: 1900, rampDemandVph: 900, vslOn: true }, 3);
  let minPosted = sim.speedMph;
  for (let i = 0; i < 400; i++) { tick(); minPosted = Math.min(minPosted, sim.vslMph); }
  assert.ok(minPosted < sim.speedMph, `VSL never engaged (min ${minPosted})`);
  assert.ok(minPosted >= 30 && minPosted % 5 === 0);
  sim.vslOn = false; tick();
  assert.equal(sim.vslZone, null);
  assert.equal(sim.vslMph, sim.speedMph);
});

test('city: a longer arterial green split passes more traffic', () => {
  const base = { scenario: 'city', lanes: 2, speedMph: 35, demandVph: 700 };
  const short = run({ ...base, greenSplit: 0.35 }, { seeds: [1], T: 400 });
  const long = run({ ...base, greenSplit: 0.65 }, { seeds: [1], T: 400 });
  assert.ok(long.trips > short.trips, `split .65 trips ${long.trips} vs .35 ${short.trips}`);
});
