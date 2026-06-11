// Two-layer canvas renderer, camera (zoom/pan) and pointer input. All static
// scenery is pre-rendered into an offscreen canvas and blitted once per frame;
// vehicles, signal lamps, ramp meter and weather draw on top. Pointer input
// lives here because click-picking and panning are camera math.
import { N, TICK_MS, INCIDENT_CELL, SENSOR_CELL, CAR_LEN } from './config.js';
import {
  sim, cfg, offRampActive, rampLaneIdx, rampStart, rampEnd,
} from './state.js';
import { lightState } from './engine.js';
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
const cam = { z: 1, x: 0, y: 0 };
const ZOOM_MIN = 1, ZOOM_MAX = 6;
function clampCam() {
  cam.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.z));
  cam.x = Math.min(W - W / cam.z, Math.max(0, cam.x));
  cam.y = Math.min(H - H / cam.z, Math.max(0, cam.y));
}
// Zoom by `factor` keeping the world point under screen (sx, sy) fixed.
function zoomAt(sx, sy, factor) {
  const wx = sx / cam.z + cam.x, wy = sy / cam.z + cam.y;
  cam.z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cam.z * factor));
  cam.x = wx - sx / cam.z;
  cam.y = wy - sy / cam.z;
  clampCam();
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
// Interpolated position in cells, handling ring wrap.
function lerpPos(car, a) {
  let to = car.cell;
  if (to < car.prevCell) to += N;
  return (car.prevCell + (to - car.prevCell) * a) % N;
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
  g.fillStyle = '#d9dade';
  const dash = Math.max(9, cw() * 2), gap = dash * 1.7;
  for (let l = 1; l < sim.lanes; l++) {
    const y = top + l * LANE_H - 1;
    for (let x = 4; x < W; x += dash + gap) g.fillRect(x, y, dash, 2);
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
  const a = sim.paused ? 1 : Math.min(1, (performance.now() - sim.lastTickWall) / TICK_MS);
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
  g.fillStyle = '#e6c84e'; g.fillRect(0, top + 1.5, W, 2);   // yellow left-edge line
  g.fillStyle = '#e4e5e9'; g.fillRect(0, ry - 3.5, W, 2);    // white right-edge line
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
  // mainline right-edge line becomes a dotted "merge" line across the accel zone
  g.fillStyle = '#3b3c41'; g.fillRect(rsX, ry - 4, reX - rsX, 4);
  g.fillStyle = '#e4e5e9';
  for (let x = rsX + 2; x < reX - 4; x += 13) g.fillRect(x, ry - 3.5, 7, 2);
  // accel-lane outer (white) edge line, following the taper into the boundary
  g.strokeStyle = '#e4e5e9'; g.lineWidth = 2;
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

  // ── Off-ramp (interchange): a wedge peeling off the rightmost mainline lane to
  //    the lower-right, opening at the boundary (ry) and dropping below the road.
  if (offRampActive()) {
    const ox = cfg().offRampCell * c;                  // exit gore point on the boundary
    const offDrop = Math.min(LANE_H * 2.4, (H - ay) * 0.5);
    const offW = LANE_H;                               // one ramp lane wide
    const mouth = LANE_H * 1.6;                         // how far back the mouth opens
    g.fillStyle = '#36373c';
    g.beginPath();
    g.moveTo(ox - mouth, ry); g.lineTo(ox, ry);        // mouth along the boundary
    g.lineTo(ox + offDrop * 0.55 + offW, ry + offDrop);
    g.lineTo(ox + offDrop * 0.55, ry + offDrop);
    g.closePath(); g.fill();
    // ramp edge lines (white)
    g.strokeStyle = '#caccd2'; g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(ox - mouth, ry); g.lineTo(ox + offDrop * 0.55, ry + offDrop);   // inner
    g.moveTo(ox, ry); g.lineTo(ox + offDrop * 0.55 + offW, ry + offDrop);    // outer
    g.stroke();
    // mainline right-edge line becomes dotted across the exit mouth
    g.fillStyle = '#3b3c41'; g.fillRect(ox - mouth, ry - 4, mouth + 2, 4);
    g.fillStyle = '#e4e5e9';
    for (let x = ox - mouth + 2; x < ox; x += 13) g.fillRect(x, ry - 3.5, 7, 2);
    // gore chevrons in the triangular nose just past the exit point
    g.strokeStyle = 'rgba(230,231,236,.6)'; g.lineWidth = 2;
    g.beginPath();
    for (let k = 1; k <= 3; k++) {
      const d = k * (offDrop / 4.5);
      g.moveTo(ox + d * 0.55, ry + d); g.lineTo(ox + d * 0.55 + d * 0.5, ry + d + 5);
    }
    g.stroke();
    // EXIT board on a post beside the ramp
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
    const ox = cfg().offRampCell * c;
    gaps.push([ox - LANE_H * 1.8, ox + LANE_H * 2.6]);
  }
  for (const s of railSegs(0, W, gaps)) drawGuardrail(g, s[0], s[1], railY);

  if (sim.weather === 'rain') {
    paintWetSheen(g, top, rh);
    g.fillStyle = 'rgba(170,195,235,.10)';            // accel lane gets the glaze too
    g.fillRect(rsX, ry, reX - rsX, LANE_H);
  }
  drawSensor(g, top, rh);
}

//—— Highway dynamic layer: ramp queue, meter signal, incident ——
function drawHighwayScene() {
  const top = roadTop(), rh = sim.lanes * LANE_H, c = cw();
  const ry = top + rh, ay = ry + LANE_H;
  const rsX = rampStart() * c;                          // accel-lane entry x
  // Approach geometry (mirrors buildHighwayStatic so cars/meter sit on the ramp)
  const appDrop = Math.min(LANE_H * 2.6, (H - ay) * 0.55);
  const appRun = appDrop * 0.62;
  const appBot = ay + appDrop;
  // Approach centreline: from the accel-lane entry down-left to the queue foot.
  const cTopX = rsX + LANE_H * 0.28, cBotX = (rsX - appRun) + LANE_H / 2;
  const ang = Math.atan2(appBot - ay, cBotX - cTopX);   // direction of travel up-ramp

  // queued cars stacked along the approach centreline, nose pointing up-ramp
  // (drawn at the same scale as live traffic so the queue reads as real cars)
  const q = Math.min(sim.rampQueue, 5);
  if (q > 0) {
    for (let i = 0; i < q; i++) {
      const t = 0.15 + i * 0.19;                        // 0=at meter, 1=foot of ramp
      ctx.save();
      ctx.translate(cTopX + (cBotX - cTopX) * t, ay + (appBot - ay) * t);
      ctx.rotate(ang);
      ctx.fillStyle = 'rgba(0,0,0,.3)'; rr(ctx, -8.4, -3.6, 17.4, 9, 2.6);
      ctx.fillStyle = '#a7adba'; rr(ctx, -9, -4.4, 17, 8.4, 2.8);
      ctx.fillStyle = 'rgba(18,26,38,.75)'; rr(ctx, 0.4, -3.3, 4, 6.6, 1.4);
      ctx.fillStyle = '#ffedb0'; ctx.fillRect(-8.8, -3.6, 1.4, 1.8);
      ctx.fillRect(-8.8, 1.8, 1.4, 1.8);
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

//—— Vehicles: shadowed, lit bodies (cab+trailer trucks), lerped between ticks ——
// Cars travel left→right: front/headlights at x+len, rear/taillights at x.
// Bodies are drawn at exactly car.len × cw() px long so bumper gaps on screen
// match the physics, and ~0.62 × LANE_H wide so a car fills a realistic share
// of its lane. car.color is the profile-coded paint and stays the dominant
// read; fine details are gated on the ON-SCREEN size (len × zoom) so vehicles
// degrade to clean silhouettes when small and bloom with detail when zoomed.
// A car mid lane change is rotated by its steering tilt (save/translate/rotate
// only while turning — straight-line traffic stays on the cheap path).

function drawCars(a) {
  const top = roadTop(), c = cw();
  const blink = Math.floor(performance.now() / 380) % 2 === 0;
  for (const car of sim.cars) {
    const pos = lerpPos(car, a);
    // Lerp the CONTINUOUS lane coordinate (prev → current) so a lane change
    // is drawn straddling the line as the body slides across.
    const laneF = car.prevLane + (car.laneCoord - car.prevLane) * a;
    const x = pos * c;
    const y = top + laneF * LANE_H + LANE_H / 2;
    const len = car.len * c;                  // body length in px = physics length
    const tilt = car.prevTilt + (car.tilt - car.prevTilt) * a;
    // World-space footprint of this frame's draw, kept for click hit-testing
    // and the selection highlight.
    car.drawX = x; car.drawY = y; car.drawLen = len;
    if (Math.abs(tilt) > 0.004) {             // steering across the line
      ctx.save();
      ctx.translate(x + len / 2, y);
      ctx.rotate(tilt);
      if (car.isTruck) drawTruck(car, -len / 2, 0, len, blink);
      else drawCar(car, -len / 2, 0, len, blink);
      ctx.restore();
    } else if (car.isTruck) drawTruck(car, x, y, len, blink);
    else drawCar(car, x, y, len, blink);
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
  if (car.braking) {
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
  // Width ≈ 62% of the lane (real car ≈ 1.8 m in a 3.7 m lane plus margin),
  // capped so the body always reads clearly longer than wide.
  const h = Math.min(LANE_H * 0.62, len * 0.56), yt = y - h / 2;
  car.drawH = h;
  // Detail gates use the ON-SCREEN size, so zooming in reveals wheels,
  // glass and mirrors even when the world-space body is small.
  const lod = len * cam.z;

  ctx.fillStyle = 'rgba(0,0,0,.30)';                   // soft drop shadow
  rr(ctx, x + 1, yt + 1.7, len, h, h * 0.34);

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
  // Wider than a car (~70% of the lane) and much longer; cab + boxed trailer.
  const h = Math.min(LANE_H * 0.70, len * 0.27), yt = y - h / 2;
  car.drawH = h;
  const lod = len * cam.z;                             // on-screen size gates detail

  ctx.fillStyle = 'rgba(0,0,0,.32)';                   // soft drop shadow
  rr(ctx, x + 1, yt + 1.9, len, h, h * 0.22);

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
  $('zoomLevel').textContent = cam.z.toFixed(1) + '×';
  canvas.style.cursor = cam.z > 1.001 ? 'grab' : '';
}

// One pointer-drag state machine distinguishes click (select) from pan.
let drag = null;
canvas.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  drag = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, panned: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
  drag.lx = e.clientX; drag.ly = e.clientY;
  if (!drag.panned &&
      Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
  drag.panned = true;
  if (cam.z > 1.001) {
    cam.x -= dx / cam.z;
    cam.y -= dy / cam.z;
    clampCam();
    canvas.style.cursor = 'grabbing';
  }
});
canvas.addEventListener('pointerup', e => {
  if (!drag) return;
  const wasPan = drag.panned;
  drag = null;
  updateZoomUI();                       // restore grab/default cursor
  if (wasPan) return;
  const p = canvasPos(e);
  selectCar(pickCar(p.x, p.y));
});
canvas.addEventListener('pointercancel', () => { drag = null; updateZoomUI(); });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const p = canvasPos(e);
  zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0014));
  updateZoomUI();
}, { passive: false });

$('zoomIn').addEventListener('click', () => { zoomAt(W / 2, H / 2, 1.35); updateZoomUI(); });
$('zoomOut').addEventListener('click', () => { zoomAt(W / 2, H / 2, 1 / 1.35); updateZoomUI(); });
$('zoomFit').addEventListener('click', () => { cam.z = 1; cam.x = cam.y = 0; updateZoomUI(); });
$('insClose').addEventListener('click', () => selectCar(null));

export {
  render, resizeCanvas, cam, clampCam, zoomAt, canvasPos, pickCar,
  LANE_H, roadTop, cw, updateZoomUI,
};
