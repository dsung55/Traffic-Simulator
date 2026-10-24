// Guided experiments: one-click scenarios that set the stage, explain what to
// watch and why, and walk the user through an A/B comparison (warm up, save a
// baseline, flip one factor, compare). This is the "learning" spine of the app.
//
// Every setup below was checked headlessly against the real engine (seeded,
// several runs, the same warm-up → baseline → change → settle sequence the
// guide walks you through): `expect` records the direction each focus metric
// moves (+1 up, −1 down, 0 = changes by less than ~10%, 'noDrop' / 'noRise'
// = on average does not fall / rise), and
// test/experiments.test.js asserts it, so the
// explanation never claims something the simulation does not show.

// Sim seconds to wait before saving a baseline, and again after the change
// before judging it. Trip statistics cover the last ~2 minutes of completed
// trips, so they need the road to fill AND that window to turn over.
// Experiments may override it (`warmup`) where queues take longer to settle.
export const WARMUP_S = 150;

export const EXPERIMENTS = [
  {
    id: 'phantom', title: 'Phantom traffic jam', scenario: 'highway',
    teaser: 'One tap of the brakes creates a jam out of nothing.',
    setup: { demandVph: 1500, rampDemandVph: 500, reactionTime: 1.2, showHeatmap: true },
    focus: ['avgSpeedMph', 'flowVphPerLane', 'hardBrakePct'],
    expect: { avgSpeedMph: +1, flowVphPerLane: +1, hardBrakePct: -1 },
    brakeEvery: 20,   // the guide asks you to keep tapping the brakes (tests do the same)
    watch: 'Busy traffic with slow (1.2 s) reactions. Tap the brakes a few times and watch the red band on the heat map move left, against the traffic, long after the braking car has driven away.',
    why: 'Each follower reacts late and brakes a little harder than the car ahead. Near capacity the disturbance grows instead of fading, becoming a shock wave that travels upstream at roughly 10–15 mph. Waves also waste capacity: the road carries fewer cars per hour. Quicker reactions damp them out.',
    steps: [
      { label: 'Tap the brakes', action: 'brake', repeat: true },
      { label: 'Save baseline, make drivers alert (0.4 s)', apply: { reactionTime: 0.4 }, baseline: true,
        then: 'Keep tapping the brakes. With quick reactions the slowdown fades instead of growing: speed and flow rise, hard braking drops.' },
    ],
  },
  {
    id: 'meter', title: 'Ramp metering: who pays?', scenario: 'highway',
    teaser: 'Holding cars on the ramp moves the queue. Does it help?',
    setup: { demandVph: 1800, rampDemandVph: 700, meterOn: false, meterInterval: 5, showHeatmap: true },
    focus: ['avgSpeedMph', 'rampQueue', 'meanRampWaitS'],
    expect: { rampQueue: +1, meanRampWaitS: +1 },
    watch: 'A busy freeway with a busy on-ramp. Turn the meter on (one car every 5 s) and compare the mainline speed with the queue it builds on the ramp.',
    why: 'Holding ramp traffic back protects the merge, so the mainline can run a little faster, but only where unmetered merging was breaking it down (the "capacity drop", 5–15% of throughput). The price is paid on the ramp, where the queue and the wait grow a lot. Real agencies tune meters to mainline sensors for exactly this reason: a badly timed meter just moves delay onto the ramp.',
    steps: [{ label: 'Save baseline, turn the ramp meter on', apply: { meterOn: true }, baseline: true,
      then: 'Watch the ramp queue and ramp wait grow, and how much (if at all) the mainline speed improves in return.' }],
  },
  {
    id: 'split', title: 'More green for the main street', scenario: 'city',
    teaser: 'Who gets the green decides who gets through.',
    setup: { demandVph: 450, cycleLen: 60, greenSplit: 0.4, greenWave: false },
    warmup: 240,
    focus: ['meanTravelTimeS', 'stopsPerVeh'],
    expect: { meanTravelTimeS: -1, stopsPerVeh: -1 },
    watch: 'The arterial gets only 40% of each signal cycle: queues at each light barely clear before red returns. Give it 60% and watch the queues and the stops per vehicle.',
    why: 'A signalised lane can only discharge while it is green: capacity ≈ saturation flow (~1,800 veh/h) × green share. With 40% green this demand is close to that limit, so cars wait through more than one red. More green raises capacity and cuts delay sharply, at the cross streets\' expense (not modelled here).',
    steps: [{ label: 'Save baseline, give the arterial 60% green', apply: { greenSplit: 0.6 }, baseline: true }],
  },
  {
    id: 'rubberneck', title: 'Rubbernecking at an incident', scenario: 'highway',
    teaser: 'The crash isn’t the only problem: gawking is.',
    setup: { demandVph: 550, rampDemandVph: 150, incident: true, incidentLanes: 1, rubbernecking: true, showHeatmap: true },
    warmup: 240,
    focus: ['avgSpeedMph', 'meanTravelTimeS'],
    expect: { avgSpeedMph: +1, meanTravelTimeS: 'noRise' },
    watch: 'One lane is blocked. Click a car in an OPEN lane as it passes the scene and watch its speed drop anyway.',
    why: 'Drivers slow down to look. A large share of incident delay comes from rubbernecking, even on the opposite side of a divided highway. Speeds past the scene recover clearly; trip times usually fall too, but queues at an incident are noisy, so give it another minute if they have not.',
    steps: [{ label: 'Save baseline, stop the rubbernecking', apply: { rubbernecking: false }, baseline: true }],
  },
  {
    id: 'weather', title: 'Rain and heavy trucks', scenario: 'highway',
    teaser: 'Same demand, worse conditions.',
    setup: { demandVph: 1550, pctTrucks: 5, weather: 'clear' },
    focus: ['avgSpeedMph', 'meanTravelTimeS', 'flowVphPerLane'],
    expect: { avgSpeedMph: -1, meanTravelTimeS: +1, flowVphPerLane: -1 },
    watch: 'Take a clear-weather baseline, then add rain and a 25% truck share. On the flow vs density chart, the same demand now sits at higher density and lower speed, and a queue starts to build upstream.',
    why: 'Rain lengthens following gaps and lowers speeds, and each truck uses the road space of about two cars. Both cut capacity, so demand that flowed freely can now break down.',
    steps: [{ label: 'Save baseline, add rain + 25% trucks', apply: { weather: 'rain', pctTrucks: 25 }, baseline: true }],
  },
  {
    id: 'av', title: 'Automated vehicles vs stop-and-go', scenario: 'highway',
    teaser: 'Can robot drivers smooth out the waves?',
    setup: { demandVph: 1800, reactionTime: 1.3, pctDistracted: 15, pctAV: 0, showHeatmap: true },
    focus: ['flowVphPerLane', 'avgSpeedMph'],
    expect: { flowVphPerLane: +1, avgSpeedMph: +1 },
    watch: 'Slow and distracted drivers create stop-and-go waves and more traffic arrives than the road can take. Add 40% automated vehicles and watch the heat map: waves weaken as AVs absorb them.',
    why: 'AVs react instantly and keep steady, shorter gaps, so they don’t amplify disturbances and the same lanes carry more vehicles per hour. The gain shows up as throughput and speed. Trip times on the road need not fall (it now holds more cars), and at this demand more traffic still arrives than even the improved road can carry, so a queue still builds upstream.',
    steps: [{ label: 'Save baseline, add 40% automated vehicles', apply: { pctAV: 40 }, baseline: true }],
  },
  {
    id: 'vsl', title: 'Speed harmonization', scenario: 'highway',
    teaser: 'Slow down upstream: smoother, but faster?',
    setup: { demandVph: 550, rampDemandVph: 150, incident: true, incidentLanes: 1, rubbernecking: true, vslOn: false, showHeatmap: true },
    warmup: 240,
    focus: ['hardBrakePct', 'meanTravelTimeS'],
    expect: { hardBrakePct: -1, meanTravelTimeS: 'noDrop' },
    watch: 'Drivers race up to the incident queue and brake hard. Turn on the variable speed limit and watch the upstream limit drop as the queue forms.',
    why: 'Lower upstream speeds mean drivers reach the back of the queue gently: far less hard braking and smaller speed differences, which is mainly a safety benefit (fewer rear-end crashes). It does not make trips faster here: on a short road the lower limit usually costs some time. Long corridors can gain a little throughput by delaying breakdown. Incident traffic is noisy, so one run can buck the trend: repeat it to see the pattern.',
    steps: [{ label: 'Save baseline, turn on the variable speed limit', apply: { vslOn: true }, baseline: true }],
  },
  {
    id: 'greenwave', title: 'Green wave', scenario: 'city',
    teaser: 'Time the lights so platoons never stop.',
    setup: { demandVph: 450, cycleLen: 60, greenSplit: 0.5, greenWave: false },
    warmup: 240,
    focus: ['stopsPerVeh', 'meanTravelTimeS'],
    expect: { stopsPerVeh: -1, meanTravelTimeS: -1 },
    watch: 'With independent signals, cars stop at light after light. Coordinate them and watch the stops per vehicle and travel time.',
    why: 'When signal offsets match the travel time between lights, a platoon released at one signal arrives at the next just as it turns green. You get fewer stops and shorter trips without new pavement. (Push demand past what the green time can serve and queues spill back, and coordination helps much less.)',
    steps: [{ label: 'Save baseline, turn on the green wave', apply: { greenWave: true }, baseline: true }],
  },
];
