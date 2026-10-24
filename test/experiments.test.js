// Every guided experiment must teach a TRUE lesson: run each one exactly the
// way the guide walks a learner through it (preset → warm-up → baseline →
// one change → settle → compare) on the real engine, over several seeds, and
// check that each focus metric moves the way the experiment's `expect` (and
// its explanation) says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, resetSim, applyLaneCount, getStats, triggerPhantomBrake } from '../js/engine.js';
import { sim } from '../js/state.js';
import { seedRng } from '../js/rng.js';
import { EXPERIMENTS, WARMUP_S } from '../js/ui/experiments.js';
import { defaultsFor } from '../js/ui/spec.js';

const SEEDS = process.env.EXP_SEEDS ? process.env.EXP_SEEDS.split(",").map(Number) : [1, 2, 3, 4];
// Baseline = mean of the last 60 s of the warm-up (as the UI saves it); the
// result = the minute after the same settling time has passed again.
const BASE = 60, MEASURE = 60;

function applySettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'lanes') { if (v !== sim.lanes) applyLaneCount(v); continue; }
    sim[k] = v;
  }
}

// Advance `secs` sim seconds, sampling getStats every 2 s like the UI history.
function run(secs, e) {
  const rows = [];
  for (let i = 0; i < secs; i++) {
    if (e.brakeEvery && sim.time % e.brakeEvery === 0) triggerPhantomBrake(null);
    tick();
    if (sim.time % 2 === 0) rows.push(getStats());
  }
  return rows;
}
const meanOf = (rows, k) => {
  const v = rows.map(r => r[k]).filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};

function trial(e, seed) {
  seedRng(seed);
  sim.scenario = e.scenario;
  applySettings({ ...defaultsFor(e.scenario), ...e.setup });
  sim.nextId = 1;
  resetSim();
  const W = e.warmup || WARMUP_S;
  const base = run(W, e).slice(-BASE / 2);
  const step = e.steps.find(s => s.apply);
  const reset = 'mergeShape' in step.apply && step.apply.mergeShape !== sim.mergeShape;
  applySettings(step.apply);
  if (reset) resetSim();
  run(W, e);
  const after = run(MEASURE, e);
  const out = {};
  for (const k of Object.keys(e.expect)) out[k] = { a: meanOf(base, k), b: meanOf(after, k) };
  return out;
}

for (const e of EXPERIMENTS) {
  test(`experiment "${e.title}": focus metrics move as the guide explains`, () => {
    assert.ok(e.expect && Object.keys(e.expect).length, 'experiment declares expected directions');
    for (const k of Object.keys(e.expect)) assert.ok(e.focus.includes(k), `${k} is shown to the learner`);
    const trials = SEEDS.map(s => trial(e, s));
    for (const [k, dir] of Object.entries(e.expect)) {
      const rel = trials.map(t => (t[k].b - t[k].a) / Math.max(Math.abs(t[k].a), 1e-6));
      const desc = trials.map(t => `${t[k].a.toFixed(2)}→${t[k].b.toFixed(2)}`).join(', ');
      // Pooled change (mean after vs mean before) so one run with a tiny
      // baseline cannot dominate; plus a per-run majority check below.
      const sa = trials.reduce((x, t) => x + t[k].a, 0), sb = trials.reduce((x, t) => x + t[k].b, 0);
      const avg = (sb - sa) / Math.max(Math.abs(sa), 1e-6);
      if (dir === 'noRise') {
        assert.ok(avg < 0.03, `${e.id}: ${k} should not rise (mean ${(avg * 100).toFixed(0)}%: ${desc})`);
      } else if (dir === 'noDrop') {
        assert.ok(avg > -0.03, `${e.id}: ${k} should not fall (mean ${(avg * 100).toFixed(0)}%: ${desc})`);
      } else if (dir === 0) {
        assert.ok(Math.abs(avg) < 0.1, `${e.id}: ${k} should barely change (mean ${(avg * 100).toFixed(0)}%: ${desc})`);
      } else {
        const agree = rel.filter(r => Math.sign(r) === dir).length;
        assert.ok(avg * dir > 0.03, `${e.id}: ${k} should go ${dir > 0 ? 'up' : 'down'} (mean ${(avg * 100).toFixed(0)}%: ${desc})`);
        assert.ok(agree >= SEEDS.length - 1, `${e.id}: ${k} direction holds in only ${agree}/${SEEDS.length} runs (${desc})`);
      }
    }
  });
}
