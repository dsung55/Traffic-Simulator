// Renderer entry point: canvas + camera, the per-frame draw orchestration,
// vehicle interpolation, the overview minimap and pointer input.
//
// Layering (world space, under the camera transform):
//   1. static GROUND layer (terrain, roads, markings, rails)   — cached
//   2. congestion heat tint (optional, sim.showHeatmap)
//   3. ground props: incident wrecks/cones, ramp queue, cross traffic
//   4. headlight beams / wet-road light streaks (additive)
//   5. vehicle bodies (cached sprites), then live lamps (additive)
//   6. static TOP layer (overpasses, poles, tree canopies, mast arms) — cached
//   7. overhead props: signal lamps, gantries/signs, responders' strobes
//   8. badges (distracted drivers), selection ring
// then screen-space weather and the minimap HUD.
// The static layers live in render/scene.js, vehicles in render/vehicles.js,
// dynamic props in render/props.js and weather in render/weather.js.
import { N, CAR_LEN } from './config.js';
import {
  sim, cfg, offRampActive, rampLaneIdx, rampStart, decelEnd, vmaxFloat,
} from './state.js';
import { LANE_CHANGE_TIME } from './engine.js';
import { selectCar } from './ui.js';
import { $ } from './dom.js';
import {
  view, cam, camT, cw as viewCw, roadTop as viewRoadTop, computeLaneH, tickMs, viewRect,
} from './render/view.js';
import { geo } from './render/geometry.js';
import { rr, lutAt, clamp } from './render/util.js';
import {
  prepareScene, drawLayer, invalidateScene as invalidateStatic,
} from './render/scene.js';
import {
  vehSpec, bodyWidth, drawVehicle, drawLamps, drawPhoneBadge, resetSpriteBudget, clearSprites,
  glow, GLOW_RED,
} from './render/vehicles.js';
import {
  drawHeatmap, drawRampQueue, rampMeterS, drawIncidentGround, drawIncidentResponders,
  drawRoadSigns, drawSignals, drawCrossTraffic, drawOverpassTraffic,
} from './render/props.js';
import { drawWeather } from './render/weather.js';

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
// Mirrors of the shared view state, kept for the input code below and for
// importers of the legacy exports (LANE_H is a live binding).
let W = 0, H = 380, dpr = 1;
let LANE_H = 26;

export function invalidateScene() { invalidateStatic(); clearSprites(); }
function cw() { return viewCw(); }
function roadTop() { return viewRoadTop(); }

//──────────────────────────── Camera ────────────────────────────
// z = 1 shows the entire road (the maximum zoom-out); zooming magnifies about
// the cursor, after which the view can be dragged. `cam` is drawn, `camT` is
// the target the controls write; cam eases toward camT each frame.
const ZOOM_MIN = 1, ZOOM_MAX = 14;
function clampOne(c) {
  c.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, c.z));
  c.x = Math.min(W - W / c.z, Math.max(0, c.x));
  c.y = Math.min(H - H / c.z, Math.max(0, c.y));
}
function clampCam() { clampOne(cam); clampOne(camT); }
function zoomAt(sx, sy, factor) {
  const wx = sx / camT.z + camT.x, wy = sy / camT.z + camT.y;
  camT.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camT.z * factor));
  camT.x = wx - sx / camT.z;
  camT.y = wy - sy / camT.z;
  clampCam();
}
function easeCamera(dtMs) {
  const k = 1 - Math.exp(-dtMs / 75);
  cam.z += (camT.z - cam.z) * k;
  cam.x += (camT.x - cam.x) * k;
  cam.y += (camT.y - cam.y) * k;
  if (Math.abs(camT.z - cam.z) < 1e-4 &&
      Math.abs(camT.x - cam.x) < 0.02 && Math.abs(camT.y - cam.y) < 0.02) {
    cam.z = camT.z; cam.x = camT.x; cam.y = camT.y;
  }
  clampOne(cam);
}

//──────────────────────────── Overview minimap ────────────────────────────
// A thin strip along the bottom showing the WHOLE road once zoomed in, with a
// viewport rectangle and a congestion heat-strip; click/drag to jump.
const MM_H = 30;
function minimapRect() {
  const mmW = Math.min(W - 120, 560);
  const bar = $('bottombar');
  const barTop = bar ? H - bar.offsetHeight : H - 56;
  const y = Math.round(barTop - MM_H - 12);
  return { x: Math.round((W - mmW) / 2), y, w: mmW, h: MM_H };
}
function minimapVisible() {
  if (cam.z <= 1.04) return false;
  const m = minimapRect();
  return m.y > roadTop() + sim.lanes * LANE_H * 0.4;
}
const heat = new Float32Array(N);
const heatCounts = new Uint16Array(N);
function sampleHeat() {
  heat.fill(0); heatCounts.fill(0);
  const vmax = Math.max(0.5, vmaxFloat());
  for (const car of sim.cars) {
    const i = Math.min(N - 1, Math.max(0, Math.floor(car.cell)));
    heatCounts[i]++;
    heat[i] += Math.max(0, Math.min(1, 1 - car.v / vmax));
  }
  for (let i = 0; i < N; i++) {
    if (heatCounts[i]) {
      const occ = Math.min(1, heatCounts[i] / Math.max(1, sim.lanes));
      heat[i] = (heat[i] / heatCounts[i]) * (0.45 + 0.55 * occ);
    }
  }
}
function drawMinimap() {
  if (!minimapVisible()) return;
  const m = minimapRect();
  sampleHeat();
  ctx.save();
  ctx.fillStyle = 'rgba(16,19,27,.62)';
  rr(ctx, m.x - 6, m.y - 6, m.w + 12, m.h + 12, 9);
  ctx.strokeStyle = 'rgba(150,164,198,.22)';
  ctx.lineWidth = 1;
  ctx.strokeRect(m.x - 5.5, m.y - 5.5, m.w + 11, m.h + 11);
  ctx.fillStyle = 'rgba(56,57,62,.9)';
  rr(ctx, m.x, m.y, m.w, m.h, 4);
  const cwm = m.w / N;
  for (let i = 0; i < N; i++) {
    const v = heat[i];
    if (v < 0.02) continue;
    const hue = 130 * (1 - Math.min(1, v));
    const bh = Math.max(2, m.h * (0.35 + 0.65 * v));
    ctx.fillStyle = `hsl(${hue.toFixed(0)},80%,52%)`;
    ctx.globalAlpha = 0.5 + 0.5 * v;
    ctx.fillRect(m.x + i * cwm, m.y + m.h - bh, Math.max(1, cwm + 0.5), bh);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255,255,255,.30)';
  if (cfg().hasRamp) {
    ctx.fillRect(m.x + rampStart() * cwm, m.y, 1.5, m.h);
    if (offRampActive()) ctx.fillRect(m.x + decelEnd() * cwm, m.y, 1.5, m.h);
  } else for (const lc of cfg().lightCells) {
    ctx.fillRect(m.x + lc * cwm, m.y, 1.5, m.h);
  }
  const vx = m.x + (cam.x / W) * m.w;
  const vw = Math.max(6, (m.w / cam.z));
  ctx.fillStyle = 'rgba(88,166,255,.16)';
  ctx.fillRect(vx, m.y, vw, m.h);
  ctx.strokeStyle = 'rgba(120,182,255,.95)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(vx + 0.75, m.y + 0.75, Math.max(4, vw - 1.5), m.h - 1.5);
  ctx.restore();
}
function minimapJumpTo(sx) {
  const m = minimapRect();
  const frac = Math.min(1, Math.max(0, (sx - m.x) / m.w));
  const worldX = frac * W;
  camT.x = worldX - (W / camT.z) / 2;
  clampCam();
  cam.x = camT.x;
  clampOne(cam);
}
function inMinimap(sx, sy) {
  if (!minimapVisible()) return false;
  const m = minimapRect();
  return sx >= m.x - 6 && sx <= m.x + m.w + 6 &&
         sy >= m.y - 6 && sy <= m.y + m.h + 6;
}

//──────────────────────────── Canvas sizing ────────────────────────────
function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  view.W = W; view.H = H; view.dpr = dpr;
  view.laneH = LANE_H = computeLaneH();
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clearSprites();
  clampCam();
}
window.addEventListener('resize', resizeCanvas);

//──────────────────────────── Interpolation ────────────────────────────
// Cubic Hermite between tick snapshots (position AND speed matched at both
// ends), tangents clamped (Fritsch–Carlson) so the curve never reverses.
function lerpPos(car, a) {
  let to = car.cell;
  if (to < car.prevCell) to += N;
  const D = to - car.prevCell;
  const m0 = Math.max(0, Math.min(car.startV, 3 * D));
  const m1 = Math.max(0, Math.min(car.v, 3 * D));
  const a2 = a * a, a3 = a2 * a;
  const pos = car.prevCell + m0 * a +
              (3 * D - 2 * m0 - m1) * a2 + (m0 + m1 - 2 * D) * a3;
  return ((pos % N) + N) % N;
}

// Real-rate blinker (~1.5 Hz), de-phased per car.
function blinkOn(car) { return ((view.nowMs / 667 + car.id * 0.41) % 1) < 0.55; }

//──────────────────────────── Spawn / despawn smoothing ────────────────────────────
// A car that VANISHED becomes a render-only ghost that drives out of the
// world (down the exit ramp's curve, or off the right edge); a car that
// APPEARED glides in (from the left edge, or from the ramp meter along the
// on-ramp curve) instead of popping.
const tracked = new Map();
let trackTime = -1;
const ghosts = [];

function updateCarTracking() {
  if (sim.time < trackTime) { tracked.clear(); ghosts.length = 0; }
  const wasTracking = trackTime >= 0 && sim.time >= trackTime;
  let gone = null;
  if (wasTracking) {
    const live = new Set();
    for (const car of sim.cars) live.add(car.id);
    for (const [id, car] of tracked) if (!live.has(id)) (gone || (gone = [])).push(car);
    if (gone && gone.length <= 6 && !sim.paused) {
      const G = geo(), c = G.c;
      for (const car of gone) {
        if (car.drawX === undefined) continue;
        const front = car.drawX + car.drawLen;
        if (offRampActive() && (car.lane === rampLaneIdx() || car.lane2 === rampLaneIdx()) &&
            Math.abs(front - G.ox) < c * 5) {
          ghosts.push({ car, s: Math.max(0, front - G.ox), t: 0, kind: 'exit' });
        } else if (front > (N - 6) * c) {
          ghosts.push({ car, x: car.drawX, y: car.drawY, t: 0, kind: 'edge' });
        }
      }
    }
    for (const car of sim.cars) {
      if (!tracked.has(car.id)) {
        car.inWall = view.nowMs;
        car.inKind = (cfg().hasRamp && car.lane === rampLaneIdx() && car.cell < rampStart() + 3) ? 'ramp'
                   : car.cell < 3 ? 'edge' : '';
      }
    }
  }
  tracked.clear();
  for (const car of sim.cars) tracked.set(car.id, car);
  trackTime = sim.time;
}

// Position on the exit path at arc length s measured from the gore along the
// off-ramp curve (negative s = still on the straight deceleration lane).
function exitPoint(G, s) {
  if (s <= 0) return { x: G.ox + s, y: G.ry + G.LH / 2, a: 0 };
  if (s <= G.offLUT.len) return lutAt(G.offLUT, s);
  const e = G.offLUT.pts[G.offLUT.pts.length - 1];
  return { x: e.x + (s - G.offLUT.len) * Math.cos(e.a), y: e.y + (s - G.offLUT.len) * Math.sin(e.a), a: e.a };
}

function stepGhosts(list) {
  const G = geo(), c = G.c;
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i];
    const len = g.car.drawLen;
    let cx, cy, rot, alpha = 1;
    if (g.kind === 'exit') {
      if (!sim.paused) {
        g.t += view.frameDt;
        g.s += Math.max(0.8, Math.min(g.car.v, 2.2)) * c * (view.frameDt / tickMs());
      }
      const total = G.offLUT.len + len * 0.4;
      if (g.s > total + len || g.t > 9000) { ghosts.splice(i, 1); continue; }
      const p = exitPoint(G, g.s - len / 2);
      cx = p.x; cy = p.y; rot = p.a;
      alpha = clamp((total + len - g.s) / (len * 1.2), 0, 1);
    } else {
      const life = 600;
      if (!sim.paused) {
        g.t += view.frameDt;
        g.x += Math.max(0.6, g.car.v) * c * (view.frameDt / tickMs());
      }
      if (g.t >= life) { ghosts.splice(i, 1); continue; }
      cx = g.x + len / 2; cy = g.y; rot = 0;
      alpha = Math.min(1, 2 * (1 - g.t / life));
    }
    list.push({ car: g.car, cx, cy, len, h: g.car.drawH || bodyWidth(vehSpec(g.car).kind, len), rot, alpha, ghost: true });
  }
}

// On-ramp entry glide: distance d (px) back from the accel-lane centre x
// along the ramp curve.
function onRampBack(G, cx, d) {
  const x = cx - d;
  if (x >= G.rsX) return { x, y: G.ry + G.LH / 2, a: 0 };
  return lutAt(G.onLUT, G.onLUT.len - (G.rsX - x));
}

//──────────────────────────── Vehicles ────────────────────────────
const drawList = [];
function collectCars(a) {
  const G = geo(), top = G.top, c = G.c;
  updateCarTracking();
  drawList.length = 0;
  stepGhosts(drawList);
  for (const car of sim.cars) {
    const pos = lerpPos(car, a);
    // Lateral: exact engine smoothstep S-curve mid lane change; otherwise lerp.
    const prevT = car.prevLaneT !== undefined ? car.prevLaneT : 1;
    let laneF, tilt;
    if (car.laneT < 1 || prevT < 1) {
      const t0 = prevT <= car.laneT ? prevT : 0;
      const tt = t0 + (car.laneT - t0) * a;
      const span = car.laneTo - car.laneFrom;
      laneF = car.laneFrom + span * tt * tt * (3 - 2 * tt);
      const latV = span * 6 * tt * (1 - tt) / LANE_CHANGE_TIME;
      tilt = Math.max(-0.20, Math.min(0.20, latV * 0.34));
    } else {
      const lc = car.laneCoord !== undefined ? car.laneCoord : car.lane;
      const pl = car.prevLane !== undefined ? car.prevLane : lc;
      laneF = pl + (lc - pl) * a;
      tilt = (car.prevTilt || 0) + ((car.tilt || 0) - (car.prevTilt || 0)) * a;
    }
    const len = car.len * c;                  // drawn length = physics length
    let x = pos * c;
    let cx = x + len / 2;
    let cy = top + laneF * LANE_H + LANE_H / 2;
    let rot = tilt, alpha = 1;
    if (car.inWall !== undefined) {
      if (car.inKind === 'ramp') {
        // glide from the meter stop bar to the spawn point over ~2 ticks
        const u = (view.nowMs - car.inWall) / (tickMs() * 2);
        if (u >= 1) car.inWall = undefined;
        else {
          const D0 = (G.onLUT.len - rampMeterS()) + Math.max(0, cx - G.rsX) * 0.25;
          const d = D0 * (1 - u) * (1 - u) + car.v * c * (1 - u) * 0.3;
          const p = onRampBack(G, cx, d);
          cx = p.x; cy = p.y; rot = p.a + tilt * u;
          x = cx - len / 2;
        }
      } else {
        const u = (view.nowMs - car.inWall) / tickMs();
        if (u >= 1) car.inWall = undefined;
        else if (car.inKind === 'edge') {
          alpha = Math.min(1, 0.25 + u * 1.5);
          const d = car.v * (1 - u) * c;
          x -= d; cx -= d;
        }
      }
    }
    const spec = vehSpec(car);
    const h = bodyWidth(spec.kind, len);
    car.drawX = x; car.drawY = cy; car.drawLen = len; car.drawH = h;
    drawList.push({ car, cx, cy, len, h, rot, alpha, spec });
  }
}

const BRAKE_LATCH_MS = 350;
function brakeLevel(car) {
  const braking = car.braking || (Number.isFinite(car.accel) && car.accel < -0.06);
  if (braking) car.brakeWall = view.nowMs;
  const on = braking || view.nowMs - (car.brakeWall || -1e9) < BRAKE_LATCH_MS;
  const tgt = on ? 1 : 0;
  car._bk = (car._bk || 0) + (tgt - (car._bk || 0)) * Math.min(1, view.frameDt / 60);
  return car._bk;
}

function drawCars() {
  const vr = viewRect(LANE_H * 2);
  const wet = sim.weather === 'rain', beams = sim.weather !== 'clear';
  const visible = [];
  for (const d of drawList) {
    if (d.cx + d.len < vr.x0 || d.cx - d.len > vr.x1 || d.cy < vr.y0 || d.cy > vr.y1) continue;
    visible.push(d);
  }
  // (a) light on the road: headlight beams + wet taillight streaks (additive)
  if (beams) {
    ctx.globalCompositeOperation = 'lighter';
    for (const d of visible) {
      ctx.globalAlpha = d.alpha;
      ctx.save(); ctx.translate(d.cx, d.cy); if (d.rot) ctx.rotate(d.rot);
      drawLamps(ctx, d.len, d.h, 0, 0, sim.weather === 'fog' ? 1.3 : 1, false);
      if (wet) {
        const bk = d.ghost ? 0 : (d.car._bk || 0);
        ctx.globalAlpha = d.alpha * (0.18 + 0.4 * bk);
        glow(ctx, GLOW_RED, -d.len / 2 - d.h * 0.6, 0, d.h * 1.1, d.h * 0.45);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
  // (b) bodies
  for (const d of visible) {
    const spec = d.spec || vehSpec(d.car);
    if (d.alpha < 1) ctx.globalAlpha = d.alpha;
    drawVehicle(ctx, spec, d.cx, d.cy, d.len, d.h, Math.abs(d.rot) > 0.004 ? d.rot : 0);
    if (d.alpha < 1) ctx.globalAlpha = 1;
  }
  // (c) live lamps: brake lights + turn signals
  for (const d of visible) {
    const car = d.car;
    const bk = d.ghost ? 0 : brakeLevel(car);
    const sig = car.signal && blinkOn(car) ? car.signal : 0;
    if (bk < 0.02 && !sig) continue;
    ctx.globalAlpha = d.alpha;
    ctx.save(); ctx.translate(d.cx, d.cy); if (Math.abs(d.rot) > 0.004) ctx.rotate(d.rot);
    drawLamps(ctx, d.len, d.h, bk, sig, 0, false);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  return visible;
}

// Distracted-driver badges (after the overhead layer so they're never hidden).
function drawBadges(visible) {
  const show = LANE_H * cam.z >= 18 || drawList.length < 0;
  if (!show) return;
  for (const d of visible) {
    if (d.ghost || d.car.distracted !== true) continue;
    drawPhoneBadge(ctx, d.cx, d.cy - d.h / 2 - 1 / cam.z, view.nowMs + d.car.id * 97);
  }
}

// Pulsing ring around the clicked vehicle.
function drawSelection() {
  const car = sim.selected;
  if (!car || car.drawX === undefined || !sim.cars.includes(car)) return;
  const h = car.drawH || LANE_H * 0.62, pad = 3;
  const pulse = 0.55 + 0.30 * Math.sin(view.nowMs / 240);
  ctx.lineWidth = 1.4 / cam.z + 0.8;
  ctx.strokeStyle = `rgba(88,166,255,${pulse.toFixed(3)})`;
  ctx.strokeRect(car.drawX - pad, car.drawY - h / 2 - pad, car.drawLen + pad * 2, h + pad * 2);
  ctx.lineWidth = (1.4 / cam.z + 0.8) * 3;
  ctx.strokeStyle = 'rgba(88,166,255,.14)';
  ctx.strokeRect(car.drawX - pad, car.drawY - h / 2 - pad, car.drawLen + pad * 2, h + pad * 2);
}

//──────────────────────────── Frame ────────────────────────────
function render() {
  const t = performance.now();
  view.frameDt = Math.min(100, Math.max(1, t - view.nowMs));
  view.nowMs = t;
  if (!W) resizeCanvas();
  easeCamera(view.frameDt);
  const a = sim.paused ? 1 : Math.min(1, (view.nowMs - sim.lastTickWall) / tickMs());
  prepareScene();
  resetSpriteBudget();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.scale(cam.z, cam.z);
  ctx.translate(-cam.x, -cam.y);
  drawLayer(ctx, 'ground');
  if (sim.showHeatmap) drawHeatmap(ctx);
  drawIncidentGround(ctx);
  drawCrossTraffic(ctx);
  drawRampQueue(ctx);
  collectCars(a);
  const visible = drawCars();
  drawLayer(ctx, 'top');
  drawOverpassTraffic(ctx);
  drawSignals(ctx);
  drawIncidentResponders(ctx);
  drawRoadSigns(ctx);
  drawBadges(visible);
  drawSelection();
  ctx.restore();
  drawWeather(ctx);
  drawMinimap();
}

//──────────────────────────── Camera & vehicle inspector ────────────────────────────
// Scroll wheel zooms about the cursor; dragging pans when zoomed in; a plain
// click (≤4 px of travel) selects the vehicle under the cursor and opens the
// inspector. All of it is cheap: a hit test is one O(n) scan on click, and
// the camera adds a single transform per frame.

function canvasPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// Vehicle under screen point (sx, sy), or null. Uses the footprint recorded
// by drawCars; the pad shrinks with zoom so picking stays ~finger-sized on
// screen without grabbing the whole lane when zoomed out.
function pickCar(sx, sy) {
  const wx = sx / cam.z + cam.x, wy = sy / cam.z + cam.y;
  const pad = 6 / cam.z + 2;
  let best = null, bestD = Infinity;
  for (const car of sim.cars) {
    if (car.drawX === undefined) continue;
    const cx = car.drawX + car.drawLen / 2, cy = car.drawY;
    if (Math.abs(wx - cx) > car.drawLen / 2 + pad ||
        Math.abs(wy - cy) > (car.drawH || LANE_H * 0.62) / 2 + pad) continue;
    const d = (wx - cx) ** 2 + (wy - cy) ** 2;
    if (d < bestD) { bestD = d; best = car; }
  }
  return best;
}

function updateZoomUI() {
  $('zoomLevel').textContent = camT.z.toFixed(1) + '×';
  canvas.style.cursor = camT.z > 1.001 ? 'grab' : '';
}

// Pointer input handles mouse, pen and multi-touch from one code path. One
// pointer taps to select a vehicle or drags to pan (when zoomed in); two
// pointers pinch-zoom and pan together, giving touch devices the camera control
// a wheel gives a mouse. Tracking every active pointer is what makes the pinch
// gesture possible — `touch-action:none` on the canvas hands us the raw touches.
const pointers = new Map();   // active pointerId -> {x, y} in client coords
let drag = null;              // single-pointer pan/select state
let lastPinch = null;         // {dist, cx, cy} from the previous pinch sample
let lastTap = null;           // {t, x, y} of the previous tap, for double-tap zoom

// Distance between the two active pointers and their midpoint (in canvas-local
// coordinates), the two quantities a pinch is built from.
function pinchSample() {
  const [a, b] = [...pointers.values()];
  const r = canvas.getBoundingClientRect();
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    cx: (a.x + b.x) / 2 - r.left,
    cy: (a.y + b.y) / 2 - r.top,
  };
}

// Zoom the DISPLAYED camera immediately (and sync the target to it) so a pinch
// tracks the fingers 1:1 instead of easing behind them — the same direct-
// manipulation rule panning follows.
function pinchZoom(sx, sy, factor) {
  const wx = sx / cam.z + cam.x, wy = sy / cam.z + cam.y;
  cam.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.z * factor));
  cam.x = wx - sx / cam.z;
  cam.y = wy - sy / cam.z;
  camT.z = cam.z; camT.x = cam.x; camT.y = cam.y;
  clampCam();
}

canvas.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size >= 2) {
    drag = null;                          // a second finger cancels tap/select
    lastPinch = pinchSample();
    return;
  }
  // A press on the overview strip scrubs the viewport: jump there now and keep
  // scrubbing on drag. Flagged so it never pans the world or selects a car.
  const lp = canvasPos(e);
  if (inMinimap(lp.x, lp.y)) {
    drag = { minimap: true };
    minimapJumpTo(lp.x);
    updateZoomUI();
    return;
  }
  drag = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, panned: false };
});
canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size >= 2) {               // pinch-zoom + two-finger pan
    const p = pinchSample();
    if (lastPinch) {
      if (lastPinch.dist > 0) pinchZoom(p.cx, p.cy, p.dist / lastPinch.dist);
      cam.x -= (p.cx - lastPinch.cx) / cam.z;   // drag the midpoint with the fingers
      cam.y -= (p.cy - lastPinch.cy) / cam.z;
      camT.x = cam.x; camT.y = cam.y;
      clampCam();
      updateZoomUI();
    }
    lastPinch = p;
    return;
  }

  if (!drag) return;
  if (drag.minimap) {                     // scrub the viewport along the strip
    minimapJumpTo(canvasPos(e).x);
    updateZoomUI();
    return;
  }
  const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
  drag.lx = e.clientX; drag.ly = e.clientY;
  if (!drag.panned &&
      Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
  drag.panned = true;
  if (camT.z > 1.001) {
    // Pan writes both the displayed and target cameras so the world tracks
    // the pointer exactly (no easing lag while dragging).
    cam.x -= dx / cam.z; cam.y -= dy / cam.z;
    camT.x = cam.x; camT.y = cam.y;
    clampCam();
    canvas.style.cursor = 'grabbing';
  }
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const wasSelect = drag && !drag.minimap && !drag.panned && pointers.size === 1;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) lastPinch = null;
  if (pointers.size === 1) {
    // One finger remains after a pinch: keep panning from it, never select.
    const [p] = pointers.values();
    drag = { sx: p.x, sy: p.y, lx: p.x, ly: p.y, panned: true };
  } else if (pointers.size === 0) {
    drag = null;
  }
  updateZoomUI();                         // restore grab/default cursor
  if (wasSelect) {
    const p = canvasPos(e);
    // Touch double-tap mirrors mouse double-click (the browser doesn't always
    // synthesize dblclick for touch): a second tap within 300 ms and 26 px
    // zooms toward the point instead of selecting.
    if (e.pointerType !== 'mouse' && lastTap &&
        view.nowMs - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 26) {
      lastTap = null;
      zoomToggleAt(p.x, p.y);
      return;
    }
    lastTap = { t: view.nowMs, x: p.x, y: p.y };
    selectCar(pickCar(p.x, p.y));
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// Hover affordance (mouse only — touch has no hover): the overview strip reads
// as clickable, the zoomed-in road as draggable, everything else as default.
canvas.addEventListener('mousemove', e => {
  if (drag || pointers.size) return;      // a live gesture owns the cursor
  const p = canvasPos(e);
  canvas.style.cursor = inMinimap(p.x, p.y) ? 'pointer'
                      : camT.z > 1.001 ? 'grab' : '';
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const p = canvasPos(e);
  // deltaMode 1 = lines (Firefox), 2 = pages: normalise to pixel-ish deltas so a
  // notch feels the same across browsers. ≈20% per mouse notch (deltaY≈100)
  // crosses the 1×–14× range in ~12 notches — fluid, not twitchy on trackpads.
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
  zoomAt(p.x, p.y, Math.exp(-e.deltaY * unit * 0.0022));
  updateZoomUI();
}, { passive: false });

// Double-click / double-tap zooms toward the point, or snaps back to the full
// road once it's already deep in — one gesture both dives in and pops out.
function zoomToggleAt(sx, sy) {
  if (camT.z > ZOOM_MAX * 0.6) { camT.z = 1; camT.x = camT.y = 0; clampCam(); }
  else zoomAt(sx, sy, 2.4);
  updateZoomUI();
}
canvas.addEventListener('dblclick', e => {
  e.preventDefault();
  const p = canvasPos(e);
  if (inMinimap(p.x, p.y)) return;        // the strip owns its own gestures
  zoomToggleAt(p.x, p.y);
});

// Keyboard: discoverable zoom/pan without touching the mouse. Ignored while a
// form control is focused so typing in the sidebar never moves the camera.
function typingInForm() {
  const el = document.activeElement;
  return el && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
}
window.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || typingInForm()) return;
  const panStep = 90 / cam.z;             // world px per arrow press (eased in)
  switch (e.key) {
    case '+': case '=':                   // '=' is the unshifted '+' key
      zoomAt(W / 2, H / 2, 1.4); break;
    case '-': case '_':
      zoomAt(W / 2, H / 2, 1 / 1.4); break;
    case '0': case 'f': case 'F':
      camT.z = 1; camT.x = camT.y = 0; clampCam(); break;
    case 'ArrowLeft':  camT.x -= panStep; clampCam(); break;
    case 'ArrowRight': camT.x += panStep; clampCam(); break;
    case 'ArrowUp':    camT.y -= panStep; clampCam(); break;
    case 'ArrowDown':  camT.y += panStep; clampCam(); break;
    default: return;                      // leave every other key alone
  }
  e.preventDefault();
  updateZoomUI();
});

$('zoomIn').addEventListener('click', () => { zoomAt(W / 2, H / 2, 1.35); updateZoomUI(); });
$('zoomOut').addEventListener('click', () => { zoomAt(W / 2, H / 2, 1 / 1.35); updateZoomUI(); });
$('zoomFit').addEventListener('click', () => { camT.z = 1; camT.x = camT.y = 0; updateZoomUI(); });
$('insClose').addEventListener('click', () => selectCar(null));

export {
  render, resizeCanvas, cam, clampCam, zoomAt, canvasPos, pickCar,
  LANE_H, roadTop, cw, updateZoomUI,
};
