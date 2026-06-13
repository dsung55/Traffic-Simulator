// Simulation engine: traffic lights, vehicles, gap queries, IDM car-following,
// MOBIL lane changes (signal / gap-wait / steer-over state machine), the
// longitudinal integrator, spawning and the per-second tick. No DOM access and
// no UI/render imports: presentation is reached only through the injectable
// `hooks` (selectCar / updateLabels / invalidateScene), wired by main.js.
import {
  N, SUBSTEPS, SUB_DT, SENSOR_CELL, INCIDENT_CELL, EXIT_DECIDE_CELL,
  CAR_LEN, TRUCK_LEN, PROFILES, TRUCK_OVERRIDE, B_SAFE, MERGE_MARGIN,
  EXIT_RAMP_SPEED,
} from './config.js';
import {
  sim, cfg, offRampActive, rampLaneIdx, rampLen, rampStart, rampEnd,
  effTarget, vmaxFloat, rollSpeedFactor, carV0, weatherTfactor, weatherS0add,
} from './state.js';
import { rng } from './rng.js';

// Injectable presentation hooks. The engine never imports the UI/render layers
// directly (that would form an import cycle and drag the DOM into every engine
// import); instead main.js wires the real callbacks in via setEngineHooks at
// startup. They default to no-ops so the engine — and its pure simulation
// math — can be imported and exercised in a plain Node process with no DOM.
const hooks = {
  selectCar() {},        // surface a clicked car in the inspector (or clear it)
  updateLabels() {},     // refresh slider/value labels after a structural change
  invalidateScene() {},  // force the static render layer to rebuild
};
function setEngineHooks(h) { Object.assign(hooks, h); }

//──────────────────────────── Traffic lights (city) ────────────────────────────
// Cycle split scales the default 30/4/26 s proportions to the slider value.
function lightPhases() {
  const c = sim.cycleLen;
  const green = Math.round(c * 0.5);
  const yellow = Math.max(3, Math.round(c * 4 / 60));
  return { green, yellow, red: c - green - yellow };
}
// Green-wave offset: time for a car at the speed limit to travel from light 0.
function lightOffset(i) {
  if (!sim.greenWave) return 0;
  const cells = cfg().lightCells[i] - cfg().lightCells[0];
  return Math.round(cells / vmaxFloat()) % sim.cycleLen;
}
function lightState(i) {
  const ph = lightPhases();
  const t = ((sim.time - lightOffset(i)) % sim.cycleLen + sim.cycleLen) % sim.cycleLen;
  if (t < ph.green) return 'green';
  if (t < ph.green + ph.yellow) return 'yellow';
  return 'red';
}

//──────────────────────────── Cars ────────────────────────────
function rollProfile(isTruck) {
  const r = rng() * 100;
  let name = r < sim.pctAgg ? 'aggressive' : r < sim.pctAgg + sim.pctPas ? 'passive' : 'normal';
  if (isTruck && name === 'aggressive') name = 'normal'; // trucks are never aggressive
  return name;
}
function carColor(profName, isTruck) {
  const h = (a, b) => a + rng() * (b - a);
  if (isTruck) return `hsl(${h(22, 48)},${h(12, 22)}%,${h(58, 74)}%)`;       // tan rigs
  if (profName === 'aggressive') return `hsl(${(h(-8, 14) + 360) % 360},${h(68, 88)}%,${h(48, 60)}%)`; // hot red
  if (profName === 'passive')    return `hsl(${h(205, 232)},${h(38, 56)}%,${h(54, 68)}%)`; // cool blue
  return `hsl(${h(0, 360)},${h(6, 20)}%,${h(54, 80)}%)`;                     // neutral
}
// Create a car. Profile, truck status, speed factor and color are rolled ONCE
// here from the CURRENT slider values and then persist for the car's entire
// life — slider changes only affect cars spawned afterwards, never this one.
function makeCar(lane, cell, v) {
  const isTruck = rng() * 100 < sim.pctTrucks;
  const profName = rollProfile(isTruck);
  // Build the effective IDM/MOBIL parameter set: base profile, then truck
  // overrides merged on top. Stored per-car so slider changes never mutate it.
  const base = PROFILES[profName];
  const prof = isTruck ? Object.assign({}, base, TRUCK_OVERRIDE) : base;
  // Interchange: each car gets a permanent random 15–30% chance of taking the
  // off-ramp; it rolls that chance once upstream of the ramp, then weaves right.
  const exitChance = offRampActive()
    ? Math.min(0.9, (sim.exitPct / 100) * (0.75 + rng() * 0.5))
    : 0;
  // Physical length in cells (small per-vehicle variance around the baselines).
  const len = isTruck ? TRUCK_LEN * (0.92 + rng() * 0.18)
                      : CAR_LEN * (0.93 + rng() * 0.16);
  return {
    id: sim.nextId++, lane, cell, v, len,
    prevCell: cell, prevLane: lane, startV: v,
    laneCoord: lane,          // CONTINUOUS lane coordinate (renderer reads this for y)
    laneFrom: lane, laneTo: lane, laneT: 1, // lane-change animation state (laneT in [0,1])
    prevLaneT: 1,             // laneT at the last snapshot (renderer-only, for exact S-curve)
    lane2: null,              // secondary lane occupied while straddling the line
    lc: null,                 // lane-change plan { target, dir, phase, t, wait, sigTime, forced, from }
    signal: 0,                // blinker: -1 left (screen-up), +1 right (screen-down), 0 off
    tilt: 0, prevTilt: 0,     // body yaw (rad) while steering across, lerped by the renderer
    yieldFor: null, closeGap: false,  // per-tick cooperation flags (set in yieldPass)
    profName, prof, isTruck,
    speedFactor: rollSpeedFactor(profName),
    exitChance, exiting: rng() < exitChance, exitDecided: false,
    cool: 0, age: 0, braking: false, accel: 0,
    color: carColor(profName, isTruck),
  };
}

//──────────────────────────── Per-lane ordering & gap helpers ────────────────────────────
// The world is OPEN (cars enter left at cell 0, exit right near cell N). All
// car-following / gap queries use PLAIN signed distance — never ring wrap — so
// the visible strip behaves like a slice of an infinite road: a car near the
// right edge sees empty road ahead (it is about to drive off-screen), and a car
// spawning at the left edge never registers as the "leader" of one about to
// exit on the right. Ring-wrapped fwd() survives only for tick bookkeeping
// (sensor/landmark crossings and right-edge despawn detection). We keep no
// occupancy grid; spatial queries are O(n) scans over sim.cars (≤ ~160 cars),
// which is plenty fast. A car occupies [cell, cell+car.len) along travel; the
// bumper-to-bumper gap to a leader at lead.cell is (lead.cell - car.cell -
// car.len). A car mid lane change occupies TWO lanes (car.lane plus car.lane2)
// until it is mostly across, so traffic in both lanes follows it and nobody
// clips through a straddling body.

// Forward distance from a to b in cells, on the ring [0,N). ONLY for crossing
// detection in the post-move scan — never for gap/leader queries (see above).
function fwd(a, b) { let d = b - a; while (d < 0) d += N; while (d >= N) d -= N; return d; }

// Does `o` currently occupy `lane` (primary lane, or the lane it is leaving
// while its body still straddles the line)?
function occupiesLane(o, lane) { return o.lane === lane || o.lane2 === lane; }

// Find the nearest car ahead of `car` in `lane` (excluding itself). Returns
// { gap, leadV } where gap is bumper-to-bumper in cells (may be slightly
// negative if overlapping) and leadV is the leader's speed (cells/s). If no
// car is found within `maxScan` cells, returns a large gap and v0-ish speed.
function leaderInLane(car, lane, maxScan) {
  let bestD = Infinity, lead = null;
  for (const o of sim.cars) {
    if (o === car || !occupiesLane(o, lane)) continue;
    const d = o.cell - car.cell;          // open road: no wrap past the edges
    // d === 0 means another car sits on the exact same cell (a would-be overlap,
    // e.g. evaluating a merge onto an occupant). Count it as the nearest leader
    // so the resulting negative gap makes MOBIL/IDM reject/avoid the overlap.
    if (d >= 0 && d < bestD && d <= maxScan) { bestD = d; lead = o; }
  }
  if (!lead) return { gap: maxScan, leadV: car.v, lead: null };
  return { gap: bestD - (car.len || CAR_LEN), leadV: lead.v, lead };
}

// Find the nearest car behind `car` in `lane` (the would-be follower). Returns
// { gap, foll } where gap is bumper-to-bumper from the follower to `car`.
function followerInLane(car, lane, maxScan) {
  let bestD = Infinity, foll = null;
  for (const o of sim.cars) {
    if (o === car || !occupiesLane(o, lane)) continue;
    const d = car.cell - o.cell;       // open road: no wrap past the edges
    if (d > 0 && d < bestD && d <= maxScan) { bestD = d; foll = o; }
  }
  if (!foll) return { gap: maxScan, foll: null };
  return { gap: bestD - (foll.len || CAR_LEN), foll };
}

// Public helper (rendering/other agents may use): bumper-to-bumper gap in cells
// to the leader in `lane`, plus the leader's speed.
function leaderGap(car, lane) {
  const r = leaderInLane(car, lane, N);
  return { gap: r.gap, leadV: r.leadV };
}

// Distance ahead (cells) to the next STATIONARY virtual obstacle for `car` in
// `lane`: a red/yellow stop line, the incident block, or the end-of-ramp wall.
// Returns Infinity when none. Used as a virtual leader with speed 0.
// `skipWall` ignores the end-of-ramp wall — used when evaluating the lane a
// merging car is LEAVING, so a half-merged car isn't braked by a wall its body
// is already escaping.
function virtualObstacle(car, lane, skipWall) {
  let best = Infinity;
  const lights = cfg().lightCells;
  if (lights) {
    for (let i = 0; i < lights.length; i++) {
      const st = lightState(i);
      if (st === 'green') continue;
      const d = lights[i] - car.cell;       // open road: a passed light is behind us
      if (d < 0) continue;
      // Yellow — real dilemma-zone behavior: a driver runs the yellow when the
      // stop line is closer than the distance needed to stop at a tolerable
      // braking rate (~1.4× comfortable b, still well below emergency), and
      // stops otherwise. Old rule only ran it within ~0.6 s of the line, which
      // forced harsh stops from well inside the dilemma zone.
      if (st === 'yellow') {
        const bStop = ((car.prof && car.prof.b) || 0.27) * 1.4;
        if (d < (car.v * car.v) / (2 * bStop)) continue;
      }
      if (d < best) best = d;
    }
  }
  if (sim.incident && cfg().hasIncident && lane === sim.lanes - 1) {
    const d = INCIDENT_CELL - car.cell;
    if (d >= 0 && d < best) best = d;
  }
  if (!skipWall && cfg().hasRamp && lane === rampLaneIdx()) {
    // Wall at the end of the acceleration lane: the car must merge before it.
    const d = (rampEnd() - car.cell);
    if (d >= 0 && d < best) best = d;
  }
  return best;
}

//──────────────────────────── IDM longitudinal model ────────────────────────────
// a_IDM = a·[ 1 − (v/v0)^δ − (s*(v,Δv)/s)² ],  with
//   s*(v,Δv) = s0 + max(0, v·T + v·Δv / (2·√(a·b)))
// where s is the bumper-to-bumper gap (cells), Δv = v − v_lead (approach rate),
// v0 the desired speed (carV0). All quantities are in cell / cell·s⁻¹ units.
const IDM_DELTA = 4;

// Compute IDM acceleration (cells/s²) for `car` in `lane`, given the gap (cells)
// to the effective leader and that leader's speed. Clamped for numerical safety.
function idmAccel(car, gap, leadV) {
  const prof = car.prof;
  const v = car.v;
  const v0 = carV0(car);
  const a = prof.a, b = prof.b;
  const T = prof.T * weatherTfactor();
  const s0 = prof.s0 + weatherS0add();
  // Guard the gap so a momentary overlap can't blow up the (s*/s)² term.
  const s = Math.max(0.05, gap);
  const dv = v - leadV;                              // approach rate
  let sStar = s0 + v * T + (v * dv) / (2 * Math.sqrt(a * b));
  if (sStar < s0) sStar = s0;                        // desired gap never below s0
  let acc = a * (1 - Math.pow(v / v0, IDM_DELTA) - (sStar / s) * (sStar / s));
  // Clamp braking to a sane bound (also caps the (s*/s)² blow-up near s→0).
  if (acc < -B_SAFE * 2) acc = -B_SAFE * 2;
  if (acc > a) acc = a;
  return acc;
}

// The acceleration `car` would get following the nearest real OR virtual leader
// in `lane` — the value MOBIL and the integrator both consult. `skipWall` is
// passed when this is the lane a merging car is leaving (see virtualObstacle).
function accelInLane(car, lane, skipWall) {
  const scan = Math.ceil(carV0(car) * 2.2) + 10;   // look ≈2+ s of travel ahead
  const r = leaderInLane(car, lane, scan);
  let gap = r.gap, leadV = r.leadV;
  // A stationary virtual obstacle (red light / incident / ramp wall) becomes the
  // effective leader (speed 0) when its stop line is nearer than the real leader.
  const obst = virtualObstacle(car, lane, skipWall);
  if (Number.isFinite(obst)) {
    const obstGap = obst - (car.len || CAR_LEN);
    if (obstGap < gap) { gap = obstGap; leadV = 0; }
  }
  let acc = idmAccel(car, gap, leadV);

  // Multi-vehicle anticipation (Treiber/Kesting's human-driver extension of
  // IDM): real drivers watch the car AHEAD of their leader through its rear
  // window and ease off early when the platoon up front is slower, instead of
  // reacting late and braking hard. Modelled as also car-following the
  // second leader over the combined gap and taking the more cautious of the
  // two accelerations — this only binds when the far vehicle is the slower one.
  if (r.lead) {
    const r2 = leaderInLane(r.lead, lane, scan);
    if (r2.lead && r2.leadV < leadV) {
      const gap2 = gap + (r.lead.len || CAR_LEN) + r2.gap;
      const acc2 = idmAccel(car, gap2, r2.leadV);
      if (acc2 < acc) acc = acc2;
    }
  }

  // Exit-ramp approach: a driver committed to the off-ramp and already in the
  // exit lane sheds speed GRADUALLY toward the ramp advisory speed, following
  // a comfortable kinematic envelope v(d) = sqrt(v_ramp² + 2·b·d) instead of
  // sailing into the gore at full highway speed. (Real drivers begin slowing
  // ~10 s upstream of an exit and take the ramp at the advisory speed.)
  if (car.exiting && car.exitDecided && offRampActive() &&
      lane === sim.lanes - 1 && car.lane === sim.lanes - 1) {
    const d = cfg().offRampCell - car.cell;
    if (d > 0) {
      const vAllow = Math.sqrt(EXIT_RAMP_SPEED * EXIT_RAMP_SPEED +
                               2 * car.prof.b * d);
      const accExit = Math.max(-B_SAFE * 2, car.prof.a *
        (1 - Math.pow(car.v / Math.max(vAllow, 0.3), IDM_DELTA)));
      if (accExit < acc) acc = accExit;
    }
  }
  return acc;
}

//──────────────────────────── MOBIL lane changing ────────────────────────────
// Lane changes are a realistic multi-phase manoeuvre:
//   DECIDE  : MOBIL incentive (asymmetric, keep-right biased) says a change is
//             worthwhile — or it is forced (ramp merge, off-ramp weave).
//   SIGNAL  : the blinker comes on for prof.signalTime simulated seconds
//             BEFORE any lateral movement.
//   GAP WAIT: after signalling, the car merges only once a safe pocket exists
//             (gap ahead + behind in the target lane, scaled by relative speed
//             and the driver's gapAccept). While waiting it keeps signalling;
//             courteous followers in the target lane ease off to open the gap
//             (yieldPass), aggressive ones may close it instead. Discretionary
//             attempts give up after prof.patience seconds.
//   EXECUTE : the lateral slide takes LANE_CHANGE_TIME (~4.5 s) on a smoothstep
//             curve, the body visibly steering over (car.tilt). From the first
//             moment it occupies BOTH lanes: target-lane traffic treats it as a
//             leader immediately, old-lane traffic until it is mostly across,
//             and the ego car-follows against both lanes (integrator takes the
//             min accel). If the pocket collapses early, it aborts back.
//
// MOBIL incentive (no hard gap gate here — that is what the gap wait is for):
//   ã_c − a_c + p·[(ã_o − a_o) + (ã_n − a_n)] + Δa_bias − Δa_th > 0
// where c = ego, o = old follower, n = new follower, tilde = after the move.
function mobilDesire(car, target) {
  if (target < 0 || target > sim.lanes - 1) return null;
  const prof = car.prof;

  // Someone right alongside in the target lane: nothing to evaluate yet — the
  // configuration has to change before a merge could even be attempted.
  if (leaderInLane(car, target, N).gap < 0.3) return null;
  if (followerInLane(car, target, N).gap < -0.2) return null;

  // Current-lane actors.
  const aC = accelInLane(car, car.lane);
  const oldFollow = followerInLane(car, car.lane, N).foll;
  const aO = oldFollow ? accelInLane(oldFollow, oldFollow.lane) : 0;

  // Target-lane actors as they are NOW (before the move).
  const newFollow = followerInLane(car, target, N).foll;
  const aN = newFollow ? accelInLane(newFollow, newFollow.lane) : 0;

  // Hypothetically move the ego car into the target lane.
  const savedLane = car.lane;
  car.lane = target;
  const aCt = accelInLane(car, target);                       // ego after
  const aOt = oldFollow ? accelInLane(oldFollow, oldFollow.lane) : 0; // old follower relieved
  const aNt = newFollow ? accelInLane(newFollow, newFollow.lane) : 0; // new follower after
  car.lane = savedLane;

  // Keep-right / left-preference bias (asymmetric MOBIL). Moving right (toward
  // higher lane index) is rewarded by biasRight; moving left is rewarded by
  // leftPref (aggressive drivers chase the faster left lanes).
  let bias = 0;
  if (target > savedLane) bias += prof.biasRight;   // favour the right move
  else if (target < savedLane) bias += prof.leftPref - prof.biasRight;

  const incentive = (aCt - aC) + prof.politeness * ((aOt - aO) + (aNt - aN));
  return incentive + bias - prof.threshold;          // > 0 ⇒ change is worthwhile
}

// Is there a safe pocket in `target` for `car` to begin merging into RIGHT NOW?
// Demands a bumper gap ahead and behind sized by the closing speeds and the
// driver's gapAccept; urgency (ramp wall, blocked lane, imminent exit) lets a
// driver accept progressively tighter gaps so traffic never wedges solid.
function gapCheck(car, target, urgency) {
  const ga = car.prof.gapAccept * Math.max(0.35, 1 - urgency);
  // Real gap acceptance is TIME-based: observed minimum accepted lead/lag gaps
  // at merges are ≈0.5–1.0 s each (smallest recorded ≈0.75–1 s total), so the
  // pocket demanded here scales with speed — ~0.35 s of lead gap and ~0.3 s of
  // lag gap at speed, plus a base margin and a strong surcharge on closing
  // speed. Urgency (ramp wall / imminent exit / blocked lane) lets a driver
  // accept progressively tighter pockets, like real drivers near a gore point.
  // Absolute floor on each margin: half a MERGE_MARGIN when relaxed, shrinking
  // toward ~2 m for a wedged driver — observed creep-merges at gore points
  // accept lead/lag buffers of only 1–2 m.
  const floor = MERGE_MARGIN * (0.5 - 0.3 * urgency);
  const lead = leaderInLane(car, target, N);
  const needAhead = Math.max(floor,
    (0.8 + 0.35 * car.v + 0.9 * Math.max(0, car.v - lead.leadV)) * ga);
  if (lead.gap < needAhead) return false;

  const fol = followerInLane(car, target, N);
  if (fol.foll) {
    // Physical guard, independent of urgency: the lag gap must exceed the
    // follower's EMERGENCY stopping distance for the speed it would have to
    // shed — no driver cuts in where contact is kinematically guaranteed.
    const shed = Math.max(0, fol.foll.v - car.v);
    const needBehind = Math.max(floor,
      shed * shed / (2 * B_SAFE * 2) + 0.2,
      (0.6 + 0.3 * fol.foll.v + 1.0 * shed) * ga);
    if (fol.gap < needBehind) return false;
    // Hard safety: the new follower must not be forced into harsh braking.
    // The bound is the canonical MOBIL b_safe (4 m/s²) for discretionary
    // changes, relaxing toward ~8 m/s² for a driver wedged at a gore point —
    // real forced merges DO impose hard (but not crash-level) braking on the
    // lag vehicle, and a stuck merger eventually goes for it.
    const saved = car.lane;
    car.lane = target;
    const aNt = accelInLane(fol.foll, fol.foll.lane);
    car.lane = saved;
    if (aNt < -B_SAFE * (1 + 2 * urgency)) return false;
  }
  return true;
}

// How pressed is this driver to complete its pending change? 0 = relaxed.
function lcUrgency(car) {
  let u = 0;
  if (cfg().hasRamp && (car.lane === rampLaneIdx() || car.lane2 === rampLaneIdx())) {
    const d = rampEnd() - car.cell;          // distance to the end-of-ramp wall
    u = Math.max(u, d < 2 ? 0.75 : d < 4 ? 0.55 : d < 7 ? 0.35 : 0.15);
  }
  if (car.exiting && offRampActive() && car.lane < sim.lanes - 1) {
    const d = cfg().offRampCell - car.cell;
    if (d >= 0) { if (d < 5) u = Math.max(u, 0.6); else if (d < 12) u = Math.max(u, 0.35); }
  }
  if (sim.incident && cfg().hasIncident && car.lane === sim.lanes - 1) {
    const d = INCIDENT_CELL - car.cell;
    if (d >= 0 && d < 8) u = Math.max(u, 0.55); // creeping out of the blocked lane
  }
  return u;
}

// Seconds for the lateral slide (smoothstep). NGSIM trajectory studies put
// freeway lane-change durations at ≈2.9–7.3 s with a mean around 4–5 s.
const LANE_CHANGE_TIME = 4.5;

// DECIDE → SIGNAL: switch the blinker on; no lateral movement yet. Forced
// merges (on-ramp) signal from the moment they hit the accel lane, so by the
// time a gap exists they've blinked plenty — they may move after ~1 s rather
// than stalling at the wall waiting out a long courtesy blink.
function startSignal(car, target, forced) {
  car.lc = {
    target, dir: Math.sign(target - car.lane), phase: 'signal',
    t: 0, wait: 0, forced, from: car.lane,
    sigTime: (forced ? Math.min(1, car.prof.signalTime) : car.prof.signalTime) *
             (0.8 + rng() * 0.4),
  };
  car.signal = car.lc.dir;
}

// SIGNAL → EXECUTE: begin the physical merge. The car immediately becomes the
// leader for target-lane traffic behind it (lane = target) while continuing to
// occupy and block the lane it is leaving (lane2) until mostly across.
function beginExecute(car) {
  const lc = car.lc;
  lc.phase = 'execute';
  lc.from = car.lane;
  car.lane2 = car.lane;
  car.lane = lc.target;
  car.laneFrom = car.laneCoord;   // slide starts from where the body actually is
  car.laneTo = lc.target;
  car.laneT = 0;
  sim.evLaneChanges.push(sim.time);
}

function cancelLC(car, cool) {
  car.lc = null;
  car.signal = 0;
  car.cool = cool;
}

// Early-phase escape hatch: if the pocket collapses while the body has barely
// crossed the line, steer back into the origin lane instead of forcing it.
function maybeAbort(car) {
  const lc = car.lc;
  if (lc.phase !== 'execute' || car.laneT >= 0.45) return;
  const lead = leaderInLane(car, car.lane, 8);
  const fol = followerInLane(car, car.lane, 8);
  const collapsed =
    lead.gap < 0.15 ||
    (fol.foll && (fol.gap < 0.1 || (fol.gap < 0.7 && fol.foll.v - car.v > 1.3)));
  if (!collapsed) return;
  lc.phase = 'abort';
  const back = lc.from;
  car.lane2 = car.lane;           // still straddling the abandoned target lane
  car.lane = back;
  car.laneFrom = car.laneCoord;
  car.laneTo = back;
  car.laneT = 0;
}

// One lane-change pass per tick: advance every car's plan one phase step.
// Forced moves (ramp merge, exiting toward the off-ramp) never give up;
// discretionary ones re-validate their motive and eventually lose patience.
function laneChangeStep() {
  // Pockets claimed THIS tick, so two cars in different lanes can't both begin
  // merging into the same (lane, ~cell) spot — neither would see the other
  // during evaluation since both still register in their origin lanes.
  const reserved = [];
  const slotFree = (lane, cell, len) => reserved.every(r =>
    r.lane !== lane ||
    Math.abs(r.cell - cell) > (r.len + len) / 2 + MERGE_MARGIN + 0.5);

  for (const car of sim.cars) { car.yieldFor = null; car.closeGap = false; }

  for (const car of sim.cars) {
    const lc = car.lc;

    if (lc && (lc.phase === 'execute' || lc.phase === 'abort')) {
      maybeAbort(car);            // mid-manoeuvre: only watch for gap collapse
      continue;
    }

    if (lc) {                     // ── SIGNAL / GAP-WAIT phase ──
      lc.t += 1;
      // Discretionary changes drop the plan if their own lane has opened up…
      if (!lc.forced) {
        const ownLead = leaderInLane(car, car.lane, N);
        if (ownLead.gap > car.prof.T * car.v + 4) { cancelLC(car, 2); continue; }
      }
      if (lc.t < lc.sigTime) continue;        // minimum blink time not served yet
      // …or after waiting too long for a gap that never comes.
      if (!lc.forced && ++lc.wait > car.prof.patience) {
        cancelLC(car, 3 + Math.floor(rng() * 3));
        continue;
      }
      const urgency = lcUrgency(car);
      if (gapCheck(car, lc.target, urgency) && slotFree(lc.target, car.cell, car.len)) {
        reserved.push({ lane: lc.target, cell: car.cell, len: car.len });
        beginExecute(car);
      }
      continue;
    }

    if (car.cool > 0) { car.cool -= 1; continue; }

    // Ramp/accel-lane cars: their only move is to merge LEFT into the rightmost
    // main lane, and they MUST get it done before the wall — forced, no timeout.
    if (cfg().hasRamp && car.lane === rampLaneIdx()) {
      startSignal(car, sim.lanes - 1, true);
      continue;
    }
    if (sim.lanes < 2) continue;

    // Exiting cars (interchange) weave toward the rightmost lane for the ramp.
    // They accept a real disadvantage (up to ≈0.75 m/s² = 0.10 cells/s²) to
    // line up the exit — the one legitimate reason to move into a slower lane.
    if (car.exiting && car.lane < sim.lanes - 1) {
      const g = mobilDesire(car, car.lane + 1);
      if (g !== null && g > -0.10) { startSignal(car, car.lane + 1, false); continue; }
    }

    // Discretionary MOBIL: evaluate both neighbours, take the best gain. The
    // 0.035 cells/s² (≈0.26 m/s²) floor on top of each profile's threshold
    // keeps churn down — a change must promise a tangible improvement before
    // the blinker comes on (cf. MOBIL Δa_th=0.1 m/s², Δa_bias=0.3 m/s²).
    let bestGain = 0.035, bestTarget = -1;
    for (const t of [car.lane - 1, car.lane + 1]) {
      if (car.exiting && t < car.lane) continue;   // exiters never drift left
      const g = mobilDesire(car, t);
      if (g !== null && g > bestGain) { bestGain = g; bestTarget = t; }
    }
    if (bestTarget >= 0) startSignal(car, bestTarget, false);
  }

  yieldPass();
}

// Cooperative yielding: a follower in the target lane that sees a blinker ahead
// reacts according to temperament. Courteous drivers (politeness ≥ .25 — normal
// and passive) ease off to open the gap; hot-headed ones (politeness < .1 —
// aggressive) close it instead. Flags are consumed by the integrator this tick.
function yieldPass() {
  for (const car of sim.cars) {
    const lc = car.lc;
    if (!lc) continue;
    const watching = lc.phase === 'signal' ||
                     (lc.phase === 'execute' && car.laneT < 0.35);
    if (!watching) continue;
    const fol = followerInLane(car, lc.target, 9);
    if (!fol.foll || fol.foll.lc) continue;   // busy with their own manoeuvre
    // Already alongside (bumper gap gone): no point braking — drive on past
    // and let the merger slot in behind instead.
    if (fol.gap < 0.2) continue;
    if (fol.foll.prof.politeness >= 0.25) fol.foll.yieldFor = car;
    else if (fol.foll.prof.politeness < 0.1) fol.foll.closeGap = true;
  }
}

// Advance the lateral slide animation for every car (called once per tick).
function advanceLaneAnim(dt) {
  for (const car of sim.cars) {
    if (car.laneT < 1) {
      car.laneT = Math.min(1, car.laneT + dt / LANE_CHANGE_TIME);
      const t = car.laneT;
      // Smoothstep for a natural ease-in/out across the line.
      const e = t * t * (3 - 2 * t);
      car.laneCoord = car.laneFrom + (car.laneTo - car.laneFrom) * e;
      // Visible steering: yaw the body with the lateral velocity, which peaks
      // mid-manoeuvre (smoothstep derivative 6t(1−t)) and straightens out.
      const latV = (car.laneTo - car.laneFrom) * 6 * t * (1 - t) / LANE_CHANGE_TIME;
      car.tilt = Math.max(-0.20, Math.min(0.20, latV * 0.34));
      // Mostly across: release the lane being left for trailing traffic.
      if (car.laneT >= 0.55 && car.lane2 != null) car.lane2 = null;
      if (car.laneT >= 1) {
        car.laneCoord = car.laneTo;
        car.lane2 = null;
        car.tilt = 0;
        if (car.lc) {
          // Settle into the lane before considering another move — except
          // exiters mid-weave, who may need the next lane right away.
          car.cool = car.lc.phase === 'abort' ? 4
                   : car.exiting ? 1
                   : 4 + Math.floor(rng() * 5);
          car.lc = null;
        }
      }
    } else {
      car.laneCoord = car.lane;
      car.tilt = 0;
    }
    // Blinker state: an active plan owns the signal (off while steering back
    // from an abort); otherwise committed exiters blink right for the ramp.
    if (car.lc) car.signal = car.lc.phase === 'abort' ? 0 : car.lc.dir;
    else car.signal = (car.exiting && car.exitDecided) ? 1 : 0;
  }
}

//──────────────────────────── Longitudinal integration & movement ────────────────────────────
// Integrate IDM over SUBSTEPS sub-steps (dt = 1/SUBSTEPS s) for each car, then
// detect sensor crossings, off-ramp exits and right-edge outflow. Open-road
// model: traffic flows strictly left→right; a car whose position passes the
// right edge (near cell N) drives off and despawns. prevCell/prevLane are saved
// for the renderer's inter-tick interpolation.
function speedAndMoveStep() {
  // Integrate every car's IDM acceleration in lockstep sub-steps. Acceleration
  // is recomputed each sub-step against current positions; because per-substep
  // motion is small this stays collision-free without a strict parallel update.
  for (let s = 0; s < SUBSTEPS; s++) {
    const acc = new Array(sim.cars.length);
    for (let i = 0; i < sim.cars.length; i++) {
      const car = sim.cars[i];
      let a2 = accelInLane(car, car.lane);
      // Mid lane change: car-follow against BOTH lanes (min of the two) so the
      // straddling body never clips traffic in either. The lane being left
      // ignores the end-of-ramp wall (the body is already escaping it).
      if (car.lane2 != null) a2 = Math.min(a2, accelInLane(car, car.lane2, true));
      if (car.yieldFor) {
        // Courteous: ease off toward the signalling car ahead as if it were a
        // leader wanting an extra courtesy buffer — gentle deceleration only,
        // only while the merger is genuinely ahead and we'd otherwise keep
        // closing on it (never brake to a standstill for a blinker).
        const yf = car.yieldFor;
        const g = (yf.cell - car.cell) - (car.len || CAR_LEN);
        if (g > 0.1 && car.v > yf.v - 0.2) {
          const ay = idmAccel(car, Math.max(0.3, g - 1.0), yf.v);
          // Courtesy yielding is GENTLE: cap at ~1.5 m/s² (0.2 cells/s²) —
          // a real driver lifts off / brushes the brake for a merger, never
          // brakes hard for someone else's blinker.
          if (ay < a2) a2 = Math.max(ay, -0.2);
        }
      } else if (car.closeGap && a2 > -0.1) {
        // Aggressive: nudge forward (~0.5 m/s²) to deny the merger the pocket.
        a2 = Math.min(a2 + 0.07, car.prof.a);
      }
      acc[i] = a2;
    }
    for (let i = 0; i < sim.cars.length; i++) {
      const car = sim.cars[i];
      let v = car.v + acc[i] * SUB_DT;
      if (v < 0) v = 0;                       // clamp speed ≥ 0 (no reversing)
      car.v = v;
      car.cell += v * SUB_DT;
      // Ring math keeps cell in [0,N); right-edge despawn is detected via wrap.
      // (We detect the wrap during the post-move scan below.)
    }
  }

  // Post-move bookkeeping: braking flag, sensor counts, exits, outflow.
  const remove = new Set();
  for (let i = 0; i < sim.cars.length; i++) {
    const car = sim.cars[i];
    car.age += 1;
    car.accel = car.v - car.startV;
    car.braking = car.v < car.startV - 0.02;       // decelerating ⇒ brake lights

    // Did the car pass the right edge this tick? Detect via ring wrap: its
    // continuous cell exceeded N during integration.
    let wrapped = false;
    if (car.cell >= N) { car.cell -= N; wrapped = true; }

    const prev = car.prevCell;
    const movedDist = wrapped ? (car.cell + N - prev) : (car.cell - prev);

    // Throughput sensor crossing: counted when the car advanced past the sensor
    // cell this tick (forward distance to it ≤ distance travelled).
    const dSensor = fwd(prev, SENSOR_CELL);
    if (movedDist > 0 && dSensor > 0 && dSensor <= movedDist) sim.evThroughput.push(sim.time);

    if (offRampActive()) {
      // Commit/re-roll the exit decision upstream of the ramp.
      const dDecide = fwd(prev, EXIT_DECIDE_CELL);
      if (!car.exitDecided && movedDist >= dDecide && dDecide >= 0) {
        car.exiting = rng() < car.exitChance;
        car.exitDecided = true;
      }
      // Off-ramp departure: an exiting car in the rightmost lane peels off. One
      // that crosses the gore point still stuck in an inner lane has MISSED the
      // exit — it gives up (blinker off) and drives on like everyone else.
      const dExit = fwd(prev, cfg().offRampCell);
      if (car.exiting && movedDist >= dExit && dExit >= 0 && !wrapped) {
        if (car.lane === sim.lanes - 1 && car.lane2 == null) {
          remove.add(i); sim.rampQueue++; continue;
        }
        car.exiting = false;
      }
    }

    // Stop event (city metric): came to rest this tick at/near a light.
    if (car.v < 0.05 && car.startV >= 0.05) sim.evStops.push(sim.time);

    // Right-edge outflow: main-lane cars that wrapped past the seam have exited.
    // Ramp/accel-lane cars are still merging and are kept until they reach a
    // main lane (they can't realistically wrap before merging on this short ring,
    // but guard anyway).
    if (wrapped && (!cfg().hasRamp || car.lane < sim.lanes)) remove.add(i);
  }
  if (remove.size) sim.cars = sim.cars.filter((_, i) => !remove.has(i));
}

//──────────────────────────── Spawning / ramp meter ────────────────────────────
// Open-road inflow: fresh cars enter from the LEFT edge for every scenario and
// flow rightward; right-edge outflow removes them at the far side. Inflow scales
// with the population deficit (target − current) so the road fills GRADUALLY
// from empty, climbs toward effTarget() at a believable pace, then holds. Because
// makeCar reads the CURRENT sliders, the left-edge stream always reflects the
// latest settings; the on-screen mix shifts as old cars exit right.
function spawnStep() {
  const target = effTarget();

  if (cfg().hasRamp) {
    // Metered on-ramp as a SECONDARY inflow with a small standing queue.
    const pop = sim.cars.length;
    const want = Math.min(6, Math.max(0, target - pop));
    if (sim.rampQueue < want && rng() < 0.5) sim.rampQueue++;
    else if (sim.rampQueue > want) sim.rampQueue = want;

    const entry = rampStart();
    const entryFree = laneEntryFree(rampLaneIdx(), entry, 3.6);
    if (sim.meterOn) {
      sim.meterTimer++;
      if (sim.meterTimer >= sim.meterInterval && sim.rampQueue > 0 && entryFree) {
        sim.meterTimer = 0;
        releaseRampCar(entry);
      }
    } else if (sim.rampQueue > 0 && entryFree) {
      releaseRampCar(entry);
    }
  }

  spawnLeftEdge(target);
}

// Is there a clear pocket (≥ minGap cells of clear road ahead, and nothing
// straddling the entry point) at `cell` in `lane` for a fresh insertion?
function laneEntryFree(lane, cell, minGap) {
  for (const o of sim.cars) {
    if (!occupiesLane(o, lane)) continue;
    const d = o.cell - cell;                  // signed: + ahead of entry, − behind
    if (d >= 0 && d < minGap) return false;   // room for the newcomer's body + gap
    if (d < 0 && -d < o.len + 0.4) return false; // something straddling the entry
  }
  return true;
}

// Inject fresh cars at the leftmost cells. Rate scales with the deficit so a
// 0→target fill takes a few seconds; near target it falls to a trickle that
// just replaces cars leaving on the right.
function spawnLeftEdge(target) {
  const queued = cfg().hasRamp ? sim.rampQueue : 0;
  let deficit = target - sim.cars.length - queued;
  if (deficit <= 0) return;
  let budget = Math.min(sim.lanes, Math.max(1, Math.ceil(deficit / 8)));
  const lanes = [...Array(sim.lanes).keys()].sort(() => rng() - 0.5);
  for (const l of lanes) {
    if (budget <= 0) break;
    if (!laneEntryFree(l, 0, 4.5)) continue;   // need breathing room (truck-sized)
    const r = leaderInLane({ lane: l, cell: 0, v: 0, len: CAR_LEN, prof: PROFILES.normal, isTruck: false, speedFactor: 1 }, l, N);
    const car = makeCar(l, 0, 1);
    // Arrival speed: the visible strip is a slice of a longer road, so a car
    // "was already driving" before it appeared — it enters at the speed the
    // traffic ahead supports, not from a near-standstill. Clear lane ⇒ its own
    // desired speed; leader ahead ⇒ the comfortable-braking kinematic envelope
    // v = √(v_lead² + 2·b·(gap − s0)): the fastest speed from which it can
    // still ease down to the leader's pace within the available gap at its
    // comfortable deceleration. (A driver coming up on a queue from upstream
    // would have ALREADY slowed before entering the visible strip.)
    const free = carV0(car);
    const eq = r.lead
      ? Math.sqrt(r.leadV * r.leadV +
                  2 * car.prof.b * Math.max(0, r.gap - car.prof.s0))
      : free;
    car.v = car.startV = Math.max(0.4, Math.min(free, eq));
    sim.cars.push(car);
    budget--;
  }
}

function releaseRampCar(entry) {
  const car = makeCar(rampLaneIdx(), entry, 0);  // re-rolls profile & exit chance
  // Real merge behavior is speed matching: an unmetered driver rolls down the
  // ramp carrying speed (~30–40 mph, more on a longer acceleration lane) so it
  // arrives near mainline pace; a metered release launches from a standing
  // start at the stop bar (~20 mph by the merge area).
  const want = sim.meterOn ? 1.2 : Math.min(2.4, 1.2 + rampLen() * 0.11);
  // Cap that desired entry speed by the comfortable-braking envelope to whatever
  // is queued ahead in the acceleration lane — exactly as left-edge arrivals are
  // capped (see spawnLeftEdge). A car rolling onto a backed-up accel lane must
  // still be able to ease down to its leader's pace within the available gap, so
  // it can never overrun a stopped merge queue and clip its tail.
  const r = leaderInLane(car, rampLaneIdx(), N);
  // Physical fit guard: the rolled vehicle's body (rear at the entry cell, front
  // at entry + car.len) must clear the pocket ahead. A long truck can be longer
  // than the entry gate's fixed clearance, so without this it would be placed
  // straddling a car already queued in the accel lane. If it doesn't fit, leave
  // it queued and try again next tick rather than clip the line.
  if (r.lead && r.gap < car.prof.s0) return;
  const eq = r.lead
    ? Math.sqrt(r.leadV * r.leadV +
                2 * car.prof.b * Math.max(0, r.gap - car.prof.s0))
    : want;
  car.v = car.startV = Math.max(0.4, Math.min(want, eq));
  sim.cars.push(car);
  sim.rampQueue--;
}

//──────────────────────────── Sim tick ────────────────────────────
// Snapshot prev state for the renderer's inter-tick interpolation. Taken at
// the very top of the tick, BEFORE the lane animation advances, so the lateral
// slide and steering tilt lerp smoothly at 60 fps instead of stepping per tick.
function snapshotPrev() {
  for (const car of sim.cars) {
    car.prevCell = car.cell;
    car.prevLane = car.laneCoord;   // renderer lerps the CONTINUOUS lane coord
    car.prevLaneT = car.laneT;      // lets the renderer evaluate the exact S-curve
    car.prevTilt = car.tilt;
    car.startV = car.v;
  }
}

function tick() {
  sim.time++;
  snapshotPrev();          // freeze last tick's pose for 60 fps interpolation
  laneChangeStep();        // signal / gap-wait / begin-merge state machine
  advanceLaneAnim(1);      // advance the lateral slide animation by one second
  speedAndMoveStep();      // IDM: integrate longitudinal motion & handle exits
  spawnStep();             // open-road inflow at the left edge (+ ramp)
  // Trim rolling event logs to the last 2 minutes of sim time.
  const cut = sim.time - 120;
  for (const k of ['evThroughput', 'evLaneChanges', 'evStops']) {
    sim[k] = sim[k].filter(t => t > cut);
  }
  sim.lastTickWall = performance.now();
}

//──────────────────────────── Reset / seeding ────────────────────────────
// Reset rebuilds the world and starts the road EMPTY. Traffic is no longer
// pre-seeded across the whole ring; instead the open-road model takes over from
// t=0 — fresh cars flow in at the LEFT edge (spawnStep → spawnLeftEdge) and the
// population climbs toward effTarget() over a few seconds, so the user literally
// watches traffic accumulate and congestion form from the left. Cars exit on the
// right, keeping a steady left→right flow. The ramp queue also starts empty and
// fills from spawnStep, so the highway/interchange on-ramp behaves the same way.
function resetSim() {
  sim.cars = [];
  hooks.selectCar(null);
  sim.rampQueue = 0;
  sim.meterTimer = 0;
  sim.time = 0;
  sim.evThroughput = []; sim.evLaneChanges = []; sim.evStops = [];
  sim.speedHistory = [];

  // Road starts empty: no pre-seeding. spawnLeftEdge() builds the population up
  // from zero toward effTarget() as the sim runs, entering from the left edge.
  if (cfg().style === 'city') genBuildings();
  sim.lastTickWall = performance.now();
}

// Change the number of main lanes IN PLACE, without clearing the fleet.
//   • Increasing: just widen the road. Existing cars stay put; they migrate into
//     the new emptier lane over the next seconds via MOBIL (path of least
//     resistance). New left-edge arrivals may use any lane.
//   • Decreasing: relocate any car now in a vanished lane (index ≥ n) into the
//     nearest still-valid lane, picking a safe gap when one exists; otherwise it
//     is dropped onto the edge lane and merges as soon as IDM/MOBIL allow (it
//     will simply slot in — no hard delete). The ramp/accel lane follows
//     sim.lanes automatically (rampLaneIdx === sim.lanes).
function applyLaneCount(n) {
  const opts = cfg().laneOptions;
  if (!opts.includes(n)) n = cfg().defaultLanes;
  const old = sim.lanes;
  if (n === old) { sim.lanes = n; hooks.updateLabels(); return; }

  if (n < old) {
    // Move cars out of lanes that will no longer exist (lane index ≥ n).
    for (const car of sim.cars) {
      let lane = car.lane;
      // A ramp/accel-lane car (index === old) maps onto the new ramp lane (n).
      if (cfg().hasRamp && lane === old) { car.lane = n; car.laneFrom = car.laneTo = car.laneCoord = n; continue; }
      if (lane < n) continue;            // still valid
      // Find the nearest valid lane (search inward) that has a safe pocket.
      let placed = -1;
      for (let t = n - 1; t >= 0; t--) {
        const probe = { lane: car.lane, cell: car.cell, len: car.len };
        const aheadGap = leaderInLane({ ...probe, v: car.v }, t, N).gap;
        const behindGap = followerInLane({ ...probe }, t, N).gap;
        if (aheadGap > 0.2 && behindGap > 0.2) { placed = t; break; }
      }
      if (placed < 0) placed = n - 1;    // no safe gap: drop onto edge lane, IDM sorts it out
      car.lane = placed;
      car.laneFrom = car.laneTo = car.laneCoord = placed;
      car.laneT = 1;
    }
  }

  // Lane indices (and the ramp-lane index) just shifted under any in-flight
  // lane-change plans: cancel them all cleanly so nobody slides into a lane
  // that no longer exists. The cars re-decide within a couple of seconds.
  for (const car of sim.cars) {
    if (car.lc) { car.lc = null; car.signal = 0; car.cool = 2; }
    if (car.lane2 != null) car.lane2 = null;
    car.laneT = 1;
    car.laneFrom = car.laneTo = car.laneCoord = car.lane;
    car.tilt = 0;
  }

  sim.lanes = n;
  // Rebuild lane-indexed structures and force the static scene to redraw at the
  // new width (the render loop keys off sim.lanes in its signature).
  hooks.invalidateScene();
  hooks.updateLabels();
}

// Deterministic pseudo-random skyline for the city backdrop.
function genBuildings() {
  let seed = 1337;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  sim.buildings = [];
  for (const side of ['top', 'bottom']) {
    let c = 0;
    while (c < N) {
      const w = 6 + Math.floor(rnd() * 14);
      sim.buildings.push({
        side, c0: c, w: Math.min(w, N - c),
        h: 18 + rnd() * 30,
        shade: 30 + Math.floor(rnd() * 18),
        win: rnd() > 0.3,
      });
      c += w + 1;
    }
  }
}

export {
  setEngineHooks, LANE_CHANGE_TIME,
  lightPhases, lightOffset, lightState, makeCar, fwd, occupiesLane,
  leaderInLane, followerInLane, leaderGap, idmAccel, accelInLane,
  tick, resetSim, applyLaneCount, genBuildings,
};
