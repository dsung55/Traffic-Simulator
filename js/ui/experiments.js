// Guided experiments: one-click scenarios that set the stage, explain what to
// watch and why, and walk the user through an A/B comparison (warm up, save a
// baseline, flip one factor, compare). This is the "learning" spine of the app.

export const WARMUP_S = 90;   // sim seconds before a baseline is meaningful

export const EXPERIMENTS = [
  {
    id: 'phantom', title: 'Phantom traffic jam', scenario: 'highway',
    teaser: 'One tap of the brakes creates a jam out of nothing.',
    setup: { demandVph: 1750, rampDemandVph: 300, reactionTime: 1.2, showHeatmap: true },
    watch: 'Once the road fills up, tap the brakes. Watch the red band on the heat map move left, against the traffic, long after the braking car has driven away.',
    why: 'Each follower reacts late and brakes a little harder than the car ahead. Near capacity the disturbance grows instead of fading, becoming a shock wave that travels upstream at roughly 10–15 mph.',
    steps: [
      { label: 'Tap the brakes', action: 'brake', repeat: true },
      { label: 'Save baseline, make drivers alert (0.4 s)', apply: { reactionTime: 0.4 }, baseline: true,
        then: 'Tap the brakes again. With quick reactions the wave should fade instead of growing.' },
    ],
  },
  {
    id: 'meter', title: 'Ramp metering at rush hour', scenario: 'highway',
    teaser: 'Hold cars on the ramp to keep the freeway moving.',
    setup: { demandVph: 1650, rampDemandVph: 1000, meterOn: false, meterInterval: 5, showHeatmap: true },
    watch: 'Unmetered platoons pour in at the merge, forcing mainline drivers to brake, and congestion spreads upstream. After you switch the meter on, compare mainline speed and travel time with the growing ramp queue.',
    why: 'Once a merge breaks down its throughput falls 5–15% (the "capacity drop"). A meter keeps the merge just under capacity, so the freeway keeps flowing even though ramp drivers wait.',
    steps: [{ label: 'Save baseline, turn the ramp meter on', apply: { meterOn: true }, baseline: true }],
  },
  {
    id: 'zipper', title: 'Early merge vs zipper merge', scenario: 'highway',
    teaser: 'Does a longer merge lane really help?',
    setup: { demandVph: 1450, rampDemandVph: 900, mergeShape: 'taper' },
    watch: 'With the short taper, ramp drivers must merge early and slowly into whatever gap appears. Switch to the zipper lane: cars accelerate alongside the mainline and alternate in.',
    why: 'Merging at matched speed into alternating gaps uses the full length of both lanes and avoids hard braking. That is why agencies promote the "zipper merge".',
    steps: [{ label: 'Save baseline, switch to a zipper lane', apply: { mergeShape: 'zipper' }, baseline: true,
      then: 'Changing the road layout restarts the run, so give it a couple of minutes before comparing.' }],
  },
  {
    id: 'rubberneck', title: 'Rubbernecking at an incident', scenario: 'highway',
    teaser: 'The crash isn’t the only problem: gawking is.',
    setup: { demandVph: 1400, incident: true, incidentLanes: 1, rubbernecking: true, showHeatmap: true },
    watch: 'One lane is blocked. Click a car in an OPEN lane as it passes the scene and watch its speed drop anyway.',
    why: 'Drivers slow down to look. A large share of incident delay comes from rubbernecking, even on the opposite side of a divided highway.',
    steps: [{ label: 'Save baseline, stop the rubbernecking', apply: { rubbernecking: false }, baseline: true }],
  },
  {
    id: 'weather', title: 'Rain and heavy trucks', scenario: 'highway',
    teaser: 'Same demand, worse conditions.',
    setup: { demandVph: 1550, pctTrucks: 5, weather: 'clear' },
    watch: 'Take a clear-weather baseline, then add rain and a 25% truck share. On the flow vs density chart, the same demand now sits at higher density and lower speed.',
    why: 'Rain lengthens following gaps and lowers speeds, and each truck uses the road space of about two cars. Both cut capacity, so demand that flowed freely can now break down.',
    steps: [{ label: 'Save baseline, add rain + 25% trucks', apply: { weather: 'rain', pctTrucks: 25 }, baseline: true }],
  },
  {
    id: 'av', title: 'Automated vehicles vs stop-and-go', scenario: 'highway',
    teaser: 'Can a few robot drivers smooth out the waves?',
    setup: { demandVph: 1800, reactionTime: 1.3, pctDistracted: 15, pctAV: 0, showHeatmap: true },
    watch: 'Slow and distracted drivers create stop-and-go waves. Add 30% automated vehicles and watch the heat map: waves weaken as AVs absorb them.',
    why: 'AVs react instantly and keep steady gaps, so they don’t amplify disturbances. Research suggests that even 5–20% automated vehicles can damp waves for everyone.',
    steps: [{ label: 'Save baseline, add 30% automated vehicles', apply: { pctAV: 30 }, baseline: true }],
  },
  {
    id: 'vsl', title: 'Speed harmonization', scenario: 'highway',
    teaser: 'Slow down upstream to go faster overall.',
    setup: { demandVph: 1750, incident: true, incidentLanes: 1, rubbernecking: true, vslOn: false, showHeatmap: true },
    watch: 'Drivers race up to the incident queue and brake hard. Turn on the variable speed limit and watch the upstream limit drop as the queue forms.',
    why: 'Lower upstream speeds feed vehicles into the bottleneck more evenly, reducing shock waves and rear-end risk. Many European motorways and US "smart corridors" use it.',
    steps: [{ label: 'Save baseline, turn on the variable speed limit', apply: { vslOn: true }, baseline: true }],
  },
  {
    id: 'greenwave', title: 'Green wave', scenario: 'city',
    teaser: 'Time the lights so platoons never stop.',
    setup: { demandVph: 650, cycleLen: 60, greenSplit: 0.5, greenWave: false },
    watch: 'With independent signals, cars stop at light after light. Coordinate them and watch the stops per vehicle and travel time.',
    why: 'When signal offsets match the travel time between lights, a platoon released at one signal arrives at the next just as it turns green. You get capacity without new pavement.',
    steps: [{ label: 'Save baseline, turn on the green wave', apply: { greenWave: true }, baseline: true }],
  },
];
