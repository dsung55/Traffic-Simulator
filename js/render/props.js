// Dynamic world-space props drawn every frame: congestion heat tint, ramp
// queue + meter, the incident scene (wrecks, cones, flares, emergency
// vehicles), VSL gantry, roadside regulatory signs, city signal lamps and the
// decorative cross-street / overpass traffic.
import { N, INCIDENT_CELL, CAR_LEN } from '../config.js';
import { sim, cfg, vmaxFloat } from '../state.js';
import { lightState, lightPhases, lightOffset } from '../engine.js';
import { view, cam, tickMs } from './view.js';
import { geo } from './geometry.js';
import { rr, hash01, lutAt, speedColor, clamp } from './util.js';
import {
  drawVehicle, paintVehicle, bodyWidth, drawLamps, drawLightbar, glow,
  GLOW_AMBER, GLOW_RED, GLOW_WHITE,
} from './vehicles.js';
import { signGantry, signalHeads, weatherKind } from './scene.js';

const lit = () => sim.weather !== 'clear';           // headlights on in bad weather

//──────────────────────── Congestion heat tint ────────────────────────
const MAXL = 8;
const hSum = new Float32Array(MAXL * N), hCnt = new Uint16Array(MAXL * N);
export function drawHeatmap(ctx) {
  const G = geo(), c = G.c, LH = G.LH;
  const rows = sim.lanes + (cfg().hasRamp ? 1 : 0);
  hSum.fill(0); hCnt.fill(0);
  const vmax = Math.max(0.5, vmaxFloat());
  for (const car of sim.cars) {
    const l = clamp(Math.round(car.laneCoord ?? car.lane), 0, rows - 1);
    const i = clamp(Math.floor(car.cell + (car.len || CAR_LEN) / 2), 0, N - 1);
    hSum[l * N + i] += clamp(car.v / vmax, 0, 1); hCnt[l * N + i]++;
  }
  ctx.save();
  for (let l = 0; l < rows; l++) {
    const y = G.top + l * LH;
    const gr = ctx.createLinearGradient(0, 0, view.W, 0);
    let any = false, last = 1;
    for (let i = 0; i < N; i++) {
      // nearest-data blend within ±3 cells so the tint reads as a band
      let s = 0, w = 0;
      for (let k = -3; k <= 3; k++) {
        const j = i + k;
        if (j < 0 || j >= N || !hCnt[l * N + j]) continue;
        const wt = 1 / (1 + Math.abs(k));
        s += (hSum[l * N + j] / hCnt[l * N + j]) * wt; w += wt;
      }
      const stop = (i + 0.5) / N;
      if (w) { last = s / w; gr.addColorStop(stop, speedColor(last, 0.42)); any = true; }
      else gr.addColorStop(stop, speedColor(last, 0));
    }
    if (!any) continue;
    ctx.fillStyle = gr;
    ctx.fillRect(0, y + LH * 0.06, view.W, LH * 0.88);
  }
  ctx.restore();
}

//──────────────────────── Ramp queue + meter ────────────────────────
let lastQueue = 0, qShift = 0, released = 0;
const QSPEC = [];
function queueSpec(n) {
  const r = hash01(n, 3), r2 = hash01(n, 5);
  const kinds = ['sedan', 'sedan', 'hatch', 'suv', 'suv', 'pickup', 'van'];
  const paint = r2 < 0.55 ? { h: 210, s: 4, l: 18 + r2 * 120 } : { h: r * 360, s: 30 + r2 * 40, l: 34 + r * 30 };
  return { kind: kinds[Math.floor(r * kinds.length)], paint, av: false };
}
export function rampMeterS() { const G = geo(); return G.onLUT.len - G.LH * 1.2; }

export function drawRampQueue(ctx) {
  const G = geo();
  if (!cfg().hasRamp) return;
  if (sim.rampQueue < lastQueue) { qShift = Math.min(1, qShift + (lastQueue - sim.rampQueue)); released += lastQueue - sim.rampQueue; }
  lastQueue = sim.rampQueue;
  if (qShift > 0 && !sim.paused) {
    qShift *= Math.exp(-view.frameDt / (tickMs() * 1.2));
    if (qShift < 0.01) qShift = 0;
  }
  const c = G.c, len = CAR_LEN * c, slot = len * 1.18;
  const sM = rampMeterS();
  const fit = Math.max(0, Math.floor((sM - len * 0.5) / slot));
  const q = Math.min(sim.rampQueue, fit);
  for (let i = q - 1; i >= 0; i--) {
    const s = sM - slot * (i + 0.5) + slot * qShift - len * 0.1;
    const p = lutAt(G.onLUT, s);
    const n = released + i;
    if (!QSPEC[n % 64] || QSPEC[n % 64].n !== n) QSPEC[n % 64] = Object.assign(queueSpec(n), { n });
    const spec = QSPEC[n % 64];
    const h = bodyWidth(spec.kind, len);
    drawVehicle(ctx, spec, p.x, p.y, len, h, p.a);
    // brake lights on while queued
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
    drawLamps(ctx, len, h, 0.85, 0, lit() ? 1 : 0, false);
    ctx.restore();
  }
  if (sim.rampQueue > q) {
    const p = lutAt(G.onLUT, 0);
    badge(ctx, p.x + G.LH * 0.2, p.y + G.LH * 0.9, '+' + (sim.rampQueue - q));
  }
  if (sim.meterOn) {
    const green = sim.meterTimer >= sim.meterInterval - 1;
    const p = lutAt(G.onLUT, sM);
    const LH = G.LH;
    // stop bar across the ramp at the meter
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a);
    ctx.fillStyle = '#eef0f2'; ctx.fillRect(LH * 0.05, -LH * 0.42, Math.max(1, LH * 0.09), LH * 0.84);
    ctx.restore();
    // two-lamp head on a post at the ramp's outer edge
    const mx = p.x - LH * 0.2, my = p.y + LH * 0.75;
    ctx.fillStyle = 'rgba(0,0,0,.3)'; rr(ctx, mx + LH * 0.12, my + LH * 0.1, LH * 0.3, LH * 0.62, LH * 0.06);
    ctx.fillStyle = '#16181d'; rr(ctx, mx, my, LH * 0.3, LH * 0.62, LH * 0.06);
    const rl = LH * 0.1;
    ctx.fillStyle = green ? '#3a1714' : '#ff4a3d';
    ctx.beginPath(); ctx.arc(mx + LH * 0.15, my + LH * 0.17, rl, 0, 7); ctx.fill();
    ctx.fillStyle = green ? '#3ff07f' : '#13361f';
    ctx.beginPath(); ctx.arc(mx + LH * 0.15, my + LH * 0.45, rl, 0, 7); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    glow(ctx, green ? 'rgba(60,240,120,A)' : GLOW_RED, mx + LH * 0.15, my + LH * (green ? 0.45 : 0.17), LH * 0.45);
    ctx.globalCompositeOperation = 'source-over';
  }
}

function badge(ctx, x, y, text) {
  ctx.save();
  ctx.translate(x, y); ctx.scale(1 / cam.z, 1 / cam.z);
  ctx.font = '600 11px system-ui, sans-serif';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(14,17,24,.8)'; rr(ctx, -w / 2, -9, w, 17, 8);
  ctx.fillStyle = '#e8ecf3'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

//──────────────────────── Incident ────────────────────────
// Blocked lanes: sim.lanes-1 down to sim.lanes-incidentLanes at INCIDENT_CELL.
function blockedLanes() {
  const k = clamp(Math.round(sim.incidentLanes || 1), 1, Math.max(1, sim.lanes - 1));
  const out = [];
  for (let l = sim.lanes - 1; l >= sim.lanes - k; l--) out.push(l);
  return out;
}
const WRECKS = [
  { kind: 'sedan', paint: { h: 352, s: 60, l: 42 }, av: false },
  { kind: 'suv', paint: { h: 210, s: 8, l: 70 }, av: false },
  { kind: 'pickup', paint: { h: 205, s: 40, l: 34 }, av: false },
  { kind: 'hatch', paint: { h: 45, s: 70, l: 55 }, av: false },
];
export function incidentActive() { return sim.incident && cfg().hasIncident; }

// Ground-level incident scene (before live traffic).
export function drawIncidentGround(ctx) {
  if (!incidentActive()) return;
  const G = geo(), c = G.c, LH = G.LH, t = view.nowMs;
  const ix = INCIDENT_CELL * c;
  const lanes = blockedLanes();
  const yTop = G.top + Math.min(...lanes) * LH, yBot = G.top + (Math.max(...lanes) + 1) * LH;
  // skid marks leading into the crash
  ctx.strokeStyle = 'rgba(10,10,12,.45)'; ctx.lineWidth = Math.max(0.8, LH * 0.07);
  ctx.beginPath();
  for (const l of lanes) {
    const yc = G.top + l * LH + LH / 2;
    ctx.moveTo(ix - c * 2.4, yc - LH * 0.16); ctx.bezierCurveTo(ix - c * 1.2, yc - LH * 0.18, ix - c * 0.2, yc - LH * 0.3, ix + c * 0.5, yc - LH * 0.06);
    ctx.moveTo(ix - c * 2.4, yc + LH * 0.16); ctx.bezierCurveTo(ix - c * 1.2, yc + LH * 0.14, ix - c * 0.2, yc + LH * 0.02, ix + c * 0.5, yc + LH * 0.24);
  }
  ctx.stroke();
  // debris field + fluid spill
  ctx.fillStyle = 'rgba(25,20,15,.16)';
  ctx.beginPath(); ctx.ellipse(ix + c * 1.2, (yTop + yBot) / 2 + LH * 0.1, c * 0.9, LH * 0.28 * lanes.length, 0.3, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(ix + c * 1.9, (yTop + yBot) / 2 + LH * 0.25, c * 0.6, LH * 0.18 * lanes.length, -0.2, 0, 7); ctx.fill();
  for (let k = 0; k < 22; k++) {
    const dx = (hash01(k, 41) - 0.3) * c * 3.2, dy = hash01(k, 43) * (yBot - yTop);
    ctx.fillStyle = k % 3 ? 'rgba(200,210,220,.7)' : 'rgba(40,40,44,.8)';
    ctx.fillRect(ix + dx, yTop + dy, Math.max(0.6, LH * 0.06), Math.max(0.6, LH * 0.04));
  }
  // wrecks: one per blocked lane, yawed and nose-to-tail
  lanes.forEach((l, j) => {
    const spec = WRECKS[j % WRECKS.length];
    const len = CAR_LEN * c, h = bodyWidth(spec.kind, len);
    const yc = G.top + l * LH + LH / 2 + (j % 2 ? -1 : 1) * LH * 0.08;
    const x = ix + c * (0.9 + (j % 2) * 0.9);
    const rot = (j % 2 ? -0.5 : 0.62);
    ctx.save(); ctx.translate(x, yc); ctx.rotate(rot);
    paintVehicle(ctx, spec, len, h, len * cam.z * view.dpr);
    // crumpled front + shattered glass
    ctx.fillStyle = 'rgba(30,30,34,.55)';
    ctx.beginPath();
    ctx.moveTo(len * 0.5, -h * 0.5); ctx.lineTo(len * 0.36, -h * 0.3); ctx.lineTo(len * 0.42, -h * 0.05);
    ctx.lineTo(len * 0.33, h * 0.2); ctx.lineTo(len * 0.44, h * 0.5); ctx.lineTo(len * 0.5, h * 0.5); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(230,240,250,.6)'; ctx.lineWidth = Math.max(0.3, h * 0.03);
    ctx.beginPath(); ctx.moveTo(len * 0.18, -h * 0.25); ctx.lineTo(len * 0.25, 0); ctx.lineTo(len * 0.17, h * 0.2); ctx.stroke();
    ctx.restore();
    lanes.wreckPos = lanes.wreckPos || [];
    lanes.wreckPos.push({ x, yc, rot, len, h });
  });
  // cone taper across the blocked lanes (upstream edge of the closure)
  const n = Math.max(3, lanes.length * 3);
  for (let k = 0; k <= n; k++) {
    const f = k / n;
    const x = ix - c * 0.15 + f * c * 0.5;
    const y = yBot - LH * 0.12 - f * (yBot - yTop - LH * 0.12) + (k === n ? -LH * 0.02 : 0);
    cone(ctx, x, y, LH);
  }
  // cones along the open-lane edge of the closure
  for (let k = 1; k < 5; k++) cone(ctx, ix + c * (0.35 + k * 0.75), yTop + LH * 0.06, LH);
  // burning flares upstream: flicker
  for (let k = 0; k < 3; k++) {
    const fx = ix - c * (0.8 + k * 0.85), fy = yBot - LH * 0.18 - k * LH * 0.12;
    const fl = 0.7 + 0.3 * Math.sin(t / 47 + k * 2.1) * Math.sin(t / 113 + k);
    ctx.fillStyle = '#ffdb8a'; ctx.fillRect(fx - LH * 0.03, fy - LH * 0.03, LH * 0.06, LH * 0.06);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.65 * fl;
    glow(ctx, 'rgba(255,90,40,A)', fx, fy, LH * 0.6 * fl);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  incidentCache = { lanes, ix, yTop, yBot };
}
let incidentCache = null;
function cone(ctx, x, y, LH) {
  const r = Math.max(0.7, LH * 0.065);
  ctx.fillStyle = 'rgba(0,0,0,.3)';
  ctx.beginPath(); ctx.arc(x + r * 0.5, y + r * 0.5, r * 1.15, 0, 7); ctx.fill();
  ctx.fillStyle = '#e8590c';
  ctx.fillRect(x - r * 1.1, y - r * 1.1, r * 2.2, r * 2.2);    // square base
  ctx.fillStyle = '#ff7a1a';
  ctx.beginPath(); ctx.arc(x, y, r * 0.85, 0, 7); ctx.fill();
  ctx.strokeStyle = '#f5f7fa'; ctx.lineWidth = r * 0.35;
  ctx.beginPath(); ctx.arc(x, y, r * 0.5, 0, 7); ctx.stroke();
  ctx.fillStyle = '#ff9a40';
  ctx.beginPath(); ctx.arc(x, y, r * 0.2, 0, 7); ctx.fill();
}

// Emergency vehicles + strobes (above the live traffic). They park in the
// closed lanes just downstream of the wrecks, and on the shoulder.
export function drawIncidentResponders(ctx) {
  if (!incidentActive() || !incidentCache) return;
  const G = geo(), c = G.c, LH = G.LH, t = view.nowMs;
  const { lanes, ix } = incidentCache;
  const resp = [];
  const lowLane = Math.max(...lanes);
  // police cruiser angled across the lowest blocked lane, behind the wrecks
  resp.push({ kind: 'police', x: ix + c * 3.3, y: G.top + lowLane * LH + LH / 2, rot: -0.3, len: CAR_LEN * c * 1.02 });
  // fire engine on the closure when 2+ lanes are blocked, ambulance on the shoulder
  if (lanes.length >= 2) {
    const l2 = Math.min(...lanes);
    resp.push({ kind: 'fire', x: ix + c * 4.6, y: G.top + l2 * LH + LH / 2 + LH * 0.1, rot: 0.05, len: 3.3 * c });
  }
  resp.push({ kind: 'ambulance', x: ix + c * 5.4, y: G.ry + G.outerSh * 0.55, rot: 0, len: 1.9 * c });
  for (const r of resp) {
    const h = bodyWidth(r.kind, r.len);
    ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(r.rot);
    paintVehicle(ctx, { kind: r.kind }, r.len, h, r.len * cam.z * view.dpr);
    drawLightbar(ctx, r.len, h, t + r.x * 7, r.kind, true);
    ctx.globalCompositeOperation = 'lighter';
    drawLightbar(ctx, r.len, h, t + r.x * 7, r.kind);
    drawLamps(ctx, r.len, h, 0, 0, 0, Math.floor(t / 380) % 2 === 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }
  // hazard flashers on the wrecks
  const on = Math.floor(t / 420) % 2 === 0;
  if (on && lanes.wreckPos) {
    ctx.globalCompositeOperation = 'lighter';
    for (const w of lanes.wreckPos) {
      ctx.save(); ctx.translate(w.x, w.yc); ctx.rotate(w.rot);
      drawLamps(ctx, w.len, w.h, 0, 0, 0, true);
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

//──────────────────────── Regulatory signs, VSL gantry ────────────────────────
function vslActive() { return !!(sim.vslZone && sim.vslOn !== false && Number.isFinite(sim.vslZone.start)); }

export function drawRoadSigns(ctx) {
  const G = geo(), c = G.c, LH = G.LH;
  if (cfg().style === 'city') {
    speedSign(ctx, c * 6, G.curbBot + G.walkW * 0.75, LH, sim.speedMph);
    return;
  }
  // posted limit on the right shoulder near the entry
  speedSign(ctx, Math.max(36 * c, G.reX + G.taper + c * 1.5), G.ay + G.outerSh + LH * 0.95, LH, sim.speedMph);
  if (sim.truckLaneRestriction) {
    for (const cell of [9.5, 47]) truckSign(ctx, cell * c, G.barrierY - LH * 0.62, LH);
  }
  if (vslActive()) {
    const z = sim.vslZone;
    const gx = clamp(z.start, 1, N - 2) * c;
    const mph = Math.round((Number.isFinite(sim.vslMph) ? sim.vslMph : sim.speedMph) / 5) * 5;
    const reduced = mph < sim.speedMph - 0.1;
    signGantry(ctx, G, gx, (g, sx, sy, sw, sh, lane) => {
      // LED variable-message panel: black face, ring + digits
      g.fillStyle = '#0d0f12'; rr(g, sx, sy, sw, sh, sh * 0.1);
      g.strokeStyle = '#5b6068'; g.lineWidth = Math.max(0.4, sh * 0.05); g.strokeRect(sx, sy, sw, sh);
      const cx = sx + sw * 0.32, cy = sy + sh / 2, r = sh * 0.38;
      if (sim.truckLaneRestriction && lane === 0) {
        truckIcon(g, sx + sw * 0.32, cy, sh * 0.62, '#ffd36b', true);
      } else {
        g.strokeStyle = reduced ? '#ff3b30' : '#f1f1f1'; g.lineWidth = r * 0.22;
        g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke();
        g.fillStyle = reduced ? '#ffcf4a' : '#f4f4f4';
        g.font = `700 ${(r * 1.05).toFixed(1)}px system-ui, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(mph), cx, cy + r * 0.05);
      }
      g.fillStyle = reduced ? '#ffcf4a' : '#9aa0a8';
      g.font = `700 ${(sh * 0.22).toFixed(1)}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(reduced ? 'SLOW' : 'MPH', sx + sw * 0.76, cy);
      g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      if (reduced) {
        g.globalCompositeOperation = 'lighter';
        glow(g, 'rgba(255,190,60,A)', cx, cy, r * 1.8);
        g.globalCompositeOperation = 'source-over';
      }
    }, -1, Math.max(LH * 1.7, c * 2.6));
    // end-of-zone marker on the shoulder
    if (Number.isFinite(z.end)) {
      const ex = clamp(z.end, 1, N - 1) * c;
      const y = G.ay + G.outerSh + LH * 0.75;
      postSign(ctx, ex, y, LH * 1.4, LH * 0.7, (g, x, yy, w, h) => {
        g.fillStyle = '#f4f4f2'; rr(g, x, yy, w, h, h * 0.1);
        g.fillStyle = '#16181c';
        g.font = `700 ${(h * 0.42).toFixed(1)}px system-ui, sans-serif`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('END VSL', x + w / 2, yy + h / 2);
        g.textAlign = 'left'; g.textBaseline = 'alphabetic';
      });
    }
  }
}

function postSign(ctx, x, y, w, h, paint) {
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(x - w / 2 + h * 0.25, y - h / 2 + h * 0.2, w, h);
  ctx.fillStyle = '#6a6f77'; ctx.fillRect(x - h * 0.05, y + h / 2, h * 0.1, h * 0.25);
  paint(ctx, x - w / 2, y - h / 2, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = Math.max(0.3, h * 0.04);
  ctx.strokeRect(x - w / 2, y - h / 2, w, h);
}
function speedSign(ctx, x, y, LH, mph) {
  const w = LH * 0.82, h = LH * 1.02;
  postSign(ctx, x, y, w, h, (g, sx, sy) => {
    g.fillStyle = '#f7f7f5'; rr(g, sx, sy, w, h, w * 0.08);
    g.strokeStyle = '#111'; g.lineWidth = Math.max(0.3, w * 0.04);
    g.strokeRect(sx + w * 0.07, sy + w * 0.07, w - w * 0.14, h - w * 0.14);
    g.fillStyle = '#111';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${(h * 0.14).toFixed(1)}px system-ui, sans-serif`;
    g.fillText('SPEED', sx + w / 2, sy + h * 0.2);
    g.fillText('LIMIT', sx + w / 2, sy + h * 0.36);
    g.font = `800 ${(h * 0.38).toFixed(1)}px system-ui, sans-serif`;
    g.fillText(String(Math.round(mph)), sx + w / 2, sy + h * 0.68);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  });
}
function truckIcon(g, cx, cy, s, col, slash) {
  g.fillStyle = col;
  g.fillRect(cx - s * 0.42, cy - s * 0.2, s * 0.55, s * 0.36);      // box
  g.fillRect(cx + s * 0.15, cy - s * 0.08, s * 0.24, s * 0.24);      // cab
  g.beginPath(); g.arc(cx - s * 0.28, cy + s * 0.2, s * 0.08, 0, 7); g.arc(cx + s * 0.26, cy + s * 0.2, s * 0.08, 0, 7); g.fill();
  if (slash) {
    g.strokeStyle = '#ff3b30'; g.lineWidth = s * 0.1;
    g.beginPath(); g.arc(cx, cy, s * 0.5, 0, 7); g.stroke();
    g.beginPath(); g.moveTo(cx - s * 0.35, cy - s * 0.35); g.lineTo(cx + s * 0.35, cy + s * 0.35); g.stroke();
  }
}
function truckSign(ctx, x, y, LH) {
  const w = LH * 1.15, h = LH * 1.0;
  postSign(ctx, x, y, w, h, (g, sx, sy) => {
    g.fillStyle = '#f7f7f5'; rr(g, sx, sy, w, h, w * 0.06);
    truckIcon(g, sx + w / 2, sy + h * 0.4, h * 0.6, '#16181c', true);
    g.fillStyle = '#16181c';
    g.font = `700 ${(h * 0.16).toFixed(1)}px system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('LEFT LANE', sx + w / 2, sy + h * 0.86);
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  });
}

//──────────────────────── City: signal lamps + cross-street traffic ────────────────────────
const LAMP = { red: 0, yellow: 1, green: 2 };
const LAMP_COL = ['#ff4b3e', '#ffcf3a', '#3ff07f'];
const LAMP_GLOW = ['rgba(255,70,50,A)', 'rgba(255,200,50,A)', 'rgba(60,240,120,A)'];

// Cross-street state from the arterial's phase: cross traffic is green only
// while the arterial is red, after a 2 s all-red clearance and ending 1 s early.
function crossState(i) {
  let ph;
  try { ph = lightPhases(); } catch { return 'red'; }
  const cyc = sim.cycleLen || (ph.green + ph.yellow + ph.red);
  let off = 0;
  try { off = lightOffset(i); } catch { /* ignore */ }
  const t = ((sim.time - off) % cyc + cyc) % cyc;
  const rs = ph.green + ph.yellow;
  if (t >= rs + 2 && t < cyc - 4) return 'green';
  if (t >= cyc - 4 && t < cyc - 1) return 'yellow';
  return 'red';
}

export function drawSignals(ctx) {
  if (cfg().style !== 'city') return;
  const G = geo();
  ctx.globalCompositeOperation = 'source-over';
  G.inters.forEach((it, i) => {
    const st = lightState(i), cs = crossState(i);
    for (const hp of signalHeads(G, it)) {
      const k = LAMP[hp.cross ? cs : st];
      const lx = hp.x + hp.w / 2, ly = hp.y + hp.h * (k + 0.5) / 3;
      ctx.fillStyle = LAMP_COL[k];
      ctx.beginPath(); ctx.arc(lx, ly, hp.w * 0.32, 0, 7); ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      glow(ctx, LAMP_GLOW[k], lx, ly, hp.w * 1.6);
      ctx.globalCompositeOperation = 'source-over';
    }
  });
}

// Decorative cross-street traffic: a tiny follow-the-leader model per
// approach that stops at its own stop line when the cross signal is red.
const xTraffic = new Map();
let xSig = '';
export function drawCrossTraffic(ctx) {
  if (cfg().style !== 'city') return;
  const G = geo(), c = G.c, LH = G.LH, H = view.H;
  const s = view.W + '|' + H + '|' + sim.lanes;
  if (s !== xSig) { xSig = s; xTraffic.clear(); }
  const dt = sim.paused ? 0 : (view.frameDt / tickMs());      // sim seconds this frame
  const len = 1.35 * c, vMax = 2.0 * c, acc = 0.6 * c;
  G.inters.forEach((it, i) => {
    const cs = crossState(i);
    for (const dir of [1, -1]) {                               // +1 southbound (down), −1 northbound
      const key = i + ':' + dir;
      let lane = xTraffic.get(key);
      if (!lane) { lane = { cars: [], spawnT: hash01(i * 7 + dir, 9) * 4, n: 0 }; xTraffic.set(key, lane); }
      const x = dir > 0 ? it.sx0 + G.csW * 0.27 : it.sx0 + G.csW * 0.73;
      const stopY = dir > 0 ? G.walkTop - LH * 0.25 : G.walkBot + LH * 0.25;   // front-bumper stop
      // spawn from the screen edge
      lane.spawnT -= dt;
      const last = lane.cars[lane.cars.length - 1];
      if (lane.spawnT <= 0 && (!last || (dir > 0 ? last.y - len > -len * 0.5 : last.y + len < H + len * 0.5))) {
        lane.cars.push({ y: dir > 0 ? -len : H + len, v: vMax * 0.8, n: lane.n++ });
        lane.spawnT = 3 + hash01(lane.n, i + 31) * 6;
      }
      for (let k = 0; k < lane.cars.length; k++) {
        const car = lane.cars[k], lead = lane.cars[k - 1];
        let gap = Infinity;
        if (lead) gap = Math.abs(lead.y - car.y) - len * 1.2;
        const front = car.y + dir * len / 2;
        const toStop = (stopY - front) * dir;
        if (cs !== 'green' && toStop > -len * 0.2) gap = Math.min(gap, toStop);
        const target = gap < 0.1 ? 0 : Math.min(vMax, Math.sqrt(Math.max(0, gap) * 2 * acc));
        car.v += clamp(target - car.v, -acc * 3 * dt, acc * dt);
        car.v = Math.max(0, car.v);
        car.y += dir * car.v * dt;
        car.braking = target < car.v - 0.01 || car.v < 0.05;
      }
      lane.cars = lane.cars.filter(cr => (dir > 0 ? cr.y < H + len * 2 : cr.y > -len * 2));
      for (const car of lane.cars) {
        if (!car.spec) {
          const r = hash01(car.n, i * 3 + dir + 50);
          const kinds = ['sedan', 'sedan', 'suv', 'hatch', 'pickup', 'van'];
          car.spec = {
            kind: kinds[Math.floor(r * kinds.length)], av: false,
            paint: hash01(car.n, i + 77) < 0.5 ? { h: 210, s: 3, l: 18 + r * 70 } : { h: r * 360, s: 35 + r * 30, l: 35 + r * 25 },
          };
        }
        const h = bodyWidth(car.spec.kind, len), rot = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
        drawVehicle(ctx, car.spec, x, car.y, len, h, rot);
        ctx.save(); ctx.translate(x, car.y); ctx.rotate(rot);
        drawLamps(ctx, len, h, car.braking ? 1 : 0, 0, lit() ? 1 : 0, false);
        ctx.restore();
      }
    }
  });
}

// Light decorative traffic over the highway overpasses (drawn above the deck).
export function drawOverpassTraffic(ctx) {
  if (cfg().style === 'city') return;
  const G = geo(), c = G.c, H = view.H;
  const t = sim.time + (sim.paused ? 0 : clamp((view.nowMs - sim.lastTickWall) / tickMs(), 0, 1));
  const len = 1.35 * c, v = 2.4 * c;
  G.crossX.forEach((cx, i) => {
    for (const dir of [1, -1]) {
      const x = cx + dir * -G.crossW * 0.24;
      const period = (H + len * 4) / v * 1.0;
      for (let k = 0; k < 2; k++) {
        const ph = ((t + k * period * 0.5 + i * 13 + (dir > 0 ? 0 : 7)) % period) / period;
        const y = dir > 0 ? -len * 2 + ph * (H + len * 4) : H + len * 2 - ph * (H + len * 4);
        const n = Math.floor((t + k * period * 0.5 + i * 13 + (dir > 0 ? 0 : 7)) / period) * 2 + k + i * 100 + (dir > 0 ? 0 : 50);
        const r = hash01(n, 17);
        const kinds = ['sedan', 'suv', 'hatch', 'pickup', 'van', 'box'];
        const kind = kinds[Math.floor(r * kinds.length)];
        const spec = { kind, av: false,
          paint: r < 0.5 ? { h: 210, s: 3, l: 20 + r * 140 } : { h: r * 720 % 360, s: 40, l: 42 },
          cab: { h: 216, s: 50, l: 40 }, trailer: { h: 40, s: 6, l: 94 } };
        const L = kind === 'box' ? len * 1.7 : len;
        drawVehicle(ctx, spec, x, y, L, bodyWidth(kind, L), dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      }
    }
  });
}

export { GLOW_AMBER, GLOW_WHITE, weatherKind };
