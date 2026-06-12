// Gap/leader queries: the open-road no-wrap rule, lane straddling (lane2),
// exact-cell overlap handling and bumper-to-bumper arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leaderInLane, followerInLane, occupiesLane, fwd } from '../js/engine.js';
import { N } from '../js/config.js';
import { resetWorld, placeCar } from './helpers.js';

test('bumper-to-bumper gap subtracts the FOLLOWER length (leader) / leader length (follower)', () => {
  resetWorld();
  const a = placeCar({ lane: 0, cell: 10, v: 3, len: 1.5 });
  const b = placeCar({ lane: 0, cell: 16, v: 3, len: 2.0 });
  // a -> b: distance 6 minus a's own length (a occupies [10, 11.5)).
  assert.equal(leaderInLane(a, 0, N).gap, 6 - 1.5);
  // b's follower is a: distance 6 minus a's length too (a's nose to b's tail).
  assert.equal(followerInLane(b, 0, N).gap, 6 - 1.5);
});

test('open road: gap queries NEVER wrap around the edges', () => {
  resetWorld();
  const left = placeCar({ lane: 0, cell: 2, v: 3 });  // fresh arrival at the left edge
  const edge = placeCar({ lane: 0, cell: 80, v: 3 }); // about to drive off the right
  // The right-edge car sees clear road ahead (the left-edge car is NOT its leader)...
  const lead = leaderInLane(edge, 0, N);
  assert.equal(lead.lead, null);
  assert.equal(lead.gap, N);
  // ...and the left-edge car has nobody behind it (no wrap backwards either).
  assert.equal(followerInLane(left, 0, N).foll, null);
});

test('a car mid lane change occupies BOTH lanes via lane2', () => {
  resetWorld();
  const straddler = placeCar({ lane: 1, cell: 20, v: 3 });
  straddler.lane2 = 0; // body still over the line into lane 0
  assert.ok(occupiesLane(straddler, 1));
  assert.ok(occupiesLane(straddler, 0));
  assert.ok(!occupiesLane(straddler, 2));
  const behind = placeCar({ lane: 0, cell: 14, v: 3 });
  assert.equal(leaderInLane(behind, 0, N).lead, straddler);
});

test('exact same cell counts as leader with a negative gap (overlap rejection)', () => {
  resetWorld();
  const a = placeCar({ lane: 0, cell: 30, v: 3, len: 1.5 });
  const b = placeCar({ lane: 0, cell: 30, v: 3 });
  const r = leaderInLane(a, 0, N);
  assert.equal(r.lead, b);
  assert.equal(r.gap, -1.5); // 0 distance minus a.len => firmly negative
});

test('maxScan limits the search; beyond it the lane reads as open', () => {
  resetWorld();
  const a = placeCar({ lane: 0, cell: 10, v: 3 });
  placeCar({ lane: 0, cell: 40, v: 3 });
  const r = leaderInLane(a, 0, 20); // leader is 30 cells out, beyond the scan
  assert.equal(r.lead, null);
  assert.equal(r.gap, 20);
  assert.equal(r.leadV, a.v); // "v0-ish": no phantom slowdown from an unseen car
});

test('fwd() is ring math, reserved for crossing detection', () => {
  assert.equal(fwd(80, 2), N - 80 + 2);
  assert.equal(fwd(2, 80), 78);
  assert.equal(fwd(5, 5), 0);
});
