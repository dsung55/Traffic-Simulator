// Two-layer canvas renderer, camera (zoom/pan) and pointer input. All static
// scenery is pre-rendered into an offscreen canvas and blitted once per frame;
// vehicles, signal lamps, ramp meter and weather draw on top. Pointer input
// lives here because click-picking and panning are camera math.
import { N, TICK_MS, INCIDENT_CELL, SENSOR_CELL, CAR_LEN } from './config.js';
import {
  sim, cfg, offRampActive, rampLaneIdx, rampStart, rampEnd,
  decelStart, decelEnd, vmaxFloat,
} from './state.js';
import { lightState, LANE_CHANGE_TIME } from './engine.js';
import { selectCar } from './ui.js';
import { $ } from './dom.js';

//──────────────────────────── Rendering ────────────────────────────
// Two-layer renderer. All static scenery (terrain, asphalt texture, lane
// markings, ramps, guardrails, buildings, streetlights, crosswalks, sensor)
// is pre-rendered into an offscreen canvas and blitted once per frame; only
// dynamic elements — vehicles, signal lamps, ramp meter/queue, the incident
// and weather — are drawn per frame, so the 60 fps loop stays cheap even
// with 200 cars. The static layer is rebuilt lazily whenever its signature
// (canvas size / dpr / scenario / lanes / merge shape / weather) changes.
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
let W = 0, H = 380, dpr = 1;

// Camera: zoom factor z and world-space pan origin (x, y), applied on top of
// the dpr transform when drawing the world. z = 1 shows the entire ring road
// (the maximum zoom-out — the full loop is always on screen at 1×); zooming
// in magnifies about the cursor, after which the view can be dragged.
// Screen→world: w = s / z + cam. Cost is one save/scale/translate per frame.
//
// `cam` is what is DRAWN each frame; `camT` is the target the controls write.
// Each frame cam eases exponentially toward camT, so wheel notches and the
// zoom buttons glide instead of stepping. Panning writes BOTH (direct
// manipulation must track the pointer 1:1, never lag behind it).
const cam = { z: 1, x: 0, y: 0 };
const camT = { z: 1, x: 0, y: 0 };
// ZOOM_MAX raised to 14×: at 1× the whole 84-cell ring fills the width (one car
// ≈ 25 px), so 6× left a merge/jam still spanning most of the screen. At 14× a
// single car is ~350 px and an 8–18-cell speed-change lane fills the view, which
// is what "zoom in to study a few cars / a merge / a jam" actually needs. The
// vehicle renderer gates detail on len×cam.z, so the extra range just blooms
// more legible detail (wheels, glass, seams) rather than upscaling a blur.
const ZOOM_MIN = 1, ZOOM_MAX = 14;
function clampOne(c) {
  c.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, c.z));
  c.x = Math.min(W - W / c.z, Math.max(0, c.x));
  c.y = Math.min(H - H / c.z, Math.max(0, c.y));
}
function clampCam() { clampOne(cam); clampOne(camT); }
// Zoom by `factor` keeping the world point under screen (sx, sy) fixed.
// Operates on the TARGET camera; the render loop eases the view there.
function zoomAt(sx, sy, factor) {
  const wx = sx / camT.z + camT.x, wy = sy / camT.z + camT.y;
  camT.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, camT.z * factor));
  camT.x = wx - sx / camT.z;
  camT.y = wy - sy / camT.z;
  clampCam();
}
// Ease the displayed camera toward the target (called once per frame).
function easeCamera(dtMs) {
  const k = 1 - Math.exp(-dtMs / 75);          // ~75 ms time constant (snappy glide)
  cam.z += (camT.z - cam.z) * k;
  cam.x += (camT.x - cam.x) * k;
  cam.y += (camT.y - cam.y) * k;
  // Snap when effectively settled so we stop accumulating sub-pixel drift.
  if (Math.abs(camT.z - cam.z) < 1e-4 &&
      Math.abs(camT.x - cam.x) < 0.02 && Math.abs(camT.y - cam.y) < 0.02) {
    cam.z = camT.z; cam.x = camT.x; cam.y = camT.y;
  }
  clampOne(cam);
}

//──────────────────────────── Overview minimap ────────────────────────────
// A thin always-on strip along the bottom edge showing the WHOLE road at a
// glance. When zoomed in it gains a viewport rectangle (the slice currently on
// screen) and a congestion heat-strip (red where traffic is jammed) so the user
// can SEE where a queue is building and click/drag to jump straight to it. The
// whole road's x-axis maps linearly to the strip; world-x 0..W ↔ strip 0..mmW,
// the SAME w = s/z + cam transform the main view uses, so the viewport rect and
// click-to-jump line up exactly with what's on screen.
//
// Drawn in SCREEN space (after the world pass), so the camera transform never
// touches it — it stays a crisp, fixed-size HUD element at any zoom.
const MM_H = 30;                 // strip height in CSS px
// Geometry of the strip for the current canvas size. Centred horizontally and
// docked just ABOVE the bottom controls bar (whose height varies with the
// device and how many control rows wrap), so it never hides behind the bar or
// covers the road band. Capped so it never spans the whole width on big
// monitors. The bar is position:fixed; bottom:0, so its top edge in viewport
// coords is H − offsetHeight; we float 12 px clear of it.
function minimapRect() {
  const mmW = Math.min(W - 120, 560);
  const bar = $('bottombar');
  const barTop = bar ? H - bar.offsetHeight : H - 56;
  const y = Math.round(barTop - MM_H - 12);
  return { x: Math.round((W - mmW) / 2), y, w: mmW, h: MM_H };
}
// The minimap only earns its screen real estate once the user has zoomed in
// (at 1× the main view already IS the overview) and only when the bottom bar
// has left vertical room for it below the road band (e.g. it's hidden when a
// mobile controls drawer is expanded over the lower screen).
function minimapVisible() {
  if (cam.z <= 1.04) return false;
  const m = minimapRect();
  return m.y > roadTop() + sim.lanes * LANE_H * 0.4;
}

// Per-cell congestion sampled cheaply from live cars: 0 = empty/free-flow,
// 1 = jammed. Rebuilt each frame from one O(cars) scan (N buckets, tiny).
const heat = new Float32Array(N);
function sampleHeat() {
  heat.fill(0);
  const counts = new Uint16Array(N);
  const vmax = Math.max(0.5, vmaxFloat());
  for (const car of sim.cars) {
    const i = Math.min(N - 1, Math.max(0, Math.floor(car.cell)));
    counts[i]++;
    // slowness in [0,1]: 0 at/above free speed, 1 at a standstill
    heat[i] += Math.max(0, Math.min(1, 1 - car.v / vmax));
  }
  // average slowness per occupied cell, weighted up a little by how many cars
  // share the cell (a packed cell reads as more congested than a lone slow car)
  for (let i = 0; i < N; i++) {
    if (counts[i]) {
      const occ = Math.min(1, counts[i] / Math.max(1, sim.lanes));
      heat[i] = (heat[i] / counts[i]) * (0.45 + 0.55 * occ);
    }
  }
}

function drawMinimap() {
  if (!minimapVisible()) return;
  const m = minimapRect();
  sampleHeat();
  ctx.save();
  // translucent glass plate matching the UI aesthetic
  ctx.fillStyle = 'rgba(16,19,27,.62)';
  rr(ctx, m.x - 6, m.y - 6, m.w + 12, m.h + 12, 9);
  ctx.strokeStyle = 'rgba(150,164,198,.22)';
  ctx.lineWidth = 1;
  ctx.strokeRect(m.x - 5.5, m.y - 5.5, m.w + 11, m.h + 11);
  // road bed
  ctx.fillStyle = 'rgba(56,57,62,.9)';
  rr(ctx, m.x, m.y, m.w, m.h, 4);

  // congestion heat-strip: a green→amber→red bar per cell, height-scaled by jam
  const cwm = m.w / N;
  for (let i = 0; i < N; i++) {
    const v = heat[i];
    if (v < 0.02) continue;
    // hue 130° (green) → 0° (red) as congestion rises
    const hue = 130 * (1 - Math.min(1, v));
    const bh = Math.max(2, m.h * (0.35 + 0.65 * v));
    ctx.fillStyle = `hsl(${hue.toFixed(0)},80%,52%)`;
    ctx.globalAlpha = 0.5 + 0.5 * v;
    ctx.fillRect(m.x + i * cwm, m.y + m.h - bh, Math.max(1, cwm + 0.5), bh);
  }
  ctx.globalAlpha = 1;

  // landmark ticks: on-ramp entry and off-ramp gore, so the user can orient
  ctx.fillStyle = 'rgba(255,255,255,.30)';
  if (cfg().hasRamp) {
    ctx.fillRect(m.x + rampStart() * cwm, m.y, 1.5, m.h);
    if (offRampActive()) ctx.fillRect(m.x + decelEnd() * cwm, m.y, 1.5, m.h);
  } else for (const lc of cfg().lightCells) {
    ctx.fillRect(m.x + lc * cwm, m.y, 1.5, m.h);
  }

  // viewport rectangle: the world-x slice [cam.x, cam.x + W/cam.z] on screen now
  const vx = m.x + (cam.x / W) * m.w;
  const vw = Math.max(6, (m.w / cam.z));
  ctx.fillStyle = 'rgba(88,166,255,.16)';
  ctx.fillRect(vx, m.y, vw, m.h);
  ctx.strokeStyle = 'rgba(120,182,255,.95)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(vx + 0.75, m.y + 0.75, Math.max(4, vw - 1.5), m.h - 1.5);
  ctx.restore();
}

// Map a screen-x over the minimap to a camera so that world point sits in the
// CENTRE of the view, then clamp. Shared by click and drag on the strip.
function minimapJumpTo(sx) {
  const m = minimapRect();
  const frac = Math.min(1, Math.max(0, (sx - m.x) / m.w));
  const worldX = frac * W;                       // centre of the desired view
  camT.x = worldX - (W / camT.z) / 2;
  clampCam();
  cam.x = camT.x;                                // track the pointer 1:1, no lag
  clampOne(cam);
}
// Is screen point (sx, sy) within the interactive minimap (incl. its padding)?
function inMinimap(sx, sy) {
  if (!minimapVisible()) return false;
  const m = minimapRect();
  return sx >= m.x - 6 && sx <= m.x + m.w + 6 &&
         sy >= m.y - 6 && sy <= m.y + m.h + 6;
}

const scene = document.createElement('canvas');  // offscreen static scenery
const sctx = scene.getContext('2d');
let sceneSig = '';
export function invalidateScene() { sceneSig = ''; }
let fogGrad = null;                              // cached fog gradient

function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  // Fullscreen: the canvas fills the entire viewport edge to edge.
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clampCam();
}
window.addEventListener('resize', resizeCanvas);

const LANE_H = 26;
// Vertically centre the road band within the full-viewport canvas, leaving
// scenery above and below. Highway scenarios add one ramp/accel lane below the
// mainline (rampLaneIdx === sim.lanes), so the band is one LANE_H taller.
function roadTop() {
  const rows = sim.lanes + (cfg().hasRamp ? 1 : 0);
  const band = rows * LANE_H;
  return Math.max(40, Math.round((H - band) / 2));
}
function cw() { return W / N; }

// Per-frame wall clock, shared by every animation in this file. nowMs/frameDt
// are refreshed once at the top of render() so all painters agree on "now".
let nowMs = performance.now();
let frameDt = 16;

// Interpolated position in cells, handling ring wrap. Cubic Hermite rather
// than linear: the engine snapshots the speed at both tick boundaries
// (car.startV at the start, car.v at the end), so we can match velocity as
// well as position across ticks — cars visibly ease in/out instead of
// changing speed instantaneously once per second. Tangents are clamped to
// [0, 3·D] (Fritsch–Carlson) so the curve can never overshoot or reverse,
// even when the boundary speeds disagree with the integrated displacement
// (e.g. a freshly spawned car with D = 0 but v > 0 stays put).
function lerpPos(car, a) {
  let to = car.cell;
  if (to < car.prevCell) to += N;
  const D = to - car.prevCell;                 // displacement over the tick
  const m0 = Math.max(0, Math.min(car.startV, 3 * D));
  const m1 = Math.max(0, Math.min(car.v, 3 * D));
  const a2 = a * a, a3 = a2 * a;
  const pos = car.prevCell + m0 * a +
              (3 * D - 2 * m0 - m1) * a2 + (m0 + m1 - 2 * D) * a3;
  return ((pos % N) + N) % N;
}

// Rounded-rect fill helper (radius clamped so tiny shapes stay valid).
function rr(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0.5) { g.fillRect(x, y, w, h); return; }
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fill();
}

// Deterministic PRNG for scenery decoration — identical across rebuilds.
function sceneRand(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
}

//—— Static-layer painters shared by both scenes ——
function paintAsphalt(g, top, rh, rnd) {
  const grad = g.createLinearGradient(0, top, 0, top + rh);
  grad.addColorStop(0, '#36373c'); grad.addColorStop(0.5, '#3e3f45'); grad.addColorStop(1, '#35363b');
  g.fillStyle = grad; g.fillRect(0, top, W, rh);
  // tire-wear tracks: two darker streaks per lane
  g.fillStyle = 'rgba(0,0,0,.10)';
  for (let l = 0; l < sim.lanes; l++) {
    const yc = top + l * LANE_H + LANE_H / 2;
    g.fillRect(0, yc - LANE_H * 0.27, W, 2.5);
    g.fillRect(0, yc + LANE_H * 0.27 - 2.5, W, 2.5);
  }
  // gravel specks & faint patches
  for (let i = 0; i < 240; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.06)';
    g.fillRect(rnd() * W, top + rnd() * rh, 1 + rnd() * 3, 1 + rnd() * 1.5);
  }
  // occasional cracks / tar seams
  g.strokeStyle = 'rgba(0,0,0,.09)'; g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i < 9; i++) {
    const x = rnd() * W, y = top + rnd() * rh;
    g.moveTo(x, y); g.lineTo(x + 12 + rnd() * 34, y + (rnd() - 0.5) * 7);
  }
  g.stroke();
}

function paintLaneDashes(g, top) {
  // US convention: a broken lane line is a 10 ft stripe with a 30 ft gap
  // (1:3). 1 cell = 7.5 m ≈ 24.6 ft, so a stripe ≈ 0.41 cell and the gap ≈
  // 1.22 cell. Scaled to pixels via cw(); clamped so it never disappears.
  const c = cw();
  const dash = Math.max(6, c * 0.41), gap = Math.max(14, c * 1.22);
  for (let l = 1; l < sim.lanes; l++) {
    const y = top + l * LANE_H - 1.25;
    // soft cast shadow under the paint, then the bright stripe
    for (let x = 6; x < W; x += dash + gap) {
      g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(x + 0.6, y + 1, dash, 2.5);
      g.fillStyle = '#eef0f3'; g.fillRect(x, y, dash, 2.5);
    }
  }
}

// Wet-road sheen baked into the static layer when it's raining.
function paintWetSheen(g, top, rh) {
  const grad = g.createLinearGradient(0, top, 0, top + rh);
  grad.addColorStop(0, 'rgba(150,180,220,.09)');
  grad.addColorStop(0.5, 'rgba(195,215,245,.16)');
  grad.addColorStop(1, 'rgba(150,180,220,.09)');
  g.fillStyle = grad; g.fillRect(0, top, W, rh);
  // reflective glaze along each lane center
  g.fillStyle = 'rgba(215,228,250,.07)';
  for (let l = 0; l < sim.lanes; l++) {
    g.fillRect(0, top + l * LANE_H + LANE_H / 2 - 2, W, 4);
  }
}

function drawGuardrail(g, x0, x1, y) {
  if (x1 - x0 < 20) return;
  g.fillStyle = '#565963';
  for (let x = x0 + 6; x < x1 - 4; x += 26) g.fillRect(x, y, 2, 6);
  g.fillStyle = '#9ba0ab'; g.fillRect(x0, y - 3, x1 - x0, 3);
  g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(x0, y - 3, x1 - x0, 1);
}

// Split [x0,x1] into rail segments avoiding the given gap intervals.
function railSegs(x0, x1, gaps) {
  let segs = [[x0, x1]];
  for (const gp of gaps) {
    const out = [];
    for (const s of segs) {
      if (gp[1] <= s[0] || gp[0] >= s[1]) { out.push(s); continue; }
      if (gp[0] > s[0]) out.push([s[0], gp[0]]);
      if (gp[1] < s[1]) out.push([gp[1], s[1]]);
    }
    segs = out;
  }
  return segs;
}

// (Re)build the offscreen static layer at device resolution.
function buildScene() {
  scene.width = Math.max(1, Math.round(W * dpr));
  scene.height = Math.max(1, Math.round(H * dpr));
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.clearRect(0, 0, W, H);
  if (cfg().style === 'city') buildCityStatic(sctx); else buildHighwayStatic(sctx);
  // fog gradient: thinnest over the road, thicker toward the canvas edges
  const mid = Math.max(0.05, Math.min(0.95, (roadTop() + sim.lanes * LANE_H / 2) / H));
  fogGrad = ctx.createLinearGradient(0, 0, 0, H);
  fogGrad.addColorStop(0, 'rgba(206,213,224,.62)');
  fogGrad.addColorStop(mid, 'rgba(206,213,224,.22)');
  fogGrad.addColorStop(1, 'rgba(206,213,224,.58)');
}

function render() {
  const t = performance.now();
  frameDt = Math.min(100, Math.max(1, t - nowMs));   // clamp tab-switch spikes
  nowMs = t;
  easeCamera(frameDt);
  const a = sim.paused ? 1 : Math.min(1, (nowMs - sim.lastTickWall) / TICK_MS);
  const sig = W + '|' + H + '|' + dpr + '|' + sim.scenario + '|' + sim.lanes + '|' +
              sim.mergeShape + '|' + sim.weather + '|' + sim.exitRamp + '|' +
              sim.buildings.length;
  if (sig !== sceneSig) { sceneSig = sig; buildScene(); }
  ctx.clearRect(0, 0, W, H);
  // World pass under the camera transform: static blit, dynamic scenery,
  // vehicles, selection highlight. Weather stays screen-space on top.
  ctx.save();
  ctx.scale(cam.z, cam.z);
  ctx.translate(-cam.x, -cam.y);
  ctx.drawImage(scene, 0, 0, W, H);
  if (cfg().style === 'city') drawCityScene(); else drawHighwayScene();
  drawCars(a);
  drawSelection();
  ctx.restore();
  drawWeatherOverlay();
  drawMinimap();          // screen-space overview HUD (only when zoomed in)
}

//—— Highway static layer: terrain, asphalt, markings, ramps, guardrails ——
function buildHighwayStatic(g) {
  const top = roadTop(), rh = sim.lanes * LANE_H, c = cw();
  const ry = top + rh;                       // y of the accel-lane top (merge boundary)
  const ay = ry + LANE_H;                     // y of the accel-lane bottom / outer edge
  // Accel lane occupies grid row rampLaneIdx()===sim.lanes, cells rampStart()..rampEnd(),
  // i.e. the pixel box [rsX, reX] × [ry, ay]. Cars travel ON this box, so the painted
  // ramp footprint is tied directly to those cells.
  const rsX = rampStart() * c;               // left edge of accel lane (entry from ramp)
  const reX = (rampEnd() + 1) * c;           // right edge of accel lane (end of taper)
  // Approach ramp angles up from the lower-left into the accel-lane entry. Its drop is a
  // fraction of the generous below-road margin so it always stays on-screen.
  const appDrop = Math.min(LANE_H * 2.6, (H - ay) * 0.55);  // vertical rise of the approach
  const appRun = appDrop * 0.62;             // horizontal run (gentle merge angle)
  const rnd = sceneRand(424243);

  // terrain: layered green gradient with mottling, tufts, bushes
  const tg = g.createLinearGradient(0, 0, 0, H);
  tg.addColorStop(0, '#2e4326'); tg.addColorStop(0.45, '#283a20'); tg.addColorStop(1, '#20301a');
  g.fillStyle = tg; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 150; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(210,230,150,.05)' : 'rgba(0,0,0,.09)';
    g.beginPath();
    g.ellipse(rnd() * W, rnd() * H, 10 + rnd() * 30, 3 + rnd() * 8, 0, 0, 7);
    g.fill();
  }
  g.strokeStyle = 'rgba(165,195,115,.38)'; g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i < 90; i++) {                       // grass tufts
    const x = rnd() * W, y = rnd() * H;
    g.moveTo(x, y); g.lineTo(x - 2, y - 3);
    g.moveTo(x, y); g.lineTo(x, y - 4);
    g.moveTo(x, y); g.lineTo(x + 2, y - 3);
  }
  g.stroke();
  for (let i = 0; i < 22; i++) {                       // bushes / tree canopies
    const x = rnd() * W, y = rnd() * H, r = 4 + rnd() * 8;
    g.fillStyle = 'rgba(0,0,0,.25)';
    g.beginPath(); g.ellipse(x + 2, y + 2.5, r, r * 0.55, 0, 0, 7); g.fill();
    g.fillStyle = `hsl(${100 + rnd() * 30},${30 + rnd() * 20}%,${20 + rnd() * 12}%)`;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,210,.10)';
    g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.55, 0, 7); g.fill();
  }

  // shoulders with rumble strips (road & ramp pave over them below)
  g.fillStyle = '#46474d';
  g.fillRect(0, top - 7, W, 7); g.fillRect(0, ry, W, 7);
  g.fillStyle = 'rgba(0,0,0,.25)';
  for (let x = 0; x < W; x += 7) { g.fillRect(x, top - 5, 3, 2); g.fillRect(x, ry + 2.6, 3, 2); }

  // mainline asphalt + edge lines + dashes
  paintAsphalt(g, top, rh, rnd);
  // Solid yellow edge line on the median (left) side, solid white on the right
  // shoulder — both with a faint cast shadow so they sit ON the asphalt.
  g.fillStyle = 'rgba(0,0,0,.20)'; g.fillRect(0, top + 3, W, 2.4);
  g.fillStyle = '#f2cf3c'; g.fillRect(0, top + 2, W, 2.4);    // yellow left-edge line
  g.fillStyle = 'rgba(0,0,0,.20)'; g.fillRect(0, ry - 2.6, W, 2.4);
  g.fillStyle = '#eef0f3'; g.fillRect(0, ry - 3.8, W, 2.4);   // white right-edge line
  paintLaneDashes(g, top);

  // ── On-ramp approach roadway: a separate lane angling up from the lower-left
  //    into the accel-lane entry at (rsX, ay). Its outer (left) edge runs from
  //    (appX0, appBot) to the accel-lane outer edge; its inner (right) edge runs
  //    to the merge boundary (rsX, ry). Drawn the same asphalt tone as the road.
  const appBot = ay + appDrop;                         // bottom of the approach
  const appX0 = rsX - appRun;                          // outer-left foot of the approach
  const appX1 = appX0 + LANE_H;                         // inner-right foot (one lane wide)
  g.fillStyle = '#36373c';
  g.beginPath();
  g.moveTo(rsX, ay); g.lineTo(rsX + LANE_H * 0.55, ay);  // top: where it meets accel lane
  g.lineTo(appX1, appBot); g.lineTo(appX0, appBot);
  g.closePath(); g.fill();
  // approach edge lines (white)
  g.strokeStyle = '#caccd2'; g.lineWidth = 1.8;
  g.beginPath();
  g.moveTo(rsX, ay); g.lineTo(appX0, appBot);            // outer edge
  g.moveTo(rsX + LANE_H * 0.55, ay); g.lineTo(appX1, appBot); // inner edge
  g.stroke();
  // approach centre dashes
  g.strokeStyle = 'rgba(230,231,236,.45)'; g.lineWidth = 2; g.setLineDash([7, 8]);
  g.beginPath();
  g.moveTo(rsX + LANE_H * 0.28, ay); g.lineTo((appX0 + appX1) / 2, appBot);
  g.stroke(); g.setLineDash([]);

  // ── Acceleration lane: the box [rsX, reX] × [ry, ay] cars actually drive on,
  //    with a gore taper closing the outer edge into the mainline at the end.
  const taper = Math.min(LANE_H * 1.3, (reX - rsX) * 0.45);  // length of the end wedge
  g.fillStyle = '#3b3c41';
  g.beginPath();
  g.moveTo(rsX, ry); g.lineTo(reX, ry);
  g.lineTo(reX, ry + 2); g.lineTo(reX - taper, ay);     // outer edge tapers up to boundary
  g.lineTo(rsX, ay);
  g.closePath(); g.fill();
  // mainline right-edge line becomes a wide dotted channelizing line across the
  // accel zone (short dots, big gaps — the MUTCD lane-drop / merge marking)
  g.fillStyle = '#3b3c41'; g.fillRect(rsX, ry - 4, reX - rsX, 4);
  g.fillStyle = '#eef0f3';
  for (let x = rsX + 2; x < reX - 6; x += 18) g.fillRect(x, ry - 3.6, 9, 2.4);
  // accel-lane outer (white) edge line, following the taper into the boundary
  g.strokeStyle = '#eef0f3'; g.lineWidth = 2.4;
  g.beginPath();
  g.moveTo(rsX, ay - 1.5); g.lineTo(reX - taper, ay - 1.5); g.lineTo(reX, ry + 1);
  g.stroke();
  // gore chevrons filling the closing wedge of the taper
  g.strokeStyle = 'rgba(230,231,236,.65)'; g.lineWidth = 2;
  g.beginPath();
  for (let k = 0; k < 3; k++) {
    const gx = reX - taper + k * (taper / 3.2);
    g.moveTo(gx, ay - 3); g.lineTo(gx + taper * 0.5, ry + 3);
  }
  g.stroke();

  // ── Off-ramp (interchange): a long parallel DECELERATION lane in the aux row,
  //    cells decelStart()..decelEnd(). Exit-bound cars move over EARLY into this
  //    box (same [ry, ay] band the accel lane uses, just downstream), ease down
  //    its length, and peel off at the gore (decelEnd) where it drops away to the
  //    lower-right. The painted footprint is tied to the same cells the engine
  //    uses, so cars drive exactly on it.
  if (offRampActive()) {
    const dsX = decelStart() * c;                      // where the decel lane opens
    const ox = decelEnd() * c;                         // gore / departure point
    const offDrop = Math.min(LANE_H * 2.4, (H - ay) * 0.5);
    const offW = LANE_H;                               // one ramp lane wide
    const open = Math.min(LANE_H * 1.3, (ox - dsX) * 0.4); // opening taper length
    // deceleration-lane asphalt: an opening wedge then a full-width parallel lane
    g.fillStyle = '#3b3c41';
    g.beginPath();
    g.moveTo(dsX, ry);                                  // inner edge starts at the boundary
    g.lineTo(ox, ry);
    g.lineTo(ox + offDrop * 0.55, ry + offDrop);        // inner edge drops down the ramp
    g.lineTo(ox + offDrop * 0.55 + offW, ry + offDrop); // outer edge of the ramp throat
    g.lineTo(ox, ay);                                   // back up to the lane's outer edge
    g.lineTo(dsX + open, ay);                           // along the outer edge…
    g.closePath(); g.fill();                            // …to the opening taper
    // mainline right-edge line becomes a dotted channelizing line the whole
    // length of the deceleration lane (MUTCD diverge marking)
    g.fillStyle = '#3b3c41'; g.fillRect(dsX, ry - 4, ox - dsX, 4);
    g.fillStyle = '#eef0f3';
    for (let x = dsX + 2; x < ox - 6; x += 18) g.fillRect(x, ry - 3.6, 9, 2.4);
    // decel-lane outer (white) edge line: opening taper, then straight to the gore
    g.strokeStyle = '#eef0f3'; g.lineWidth = 2.4;
    g.beginPath();
    g.moveTo(dsX, ry + 1); g.lineTo(dsX + open, ay - 1.5); g.lineTo(ox, ay - 1.5);
    g.stroke();
    // ramp throat edge lines beyond the gore (white)
    g.strokeStyle = '#caccd2'; g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(ox, ry); g.lineTo(ox + offDrop * 0.55, ry + offDrop);           // inner
    g.moveTo(ox, ay); g.lineTo(ox + offDrop * 0.55 + offW, ry + offDrop);    // outer
    g.stroke();
    // gore chevrons filling the triangular nose just past the gore point
    g.strokeStyle = 'rgba(230,231,236,.6)'; g.lineWidth = 2;
    g.beginPath();
    for (let k = 1; k <= 3; k++) {
      const d = k * (offDrop / 4.5);
      g.moveTo(ox + d * 0.55, ry + d); g.lineTo(ox + d * 0.55 + d * 0.5, ry + d + 5);
    }
    g.stroke();
    // EXIT board on a post beside the ramp throat
    const sgx = ox + offDrop * 0.55 + offW + 6, sgy = ry + offDrop * 0.55;
    g.fillStyle = '#3c3e45'; g.fillRect(sgx + 16, sgy + 17, 2, offDrop * 0.45);
    g.fillStyle = '#0f7a3d'; rr(g, sgx, sgy, 36, 17, 2);
    g.strokeStyle = '#e8f5ee'; g.lineWidth = 1; g.strokeRect(sgx + 1.5, sgy + 1.5, 33, 14);
    g.fillStyle = '#fff'; g.font = 'bold 10px system-ui'; g.textAlign = 'center';
    g.fillText('EXIT', sgx + 18, sgy + 12);
    g.textAlign = 'left';
  }

  // guardrails: continuous along the top, gapped below where ramps break through
  drawGuardrail(g, 0, W, top - 11);
  const railY = ay + 11;                               // rail sits below the accel lane
  const gaps = [[rsX - appRun - 10, reX + 6]];          // on-ramp + accel-lane gap
  if (offRampActive()) {
    // gap the rail along the whole decel lane + the ramp throat past the gore
    gaps.push([decelStart() * c - 6, decelEnd() * c + LANE_H * 2.6]);
  }
  for (const s of railSegs(0, W, gaps)) drawGuardrail(g, s[0], s[1], railY);

  if (sim.weather === 'rain') {
    paintWetSheen(g, top, rh);
    g.fillStyle = 'rgba(170,195,235,.10)';            // speed-change lanes glazed too
    g.fillRect(rsX, ry, reX - rsX, LANE_H);
    if (offRampActive()) {
      const dsX = decelStart() * c;
      g.fillRect(dsX, ry, decelEnd() * c - dsX, LANE_H);
    }
  }
  drawSensor(g, top, rh);
}

//—— Highway dynamic layer: ramp queue, meter signal, incident ——
// On-ramp approach geometry (mirrors buildHighwayStatic so queue cars, the
// meter and the ramp-entry glide all sit exactly on the painted approach).
function approachGeom() {
  const ry = roadTop() + sim.lanes * LANE_H, ay = ry + LANE_H;
  const rsX = rampStart() * cw();                       // accel-lane entry x
  const appDrop = Math.min(LANE_H * 2.6, (H - ay) * 0.55);
  const appRun = appDrop * 0.62;
  const appBot = ay + appDrop;
  // Approach centreline: from the accel-lane entry down-left to the queue foot.
  const cTopX = rsX + LANE_H * 0.28, cBotX = (rsX - appRun) + LANE_H / 2;
  return {
    ay, appBot, cTopX, cBotX,
    ang: Math.atan2(appBot - ay, cBotX - cTopX),     // pointing down-ramp
    heading: Math.atan2(ay - appBot, cTopX - cBotX), // direction of travel up-ramp
  };
}

// Queue-slide state: when the meter releases a car, the rest of the queue
// glides forward one slot instead of teleporting into it.
let lastQueue = 0, qShift = 0;

function drawHighwayScene() {
  const top = roadTop(), c = cw();
  const { ay, appBot, cTopX, cBotX, ang } = approachGeom();

  if (sim.rampQueue < lastQueue) qShift = Math.min(1, qShift + (lastQueue - sim.rampQueue));
  lastQueue = sim.rampQueue;
  if (qShift > 0) {
    qShift *= Math.exp(-frameDt / 200);                 // eased slide up the ramp
    if (qShift < 0.01) qShift = 0;
  }

  // queued cars stacked along the approach centreline, nose pointing up-ramp
  // (drawn at the same scale as live traffic so the queue reads as real cars)
  const q = Math.min(sim.rampQueue, 5);
  if (q > 0) {
    for (let i = 0; i < q; i++) {
      const t = 0.15 + (i + qShift) * 0.19;             // 0=at meter, 1=foot of ramp
      ctx.save();
      ctx.translate(cTopX + (cBotX - cTopX) * t, ay + (appBot - ay) * t);
      ctx.rotate(ang);
      // queue cars share the live-car proportions (≈half a lane wide) so the
      // stack reads as the same fleet, with a little hue variety per slot
      const ql = 17, qh = 7.4;
      ctx.fillStyle = 'rgba(0,0,0,.32)'; rr(ctx, -ql / 2 + 0.6, -qh / 2 + 1.4, ql, qh, 2.4);
      ctx.fillStyle = `hsl(${(i * 47) % 360},${i % 2 ? 12 : 34}%,${60 + (i % 3) * 6}%)`;
      rr(ctx, -ql / 2, -qh / 2, ql, qh, 2.4);
      // local frame: ang points DOWN-ramp, so the cars' direction of travel
      // (up-ramp, toward the meter) is −x → windshield & headlights sit at −x
      ctx.fillStyle = 'rgba(14,23,38,.78)'; rr(ctx, -4.6, -qh / 2 + 1, 4, qh - 2, 1.2); // windshield
      ctx.fillStyle = 'rgba(255,255,255,.12)'; rr(ctx, -ql / 2 + 1, -qh / 2 + 0.8, ql - 2, qh * 0.32, 1);
      ctx.fillStyle = '#ffedb0';               // headlights facing up-ramp
      ctx.fillRect(-ql / 2 + 0.4, -qh / 2 + 0.8, 1.4, 1.6);
      ctx.fillRect(-ql / 2 + 0.4, qh / 2 - 2.4, 1.4, 1.6);
      ctx.restore();
    }
  }
  if (sim.rampQueue > 5) {
    ctx.fillStyle = '#dfe2ea'; ctx.font = '11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('+' + (sim.rampQueue - 5), cBotX, appBot + 14);
    ctx.textAlign = 'left';
  }

  // ramp meter: two-lamp signal head on a post just inside the accel-lane entry
  if (sim.meterOn) {
    const green = sim.meterTimer >= sim.meterInterval - 1;
    const mx = cTopX - 4, my = ay + 6;
    ctx.fillStyle = '#3c3e45'; ctx.fillRect(mx + 3, my + 16, 2, 9);   // pole
    ctx.fillStyle = '#15161b'; rr(ctx, mx, my, 9, 17, 2);            // housing
    ctx.beginPath(); ctx.arc(mx + 4.5, my + 5, 2.6, 0, 7);
    ctx.fillStyle = green ? '#46221f' : '#ff5148'; ctx.fill();
    ctx.beginPath(); ctx.arc(mx + 4.5, my + 12, 2.6, 0, 7);
    ctx.fillStyle = green ? '#46e07c' : '#1d4a2c'; ctx.fill();
    ctx.fillStyle = green ? 'rgba(70,224,124,.25)' : 'rgba(255,81,72,.25)';
    ctx.beginPath(); ctx.arc(mx + 4.5, green ? my + 12 : my + 5, 6, 0, 7); ctx.fill();
  }

  // incident: skid marks, crashed car skewed across the lane, cones, flare
  if (sim.incident && cfg().hasIncident) {
    const ix = INCIDENT_CELL * c, iy = top + (sim.lanes - 1) * LANE_H, yc = iy + LANE_H / 2;
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ix - 26, yc - 4); ctx.quadraticCurveTo(ix - 10, yc - 6, ix - 1, yc - 2);
    ctx.moveTo(ix - 26, yc + 3); ctx.quadraticCurveTo(ix - 12, yc + 2, ix - 1, yc + 4);
    ctx.stroke();
    ctx.save();
    ctx.translate(ix + c * 0.45, yc); ctx.rotate(0.42);
    const cl = Math.max(12, c * CAR_LEN), chh = LANE_H * 0.55;
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(-cl / 2 + 1, -chh / 2 + 1.5, cl, chh);
    ctx.fillStyle = '#7d828d'; rr(ctx, -cl / 2, -chh / 2, cl, chh, 2);
    ctx.fillStyle = 'rgba(18,26,38,.8)'; ctx.fillRect(cl * 0.08, -chh / 2 + 1, 2, chh - 2);
    ctx.fillStyle = '#4c4f57'; ctx.fillRect(cl / 2 - 3, -chh / 2, 3, chh);  // crumpled nose
    ctx.restore();
    // pulsing hazard-flare glow
    ctx.fillStyle = '#ff8c2e';
    ctx.globalAlpha = 0.18 + 0.10 * Math.sin(performance.now() / 250);
    ctx.beginPath(); ctx.arc(ix - 8, yc + 5, 9, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
    // traffic cones with reflective bands
    for (let k = 0; k < 3; k++) {
      const cx2 = ix - 7 - k * 8, cy2 = iy + LANE_H * 0.78;
      ctx.fillStyle = '#ff8c2e';
      ctx.beginPath();
      ctx.moveTo(cx2 - 2.6, cy2); ctx.lineTo(cx2 + 2.6, cy2); ctx.lineTo(cx2, cy2 - 7);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillRect(cx2 - 1.4, cy2 - 4.4, 2.8, 1.3);
    }
  }
}

//—— City static layer: night sky, skyline, sidewalks, asphalt, crosswalks,
//    signal poles/housings, streetlights with light pools, sensor ——
// Signal-head geometry shared with the dynamic lamp pass in drawCityScene().
function signalHeadX(lc) { return lc * cw() - 5; }
function signalHeadY() { return roadTop() - 46; }

function buildCityStatic(g) {
  const top = roadTop(), rh = sim.lanes * LANE_H, c = cw();
  const rnd = sceneRand(902101);

  // night sky → street-level glow → ground
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#0f1220'); sky.addColorStop(0.3, '#171927');
  sky.addColorStop(0.55, '#1d1e26'); sky.addColorStop(1, '#16171c');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 70; i++) {                       // stars
    g.fillStyle = `rgba(225,232,255,${(0.2 + rnd() * 0.5).toFixed(2)})`;
    g.fillRect(rnd() * W, rnd() * (top - 80), 1, 1);
  }
  g.fillStyle = '#d9dce8';                             // crescent moon
  g.beginPath(); g.arc(W * 0.86, 34, 11, 0, 7); g.fill();
  g.fillStyle = '#11131f';
  g.beginPath(); g.arc(W * 0.86 - 5, 31, 9.5, 0, 7); g.fill();

  // distant skyline behind the foreground blocks (stable, for depth)
  let bx = -10;
  while (bx < W) {
    const bw = 24 + rnd() * 50, bh = 46 + rnd() * 56;
    g.fillStyle = `hsl(230,12%,${(11 + rnd() * 4).toFixed(1)}%)`;
    g.fillRect(bx, top - 14 - bh, bw, bh);
    if (rnd() < 0.5) {                                 // faint distant windows
      g.fillStyle = 'rgba(200,215,255,.10)';
      for (let wy = top - 8 - bh; wy < top - 26; wy += 9)
        g.fillRect(bx + 3 + rnd() * (bw - 8), wy, 2, 3);
    }
    bx += bw + 4 + rnd() * 14;
  }

  // foreground buildings from sim.buildings, enriched with varied rooflines,
  // rooftop details and antennas (deterministic via the shared rnd stream)
  for (const b of sim.buildings) {
    const x = b.c0 * c, w = b.w * c - 2;
    const y = b.side === 'top' ? top - 14 - b.h : top + rh + 14;
    const fg = g.createLinearGradient(x, 0, x + w, 0); // side-lit facade
    fg.addColorStop(0, `hsl(228,10%,${b.shade + 4}%)`);
    fg.addColorStop(1, `hsl(228,12%,${Math.max(10, b.shade - 5)}%)`);
    g.fillStyle = fg; g.fillRect(x, y, w, b.h);
    g.fillStyle = `hsl(228,8%,${b.shade + 10}%)`;      // parapet cap
    if (b.side === 'top') g.fillRect(x - 1, y - 2, w + 2, 2.5);
    else g.fillRect(x - 1, y + b.h - 0.5, w + 2, 2.5);
    if (b.win) {
      g.fillStyle = 'rgba(255,214,120,.5)';
      for (let wx = x + 3; wx < x + w - 4; wx += 7)
        for (let wy = y + 4; wy < y + b.h - 5; wy += 8)
          if ((wx * 7 + wy * 13) % 5 < 2) g.fillRect(wx, wy, 3, 4);
      g.fillStyle = 'rgba(150,200,255,.30)';           // a few cool TV-glow panes
      for (let wx = x + 3; wx < x + w - 4; wx += 7)
        for (let wy = y + 4; wy < y + b.h - 5; wy += 8)
          if ((wx * 11 + wy * 17) % 23 < 1) g.fillRect(wx, wy, 3, 4);
    }
    if (b.side === 'top') {                            // rooftop furniture
      const r = rnd();
      if (r < 0.3 && w > 24) {                         // water tank
        const tx = x + 4 + rnd() * (w - 14);
        g.fillStyle = '#34353f'; g.fillRect(tx, y - 9, 9, 8);
        g.fillStyle = '#3f414c';
        g.beginPath(); g.moveTo(tx - 1, y - 9); g.lineTo(tx + 10, y - 9);
        g.lineTo(tx + 4.5, y - 13); g.closePath(); g.fill();
      } else if (r < 0.55 && w > 18) {                 // AC / vent boxes
        g.fillStyle = '#3b3d48';
        g.fillRect(x + w * 0.18, y - 4, 7, 4);
        g.fillRect(x + w * 0.55, y - 5.5, 9, 5.5);
      } else if (r < 0.72 && w > 14) {                 // stepped penthouse
        g.fillStyle = `hsl(228,10%,${b.shade + 2}%)`;
        g.fillRect(x + w * 0.25, y - 7, w * 0.45, 7);
        g.fillStyle = `hsl(228,8%,${b.shade + 10}%)`;
        g.fillRect(x + w * 0.25 - 1, y - 8.5, w * 0.45 + 2, 2);
      }
      if (rnd() < 0.3) {                               // antenna with beacon
        const ax = x + w * (0.2 + rnd() * 0.6), ah = 10 + rnd() * 9;
        g.strokeStyle = '#565866'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(ax, y); g.lineTo(ax, y - ah); g.stroke();
        g.fillStyle = '#e85149'; g.fillRect(ax - 1, y - ah - 1.5, 2, 2);
      }
    } else if (rnd() < 0.35 && w > 20) {               // street-level awning
      g.fillStyle = `hsl(${(rnd() * 360) | 0},30%,32%)`;
      g.fillRect(x + 2, y - 0.5, Math.min(w - 4, 18), 3);
    }
  }

  // sidewalks with expansion joints, then curbs (drawn after the asphalt)
  g.fillStyle = '#4d4e56';
  g.fillRect(0, top - 12, W, 12); g.fillRect(0, top + rh, W, 12);
  g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 1;
  g.beginPath();
  for (let x = 12; x < W; x += 34) {
    g.moveTo(x, top - 12); g.lineTo(x, top);
    g.moveTo(x + 17, top + rh); g.lineTo(x + 17, top + rh + 12);
  }
  g.stroke();

  // asphalt + edge lines + dashes
  paintAsphalt(g, top, rh, rnd);
  g.fillStyle = '#e4e5e9';
  g.fillRect(0, top + 1.5, W, 2); g.fillRect(0, top + rh - 3.5, W, 2);
  paintLaneDashes(g, top);

  // curb lines: lit face on the near curb, shadow under the far one
  g.fillStyle = '#71737e'; g.fillRect(0, top - 2.5, W, 2.5);
  g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(0, top - 2.5, W, 1);
  g.fillStyle = '#5e606b'; g.fillRect(0, top + rh, W, 2);
  g.fillStyle = 'rgba(0,0,0,.30)'; g.fillRect(0, top + rh, W, 1);

  // crosswalk zebras, stop lines, signal pole + housing at each light
  for (const lc of cfg().lightCells) {
    const x = (lc + 1) * c, zw = Math.max(10, c * 1.6);
    g.fillStyle = 'rgba(0,0,0,.14)';                   // worn patch under the zebra
    g.fillRect(x - 2, top, zw + 4, rh);
    g.fillStyle = 'rgba(232,233,238,.88)';
    for (let y = top + 3; y < top + rh - 3; y += 7) g.fillRect(x, y, zw, 4);
    g.fillStyle = '#e8e8e8';                           // stop line
    g.fillRect(lc * c - 3, top + 2, 3, rh - 4);

    const sx = signalHeadX(lc), sy = signalHeadY();
    g.fillStyle = '#23242b';                           // pole down to the sidewalk
    g.fillRect(sx + 4, sy + 27, 3, top - 10 - (sy + 27));
    g.fillStyle = '#2c2d35'; g.fillRect(sx + 2, top - 11, 7, 3);
    g.fillStyle = '#0d0e12'; rr(g, sx - 2, sy - 2, 15, 33, 3);  // backplate
    g.fillStyle = '#1a1b21'; rr(g, sx, sy, 11, 29, 2);          // housing
    g.fillStyle = '#33343c';                           // dark lamps (lit per frame)
    for (let k = 0; k < 3; k++) {
      g.beginPath(); g.arc(sx + 5.5, sy + 5.5 + k * 9, 3.4, 0, 7); g.fill();
    }
    g.fillStyle = '#0b0c10';                           // visors
    for (let k = 0; k < 3; k++) g.fillRect(sx + 1.5, sy + 1 + k * 9, 8, 1.5);
  }

  // streetlights: curved poles with warm light pools on the roadway,
  // mirrored on the far side to match the mirrored skyline
  for (const [cell, side] of [[10, 0], [36, 0], [61, 0], [23, 1], [55, 1], [78, 1]]) {
    const x = cell * c;
    const by = side ? top + rh + 3 : top - 3;          // base at the curb
    const dir = side ? 1 : -1;                         // pole extends off-road
    g.strokeStyle = '#3a3c46'; g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x, by); g.lineTo(x, by + dir * 32);
    g.quadraticCurveTo(x, by + dir * 41, x + 10, by + dir * 41);
    g.stroke();
    g.fillStyle = '#ffd98f';                           // lamp head
    rr(g, x + 7, by + dir * 41 - 1.5, 8, 3, 1.5);
    g.fillStyle = 'rgba(255,214,140,.16)';             // halo at the head
    g.beginPath(); g.arc(x + 11, by + dir * 40, 7, 0, 7); g.fill();
    const py = side ? top + rh - 8 : top + 8;          // soft pool on the road
    const pg = g.createRadialGradient(x + 11, py, 2, x + 11, py, 34);
    pg.addColorStop(0, 'rgba(255,210,130,.15)');
    pg.addColorStop(1, 'rgba(255,210,130,0)');
    g.fillStyle = pg;
    g.beginPath(); g.ellipse(x + 11, py, 34, 12, 0, 0, 7); g.fill();
  }

  if (sim.weather === 'rain') paintWetSheen(g, top, rh);
  drawSensor(g, top, rh);
}

//—— City dynamic layer: live signal lamps over the static housings ——
const LAMP_IDX = { red: 0, yellow: 1, green: 2 };
const LAMP_COLS = ['#ff5148', '#ffd23e', '#46e07c'];
const LAMP_GLOWS = ['rgba(255,81,72,.28)', 'rgba(255,210,62,.28)', 'rgba(70,224,124,.28)'];

function drawCityScene() {
  const cells = cfg().lightCells, sy = signalHeadY();
  for (let i = 0; i < cells.length; i++) {
    const k = LAMP_IDX[lightState(i)];
    const lx = signalHeadX(cells[i]) + 5.5, ly = sy + 5.5 + k * 9;
    ctx.fillStyle = LAMP_GLOWS[k];                     // glow, ramp-meter style
    ctx.beginPath(); ctx.arc(lx, ly, 6.5, 0, 7); ctx.fill();
    ctx.fillStyle = LAMP_COLS[k];
    ctx.beginPath(); ctx.arc(lx, ly, 3.4, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.5)';            // hot core
    ctx.beginPath(); ctx.arc(lx - 0.9, ly - 0.9, 1.1, 0, 7); ctx.fill();
  }
}

function drawSensor(g, top, rh) {
  const x = SENSOR_CELL * cw();
  g.strokeStyle = 'rgba(77,163,255,.35)'; g.lineWidth = 1; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(x, top); g.lineTo(x, top + rh); g.stroke();
  g.setLineDash([]);
}

//—— Vehicles: shadowed, lit bodies (cab+trailer trucks), Hermite-interpolated
//   between ticks (position AND velocity matched at tick boundaries) ——
// Cars travel left→right: front/headlights at x+len, rear/taillights at x.
// Bodies are drawn at exactly car.len × cw() px long so bumper gaps on screen
// match the physics, and ~0.62 × LANE_H wide so a car fills a realistic share
// of its lane. car.color is the profile-coded paint and stays the dominant
// read; fine details are gated on the ON-SCREEN size (len × zoom) so vehicles
// degrade to clean silhouettes when small and bloom with detail when zoomed.
// A car mid lane change is rotated by its steering tilt (save/translate/rotate
// only while turning — straight-line traffic stays on the cheap path).

// Real-rate blinker (~1.5 Hz, 55% duty), de-phased per car by id so the fleet
// doesn't flash in lockstep like a Christmas tree.
function blinkOn(car) { return ((nowMs / 667 + car.id * 0.41) % 1) < 0.55; }

// Spawn/despawn smoothing. `tracked` remembers which cars existed last frame:
// a car that VANISHED becomes a short render-only ghost that drives out of
// the world (down the exit ramp, or off the right edge) instead of popping
// away mid-screen; a car that APPEARED gets an entry glide (in from the left
// edge, or up the on-ramp approach) instead of materialising in place.
const tracked = new Map();        // id → car, as of the previous frame
let trackTime = -1;               // sim.time of that frame (reset detection)
const ghosts = [];                // { car, x, y, rot, alpha, t, kind }
const EXIT_RAMP_ANGLE = Math.atan2(1, 0.55);   // painted off-ramp tangent

function updateCarTracking() {
  if (sim.time < trackTime) {                  // sim was reset: drop everything
    tracked.clear(); ghosts.length = 0;
  }
  const wasTracking = trackTime >= 0 && sim.time >= trackTime;
  let gone = null;
  if (wasTracking) {
    const live = new Set();
    for (const car of sim.cars) live.add(car.id);
    for (const [id, car] of tracked) {
      if (!live.has(id)) (gone || (gone = [])).push(car);
    }
    // A mass disappearance is a scenario/lane rebuild, not traffic — no ghosts.
    if (gone && gone.length <= 4 && !sim.paused) {
      const c = cw();
      for (const car of gone) {
        if (car.drawX === undefined) continue;
        // Off-ramp departure: a car that vanished from the DECELERATION lane (aux
        // row) at the gore drives off down the ramp as a curving ghost.
        if (offRampActive() && (car.lane === rampLaneIdx() || car.lane2 === rampLaneIdx()) &&
            Math.abs((car.drawX + car.drawLen) - decelEnd() * c) < c * 5) {
          ghosts.push({ car, x: car.drawX, y: car.drawY, rot: 0, alpha: 1, t: 0, kind: 'exit' });
        } else if (car.drawX + car.drawLen > (N - 6) * c) {
          ghosts.push({ car, x: car.drawX, y: car.drawY, rot: 0, alpha: 1, t: 0, kind: 'edge' });
        }
      }
    }
    for (const car of sim.cars) {
      if (!tracked.has(car.id)) {              // first frame of this car's life
        car.inWall = nowMs;
        car.inKind = (cfg().hasRamp && car.lane === rampLaneIdx()) ? 'ramp'
                   : car.cell < 3 ? 'edge' : '';
      }
    }
  }
  tracked.clear();
  for (const car of sim.cars) tracked.set(car.id, car);
  trackTime = sim.time;
}

// Ghosts integrate their position per frame, blending the travel direction
// from straight-ahead into the ramp tangent over ~0.4 s, so an exiting car
// follows a smooth curve through the gore point — no kink, no teleport.
function drawGhosts(c) {
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i];
    const life = g.kind === 'exit' ? 850 : 400;
    if (!sim.paused) {                         // paused ⇒ ghosts freeze too
      g.t += frameDt;
      if (g.t >= life) { ghosts.splice(i, 1); continue; }
      if (g.kind === 'exit') {
        const k = Math.min(1, g.t / 420);
        g.rot = EXIT_RAMP_ANGLE * k * k * (3 - 2 * k);  // ease into the ramp heading
      }
      const sp = Math.max(0.6, g.car.v) * c * (frameDt / TICK_MS);  // px this frame
      g.x += sp * Math.cos(g.rot);
      g.y += sp * Math.sin(g.rot);
      g.alpha = Math.min(1, 2 * (1 - g.t / life));      // hold, then fade out
    }
    const len = g.car.drawLen;
    ctx.save();
    ctx.globalAlpha = Math.max(0, g.alpha);
    ctx.translate(g.x + len / 2, g.y);
    ctx.rotate(g.rot);
    (g.car.isTruck ? drawTruck : drawCar)(g.car, -len / 2, 0, len, blinkOn(g.car));
    ctx.restore();
  }
}

function drawCars(a) {
  const top = roadTop(), c = cw();
  updateCarTracking();
  drawGhosts(c);
  for (const car of sim.cars) {
    const pos = lerpPos(car, a);
    // Lateral position: a car mid lane change follows the engine's exact
    // smoothstep S-curve, evaluated at the inter-tick phase tt — the same
    // curve the engine samples once per second — so the slide is slow-fast-
    // slow with no per-tick corners, and the body yaw is the curve's TRUE
    // lateral velocity (peaks mid-change, settles back), always in sync with
    // the sideways motion. Straight-line cars take the cheap lerp path.
    const prevT = car.prevLaneT !== undefined ? car.prevLaneT : 1;
    let laneF, tilt;
    if (car.laneT < 1 || prevT < 1) {
      const t0 = prevT <= car.laneT ? prevT : 0;        // restarted curve ⇒ from 0
      const tt = t0 + (car.laneT - t0) * a;
      const span = car.laneTo - car.laneFrom;
      laneF = car.laneFrom + span * tt * tt * (3 - 2 * tt);
      const latV = span * 6 * tt * (1 - tt) / LANE_CHANGE_TIME;
      tilt = Math.max(-0.20, Math.min(0.20, latV * 0.34));
    } else {
      laneF = car.prevLane + (car.laneCoord - car.prevLane) * a;
      tilt = car.prevTilt + (car.tilt - car.prevTilt) * a;
    }
    let x = pos * c;
    let y = top + laneF * LANE_H + LANE_H / 2;
    const len = car.len * c;                  // body length in px = physics length
    let rot = tilt, alpha = 1;

    // Entry glide: back-extrapolate a newcomer along its path of travel (off
    // the left edge, or down the ramp approach) and slide it in at its own
    // speed, with a quick fade, so it joins the flow with no pop and no kink
    // at the merge point. The offset decays to zero exactly as the engine's
    // own motion takes over.
    if (car.inWall !== undefined) {
      // The glide spans exactly one tick: the offset reaches zero at the same
      // moment the engine's own integration starts moving the car, so the
      // hand-off is velocity-continuous (no surge, no hitch).
      const u = (nowMs - car.inWall) / TICK_MS;
      if (u >= 1) car.inWall = undefined;
      else {
        alpha = Math.min(1, 0.25 + u * 1.5);
        const d = car.v * (1 - u) * c;                  // distance back along path
        if (car.inKind === 'edge') {
          x -= d;
        } else if (car.inKind === 'ramp') {
          const gm = approachGeom();
          x -= d * Math.cos(gm.heading);
          y -= d * Math.sin(gm.heading);
          const e = u * u * (3 - 2 * u);
          rot += gm.heading * (1 - e);                  // heading eases ramp → lane
        }
      }
    }

    // World-space footprint of this frame's draw, kept for click hit-testing
    // and the selection highlight.
    car.drawX = x; car.drawY = y; car.drawLen = len;
    const blink = blinkOn(car);
    if (alpha < 1) ctx.globalAlpha = alpha;
    if (Math.abs(rot) > 0.004) {              // steering across the line
      ctx.save();
      ctx.translate(x + len / 2, y);
      ctx.rotate(rot);
      if (car.isTruck) drawTruck(car, -len / 2, 0, len, blink);
      else drawCar(car, -len / 2, 0, len, blink);
      ctx.restore();
    } else if (car.isTruck) drawTruck(car, x, y, len, blink);
    else drawCar(car, x, y, len, blink);
    if (alpha < 1) ctx.globalAlpha = 1;
  }
}

// Pulsing ring around the clicked vehicle, drawn in world space so it tracks
// the car through lane changes and zoom. Line width compensates for zoom so
// the ring stays a consistent on-screen weight.
function drawSelection() {
  const car = sim.selected;
  if (!car || car.drawX === undefined || !sim.cars.includes(car)) return;
  const h = car.drawH || LANE_H * 0.62, pad = 3;
  const pulse = 0.55 + 0.30 * Math.sin(performance.now() / 240);
  ctx.lineWidth = 1.4 / cam.z + 0.8;
  ctx.strokeStyle = `rgba(88,166,255,${pulse.toFixed(3)})`;
  ctx.strokeRect(car.drawX - pad, car.drawY - h / 2 - pad,
                 car.drawLen + pad * 2, h + pad * 2);
  ctx.lineWidth = (1.4 / cam.z + 0.8) * 3;
  ctx.strokeStyle = 'rgba(88,166,255,.14)';
  ctx.strokeRect(car.drawX - pad, car.drawY - h / 2 - pad,
                 car.drawLen + pad * 2, h + pad * 2);
}

// Rear (taillights / brake glow) + front (headlights) + blinking turn signals,
// shared by cars and trucks. yt/h bound the body the lights attach to.
// car.signal: −1 = changing toward a lower lane index (screen-up), +1 = toward
// a higher index (screen-down); amber corner lamps blink on that side, front
// and rear, through the whole signal → merge sequence.
function drawVehicleLights(car, x, len, yt, h, blink) {
  const lh = Math.max(1.6, h * 0.20);                  // lamp height scales w/ body
  const lw = Math.max(1.3, len * 0.045);               // lamp width
  const inset = Math.max(1, h * 0.10);                 // keep lamps off the edges
  // Brake lamps hold for a minimum ~350 ms after the engine's per-tick braking
  // flag last fired, so marginal tick-to-tick decelerations read as one steady
  // light instead of a 5 Hz flicker. (Real brake lights also latch on for the
  // whole pedal application, not per-instant deceleration sign.)
  if (car.braking) car.brakeWall = nowMs;
  if (car.braking || nowMs - (car.brakeWall || -1e9) < 350) {
    ctx.fillStyle = 'rgba(255,59,48,.35)';             // brake-light glow
    ctx.fillRect(x - 2.4, yt + 0.5, 3.2, h - 1);
    ctx.fillStyle = '#ff3b30';
  } else ctx.fillStyle = '#b04038';
  ctx.fillRect(x, yt + inset, lw, lh);                 // taillights (both corners)
  ctx.fillRect(x, yt + h - inset - lh, lw, lh);
  ctx.fillStyle = '#ffedb0';                           // headlights
  ctx.fillRect(x + len - lw - 0.4, yt + inset, lw + 0.4, lh);
  ctx.fillRect(x + len - lw - 0.4, yt + h - inset - lh, lw + 0.4, lh);
  if (car.signal && blink) {                           // turn indicators
    const sz = Math.max(2.2, h * 0.24);
    const sy = car.signal > 0 ? yt + h - sz * 0.55 : yt - sz * 0.45;
    ctx.fillStyle = 'rgba(255,176,46,.40)';            // glow halo
    ctx.fillRect(x - 1.2, sy - 1.2, sz + 2.4, sz + 2.4);
    ctx.fillRect(x + len - sz - 1.2, sy - 1.2, sz + 2.4, sz + 2.4);
    ctx.fillStyle = '#ffb02e';                         // amber lamps, fore & aft
    ctx.fillRect(x, sy, sz, sz);
    ctx.fillRect(x + len - sz, sy, sz, sz);
  }
}

// Pitch cue: a tiny, eased longitudinal shadow shift — braking dives the nose
// (shadow slips rearward under the body), hard acceleration squats the tail.
// One lerp + one offset per vehicle; reads as weight transfer at a glance.
function bodyPitch(car, len) {
  const target = car.braking ? 1 : car.accel > 0.06 ? -0.6 : 0;
  car.pitch = (car.pitch || 0) + (target - (car.pitch || 0)) * Math.min(1, frameDt / 160);
  return -car.pitch * len * 0.03;
}

// Top-down car body outline: rounded rear, tapered/rounded front (hood).
// Builds a path on g; caller sets fillStyle and calls fill() (or stroke()).
// Radius clamped so it stays valid at tiny len. front = +x edge, rear = x edge.
function carBody(g, x, yt, len, h) {
  const rRear = Math.min(h * 0.30, len * 0.22);        // squarer rear corners
  const rFront = Math.min(h * 0.46, len * 0.30);       // rounder hood corners
  g.beginPath();
  g.moveTo(x + rRear, yt);
  g.lineTo(x + len - rFront, yt);
  g.arcTo(x + len, yt, x + len, yt + h, rFront);        // front-top hood curve
  g.arcTo(x + len, yt + h, x, yt + h, rFront);          // front-bottom hood curve
  g.lineTo(x + rRear, yt + h);
  g.arcTo(x, yt + h, x, yt, rRear);                     // rear-bottom corner
  g.arcTo(x, yt, x + len, yt, rRear);                  // rear-top corner
  g.closePath();
}

function drawCar(car, x, y, len, blink) {
  // Width ≈ 51% of the lane: a real car ≈ 1.8 m sits in a ~3.6 m lane, so the
  // body leaves a believable margin of asphalt on each side rather than
  // filling the lane. Capped against len so it always reads longer than wide.
  const h = Math.min(LANE_H * 0.51, len * 0.52), yt = y - h / 2;
  car.drawH = h;
  // Detail gates use the ON-SCREEN size, so zooming in reveals wheels,
  // glass and mirrors even when the world-space body is small.
  const lod = len * cam.z;

  ctx.fillStyle = 'rgba(0,0,0,.30)';                   // soft drop shadow
  rr(ctx, x + 1 + bodyPitch(car, len), yt + 1.7, len, h, h * 0.34);

  if (lod > 12) {                                      // wheels proud of the sides
    ctx.fillStyle = '#0e1014';
    const ww = Math.max(2.4, len * 0.16), wh = Math.max(1.8, h * 0.20);
    const rearX = x + len * 0.10, frontX = x + len * 0.70;
    rr(ctx, rearX, yt - wh * 0.40, ww, wh, wh * 0.35);  // top side, both axles
    rr(ctx, frontX, yt - wh * 0.40, ww, wh, wh * 0.35);
    rr(ctx, rearX, yt + h - wh * 0.60, ww, wh, wh * 0.35); // bottom side
    rr(ctx, frontX, yt + h - wh * 0.60, ww, wh, wh * 0.35);
  }

  ctx.fillStyle = car.color;                           // painted body
  carBody(ctx, x, yt, len, h);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.28)';                 // crisp body rim
  ctx.lineWidth = Math.max(0.7, h * 0.055);
  carBody(ctx, x, yt, len, h);
  ctx.stroke();

  if (lod > 10) {                                      // curvature shading
    ctx.fillStyle = 'rgba(0,0,0,.13)';                 // darker lower flank
    rr(ctx, x + len * 0.05, yt + h * 0.66, len * 0.88, h * 0.24, h * 0.12);
    ctx.fillStyle = 'rgba(255,255,255,.12)';           // lit upper flank
    rr(ctx, x + len * 0.07, yt + h * 0.10, len * 0.84, h * 0.18, h * 0.09);
  }

  if (lod > 14) {                                      // full greenhouse
    const gIn = h * 0.14;
    ctx.fillStyle = 'rgba(14,23,38,.88)';              // glass band: rear window
    rr(ctx, x + len * 0.225, yt + gIn, len * 0.50, h - gIn * 2, h * 0.20); // → windshield
    ctx.fillStyle = car.color;                         // roof panel on the glass
    rr(ctx, x + len * 0.345, yt + gIn + h * 0.07, len * 0.225, h - gIn * 2 - h * 0.14, h * 0.12);
    ctx.fillStyle = 'rgba(255,255,255,.15)';           // roof catches the light
    rr(ctx, x + len * 0.345, yt + gIn + h * 0.07, len * 0.225, h - gIn * 2 - h * 0.14, h * 0.12);
    ctx.fillStyle = 'rgba(165,200,240,.30)';           // windshield glint
    rr(ctx, x + len * 0.60, yt + gIn + 1, len * 0.07, h - gIn * 2 - 2, 1.2);
    ctx.fillStyle = car.color;                         // side mirrors at the A-pillar
    const mw = Math.max(1.4, len * 0.06), mh = Math.max(1.4, h * 0.14);
    ctx.fillRect(x + len * 0.585, yt - mh + 0.4, mw, mh);
    ctx.fillRect(x + len * 0.585, yt + h - 0.4, mw, mh);
  } else if (lod > 7) {                                 // small: single glass cabin
    ctx.fillStyle = 'rgba(14,23,38,.82)';
    rr(ctx, x + len * 0.30, yt + h * 0.18, len * 0.42, h * 0.64, 1.5);
  }

  if (lod > 24) {                                      // hood + trunk seam lines
    ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x + len * 0.80, yt + h * 0.16); ctx.lineTo(x + len * 0.80, yt + h * 0.84);
    ctx.moveTo(x + len * 0.16, yt + h * 0.20); ctx.lineTo(x + len * 0.16, yt + h * 0.80);
    ctx.stroke();
  }

  drawVehicleLights(car, x, len, yt, h, blink);
}

function drawTruck(car, x, y, len, blink) {
  // Wider than a car (a tractor-trailer is ≈2.6 m vs 1.8 m) but still inside
  // its lane; much longer, drawn as cab + boxed trailer.
  const h = Math.min(LANE_H * 0.60, len * 0.26), yt = y - h / 2;
  car.drawH = h;
  const lod = len * cam.z;                             // on-screen size gates detail

  ctx.fillStyle = 'rgba(0,0,0,.32)';                   // soft drop shadow
  rr(ctx, x + 1 + bodyPitch(car, len), yt + 1.9, len, h, h * 0.22);

  if (lod < 18) {                                      // too small for cab/trailer
    ctx.fillStyle = car.color;
    rr(ctx, x, yt, len, h, 2);
    drawVehicleLights(car, x, len, yt, h, blink);
    return;
  }
  const cabLen = len * 0.205, gap = len * 0.02;
  const trLen = len - cabLen - gap;                    // trailer + visible gap
  const cabX = x + trLen + gap;

  // wheels: trailer tandems (rear), tractor drives (under the kingpin), steer
  ctx.fillStyle = '#0e1014';
  const wh = Math.max(2, h * 0.18), ww = Math.max(2.4, len * 0.035);
  for (const fx of [0.05, 0.11, 0.66, 0.72, 0.93]) {
    rr(ctx, x + len * fx, yt - wh * 0.40, ww, wh, 1);
    rr(ctx, x + len * fx, yt + h - wh * 0.60, ww, wh, 1);
  }

  ctx.fillStyle = car.color;                           // boxy trailer…
  rr(ctx, x, yt, trLen, h, 1.5);
  ctx.fillStyle = 'rgba(255,255,255,.38)';             // …as a pale freight box
  rr(ctx, x, yt, trLen, h, 1.5);
  ctx.strokeStyle = 'rgba(18,20,28,.50)'; ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, yt + 0.5, Math.max(1, trLen - 1), Math.max(1, h - 1));
  if (lod > 28) {                                      // ribbed trailer roof
    ctx.strokeStyle = 'rgba(0,0,0,.10)';
    ctx.beginPath();
    for (let fx = x + 4; fx < x + trLen - 3; fx += 5.5) {
      ctx.moveTo(fx, yt + 1.5); ctx.lineTo(fx, yt + h - 1.5);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,.18)';                 // reefer unit at the nose
    ctx.fillRect(x + trLen - 2.5, yt + h * 0.2, 2, h * 0.6);
  }

  ctx.fillStyle = car.color;                           // cab (rounded snout)
  carBody(ctx, cabX, yt + h * 0.04, cabLen, h * 0.92);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,.30)'; ctx.lineWidth = 0.8;
  carBody(ctx, cabX, yt + h * 0.04, cabLen, h * 0.92);
  ctx.stroke();
  if (lod > 24) {
    ctx.fillStyle = 'rgba(14,23,38,.88)';              // cab windshield band
    rr(ctx, cabX + cabLen * 0.40, yt + h * 0.14, cabLen * 0.26, h * 0.72, 1.2);
    ctx.fillStyle = 'rgba(255,255,255,.14)';           // roof fairing sheen
    rr(ctx, cabX + cabLen * 0.05, yt + h * 0.20, cabLen * 0.30, h * 0.60, 2);
    ctx.fillStyle = car.color;                         // mirrors
    const mh = Math.max(1.6, h * 0.13);
    ctx.fillRect(cabX + cabLen * 0.42, yt - mh + 0.4, 1.6, mh);
    ctx.fillRect(cabX + cabLen * 0.42, yt + h - 0.4, 1.6, mh);
  }

  drawVehicleLights(car, x, len, yt, h, blink);
}

//—— Weather overlays (wet-road sheen lives in the static layer) ——
function drawWeatherOverlay() {
  if (sim.weather === 'rain') {
    ctx.fillStyle = 'rgba(38,52,82,.13)';              // dim blue storm cast
    ctx.fillRect(0, 0, W, H);
    const t = performance.now() / 4;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(165,193,235,.30)';         // far layer: short streaks,
    ctx.beginPath();                                   // per-streak slant variance
    for (let i = 0; i < 70; i++) {
      const x = (i * 137 + t * (0.9 + (i % 3) * 0.1)) % (W + 40) - 20;
      const y = (i * 89 + t * 1.6) % H;
      ctx.moveTo(x, y);
      ctx.lineTo(x - 2 - (i % 5) * 0.7, y + 7 + (i % 4) * 2);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(200,222,250,.38)';         // near layer: sparser,
    ctx.beginPath();                                   // longer, faster
    for (let i = 0; i < 22; i++) {
      const x = (i * 211 + t * 1.5) % (W + 40) - 20;
      const y = (i * 127 + t * 2.4) % H;
      ctx.moveTo(x, y); ctx.lineTo(x - 4.5 - (i % 3), y + 13);
    }
    ctx.stroke();
  } else if (sim.weather === 'fog') {
    if (fogGrad) {                                     // thin over the road,
      ctx.fillStyle = fogGrad;                         // thick at the edges
      ctx.fillRect(0, 0, W, H);
    }
    const t = performance.now() / 1000;                // slow-drifting banks
    ctx.fillStyle = 'rgba(206,213,224,.15)';
    for (let i = 0; i < 5; i++) {
      const span = W * (0.55 + (i % 3) * 0.18);
      const x = ((t * (6 + i * 2.4) + i * 320) % (W + span)) - span / 2;
      ctx.beginPath();
      ctx.ellipse(x, H * (0.10 + i * 0.19), span / 2, 14 + (i % 2) * 8, 0, 0, 7);
      ctx.fill();
    }
  }
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
        nowMs - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 26) {
      lastTap = null;
      zoomToggleAt(p.x, p.y);
      return;
    }
    lastTap = { t: nowMs, x: p.x, y: p.y };
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
