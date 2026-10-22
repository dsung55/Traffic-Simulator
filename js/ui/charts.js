// Small, crisp (devicePixelRatio-aware) canvas charts for the metrics panel:
//   • time series — speed and flow as two stacked single-series panels that
//     share a time axis (never a dual-axis chart);
//   • fundamental diagram — flow vs density scatter, the core picture of
//     traffic flow theory, with the current state and the baseline marked.
import { sim, cfg } from '../state.js';
import { CHART_WINDOW } from './stats.js';

const INK = '#e9ebf2', DIM = '#969cad', FAINT = '#697084';
const GRID = 'rgba(150,164,198,.13)';
const C_SPEED = '#58a6ff', C_FLOW = '#3ddad0';
const FONT = '600 10px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
const FONT_SM = '500 9.5px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';

function prep(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;
  const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

const fmtN = v => Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '–';
function niceMax(v, steps) {
  for (const s of steps) if (v <= s) return s;
  return Math.ceil(v / steps[steps.length - 1]) * steps[steps.length - 1];
}
function fmtAgo(s) {
  s = Math.max(0, Math.round(s));
  return s < 60 ? `−${s}s` : `−${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function tooltip(g, w, h, x, y, lines) {
  g.font = FONT;
  const tw = Math.max(...lines.map(l => g.measureText(l).width)) + 14;
  const th = lines.length * 13 + 8;
  let bx = x + 10; if (bx + tw > w - 2) bx = x - tw - 10;
  let by = y - th / 2; by = Math.max(2, Math.min(h - th - 2, by));
  g.fillStyle = 'rgba(10,12,18,.92)'; g.strokeStyle = 'rgba(150,164,198,.35)'; g.lineWidth = 1;
  g.beginPath(); g.roundRect(bx, by, tw, th, 6); g.fill(); g.stroke();
  g.fillStyle = INK; g.textAlign = 'left'; g.textBaseline = 'top';
  lines.forEach((l, i) => g.fillText(l, bx + 7, by + 5 + i * 13));
}

// One single-series panel inside the time-series canvas.
function seriesPanel(g, box, rows, key, color, yMax, label, unit, base, t0, t1) {
  const { x, y, w, h } = box;
  const X = t => x + (t - t0) / (t1 - t0) * w;
  const Y = v => y + h - (Math.max(0, Math.min(yMax, v)) / yMax) * h;
  // grid: 0, ½, max
  g.strokeStyle = GRID; g.lineWidth = 1;
  g.font = FONT_SM; g.fillStyle = FAINT; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const f of [0, 0.5, 1]) {
    const yy = Math.round(Y(yMax * f)) + 0.5;
    g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke();
    g.fillText(fmtN(yMax * f), x - 4, yy);
  }
  // baseline reference
  if (Number.isFinite(base)) {
    const yy = Math.round(Y(base)) + 0.5;
    g.strokeStyle = 'rgba(233,235,242,.5)'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke(); g.setLineDash([]);
  }
  const pts = rows.filter(r => Number.isFinite(r[key]));
  if (pts.length > 1) {
    const grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, color + '40'); grad.addColorStop(1, color + '00');
    g.beginPath();
    pts.forEach((r, i) => (i ? g.lineTo : g.moveTo).call(g, X(r.t), Y(r[key])));
    g.lineTo(X(pts[pts.length - 1].t), y + h); g.lineTo(X(pts[0].t), y + h); g.closePath();
    g.fillStyle = grad; g.fill();
    g.beginPath();
    pts.forEach((r, i) => (i ? g.lineTo : g.moveTo).call(g, X(r.t), Y(r[key])));
    g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round'; g.stroke();
    const L = pts[pts.length - 1];
    g.fillStyle = color; g.beginPath(); g.arc(X(L.t), Y(L[key]), 3, 0, 7); g.fill();
  }
  // title (ink) + current value; the colored line itself carries identity
  g.textBaseline = 'alphabetic';
  g.font = FONT; g.fillStyle = DIM; g.textAlign = 'left';
  g.fillText(label, x + 2, y - 6);
  const last = pts.length ? pts[pts.length - 1][key] : NaN;
  g.fillStyle = INK; g.textAlign = 'right';
  g.fillText(`${fmtN(last)} ${unit}`, x + w, y - 6);
  return { X, Y };
}

export function drawTimeSeries(cv, rows, baseline, hover) {
  const c = prep(cv);
  if (!c) return;
  const { g, w, h } = c;
  // Window grows from 1 min up to CHART_WINDOW so a fresh run fills the plot.
  const span = Math.max(60, Math.min(CHART_WINDOW, Math.ceil(sim.time / 30) * 30));
  const t1 = Math.max(sim.time, span), t0 = t1 - span;
  const vis = rows.filter(r => r.t >= t0);
  const padL = 34, padR = 6, gap = 22, top = 16, bottom = 14;
  const ph = (h - top - bottom - gap) / 2;
  const limit = Math.max(sim.speedMph || 0, ...vis.map(r => r.avgSpeedMph).filter(Number.isFinite));
  const sMax = niceMax(limit * 1.05, [30, 40, 50, 60, 70, 80, 90]);
  const fPeak = Math.max(1200, ...vis.map(r => r.flowVphPerLane).filter(Number.isFinite));
  const fMax = niceMax(fPeak * 1.05, [1200, 1600, 2000, 2400, 3000]);
  const b1 = { x: padL, y: top, w: w - padL - padR, h: ph };
  const b2 = { x: padL, y: top + ph + gap, w: w - padL - padR, h: ph };
  const s1 = seriesPanel(g, b1, vis, 'avgSpeedMph', C_SPEED, sMax, 'Avg speed', 'mph', baseline?.avgSpeedMph, t0, t1);
  seriesPanel(g, b2, vis, 'flowVphPerLane', C_FLOW, fMax, 'Flow', 'veh/h/ln', baseline?.flowVphPerLane, t0, t1);
  // time axis labels
  g.font = FONT_SM; g.fillStyle = FAINT; g.textBaseline = 'alphabetic';
  g.textAlign = 'left'; g.fillText(span < 120 ? `−${span} s` : `−${(span / 60).toFixed(span % 60 ? 1 : 0)} min`, padL, h - 2);
  g.textAlign = 'right'; g.fillText('now', w - padR, h - 2);
  if (!vis.length) {
    g.textAlign = 'center'; g.fillStyle = FAINT; g.font = FONT;
    g.fillText('Collecting data…', padL + b1.w / 2, top + ph / 2 + 4);
  }
  // hover crosshair + readout
  if (hover && vis.length) {
    let best = null, bd = Infinity;
    for (const r of vis) { const d = Math.abs(s1.X(r.t) - hover.x); if (d < bd) { bd = d; best = r; } }
    if (best && bd < 30) {
      const xx = Math.round(s1.X(best.t)) + 0.5;
      g.strokeStyle = 'rgba(233,235,242,.45)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(xx, top); g.lineTo(xx, h - bottom); g.stroke();
      tooltip(g, w, h, xx, hover.y, [
        fmtAgo(sim.time - best.t),
        `${best.avgSpeedMph.toFixed(1)} mph`,
        `${fmtN(best.flowVphPerLane)} veh/h/ln`,
      ]);
    }
  }
}

export function drawFD(cv, rows, baseline, hover) {
  const c = prep(cv);
  if (!c) return;
  const { g, w, h } = c;
  const padL = 34, padR = 8, top = 16, bottom = 16;
  const pts = rows.filter(r => Number.isFinite(r.densityVpmPerLane) && Number.isFinite(r.flowVphPerLane));
  const kMax = niceMax(Math.max(40, ...pts.map(r => r.densityVpmPerLane)) * 1.1, [40, 60, 80, 100, 120, 160]);
  const qFloor = cfg().lightCells ? 1600 : 2400;   // freeway: keep headroom above the capacity line
  const qMax = niceMax(Math.max(qFloor, ...pts.map(r => r.flowVphPerLane * 1.08)), [1600, 2000, 2400, 3000]);
  const pw = w - padL - padR, ph = h - top - bottom;
  const X = k => padL + k / kMax * pw, Y = q => top + ph - q / qMax * ph;

  g.strokeStyle = GRID; g.lineWidth = 1; g.font = FONT_SM; g.fillStyle = FAINT;
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const f of [0, 0.5, 1]) {
    const yy = Math.round(Y(qMax * f)) + 0.5;
    g.beginPath(); g.moveTo(padL, yy); g.lineTo(w - padR, yy); g.stroke();
    g.fillText(fmtN(qMax * f), padL - 4, yy);
  }
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.textAlign = 'left'; g.fillText('0', padL, h - 2);
  g.textAlign = 'right'; g.fillText(fmtN(kMax), w - padR, h - 2);
  g.textAlign = 'center'; g.fillText('density, veh/mi/ln →', padL + pw / 2, h - 2);

  // freeway capacity reference
  if (!cfg().lightCells) {
    const yy = Math.round(Y(2000)) + 0.5;
    if (yy > top) {
      g.strokeStyle = 'rgba(240,194,75,.35)'; g.setLineDash([4, 3]);
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(w - padR, yy); g.stroke(); g.setLineDash([]);
      g.fillStyle = 'rgba(240,194,75,.8)'; g.textAlign = 'left'; g.font = FONT_SM;
      g.fillText('~lane capacity', padL + 4, yy - 3);
    }
  }
  // points, older = fainter
  const n = pts.length;
  pts.forEach((r, i) => {
    const a = 0.12 + 0.6 * (i / Math.max(1, n - 1));
    g.fillStyle = `rgba(88,166,255,${a.toFixed(3)})`;
    g.beginPath(); g.arc(X(r.densityVpmPerLane), Y(r.flowVphPerLane), 2.2, 0, 7); g.fill();
  });
  if (baseline && Number.isFinite(baseline.densityVpmPerLane) && Number.isFinite(baseline.flowVphPerLane)) {
    g.strokeStyle = 'rgba(233,235,242,.8)'; g.lineWidth = 1.5; g.setLineDash([2, 2]);
    g.beginPath(); g.arc(X(baseline.densityVpmPerLane), Y(baseline.flowVphPerLane), 5.5, 0, 7); g.stroke();
    g.setLineDash([]);
  }
  if (n) {
    const L = pts[n - 1];
    g.fillStyle = '#0c0e13'; g.beginPath(); g.arc(X(L.densityVpmPerLane), Y(L.flowVphPerLane), 5, 0, 7); g.fill();
    g.fillStyle = C_SPEED; g.beginPath(); g.arc(X(L.densityVpmPerLane), Y(L.flowVphPerLane), 3.6, 0, 7); g.fill();
  }
  g.font = FONT; g.fillStyle = DIM; g.textAlign = 'left';
  g.fillText('Flow vs density', padL + 2, top - 5);
  g.fillStyle = FAINT; g.font = FONT_SM; g.textAlign = 'right';
  if (w >= 230) g.fillText('flow, veh/h/ln', w - padR, top - 5);
  if (!n) {
    g.textAlign = 'center'; g.fillStyle = FAINT; g.font = FONT;
    g.fillText('Collecting data…', padL + pw / 2, top + ph / 2);
  }
  if (hover && n) {
    let best = null, bd = 14 * 14;
    for (const r of pts) {
      const d = (X(r.densityVpmPerLane) - hover.x) ** 2 + (Y(r.flowVphPerLane) - hover.y) ** 2;
      if (d < bd) { bd = d; best = r; }
    }
    if (best) {
      const bx = X(best.densityVpmPerLane), by = Y(best.flowVphPerLane);
      g.strokeStyle = INK; g.lineWidth = 1.5;
      g.beginPath(); g.arc(bx, by, 4.5, 0, 7); g.stroke();
      tooltip(g, w, h, bx, by, [
        `${best.densityVpmPerLane.toFixed(0)} veh/mi/ln`,
        `${fmtN(best.flowVphPerLane)} veh/h/ln`,
        `${best.avgSpeedMph.toFixed(0)} mph · ${fmtAgo(sim.time - best.t)}`,
      ]);
    }
  }
}
