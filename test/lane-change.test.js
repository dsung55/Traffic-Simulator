// The MOBIL lane-change state machine, exercised through whole ticks:
// signal-before-move, forced ramp merges, discretionary overtakes, straddling
// (lane2) during execution, and in-place lane-count changes.
// targetCars is 0 in resetWorld, so no spawning disturbs the fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, applyLaneCount } from '../js/engine.js';
import { sim, rampLaneIdx, rampStart } from '../js/state.js';
import { resetWorld, placeCar } from './helpers.js';

test('ramp car: forced merge with signal phase BEFORE any lateral movement', () => {
  resetWorld();
  // Alone on the accel lane (ramp lane = 3), clear mainline: textbook merge.
  // Placed at the on-ramp entry so the accel-lane wall/urgency logic applies.
  const car = placeCar({ lane: rampLaneIdx(), cell: rampStart(), v: 2 });
  tick();
  assert.ok(car.lc, 'plan starts immediately on the accel lane');
  assert.ok(car.lc.forced, 'ramp merges are forced');
  assert.equal(car.lc.target, sim.lanes - 1);
  assert.equal(car.signal, -1, 'blinker on toward the mainline');
  // While still signalling, the body must not have moved laterally.
  if (car.lc.phase === 'signal') {
    assert.equal(car.lane, rampLaneIdx());
    assert.equal(car.laneCoord, rampLaneIdx());
  }
  for (let i = 0; i < 10 && sim.cars.includes(car) && car.lane !== sim.lanes - 1; i++) tick();
  assert.equal(car.lane, sim.lanes - 1, 'merged into the rightmost main lane');
  for (let i = 0; i < 6 && car.laneT < 1; i++) tick();
  assert.equal(car.laneCoord, car.lane, 'slide animation completed');
  assert.equal(car.lane2, null, 'origin lane released');
});

test('execute phase: car immediately leads the target lane and straddles the old one', () => {
  resetWorld();
  const car = placeCar({ lane: rampLaneIdx(), cell: rampStart(), v: 2 });
  let sawStraddle = false;
  for (let i = 0; i < 10; i++) {
    tick();
    if (car.lc && car.lc.phase === 'execute' && car.laneT < 0.55) {
      assert.equal(car.lane, sim.lanes - 1, 'already counts in the target lane');
      assert.equal(car.lane2, rampLaneIdx(), 'still blocks the lane being left');
      sawStraddle = true;
      break;
    }
  }
  assert.ok(sawStraddle, 'never observed the straddling execute phase');
});

test('discretionary overtake: fast car stuck behind a crawler changes lanes', () => {
  resetWorld();
  // Crawler ahead in the middle lane; ego is aggressive and boxed in behind it.
  placeCar({ lane: 1, cell: 26, v: 0.4, prof: 'passive' });
  const ego = placeCar({ lane: 1, cell: 21, v: 3.5, prof: 'aggressive' });
  let signalled = false;
  for (let i = 0; i < 14 && sim.cars.includes(ego); i++) {
    tick();
    if (ego.lc) signalled = true;
    if (ego.lane !== 1) break;
  }
  assert.ok(signalled, 'never even signalled a lane change');
  assert.notEqual(ego.lane, 1, 'still stuck behind the crawler after 14 s');
});

test('no overtake incentive on an empty road: nobody changes lanes', () => {
  resetWorld();
  const a = placeCar({ lane: 1, cell: 20, v: 3.8 });
  for (let i = 0; i < 8; i++) tick();
  assert.equal(a.lane, 1);
  assert.equal(a.lc, null);
  assert.equal(sim.evLaneChanges.length, 0);
});

test('discretionary plans time out (patience) when the target lane stays blocked', () => {
  // A red-light queue pins every car at v = 0 so the geometry holds still long
  // enough to observe the timeout. Ego idles in lane 0 nose-to-tail behind the
  // queue; lane 1 has a tempting pocket AHEAD of it (strong MOBIL incentive)
  // but a stopped follower 0.3 cells behind, which fails gapCheck's rear-gap
  // requirement every tick. Ego must signal, wait out its patience, give up.
  // (Queue gaps sit at/below each profile's standstill s0 — now a realistic
  // 2–4 m — so the stopped queue doesn't creep during the test.)
  resetWorld({ scenario: 'city', lanes: 2, speedMph: 35 });
  sim.time = 35; // cycle 60 => red from t=34 to t=60; the whole test stays red
  // Lane 0 queue at the light (cell 21): ego boxed at a 0.3-cell gap.
  placeCar({ lane: 0, cell: 19.1, v: 0 });
  placeCar({ lane: 0, cell: 17.25, v: 0 });
  const ego = placeCar({ lane: 0, cell: 15.45, v: 0, prof: 'aggressive' });
  placeCar({ lane: 0, cell: 12.0, v: 0 });
  // Lane 1 queue: pocket ahead of ego (gap 0.7 > the ~0.56 it needs ahead),
  // follower 0.3 behind (< the 0.5 it needs behind => blocked forever; the
  // passive follower also yields for the blinker, so it stays put).
  placeCar({ lane: 1, cell: 17.65, v: 0 });
  placeCar({ lane: 1, cell: 13.65, v: 0, prof: 'passive' });
  placeCar({ lane: 1, cell: 11.0, v: 0, prof: 'passive' });
  let signalled = false, gaveUp = false;
  for (let i = 0; i < 20; i++) {
    tick();
    if (ego.lc) signalled = true;
    if (signalled && !ego.lc) { gaveUp = true; break; }
  }
  assert.ok(signalled, 'expected the boxed-in car to signal for the pocket');
  assert.ok(gaveUp, 'expected the plan to time out (patience)');
  assert.equal(ego.lane, 0, 'must not have squeezed into the blocked pocket');
  assert.ok(ego.cool > 0, 'cooldown set after giving up');
});

test('applyLaneCount shrink: every car lands in a valid lane with clean LC state', () => {
  resetWorld({ lanes: 4 });
  // Cars spread over all four main lanes + one on the accel lane (index 4),
  // including one mid-lane-change.
  for (let lane = 0; lane < 4; lane++) {
    placeCar({ lane, cell: 10 + lane * 7, v: 3 });
  }
  const midChange = placeCar({ lane: 2, cell: 50, v: 3 });
  midChange.lc = { target: 3, dir: 1, phase: 'execute', t: 0, wait: 0, forced: false, from: 2 };
  midChange.lane2 = 3; midChange.laneT = 0.3;
  const rampCar = placeCar({ lane: 4, cell: 60, v: 2 });

  applyLaneCount(2);

  assert.equal(sim.lanes, 2);
  for (const car of sim.cars) {
    const maxLane = car === rampCar ? rampLaneIdx() : sim.lanes - 1;
    assert.ok(car.lane >= 0 && car.lane <= maxLane, `car ${car.id} in lane ${car.lane}`);
    assert.equal(car.lc, null);
    assert.equal(car.lane2, null);
    assert.equal(car.laneT, 1);
    assert.equal(car.laneCoord, car.lane);
  }
  assert.equal(rampCar.lane, rampLaneIdx(), 'accel-lane car follows the ramp lane index');
  // The shrunken world must still tick without error.
  for (let i = 0; i < 5; i++) tick();
});

test('applyLaneCount grow: cars stay put, world keeps ticking', () => {
  resetWorld({ lanes: 2 });
  const a = placeCar({ lane: 0, cell: 20, v: 3 });
  const b = placeCar({ lane: 1, cell: 30, v: 3 });
  applyLaneCount(4);
  assert.equal(sim.lanes, 4);
  assert.equal(a.lane, 0);
  assert.equal(b.lane, 1);
  for (let i = 0; i < 5; i++) tick();
});
