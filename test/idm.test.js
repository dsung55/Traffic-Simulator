// IDM car-following math: free-road acceleration, equilibrium, braking,
// clamping, weather stiffening and virtual obstacles (red lights, incident,
// end-of-ramp wall) acting as stationary leaders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idmAccel, accelInLane, effV0 } from '../js/engine.js';
import { carV0, sim, rampEnd, rampLaneIdx, laneBlocked } from '../js/state.js';
import { B_SAFE, INCIDENT_CELL, MPH_PER_CELL } from '../js/config.js';
import { resetWorld, placeCar } from './helpers.js';

test('free road, well below desired speed: accelerates', () => {
  resetWorld();
  const car = placeCar({ v: 1 });
  const acc = idmAccel(car, 100, car.v);
  // Near full throttle for the profile — but full throttle is now a realistic
  // ~1.4 m/s² (0.19 cells/s²), not the old 12 m/s².
  assert.ok(acc > 0.1, `expected near-max acceleration, got ${acc}`);
  assert.ok(acc <= car.prof.a * 1.6 + 1e-12, "never exceeds the profile max (with the from-stop launch boost)");
});

test('at desired speed v0 on a free road: acceleration ~ 0', () => {
  resetWorld();
  const car = placeCar({ v: 1 });
  car.v = carV0(car);
  const acc = idmAccel(car, 1000, car.v);
  assert.ok(Math.abs(acc) < 0.05, `expected ~0, got ${acc}`);
});

test('IDM+ equilibrium: zero acceleration at s = s0 + vT behind a matched-speed leader', () => {
  resetWorld({ reactionTime: 0 });
  const car = placeCar({ v: 3 });
  const { s0, T } = car.prof;
  // IDM+ (Schakel et al. 2010): a = a·min(1 − (v/v0)^4, 1 − (s*/s)²), so with
  // dv = 0 the equilibrium gap is exactly s* = s0 + vT for every v < v0.
  const sEq = s0 + car.v * T;
  assert.ok(Math.abs(idmAccel(car, sEq, car.v)) < 1e-9);
  // Tighter than equilibrium brakes; looser accelerates.
  assert.ok(idmAccel(car, sEq * 0.7, car.v) < 0);
  assert.ok(idmAccel(car, sEq * 1.5, car.v) > 0);
});

test('over the desired speed (e.g. entering a lower limit) a car eases down at most at b', () => {
  resetWorld();
  const car = placeCar({ v: 1 });
  car.v = carV0(car) * 1.6;
  const acc = idmAccel(car, 1000, car.v);
  assert.ok(acc < 0, 'decelerates toward v0');
  assert.ok(acc >= -car.prof.b - 1e-9, `no harsh braking on a free road (got ${acc})`);
});

test('human anticipation: closing on a slower leader brakes earlier than an AV would at the same gap', () => {
  resetWorld({ reactionTime: 1.2 });
  const human = placeCar({ v: 3.5 });
  const av = placeCar({ v: 3.5 });
  av.isAV = true;
  const h = idmAccel(human, 8, 2.5);
  resetWorld({ reactionTime: 0 });
  const h0 = idmAccel(placeCar({ v: 3.5 }), 8, 2.5);
  assert.ok(h < h0, 'a longer reaction time makes a human more cautious while closing');
  assert.ok(Number.isFinite(idmAccel(av, 8, 2.5, -0.2)));
});

test('ACC (AV) does not over-brake for a cut-in that is pulling away', () => {
  resetWorld({ reactionTime: 0 });
  const av = placeCar({ v: 3.5 });
  av.isAV = true; av.prof = { ...av.prof };
  const human = placeCar({ v: 3.5 });
  // A car cuts in 2 cells ahead, slightly faster and accelerating.
  const aAV = idmAccel(av, 2, 3.7, 0.1);
  const aH = idmAccel(human, 2, 3.7);
  assert.ok(aAV > aH, `ACC/CAH should react more calmly (AV ${aAV}, human ${aH})`);
});

test('braking is clamped at -2*B_SAFE even on overlap; accel capped at prof.a', () => {
  resetWorld();
  const car = placeCar({ v: 4 });
  // Negative gap (overlap) against a stopped leader: the s = max(0.05, gap)
  // guard plus the clamp must keep the result finite and bounded.
  const acc = idmAccel(car, -0.5, 0);
  assert.ok(Number.isFinite(acc));
  assert.equal(acc, -B_SAFE * 2);
  assert.ok(idmAccel(car, 1e6, 0) <= car.prof.a + 1e-12);
});

test('rain, fog and snow stiffen following: less acceleration at the same gap', () => {
  const gap = 6, v = 2.5;
  const at = w => { resetWorld({ weather: w }); return idmAccel(placeCar({ v }), gap, v); };
  const clear = at('clear'), rain = at('rain'), fog = at('fog'), snow = at('snow');
  assert.ok(rain < clear, `rain ${rain} should be < clear ${clear}`);
  assert.ok(fog < rain, `fog ${fog} should be < rain ${rain}`);
  assert.ok(snow < fog, `snow ${snow} should be < fog ${fog}`);
});

test('snow lowers the emergency braking ceiling (less tyre grip)', () => {
  resetWorld({ weather: 'snow' });
  const acc = idmAccel(placeCar({ v: 3 }), -0.5, 0);
  assert.ok(acc > -B_SAFE * 2 && acc < -0.4, `snow emergency brake ${acc}`);
});

test('red light acts as a stationary virtual leader (city)', () => {
  // City lights at cells [21, 46, 71]; cycle 60 => green 30s, yellow 4s, red 26s.
  // t = 40 is in the red window for every light (no green wave => offset 0).
  resetWorld({ scenario: 'city', lanes: 2 });
  sim.time = 40;
  const car = placeCar({ lane: 0, cell: 16, v: 3 });
  const atRed = accelInLane(car, 0);
  sim.time = 10; // green
  const atGreen = accelInLane(car, 0);
  assert.ok(atRed < -0.5, `expected braking for red, got ${atRed}`);
  assert.ok(atGreen > 0, `expected free acceleration on green, got ${atGreen}`);
});

test('incident blocks ONLY the rightmost lane', () => {
  resetWorld({ incident: true, rubbernecking: false });
  const right = placeCar({ lane: sim.lanes - 1, cell: INCIDENT_CELL - 5, v: 3 });
  const inner = placeCar({ lane: 0, cell: INCIDENT_CELL - 5, v: 3 });
  assert.ok(accelInLane(right, right.lane) < -0.5, 'rightmost lane should brake');
  assert.ok(accelInLane(inner, inner.lane) > 0, 'inner lane should flow');
});

test('end-of-ramp wall brakes accel-lane cars; skipWall ignores it', () => {
  resetWorld(); // highway: on-ramp accel lane ends at rampEnd() (the gore wall)
  // Sit just shy of the gore wall in the acceleration lane (ramp lane = sim.lanes).
  const car = placeCar({ lane: rampLaneIdx(), cell: rampEnd() - 1.5, v: 3 });
  assert.ok(accelInLane(car, car.lane) < -0.5, 'should brake for the wall');
  assert.ok(accelInLane(car, car.lane, true) > 0, 'skipWall should see open road');
});

test('multi-lane incident: incidentLanes blocks lanes from the right, at least one stays open', () => {
  resetWorld({ incident: true, incidentLanes: 2, rubbernecking: false });
  const l2 = placeCar({ lane: 2, cell: INCIDENT_CELL - 5, v: 3 });
  const l1 = placeCar({ lane: 1, cell: INCIDENT_CELL - 5, v: 3 });
  const l0 = placeCar({ lane: 0, cell: INCIDENT_CELL - 5, v: 3 });
  assert.ok(accelInLane(l2, 2) < -0.5);
  assert.ok(accelInLane(l1, 1) < -0.5);
  assert.ok(accelInLane(l0, 0) > 0);
  assert.ok(laneBlocked(1) && laneBlocked(2) && !laneBlocked(0));
  sim.incidentLanes = 5;  // clamped to lanes − 1
  assert.ok(!laneBlocked(0));
  sim.incident = false;
  assert.ok(!laneBlocked(2));
});

test('rubbernecking slows OPEN-lane drivers next to an incident; AVs and the toggle are exempt', () => {
  resetWorld({ incident: true });
  const gawker = placeCar({ lane: 0, cell: INCIDENT_CELL - 2, v: 3 });
  const free = effV0(gawker);
  assert.ok(free < carV0(gawker) * 0.7, 'desired speed drops alongside the incident');
  gawker.isAV = true;
  assert.equal(effV0(gawker), carV0(gawker));
  gawker.isAV = false;
  sim.rubbernecking = false;
  assert.equal(effV0(gawker), carV0(gawker));
  // Far upstream nobody gawks.
  sim.rubbernecking = true;
  const far = placeCar({ lane: 0, cell: 5, v: 3 });
  assert.equal(effV0(far), carV0(far));
});

test('VSL zone caps the desired speed (AVs comply fully, humans partially)', () => {
  resetWorld({ vslOn: true });
  sim.vslZone = { start: 0, end: 30 };
  sim.vslMph = 45;
  const human = placeCar({ lane: 0, cell: 10, v: 3 });
  const av = placeCar({ lane: 1, cell: 10, v: 3 });
  av.isAV = true;
  const lim = 45 / MPH_PER_CELL;
  assert.ok(Math.abs(effV0(av) - lim) < 1e-9);
  assert.ok(effV0(human) > lim && effV0(human) < carV0(human));
  const outside = placeCar({ lane: 0, cell: 50, v: 3 });
  assert.equal(effV0(outside), carV0(outside));
});
