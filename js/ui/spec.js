// Declarative description of every user-facing control: which sim field it
// binds, its range and units, which scenario it applies to, and a short
// traffic-engineering explanation ("what it is / why it matters") shown in
// the info popover. The control panel, the "modified" badges, the baseline
// diff and the experiment presets are all generated from this one table.
import { SCENARIOS } from '../config.js';

// Control tabs, in display order. `icon` is an inline SVG path (16×16 box).
export const GROUPS = [
  { id: 'demand',  label: 'Demand',
    icon: 'M2 13h12M4 10l3-3 2 2 4-5' },
  { id: 'drivers', label: 'Drivers & Vehicles',
    icon: 'M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 14c.6-2.8 2.6-4.3 5-4.3s4.4 1.5 5 4.3' },
  { id: 'road',    label: 'Road',
    icon: 'M5.5 2 3 14M10.5 2 13 14M8 3v2M8 7.5v2M8 12v2' },
  { id: 'control', label: 'Traffic Control',
    icon: 'M6 1.8h4a1 1 0 0 1 1 1v10.4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1zM8 4.6v.01M8 8v.01M8 11.4v.01' },
  { id: 'events',  label: 'Events',
    icon: 'M8 2 1.8 13h12.4zM8 6.5v3M8 11.4v.01' },
  { id: 'env',     label: 'Environment',
    icon: 'M4.5 11.5a3 3 0 0 1-.3-6A4 4 0 0 1 12 6a2.8 2.8 0 0 1 .2 5.5zM5 14l-.7 1M8.5 14l-.7 1M12 14l-.7 1' },
  { id: 'sim',     label: 'Simulation',
    icon: 'M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM8 4.5V8l2.4 1.6' },
];

const pct = v => Math.round(v) + '%';
const num = v => Math.round(v).toLocaleString('en-US');
const HWY = 'highway', CITY = 'city';

// Lane capacity used for the demand hint: a modern freeway lane tops out
// around 2,000–2,200 veh/h (HCM basic freeway segment); a signalised lane
// discharges at a saturation flow of ~1,800 veh/h of green.
const FREEWAY_CAP = 2000, SAT_FLOW = 1800;

// Defaults per scenario (mirrors the engine's own defaults in state.js).
export function defaultsFor(scn) {
  const s = SCENARIOS[scn] || SCENARIOS.highway;
  return {
    lanes: s.defaultLanes, speedMph: s.defaultSpeed,
    demandVph: scn === CITY ? 700 : 1500, rampDemandVph: 600,
    exitRamp: false, exitPct: 20,
    reactionTime: 0.8, pctAgg: 15, pctPas: 15, pctDistracted: 0, pctAV: 0, pctTrucks: 10,
    mergeShape: 'taper', truckLaneRestriction: false,
    meterOn: false, meterInterval: 8, vslOn: false,
    cycleLen: 60, greenSplit: 0.5, greenWave: false,
    incident: false, incidentLanes: 1, rubbernecking: true,
    weather: 'clear', showHeatmap: false,
  };
}

/*
 * Control fields:
 *   key       sim field            type  range | toggle | select | seg | action
 *   group     tab id               label visible label
 *   scenario  'highway' | 'city'   (omitted = both)
 *   when(sim) extra availability test (disabled, with `whyOff` text, when false)
 *   parent    toggle key that must be ON for this control to be active
 *   fmt(v)    value pill text      hint(sim) live sub-line under the control
 *   info      { what, why }        reset: true if changing it restarts the run
 *   track     false to exclude from baseline diffs / modified badges
 */
export const CONTROLS = [
  // ── Demand ──────────────────────────────────────────────────────────
  { key: 'demandVph', group: 'demand', type: 'range', label: 'Mainline demand',
    min: 0, max: 2400, step: 50, fmt: v => num(v) + ' veh/h/ln',
    hint: s => s.scenario === CITY
      ? `Signals cap a lane near ${num(SAT_FLOW * (s.greenSplit ?? 0.5))} veh/h (${num(SAT_FLOW)} × ${pct((s.greenSplit ?? 0.5) * 100)} green)`
      : `${pct(100 * s.demandVph / FREEWAY_CAP)} of a lane's capacity (~${num(FREEWAY_CAP)} veh/h)`,
    info: { what: 'Vehicles per hour, per lane, arriving at the upstream (left) edge. Density on the road is not set directly; it emerges from demand and how well the road serves it.',
            why: 'A freeway lane carries at most ~2,000–2,200 veh/h. Near that capacity traffic is fragile: small disturbances grow into jams. Above it, a queue must form somewhere.' } },
  { key: 'rampDemandVph', group: 'demand', type: 'range', label: 'On-ramp demand', scenario: HWY,
    min: 0, max: 1500, step: 50, fmt: v => num(v) + ' veh/h',
    hint: s => `Downstream of the merge: ${num(s.demandVph * s.lanes + s.rampDemandVph)} veh/h total vs ~${num(FREEWAY_CAP * s.lanes)} capacity`,
    info: { what: 'Vehicles per hour joining from the on-ramp. Each one needs a gap in the right lane to merge into.',
            why: 'When mainline + ramp demand exceeds the capacity downstream of the merge, the merge becomes a bottleneck: the textbook rush-hour breakdown. Ramp metering targets exactly this.' } },
  { key: 'exitRamp', group: 'demand', type: 'toggle', label: 'Exit ramp', scenario: HWY,
    info: { what: 'Opens an off-ramp near the downstream end with a deceleration lane.',
            why: 'Exiting drivers must weave right across through traffic. Heavy weaving creates turbulence (extra lane changes and braking) even though it removes cars from the road.' } },
  { key: 'exitPct', group: 'demand', type: 'range', label: 'Drivers taking the exit', scenario: HWY, parent: 'exitRamp',
    min: 5, max: 50, step: 1, fmt: pct,
    info: { what: 'Average share of mainline drivers who leave at the exit.',
            why: 'More exiting traffic means more weaving across lanes. Weaving sections are capacity-limited by lane changes, not just by vehicle count.' } },

  // ── Drivers & vehicles ──────────────────────────────────────────────
  { key: 'reactionTime', group: 'drivers', type: 'range', label: 'Reaction time',
    min: 0, max: 2, step: 0.1, fmt: v => v.toFixed(1) + ' s',
    hint: s => s.reactionTime < 0.6 ? 'Very alert drivers'
      : s.reactionTime <= 1.2 ? 'Typical alert driver (0.7–1.2 s)' : 'Slow / tired drivers',
    info: { what: 'Delay between the car ahead changing speed and a human driver responding. Applies to human drivers only (AVs react almost instantly).',
            why: 'Late reactions force harder braking than the leader used, so each driver over-reacts a little more than the one ahead. That "string instability" amplifies a small tap on the brakes into a full stop several cars back.' } },
  { key: 'pctAgg', group: 'drivers', type: 'range', label: 'Aggressive drivers', dot: 'dotA',
    min: 0, max: 50, step: 1, fmt: pct,
    info: { what: 'Tailgaters: ~1.0 s headway, hard acceleration and eager, less polite lane changes.',
            why: 'Short headways raise capacity slightly, but abrupt cut-ins force followers to brake, seeding shock waves. They rarely arrive much sooner.' } },
  { key: 'pctPas', group: 'drivers', type: 'range', label: 'Cautious drivers', dot: 'dotP',
    min: 0, max: 50, step: 1, fmt: pct,
    info: { what: 'Cautious drivers: ~1.8 s headway, gentle acceleration, polite merging.',
            why: 'Smooth and safe, but longer gaps mean fewer vehicles per lane per hour, so capacity drops when many drive this way.' } },
  { key: 'pctDistracted', group: 'drivers', type: 'range', label: 'Distracted drivers',
    min: 0, max: 50, step: 1, fmt: pct,
    info: { what: 'Share of human drivers prone to phone distraction: brief attention lapses where they stop reacting, then brake late.',
            why: 'A lapse turns a gentle slowdown ahead into a hard, late brake. A few late brakers are enough to trigger stop-and-go waves.' } },
  { key: 'pctAV', group: 'drivers', type: 'range', label: 'Automated vehicles',
    min: 0, max: 100, step: 5, fmt: pct,
    info: { what: 'Vehicles on adaptive cruise / automation: near-zero reaction delay, a stable gap, smooth acceleration and polite lane changes.',
            why: 'AVs absorb disturbances instead of amplifying them. Field experiments (e.g. Stern et al., 2018) showed a single well-controlled car can dissolve a stop-and-go wave on a ring road.' } },
  { key: 'pctTrucks', group: 'drivers', type: 'range', label: 'Trucks',
    min: 0, max: 30, step: 1, fmt: pct,
    info: { what: 'Share of heavy vehicles: ~2.5 car lengths, governed near 60 mph, slow acceleration and longer headways.',
            why: 'Engineers count a truck as 1.5–2.5 "passenger-car equivalents": each one uses the road space of several cars, so more trucks means less capacity, especially at merges.' } },

  // ── Road ────────────────────────────────────────────────────────────
  { key: 'lanes', group: 'road', type: 'seg', label: 'Lanes',
    options: s => (SCENARIOS[s.scenario] || SCENARIOS.highway).laneOptions.map(n => [n, String(n)]),
    fmt: v => v + (v === 1 ? ' lane' : ' lanes'),
    info: { what: 'Number of through lanes. Changes the road in place; traffic adapts.',
            why: 'Each lane adds roughly 2,000 veh/h of capacity, but only helps if it relieves the actual bottleneck. Extra lanes upstream of a merge just deliver cars to the jam faster.' } },
  { key: 'speedMph', group: 'road', type: 'range', label: 'Speed limit',
    min: s => (SCENARIOS[s.scenario] || SCENARIOS.highway).speedRange[0],
    max: s => (SCENARIOS[s.scenario] || SCENARIOS.highway).speedRange[1],
    step: s => (SCENARIOS[s.scenario] || SCENARIOS.highway).speedStep,
    fmt: v => v + ' mph',
    hint: s => s.vslOn && Number.isFinite(s.vslMph) && s.vslMph < s.speedMph
      ? `Speed harmonization is posting ${Math.round(s.vslMph)} mph upstream` : '',
    info: { what: 'Posted limit; drivers choose a desired speed around it (aggressive drivers a bit above, cautious a bit below).',
            why: 'Higher speeds shorten trips in light traffic, but drivers need longer gaps at speed, so lane capacity peaks around 45–60 mph. Raising the limit barely raises throughput.' } },
  { key: 'mergeShape', group: 'road', type: 'select', label: 'On-ramp merge lane', scenario: HWY, reset: true,
    options: () => [['taper', 'Short taper (~60 m)'], ['zipper', 'Zipper lane (~90 m)'], ['parallel', 'Long parallel (~135 m)']],
    fmt: v => ({ taper: 'Short taper', zipper: 'Zipper', parallel: 'Long parallel' })[v] || v,
    info: { what: 'Length of the acceleration lane where ramp traffic merges. Changing it restarts the run.',
            why: 'A short taper forces drivers to merge early, slow and into whatever gap appears. A longer lane lets them match speed and "zipper" in, alternating with mainline cars, which keeps the merge smoother.' } },
  { key: 'truckLaneRestriction', group: 'road', type: 'toggle', label: 'Keep trucks out of left lane',
    when: s => s.lanes >= 2, whyOff: 'Needs 2+ lanes',
    info: { what: 'Trucks may not use the leftmost (fast) lane.',
            why: 'Gives cars a clean passing lane and fewer slow "elephant races", but concentrates trucks in the right lanes where ramps merge. Its net effect depends on the truck share.' } },

  // ── Traffic control ─────────────────────────────────────────────────
  { key: 'meterOn', group: 'control', type: 'toggle', label: 'Ramp meter', scenario: HWY,
    info: { what: 'A traffic signal on the on-ramp that releases one vehicle at a time.',
            why: 'Spacing out merging cars keeps the merge below capacity, so the mainline does not break down. The cost is a queue on the ramp: a deliberate trade-off used on freeways worldwide.' } },
  { key: 'meterInterval', group: 'control', type: 'range', label: 'Meter release interval', scenario: HWY, parent: 'meterOn',
    min: 4, max: 30, step: 1, fmt: v => '1 car / ' + v + ' s',
    hint: s => {
      const rate = 3600 / s.meterInterval;
      return `Releases ≈ ${num(rate)} veh/h` + (rate < s.rampDemandVph ? ' (below ramp demand, so the queue will grow)' : '');
    },
    info: { what: 'Seconds between green lights at the ramp meter (3600 / interval = metered rate).',
            why: 'Too fast and the meter does nothing; too slow and the ramp queue spills back onto city streets. Real systems adapt the rate to mainline occupancy.' } },
  { key: 'vslOn', group: 'control', type: 'toggle', label: 'Variable speed limit', scenario: HWY,
    hint: s => s.vslOn ? (Number.isFinite(s.vslMph) ? `Currently posting ${Math.round(s.vslMph)} mph upstream` : 'Waiting for congestion downstream') : '',
    info: { what: 'Speed harmonization: when congestion is detected downstream, overhead signs lower the limit upstream.',
            why: 'Drivers approach the queue gradually instead of braking hard into it, so speed differences shrink and breakdown is delayed. It trades a little speed for steadier flow.' } },
  { key: 'cycleLen', group: 'control', type: 'range', label: 'Signal cycle length', scenario: CITY,
    min: 30, max: 90, step: 5, fmt: v => v + ' s',
    hint: s => `${Math.round(s.cycleLen * (s.greenSplit ?? 0.5))} s green per cycle`,
    info: { what: 'Time for one full green → yellow → red rotation at each light.',
            why: 'Every green start loses a few seconds while the queue gets moving. Longer cycles lose that time less often (more capacity) but make red waits longer (more delay).' } },
  { key: 'greenSplit', group: 'control', type: 'range', label: 'Green share (split)', scenario: CITY,
    min: 0.3, max: 0.7, step: 0.05, fmt: v => pct(v * 100),
    hint: s => `${Math.round(s.cycleLen * s.greenSplit)} s green / ${Math.round(s.cycleLen * (1 - s.greenSplit))} s red`,
    info: { what: 'Fraction of each cycle that is green for the arterial (the rest serves cross streets, not modelled).',
            why: 'Capacity of a signalised lane ≈ saturation flow (~1,800 veh/h) × green share. Giving the arterial more green raises its capacity at the cross streets\' expense.' } },
  { key: 'greenWave', group: 'control', type: 'toggle', label: 'Green wave (coordinated)', scenario: CITY,
    info: { what: 'Offsets each light so a platoon released by one signal reaches the next just as it turns green.',
            why: 'Coordinated signals let platoons roll through without stopping. Stops and delay fall sharply, with no new pavement.' } },

  // ── Events ──────────────────────────────────────────────────────────
  { key: 'phantomBrake', group: 'events', type: 'action', label: 'Phantom brake', kbd: 'B', track: false,
    button: 'Tap the brakes',
    hint: s => s.selected ? `Car #${s.selected.id} (selected) will brake` : 'A random mid-road car will brake (select a car to choose)',
    info: { what: 'One driver brakes hard for ~2 s for no reason.',
            why: 'Near capacity the disturbance grows as it passes back through the traffic and becomes a jam that travels upstream long after its cause is gone: the "phantom traffic jam".' } },
  { key: 'incident', group: 'events', type: 'toggle', label: 'Incident (lane blockage)', scenario: HWY,
    info: { what: 'A crash or stalled vehicle blocks lanes mid-section.',
            why: 'Blocking 1 of 3 lanes typically removes about half of the capacity, not a third, because drivers must merge out and slow down near the scene.' } },
  { key: 'incidentLanes', group: 'events', type: 'range', label: 'Lanes blocked', scenario: HWY, parent: 'incident',
    min: 1, max: s => Math.max(1, s.lanes - 1), step: 1, fmt: v => v + (v === 1 ? ' lane' : ' lanes'),
    hint: s => `${s.lanes - s.incidentLanes} of ${s.lanes} lanes open`,
    info: { what: 'How many lanes the incident closes (counting from the right).',
            why: 'Each closed lane forces more merging into fewer lanes; the queue grows whenever demand exceeds the remaining capacity.' } },
  { key: 'rubbernecking', group: 'events', type: 'toggle', label: 'Rubbernecking', scenario: HWY, parent: 'incident',
    info: { what: 'Drivers slow down to look at the incident, even in the open lanes.',
            why: '"Gawking" cuts the capacity of the open lanes, and studies find it can cause as much delay as the blockage itself, sometimes even on the opposite carriageway.' } },

  // ── Environment ─────────────────────────────────────────────────────
  { key: 'weather', group: 'env', type: 'seg', label: 'Weather',
    options: () => [['clear', 'Clear'], ['rain', 'Rain'], ['fog', 'Fog'], ['snow', 'Snow']],
    fmt: v => ({ clear: 'Clear', rain: 'Rain', fog: 'Fog', snow: 'Snow' })[v] || v,
    hint: s => ({ clear: 'Dry pavement, full visibility',
                  rain: 'Slower speeds, ~15% longer gaps: capacity typically drops 5–15%',
                  fog: 'Low visibility: lower speeds and longer gaps',
                  snow: 'Slowest, longest gaps, weak acceleration and braking: capacity can fall 20–30%' })[s.weather] || '',
    info: { what: 'Road and visibility conditions. Drivers lower their speed and keep longer gaps; in snow they also accelerate and brake more gently.',
            why: 'Capacity = how tightly vehicles can pack at speed. Longer gaps and slower speeds both cut it, so the same demand that flows on a dry day can jam in rain.' } },

  // ── Simulation / view ───────────────────────────────────────────────
  { key: 'showHeatmap', group: 'sim', type: 'toggle', label: 'Speed heat-map overlay', kbd: 'H', track: false,
    info: { what: 'Colors the road by local speed: green = free flow, amber = slowing, red = jammed.',
            why: 'Makes congestion patterns visible: watch jams form at bottlenecks and stop-and-go waves travel upstream, against the direction of traffic.' } },
];

export const CONTROL_BY_KEY = Object.fromEntries(CONTROLS.map(c => [c.key, c]));

// Resolve a field that may be a constant or a function of sim.
export function resolve(v, s) { return typeof v === 'function' ? v(s) : v; }

// Is control `c` relevant to the current scenario?
export function inScenario(c, s) { return !c.scenario || c.scenario === s.scenario; }

// Human-readable value for any control (also used by the baseline diff).
export function fmtValue(c, v) {
  if (c.type === 'toggle') return v ? 'On' : 'Off';
  if (v === undefined || v === null) return '–';
  return c.fmt ? c.fmt(v) : String(v);
}

// Keys that make up a "settings snapshot" (for baselines / modified badges).
export const TRACKED = ['scenario', ...CONTROLS.filter(c => c.type !== 'action' && c.track !== false).map(c => c.key)];
