// Traffic-light phasing and the small derived state helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightPhases, lightOffset, lightState, makeCar } from '../js/engine.js';
import {
  sim, densityCap, effTarget, vmaxFloat, carV0,
  weatherTfactor, weatherS0add,
} from '../js/state.js';
import { N, MPH_PER_CELL, TRUCK_OVERRIDE } from '../js/config.js';
import { resetWorld, placeCar } from './helpers.js';

test('light phases always sum to the cycle length', () => {
  resetWorld({ scenario: 'city', lanes: 2 });
  for (const c of [30, 45, 60, 75, 90]) {
    sim.cycleLen = c;
    const ph = lightPhases();
    assert.equal(ph.green + ph.yellow + ph.red, c, `cycle ${c}`);
    assert.ok(ph.yellow >= 3, 'yellow never shorter than 3 s');
    assert.ok(ph.red > 0, 'red never vanishes');
  }
});

test('lightState cycles green -> yellow -> red over one cycle', () => {
  resetWorld({ scenario: 'city', lanes: 2 });
  const ph = lightPhases();
  const seen = [];
  for (let t = 0; t < sim.cycleLen; t++) {
    sim.time = t;
    seen.push(lightState(0));
  }
  assert.equal(seen.filter(s => s === 'green').length, ph.green);
  assert.equal(seen.filter(s => s === 'yellow').length, ph.yellow);
  assert.equal(seen.filter(s => s === 'red').length, ph.red);
  // Phases are contiguous in g->y->r order from t=0.
  assert.equal(seen[0], 'green');
  assert.equal(seen[ph.green], 'yellow');
  assert.equal(seen[ph.green + ph.yellow], 'red');
});

test('green wave staggers lights by travel time; off => no offset', () => {
  resetWorld({ scenario: 'city', lanes: 2 });
  assert.equal(lightOffset(2), 0);
  sim.greenWave = true;
  const expected = Math.round((71 - 21) / vmaxFloat()) % sim.cycleLen;
  assert.equal(lightOffset(0), 0);
  assert.equal(lightOffset(2), expected);
  // Offset shifts the phase: light i turns green `offset` seconds after light 0.
  sim.time = lightOffset(2);
  assert.equal(lightState(2), 'green');
});

test('densityCap / effTarget: target is capped by physical road capacity', () => {
  resetWorld({ lanes: 3, targetCars: 10_000 });
  assert.equal(densityCap(), Math.floor(3 * N * 0.30));
  assert.equal(effTarget(), densityCap());
  sim.targetCars = 5;
  assert.equal(effTarget(), 5);
});

test('vmaxFloat: weather slows the posted limit, floored at 1 cell/s', () => {
  resetWorld({ speedMph: 65 });
  const base = 65 / MPH_PER_CELL;
  assert.equal(vmaxFloat(), base);
  sim.weather = 'rain';
  assert.equal(vmaxFloat(), base - 0.5);
  sim.weather = 'fog';
  assert.equal(vmaxFloat(), base - 1.0);
  sim.speedMph = 1; // absurdly low posted limit: floor kicks in
  assert.equal(vmaxFloat(), 1);
});

test('carV0: trucks are governed at the v0Cap', () => {
  resetWorld({ speedMph: 75 });
  const truck = placeCar({ v: 2, isTruck: true });
  assert.equal(carV0(truck), TRUCK_OVERRIDE.v0Cap);
  const car = placeCar({ v: 2, prof: 'aggressive' });
  car.speedFactor = 1.05;
  assert.ok(carV0(car) > vmaxFloat(), 'aggressive drivers run over the limit');
});

test('weather following factors: clear < rain < fog', () => {
  resetWorld();
  sim.weather = 'clear';
  assert.equal(weatherTfactor(), 1); assert.equal(weatherS0add(), 0);
  sim.weather = 'rain';
  const rT = weatherTfactor(), rS = weatherS0add();
  sim.weather = 'fog';
  assert.ok(weatherTfactor() > rT && rT > 1);
  assert.ok(weatherS0add() > rS && rS > 0);
});

test('makeCar honours the fleet-mix sliders (statistically, seeded)', () => {
  resetWorld({ pctTrucks: 100 });
  assert.ok(makeCar(0, 0, 1).isTruck);
  resetWorld({ pctAgg: 100, pctTrucks: 0 });
  assert.equal(makeCar(0, 0, 1).profName, 'aggressive');
  // Trucks are never aggressive even at 100% aggressive mix.
  resetWorld({ pctAgg: 100, pctTrucks: 100 });
  assert.equal(makeCar(0, 0, 1).profName, 'normal');
});
