// Regression tests for integration bugs found in end-to-end QA: incident
// deadlocks with several lanes closed, and lane removal stacking vehicles on
// top of each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, applyLaneCount } from '../js/engine.js';
import { sim } from '../js/state.js';
import { resetWorld } from './helpers.js';

const MIX = { pctTrucks: 16, pctAgg: 3, pctPas: 15, pctAV: 30, reactionTime: 0 };

// Bumper overlaps between vehicles sharing a lane (either as primary lane or
// while straddling the line mid lane change).
function overlaps(tol = 0.3) {
  const byLane = {};
  for (const c of sim.cars) for (const l of [c.lane, c.lane2]) if (l != null) (byLane[l] ||= []).push(c);
  const out = [];
  for (const cs of Object.values(byLane)) {
    cs.sort((a, b) => a.cell - b.cell);
    for (let i = 1; i < cs.length; i++) {
      const g = cs[i].cell - cs[i - 1].cell - cs[i - 1].len;
      if (g < -tol) out.push({ a: cs[i - 1].id, b: cs[i].id, g });
    }
  }
  return out;
}

test('two of three lanes closed: the queue keeps draining (no zipper deadlock)', () => {
  for (const seed of [1, 2, 3]) {
    resetWorld({ ...MIX, demandVph: 1500, rampDemandVph: 400, incident: true, incidentLanes: 2 }, seed);
    let worst = Infinity;
    for (let i = 0; i < 900; i++) {
      tick();
      if (sim.time >= 300 && sim.time % 60 === 0) {
        const done = sim.evTravel.filter(e => e.t > sim.time - 60).length;
        worst = Math.min(worst, done);
      }
    }
    // One open lane still discharges a steady stream past the scene.
    assert.ok(worst >= 6, `seed ${seed}: only ${worst} trips/min at worst`);
  }
});

test('a car halted in a closed lane can step across into the next closed lane', () => {
  resetWorld({ lanes: 4, incident: true, incidentLanes: 3, demandVph: 120 }, 4);
  for (let i = 0; i < 600; i++) tick();
  // Lanes 1–3 are closed; anything that reached the block in lane 2 or 3 must
  // have been able to work its way across to lane 0 — nobody waits forever.
  const stale = sim.cars.filter(c => c.lane >= 2 && c.lane < sim.lanes && c.age > 240);
  assert.equal(stale.length, 0, `stranded in closed lanes: ${stale.map(c => c.id + '@' + c.cell.toFixed(1)).join(', ')}`);
});

test('removing lanes never stacks vehicles on top of each other', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    resetWorld({ lanes: 4, pctTrucks: 20, pctAgg: 20, pctPas: 20, demandVph: 1600, rampDemandVph: 600 }, seed);
    for (let i = 0; i < 200; i++) tick();
    applyLaneCount(2);
    assert.deepEqual(overlaps(0.05), [], `seed ${seed}: overlap right after the change`);
    for (let i = 0; i < 20; i++) {
      tick();
      assert.deepEqual(overlaps(), [], `seed ${seed}: overlap ${i + 1} s after the change`);
    }
  }
});
