// IDM car-following math: free-road acceleration, equilibrium, braking,
// clamping, weather stiffening and virtual obstacles (red lights, incident,
// end-of-ramp wall) acting as stationary leaders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idmAccel, accelInLane } from '../js/engine.js';
import { carV0, sim } from '../js/state.js';
import { B_SAFE, INCIDENT_CELL } from '../js/config.js';
import { resetWorld, placeCar } from './helpers.js';

test('free road, well below desired speed: accelerates', () => {
  resetWorld();
  const car = placeCar({ v: 1 });
  const acc = idmAccel(car, 100, car.v);
  // Near full throttle for the profile — but full throttle is now a realistic
  // ~1.4 m/s² (0.19 cells/s²), not the old 12 m/s².
  assert.ok(acc > 0.1, `expected near-max acceleration, got ${acc}`);
  assert.ok(acc <= car.prof.a + 1e-12, 'never exceeds the profile max');
});

test('at desired speed v0 on a free road: acceleration ~ 0', () => {
  resetWorld();
  const car = placeCar({ v: 1 });
  car.v = carV0(car);
  const acc = idmAccel(car, 1000, car.v);
  assert.ok(Math.abs(acc) < 0.05, `expected ~0, got ${acc}`);
});

test('at the IDM equilibrium gap behind a matched-speed leader: acceleration ~ 0', () => {
  resetWorld();
  const car = placeCar({ v: 3 });
  const { s0, T } = car.prof;
  const v0 = carV0(car);
  // acc = 0 when matched speeds (dv=0) at s = s* / sqrt(1 - (v/v0)^4).
  const sStar = s0 + car.v * T;
  const sEq = sStar / Math.sqrt(1 - Math.pow(car.v / v0, 4));
  assert.ok(Math.abs(idmAccel(car, sEq, car.v)) < 1e-9);
  // Tighter than equilibrium brakes; looser accelerates.
  assert.ok(idmAccel(car, sEq * 0.7, car.v) < 0);
  assert.ok(idmAccel(car, sEq * 1.5, car.v) > 0);
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

test('rain and fog stiffen following: less acceleration at the same gap', () => {
  const gap = 6, v = 3;
  resetWorld({ weather: 'clear' });
  const clear = idmAccel(placeCar({ v }), gap, v);
  resetWorld({ weather: 'rain' });
  const rain = idmAccel(placeCar({ v }), gap, v);
  resetWorld({ weather: 'fog' });
  const fog = idmAccel(placeCar({ v }), gap, v);
  assert.ok(rain < clear, `rain ${rain} should be < clear ${clear}`);
  assert.ok(fog < rain, `fog ${fog} should be < rain ${rain}`);
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
  resetWorld({ incident: true });
  const right = placeCar({ lane: sim.lanes - 1, cell: INCIDENT_CELL - 5, v: 3 });
  const inner = placeCar({ lane: 0, cell: INCIDENT_CELL - 5, v: 3 });
  assert.ok(accelInLane(right, right.lane) < -0.5, 'rightmost lane should brake');
  assert.ok(accelInLane(inner, inner.lane) > 0, 'inner lane should flow');
});

test('end-of-ramp wall brakes accel-lane cars; skipWall ignores it', () => {
  resetWorld(); // highway: ramp at 59, taper len 5 => wall at cell 63
  const car = placeCar({ lane: 3, cell: 61.5, v: 3 }); // ramp lane = sim.lanes = 3
  assert.ok(accelInLane(car, 3) < -0.5, 'should brake for the wall');
  assert.ok(accelInLane(car, 3, true) > 0, 'skipWall should see open road');
});
