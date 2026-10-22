// Tunable constants, driver profiles and scenario definitions.
//──────────────────────────── Constants ────────────────────────────
// The world is ZOOMED IN versus the old N=200 ring: fewer cells across the
// fullscreen canvas means each cell renders ~18–22px wide, so a ~1-cell car
// reads as longer-than-wide rather than a squat block. Every cell-based
// landmark below was rescaled from the old N=200 layout to this N.
const N = 84;                  // cells per lane (≈ old 200, scaled ×0.42)
const MPH_PER_CELL = 16.8;     // 1 cell/s in mph
const TICK_MS = 200;           // wall-clock ms per sim tick
const SUBSTEPS = 5;            // IDM integration sub-steps per tick (dt = 1/5 s)
const SUB_DT = 1 / SUBSTEPS;
// Interchange layout (cars flow LEFT→RIGHT, so smaller cell = upstream):
//   ┌ entry ┐┌── on-ramp accel lane ──┐┌─ weave ─┐┌── off-ramp decel lane ──┐┌ exit ┐
//   0       14                       ~31         54                        70       84
// The ON-ramp (entrance) sits UPSTREAM of the OFF-ramp (exit), as on a real
// freeway. The sensor and incident both land on the open weaving mainline
// BETWEEN the two ramps so neither sits on top of a merge/diverge zone.
const SENSOR_CELL = 46;        // throughput sensor — open mainline between ramps
const INCIDENT_CELL = 38;      // lane-closure obstacle — open mainline between ramps
// EXIT_DECIDE_CELL: where a driver commits to the off-ramp. It sits a long way
// upstream of the diverge so a committed driver has room to weave right and ease
// into the deceleration lane before the gore.
const EXIT_DECIDE_CELL = 40;
const ROAD_MILES = N * 7.5 / 1609.34;
// Physical vehicle lengths in CELLS. Every gap/collision computation uses the
// per-car `car.len` rolled in makeCar (small variance around these baselines);
// the renderer draws bodies at exactly len × cw() px so visuals and physics
// always agree. Trucks are ~2.5× a car.
const CAR_LEN = 1.5;           // baseline car length (cells)
const TRUCK_LEN = 3.75;        // baseline truck length (cells)

// Acceleration-lane geometry. A merging driver is released onto the auxiliary
// lane at rampStart(), speeds up alongside the mainline, and must zipper-merge
// left before the gore wall at rampEnd(). Lengths reference real US freeway
// practice (AASHTO Green Book speed-change lane lengths; 1 cell = 7.5 m):
//   • taper    ≈ 60 m — short taper-type entrance: little room, an early/forced
//                       merge near mainline speed (think a tight cloverleaf).
//   • zipper   ≈ 90 m — a moderate parallel lane long enough to truly alternate.
//   • parallel ≈ 135 m — a generous parallel acceleration lane; the car reaches
//                        mainline speed with a comfortable choice of gaps.
const MERGE_SHAPES = {
  taper:    { len: 8 },    // standard taper-type acceleration lane (≈60 m)
  zipper:   { len: 12 },   // parallel zipper lane, alternating priority (≈90 m)
  parallel: { len: 18 },   // long parallel acceleration lane (≈135 m)
};
// Off-ramp deceleration lane: a long auxiliary lane to the right that OPENS this
// many cells upstream of the gore (offRampCell). Exit-bound drivers move into it
// early and shed speed gradually toward the ramp advisory before peeling off —
// ≈18 cells ≈ 135 m, in line with AASHTO deceleration-lane lengths for a
// freeway-speed exit easing to a ~30 mph ramp.
const DECEL_LANE_LEN = 18;

// Per-profile driving parameters, expressed as IDM + MOBIL knobs.
//
// UNITS: 1 cell = 7.5 m and 1 tick = 1 s, so 1 cell/s² = 7.5 m/s². All the
// acceleration-like knobs below are CALIBRATED from the empirical literature
// and converted by dividing m/s² by 7.5:
//   • IDM calibrations (Treiber/Kesting; NGSIM trajectory studies): max accel
//     a ≈ 1.0–2.0 m/s², comfortable decel b ≈ 1.5–3.0 m/s²; observed
//     accelerations in real traffic rarely exceed ±1.5 m/s² (Thiemann,
//     Treiber & Kesting, TRR 2088, 2008).
//   • Car-following time headways on freeways: mean ≈ 1.4 s, interquartile
//     range ≈ 1.3–1.6 s (Loulizi et al. 2019, naturalistic data); tailgaters
//     run ≈ 1 s, cautious drivers ≈ 1.8–2 s, trucks ≈ 1.7–2.2 s. Those are
//     GROSS (front-to-front) headways; IDM's T is the NET time gap, and our
//     render-scale bodies (11 m cars, 28 m rigs) eat ≈0.4 s of headway at
//     speed, so T is set ≈0.4–0.5 s below the measured headways (gross
//     headway at 65 mph ≈ 1.3 s normal, 1.1 s tailgater, 1.6 s cautious —
//     near-capacity freeway values). With IDM+ and the default mix (10 %
//     trucks, 15 % aggressive/passive, 0.8 s reaction) the basic segment
//     carries ≈1,850–1,950 veh/h/ln and the on-ramp merge ≈1,700 veh/h/ln
//     before breaking down (HCM: 2,250–2,400 pc/h/ln basic freeway).
//   • Standstill bumper gaps in stopped queues ≈ 2–4 m (IDM s0 = 2–3 m).
//   • MOBIL (Kesting/Treiber/Helbing, TRR 1999, 2007): politeness p ≈ 0.2–0.5,
//     switching threshold Δa_th = 0.1 m/s², keep-right bias Δa_bias = 0.3 m/s²,
//     hard safety limit b_safe = 4 m/s². That bias models EUROPEAN keep-right
//     law; US freeways have no such rule and lane use near capacity is fairly
//     even, so cars here get only a weak right bias (0–0.2 m/s²; trucks keep
//     a strong one), which also leaves the right lane room for merging traffic.
//
//   v0Mult : multiplier on the posted limit for desired speed v0
//   T      : safe time headway (s)
//   s0     : minimum bumper-to-bumper gap (cells)
//   a      : max acceleration (cells/s²)
//   b      : comfortable deceleration (cells/s²)
//   politeness : MOBIL politeness factor p (weight on neighbours' (dis)advantage)
//   threshold  : MOBIL switching threshold Δa_th (cells/s²) — lower = changes eagerly
//   biasRight  : keep-right bias a_bias (cells/s²) added to favour the right lane
//   leftPref   : extra incentive (cells/s²) to favour moving left/faster
//   signalTime : seconds of blinker before the lateral move may begin
//   gapAccept  : scale on the gap a driver demands before merging (lower = bolder)
//   patience   : seconds to keep signalling for a gap before giving up
const PROFILES = {
  //                          T (s)  2 m    2.25 m/s²  3.0 m/s²
  aggressive: { v0Mult: 1.04, T: 0.7, s0: 0.27, a: 0.30, b: 0.40,
                //          0.1 m/s² Δa_th   0.1 m/s²      0.3 m/s² left pull
                politeness: 0.05, threshold: 0.013, biasRight: 0.000, leftPref: 0.04,
                signalTime: 0.9, gapAccept: 0.70, patience: 5 },
  //                          T (s)  3 m    1.4 m/s²   2.0 m/s²
  normal:     { v0Mult: 1.00, T: 0.9, s0: 0.40, a: 0.19, b: 0.27,
                politeness: 0.30, threshold: 0.013, biasRight: 0.013, leftPref: 0.007,
                signalTime: 1.5, gapAccept: 1.00, patience: 8 },
  //                          T (s)  4 m    1.0 m/s²   1.6 m/s²
  passive:    { v0Mult: 0.96, T: 1.2, s0: 0.53, a: 0.13, b: 0.21,
                politeness: 0.50, threshold: 0.027, biasRight: 0.027, leftPref: 0.00,
                signalTime: 2.0, gapAccept: 1.30, patience: 11 },
};
// Truck overrides (merged onto whatever profile a truck draws): governed top
// speed (≈60 mph), longer headway (net 1.5 s ≈ 1.9 s gross, NGSIM truck median), 5 m standstill
// gap, loaded-rig accel ≈0.6 m/s², gentle service braking ≈1.3 m/s², strong
// keep-right discipline (0.5 m/s² bias).
const TRUCK_OVERRIDE = { v0Cap: 3.6, T: 1.3, s0: 0.67, a: 0.08, b: 0.17,
                         politeness: 0.45, threshold: 0.027, biasRight: 0.067, leftPref: 0,
                         signalTime: 2.0, gapAccept: 1.25, patience: 12 };
// Automated vehicles (AV / cooperative adaptive cruise). Controlled by the
// Kesting–Treiber ACC model (IDM + constant-acceleration heuristic, coolness
// c = 0.99; Kesting, Treiber, Schönhof & Helbing, Phil. Trans. R. Soc. A 2010):
// no human reaction delay, a stable 0.8 s time gap (production ACC offers
// ≈1.0–2.2 s; CACC studies use 0.6–1.1 s), smooth ≈1.5 m/s² acceleration,
// 2 m/s² comfortable braking, exact speed-limit compliance and calm, polite
// lane changing (high politeness, high threshold, long signal).
const AV_PROFILE = { v0Mult: 1.00, T: 0.8, s0: 0.27, a: 0.20, b: 0.27,
                     politeness: 0.50, threshold: 0.027, biasRight: 0.013, leftPref: 0.0,
                     signalTime: 2.0, gapAccept: 1.10, patience: 10 };
const ACC_COOLNESS = 0.99;     // ACC model coolness factor c (Kesting et al. 2010)

// Human reaction (perception–response) time. Car-following response delays
// measured in naturalistic / test-track data are ≈0.6–1.5 s (Green 2000,
// "How long does it take to stop?": ~0.7 s expected, 1.5 s surprise; HDM
// calibrations by Treiber, Kesting & Helbing 2006 use T' ≈ 0.6–1.2 s). Each
// human driver scales the global slider by a personal factor in this range.
const REACTION_SPREAD = [0.8, 1.2];

// Distraction (phone / in-vehicle task). 100-Car naturalistic study (Klauer
// et al. 2006, NHTSA DOT HS 810 594): eyes-off-road glances > 2 s double the
// near-crash risk; typical secondary-task glances last 1.5–3 s. A distraction-
// prone driver has an attention lapse on average every ~25 s lasting 1.5–3 s
// (≈8–10 % of driving time) during which it holds its speed and ignores the
// road; it only "looks up" early when a collision becomes imminent.
const DISTRACT_MEAN_INTERVAL = 25;   // s between lapse onsets (exponential)
const DISTRACT_DUR = [1.5, 3.0];     // s, uniform

// Phantom brake demo: one driver taps the brakes hard (≈3.4 m/s²) for 2 s —
// Sugiyama et al. (New J. Phys. 2008) showed such small perturbations grow
// into a stop-and-go wave at high density.
const PHANTOM_DECEL = 0.45;          // cells/s²
const PHANTOM_DUR = 2;               // s

// Rubbernecking: drivers passing an incident slow down and leave longer gaps
// even in OPEN lanes. Knoop, Hoogendoorn & van Zuylen (TRR 2009, helicopter
// data) measured the queue-discharge capacity of the remaining lanes at an
// incident ~50 % below normal per lane, and ~30 % lower in the OPPOSITE
// direction purely from gawking. Modelled as a desired-speed and time-gap
// penalty in a zone alongside and just past the scene (where drivers are
// looking at it), faded in/out linearly — it throttles the open lanes'
// discharge rather than the merge upstream.
const RUBBERNECK = { from: -5, full: -1, until: 5, to: 10, v0Mul: 0.4, Tmul: 1.8 };

// Variable speed limit / speed harmonisation (e.g. WSDOT I-5, UK M25 / MIDAS,
// Hegyi et al. SPECIALIST 2008). A detector just upstream of the bottleneck
// smooths the mean speed; when it falls below VSL_TRIGGER × free speed the
// upstream gantries post (detected speed + 10 mph) rounded down to 5 mph, never
// below VSL_MIN. Limits drop quickly and recover slowly (hysteresis).
const VSL = { trigger: 0.8, min: 30, stepDown: 10, stepUp: 5, downEvery: 5, upEvery: 10,
              compliance: 0.75 }; // humans make up 75 % of a posted reduction; AVs 100 %

// Weather. Approximate HCM 2010 (Exh. 10-15/10-16) and Agarwal, Maze &
// Souleyrette (2005, Twin Cities freeways): heavy rain cuts capacity ≈10–17 %
// and speed ≈5–10 %; heavy snow cuts capacity ≈19–27 % and speed ≈10–25 %;
// low visibility (fog) cuts capacity ≈10–12 %. Here each factor scales the
// free speed (vMul), time gap (Tmul), standstill gap (s0add, cells), max
// acceleration (aMul — wheel slip), comfortable braking (bMul) and the
// emergency braking ceiling (brakeMul — tyre–road friction μ: dry ≈0.8,
// wet ≈0.6, packed snow ≈0.3–0.4).
const WEATHER = {
  clear: { vMul: 1.00, Tmul: 1.00, s0add: 0.00, aMul: 1.00, bMul: 1.00, brakeMul: 1.00 },
  rain:  { vMul: 0.90, Tmul: 1.15, s0add: 0.13, aMul: 0.90, bMul: 0.85, brakeMul: 0.80 },
  fog:   { vMul: 0.82, Tmul: 1.30, s0add: 0.27, aMul: 0.95, bMul: 0.95, brakeMul: 0.95 },
  snow:  { vMul: 0.72, Tmul: 1.40, s0add: 0.40, aMul: 0.60, bMul: 0.60, brakeMul: 0.55 },
};

// Demand / arrivals. Freeway headways follow a SHIFTED exponential
// (Cowan M3 / Mei & Bullen 1993): no two vehicles closer than t_min, Poisson
// beyond it. t_min ≈ 1.0 s on the mainline, 2.0 s on a single-lane ramp.
const ARRIVAL_TMIN = 1.0;
const RAMP_ARRIVAL_TMIN = 2.0;
const ENTRY_QUEUE_MAX = 150;   // per lane: vehicles waiting upstream of the strip
// Ramp storage before the meter's queue-flush override kicks in (most US
// meters release faster once the queue nears the arterial; ≈ 400 ft storage).
const RAMP_STORAGE = 20;

// Body-type mix. Light vehicles split car / SUV / van with modest length
// differences; heavy vehicles are mostly tractor-trailers with some buses
// (more buses on the city arterial). Length multipliers apply to CAR_LEN /
// TRUCK_LEN. Buses get slightly livelier acceleration than a loaded rig.
const LIGHT_TYPES = [
  { type: 'car', share: 0.58, lenMul: [0.93, 1.03] },
  { type: 'suv', share: 0.30, lenMul: [1.03, 1.10] },
  { type: 'van', share: 0.12, lenMul: [1.08, 1.16] },
];
const BUS_SHARE = { highway: 0.10, city: 0.35 };
const BUS_OVERRIDE = { a: 0.10, v0Cap: 3.9, T: 1.6 };

// MOBIL hard safety: no follower forced below −b_safe. 0.53 cells/s² = 4 m/s²
// (the canonical MOBIL value). The IDM integrator clamps emergency braking at
// 2×B_SAFE ≈ 8 m/s² — the physical limit of a hard stop on dry pavement.
const B_SAFE = 0.53;
const MERGE_MARGIN = 1.0;     // min bumper gap (cells) required ahead & behind to commit a change
// Off-ramp advisory speed: exiting drivers ease down toward this before the
// gore point. 1.8 cells/s ≈ 30 mph, a typical ramp advisory speed.
const EXIT_RAMP_SPEED = 1.8;

// Scenario config objects. All scenario-specific behavior keys off these
// fields — the sim loop itself contains no scenario branching by name.
const SCENARIOS = {
  highway: {
    label: 'Highway with On-Ramp',
    desc: 'Open mainline: traffic enters at the left edge and exits at the right. A metered on-ramp feeds a second stream; an optional exit ramp lets a share of drivers peel off early.',
    laneOptions: [2, 3, 4], defaultLanes: 3,
    speedRange: [35, 75], speedStep: 5, defaultSpeed: 65,
    // ON-ramp upstream (entrance at cell 14), OFF-ramp downstream (gore at cell
    // 70) — entrance first, exit after, exactly as on a real freeway. The
    // deceleration lane opens DECEL_LANE_LEN cells before the gore (cell 52).
    hasRamp: true, onRampCell: 14, offRampCell: 70,
    hasIncident: true, lightCells: null, style: 'highway',
    // Default mainline demand (veh/h per lane) + 500 veh/h on the ramp: about
    // 70 % of capacity downstream of the merge — busy but free-flowing
    // (LOS B–C), so adding a factor shows its effect from a stable baseline.
    defaultDemandVph: 1200, defaultRampDemandVph: 500,
  },
  city: {
    label: 'City Arterial',
    desc: 'Arterial street with signals. Cars enter at the left edge, stop-and-go through the lights, and exit at the right.',
    laneOptions: [1, 2], defaultLanes: 2,
    speedRange: [25, 45], speedStep: 5, defaultSpeed: 35,
    hasRamp: false,
    hasIncident: false, lightCells: [21, 46, 71], style: 'city',
    // ≈ v/c 0.75: with a 50 % split the signals pass ≈600 veh/h/ln (the long
    // render-scale bodies stretch saturation headways to ≈2.7 s per lane).
    defaultDemandVph: 450,
  },
};

export {
  N, MPH_PER_CELL, TICK_MS, SUBSTEPS, SUB_DT, SENSOR_CELL, INCIDENT_CELL,
  EXIT_DECIDE_CELL, ROAD_MILES, CAR_LEN, TRUCK_LEN, MERGE_SHAPES, DECEL_LANE_LEN,
  PROFILES, TRUCK_OVERRIDE, B_SAFE, MERGE_MARGIN, EXIT_RAMP_SPEED, SCENARIOS,
  AV_PROFILE, ACC_COOLNESS, REACTION_SPREAD, DISTRACT_MEAN_INTERVAL, DISTRACT_DUR,
  PHANTOM_DECEL, PHANTOM_DUR, RUBBERNECK, VSL, WEATHER, ARRIVAL_TMIN,
  RAMP_ARRIVAL_TMIN, ENTRY_QUEUE_MAX, RAMP_STORAGE, LIGHT_TYPES, BUS_SHARE, BUS_OVERRIDE,
};
