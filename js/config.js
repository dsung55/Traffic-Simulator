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
const SENSOR_CELL = 63;        // throughput sensor (old 150)
const INCIDENT_CELL = 42;      // lane-closure obstacle (old 100)
const EXIT_DECIDE_CELL = 9;    // where cars commit to taking the off-ramp (old 20)
const ROAD_MILES = N * 7.5 / 1609.34;
// Physical vehicle lengths in CELLS. Every gap/collision computation uses the
// per-car `car.len` rolled in makeCar (small variance around these baselines);
// the renderer draws bodies at exactly len × cw() px so visuals and physics
// always agree. Trucks are ~2.5× a car.
const CAR_LEN = 1.5;           // baseline car length (cells)
const TRUCK_LEN = 3.75;        // baseline truck length (cells)

const MERGE_SHAPES = {
  taper:    { len: 5 },    // standard acceleration taper (old 10)
  zipper:   { len: 7 },    // alternating-priority zipper, relaxed rear gap (old 15)
  parallel: { len: 11 },   // long parallel acceleration lane (old 25)
};

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
//     run ≈ 1 s, cautious drivers ≈ 1.8–2 s, trucks ≈ 1.7–2.2 s.
//   • Standstill bumper gaps in stopped queues ≈ 2–4 m (IDM s0 = 2–3 m).
//   • MOBIL (Kesting/Treiber/Helbing, TRR 1999, 2007): politeness p ≈ 0.2–0.5,
//     switching threshold Δa_th = 0.1 m/s², keep-right bias Δa_bias = 0.3 m/s²,
//     hard safety limit b_safe = 4 m/s².
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
  aggressive: { v0Mult: 1.06, T: 1.0, s0: 0.27, a: 0.30, b: 0.40,
                //          0.1 m/s² Δa_th   0.1 m/s²      0.3 m/s² left pull
                politeness: 0.05, threshold: 0.013, biasRight: 0.013, leftPref: 0.04,
                signalTime: 0.9, gapAccept: 0.70, patience: 5 },
  //                          T (s)  3 m    1.4 m/s²   2.0 m/s²
  normal:     { v0Mult: 1.00, T: 1.4, s0: 0.40, a: 0.19, b: 0.27,
                politeness: 0.30, threshold: 0.013, biasRight: 0.045, leftPref: 0.007,
                signalTime: 1.5, gapAccept: 1.00, patience: 8 },
  //                          T (s)  4 m    1.0 m/s²   1.6 m/s²
  passive:    { v0Mult: 0.94, T: 1.8, s0: 0.53, a: 0.13, b: 0.21,
                politeness: 0.50, threshold: 0.027, biasRight: 0.053, leftPref: 0.00,
                signalTime: 2.0, gapAccept: 1.30, patience: 11 },
};
// Truck overrides (merged onto whatever profile a truck draws): governed top
// speed (≈60 mph), longer headway (≈1.7 s, NGSIM truck median), 5 m standstill
// gap, loaded-rig accel ≈0.6 m/s², gentle service braking ≈1.3 m/s², strong
// keep-right discipline (0.5 m/s² bias).
const TRUCK_OVERRIDE = { v0Cap: 3.6, T: 1.7, s0: 0.67, a: 0.08, b: 0.17,
                         politeness: 0.45, threshold: 0.027, biasRight: 0.067, leftPref: 0,
                         signalTime: 2.0, gapAccept: 1.25, patience: 12 };
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
    hasRamp: true, onRampCell: 59, offRampCell: 25,
    hasIncident: true, lightCells: null, style: 'highway',
  },
  city: {
    label: 'City Arterial',
    desc: 'Arterial street with signals. Cars enter at the left edge, stop-and-go through the lights, and exit at the right.',
    laneOptions: [1, 2], defaultLanes: 2,
    speedRange: [25, 45], speedStep: 5, defaultSpeed: 35,
    hasRamp: false,
    hasIncident: false, lightCells: [21, 46, 71], style: 'city',
  },
};

export {
  N, MPH_PER_CELL, TICK_MS, SUBSTEPS, SUB_DT, SENSOR_CELL, INCIDENT_CELL,
  EXIT_DECIDE_CELL, ROAD_MILES, CAR_LEN, TRUCK_LEN, MERGE_SHAPES, PROFILES,
  TRUCK_OVERRIDE, B_SAFE, MERGE_MARGIN, EXIT_RAMP_SPEED, SCENARIOS,
};
