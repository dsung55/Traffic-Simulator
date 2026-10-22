// Static scenery: painters for both scenarios, split into a GROUND layer
// (terrain, roads, markings, rails — drawn under the vehicles) and a TOP layer
// (overpass decks, light poles, street-tree canopies, signal mast arms —
// drawn over them). Both are painted in WORLD coordinates and cached:
//   • a base cache of the whole world at device resolution (the 1× view), and
//   • a zoom cache: when the camera settles above ~1.15×, the visible region
//     (plus a margin) is re-painted at the zoomed resolution, so lane lines,
//     asphalt grain and roofs stay crisp at 14× instead of being upscaled.
// The painters are deterministic (seeded PRNG, no viewport-dependent
// branching), so the zoom cache paints exactly the same world as the base.
import { N } from '../config.js';
import { sim, cfg } from '../state.js';
import { view, cam, camT, viewRect } from './view.js';
import { geo } from './geometry.js';
import { rr, sceneRand, lutPath, lutAt, clamp } from './util.js';
import { paintVehicle, bodyWidth } from './vehicles.js';

//──────────────────────── Shared textures ────────────────────────
let grainTile = null;
function grain(g, alpha) {
  if (!grainTile) {
    grainTile = document.createElement('canvas');
    grainTile.width = grainTile.height = 128;
    const t = grainTile.getContext('2d');
    const img = t.createImageData(128, 128);
    const r = sceneRand(99173);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = r();
      const c = v < 0.5 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = c;
      img.data[i + 3] = Math.floor(Math.abs(v - 0.5) * 2 * 60 * (r() < 0.6 ? 1 : 0.35));
    }
    t.putImageData(img, 0, 0);
  }
  const pat = g.createPattern(grainTile, 'repeat');
  // Keep the grain at ~device-pixel scale whatever the zoom.
  try {
    const m = g.getTransform();
    const s = Math.max(1, Math.sqrt(Math.abs(m.a * m.d)));
    pat.setTransform(new DOMMatrix([1 / s * 1.2, 0, 0, 1 / s * 1.2, 0, 0]));
  } catch { /* old browsers: plain pattern */ }
  g.globalAlpha = alpha;
  g.fillStyle = pat;
  return pat;
}

function weatherKind() { return sim.weather === 'snow' ? 'snow' : sim.weather === 'rain' ? 'rain' : 'dry'; }

// Palettes per weather.
function pal() {
  const w = weatherKind();
  if (w === 'snow') return {
    grass: '#e7edf2', grass2: '#d5dee7', grassHi: '#f6f9fb', mow: 'rgba(255,255,255,.35)',
    asphalt: '#55585e', asphalt2: '#5d6066', shoulder: '#6e7176', line: 'rgba(240,242,245,.72)',
    yellow: 'rgba(240,200,70,.7)', tree: ['#2e4a3a', '#36543f', '#2a4234'], treeSnow: true,
    field: ['#eef2f6', '#e3e9ef', '#f1f4f7', '#dfe6ed'], dirt: '#cfd6de', walk: '#dfe3e8', curb: '#eef1f4',
  };
  if (w === 'rain') return {
    grass: '#3f6230', grass2: '#365628', grassHi: '#4d7339', mow: 'rgba(120,170,90,.16)',
    asphalt: '#2c2e33', asphalt2: '#313338', shoulder: '#3a3c41', line: '#e3e6ea',
    yellow: '#e8c13a', tree: ['#2d5a2a', '#356b30', '#2a4f26'],
    field: ['#5b7a32', '#6f6a37', '#4a6c2e', '#5e4a33'], dirt: '#5d4f3e', walk: '#8e8b85', curb: '#a4a19a',
  };
  return {
    grass: '#5b8a3c', grass2: '#4f7a33', grassHi: '#6c9a47', mow: 'rgba(170,215,120,.16)',
    asphalt: '#3d3f45', asphalt2: '#43454b', shoulder: '#55575c', line: '#f1f2f4',
    yellow: '#f2c53a', tree: ['#3c7a35', '#4a8a3c', '#336b2e'],
    field: ['#9fb055', '#c9b46a', '#77a043', '#8f7350'], dirt: '#8e7656', walk: '#c8c3b8', curb: '#dcd8cf',
  };
}

//──────────────────────── Trees ────────────────────────
function tree(g, x, y, r, P, rnd, conifer) {
  // cast shadow (sun upper-left)
  g.fillStyle = 'rgba(0,0,0,.22)';
  g.beginPath(); g.ellipse(x + r * 0.45, y + r * 0.4, r * 1.02, r * 0.9, 0, 0, 7); g.fill();
  const col = P.tree[Math.floor(rnd() * P.tree.length)];
  if (conifer || P.treeSnow) {
    // star-shaped conifer crown
    g.fillStyle = col;
    g.beginPath();
    for (let k = 0; k < 16; k++) {
      const a = k / 16 * Math.PI * 2, rr2 = k % 2 ? r * 0.62 : r;
      g.lineTo(x + Math.cos(a) * rr2, y + Math.sin(a) * rr2);
    }
    g.closePath(); g.fill();
    g.fillStyle = P.treeSnow ? 'rgba(248,251,255,.85)' : 'rgba(255,255,220,.12)';
    g.beginPath(); g.arc(x - r * 0.18, y - r * 0.18, r * 0.5, 0, 7); g.fill();
    if (P.treeSnow) {
      g.fillStyle = 'rgba(255,255,255,.6)';
      for (let k = 0; k < 5; k++) {
        const a = rnd() * 7, d = r * (0.4 + rnd() * 0.4);
        g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.18, 0, 7); g.fill();
      }
    }
    return;
  }
  // deciduous: clustered lobes, darker base, lit top-left
  g.fillStyle = col;
  for (let k = 0; k < 5; k++) {
    const a = k / 5 * 7 + rnd(), d = r * 0.42;
    g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.62, 0, 7); g.fill();
  }
  g.beginPath(); g.arc(x, y, r * 0.7, 0, 7); g.fill();
  g.fillStyle = 'rgba(0,0,0,.14)';
  g.beginPath(); g.arc(x + r * 0.22, y + r * 0.25, r * 0.55, 0, 7); g.fill();
  g.fillStyle = 'rgba(255,255,200,.16)';
  g.beginPath(); g.arc(x - r * 0.28, y - r * 0.3, r * 0.42, 0, 7); g.fill();
  g.fillStyle = 'rgba(255,255,220,.12)';
  g.beginPath(); g.arc(x - r * 0.38, y - r * 0.4, r * 0.2, 0, 7); g.fill();
}

//──────────────────────── Generic road bits ────────────────────────
function asphaltRect(g, x, y, w, h, P, rnd, lanes, laneH) {
  g.fillStyle = P.asphalt; g.fillRect(x, y, w, h);
  // resurfacing patches and long subtle tone streaks
  for (let i = 0; i < 10; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,.025)' : 'rgba(0,0,0,.05)';
    const px = x + rnd() * w, pw = 40 + rnd() * 240;
    g.fillRect(px, y + rnd() * h * 0.8, pw, h * (0.15 + rnd() * 0.5));
  }
  // wheel-path polish + darker oil drip line down each lane centre
  if (lanes) {
    for (let l = 0; l < lanes; l++) {
      const yc = y + l * laneH + laneH / 2;
      g.fillStyle = weatherKind() === 'snow' ? 'rgba(30,32,38,.32)' : 'rgba(0,0,0,.08)';
      g.fillRect(x, yc - laneH * 0.3, w, laneH * 0.13);
      g.fillRect(x, yc + laneH * 0.17, w, laneH * 0.13);
      g.fillStyle = 'rgba(0,0,0,.07)';
      g.fillRect(x, yc - laneH * 0.04, w, laneH * 0.08);
    }
  }
  g.save();
  grain(g, 0.9);
  g.fillRect(x, y, w, h);
  g.restore();
  // cracks and sealant squiggles
  g.strokeStyle = 'rgba(10,10,12,.28)'; g.lineWidth = Math.max(0.5, (laneH || 20) * 0.03);
  g.beginPath();
  const n = Math.round(w / 90);
  for (let i = 0; i < n; i++) {
    let cx = x + rnd() * w, cy = y + rnd() * h;
    g.moveTo(cx, cy);
    const segs = 3 + Math.floor(rnd() * 4);
    for (let k = 0; k < segs; k++) {
      cx += (rnd() - 0.3) * 9; cy += (rnd() - 0.5) * 5;
      g.lineTo(cx, cy);
    }
  }
  g.stroke();
}

// Worn paint: each dash gets a slightly different opacity, a few are scuffed.
function dashes(g, y, x0, x1, dash, gap, thick, col, rnd) {
  for (let x = x0; x < x1; x += dash + gap) {
    const a = 0.78 + rnd() * 0.22;
    g.globalAlpha = a;
    g.fillStyle = col;
    g.fillRect(x, y - thick / 2, Math.min(dash, x1 - x), thick);
  }
  g.globalAlpha = 1;
}

function solidLine(g, x0, x1, y, thick, col) {
  g.fillStyle = col; g.fillRect(x0, y - thick / 2, x1 - x0, thick);
}

// Stroke a curved single-lane ramp along a LUT: shoulder, asphalt, edge lines.
function rampStroke(g, lut, LH, P, sh) {
  g.lineCap = 'butt'; g.lineJoin = 'round';
  lutPath(g, lut);
  g.strokeStyle = P.shoulder; g.lineWidth = LH + sh * 2; g.stroke();
  g.strokeStyle = P.asphalt; g.lineWidth = LH; g.stroke();
  const lw = Math.max(1, LH * 0.075);
  lutPath(g, lut);
  g.strokeStyle = P.line; g.lineWidth = LH - LH * 0.12; g.stroke();
  g.strokeStyle = P.asphalt; g.lineWidth = LH - LH * 0.12 - lw * 2; g.stroke();
  // grain over the ramp surface
  g.save();
  grain(g, 0.8);
  g.strokeStyle = g.fillStyle; g.lineWidth = LH; lutPath(g, lut); g.stroke();
  g.restore();
}

//──────────────────────── HIGHWAY ────────────────────────
function paintHighwayGround(g) {
  const G = geo(), P = pal(), wk = weatherKind();
  const { W, H, LH, c, top, ry, ay } = G;
  const rnd = sceneRand(424243);

  // ── terrain ──
  g.fillStyle = P.grass; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 70; i++) {                       // macro tone variation
    const x = rnd() * W, y = rnd() * H, r = LH * (2 + rnd() * 7);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const col = rnd() < 0.5 ? P.grass2 : P.grassHi;
    gr.addColorStop(0, col); gr.addColorStop(1, col + '00');
    g.globalAlpha = 0.55;
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.globalAlpha = 1;
  // farm parcels above and below the right-of-way
  const rowTop = G.barrierY - LH * 1.6;
  const rowBot = Math.max(G.rampY + LH * 1.4, ay + G.outerSh + LH * 1.6);
  paintFields(g, 0, rowTop, W, P, rnd, LH, true);
  paintFields(g, rowBot, H, W, P, rnd, LH, false);
  // mowed right-of-way band
  g.fillStyle = P.mow;
  g.fillRect(0, G.barrierY - LH * 1.1, W, LH * 1.1);
  g.fillRect(0, ry, W, G.outerSh + LH * 2);
  // fine grass tufts
  g.strokeStyle = wk === 'snow' ? 'rgba(150,165,180,.35)' : 'rgba(20,45,10,.30)';
  g.lineWidth = Math.max(0.5, LH * 0.03);
  g.beginPath();
  for (let i = 0; i < 520; i++) {
    const x = rnd() * W, y = rnd() * H, s = LH * 0.08;
    g.moveTo(x, y); g.lineTo(x - s, y - s * 1.4);
    g.moveTo(x, y); g.lineTo(x + s * 0.2, y - s * 1.8);
    g.moveTo(x, y); g.lineTo(x + s, y - s * 1.3);
  }
  g.stroke();

  // ── cross roads (rural two-lane, bridged over the freeway) ──
  for (const cx of G.crossX) {
    const x0 = cx - G.crossW / 2;
    g.fillStyle = P.dirt; g.fillRect(x0 - LH * 0.25, 0, G.crossW + LH * 0.5, H);   // gravel shoulders
    asphaltRect(g, x0, 0, G.crossW, H, P, rnd, 0, LH);
    solidLine(g, x0 + LH * 0.06, x0 + LH * 0.06 + 0, 0, 0, P.line);
    g.fillStyle = P.line;
    g.fillRect(x0 + LH * 0.08, 0, Math.max(1, LH * 0.06), H);
    g.fillRect(x0 + G.crossW - LH * 0.08 - Math.max(1, LH * 0.06), 0, Math.max(1, LH * 0.06), H);
    g.fillStyle = P.yellow;
    const yl = Math.max(0.8, LH * 0.05);
    g.fillRect(cx - yl * 1.6, 0, yl, H); g.fillRect(cx + yl * 0.6, 0, yl, H);
  }

  // ── trees (kept clear of every paved surface) ──
  const clearOf = (x, y, r) => {
    if (y + r > G.barrierY - LH * 1.0 && y - r < ay + G.outerSh + LH * 0.9) return false;
    for (const cx of G.crossX) if (Math.abs(x - cx) < G.crossW / 2 + LH * 0.5 + r) return false;
    for (const lut of G.hasOff ? [G.onLUT, G.offLUT] : [G.onLUT]) {
      for (let k = 0; k < lut.pts.length; k += 2) {
        const p = lut.pts[k];
        if (Math.abs(p.x - x) < LH + r && Math.abs(p.y - y) < LH * 1.1 + r) return false;
      }
    }
    return true;
  };
  for (let i = 0; i < 150; i++) {
    const x = rnd() * W, y = rnd() * H, r = LH * (0.35 + rnd() * 0.45);
    const conifer = rnd() < 0.3;
    if (!clearOf(x, y, r)) continue;
    // clumps: a few satellites
    tree(g, x, y, r, P, rnd, conifer);
    const n = Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const a = rnd() * 7, d = r * (1.2 + rnd() * 0.6), r2 = r * (0.6 + rnd() * 0.3);
      const tx = x + Math.cos(a) * d, ty = y + Math.sin(a) * d;
      if (clearOf(tx, ty, r2)) tree(g, tx, ty, r2, P, rnd, conifer);
    }
  }

  // ── shoulders ──
  g.fillStyle = P.shoulder;
  g.fillRect(0, top - G.innerSh, W, G.innerSh);
  g.fillRect(0, ry, W, G.outerSh);

  // ── ramps (under the mainline / aux lanes so they merge seamlessly) ──
  rampStroke(g, G.onLUT, LH, P, G.outerSh * 0.6);
  if (G.hasOff) rampStroke(g, G.offLUT, LH, P, G.outerSh * 0.6);

  // ── aux lanes: acceleration lane (+ end taper) and deceleration lane ──
  const accelPoly = (dy) => {
    g.beginPath();
    g.moveTo(G.rsX - 1, ry + dy * 0.2); g.lineTo(G.reX, ry + dy * 0.2);
    g.lineTo(G.reX + G.taper, ry + 0.5);
    g.lineTo(G.reX, ay + dy); g.lineTo(G.rsX - 1, ay + dy);
    g.closePath();
  };
  const decelPoly = (dy) => {
    g.beginPath();
    g.moveTo(G.dsX - G.open, ry + dy * 0.2); g.lineTo(G.ox + 1, ry + dy * 0.2);
    g.lineTo(G.ox + 1, ay + dy); g.lineTo(G.dsX, ay + dy);
    g.closePath();
  };
  g.fillStyle = P.shoulder;
  accelPoly(G.outerSh); g.fill();
  if (G.hasOff) { decelPoly(G.outerSh); g.fill(); }
  g.fillStyle = P.asphalt2;
  accelPoly(0); g.fill();
  if (G.hasOff) { decelPoly(0); g.fill(); }
  g.save();
  grain(g, 0.9);
  accelPoly(0); g.fill();
  if (G.hasOff) { decelPoly(0); g.fill(); }
  g.restore();

  // ── mainline ──
  asphaltRect(g, 0, top, W, G.rh, P, rnd, sim.lanes, LH);
  // rumble strips on both shoulders
  g.fillStyle = 'rgba(0,0,0,.16)';
  const rs = Math.max(0.6, LH * 0.035);
  for (let x = 0; x < W; x += rs * 3.2) {
    g.fillRect(x, top - G.innerSh * 0.55, rs, G.innerSh * 0.26);
    if (!((x > G.rsX - 4 && x < G.reX + G.taper) || (G.hasOff && x > G.dsX - G.open && x < G.ox + 4)))
      g.fillRect(x, ry + G.outerSh * 0.3, rs, G.outerSh * 0.26);
  }

  // ── markings ──
  const lw = Math.max(1.1, LH * 0.085);
  const inset = LH * 0.07;
  solidLine(g, 0, W, top + inset, lw, P.yellow);           // median-side edge line
  // right edge line: solid, broken into a dotted channelising line along the
  // speed-change lanes
  const edgeY = ry - inset * 0.4;
  const segs = [[0, G.rsX], [G.reX + G.taper * 0.5, G.hasOff ? G.dsX - G.open * 0.5 : W]];
  if (G.hasOff) segs.push([G.ox, W]);
  for (const [a, b] of segs) if (b > a) solidLine(g, a, b, edgeY, lw, P.line);
  const dotted = (a, b) => dashes(g, edgeY, a, b, Math.max(3, c * 0.35), Math.max(3, c * 0.35), lw * 1.5, P.line, rnd);
  dotted(G.rsX, G.reX + G.taper * 0.5);
  if (G.hasOff) dotted(G.dsX - G.open * 0.5, G.ox);
  const dash = Math.max(4, c * 0.41), gap = Math.max(10, c * 1.22);
  for (let l = 1; l < sim.lanes; l++) dashes(g, top + l * LH, c * 0.2, W, dash, gap, lw, P.line, rnd);
  // aux-lane outer edge lines (+ taper)
  g.strokeStyle = P.line; g.lineWidth = lw;
  g.beginPath();
  g.moveTo(G.rsX, ay - inset); g.lineTo(G.reX, ay - inset); g.lineTo(G.reX + G.taper, ry + inset * 0.5);
  if (G.hasOff) { g.moveTo(G.dsX - G.open, ry + inset * 0.5); g.lineTo(G.dsX, ay - inset); g.lineTo(G.ox, ay - inset); }
  g.stroke();
  // off-ramp gore: solid edge lines diverging + chevrons in the nose
  if (G.hasOff) {
    g.fillStyle = P.line;
    g.save();
    g.beginPath();
    g.moveTo(G.ox, ry);
    for (const p of G.offLUT.pts) g.lineTo(p.x, p.y - LH / 2 + 1);
    g.lineTo(G.offLUT.pts[G.offLUT.pts.length - 1].x, ry);
    g.closePath();
    g.clip();
    g.strokeStyle = P.line; g.lineWidth = lw * 1.2;
    g.beginPath();
    for (let x = G.ox + LH * 0.6; x < G.ox + LH * 7; x += LH * 0.75) { g.moveTo(x, ry); g.lineTo(x + LH * 0.6, ry + LH * 0.9); }
    g.stroke();
    g.restore();
  }
  // on-ramp gore: the painted sliver where the ramp's inner edge converges on
  // the mainline shoulder, hatched with chevrons
  {
    const yS = ry + G.outerSh, pts = [];
    for (const p of G.onLUT.pts) {
      const te = p.y - LH / 2 * Math.cos(p.a);
      if (te > yS && te - yS < LH * 1.1) pts.push([p.x + LH / 2 * Math.sin(p.a), te]);
    }
    if (pts.length > 1) {
      g.save();
      g.beginPath();
      g.moveTo(pts[0][0], yS);
      for (const q of pts) g.lineTo(q[0], q[1]);
      g.lineTo(pts[pts.length - 1][0], yS);
      g.closePath();
      g.fillStyle = P.shoulder; g.fill();
      g.clip();
      g.strokeStyle = P.line; g.lineWidth = lw;
      g.beginPath();
      for (let x = pts[pts.length - 1][0]; x > pts[0][0] - LH; x -= LH * 0.7) { g.moveTo(x, yS); g.lineTo(x - LH * 0.5, yS + LH * 1.1); }
      g.stroke();
      g.restore();
    }
  }
  // inductive loop detectors at the counting station
  g.strokeStyle = 'rgba(12,12,14,.32)'; g.lineWidth = Math.max(0.4, LH * 0.022);
  for (let l = 0; l < sim.lanes; l++) {
    const y = top + l * LH + LH * 0.24;
    g.strokeRect(G.sensorX - LH * 0.26, y, LH * 0.52, LH * 0.52);
    g.beginPath(); g.moveTo(G.sensorX + LH * 0.26, y + LH * 0.26); g.lineTo(G.sensorX + LH * 0.45, top + l * LH + LH * 0.97); g.stroke();
  }
  // roadside controller cabinet for the station
  g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(G.sensorX + LH * 0.08, G.barrierY - LH * 0.62, LH * 0.5, LH * 0.38);
  g.fillStyle = '#9aa1a8'; g.fillRect(G.sensorX, G.barrierY - LH * 0.7, LH * 0.48, LH * 0.36);
  g.fillStyle = '#c4c9ce'; g.fillRect(G.sensorX, G.barrierY - LH * 0.7, LH * 0.48, LH * 0.08);

  // ── median barrier (Jersey) ──
  const by = G.barrierY, bw = G.barrierW;
  g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(0, by + bw, W, bw * 0.7);       // cast shadow on the shoulder
  const bg = g.createLinearGradient(0, by, 0, by + bw);
  bg.addColorStop(0, wk === 'snow' ? '#f4f7fa' : '#d9d6ce'); bg.addColorStop(0.45, '#c3c0b8'); bg.addColorStop(1, '#94918a');
  g.fillStyle = bg; g.fillRect(0, by, W, bw);
  g.fillStyle = 'rgba(0,0,0,.18)';
  for (let x = 0; x < W; x += c * 1.3) g.fillRect(x, by, Math.max(0.5, LH * 0.025), bw);

  // ── outer guardrail (W-beam) following the paved edge, gapped at ramps ──
  const railMain = ry + G.outerSh + LH * 0.22, railAux = ay + G.outerSh + LH * 0.22;
  const pts = [];
  const flare = c * 1.5;
  const addSeg = (x0, x1, y0, y1) => { if (x1 > x0 + 4) pts.push([[x0, y0], [x1, y1]]); };
  addSeg(0, G.crossX[0] - G.crossW / 2 - LH * 0.4, railMain, railMain);
  // accel lane stretch: along the aux edge until the taper, then back to main
  addSeg(G.rsX + LH * 0.3, G.reX, railAux, railAux);
  const afterAccel = G.reX + G.taper + flare;
  pts.push([[G.reX, railAux], [afterAccel, railMain]]);
  const endMain = G.hasOff ? G.dsX - G.open - flare : G.crossX[1] - G.crossW / 2 - LH * 0.4;
  addSeg(afterAccel, endMain, railMain, railMain);
  if (G.hasOff) {
    pts.push([[endMain, railMain], [G.dsX, railAux]]);
    addSeg(G.dsX, G.ox - LH * 0.3, railAux, railAux);
  }
  addSeg(G.crossX[1] + G.crossW / 2 + LH * 0.4, W, railMain, railMain);
  drawRails(g, pts, LH, wk);

  // ── weather finish ──
  if (wk === 'rain') wetFinish(g, rnd, 0, top - G.innerSh, W, ay + G.outerSh - (top - G.innerSh), LH);
  if (wk === 'snow') snowFinish(g, rnd, G, LH);
}

function drawRails(g, segs, LH, wk) {
  const pw = Math.max(1, LH * 0.07);
  for (const [[x0, y0], [x1, y1]] of segs) {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.floor(len / (LH * 0.55)));
    g.fillStyle = 'rgba(0,0,0,.3)';
    for (let k = 0; k <= n; k++) {                      // post shadows + posts
      const t = k / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      g.fillRect(x + pw * 0.6, y + pw * 0.4, pw, pw * 1.6);
    }
    g.fillStyle = '#5b5e66';
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      g.fillRect(x - pw / 2, y - pw * 0.3, pw, pw * 1.4);
    }
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = pw * 1.3;
    g.beginPath(); g.moveTo(x0 + pw, y0 + pw * 1.3); g.lineTo(x1 + pw, y1 + pw * 1.3); g.stroke();
    g.strokeStyle = wk === 'snow' ? '#eef2f6' : '#b7bcc4'; g.lineWidth = pw * 1.1;
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = pw * 0.35;
    g.beginPath(); g.moveTo(x0, y0 - pw * 0.25); g.lineTo(x1, y1 - pw * 0.25); g.stroke();
    g.lineCap = 'butt';
  }
}

function paintFields(g, y0, y1, W, P, rnd, LH, upper) {
  if (y1 - y0 < LH * 2) return;
  let y = upper ? y1 : y0;
  const dir = upper ? -1 : 1;
  for (let row = 0; row < 8; row++) {
    const rh = LH * (3.5 + rnd() * 3.5);
    const ya = upper ? y - rh : y, yb = ya + rh;
    if ((upper && yb < 0) || (!upper && ya > view.H)) break;
    let x = -rnd() * LH * 4;
    while (x < W) {
      const fw = LH * (5 + rnd() * 9);
      const kind = Math.floor(rnd() * 5);
      const inset = LH * 0.18;
      const fx = x + inset, fy = ya + inset, fW = fw - inset * 2, fH = rh - inset * 2;
      if (kind < 4) {
        g.fillStyle = P.field[kind];
        g.globalAlpha = 0.85;
        g.fillRect(fx, fy, fW, fH);
        // crop rows / furrows
        g.strokeStyle = kind === 3 ? 'rgba(40,25,10,.25)' : 'rgba(0,0,0,.10)';
        g.lineWidth = Math.max(0.6, LH * 0.06);
        g.beginPath();
        const vert = rnd() < 0.5, step = LH * (0.28 + rnd() * 0.14);
        if (vert) for (let xx = fx + step / 2; xx < fx + fW; xx += step) { g.moveTo(xx, fy); g.lineTo(xx, fy + fH); }
        else for (let yy = fy + step / 2; yy < fy + fH; yy += step) { g.moveTo(fx, yy); g.lineTo(fx + fW, yy); }
        g.stroke();
        g.globalAlpha = 1;
      } else {
        // orchard: grid of small trees
        g.fillStyle = P.grass2; g.fillRect(fx, fy, fW, fH);
        const s = LH * 0.9;
        for (let yy = fy + s / 2; yy < fy + fH - s / 3; yy += s)
          for (let xx = fx + s / 2; xx < fx + fW - s / 3; xx += s) {
            g.fillStyle = 'rgba(0,0,0,.2)';
            g.beginPath(); g.arc(xx + s * 0.12, yy + s * 0.12, s * 0.3, 0, 7); g.fill();
            g.fillStyle = P.tree[1];
            g.beginPath(); g.arc(xx, yy, s * 0.3, 0, 7); g.fill();
            g.fillStyle = P.treeSnow ? 'rgba(255,255,255,.7)' : 'rgba(255,255,200,.15)';
            g.beginPath(); g.arc(xx - s * 0.08, yy - s * 0.08, s * 0.14, 0, 7); g.fill();
          }
      }
      // hedgerow on the field's far edge
      if (rnd() < 0.45) {
        for (let xx = x; xx < x + fw; xx += LH * 0.45) {
          g.fillStyle = 'rgba(0,0,0,.18)';
          g.beginPath(); g.arc(xx + LH * 0.12, (upper ? ya : yb) + LH * 0.12, LH * 0.26, 0, 7); g.fill();
          g.fillStyle = P.tree[2];
          g.beginPath(); g.arc(xx, upper ? ya : yb, LH * 0.24 + rnd() * LH * 0.08, 0, 7); g.fill();
        }
      }
      x += fw;
    }
    // farm track between rows
    g.fillStyle = P.dirt; g.globalAlpha = 0.55;
    g.fillRect(0, upper ? ya - LH * 0.12 : yb - LH * 0.06, W, LH * 0.18);
    g.globalAlpha = 1;
    y += dir * rh;
  }
}

function wetFinish(g, rnd, x, y, w, h, LH) {
  // darker, glossy pavement: cool sky sheen + scattered puddles
  const gr = g.createLinearGradient(0, y, 0, y + h);
  gr.addColorStop(0, 'rgba(150,175,210,.05)');
  gr.addColorStop(0.5, 'rgba(170,195,230,.12)');
  gr.addColorStop(1, 'rgba(150,175,210,.05)');
  g.fillStyle = gr; g.fillRect(x, y, w, h);
  for (let i = 0; i < 26; i++) {
    const px = x + rnd() * w, py = y + rnd() * h, rx = LH * (0.4 + rnd() * 1.4), ry = LH * (0.12 + rnd() * 0.2);
    const pg = g.createRadialGradient(px, py, 0, px, py, rx);
    pg.addColorStop(0, 'rgba(185,205,235,.20)'); pg.addColorStop(0.7, 'rgba(160,185,220,.10)'); pg.addColorStop(1, 'rgba(160,185,220,0)');
    g.fillStyle = pg;
    g.beginPath(); g.ellipse(px, py, rx, ry, 0, 0, 7); g.fill();
  }
}

function snowFinish(g, rnd, G, LH) {
  const { W, top, ry, ay } = G;
  // windrows of plowed snow along both shoulders + powder over the lane lines
  const bank = (y, h) => {
    g.fillStyle = 'rgba(244,247,250,.92)';
    g.beginPath();
    g.moveTo(0, y + h);
    for (let x = 0; x <= W + 10; x += LH * 0.5) g.lineTo(x, y + h * (0.15 + rnd() * 0.35));
    g.lineTo(W, y + h); g.closePath(); g.fill();
  };
  bank(top - G.innerSh, G.innerSh * 0.8);
  g.save();
  g.translate(0, 0);
  g.fillStyle = 'rgba(244,247,250,.9)';
  g.fillRect(0, ry + G.outerSh * 0.35, W, G.outerSh * 0.65);
  g.restore();
  // slush between wheel paths (blurs the lane lines)
  for (let l = 0; l <= sim.lanes; l++) {
    const yb = top + l * LH;
    slushBand(g, rnd, W, yb, LH);
  }
  void ay;
}

// Packed slush between the wheel paths: long, thin, overlapping streaks.
function slushBand(g, rnd, W, yb, LH) {
  for (let x = -LH; x < W; x += LH * 0.35) {
    g.fillStyle = `rgba(232,238,244,${(0.12 + rnd() * 0.22).toFixed(2)})`;
    const len = LH * (0.6 + rnd() * 1.4), th = LH * (0.025 + rnd() * 0.05);
    g.beginPath(); g.ellipse(x + len / 2, yb + (rnd() - 0.5) * LH * 0.3, len / 2, th, 0, 0, 7); g.fill();
  }
}

function paintHighwayTop(g) {
  const G = geo(), P = pal(), wk = weatherKind();
  const { LH, c, top } = G;
  // median light poles: base on the barrier, arm reaching over the inner lane
  for (const x of G.poleX) {
    const by = G.barrierY + G.barrierW / 2, arm = LH * 0.95;
    g.strokeStyle = 'rgba(0,0,0,.22)'; g.lineWidth = Math.max(0.6, LH * 0.045);
    g.beginPath(); g.moveTo(x + LH * 0.3, by + LH * 0.2); g.lineTo(x + LH * 0.3 + LH * 0.1, by + arm + LH * 0.2); g.stroke();
    g.strokeStyle = '#8c9199'; g.lineWidth = Math.max(0.6, LH * 0.045);
    g.beginPath(); g.moveTo(x, by); g.lineTo(x, by + arm); g.stroke();
    g.fillStyle = '#6c7078'; rr(g, x - LH * 0.12, by + arm - LH * 0.05, LH * 0.24, LH * 0.34, LH * 0.06);
    g.fillStyle = '#fff3cf'; rr(g, x - LH * 0.07, by + arm + LH * 0.02, LH * 0.14, LH * 0.2, LH * 0.04);
    g.fillStyle = '#7d828a'; g.beginPath(); g.arc(x, by, LH * 0.1, 0, 7); g.fill();
  }
  // overpass decks (cast shadow first, sun from the upper-left)
  for (const cx of G.crossX) {
    const par = Math.max(2, LH * 0.16);
    const x0 = cx - G.crossW / 2 - par, w = G.crossW + par * 2;
    const y0 = G.deckY0, h = G.deckY1 - G.deckY0;
    g.fillStyle = 'rgba(10,14,20,.34)';
    g.fillRect(x0 + LH * 0.45, y0 + LH * 0.25, w, h);
    g.fillStyle = 'rgba(10,14,20,.16)';
    g.fillRect(x0 + LH * 0.25, y0 + LH * 0.12, w + LH * 0.4, h);
    // deck slab edge (concrete), road surface, parapets
    g.fillStyle = '#8f8c86'; g.fillRect(x0 - par * 0.3, y0, w + par * 0.6, h);
    g.fillStyle = P.asphalt; g.fillRect(cx - G.crossW / 2, y0, G.crossW, h);
    g.save(); grain(g, 0.9); g.fillRect(cx - G.crossW / 2, y0, G.crossW, h); g.restore();
    const pg = g.createLinearGradient(x0, 0, x0 + par, 0);
    pg.addColorStop(0, '#e6e3dc'); pg.addColorStop(1, '#b9b6ae');
    g.fillStyle = pg; g.fillRect(x0, y0, par, h);
    const pg2 = g.createLinearGradient(x0 + w - par, 0, x0 + w, 0);
    pg2.addColorStop(0, '#d8d5ce'); pg2.addColorStop(1, '#a29f98');
    g.fillStyle = pg2; g.fillRect(x0 + w - par, y0, par, h);
    // markings on the deck
    const yl = Math.max(0.8, LH * 0.05);
    g.fillStyle = P.yellow;
    g.fillRect(cx - yl * 1.6, y0, yl, h); g.fillRect(cx + yl * 0.6, y0, yl, h);
    g.fillStyle = P.line;
    g.fillRect(cx - G.crossW / 2 + LH * 0.08, y0, Math.max(1, LH * 0.06), h);
    g.fillRect(cx + G.crossW / 2 - LH * 0.08 - Math.max(1, LH * 0.06), y0, Math.max(1, LH * 0.06), h);
    // expansion joints at the abutments
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.fillRect(x0, y0, w, Math.max(0.8, LH * 0.06)); g.fillRect(x0, y0 + h - Math.max(0.8, LH * 0.06), w, Math.max(0.8, LH * 0.06));
    if (wk === 'snow') {
      g.fillStyle = 'rgba(245,248,252,.9)';
      g.fillRect(x0, y0, par * 1.5, h); g.fillRect(x0 + w - par * 1.5, y0, par * 1.5, h);
    }
  }
  // overhead guide sign for the exit (static gantry upstream of the diverge)
  if (G.hasOff) {
    const gx = G.dsX - c * 6;
    signGantry(g, G, gx, (gc, sx, sy, sw, sh) => {
      gc.fillStyle = '#0f6b3a'; rr(gc, sx, sy, sw, sh, sh * 0.12);
      gc.strokeStyle = '#e8f3ec'; gc.lineWidth = Math.max(0.5, sh * 0.06);
      gc.strokeRect(sx + sh * 0.1, sy + sh * 0.1, sw - sh * 0.2, sh - sh * 0.2);
      gc.fillStyle = '#ffffff';
      gc.font = `700 ${(sh * 0.42).toFixed(1)}px system-ui, sans-serif`;
      gc.textAlign = 'center'; gc.textBaseline = 'middle';
      gc.fillText('EXIT 24 ↘', sx + sw / 2, sy + sh * 0.52);
      gc.textAlign = 'left'; gc.textBaseline = 'alphabetic';
    }, sim.lanes - 1);
  }
  void top;
}

// A cantilever/truss gantry spanning the carriageway at x, with a sign panel
// over lane `lane` (or all lanes when lane < 0). The sign is drawn flat
// (stylised, readable from above) and casts a shadow on the road.
export function signGantry(g, G, x, paintSign, lane = -1, panelW) {
  const { LH } = G;
  const y0 = G.barrierY - LH * 0.25, y1 = (G.ay || G.ry) + G.outerSh + LH * 0.25;
  const tw = Math.max(2, LH * 0.14);
  // shadow
  g.fillStyle = 'rgba(0,0,0,.22)';
  g.fillRect(x + LH * 0.35, y0 + LH * 0.2, tw * 2.2, y1 - y0);
  // truss: two chords + lacing
  g.fillStyle = '#9ea4ad';
  g.fillRect(x - tw, y0, tw * 0.7, y1 - y0); g.fillRect(x + tw * 0.3, y0, tw * 0.7, y1 - y0);
  g.strokeStyle = '#7d838c'; g.lineWidth = Math.max(0.4, tw * 0.25);
  g.beginPath();
  for (let y = y0, k = 0; y < y1; y += tw * 1.4, k++) { g.moveTo(x - tw * 0.65, y); g.lineTo(x + tw * 0.65, y + tw * 1.4); }
  g.stroke();
  // end posts
  g.fillStyle = '#6d727a';
  g.fillRect(x - tw * 1.3, y0 - tw * 0.5, tw * 2.6, tw * 1.2);
  g.fillRect(x - tw * 1.3, y1 - tw * 0.7, tw * 2.6, tw * 1.2);
  // sign panel(s)
  const pw = panelW || Math.max(LH * 1.3, G.c * 2.2);
  const lanes = lane < 0 ? [...Array(sim.lanes).keys()] : [lane];
  for (const l of lanes) {
    const sy = G.top + l * LH + LH * 0.12, sh = LH * 0.76;
    const sx = x - pw * 0.15;
    g.fillStyle = 'rgba(0,0,0,.25)';
    g.fillRect(sx + LH * 0.3, sy + LH * 0.18, pw, sh);
    paintSign(g, sx, sy, pw, sh, l);
  }
}

//──────────────────────── CITY ────────────────────────
function paintCityGround(g) {
  const G = geo(), P = pal(), wk = weatherKind();
  const { W, H, LH, c, top, rh } = G;
  const rnd = sceneRand(902101);
  const ry = top + rh;

  // base: urban ground (pavement / lots)
  g.fillStyle = wk === 'snow' ? '#e9eef2' : wk === 'rain' ? '#6d6c69' : '#a9a69f';
  g.fillRect(0, 0, W, H);

  // building blocks above and below, driven by sim.buildings near the street
  // and procedurally further out; shadows first so they never land on roofs.
  const blocks = [];
  const nearTop = G.walkTop, nearBot = G.walkBot;
  for (const b of sim.buildings) {
    const x = b.c0 * c + 1, w = b.w * c - 2;
    const depth = LH * (2.2 + ((b.h - 18) / 30) * 2.4);
    const setback = LH * 0.15;
    const y = b.side === 'top' ? nearTop - setback - depth : nearBot + setback;
    blocks.push({ x, y, w, h: depth, ht: 0.6 + (b.h - 18) / 30 * 1.6 + (b.shade % 7) * 0.15, shade: b.shade, win: b.win, r: rnd() });
  }
  // back alleys + outer blocks to fill the canvas
  const alley = LH * 0.9;
  for (const side of ['top', 'bottom']) {
    let edge = side === 'top' ? nearTop - LH * 0.15 - LH * 4.8 - alley : nearBot + LH * 0.15 + LH * 4.8 + alley;
    for (let row = 0; row < 6; row++) {
      const depth = LH * (3 + rnd() * 3);
      const y = side === 'top' ? edge - depth : edge;
      if ((side === 'top' && y + depth < 0) || (side === 'bottom' && y > H)) break;
      let x = -rnd() * LH * 3;
      while (x < W) {
        const w = LH * (2.5 + rnd() * 6);
        const kind = rnd();
        blocks.push({ x: x + 1, y, w: w - 2, h: depth, ht: 0.5 + rnd() * 2.6, shade: 30 + Math.floor(rnd() * 18), win: true, r: rnd(), park: kind < 0.08, lot: kind > 0.92 });
        x += w;
      }
      edge = side === 'top' ? y - alley : y + depth + alley;
    }
  }
  // alleys/back streets as asphalt between rows (draw before buildings)
  g.fillStyle = wk === 'snow' ? '#c9d0d7' : wk === 'rain' ? '#3a3b3f' : '#58595d';
  for (const b of blocks) g.fillRect(b.x - 1, b.y - alley * 0.5, b.w + 2, b.h + alley);
  // building shadows
  g.fillStyle = 'rgba(15,18,24,.30)';
  for (const b of blocks) {
    if (b.park || b.lot) continue;
    const sx = LH * 0.55 * b.ht, sy = LH * 0.45 * b.ht;
    g.beginPath();
    g.moveTo(b.x + b.w, b.y); g.lineTo(b.x + b.w + sx, b.y + sy);
    g.lineTo(b.x + b.w + sx, b.y + b.h + sy); g.lineTo(b.x + sx, b.y + b.h + sy);
    g.lineTo(b.x, b.y + b.h); g.lineTo(b.x + b.w, b.y + b.h); g.closePath(); g.fill();
  }
  for (const b of blocks) {
    if (b.park) parkBlock(g, b, P, rnd, LH);
    else if (b.lot) parkingLot(g, b, P, rnd, LH);
    else roof(g, b, P, rnd, LH, wk);
  }

  // ── cross streets (full height) ──
  for (const it of G.inters) {
    g.fillStyle = P.walk;
    g.fillRect(it.sx0 - LH * 0.7, 0, G.csW + LH * 1.4, H);           // sidewalks along it
    g.fillStyle = P.curb;
    g.fillRect(it.sx0 - LH * 0.08, 0, LH * 0.08, H); g.fillRect(it.sx1, 0, LH * 0.08, H);
    asphaltRect(g, it.sx0, 0, G.csW, H, P, rnd, 0, LH);
    const yl = Math.max(0.8, LH * 0.05);
    g.fillStyle = P.yellow;
    const cx = (it.sx0 + it.sx1) / 2;
    g.fillRect(cx - yl * 1.6, 0, yl, H); g.fillRect(cx + yl * 0.6, 0, yl, H);
  }

  // ── sidewalks + curbs + parking lanes along the arterial ──
  g.fillStyle = P.walk;
  g.fillRect(0, G.walkTop, W, G.walkW); g.fillRect(0, G.curbBot, W, G.walkW);
  g.strokeStyle = 'rgba(0,0,0,.12)'; g.lineWidth = Math.max(0.5, LH * 0.03);
  g.beginPath();
  for (let x = 0; x < W; x += LH * 0.7) {
    g.moveTo(x, G.walkTop); g.lineTo(x, G.curbTop);
    g.moveTo(x, G.curbBot); g.lineTo(x, G.walkBot);
  }
  g.moveTo(0, G.walkTop + G.walkW * 0.5); g.lineTo(W, G.walkTop + G.walkW * 0.5);
  g.moveTo(0, G.curbBot + G.walkW * 0.5); g.lineTo(W, G.curbBot + G.walkW * 0.5);
  g.stroke();
  asphaltRect(g, 0, G.curbTop, W, G.curbBot - G.curbTop, P, rnd, 0, LH);
  // wheel-path polish on the travel lanes only
  for (let l = 0; l < sim.lanes; l++) {
    const yc = top + l * LH + LH / 2;
    g.fillStyle = wk === 'snow' ? 'rgba(30,32,38,.3)' : 'rgba(0,0,0,.08)';
    g.fillRect(0, yc - LH * 0.3, W, LH * 0.13); g.fillRect(0, yc + LH * 0.17, W, LH * 0.13);
  }
  // curbs (lit top face) + gutter
  g.fillStyle = P.curb;
  g.fillRect(0, G.curbTop - LH * 0.1, W, LH * 0.1); g.fillRect(0, G.curbBot, W, LH * 0.1);
  g.fillStyle = 'rgba(0,0,0,.22)';
  g.fillRect(0, G.curbTop, W, LH * 0.05);
  g.fillRect(0, G.curbBot + LH * 0.1, W, LH * 0.04);

  // ── intersections: re-pave the box, crosswalks, stop lines ──
  const lw = Math.max(1.1, LH * 0.085);
  for (const it of G.inters) {
    asphaltRect(g, it.cw0 - 1, G.walkTop, it.cw1 + G.cwW - it.cw0 + 2, G.walkBot - G.walkTop, P, rnd, 0, LH);
    // curb returns
    g.fillStyle = P.walk;
    g.fillStyle = P.curb;
    // crosswalks across the arterial (both sides of the cross street)
    for (const x of [it.cw0, it.cw1]) {
      g.fillStyle = 'rgba(240,241,243,.9)';
      const bar = Math.max(1.2, LH * 0.14);
      for (let y = G.curbTop + bar * 0.6; y < G.curbBot - bar * 0.6; y += bar * 2) g.fillRect(x, y, G.cwW, bar);
    }
    // crosswalks across the cross street at the sidewalk lines
    for (const y of [G.walkTop, G.curbBot]) {
      g.fillStyle = 'rgba(240,241,243,.9)';
      const bar = Math.max(1.2, LH * 0.14);
      for (let x = it.sx0 + bar * 0.6; x < it.sx1 - bar * 0.6; x += bar * 2) g.fillRect(x, y, bar, G.walkW);
    }
    // stop lines: arterial (before the near crosswalk) and cross street
    g.fillStyle = P.line;
    g.fillRect(it.stop - lw * 2.2, top + LH * 0.05, lw * 2.2, rh - LH * 0.1);
    g.fillRect(it.sx0 + G.csW / 2, G.walkTop - lw * 2.4, G.csW / 2, lw * 2.2);
    g.fillRect(it.sx0, G.walkBot + lw * 0.2, G.csW / 2, lw * 2.2);
  }
  // ── arterial markings ──
  const dash = Math.max(4, c * 0.41), gap = Math.max(10, c * 1.22);
  const skip = (x) => G.inters.some(it => x > it.stop - 2 && x < it.cw1 + G.cwW + 2);
  const lineRuns = (fn) => {
    let a = 0;
    for (const it of G.inters) { fn(a, it.stop - lw * 2.4); a = it.cw1 + G.cwW + 2; }
    fn(a, W);
  };
  lineRuns((a, b) => { solidLine(g, a, b, top + LH * 0.04, lw, P.line); solidLine(g, a, b, top + rh - LH * 0.04, lw, P.line); });
  for (let l = 1; l < sim.lanes; l++) {
    lineRuns((a, b) => dashes(g, top + l * LH, a, b, dash, gap, lw, P.line, rnd));
  }
  // parking stall ticks + parked cars
  const stall = c * 1.75;
  for (const side of [0, 1]) {
    const y0 = side ? top + rh : G.curbTop, yc = y0 + G.parkW / 2;
    for (let x = c * 0.6; x < W - stall; x += stall) {
      if (skip(x) || skip(x + stall) || G.inters.some(it => x + stall > it.stop - c * 2.5 && x < it.cw1 + G.cwW + c * 1.5)) continue;
      g.fillStyle = 'rgba(240,241,243,.7)';
      g.fillRect(x, side ? y0 + G.parkW * 0.45 : y0, Math.max(0.8, LH * 0.05), G.parkW * 0.55);
      if (rnd() < 0.55) {
        const kinds = ['sedan', 'sedan', 'hatch', 'suv', 'pickup', 'van'];
        const kind = kinds[Math.floor(rnd() * kinds.length)];
        const paint = rnd() < 0.5 ? { h: 0, s: 0, l: 20 + rnd() * 70 } : { h: rnd() * 360, s: 25 + rnd() * 40, l: 30 + rnd() * 35 };
        const len = c * 1.35, h = bodyWidth(kind, len);
        g.save();
        g.translate(x + stall / 2, yc);
        if (side === 0) g.rotate(Math.PI);
        paintVehicle(g, { kind, paint, av: false }, len, h, len * 3);
        g.restore();
      }
    }
  }
  if (wk === 'rain') wetFinish(g, rnd, 0, G.curbTop, W, G.curbBot - G.curbTop, LH);
  if (wk === 'snow') {
    // slush along the gutters and over the lane lines
    for (let l = 0; l <= sim.lanes; l++) {
      const yb = top + l * LH;
      slushBand(g, rnd, W, yb, LH);
    }
  }
}

function roof(g, b, P, rnd, LH, wk) {
  const { x, y, w, h } = b;
  if (w < 2 || h < 2) return;
  const t = b.r;
  const snow = wk === 'snow';
  let base;
  if (snow) base = '#eef2f6';
  else if (t < 0.25) base = `hsl(30,6%,${42 + (b.shade % 10)}%)`;        // gravel ballast
  else if (t < 0.45) base = `hsl(210,5%,${70 + (b.shade % 12)}%)`;        // white TPO membrane
  else if (t < 0.6) base = `hsl(22,30%,${34 + (b.shade % 10)}%)`;         // brick/tar
  else if (t < 0.75) base = `hsl(215,8%,${30 + (b.shade % 8)}%)`;         // dark membrane
  else base = `hsl(35,14%,${52 + (b.shade % 12)}%)`;                      // concrete
  g.fillStyle = base; g.fillRect(x, y, w, h);
  g.save(); grain(g, 0.55); g.fillRect(x, y, w, h); g.restore();
  // parapet: lit top/left edges, shaded bottom/right
  const p = Math.max(0.8, LH * 0.1);
  g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(x, y, w, p); g.fillRect(x, y, p, h);
  g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(x, y + h - p, w, p); g.fillRect(x + w - p, y, p, h);
  g.fillStyle = 'rgba(0,0,0,.10)'; g.fillRect(x + p, y + p, w - 2 * p, p * 0.8); g.fillRect(x + p, y + p, p * 0.8, h - 2 * p);
  // rooftop furniture
  const n = Math.floor(w * h / (LH * LH * 3)) + 1;
  for (let k = 0; k < n; k++) {
    const r = rnd();
    const ux = x + p * 2 + rnd() * Math.max(1, w - p * 4 - LH * 0.9);
    const uy = y + p * 2 + rnd() * Math.max(1, h - p * 4 - LH * 0.9);
    if (r < 0.4) {                                       // HVAC unit with fan
      const s = LH * (0.45 + rnd() * 0.4);
      g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(ux + s * 0.2, uy + s * 0.2, s, s * 0.8);
      g.fillStyle = snow ? '#f4f7fa' : '#c9ccd0'; g.fillRect(ux, uy, s, s * 0.8);
      g.fillStyle = '#5d6168'; g.beginPath(); g.arc(ux + s * 0.5, uy + s * 0.4, s * 0.26, 0, 7); g.fill();
      g.fillStyle = '#8b9097'; g.beginPath(); g.arc(ux + s * 0.5, uy + s * 0.4, s * 0.08, 0, 7); g.fill();
    } else if (r < 0.55 && !snow) {                      // solar array
      const sw = Math.min(w * 0.5, LH * 2.4), sh = Math.min(h * 0.4, LH * 1.2);
      g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(ux + LH * 0.1, uy + LH * 0.1, sw, sh);
      g.fillStyle = '#1f3557'; g.fillRect(ux, uy, sw, sh);
      g.strokeStyle = 'rgba(160,190,230,.35)'; g.lineWidth = Math.max(0.3, LH * 0.02);
      g.beginPath();
      for (let gx = ux; gx <= ux + sw; gx += LH * 0.3) { g.moveTo(gx, uy); g.lineTo(gx, uy + sh); }
      for (let gy = uy; gy <= uy + sh; gy += LH * 0.3) { g.moveTo(ux, gy); g.lineTo(ux + sw, gy); }
      g.stroke();
    } else if (r < 0.7) {                                // skylights
      for (let i = 0; i < 3; i++) {
        g.fillStyle = snow ? '#dfe7ee' : '#8fb2c9';
        g.fillRect(ux + i * LH * 0.4, uy, LH * 0.28, LH * 0.5);
        g.fillStyle = 'rgba(255,255,255,.3)';
        g.fillRect(ux + i * LH * 0.4, uy, LH * 0.28, LH * 0.1);
      }
    } else if (r < 0.8) {                                // water tank / vent
      const s = LH * 0.35;
      g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.arc(ux + s * 1.3, uy + s * 1.3, s, 0, 7); g.fill();
      g.fillStyle = snow ? '#f2f5f8' : '#8b6a4c'; g.beginPath(); g.arc(ux + s, uy + s, s, 0, 7); g.fill();
      g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = Math.max(0.3, LH * 0.03); g.stroke();
    } else if (r < 0.88 && !snow && w > LH * 2 && h > LH * 2) {   // roof garden
      g.fillStyle = '#5f8f45'; rr(g, ux, uy, LH * 1.2, LH * 0.8, LH * 0.15);
      g.fillStyle = '#4c7a37'; g.beginPath(); g.arc(ux + LH * 0.4, uy + LH * 0.4, LH * 0.22, 0, 7); g.fill();
    }
  }
  // stepped penthouse block on taller buildings
  if (b.ht > 1.6 && w > LH * 1.6 && h > LH * 1.6) {
    const px = x + w * 0.3, py = y + h * 0.25, pw = w * 0.35, ph = h * 0.4;
    g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(px + LH * 0.3, py + LH * 0.25, pw, ph);
    g.fillStyle = base; g.fillRect(px, py, pw, ph);
    g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(px, py, pw, p); g.fillRect(px, py, p, ph);
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(px, py + ph - p, pw, p); g.fillRect(px + pw - p, py, p, ph);
  }
}

function parkBlock(g, b, P, rnd, LH) {
  g.fillStyle = P.grass; g.fillRect(b.x, b.y, b.w, b.h);
  g.strokeStyle = P.walk; g.lineWidth = LH * 0.18;
  g.beginPath(); g.moveTo(b.x, b.y + b.h * 0.6); g.quadraticCurveTo(b.x + b.w * 0.5, b.y + b.h * 0.1, b.x + b.w, b.y + b.h * 0.5); g.stroke();
  const n = Math.floor(b.w * b.h / (LH * LH * 1.5));
  for (let i = 0; i < n; i++) tree(g, b.x + LH * 0.4 + rnd() * (b.w - LH * 0.8), b.y + LH * 0.4 + rnd() * (b.h - LH * 0.8), LH * (0.35 + rnd() * 0.3), P, rnd, false);
}

function parkingLot(g, b, P, rnd, LH) {
  g.fillStyle = P.asphalt; g.fillRect(b.x, b.y, b.w, b.h);
  g.save(); grain(g, 0.8); g.fillRect(b.x, b.y, b.w, b.h); g.restore();
  const sw = LH * 0.55, rowH = LH * 1.1;
  g.fillStyle = 'rgba(240,241,243,.7)';
  for (let y = b.y + LH * 0.2; y + rowH < b.y + b.h; y += rowH * 1.9) {
    for (let x = b.x + LH * 0.2; x + sw < b.x + b.w; x += sw) {
      g.fillRect(x, y, Math.max(0.6, LH * 0.04), rowH);
      if (rnd() < 0.5) {
        const kinds = ['sedan', 'hatch', 'suv', 'pickup'];
        const kind = kinds[Math.floor(rnd() * 4)];
        const paint = rnd() < 0.5 ? { h: 0, s: 0, l: 20 + rnd() * 70 } : { h: rnd() * 360, s: 25 + rnd() * 40, l: 30 + rnd() * 35 };
        g.save(); g.translate(x + sw / 2, y + rowH / 2); g.rotate(rnd() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
        const len = rowH * 0.85;
        paintVehicle(g, { kind, paint, av: false }, len, Math.min(sw * 0.75, len * 0.5), len * 3);
        g.restore();
        g.fillStyle = 'rgba(240,241,243,.7)';
      }
    }
  }
}

function paintCityTop(g) {
  const G = geo(), P = pal(), wk = weatherKind();
  const { W, LH, c, top, rh } = G;
  const rnd = sceneRand(55117);
  // street trees in sidewalk pits, canopies overhanging the parking lane
  for (const side of [0, 1]) {
    const y = side ? G.curbBot + G.walkW * 0.32 : G.curbTop - G.walkW * 0.32;
    for (let x = c * 2; x < W; x += c * (3.2 + rnd() * 1.2)) {
      if (G.inters.some(it => x > it.cw0 - LH * 1.1 && x < it.cw1 + G.cwW + LH * 1.1)) continue;
      const r = LH * (0.55 + rnd() * 0.2);
      tree(g, x, y, r, P, rnd, false);
    }
  }
  // streetlights: pole at the curb, arm over the parking lane
  for (const [cell, side] of [[10, 0], [36, 0], [61, 0], [23, 1], [55, 1], [78, 1]]) {
    const x = cell * c;
    if (G.inters.some(it => x > it.cw0 - LH && x < it.cw1 + G.cwW + LH)) continue;
    const by = side ? G.curbBot + LH * 0.12 : G.curbTop - LH * 0.12, dir = side ? -1 : 1;
    const ay2 = by + dir * G.parkW * 1.1;
    g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = Math.max(0.8, LH * 0.07);
    g.beginPath(); g.moveTo(x + LH * 0.25, by + LH * 0.2); g.lineTo(x + LH * 0.25, ay2 + LH * 0.2); g.stroke();
    g.strokeStyle = '#6f747c';
    g.beginPath(); g.moveTo(x, by); g.lineTo(x, ay2); g.stroke();
    g.fillStyle = '#4f535a'; rr(g, x - LH * 0.12, ay2 - LH * 0.12, LH * 0.24, LH * 0.3, LH * 0.06);
    g.fillStyle = '#fff1c4'; rr(g, x - LH * 0.07, ay2 - LH * 0.06, LH * 0.14, LH * 0.18, LH * 0.04);
    g.fillStyle = '#3e4248'; g.beginPath(); g.arc(x, by, LH * 0.1, 0, 7); g.fill();
  }
  // signal mast arms: pole on the far-side corner, arm reaching over the
  // arterial lanes with one head per lane (lamps lit dynamically).
  for (const it of G.inters) {
    const px = it.cw1 + G.cwW + LH * 0.3, py = G.curbBot + G.walkW * 0.45;
    const armTop = top + LH * 0.1;
    g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = Math.max(1, LH * 0.1);
    g.beginPath(); g.moveTo(px + LH * 0.3, py + LH * 0.2); g.lineTo(px + LH * 0.3, armTop + LH * 0.2); g.stroke();
    g.strokeStyle = '#5b6068'; g.lineWidth = Math.max(1, LH * 0.1);
    g.beginPath(); g.moveTo(px, py); g.lineTo(px, armTop); g.stroke();
    g.fillStyle = '#41454c'; g.beginPath(); g.arc(px, py, LH * 0.16, 0, 7); g.fill();
    // a second, shorter arm for the cross street (pointing up the street)
    const cx = it.sx1 + LH * 0.45, cy = G.walkTop - LH * 0.35;
    g.strokeStyle = '#5b6068';
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(it.sx0 + G.csW * 0.25, cy); g.stroke();
    g.fillStyle = '#41454c'; g.beginPath(); g.arc(cx, cy, LH * 0.16, 0, 7); g.fill();
    for (const hp of signalHeads(G, it)) {
      g.fillStyle = 'rgba(0,0,0,.3)'; rr(g, hp.x + LH * 0.15, hp.y + LH * 0.12, hp.w, hp.h, LH * 0.05);
      g.fillStyle = '#1b1d22'; rr(g, hp.x, hp.y, hp.w, hp.h, LH * 0.05);
      g.fillStyle = '#2a2d33';
      for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(hp.x + hp.w / 2, hp.y + hp.h * (k + 0.5) / 3, hp.w * 0.32, 0, 7); g.fill(); }
    }
  }
  if (wk === 'snow') {
    // snow caps on the mast-arm poles are too fine to matter; trees carry it
  }
  void rh;
}

// Signal heads for an intersection (arterial heads on the main arm, one per
// lane, plus one cross-street head). Shared with the dynamic lamp pass.
export function signalHeads(G, it) {
  const { LH } = G;
  const px = it.cw1 + G.cwW + LH * 0.3;
  const out = [];
  const hw = Math.max(2.2, LH * 0.2), hh = hw * 2.6;
  for (let l = 0; l < sim.lanes; l++) {
    out.push({ x: px - hw / 2, y: G.top + l * LH + LH / 2 - hh / 2, w: hw, h: hh, cross: false });
  }
  out.push({ x: it.sx0 + G.csW * 0.25 - hw / 2, y: G.walkTop - LH * 0.35 - hh / 2, w: hw, h: hh, cross: true });
  return out;
}

//──────────────────────── Caching ────────────────────────
function paintGround(g) { if (cfg().style === 'city') paintCityGround(g); else paintHighwayGround(g); }
function paintTop(g) { if (cfg().style === 'city') paintCityTop(g); else paintHighwayTop(g); }

const layers = {
  ground: { paint: paintGround, base: document.createElement('canvas'), zoom: null, zi: null },
  top: { paint: paintTop, base: document.createElement('canvas'), zoom: null, zi: null },
};
let sig = '', forced = true;
let zStableSince = 0, lastZ = 1, lastX = 0, lastY = 0;
let builtThisFrame = false;

export function invalidateScene() { forced = true; }
export function sceneSignature() {
  return view.W + '|' + view.H + '|' + view.dpr + '|' + view.laneH + '|' + sim.scenario + '|' +
         sim.lanes + '|' + sim.mergeShape + '|' + sim.weather + '|' + sim.exitRamp + '|' +
         sim.buildings.length;
}

// Called once per frame before any layer is drawn.
export function prepareScene() {
  builtThisFrame = false;
  const s = sceneSignature();
  if (forced || s !== sig) {
    sig = s; forced = false;
    for (const k in layers) {
      const L = layers[k];
      L.base.width = Math.max(1, Math.round(view.W * view.dpr));
      L.base.height = Math.max(1, Math.round(view.H * view.dpr));
      const g = L.base.getContext('2d');
      g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      g.clearRect(0, 0, view.W, view.H);
      L.paint(g);
      L.zi = null;
    }
  }
  if (Math.abs(cam.z - lastZ) > 1e-4 || Math.abs(cam.x - lastX) > 0.01 || Math.abs(cam.y - lastY) > 0.01) {
    zStableSince = view.nowMs; lastZ = cam.z; lastX = cam.x; lastY = cam.y;
  }
}

export function drawLayer(ctx, name) {
  const L = layers[name];
  const W = view.W, H = view.H;
  if (cam.z < 1.15) { ctx.drawImage(L.base, 0, 0, W, H); return; }
  const vr = viewRect();
  const zi = L.zi;
  const effDpr = Math.min(view.dpr, 2);
  const want = cam.z * effDpr;
  const covers = zi && vr.x0 >= zi.x0 - 0.5 && vr.y0 >= zi.y0 - 0.5 && vr.x1 <= zi.x1 + 0.5 && vr.y1 <= zi.y1 + 0.5;
  const sharpEnough = zi && zi.scale >= want * 0.82 && zi.scale <= want * 1.6;
  const settled = view.nowMs - zStableSince > 110 && Math.abs(camT.z - cam.z) < 0.002 * cam.z;
  if ((!covers || !sharpEnough) && settled && !builtThisFrame) {
    builtThisFrame = true;                          // spread rebuilds: one layer per frame
    buildZoom(L, vr, want);
  }
  const z = L.zi;
  const zCovers = z && vr.x0 >= z.x0 - 0.5 && vr.y0 >= z.y0 - 0.5 && vr.x1 <= z.x1 + 0.5 && vr.y1 <= z.y1 + 0.5;
  if (!zCovers) ctx.drawImage(L.base, 0, 0, W, H);
  if (z && z.scale >= want * 0.6) ctx.drawImage(L.zoom, z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
}

function buildZoom(L, vr, scale) {
  const W = view.W, H = view.H;
  const vw = vr.x1 - vr.x0, vh = vr.y1 - vr.y0;
  const mx = vw * 0.3, my = vh * 0.3;
  const x0 = clamp(vr.x0 - mx, 0, W), y0 = clamp(vr.y0 - my, 0, H);
  const x1 = clamp(vr.x1 + mx, 0, W), y1 = clamp(vr.y1 + my, 0, H);
  // cap the cache at ~6 MP so phones don't blow their canvas memory budget
  let s = scale;
  const px = (x1 - x0) * (y1 - y0) * s * s;
  if (px > 6e6) s *= Math.sqrt(6e6 / px);
  if (!L.zoom) L.zoom = document.createElement('canvas');
  L.zoom.width = Math.max(1, Math.ceil((x1 - x0) * s));
  L.zoom.height = Math.max(1, Math.ceil((y1 - y0) * s));
  const g = L.zoom.getContext('2d');
  g.setTransform(s, 0, 0, s, -x0 * s, -y0 * s);
  g.clearRect(x0, y0, x1 - x0, y1 - y0);
  L.paint(g);
  L.zi = { x0, y0, x1, y1, scale: s };
}

export { pal, weatherKind, N, lutAt };
