// Control-panel wiring, live metrics, the speed sparkline and the
// click-to-inspect vehicle panel.
import { MPH_PER_CELL, ROAD_MILES, N } from './config.js';
import {
  sim, cfg, rampLaneIdx, densityCap, effTarget, carV0,
} from './state.js';
import { leaderInLane, resetSim, applyLaneCount } from './engine.js';
import { $, fmt } from './dom.js';

//──────────────────────────── Metrics (every 500 ms) ────────────────────────────
function updateMetrics() {
  const cars = sim.cars;
  const mph = v => v * MPH_PER_CELL;
  const avg = arr => arr.length ? arr.reduce((a, c) => a + c.v, 0) / arr.length : NaN;

  const avgAll = avg(cars);
  $('mSpeed').textContent = cars.length ? fmt(mph(avgAll), 1) + ' mph' : '–';
  for (const [id, name] of [['mSpeedA', 'aggressive'], ['mSpeedN', 'normal'], ['mSpeedP', 'passive']]) {
    const grp = cars.filter(c => c.profName === name);
    $(id).textContent = grp.length ? fmt(mph(avg(grp)), 1) + ' mph' : '–';
  }

  $('mDensity').textContent = fmt(cars.length / ROAD_MILES / sim.lanes, 1) + ' /mi/lane';

  const tput = sim.evThroughput.filter(t => t > sim.time - 60).length;
  $('mThroughput').textContent = tput + ' cars/min';

  // Traffic rating: 0 (free flow) → 100 (standstill), color-coded gauge.
  let rating = NaN;
  if (cars.length && sim.speedMph > 0) {
    rating = Math.max(0, Math.min(100, 100 * (1 - mph(avgAll) / sim.speedMph)));
  }
  $('mRating').textContent = fmt(rating, 0);
  const bar = $('gaugeBar');
  bar.style.width = (Number.isFinite(rating) ? rating : 0) + '%';
  const band = !Number.isFinite(rating) || rating < 33 ? 0 : rating < 66 ? 1 : 2;
  bar.style.background = [
    'linear-gradient(90deg,#2cb863,#5fdc8f)',
    'linear-gradient(90deg,#dcae33,#f6d36c)',
    'linear-gradient(90deg,#df4a3f,#ff7d66)',
  ][band];
  $('mRating').style.color = Number.isFinite(rating)
    ? ['var(--good)', 'var(--warn)', 'var(--bad)'][band] : 'var(--text)';

  if (cfg().hasRamp) {
    const onRamp = cars.filter(c => c.lane === rampLaneIdx()).length;
    $('mQueueLabel').textContent = 'Ramp queue';
    $('mQueue').textContent = (sim.rampQueue + onRamp) + ' cars';
  } else {
    const stops = sim.evStops.filter(t => t > sim.time - sim.cycleLen).length;
    $('mQueueLabel').textContent = 'Stops / light cycle';
    $('mQueue').textContent = fmt(cars.length ? stops / cars.length : NaN, 2);
  }

  $('mLaneCh').textContent = sim.evLaneChanges.filter(t => t > sim.time - 60).length + ' /min';

  // Sparkline: last 120 samples (60 s at 500 ms cadence)
  sim.speedHistory.push(Number.isFinite(avgAll) ? mph(avgAll) : 0);
  if (sim.speedHistory.length > 120) sim.speedHistory.shift();
  drawSpark();
}

function drawSpark() {
  const cv = $('spark'), g = cv.getContext('2d');
  // Crisp at any zoom: back the canvas at devicePixelRatio resolution,
  // sized from its CSS box (falls back to the attribute size pre-layout).
  const sdpr = window.devicePixelRatio || 1;
  const cw2 = cv.clientWidth || 248, ch2 = cv.clientHeight || 60;
  const pw = Math.max(1, Math.round(cw2 * sdpr)), ph = Math.max(1, Math.round(ch2 * sdpr));
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  g.setTransform(sdpr, 0, 0, sdpr, 0, 0);
  g.clearRect(0, 0, cw2, ch2);

  const data = sim.speedHistory;
  if (data.length < 2) return;
  const max = Math.max(sim.speedMph, ...data) * 1.08;
  const X = i => i / 119 * (cw2 - 8) + 4;
  const Y = v => ch2 - 5 - (v / max) * (ch2 - 12);

  // speed-limit dashed reference
  g.strokeStyle = 'rgba(240,194,75,.4)'; g.lineWidth = 1; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(4, Y(sim.speedMph)); g.lineTo(cw2 - 4, Y(sim.speedMph));
  g.stroke(); g.setLineDash([]);

  // gradient area fill under the trace
  const fill = g.createLinearGradient(0, 0, 0, ch2);
  fill.addColorStop(0, 'rgba(88,166,255,.32)');
  fill.addColorStop(1, 'rgba(88,166,255,0)');
  g.beginPath();
  data.forEach((v, i) => { i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); });
  g.lineTo(X(data.length - 1), ch2 - 2); g.lineTo(X(0), ch2 - 2); g.closePath();
  g.fillStyle = fill; g.fill();

  // the trace itself, with a glowing endpoint dot on the live sample
  g.strokeStyle = '#58a6ff'; g.lineWidth = 1.6; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  data.forEach((v, i) => { i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); });
  g.stroke();
  const ex = X(data.length - 1), ey = Y(data[data.length - 1]);
  g.fillStyle = 'rgba(88,166,255,.35)';
  g.beginPath(); g.arc(ex, ey, 4.5, 0, 7); g.fill();
  g.fillStyle = '#bcd9ff';
  g.beginPath(); g.arc(ex, ey, 2, 0, 7); g.fill();
}

function selectCar(car) {
  sim.selected = car || null;
  $('inspector').classList.toggle('show', !!car);
  if (!car) return;
  $('insSwatch').style.background = car.color;
  $('insName').textContent = (car.isTruck ? 'Truck' : 'Car') + ' #' + car.id;
  $('insProf').textContent = car.profName + ' driver' + (car.isTruck ? ' · truck' : '');
  updateInspector();
}

// Refresh the panel readouts; deselects automatically once the car leaves the
// road. Runs on a 200 ms interval (one sim tick) — fast enough to feel live.
function updateInspector() {
  const car = sim.selected;
  if (!car) return;
  if (!sim.cars.includes(car)) { selectCar(null); return; }
  const toMph = v => v * MPH_PER_CELL;
  $('insSpeed').textContent = fmt(toMph(car.v), 1) + ' mph';
  $('insV0').textContent = fmt(toMph(carV0(car)), 0) + ' mph';
  $('insAcc').textContent = fmt((car.accel || 0) * 7.5, 2) + ' m/s²';
  const lead = leaderInLane(car, car.lane, N);
  $('insGap').textContent = lead.lead ? fmt(lead.gap * 7.5, 0) + ' m' : 'open road';
  $('insHeadway').textContent =
    lead.lead && car.v > 0.05 ? fmt(lead.gap / car.v, 1) + ' s' : '–';
  $('insLane').textContent =
    cfg().hasRamp && car.lane === rampLaneIdx() ? 'On-ramp' : 'Lane ' + (car.lane + 1);
  let st = car.lc ? (car.lc.phase === 'signal' ? 'Signaling · waiting for gap'
                   : car.lc.phase === 'abort' ? 'Aborting lane change'
                   : 'Changing lanes')
         : car.braking ? 'Braking'
         : car.v < 0.05 ? 'Stopped'
         : (car.accel || 0) > 0.05 ? 'Accelerating' : 'Cruising';
  if (car.exiting) st += ' · exiting';
  $('insStatus').textContent = st;
  $('insAge').textContent = car.age + ' s';
}

//──────────────────────────── UI wiring ────────────────────────────
function setDisabled(id, off) { $(id).classList.toggle('disabled', off); }

const ICON_PAUSE = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">' +
  '<rect x="3" y="2.5" width="3.5" height="11" rx="1.2"/><rect x="9.5" y="2.5" width="3.5" height="11" rx="1.2"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">' +
  '<path d="M5 3.2a1 1 0 0 1 1.53-.85l7 4.3a1 1 0 0 1 0 1.7l-7 4.3A1 1 0 0 1 5 11.8z"/></svg>';

// Paint a slider's filled-track portion via the --p custom property
// (the track background is a linear-gradient split at --p).
function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  const p = max > min ? (el.value - min) / (max - min) * 100 : 0;
  el.style.setProperty('--p', p + '%');
}
function paintAllRanges() {
  document.querySelectorAll('input[type=range]').forEach(paintRange);
}
// Brief highlight on the value pill belonging to a slider.
function flashVal(el) {
  const wrap = el.closest('.ctl');
  const v = wrap && wrap.querySelector('.val');
  if (!v) return;
  v.classList.remove('bump'); void v.offsetWidth; v.classList.add('bump');
}
// Pause button + header status chip reflect the run state.
function updatePauseUI() {
  const b = $('btnPause');
  b.classList.toggle('paused', sim.paused);
  b.setAttribute('aria-pressed', String(sim.paused));
  b.innerHTML = (sim.paused ? ICON_PLAY + '<span>Play</span>' : ICON_PAUSE + '<span>Pause</span>');
  $('statusChip').classList.toggle('paused', sim.paused);
  $('statusState').textContent = sim.paused ? 'Paused' : 'Live';
}

// Sync control availability/ranges to the active scenario.
function syncControls() {
  const s = cfg();
  $('scenarioDesc').textContent = s.desc;
  $('statusScenario').textContent = s.label;

  const sp = $('speed');
  sp.min = s.speedRange[0]; sp.max = s.speedRange[1]; sp.step = s.speedStep;
  sim.speedMph = Math.min(Math.max(sim.speedMph, s.speedRange[0]), s.speedRange[1]);
  sp.value = sim.speedMph;

  const ln = $('lanes');
  ln.innerHTML = s.laneOptions.map(n => `<option value="${n}">${n}</option>`).join('');
  if (!s.laneOptions.includes(sim.lanes)) sim.lanes = s.defaultLanes;
  ln.value = sim.lanes;

  setDisabled('cMeter', !s.hasRamp);
  setDisabled('cMerge', !s.hasRamp);
  setDisabled('cExit', s.offRampCell === undefined);
  setDisabled('cIncident', !s.hasIncident);
  setDisabled('cCycle', !s.lightCells);
  setDisabled('cWave', !s.lightCells);

  updateLabels();
}

function updateLabels() {
  $('carsVal').textContent = effTarget() + (effTarget() < sim.targetCars ? ` (cap ${densityCap()})` : '');
  $('speedVal').textContent = sim.speedMph + ' mph';
  $('trucksVal').textContent = sim.pctTrucks + '%';
  $('aggVal').textContent = sim.pctAgg + '%';
  $('pasVal').textContent = sim.pctPas + '%';
  $('meterRateVal').textContent = sim.meterInterval + ' s';
  $('exitPctVal').textContent = sim.exitPct + '%';
  $('cycleVal').textContent = sim.cycleLen + ' s';
  // Repaint every slider's filled track (covers programmatic value/min/max
  // rewrites too, e.g. syncControls retargeting the speed slider).
  paintAllRanges();
}

function bindUI() {
  $('scenario').addEventListener('change', e => {
    sim.scenario = e.target.value; syncControls(); resetSim();
  });
  $('cars').addEventListener('input', e => { sim.targetCars = +e.target.value; updateLabels(); });
  $('speed').addEventListener('input', e => { sim.speedMph = +e.target.value; updateLabels(); });
  // Lane add/remove changes the road IN PLACE — never resets the running sim.
  $('lanes').addEventListener('change', e => { applyLaneCount(+e.target.value); });
  // Mix sliders affect only cars spawned afterwards (makeCar reads the current
  // sliders); existing vehicles keep the profile/truck/colour they were born
  // with, so the on-screen composition shifts gradually as the fleet turns over.
  $('trucks').addEventListener('input', e => { sim.pctTrucks = +e.target.value; updateLabels(); });
  $('pctAgg').addEventListener('input', e => { sim.pctAgg = +e.target.value; updateLabels(); });
  $('pctPas').addEventListener('input', e => { sim.pctPas = +e.target.value; updateLabels(); });
  $('meterOn').addEventListener('change', e => { sim.meterOn = e.target.checked; sim.meterTimer = 0; });
  $('meterRate').addEventListener('input', e => { sim.meterInterval = +e.target.value; updateLabels(); });
  $('mergeShape').addEventListener('change', e => { sim.mergeShape = e.target.value; resetSim(); });
  // Exit ramp toggles IN PLACE (no reset): the ramp appears/disappears and the
  // fleet adapts. On enable, cars still meaningfully upstream of the gore get
  // an immediate exit decision so the effect shows within seconds; on disable,
  // would-be exiters just drive on.
  $('exitRamp').addEventListener('change', e => {
    sim.exitRamp = e.target.checked;
    const ox = cfg().offRampCell;
    for (const car of sim.cars) {
      if (sim.exitRamp && ox !== undefined && car.cell < ox - 5 &&
          car.lane < sim.lanes) {  // accel-lane cars decide after merging
        car.exitChance = Math.min(0.9, (sim.exitPct / 100) * (0.75 + Math.random() * 0.5));
        car.exiting = Math.random() < car.exitChance;
        car.exitDecided = true;
      } else if (!sim.exitRamp) {
        car.exiting = false;
      }
    }
  });
  $('exitPct').addEventListener('input', e => { sim.exitPct = +e.target.value; updateLabels(); });
  $('incident').addEventListener('change', e => { sim.incident = e.target.checked; });
  $('cycleLen').addEventListener('input', e => { sim.cycleLen = +e.target.value; updateLabels(); });
  $('greenWave').addEventListener('change', e => { sim.greenWave = e.target.checked; });
  $('weather').addEventListener('change', e => { sim.weather = e.target.value; });

  $('btnPause').addEventListener('click', () => {
    sim.paused = !sim.paused;
    updatePauseUI();
  });
  $('btnReset').addEventListener('click', resetSim);

  // Micro-interactions shared by every range input: filled-track repaint
  // and a brief highlight of the value pill while scrubbing.
  document.querySelectorAll('input[type=range]').forEach(r => {
    r.addEventListener('input', () => { paintRange(r); flashVal(r); });
  });

  updatePauseUI();
}

export {
  updateMetrics, drawSpark, selectCar, updateInspector, setDisabled,
  paintRange, paintAllRanges, flashVal, updatePauseUI, syncControls,
  updateLabels, bindUI,
};
