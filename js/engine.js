// Simulation engine: traffic lights, vehicles, gap queries, IDM+/ACC
// car-following with human reaction delay, distraction lapses, MOBIL lane
// changes (signal / gap-wait / steer-over state machine), the longitudinal
// integrator, demand-driven spawning with entry/ramp queues, variable speed
// limits, incidents & rubbernecking, trip logging and the per-second tick.
// No DOM access and no UI/render imports: presentation is reached only through
// the injectable `hooks` (selectCar / updateLabels / invalidateScene), wired
// by main.js. One tick = one simulated second regardless of wall-clock pacing
// (sim.timeScale only changes how often main.js calls tick()).
import {
  N, SUBSTEPS, SUB_DT, SENSOR_CELL, INCIDENT_CELL, EXIT_DECIDE_CELL, MPH_PER_CELL,
  ROAD_MILES, CAR_LEN, TRUCK_LEN, PROFILES, TRUCK_OVERRIDE, B_SAFE, MERGE_MARGIN,
  EXIT_RAMP_SPEED, AV_PROFILE, ACC_COOLNESS, REACTION_SPREAD,
  DISTRACT_MEAN_INTERVAL, DISTRACT_DUR, PHANTOM_DECEL, PHANTOM_DUR, RUBBERNECK,
  VSL, ARRIVAL_TMIN, RAMP_ARRIVAL_TMIN, ENTRY_QUEUE_MAX, RAMP_STORAGE,
  LIGHT_TYPES, BUS_SHARE, BUS_OVERRIDE,
} from './config.js';
import {
  sim, cfg, offRampActive, rampLaneIdx, rampLen, rampStart, rampEnd,
  decelStart, decelEnd, inAccelLane, inDecelLane, densityCap,
  vmaxFloat, rollSpeedFactor, carV0, carV0Ideal, weatherParams,
  incidentActive, laneBlocked,
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
const nowMs = () => (typeof performance !== 'undefined' ? performance : Date).now();

//──────────────────────────── Traffic lights (city) ────────────────────────────
// sim.greenSplit is the arterial's share of the cycle (g/C). Yellow is ~4 s per
// 60 s of cycle (ITE change interval ≈ 3–5 s); red takes the remainder (the
// cross street's green plus all-red). Red never vanishes.
function lightPhases() {
  const c = sim.cycleLen;
  const yellow = Math.max(3, Math.round(c * 4 / 60));
  const split = Math.max(0.2, Math.min(0.8, Number.isFinite(sim.greenSplit) ? sim.greenSplit : 0.5));
  const green = Math.max(5, Math.min(c - yellow - 3, Math.round(c * split)));
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
function carColor(profName, isTruck, isAV) {
  const h = (a, b) => a + rng() * (b - a);
  if (isTruck) return `hsl(${h(22, 48)},${h(12, 22)}%,${h(58, 74)}%)`;       // tan rigs
  if (isAV) return `hsl(${h(180, 200)},${h(18, 32)}%,${h(78, 88)}%)`;        // pale silver-teal
  if (profName === 'aggressive') return `hsl(${(h(-8, 14) + 360) % 360},${h(68, 88)}%,${h(48, 60)}%)`; // hot red
  if (profName === 'passive')    return `hsl(${h(205, 232)},${h(38, 56)}%,${h(54, 68)}%)`; // cool blue
  return `hsl(${h(0, 360)},${h(6, 20)}%,${h(54, 80)}%)`;                     // neutral
}
// Ring buffer of commanded accelerations (one entry per integration sub-step)
// used to delay a human driver's response by its reaction time.
const HIST = 16;   // ≥ 2.0 s × 1.2 spread / 0.2 s sub-step + margin

// Create a car. Profile, vehicle type, automation, distraction-proneness,
// speed factor and color are rolled ONCE here from the CURRENT slider values
// and persist for the car's entire life — slider changes only affect cars
// spawned afterwards, never this one.
function makeCar(lane, cell, v) {
  const isTruck = rng() * 100 < sim.pctTrucks;
  const isAV = rng() * 100 < (sim.pctAV || 0);
  const profName = isAV ? 'av' : rollProfile(isTruck);
  // Vehicle body type.
  let vehType = 'truck', lenMul;
  if (isTruck) {
    const busShare = BUS_SHARE[cfg().style] ?? 0.1;
    vehType = rng() < busShare ? 'bus' : 'truck';
    lenMul = vehType === 'bus' ? 0.80 + rng() * 0.08 : 0.92 + rng() * 0.18;
  } else {
    let r = rng(), t = LIGHT_TYPES[0];
    for (const lt of LIGHT_TYPES) { if (r < lt.share) { t = lt; break; } r -= lt.share; }
    vehType = t.type;
    lenMul = t.lenMul[0] + rng() * (t.lenMul[1] - t.lenMul[0]);
  }
  // Build the effective IDM/MOBIL parameter set: base profile, then truck/bus
  // overrides merged on top. Stored per-car so slider changes never mutate it.
  const base = isAV ? AV_PROFILE : PROFILES[profName];
  let prof = base;
  if (isTruck) {
    prof = Object.assign({}, base, TRUCK_OVERRIDE, vehType === 'bus' ? BUS_OVERRIDE : null);
    // An automated rig keeps its truck physics but runs a slightly tighter,
    // delay-free gap (truck platooning trials: ≈0.8–1.5 s).
    if (isAV) prof.T = 1.4;
  }
  // Interchange: each car gets a permanent random 15–30% chance of taking the
  // off-ramp; it rolls that chance once upstream of the ramp, then weaves right.
  const exitChance = offRampActive()
    ? Math.min(0.9, (sim.exitPct / 100) * (0.75 + rng() * 0.5))
    : 0;
  // Physical length in cells (small per-vehicle variance around the baselines).
  const len = (isTruck ? TRUCK_LEN : CAR_LEN) * lenMul;
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
    zipperFor: null, zipperU: 0,      // per-tick zipper-merge flags (forced merges)
    profName, prof, isTruck, isAV, vehType,
    speedFactor: rollSpeedFactor(profName),
    exitChance, exiting: rng() < exitChance, exitDecided: false,
    cool: 0, age: 0, braking: false, accel: 0,
    accA: 0,                  // acceleration actually applied last sub-step (cells/s²)
    // Human factors (AVs: no delay, never distracted).
    reactFactor: isAV ? 0 : REACTION_SPREAD[0] + rng() * (REACTION_SPREAD[1] - REACTION_SPREAD[0]),
    aHist: new Float64Array(HIST), aHistPos: 0,
    distractProne: !isAV && rng() * 100 < (sim.pctDistracted || 0),
    distracted: false, distractUntil: 0, lapseA: 0,
    phantomUntil: -Infinity, phantom: false,
    // Trip bookkeeping for travel-time / delay / stops statistics.
    arriveTime: sim.time, enterTime: sim.time, spawnCell: cell, stops: 0, stopped: false,
    color: carColor(profName, isTruck, isAV),
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
  if (laneBlocked(lane)) {
    // Incident block across `incidentLanes` lanes. A body already nosing past
    // the block's upstream face (e.g. the incident was switched on under it)
    // is let through rather than frozen inside the obstacle.
    const d = INCIDENT_CELL - car.cell;
    if (d >= 0 && d < best && d - (car.len || CAR_LEN) > -0.5) best = d;
  }
  return best;
}

// End of the on-ramp acceleration lane (the gore wall). The single auxiliary
// row carries two speed-change lanes; a car in the ON-ramp acceleration lane
// must merge LEFT before rampEnd(). (The OFF-ramp deceleration lane needs no
// wall: exiting cars ease to the advisory and depart at the gore.)
// Unlike a red light, drivers do NOT treat the lane end as a car to follow
// at a safe time gap — that would have them braking from the moment they
// enter the lane. They keep accelerating while hunting for a gap and only
// brake once the deceleration needed to stop at the end, b_kin = v²/2d,
// reaches ~60 % of their comfortable b (then they brake at ≈b_kin, which
// stops them right at the end). Returns an acceleration cap (cells/s²) or
// Infinity when the wall does not bind. `skipWall`: the lane being left.
function rampWallAccel(car, lane, skipWall) {
  if (skipWall || !cfg().hasRamp || lane !== rampLaneIdx() || !inAccelLane(car.cell)) return Infinity;
  const P = drv(car);
  const d = rampEnd() - car.cell - (car.len || CAR_LEN) - 0.15;
  if (d <= 0.05) return -P.brake;                 // nose at the end: hold
  const bk = car.v * car.v / (2 * d);
  if (bk < 0.6 * P.b) return P.a * Math.min(1, d / 2.5);   // ease the final creep
  return Math.max(-P.brake, -1.15 * bk);
}

//──────────────────────────── Effective driver parameters ────────────────────────────
// Rubbernecking intensity in [0,1] at `cell`: fades in upstream of the
// incident, holds alongside it, fades out downstream (RUBBERNECK zone).
// Length (cells) of the wreck in each blocked lane, downstream of INCIDENT_CELL.
const INCIDENT_SPAN = 2;

function rubberneckFactor(cell) {
  const R = RUBBERNECK;
  const d = cell - INCIDENT_CELL;
  if (d <= R.from || d >= R.to) return 0;
  if (d < R.full) return (d - R.from) / (R.full - R.from);
  if (d <= R.until) return 1;
  return (R.to - d) / (R.to - R.until);
}
// Is `cell` inside the active variable-speed-limit zone?
function inVslZone(cell) {
  const z = sim.vslZone;
  return !!z && cell >= z.start && cell <= z.end;
}
// Effective IDM parameters for `car` RIGHT HERE: profile × weather, plus the
// location effects — the VSL posted limit (humans comply only partially, AVs
// fully) and rubbernecking next to an incident (humans only).
function drv(car) {
  const p = car.prof, w = weatherParams();
  let v0 = carV0(car);
  let T = p.T * w.Tmul;
  if (inVslZone(car.cell)) {
    const free = vmaxFloat();
    const lim = Math.min(free, sim.vslMph / MPH_PER_CELL);
    if (lim < free - 1e-9) {
      const eff = car.isAV ? lim : lim + (free - lim) * (1 - VSL.compliance);
      v0 = Math.min(v0, Math.max(0.5, eff * p.v0Mult * car.speedFactor));
    }
  }
  if (!car.isAV && sim.rubbernecking && incidentActive()) {
    const f = rubberneckFactor(car.cell);
    if (f > 0) {
      v0 *= 1 - f * (1 - RUBBERNECK.v0Mul);
      T *= 1 + f * (RUBBERNECK.Tmul - 1);
    }
  }
  // Available acceleration falls with speed: drivers pull away from a stop at
  // ≈2–2.5 m/s² but accelerate at highway speed at ≈1–1.5 m/s² (Long 2000,
  // TRR 1737; Bham & Benekohal 2002). Without this, signal queues discharge
  // at ~3.4 s headways instead of the ≈2 s saturation headway (HCM: ~1,900
  // veh/h of green per lane).
  const launch = 1 + LAUNCH_BOOST * Math.max(0, 1 - car.v / Math.max(0.5, v0));
  return {
    v0, T,
    s0: p.s0 + w.s0add,
    a: p.a * w.aMul * launch,
    b: p.b * w.bMul,
    brake: 2 * B_SAFE * w.brakeMul,   // emergency braking ceiling (friction-limited)
  };
}
// Desired speed for `car` at its current position (inspector / render helper).
function effV0(car) { return drv(car).v0; }

//──────────────────────────── IDM+ / ACC longitudinal model ────────────────────────────
// IDM+ (Schakel, van Arem & Netten, ITSC 2010):
//   a = a_max · min( 1 − (v/v0)^δ ,  1 − (s*(v,Δv)/s)² ),
//   s*(v,Δv) = s0 + max(0, v·T + v·Δv / (2·√(a·b)))
// where s is the bumper-to-bumper gap (cells), Δv = v − v_lead (approach rate).
// IDM+ keeps IDM's "intelligent" braking but its equilibrium gap is exactly
// s0 + vT, so lane capacity lands near the empirical ~1,900–2,200 veh/h instead
// of plain IDM's ~1,550 (with these long, render-scale bodies). When v > v0
// (entering a lower VSL / rubbernecking zone) the free-road term uses the
// smooth over-speed branch of Treiber & Kesting's IIDM, −b·[1 − (v0/v)^(aδ/b)],
// so drivers ease down at ≤ b rather than slamming on the brakes.
//
// AVs blend IDM with the constant-acceleration heuristic (CAH) — the ACC model
// of Kesting et al. (2010): it uses the leader's acceleration and does not
// over-react to cut-ins or to a leader that is already braking enough.
const IDM_DELTA = 4;
const LAUNCH_BOOST = 0.6;  // max accel at standstill = (1 + 0.6) × profile a
const ANTICIPATION = 0.6;   // α: fraction of the τ-ahead gap change a human anticipates

function cahAccel(s, v, vl, al, a) {
  const ale = Math.min(al, a);
  const denom = vl * vl - 2 * s * ale;
  if (vl * (v - vl) <= -2 * s * ale && denom > 1e-6) return v * v * ale / denom;
  const dv = v - vl;
  return ale - (dv > 0 ? dv * dv : 0) / (2 * s);
}

// Compute the acceleration (cells/s²) for `car` given the gap (cells) to the
// effective leader, that leader's speed and (AVs only) its acceleration.
// Clamped for numerical safety at the friction-limited emergency ceiling.
function idmAccel(car, gap, leadV, leadA) {
  const P = drv(car);
  const v = car.v, v0 = P.v0, a = P.a, b = P.b;
  const dv = v - leadV;                              // approach rate
  // Human anticipation (Treiber, Kesting & Helbing 2006, Human Driver Model):
  // a driver who knows they respond τ late judges the gap it WILL be, by
  // extrapolating the closing speed, s_est = s − α·τ·Δv. Estimation is
  // imperfect (α < 1), so long reaction times still destabilise traffic.
  if (!car.isAV && gap < 1e6) {
    const tau = (sim.reactionTime || 0) * (car.reactFactor || 1);
    gap -= ANTICIPATION * tau * dv;
  }
  // Guard the gap so a momentary overlap can't blow up the (s*/s)² term.
  const s = Math.max(0.05, gap);
  let sStar = P.s0 + v * P.T + (v * dv) / (2 * Math.sqrt(a * b));
  if (sStar < P.s0) sStar = P.s0;                    // desired gap never below s0
  const free = v <= v0
    ? 1 - Math.pow(v / v0, IDM_DELTA)
    : -(b / a) * (1 - Math.pow(v0 / v, a * IDM_DELTA / b));
  const inter = 1 - (sStar / s) * (sStar / s);
  let acc = a * Math.min(free, inter);
  if (car.isAV && leadA !== undefined && gap > 0.05) {
    const aCah = cahAccel(s, v, leadV, leadA, a);
    if (acc < aCah) {
      const c = ACC_COOLNESS;
      acc = (1 - c) * acc + c * (aCah + b * Math.tanh((acc - aCah) / b));
    }
  }
  // Clamp braking to a sane bound (also caps the (s*/s)² blow-up near s→0).
  if (acc < -P.brake) acc = -P.brake;
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
  let leadA = r.lead ? (r.lead.accA || 0) : 0;
  let virtual = false;
  // A stationary virtual obstacle (red light / incident / ramp wall) becomes the
  // effective leader (speed 0) when its stop line is nearer than the real leader.
  const obst = virtualObstacle(car, lane, skipWall);
  if (Number.isFinite(obst)) {
    const obstGap = obst - (car.len || CAR_LEN);
    if (obstGap < gap) { gap = obstGap; leadV = 0; leadA = 0; virtual = true; }
  }
  let acc = idmAccel(car, gap, leadV, leadA);
  const wall = rampWallAccel(car, lane, skipWall);
  if (wall < acc) acc = wall;

  // Multi-vehicle anticipation (Treiber/Kesting's human-driver extension of
  // IDM): real drivers watch the car AHEAD of their leader through its rear
  // window and ease off early when the platoon up front is slower, instead of
  // reacting late and braking hard. Modelled as also car-following the
  // second leader over the combined gap and taking the more cautious of the
  // two accelerations — this only binds when the far vehicle is the slower one.
  if (r.lead && !virtual) {
    const r2 = leaderInLane(r.lead, lane, scan);
    if (r2.lead && r2.leadV < leadV) {
      const gap2 = gap + (r.lead.len || CAR_LEN) + r2.gap;
      const acc2 = idmAccel(car, gap2, r2.leadV, r2.lead.accA || 0);
      if (acc2 < acc) acc = acc2;
    }
  }

  // Lane closure ahead: a driver in a blocked lane who must merge left
  // SYNCHRONISES with the target lane instead of racing up the empty closed
  // lane — it car-follows the target lane's next vehicle at a relaxed gap so it
  // drifts alongside a gap (the speed-adaptation step of merging models,
  // e.g. Hidas 2002; Treiber & Kesting §14). Without this nearly every car
  // reaches the wreck before merging and the closure jams solid.
  if (lane === car.lane && laneBlocked(lane) && lane > 0) {
    const d = INCIDENT_CELL - car.cell;
    if (d > 0 && d < 40) {
      const adj = leaderInLane(car, lane - 1, 30);
      if (adj.lead && adj.leadV < car.v) {
        const accSync = idmAccel(car, adj.gap + 1.5, adj.leadV, adj.lead.accA || 0);
        if (accSync < acc) acc = Math.max(accSync, -drv(car).b);
      }
    }
  }

  // Exit-ramp approach: a driver committed to the off-ramp and now in the
  // DECELERATION lane sheds speed GRADUALLY toward the ramp advisory, following
  // a comfortable kinematic envelope v(d) = sqrt(v_ramp² + 2·b·d) toward the
  // gore (decelEnd) instead of sailing into it at full highway speed. The long
  // auxiliary decel lane is where the slowing happens, so through traffic in
  // the mainline is never held up by an exiting car. (Real drivers move into
  // the deceleration lane first, THEN slow to the advisory before the gore.)
  if (car.exiting && car.exitDecided && offRampActive() &&
      lane === rampLaneIdx() && car.lane === rampLaneIdx() && inDecelLane(car.cell)) {
    const d = decelEnd() - car.cell;
    if (d > 0) {
      const vAllow = Math.sqrt(EXIT_RAMP_SPEED * EXIT_RAMP_SPEED +
                               2 * car.prof.b * d);
      const accExit = Math.max(-B_SAFE * 2, drv(car).a *
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
// Truck lane restriction: heavy vehicles may not enter the leftmost lane.
function truckBanned(car, lane) {
  return car.isTruck && sim.truckLaneRestriction && lane === 0 && sim.lanes > 1;
}

// MOBIL incentive (no hard gap gate here — that is what the gap wait is for):
//   ã_c − a_c + p·[(ã_o − a_o) + (ã_n − a_n)] + Δa_bias − Δa_th > 0
// where c = ego, o = old follower, n = new follower, tilde = after the move.
function mobilDesire(car, target) {
  if (target < 0 || target > sim.lanes - 1) return null;
  if (truckBanned(car, target)) return null;
  // Drivers see the flashing lights well upstream and don't move INTO a lane
  // that is closed ahead (it would only force another merge back out).
  if (laneBlocked(target) && !laneBlocked(car.lane) &&
      car.cell > INCIDENT_CELL - 40 && car.cell < INCIDENT_CELL + INCIDENT_SPAN + 1) return null;
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
  // Merge courtesy: approaching an on-ramp with traffic waiting to merge,
  // right-lane drivers who can move left do so to leave room (a widely
  // observed cooperative behaviour; cf. Hidas 2005, TR-C 13(1)). Polite
  // drivers do it more readily; nobody moves right INTO the merge area.
  if (cfg().hasRamp && car.cell > rampStart() - 14 && car.cell < rampEnd() &&
      (sim.rampQueue > 0 || sim.cars.some(o => o.lane === rampLaneIdx() && inAccelLane(o.cell)))) {
    if (savedLane === sim.lanes - 1 && target === savedLane - 1) bias += 0.03 + 0.06 * prof.politeness;
    if (target === sim.lanes - 1 && target > savedLane) bias -= 0.05;
  }

  const incentive = (aCt - aC) + prof.politeness * ((aOt - aO) + (aNt - aN));
  return incentive + bias - prof.threshold;          // > 0 ⇒ change is worthwhile
}

// Is there a safe pocket in `target` for `car` to begin merging into RIGHT NOW?
// Demands a bumper gap ahead and behind sized by the closing speeds and the
// driver's gapAccept; urgency (ramp wall, blocked lane, imminent exit) lets a
// driver accept progressively tighter gaps so traffic never wedges solid.
function gapCheck(car, target, urgency) {
  // Never slide into the wreck: in a blocked lane the crashed vehicles occupy
  // [INCIDENT_CELL, INCIDENT_CELL + INCIDENT_SPAN] (what the renderer draws).
  // A car already halted at the block in its OWN closed lane may still step
  // sideways into the next closed lane (its nose is no nearer that wreck), so
  // with 2+ lanes closed it can work its way across toward the open ones.
  const margin = laneBlocked(car.lane) ? 0 : 0.5;
  if (laneBlocked(target) && car.cell + (car.len || CAR_LEN) > INCIDENT_CELL - margin &&
      car.cell < INCIDENT_CELL + INCIDENT_SPAN + 0.5) return false;
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
  // Nor does a driver cut in so close behind a slower car that it would
  // itself have to brake hard (MOBIL's safety criterion applied to the ego
  // vehicle; same urgency-relaxed bound as for the new follower below).
  if (lead.lead) {
    const saved = car.lane;
    car.lane = target;
    const aCt = idmAccel(car, lead.gap, lead.leadV, lead.lead.accA || 0);
    car.lane = saved;
    if (aCt < -B_SAFE * (0.6 + 1.6 * urgency)) return false;
  }

  const fol = followerInLane(car, target, N);
  if (fol.foll) {
    // Physical guard, independent of urgency: the lag gap must exceed the
    // follower's EMERGENCY stopping distance for the speed it would have to
    // shed — no driver cuts in where contact is kinematically guaranteed.
    // Escaping a closed lane close to the wreck, the merger keeps braking for
    // it until its body is across (it cannot drive through it), so size the
    // lag gap as if it will stop — otherwise the new follower runs into it.
    // Likewise it keeps following a close leader in the lane it is leaving.
    const nearWreck = laneBlocked(car.lane) && INCIDENT_CELL - car.cell - (car.len || CAR_LEN) < 3;
    const own = car.lane < sim.lanes ? leaderInLane(car, car.lane, 3) : null;
    const vMerge = nearWreck ? 0 : own && own.lead ? Math.min(car.v, own.leadV) : car.v;
    const shed = Math.max(0, fol.foll.v - vMerge);
    const needBehind = Math.max(floor,
      shed * shed / (2 * 2 * B_SAFE * weatherParams().brakeMul) + 0.2,
      (0.6 + 0.3 * fol.foll.v + 1.0 * shed) * ga);
    if (fol.gap < needBehind) return false;
    // Hard safety: the new follower must not be forced into harsh braking.
    // The bound is ≈2.4 m/s² for a relaxed discretionary change (most drivers
    // won't make a follower brake harder than comfortably), reaching the
    // canonical MOBIL b_safe (4 m/s²) at moderate urgency and ~8 m/s² for a
    // driver wedged at a gore point —
    // real forced merges DO impose hard (but not crash-level) braking on the
    // lag vehicle, and a stuck merger eventually goes for it.
    const saved = car.lane;
    car.lane = target;
    const aNt = accelInLane(fol.foll, fol.foll.lane);
    car.lane = saved;
    if (aNt < -B_SAFE * (0.6 + 1.6 * urgency)) return false;
  }
  return true;
}

// How pressed is this driver to complete its pending change? 0 = relaxed.
// Urgency grows sharply as the deadline (a wall or a gore point) nears, letting
// a driver accept progressively tighter pockets so traffic never wedges solid.
function lcUrgency(car) {
  let u = 0;
  // On-ramp: an acceleration-lane car must merge LEFT before the gore wall.
  if (cfg().hasRamp && (inAccelLane(car.cell) || inAccelLane(car.cell - 0.5)) &&
      (car.lane === rampLaneIdx() || car.lane2 === rampLaneIdx())) {
    const d = rampEnd() - car.cell;          // distance to the end-of-ramp wall
    // Pressure grows with distance AND with time-to-the-end: a driver doing
    // 50 mph on a 60 m taper has ~2 s left and takes a tighter gap at once
    // rather than braking to a stop at the gore (which would leave it
    // needing a huge gap to get in from a standstill).
    const ttw = d / Math.max(0.5, car.v);
    const uD = d < 2 ? 0.95 : d < 4 ? 0.75 : d < 7 ? 0.5 : 0.25;
    const uT = ttw < 1.2 ? 0.9 : ttw < 2 ? 0.7 : ttw < 3 ? 0.5 : 0.25;
    u = Math.max(u, car.rampU || 0, uD, uT);
  }
  // Off-ramp, step 1: an exiting car still in an inner mainline lane must reach
  // the rightmost lane before the deceleration lane opens (decelStart), where it
  // can move over into the aux row. The deadline is decelStart, not the gore.
  if (car.exiting && offRampActive() && car.lane < sim.lanes - 1 && car.lane !== rampLaneIdx()) {
    const d = decelStart() - car.cell;
    if (d >= 0) { if (d < 6) u = Math.max(u, 0.6); else if (d < 14) u = Math.max(u, 0.35); }
    else u = Math.max(u, 0.6);               // already past the opening: hurry
  }
  // Off-ramp, step 2: an exiting car in the rightmost main lane, now alongside
  // the open deceleration lane, must move RIGHT into it before the gore.
  if (car.exiting && offRampActive() && car.lane === sim.lanes - 1 && inDecelLane(car.cell)) {
    const d = decelEnd() - car.cell;
    u = Math.max(u, d < 4 ? 0.8 : d < 9 ? 0.5 : 0.3);
  }
  if (laneBlocked(car.lane) || (car.lane2 != null && laneBlocked(car.lane2))) {
    // Escaping a closed lane: pressure builds toward the block (cf. the
    // on-ramp gore) so a stranded driver eventually takes a tight zipper gap.
    const d = INCIDENT_CELL - car.cell;
    if (d >= 0) u = Math.max(u, d < 3 ? 0.9 : d < 8 ? 0.7 : d < 16 ? 0.5 : 0.35);
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
  // A forced merge at crawl speed (zipper at a lane closure or gore) is a
  // short, steep move — cars nose across in ≈2.5 s rather than drifting over
  // for 4.5 s while blocking both lanes.
  car.lcDur = lc.forced ? LANE_CHANGE_TIME - 2 * Math.max(0, 1 - car.v / 2) : LANE_CHANGE_TIME;
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

  for (const car of sim.cars) {
    car.yieldFor = null; car.closeGap = false;
    car.zipperFor = null; car.zipperU = 0;
  }

  for (const car of sim.cars) {
    const lc = car.lc;

    if (lc && (lc.phase === 'execute' || lc.phase === 'abort')) {
      maybeAbort(car);            // mid-manoeuvre: only watch for gap collapse
      continue;
    }

    if (lc) {                     // ── SIGNAL / GAP-WAIT phase ──
      lc.t += 1;
      // Discretionary changes drop the plan if their own lane has opened up…
      if (!lc.forced && !lc.keep) {
        const ownLead = leaderInLane(car, car.lane, N);
        if (ownLead.gap > car.prof.T * car.v + 4) { cancelLC(car, 2); continue; }
      }
      // A pending move into a lane that is closed ahead is dropped.
      if (!lc.forced && laneBlocked(lc.target) && !laneBlocked(car.lane) &&
          car.cell > INCIDENT_CELL - 40 && car.cell < INCIDENT_CELL + INCIDENT_SPAN + 1) {
        cancelLC(car, 2); continue;
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

    // The settle-in pause after a lane change never delays escaping a closed
    // lane (e.g. a ramp merger that has just landed in the blocked right lane):
    // waiting it out left such cars stopped at the wreck, dragging the open
    // lane down with a merge from standstill.
    const escaping = laneBlocked(car.lane) && car.lane > 0 &&
      INCIDENT_CELL - car.cell >= 0 && INCIDENT_CELL - car.cell < 40;
    if (car.cool > 0) { car.cool -= 1; if (!escaping) continue; }
    // Eyes off the road: no new manoeuvres during an attention lapse.
    if (car.distracted) continue;

    // ── Auxiliary-row cars (index === rampLaneIdx()) ──
    if (cfg().hasRamp && car.lane === rampLaneIdx()) {
      // On-ramp ACCELERATION lane: the only move is to zipper LEFT into the
      // rightmost main lane, and it MUST be done before the gore wall — forced,
      // no timeout. (A car in the off-ramp DECELERATION lane stays put: it rides
      // the aux row down to the gore and departs there, no lane change.)
      if (inAccelLane(car.cell)) {
        startSignal(car, sim.lanes - 1, true);
      }
      continue;
    }
    if (sim.lanes < 2) continue;

    // ── Lane closure (incident): a car in a blocked lane approaching the
    //    obstacle MUST get out — a forced move toward the open lanes (lower
    //    index), which followers there honour zipper-style.
    if (laneBlocked(car.lane)) {
      const d = INCIDENT_CELL - car.cell;
      if (d >= 0 && d < 40 && car.lane > 0) { startSignal(car, car.lane - 1, true); continue; }
    }

    // ── Truck lane restriction: a heavy vehicle in the banned left lane moves
    //    right at the first acceptable gap (keeps trying; never times out of
    //    the motive, though each attempt still has its patience).
    if (car.isTruck && sim.truckLaneRestriction && car.lane === 0) {
      startSignal(car, 1, false);
      car.lc.keep = true;
      continue;
    }

    // ── Off-ramp, step 2: an exiting car in the rightmost main lane, now
    //    alongside the open deceleration lane, peels RIGHT into the aux row so it
    //    can shed speed off the through lane. Forced — it commits to the exit.
    //    Only START the move while there is still room to finish it before the
    //    gore (a slide takes ~4.5 s); a car that reaches the last few cells of
    //    the diverge without having begun has effectively missed the exit and
    //    rides on through (handled at the gore in speedAndMoveStep).
    if (car.exiting && offRampActive() && car.lane === sim.lanes - 1 &&
        inDecelLane(car.cell) && car.cell <= decelEnd() - 4) {
      startSignal(car, rampLaneIdx(), true);
      continue;
    }

    // ── Off-ramp, step 1: an exiting car still in an inner lane weaves toward
    //    the rightmost main lane to line up for the deceleration lane. It accepts
    //    a real disadvantage (up to ≈0.75 m/s² = 0.10 cells/s²) to do so — the one
    //    legitimate reason to move into a slower lane — and grows ever more eager
    //    as the diverge nears. These weaves stay DISCRETIONARY (not forced)
    //    between main lanes: the gap-wait/urgency machinery already lets the
    //    driver accept tight pockets near the gore, while keeping the abort
    //    safety net so a collapsing pocket never leaves it clipping a neighbour.
    //    A driver that simply can't find room misses the exit gracefully.
    if (car.exiting && offRampActive() && car.lane < sim.lanes - 1) {
      const near = decelStart() - car.cell < 14;    // close to the diverge
      const g = mobilDesire(car, car.lane + 1);
      if (g !== null && (g > -0.10 || (near && g > -0.6))) {
        startSignal(car, car.lane + 1, false); continue;
      }
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

// Cooperative yielding / zipper merge: a follower in the target lane that sees a
// blinker ahead reacts according to temperament AND to how badly the merger
// needs in. For a DISCRETIONARY change, courteous drivers (politeness ≥ .25)
// ease off and hot-heads (politeness < .1) close the gap, as before. For a
// FORCED merge at a lane drop / gore (ramp accel lane, off-ramp diverge) the
// follower ZIPPERS: it actively opens a gap proportional to the merger's
// urgency — a true alternating merge that even an aggressive driver honours,
// because at a real zipper point you cannot simply refuse the car merging in.
function yieldPass() {
  for (const car of sim.cars) {
    const lc = car.lc;
    if (!lc) continue;
    // Only while the merger is still WAITING to move over: once it has begun
    // the slide it already counts as the target-lane leader, and ordinary
    // car-following handles the rest (an extra courtesy buffer on top of
    // that just makes the follower brake twice).
    if (lc.phase !== 'signal') continue;
    const fol = followerInLane(car, lc.target, 11);
    if (!fol.foll || fol.foll.lc) continue;   // busy with their own manoeuvre
    // Already alongside (bumper gap gone): no point braking — drive on past
    // and let the merger slot in behind instead.
    if (fol.gap < 0.2) continue;
    // Both at a standstill with less room than any merge needs: the follower
    // cannot back up to open the pocket, so holding still would deadlock the
    // pair (e.g. a queue at a lane closure). It moves up past the merger
    // instead, which then slots in behind it.
    if (fol.foll.v < 0.1 && car.v < 0.1 && fol.gap < MERGE_MARGIN * 0.5) continue;
    if (lc.forced) {
      // Zipper: brake to open room for the merger. Urgency (set by the merger's
      // proximity to its wall/gore) scales how firmly the follower lifts off.
      const u = lcUrgency(car);
      fol.foll.zipperFor = car;
      fol.foll.zipperU = Math.max(fol.foll.zipperU || 0, Math.max(0.2, u));
    } else if (fol.foll.prof.politeness >= 0.25) {
      fol.foll.yieldFor = car;
    } else if (fol.foll.prof.politeness < 0.1) {
      fol.foll.closeGap = true;
    }
  }
}

// Advance the lateral slide animation for every car (called once per tick).
function advanceLaneAnim(dt) {
  for (const car of sim.cars) {
    if (car.laneT < 1) {
      const dur = car.lcDur || LANE_CHANGE_TIME;
      car.laneT = Math.min(1, car.laneT + dt / dur);
      const t = car.laneT;
      // Smoothstep for a natural ease-in/out across the line.
      const e = t * t * (3 - 2 * t);
      car.laneCoord = car.laneFrom + (car.laneTo - car.laneFrom) * e;
      // Visible steering: yaw the body with the lateral velocity, which peaks
      // mid-manoeuvre (smoothstep derivative 6t(1−t)) and straightens out.
      const latV = (car.laneTo - car.laneFrom) * 6 * t * (1 - t) / dur;
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

//──────────────────────────── Human factors: reaction delay, lapses, phantom ────────────────────────────
// Read the commanded acceleration `steps` sub-steps ago (fractional steps are
// linearly interpolated). Entries never written read as 0 (steady cruising),
// which matches how a freshly inserted car arrives already in equilibrium.
function histAt(car, steps) {
  const k0 = Math.floor(steps), f = steps - k0;
  const at = k => car.aHist[(car.aHistPos - k + HIST * 4) % HIST];
  const a0 = at(k0);
  return f > 0 ? a0 + (at(k0 + 1) - a0) * f : a0;
}

// Turn the instantaneous ("what a perfect driver would do now") acceleration
// into what this driver actually applies at sub-step time `t`:
//  • Humans respond to the situation as it was one REACTION TIME ago — the
//    command is pushed into a delay line and read back τ later (the classic
//    delayed car-following model; with τ ≳ 0.6–0.8 s IDM platoons become
//    string-unstable and small perturbations grow into stop-and-go waves —
//    Treiber, Kesting & Helbing, Physica A 2006, "Delays, inaccuracies and
//    anticipation in microscopic traffic models").
//  • Clear braking cues (the undelayed model asks for more than half the
//    comfortable decel b — brake lights ahead, a closing gap) trigger braking that bypasses the delay —
//    the "surprise" brake that keeps the delayed driver from colliding, and
//    the reason late reactions turn into HARD braking (wave amplification).
//  • Distracted drivers hold their speed during a lapse; they look up early
//    only when a collision becomes imminent, then brake late and hard.
//  • A phantom-brake demo forces a hard brake for PHANTOM_DUR seconds.
//  • AVs apply the command immediately (sensor-to-actuator lag ≪ one sub-step).
function controlAccel(car, aNow, t) {
  let a = aNow;
  if (!car.isAV) {
    const P = drv(car);
    const critical = aNow < -0.5 * P.b;
    let cmd = aNow;
    if (car.distracted) {
      if (t >= car.distractUntil || critical) {
        car.distracted = false;           // looks up (time's up, or startled)
      } else {
        cmd = car.v > 0.05 ? car.lapseA : Math.min(0, car.lapseA);
      }
    }
    car.aHistPos = (car.aHistPos + 1) % HIST;
    car.aHist[car.aHistPos] = cmd;
    const steps = Math.min(HIST - 2, Math.max(0, (sim.reactionTime || 0) * car.reactFactor / SUB_DT));
    a = steps > 0 ? histAt(car, steps) : cmd;
    if (critical) a = Math.min(a, aNow);
  }
  car.phantom = car.phantomUntil > t;
  if (car.phantom) a = Math.min(a, -PHANTOM_DECEL);
  return a;
}

// Attention-lapse onsets (once per tick): each distraction-prone human driver
// starts a lapse at a Poisson rate; it then holds roughly its current speed.
function distractionStep() {
  if (!(sim.pctDistracted > 0) && !sim.cars.some(c => c.distracted)) return;
  const p = 1 / DISTRACT_MEAN_INTERVAL;
  for (const car of sim.cars) {
    if (!car.distractProne || car.distracted) continue;
    if (car.lc && car.lc.phase !== 'signal') continue;   // mid-manoeuvre: focused
    if (rng() < p) {
      car.distracted = true;
      const dur = DISTRACT_DUR[0] + rng() * (DISTRACT_DUR[1] - DISTRACT_DUR[0]);
      car.distractUntil = sim.time - 1 + dur;      // this tick's sub-steps start at time-1
      // Phone users drift: they ease off the throttle (≈−0.3 m/s²; Oviedo-
      // Trespalacios et al. 2016 review: mobile-phone use lowers speed and
      // makes headways erratic) and do not track the car ahead.
      car.lapseA = Math.max(-0.05, Math.min(0, car.accA || 0) - 0.04);
      if (car.lc) cancelLC(car, 2);
    }
  }
}

// Phantom-jam demonstration: the given car (or a random mid-road mainline car
// cruising at speed) brakes hard for ~2 s for no reason. Returns that car, or
// null if nobody suitable is on the road.
function triggerPhantomBrake(carOrNull) {
  let car = carOrNull && sim.cars.includes(carOrNull) ? carOrNull : null;
  if (!car) {
    const main = sim.cars.filter(c => c.lane < sim.lanes && !c.lc);
    let pool = main.filter(c => c.cell > N * 0.3 && c.cell < N * 0.75 && c.v > 1.0);
    if (!pool.length) pool = main.filter(c => c.v > 0.3);
    if (!pool.length) return null;
    car = pool[Math.floor(rng() * pool.length)];
  }
  car.phantomUntil = sim.time + PHANTOM_DUR;
  car.phantom = true;
  return car;
}

//──────────────────────────── Longitudinal integration & movement ────────────────────────────
// Integrate the car-following model over SUBSTEPS sub-steps (dt = 1/SUBSTEPS s)
// for each car, then detect sensor crossings, off-ramp exits and right-edge
// outflow. Open-road model: traffic flows strictly left→right; a car whose
// position passes the right edge (cell N) drives off and despawns.
// prevCell/prevLane are saved for the renderer's inter-tick interpolation.
function speedAndMoveStep() {
  // All accelerations are computed from the same snapshot, then applied
  // together (parallel update). Positions use the ballistic update
  // x += v·dt + ½·a·dt² with an exact stop when v would turn negative
  // (Treiber & Kanagaraj, Physica A 2015) — markedly more accurate than Euler.
  const t0 = sim.time - 1;
  for (let s = 0; s < SUBSTEPS; s++) {
    const t = t0 + s * SUB_DT;
    const acc = new Array(sim.cars.length);
    for (let i = 0; i < sim.cars.length; i++) {
      const car = sim.cars[i];
      let a2 = accelInLane(car, car.lane);
      // Mid lane change: car-follow against BOTH lanes (min of the two) so the
      // straddling body never clips traffic in either. The lane being left
      // ignores the end-of-ramp wall (the body is already escaping it).
      if (car.lane2 != null) a2 = Math.min(a2, accelInLane(car, car.lane2, true));
      if (car.zipperFor) {
        // Zipper merge: open a real gap for a FORCED merger (ramp/exit/lane
        // closure) ahead. Treat it as a leader needing a target headway that
        // grows with the merger's urgency, and brake toward that — firmly when
        // urgent, but always bounded below emergency braking so the follower
        // never stops dead. This is the alternation that lets a packed lane
        // still accept a merge: each blinking merger pries open one slot.
        const zf = car.zipperFor;
        const g = (zf.cell - car.cell) - (car.len || CAR_LEN);
        if (g > 0.05) {
          // Desired extra room behind the merger: ~2 m, up to ~8 m when urgent.
          const want = 0.3 + 0.8 * car.zipperU;
          const az = idmAccel(car, Math.max(0.3, g - want), Math.min(zf.v, car.v));
          // Bound the zipper brake: ≈2 m/s² (comfortable) for a relaxed merger,
          // up to ≈4 m/s² for one wedged at the very end of its lane.
          const floor = -B_SAFE * (0.35 + 0.7 * car.zipperU);
          if (az < a2) a2 = Math.max(az, floor);
        }
      } else if (car.yieldFor) {
        // Courteous: ease off toward the signalling car ahead as if it were a
        // leader wanting an extra courtesy buffer — gentle deceleration only,
        // only while the merger is genuinely ahead and we'd otherwise keep
        // closing on it (never brake to a standstill for a blinker).
        const yf = car.yieldFor;
        const g = (yf.cell - car.cell) - (car.len || CAR_LEN);
        if (g > 0.1 && car.v > yf.v - 0.2) {
          const ay = idmAccel(car, Math.max(0.3, g - 1.0), yf.v);
          // Courtesy yielding is GENTLE: cap at ~1.5 m/s² (0.2 cells/s²).
          if (ay < a2) a2 = Math.max(ay, -0.2);
        }
      } else if (car.closeGap && a2 > -0.1) {
        // Aggressive: nudge forward (~0.5 m/s²) to deny the merger the pocket.
        a2 = Math.min(a2 + 0.07, car.prof.a);
      }
      acc[i] = controlAccel(car, a2, t);
    }
    for (let i = 0; i < sim.cars.length; i++) {
      const car = sim.cars[i];
      const a = acc[i];
      const v1 = car.v + a * SUB_DT;
      if (v1 < 0) {
        // Comes to rest within this sub-step: advance exactly to the stop.
        if (a < 0) car.cell += -car.v * car.v / (2 * a);
        car.v = 0;
      } else {
        car.cell += car.v * SUB_DT + 0.5 * a * SUB_DT * SUB_DT;
        car.v = v1;
      }
      car.accA = a;
    }
  }

  // Post-move bookkeeping: braking flag, sensor counts, exits, outflow.
  const remove = new Set();
  for (let i = 0; i < sim.cars.length; i++) {
    const car = sim.cars[i];
    car.age += 1;
    car.accel = car.v - car.startV;
    // Brake lights: decelerating harder than engine drag (≈0.3 m/s²).
    car.braking = car.accel < -0.04 || car.accA < -0.04 || car.phantom;

    // Stops (HCM-style, with hysteresis): below 5 mph counts as a stop; the
    // car must exceed 10 mph again before another stop can be counted.
    if (!car.stopped && car.v < 0.3) { car.stopped = true; car.stops++; }
    else if (car.stopped && car.v > 0.6) car.stopped = false;

    const prev = car.prevCell;
    const wrapped = car.cell >= N;              // drove off the right edge
    const movedDist = car.cell - prev;

    // Throughput sensor crossing (mainline cross-section).
    if (movedDist > 0 && prev < SENSOR_CELL && car.cell >= SENSOR_CELL) sim.evThroughput.push(sim.time);

    if (offRampActive()) {
      // Commit/re-roll the exit decision upstream of the ramp.
      if (!car.exitDecided && prev < EXIT_DECIDE_CELL && car.cell >= EXIT_DECIDE_CELL) {
        car.exiting = rng() < car.exitChance;
        car.exitDecided = true;
      }
      // Off-ramp departure: an exiting car that REACHES the gore (decelEnd) down
      // in the DECELERATION lane peels off onto the ramp and is gone. This is a
      // PROXIMITY test, not a crossing test: at the gore the car is rolling at
      // the ramp advisory (~30 mph), and it must leave the moment its nose gets
      // there — it never stops AT the gore (that would dam the whole decel lane).
      if (car.exiting && !wrapped && (car.lane === rampLaneIdx() || car.lane2 === rampLaneIdx())
          && car.cell + car.len >= decelEnd()) {
        recordTrip(car, decelEnd());
        remove.add(i); continue;                // committed to the ramp: gone
      }
      // A car that crosses the gore still in a main lane has MISSED the exit — it
      // gives up (blinker off) and drives on like everyone else. Abandon any
      // half-started slide toward the (now passed) deceleration lane so it can't
      // drift into the aux row downstream of the gore.
      if (car.exiting && !wrapped && prev < decelEnd() && car.cell >= decelEnd()) {
        car.exiting = false;
        if (car.lc && car.lc.target === rampLaneIdx() && car.lane !== rampLaneIdx()) {
          car.lc = null; car.signal = 0; car.lane2 = null;
          car.laneT = 1; car.laneFrom = car.laneTo = car.laneCoord = car.lane;
        }
      }
    }

    // Stop event (legacy city metric): came to rest this tick.
    if (car.v < 0.05 && car.startV >= 0.05) sim.evStops.push(sim.time);

    // Right-edge outflow: the car has driven off the far end of the strip.
    if (wrapped) { recordTrip(car, N); remove.add(i); }
  }
  if (remove.size) sim.cars = sim.cars.filter((_, i) => !remove.has(i));
}

//──────────────────────────── Trip statistics ────────────────────────────
// Completed trip: travel time runs from the moment the vehicle ENTERED the
// visible road (left edge or acceleration lane) to departure. Time spent
// waiting beforehand — in the entry queue (demand the road could not absorb)
// or at the ramp meter — is logged separately at entry (sim.evEntryWait) so
// it can be reported on its own instead of swamping travel times. Delay =
// travel − free-flow time over the same distance at the driver's own ideal
// desired speed (posted limit, clear weather) — so weather, VSL and
// rubbernecking slowdowns all register as delay.
function recordTrip(car, exitCell) {
  const travel = sim.time - car.enterTime;
  const ff = Math.max(0, exitCell - car.spawnCell) / carV0Ideal(car);
  sim.evTravel.push({
    t: sim.time, travel, delay: Math.max(0, travel - ff), stops: car.stops,
    wait: car.enterTime - car.arriveTime, ramp: !!car.fromRamp,
  });
}
// A vehicle has just entered the road: log how long it waited to get on.
function recordEntry(car) {
  car.enterTime = sim.time;
  sim.evEntryWait.push({ t: sim.time, wait: Math.max(0, sim.time - car.arriveTime), ramp: !!car.fromRamp });
}

// Rolling sample of the road state for windowed speed/density statistics.
// `hb` counts mainline vehicles braking harder than 2 m/s² (0.27 cells/s²)
// over the last second — the abrupt braking that stop-and-go waves, late
// reactions and speed differences produce.
function sampleStats() {
  let sumV = 0, nMain = 0, hb = 0;
  for (const c of sim.cars) {
    sumV += c.v;
    if (c.lane < sim.lanes) { nMain++; if (c.accel < -0.27) hb++; }
  }
  sim.statSamples.push({ t: sim.time, sumV, n: sim.cars.length, nMain, hb });
}

// Headline indicators for the UI (all numbers; NaN when not yet measurable).
//   avgSpeedMph        mean speed of all vehicles on the road, last 30 s
//   flowVphPerLane     sensor (mid-road cross-section) flow, last 60 s
//   densityVpmPerLane  mainline vehicles per mile per lane, last 30 s
//   meanTravelTimeS / meanDelayS / stopsPerVeh   completed trips, last 120 s
//                      (timed from entering the road — queue waits excluded)
//   meanEntryWaitS     mean wait in the left-edge entry queue: vehicles that
//                      entered in the last 120 s plus those still queued
//   meanRampWaitS      same at the on-ramp (meter) before entering the
//                      acceleration lane (NaN without a ramp)
//   hardBrakePct       % of mainline vehicle-time spent braking harder than 2 m/s², last 30 s
//   meanWaitS          mean wait before entering, all entries (left edge + ramp), last 120 s
//   meanTotalTimeS     completed trips, last 120 s: queue wait + travel time
//   vehOnRoad          vehicles currently on the strip
//   laneChangesPerMin  lane changes begun, last 60 s
//   rampQueue          vehicles waiting at the on-ramp meter
//   throughputPerMin   vehicles completing their trip (right edge + off-ramp), last 60 s
//   entryQueue         vehicles waiting upstream of the left edge (demand > what fits)
//   vslMph             currently posted variable speed limit (NaN when VSL off)
function getStats() {
  const now = sim.time;
  const w60 = Math.min(60, now), w30 = 30;
  const recent = sim.statSamples.filter(s => s.t > now - w30);
  let sumV = 0, n = 0, nMain = 0, hb = 0;
  for (const s of recent) { sumV += s.sumV; n += s.n; nMain += s.nMain; hb += s.hb || 0; }
  const trips = sim.evTravel.filter(e => e.t > now - 120);
  const mean = (arr, k) => arr.length ? arr.reduce((a, e) => a + e[k], 0) / arr.length : NaN;
  const per60 = cnt => (w60 >= 5 ? cnt * 60 / w60 : NaN);
  // Waits: vehicles that got on in the last 120 s, PLUS those still waiting
  // (their wait so far) — otherwise a growing or stalled queue would report
  // only the older, shorter waits of the few that made it on.
  const waits = sim.evEntryWait.filter(e => e.t > now - 120);
  for (const q of sim.entryQueues) for (const c of q) waits.push({ wait: Math.max(0, now - c.arriveTime), ramp: false });
  for (const t of sim.rampQueueTimes) waits.push({ wait: Math.max(0, now - t), ramp: true });
  const mainW = waits.filter(e => !e.ramp), rampW = waits.filter(e => e.ramp);
  return {
    avgSpeedMph: n ? (sumV / n) * MPH_PER_CELL : NaN,
    flowVphPerLane: w60 >= 5
      ? sim.evThroughput.filter(t => t > now - 60).length * 3600 / w60 / sim.lanes : NaN,
    densityVpmPerLane: recent.length ? (nMain / recent.length) / ROAD_MILES / sim.lanes : NaN,
    meanTravelTimeS: mean(trips, 'travel'),
    meanDelayS: mean(trips, 'delay'),
    stopsPerVeh: mean(trips, 'stops'),
    vehOnRoad: sim.cars.length,
    laneChangesPerMin: per60(sim.evLaneChanges.filter(t => t > now - 60).length),
    rampQueue: cfg().hasRamp ? sim.rampQueue : NaN,
    throughputPerMin: per60(sim.evTravel.filter(e => e.t > now - 60).length),
    entryQueue: sim.entryQueue,
    meanEntryWaitS: mean(mainW, 'wait'),
    meanRampWaitS: cfg().hasRamp ? mean(rampW, 'wait') : NaN,
    meanWaitS: mean(waits, 'wait'),
    hardBrakePct: nMain ? 100 * hb / nMain : NaN,
    meanTotalTimeS: trips.length ? trips.reduce((a, e) => a + e.travel + (e.wait || 0), 0) / trips.length : NaN,
    vslMph: sim.vslZone ? sim.vslMph : NaN,
  };
}

//──────────────────────────── Demand, spawning & ramp meter ────────────────────────────
// Open-road inflow driven by DEMAND (veh/h). Each main lane receives arrivals
// with shifted-exponential headways; arriving vehicles join that lane's entry
// queue (they are "on the road upstream" of the visible strip) and are
// inserted at the left edge as soon as a safe pocket exists. When demand
// exceeds what the road can absorb, the queue grows — spillback is visible as
// sim.entryQueue rather than demand silently vanishing. The on-ramp works the
// same way with its own demand and the (optional) meter.

// Shifted-exponential headway (s) with mean `mean` and minimum `tmin`.
function sampleHeadway(mean, tmin) {
  const tm = Math.min(tmin, 0.6 * mean);
  return tm - Math.log(1 - rng()) * (mean - tm);
}

function ensureLaneArrays() {
  while (sim.entryQueues.length < sim.lanes) sim.entryQueues.push([]);
  while (sim.nextArrival.length < sim.lanes) sim.nextArrival.push(null);
  if (sim.entryQueues.length > sim.lanes) {
    // Lanes removed: hand their waiting vehicles to the surviving lanes.
    const extra = sim.entryQueues.splice(sim.lanes);
    for (const q of extra) for (const car of q) enqueueEntry(car, Math.floor(rng() * sim.lanes));
    sim.nextArrival.length = sim.lanes;
  }
}

function enqueueEntry(car, lane) {
  if (truckBannedLane(car, lane)) lane = 1 + Math.floor(rng() * (sim.lanes - 1));
  const q = sim.entryQueues[lane];
  if (q.length < ENTRY_QUEUE_MAX) q.push(car);
}
function truckBannedLane(car, lane) {
  return car.isTruck && sim.truckLaneRestriction && lane === 0 && sim.lanes > 1;
}

// Generate this tick's arrivals (interval (time−1, time]).
function arrivalsStep() {
  ensureLaneArrays();
  const dem = Math.max(0, +sim.demandVph || 0);
  const mean = dem > 0 ? 3600 / dem : Infinity;
  if (sim._demandSeen !== dem) {
    // Demand changed: restart each lane's arrival clock at the new rate.
    sim._demandSeen = dem;
    for (let l = 0; l < sim.lanes; l++) sim.nextArrival[l] = null;
  }
  for (let l = 0; l < sim.lanes; l++) {
    if (!Number.isFinite(mean)) { sim.nextArrival[l] = null; continue; }
    if (sim.nextArrival[l] == null) sim.nextArrival[l] = sim.time - 1 + rng() * sampleHeadway(mean, ARRIVAL_TMIN);
    while (sim.nextArrival[l] <= sim.time) {
      const car = makeCar(l, 0, 0);
      car.arriveTime = sim.nextArrival[l];
      enqueueEntry(car, l);
      sim.nextArrival[l] += sampleHeadway(mean, ARRIVAL_TMIN);
    }
  }

  if (cfg().hasRamp) {
    const rd = Math.max(0, +sim.rampDemandVph || 0);
    const rmean = rd > 0 ? 3600 / rd : Infinity;
    if (sim._rampDemandSeen !== rd) { sim._rampDemandSeen = rd; sim.rampNextArrival = null; }
    if (Number.isFinite(rmean)) {
      if (sim.rampNextArrival == null) sim.rampNextArrival = sim.time - 1 + rng() * sampleHeadway(rmean, RAMP_ARRIVAL_TMIN);
      while (sim.rampNextArrival <= sim.time) {
        if (sim.rampQueueTimes.length < ENTRY_QUEUE_MAX) sim.rampQueueTimes.push(sim.rampNextArrival);
        sim.rampNextArrival += sampleHeadway(rmean, RAMP_ARRIVAL_TMIN);
      }
    } else sim.rampNextArrival = null;
    sim.rampQueue = sim.rampQueueTimes.length;
  }
}

// Gap a vehicle entering at speed v needs behind a leader moving at vl. In
// moving traffic it is 12 % MORE than the IDM+ desired gap s*(v, Δv): with
// IDM+ every speed below v0 is a (neutral) equilibrium at exactly s*, so
// inserting at exactly s* would let one slow car at the boundary freeze the
// whole inflow at its speed. The small surplus lets each newcomer keep
// accelerating toward v0, i.e. the boundary feeds the FREE-FLOW capacity
// state (cf. Treiber & Kesting, Traffic Flow Dynamics §11, upstream boundary
// conditions). Into a genuinely jammed entry (leader < 50 % of v0) the
// newcomer packs in at exactly s*.
function entryGap(P, v, vl) {
  const sStar = P.s0 + v * P.T + Math.max(0, v * (v - vl)) / (2 * Math.sqrt(P.a * P.b));
  return Math.max(P.s0, sStar * (vl < 0.5 * P.v0 ? 1 : 1.12));
}

// Insert waiting vehicles at the left edge of each lane where they fit.
function insertStep() {
  for (let l = 0; l < sim.lanes; l++) {
    const q = sim.entryQueues[l];
    while (q.length && sim.cars.length < densityCap()) {
      const car = q[0];
      car.lane = l; car.cell = 0; car.v = 0;
      car.laneCoord = car.laneFrom = car.laneTo = car.prevLane = l;
      const P = drv(car);
      const r = leaderInLane(car, l, N);
      let v = P.v0, room = Infinity;
      if (r.lead) {
        // Fastest speed (coarse grid) whose entry gap fits behind the leader —
        // but never slower than the leader itself: a vehicle arriving hot on
        // the heels of the previous one WAITS upstream (queue) rather than
        // being dropped in at an artificially low speed, which would plant a
        // spurious slow car at the boundary. Into a slow/jammed entry it does
        // enter slowly, at the jam's own speed.
        const avail = r.lead.cell - car.len;        // nose-to-tail room from cell 0
        const vMin = Math.min(P.v0, r.leadV);
        v = -1;
        for (let k = 0; k <= 12; k++) {
          const vk = P.v0 - (P.v0 - vMin) * (k / 12);
          if (avail - entryGap(P, vk, r.leadV) >= 0) { v = vk; break; }
        }
        if (v < 0) break;                            // no pocket: lane head blocked
        room = avail - entryGap(P, v, r.leadV);
      }
      // A vehicle that arrived (or became insertable) part-way through the
      // last second has already driven a little way in — place it there, so
      // entry headways are not quantised to whole ticks.
      const waited = Math.max(0, Math.min(1, sim.time - car.arriveTime));
      const x = Math.max(0, Math.min(waited * v, room, N * 0.25));
      q.shift();
      car.cell = car.prevCell = x;
      car.v = car.startV = v;
      car.spawnCell = x;
      recordEntry(car);
      if (v < 0.3) { car.stopped = true; car.stops = 1; }   // joined a standing queue
      sim.cars.push(car);
    }
  }
  sim.entryQueue = sim.entryQueues.reduce((a, q) => a + q.length, 0);
}

function rampStep() {
  if (!cfg().hasRamp) return;
  const entry = rampStart();
  let released = false, tried = false;
  if (sim.meterOn) {
    // Queue-flush override: when the ramp queue nears its storage, the meter
    // releases at twice the rate so the queue can't spill onto the arterial.
    const interval = sim.rampQueue > RAMP_STORAGE ? Math.max(2, sim.meterInterval / 2) : sim.meterInterval;
    sim.meterTimer++;
    if (sim.meterTimer >= interval && sim.rampQueue > 0) {
      tried = true;
      released = releaseRampCar(entry);
      if (released) sim.meterTimer = 0;
    }
  } else if (sim.rampQueue > 0) {
    tried = true;
    released = releaseRampCar(entry);
  }
  sim._rampHeadWait = released || !tried ? 0 : (sim._rampHeadWait || 0) + 1;
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

// Mean speed of the rightmost main lane alongside the merge area (what a
// driver coming down the ramp sees and matches), or null if it is empty.
function mergeLaneSpeed() {
  let sum = 0, n = 0;
  const lo = rampStart() - 6, hi = rampEnd() + 4;
  for (const c of sim.cars) {
    if (occupiesLane(c, sim.lanes - 1) && c.cell >= lo && c.cell <= hi) { sum += c.v; n++; }
  }
  return n ? sum / n : null;
}

function releaseRampCar(entry) {
  const car = makeCar(rampLaneIdx(), entry, 0);  // rolls profile & exit chance now
  const vf = vmaxFloat();
  const local = mergeLaneSpeed();
  // Gap targeting: coming down the ramp a driver times its arrival to a gap
  // in the right lane, so it may show up anywhere in the first few cells of
  // the acceleration lane. If no acceptable gap is on offer it holds back (the
  // head of the ramp queue waits), growing bolder the longer it waits — after
  // a few seconds it accepts gaps that make mainline drivers brake hard,
  // which is what breaks a busy mainline down at a merge.
  const wait = sim._rampHeadWait || 0;
  const u = wait < 3 ? 0.15 : Math.min(0.8, 0.15 + 0.12 * (wait - 2));
  for (const off of [0, 0.75, 1.5, 2.25, 3]) {
    const x = entry + off;
    if (!laneEntryFree(rampLaneIdx(), x, 3.6)) continue;
    car.cell = x;
    // Real merging is SPEED MATCHING: the ramp proper (upstream of the
    // visible acceleration lane) is where drivers build speed, and they
    // adjust it to the traffic they are about to join (AASHTO designs
    // entrance terminals for a merge within ~5–10 mph of the mainline running
    // speed). An unmetered driver arrives at ≈90 % of the right lane's local
    // speed (capped at 90 % of free speed) and never faster than the car it
    // will slot in behind; a metered one, launched from the stop bar only a
    // few hundred feet back, arrives ≈20 % slower.
    let match = Math.min(0.9 * vf, local == null ? 0.9 * vf : Math.max(0.35 * vf, 0.9 * local + 0.2));
    const ahead = leaderInLane(car, sim.lanes - 1, 12);
    if (ahead.lead) match = Math.min(match, Math.max(0.3 * vf, ahead.leadV + 0.15));
    const want = sim.meterOn ? 0.8 * match : match;
    // Cap by the comfortable-braking envelope to whatever is queued ahead in
    // the acceleration lane, so it can never overrun a stopped merge queue.
    const r = leaderInLane(car, rampLaneIdx(), N);
    if (r.lead && r.gap < car.prof.s0) continue;   // body doesn't fit here
    const eq = r.lead
      ? Math.sqrt(r.leadV * r.leadV + 2 * car.prof.b * Math.max(0, r.gap - car.prof.s0))
      : want;
    car.v = car.startV = Math.max(0.4, Math.min(want, eq));
    sim.cars.push(car);              // gapCheck probes the follower's reaction to it
    const ok = gapCheck(car, sim.lanes - 1, u);
    sim.cars.pop();
    if (!ok) continue;
    car.prevCell = x;
    car.rampU = u;
    car.arriveTime = sim.rampQueueTimes.length ? sim.rampQueueTimes.shift() : sim.time;
    car.spawnCell = x;
    car.fromRamp = true;
    recordEntry(car);
    // Blinker has been on since the ramp: it may move over at once.
    startSignal(car, sim.lanes - 1, true);
    car.lc.sigTime = 0;
    sim.cars.push(car);
    sim.rampQueue = sim.rampQueueTimes.length;
    return true;
  }
  sim.nextId--;
  return false;
}

function spawnStep() {
  arrivalsStep();
  rampStep();
  insertStep();
}

//──────────────────────────── Variable speed limit ────────────────────────────
// Speed harmonisation upstream of the active bottleneck (the incident if one
// is on, else the on-ramp merge). A detector spanning the bottleneck's
// approach smooths the mean mainline speed (τ ≈ 7 s); when it falls below
// VSL.trigger × free speed the gantries over [0, bottleneck−4] post
// (detected + 10 mph) rounded down to 5 mph — dropping by ≤ 10 mph every 5 s
// and recovering by 5 mph every 10 s.
function vslStep() {
  if (!sim.vslOn || !cfg().hasRamp) {
    sim.vslZone = null; sim.vslMph = sim.speedMph; sim._vsl = null;
    return;
  }
  const b = incidentActive() ? INCIDENT_CELL : rampEnd() + 3;
  sim.vslZone = { start: 0, end: Math.max(6, b - 4) };
  const free = vmaxFloat() * MPH_PER_CELL;
  if (!sim._vsl) { sim._vsl = { det: free, last: -Infinity }; sim.vslMph = sim.speedMph; }
  const st = sim._vsl;
  let sum = 0, n = 0;
  for (const c of sim.cars) {
    if (c.lane < sim.lanes && c.cell >= b - 8 && c.cell <= b + 6) { sum += c.v; n++; }
  }
  const meas = n ? (sum / n) * MPH_PER_CELL : free;
  st.det += 0.15 * (meas - st.det);
  const posted = sim.speedMph;
  if (sim.vslMph > posted) sim.vslMph = posted;
  let target = posted;
  if (st.det < VSL.trigger * free) {
    target = Math.max(Math.min(VSL.min, posted), Math.min(posted, Math.floor((st.det + 10) / 5) * 5));
  }
  const since = sim.time - st.last;
  if (target < sim.vslMph && since >= VSL.downEvery) {
    sim.vslMph = Math.max(target, sim.vslMph - VSL.stepDown); st.last = sim.time;
  } else if (target > sim.vslMph && since >= VSL.upEvery) {
    sim.vslMph = Math.min(target, sim.vslMph + VSL.stepUp); st.last = sim.time;
  }
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
  vslStep();               // update posted variable speed limit (if on)
  distractionStep();       // attention-lapse onsets
  laneChangeStep();        // signal / gap-wait / begin-merge state machine
  advanceLaneAnim(1);      // advance the lateral slide animation by one second
  speedAndMoveStep();      // car-following: integrate motion & handle exits
  spawnStep();             // demand arrivals, ramp meter, left-edge insertion
  sampleStats();
  // Trim rolling event logs to the last 2 minutes of sim time.
  const cut = sim.time - 120;
  for (const k of ['evThroughput', 'evLaneChanges', 'evStops']) {
    if (sim[k].length && sim[k][0] <= cut) sim[k] = sim[k].filter(t => t > cut);
  }
  for (const k of ['evTravel', 'statSamples', 'evEntryWait']) {
    if (sim[k].length && sim[k][0].t <= cut) sim[k] = sim[k].filter(e => e.t > cut);
  }
  sim.lastTickWall = nowMs();
}

//──────────────────────────── Reset / seeding ────────────────────────────
// Reset rebuilds the world and starts the road EMPTY. Demand then flows in at
// the LEFT edge (and the on-ramp), so the user watches traffic accumulate and
// congestion form. Cars exit on the right (or the off-ramp).
function resetSim() {
  sim.cars = [];
  hooks.selectCar(null);
  sim.rampQueue = 0; sim.rampQueueTimes = []; sim.rampNextArrival = null;
  sim.meterTimer = 0;
  sim.entryQueues = []; sim.nextArrival = []; sim.entryQueue = 0;
  sim._demandSeen = undefined; sim._rampDemandSeen = undefined;
  sim.time = 0;
  sim.evThroughput = []; sim.evLaneChanges = []; sim.evStops = [];
  sim.evTravel = []; sim.statSamples = []; sim.evEntryWait = [];
  sim.speedHistory = [];
  sim._vsl = null; sim.vslMph = sim.speedMph;
  sim.vslZone = sim.vslOn && cfg().hasRamp ? sim.vslZone : null;
  ensureLaneArrays();

  if (cfg().style === 'city') genBuildings();
  sim.lastTickWall = nowMs();
}

// Change the number of main lanes IN PLACE, without clearing the fleet.
//   • Increasing: just widen the road. Existing cars stay put; they migrate into
//     the new emptier lane over the next seconds via MOBIL (path of least
//     resistance). New left-edge arrivals may use any lane.
//   • Decreasing: relocate any car now in a vanished lane (index ≥ n) into the
//     nearest still-valid lane, picking a safe gap when one exists; a car with
//     no pocket in any lane leaves the strip (it would otherwise be dropped on
//     top of another vehicle). The ramp/accel lane follows
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
        // The pocket must be stoppable, not merely unoccupied: whoever is
        // closing in (the relocated car on its new leader, or the new
        // follower on it) must be able to shed the speed difference within
        // the gap at emergency braking.
        const ahead = leaderInLane({ ...probe, v: car.v }, t, N);
        const behind = followerInLane({ ...probe }, t, N);
        const stopGap = dv => 0.2 + Math.max(0, dv) ** 2 / (2 * 2 * B_SAFE * weatherParams().brakeMul);
        if (ahead.gap > stopGap(car.v - (ahead.lead ? ahead.leadV : car.v)) &&
            behind.gap > stopGap(behind.foll ? behind.foll.v - car.v : 0)) { placed = t; break; }
      }
      // No pocket anywhere: the driver takes an exit off-screen rather than
      // being dropped on top of another vehicle.
      if (placed < 0) { car.gone = true; continue; }
      car.lane = placed;
      car.laneFrom = car.laneTo = car.laneCoord = placed;
      car.laneT = 1;
    }
  }

  if (sim.cars.some(c => c.gone)) {
    if (sim.selected && sim.selected.gone) hooks.selectCar(null);
    sim.cars = sim.cars.filter(c => !c.gone);
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
  ensureLaneArrays();
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
  triggerPhantomBrake, getStats, effV0, drv, rubberneckFactor, mobilDesire,
  sampleHeadway, gapCheck, lcUrgency, INCIDENT_SPAN,
};
