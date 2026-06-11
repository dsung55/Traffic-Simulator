// Shared test scaffolding: deterministic world reset + controlled car fixtures.
// The sim is a module singleton, so every test starts by rebuilding it from a
// known seed and a known settings snapshot.
import { sim } from '../js/state.js';
import { resetSim, makeCar } from '../js/engine.js';
import { seedRng } from '../js/rng.js';
import { PROFILES, TRUCK_OVERRIDE, CAR_LEN, TRUCK_LEN } from '../js/config.js';

// Reset the singleton sim to a clean, seeded, fully-known state. `overrides`
// are applied on top of the defaults below (e.g. { scenario: 'city', lanes: 1 }).
// targetCars: 0 by default so tests control the fleet; raise it to exercise
// spawning. Returns sim for convenience.
export function resetWorld(overrides = {}, seed = 1) {
  seedRng(seed);
  Object.assign(sim, {
    scenario: 'highway', lanes: 3, speedMph: 65, targetCars: 0,
    pctTrucks: 0, pctAgg: 0, pctPas: 0,
    meterOn: false, meterInterval: 8, mergeShape: 'taper',
    incident: false, exitRamp: false, exitPct: 20,
    weather: 'clear', cycleLen: 60, greenWave: false, paused: false,
    nextId: 1,
  }, overrides);
  resetSim();
  return sim;
}

// Build a car with FIXED (non-random) driving parameters and add it to the
// fleet. makeCar rolls profile/length/colour from the seeded rng; we overwrite
// everything behaviour-relevant so fixtures are exact regardless of seed.
export function placeCar({
  lane = 0, cell = 0, v = 3, prof = 'normal', isTruck = false, len,
} = {}) {
  const car = makeCar(lane, cell, v);
  car.profName = prof;
  car.prof = isTruck ? { ...PROFILES[prof], ...TRUCK_OVERRIDE } : { ...PROFILES[prof] };
  car.isTruck = isTruck;
  car.speedFactor = 1;
  car.len = len ?? (isTruck ? TRUCK_LEN : CAR_LEN);
  car.exitChance = 0; car.exiting = false; car.exitDecided = true;
  car.startV = v;
  sim.cars.push(car);
  return car;
}
