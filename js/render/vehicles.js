// Vehicle painter + sprite cache.
//
// Every vehicle is painted top-down in a LOCAL frame: centred on the origin,
// heading +x (front at +len/2, rear at −len/2), width h across y. The same
// vector painter renders (a) cached sprites for normal zoom levels and
// (b) live vector bodies when zoomed so deep that a sprite would be huge.
// Sprites are keyed by (body type, quantised paint, AV, on-screen size
// bucket, aspect), so 250 cars cost ~250 drawImage calls plus a few lamp
// rects for the ones braking/signalling.
//
// Visual length is ALWAYS exactly car.len × cw() — the sprite is stretched to
// the physics length — so on-screen bumper gaps match the simulation.
import { CAR_LEN, TRUCK_LEN } from '../config.js';
import { sim, cfg } from '../state.js';
import { view, cam } from './view.js';
import { rr, rrPath, hash01, parseColor, hsl } from './util.js';

//──────────────────────── Vehicle type & paint resolution ────────────────────────
const CAB_COLORS = [
  { h: 40, s: 8, l: 93 }, { h: 3, s: 68, l: 44 }, { h: 216, s: 62, l: 36 }, { h: 220, s: 6, l: 17 },
  { h: 42, s: 82, l: 52 }, { h: 146, s: 45, l: 30 }, { h: 215, s: 6, l: 62 }, { h: 22, s: 82, l: 50 },
];
const TRAILER_COLORS = [
  { h: 40, s: 6, l: 94 }, { h: 40, s: 6, l: 94 }, { h: 40, s: 6, l: 94 }, { h: 210, s: 5, l: 80 },
  { h: 210, s: 4, l: 72 }, { h: 200, s: 40, l: 88 },
];

// Body width as a fraction of the lane height (a 1.8 m car in a 3.6 m lane).
const WIDTH = {
  sedan: 0.44, hatch: 0.43, suv: 0.48, van: 0.48, pickup: 0.48,
  semi: 0.6, box: 0.58, bus: 0.62, police: 0.45, ambulance: 0.52, fire: 0.6,
};
const MAX_ASPECT = { semi: 0.30, box: 0.36, bus: 0.30, fire: 0.33, ambulance: 0.42 };

// Resolve (and memoise on the car) its rendered body type and paint.
// Prefers the engine's car.vehType when present; otherwise derives stable
// variety from car.id + isTruck so the fleet looks mixed but never flickers.
export function vehSpec(car) {
  const vt = car.vehType || '';
  if (car._spec && car._spec.vt === vt && car._spec.col === car.color && car._spec.av === !!car.isAV) {
    return car._spec;
  }
  const r = hash01(car.id || 0, 7), r2 = hash01(car.id || 0, 13);
  const city = cfg().style === 'city';
  let kind;
  if (vt === 'bus') kind = 'bus';
  else if (vt === 'truck') kind = r < 0.68 ? 'semi' : 'box';
  else if (vt === 'suv') kind = 'suv';
  else if (vt === 'van') kind = 'van';
  else if (vt === 'car') kind = r < 0.62 ? 'sedan' : r < 0.80 ? 'hatch' : 'pickup';
  else if (car.isTruck) kind = city ? (r < 0.30 ? 'bus' : r < 0.70 ? 'box' : 'semi') : (r < 0.70 ? 'semi' : r < 0.92 ? 'box' : 'bus');
  else kind = r < 0.44 ? 'sedan' : r < 0.56 ? 'hatch' : r < 0.78 ? 'suv' : r < 0.88 ? 'pickup' : 'van';

  const base = parseColor(car.color);
  let paint = base, cab = null, trailer = null;
  if (kind === 'semi' || kind === 'box') {
    cab = CAB_COLORS[Math.floor(r2 * CAB_COLORS.length)];
    trailer = kind === 'box' && r2 < 0.5 ? { h: 40, s: 6, l: 94 }
            : r2 > 0.85 ? base : TRAILER_COLORS[Math.floor(hash01(car.id, 21) * TRAILER_COLORS.length)];
    paint = cab;
  } else if (kind === 'bus') {
    paint = { h: 40, s: 6, l: 93 };
    cab = r2 < 0.5 ? { h: 212, s: 70, l: 40 } : { h: 152, s: 55, l: 34 };   // livery band
  }
  car._spec = {
    vt, col: car.color, av: !!car.isAV, kind, paint, cab, trailer,
    key: kind + '|' + qcol(paint) + '|' + (cab ? qcol(cab) : '') + '|' + (trailer ? qcol(trailer) : '') +
         '|' + (car.isAV ? 1 : 0),
  };
  return car._spec;
}
function autoKey(s) {
  return s.kind + '|' + qcol(s.paint || { h: 0, s: 0, l: 50 }) + '|' + (s.cab ? qcol(s.cab) : '') + '|' +
         (s.trailer ? qcol(s.trailer) : '') + '|' + (s.av ? 1 : 0);
}
function qcol(p) {
  const s = Math.round(p.s / 8) * 8;
  const h = s < 24 ? Math.round(p.h / 40) * 40 : Math.round(p.h / 8) * 8;
  return h + ',' + s + ',' + Math.round(p.l / 4) * 4;
}

// Rendered body width (px) for a vehicle of this kind and drawn length.
export function bodyWidth(kind, len) {
  const lh = view.laneH;
  const wf = WIDTH[kind] || 0.5;
  const ma = MAX_ASPECT[kind] || 0.56;
  return Math.max(1, Math.min(lh * wf, len * ma));
}
export function nominalLen(kind) {
  return (kind === 'semi' || kind === 'box' || kind === 'bus' || kind === 'fire') ? TRUCK_LEN : CAR_LEN;
}

//──────────────────────── Paint helpers ────────────────────────
function shade(p, dl, ds = 0) { return hsl(p.h, p.s + ds, p.l + dl); }
// Convex body gradient across the width: lit upper flank, darker lower flank
// (sun from the upper-left, consistent with every cast shadow in the scene).
function bodyGrad(g, p, hw) {
  const gr = g.createLinearGradient(0, -hw, 0, hw);
  const k = p.l > 80 ? 0.6 : 1;                       // whites need gentler falloff
  gr.addColorStop(0, shade(p, -10 * k));
  gr.addColorStop(0.16, shade(p, 7 * k));
  gr.addColorStop(0.45, shade(p, 3 * k));
  gr.addColorStop(0.82, shade(p, -6 * k));
  gr.addColorStop(1, shade(p, -18 * k));
  return gr;
}
function glassGrad(g, x0, x1) {
  const gr = g.createLinearGradient(x0, 0, x1, 0);
  gr.addColorStop(0, '#1a2430');
  gr.addColorStop(0.5, '#2c3d50');
  gr.addColorStop(1, '#16202b');
  return gr;
}
// Car body outline: squarer rear, rounder hood, slight waist taper.
function carOutline(g, x0, x1, hw, rRear, rFront) {
  const L = x1 - x0;
  g.beginPath();
  g.moveTo(x0 + rRear, -hw);
  g.bezierCurveTo(x0 + L * 0.45, -hw * 1.02, x0 + L * 0.7, -hw * 1.02, x1 - rFront, -hw * 0.97);
  g.quadraticCurveTo(x1, -hw * 0.92, x1, -hw * 0.92 + rFront);
  g.lineTo(x1, hw * 0.92 - rFront);
  g.quadraticCurveTo(x1, hw * 0.92, x1 - rFront, hw * 0.97);
  g.bezierCurveTo(x0 + L * 0.7, hw * 1.02, x0 + L * 0.45, hw * 1.02, x0 + rRear, hw);
  g.quadraticCurveTo(x0, hw, x0, hw - rRear);
  g.lineTo(x0, -hw + rRear);
  g.quadraticCurveTo(x0, -hw, x0 + rRear, -hw);
  g.closePath();
}
// Trapezoid glass panel between x0 and x1; half-widths w0 (at x0) and w1 (at x1).
function trap(g, x0, w0, x1, w1, r) {
  g.beginPath();
  g.moveTo(x0, -w0 + r); g.quadraticCurveTo(x0, -w0, x0 + r, -w0 + (w0 - w1) * 0.1);
  g.lineTo(x1 - r, -w1); g.quadraticCurveTo(x1, -w1, x1, -w1 + r);
  g.lineTo(x1, w1 - r); g.quadraticCurveTo(x1, w1, x1 - r, w1);
  g.lineTo(x0 + r, w0 - (w0 - w1) * 0.1); g.quadraticCurveTo(x0, w0, x0, w0 - r);
  g.closePath();
}
// Soft, sun-cast drop shadow faked with stacked translucent rounded rects
// (portable — no ctx.filter / shadowBlur, which differ across browsers).
function dropShadow(g, len, h, r, k = 1) {
  const ox = len * 0.03 + h * 0.10, oy = h * 0.16;
  g.fillStyle = 'rgba(0,0,0,.13)';
  rr(g, -len / 2 + ox - h * 0.10, -h / 2 + oy - h * 0.06, len + h * 0.2, h * 1.12, r + h * 0.1);
  g.fillStyle = `rgba(0,0,0,${(0.22 * k).toFixed(3)})`;
  rr(g, -len / 2 + ox, -h / 2 + oy, len, h, r);
}
function wheelsAt(g, xs, hw, wl, wt) {
  g.fillStyle = '#121418';
  for (const x of xs) {
    rr(g, x - wl / 2, -hw - wt * 0.35, wl, wt, wt * 0.4);
    rr(g, x - wl / 2, hw - wt * 0.65, wl, wt, wt * 0.4);
  }
}
function lampsBaked(g, x0, x1, hw, h, rear = '#7d1414', front = '#e9eef2') {
  const lw = Math.max(0.6, h * 0.08), lh = h * 0.2;
  g.fillStyle = rear;
  g.fillRect(x0, -hw + h * 0.07, lw, lh); g.fillRect(x0, hw - h * 0.07 - lh, lw, lh);
  g.fillStyle = front;
  g.fillRect(x1 - lw, -hw + h * 0.08, lw, lh * 0.9); g.fillRect(x1 - lw, hw - h * 0.08 - lh * 0.9, lw, lh * 0.9);
}

//──────────────────────── Body painters (local frame) ────────────────────────
// lod = on-screen length in device px; gates fine detail.
function paintCarLike(g, kind, p, len, h, lod, av) {
  const hw = h / 2, x0 = -len / 2, x1 = len / 2, L = len;
  const u = f => x0 + L * f;
  const isSuv = kind === 'suv', isVan = kind === 'van', isPick = kind === 'pickup', isHatch = kind === 'hatch';
  const rRear = h * (isSuv || isVan || isPick ? 0.16 : 0.24), rFront = h * (isVan ? 0.3 : 0.36);
  dropShadow(g, len, h, h * 0.3);
  if (lod > 26) wheelsAt(g, [u(0.2), u(0.79)], hw * 0.98, L * 0.15, h * 0.16);

  carOutline(g, x0, x1, hw, rRear, rFront);
  g.fillStyle = bodyGrad(g, p, hw);
  g.fill();
  if (lod > 16) {
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = Math.max(0.5, h * 0.035);
    g.stroke();
  }
  if (lod < 9) {                                     // tiny: single glass cabin block
    g.fillStyle = 'rgba(20,30,42,.85)';
    rr(g, u(0.3), -hw * 0.66, L * 0.42, hw * 1.32, h * 0.12);
    return;
  }
  // Cabin geometry per body style (fractions of length from the rear).
  let rw0, rw1, rf0, rf1, ws1;
  if (isVan) { rw0 = 0.03; rw1 = 0.08; rf0 = 0.08; rf1 = 0.74; ws1 = 0.84; }
  else if (isSuv) { rw0 = 0.07; rw1 = 0.13; rf0 = 0.13; rf1 = 0.64; ws1 = 0.75; }
  else if (isPick) { rw0 = 0.42; rw1 = 0.45; rf0 = 0.45; rf1 = 0.64; ws1 = 0.74; }
  else if (isHatch) { rw0 = 0.07; rw1 = 0.17; rf0 = 0.17; rf1 = 0.58; ws1 = 0.71; }
  else { rw0 = 0.17; rw1 = 0.29; rf0 = 0.29; rf1 = 0.58; ws1 = 0.72; }
  const gw = hw * 0.80, rwI = hw * 0.62;             // glass / roof half-widths
  // Greenhouse (all glass), then the roof panel laid over it.
  g.fillStyle = glassGrad(g, u(rw0), u(ws1));
  trap(g, u(rw0), rwI, u(ws1), gw * 0.98, h * 0.1);
  g.fill();
  // roof panel
  const rg = g.createLinearGradient(0, -rwI, 0, rwI);
  rg.addColorStop(0, shade(p, 12)); rg.addColorStop(0.5, shade(p, 6)); rg.addColorStop(1, shade(p, -6));
  g.fillStyle = rg;
  rr(g, u(rf0), -rwI * 0.92, L * (rf1 - rf0), rwI * 1.84, h * 0.12);
  // windshield glint + rear-window glint
  if (lod > 18) {
    g.fillStyle = 'rgba(190,215,240,.28)';
    g.beginPath();
    g.moveTo(u(rf1 + 0.025), -gw * 0.6); g.lineTo(u(rf1 + 0.06), -gw * 0.6);
    g.lineTo(u(rf1 + 0.035), gw * 0.25); g.lineTo(u(rf1 + 0.01), gw * 0.25);
    g.closePath(); g.fill();
    // roof sheen
    g.fillStyle = 'rgba(255,255,255,.14)';
    rr(g, u(rf0 + 0.03), -rwI * 0.75, L * (rf1 - rf0 - 0.06), rwI * 0.45, h * 0.08);
  }
  if (isPick) {                                      // open cargo bed
    g.fillStyle = shade(p, -22);
    rr(g, u(0.04), -hw * 0.78, L * 0.36, hw * 1.56, h * 0.06);
    if (lod > 30) {
      g.strokeStyle = shade(p, -30); g.lineWidth = Math.max(0.4, h * 0.03);
      g.beginPath();
      for (let k = 1; k < 5; k++) { const yy = -hw * 0.78 + k * hw * 0.312; g.moveTo(u(0.06), yy); g.lineTo(u(0.38), yy); }
      g.stroke();
    }
  }
  if (isSuv && lod > 30) {                           // roof rails
    g.fillStyle = 'rgba(25,25,28,.55)';
    g.fillRect(u(rf0 + 0.02), -rwI * 0.86, L * (rf1 - rf0 - 0.04), Math.max(0.5, h * 0.035));
    g.fillRect(u(rf0 + 0.02), rwI * 0.86 - Math.max(0.5, h * 0.035), L * (rf1 - rf0 - 0.04), Math.max(0.5, h * 0.035));
  }
  if (lod > 40) {                                    // hood / trunk shut lines
    g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = Math.max(0.4, h * 0.02);
    g.beginPath();
    g.moveTo(u(0.86), -hw * 0.6); g.quadraticCurveTo(u(0.9), 0, u(0.86), hw * 0.6);
    if (!isPick && !isVan) { g.moveTo(u(0.1), -hw * 0.62); g.lineTo(u(0.1), hw * 0.62); }
    g.stroke();
  }
  if (lod > 22) {                                    // side mirrors at the A-pillar
    g.fillStyle = shade(p, -8);
    const mx = u(ws1 - 0.06), mw = L * 0.05, mh = h * 0.1;
    rr(g, mx, -hw - mh * 0.7, mw, mh, mh * 0.3);
    rr(g, mx, hw - mh * 0.3, mw, mh, mh * 0.3);
  }
  lampsBaked(g, x0 + h * 0.02, x1 - h * 0.02, hw * 0.94, h);
  if (av) avSensor(g, u((rf0 + rf1) / 2), h, lod);
}

// Lidar puck on the roof + teal accent: subtle, but distinctive once you know it.
function avSensor(g, x, h, lod) {
  const r = Math.max(0.9, h * 0.15);
  g.fillStyle = '#1b1f24';
  g.beginPath(); g.arc(x, 0, r, 0, 7); g.fill();
  g.strokeStyle = '#3fe0d0'; g.lineWidth = Math.max(0.5, r * 0.35);
  g.beginPath(); g.arc(x, 0, r * 0.98, 0, 7); g.stroke();
  if (lod > 30) {
    g.fillStyle = '#9ff7ee';
    g.beginPath(); g.arc(x - r * 0.25, -r * 0.25, r * 0.28, 0, 7); g.fill();
  }
}

function paintSemi(g, spec, len, h, lod) {
  const hw = h / 2, x0 = -len / 2, L = len, u = f => x0 + L * f;
  const cab = spec.cab, tr = spec.trailer;
  dropShadow(g, len, h, h * 0.12, 1.1);
  const trEnd = 0.755, cabStart = 0.775;
  if (lod > 24) {
    wheelsAt(g, [u(0.06), u(0.12), u(0.18)], hw * 0.98, L * 0.045, h * 0.13);
    wheelsAt(g, [u(0.81), u(0.86), u(0.965)], hw * 0.92, L * 0.035, h * 0.13);
  }
  // trailer box
  g.fillStyle = bodyGrad(g, tr, hw);
  rr(g, x0, -hw, L * trEnd, h, h * 0.06);
  g.strokeStyle = 'rgba(20,22,28,.45)'; g.lineWidth = Math.max(0.5, h * 0.03);
  g.strokeRect(x0 + 0.3, -hw + 0.3, L * trEnd - 0.6, h - 0.6);
  if (lod > 30) {                                    // roof bows / ribs
    g.strokeStyle = 'rgba(0,0,0,.09)'; g.lineWidth = Math.max(0.4, h * 0.02);
    g.beginPath();
    const n = Math.max(6, Math.round(trEnd * L / (h * 0.5)));
    for (let k = 1; k < n; k++) { const x = x0 + (L * trEnd) * k / n; g.moveTo(x, -hw + 1); g.lineTo(x, hw - 1); }
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,.18)';
    g.fillRect(x0 + 1, -hw * 0.82, L * trEnd - 2, hw * 0.35);
  }
  // fifth-wheel gap & tractor chassis
  g.fillStyle = '#26282d';
  g.fillRect(u(trEnd - 0.01), -hw * 0.5, L * (cabStart - trEnd + 0.03), hw);
  // tractor: sleeper + cab + hood
  const cx0 = u(cabStart), cx1 = u(1), cL = cx1 - cx0;
  carOutline(g, cx0, cx1, hw * 0.94, h * 0.08, h * 0.22);
  g.fillStyle = bodyGrad(g, cab, hw);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = Math.max(0.5, h * 0.03); g.stroke();
  if (lod > 14) {
    // roof fairing (lighter) + windshield band
    g.fillStyle = shade(cab, 8);
    rr(g, cx0 + cL * 0.04, -hw * 0.74, cL * 0.42, hw * 1.48, h * 0.1);
    g.fillStyle = glassGrad(g, cx0 + cL * 0.5, cx0 + cL * 0.64);
    rr(g, cx0 + cL * 0.5, -hw * 0.8, cL * 0.13, hw * 1.6, h * 0.05);
    if (lod > 34) {
      g.fillStyle = '#b9bcc2';                       // exhaust stacks
      g.beginPath(); g.arc(cx0 + cL * 0.47, -hw * 0.86, h * 0.05, 0, 7); g.arc(cx0 + cL * 0.47, hw * 0.86, h * 0.05, 0, 7); g.fill();
      g.fillStyle = 'rgba(0,0,0,.25)';               // hood seam
      g.fillRect(cx0 + cL * 0.8, -hw * 0.7, Math.max(0.4, h * 0.02), hw * 1.4);
      g.fillStyle = shade(cab, -10);                 // mirrors
      g.fillRect(cx0 + cL * 0.58, -hw - h * 0.12, cL * 0.04, h * 0.12);
      g.fillRect(cx0 + cL * 0.58, hw, cL * 0.04, h * 0.12);
    }
  }
  lampsBaked(g, x0 + 0.2, cx1 - h * 0.02, hw * 0.94, h);
  if (spec.av) avSensor(g, cx0 + cL * 0.3, h, lod);
}

function paintBox(g, spec, len, h, lod) {
  const hw = h / 2, x0 = -len / 2, L = len, u = f => x0 + L * f;
  const cab = spec.cab, box = spec.trailer;
  dropShadow(g, len, h, h * 0.12, 1.1);
  if (lod > 24) {
    wheelsAt(g, [u(0.12), u(0.2)], hw * 0.98, L * 0.06, h * 0.13);
    wheelsAt(g, [u(0.86)], hw * 0.92, L * 0.06, h * 0.13);
  }
  const bEnd = 0.73;
  g.fillStyle = bodyGrad(g, box, hw);
  rr(g, x0, -hw, L * bEnd, h, h * 0.05);
  g.strokeStyle = 'rgba(20,22,28,.45)'; g.lineWidth = Math.max(0.5, h * 0.03);
  g.strokeRect(x0 + 0.3, -hw + 0.3, L * bEnd - 0.6, h - 0.6);
  if (lod > 30) {
    g.fillStyle = 'rgba(255,255,255,.2)';
    g.fillRect(x0 + 1, -hw * 0.82, L * bEnd - 2, hw * 0.34);
    g.fillStyle = shade(cab, 0);                     // company stripe on the roof
    g.fillRect(x0 + L * 0.05, hw * 0.35, L * (bEnd - 0.1), hw * 0.22);
  }
  const cx0 = u(bEnd + 0.015), cx1 = u(1), cL = cx1 - cx0;
  carOutline(g, cx0, cx1, hw * 0.93, h * 0.08, h * 0.26);
  g.fillStyle = bodyGrad(g, cab, hw); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = Math.max(0.5, h * 0.03); g.stroke();
  if (lod > 14) {
    g.fillStyle = shade(cab, 9);
    rr(g, cx0 + cL * 0.05, -hw * 0.72, cL * 0.45, hw * 1.44, h * 0.1);
    g.fillStyle = glassGrad(g, cx0 + cL * 0.52, cx0 + cL * 0.7);
    rr(g, cx0 + cL * 0.52, -hw * 0.8, cL * 0.17, hw * 1.6, h * 0.05);
  }
  lampsBaked(g, x0 + 0.2, cx1 - h * 0.02, hw * 0.94, h);
  if (spec.av) avSensor(g, cx0 + cL * 0.3, h, lod);
}

function paintBus(g, spec, len, h, lod) {
  const hw = h / 2, x0 = -len / 2, L = len, u = f => x0 + L * f;
  dropShadow(g, len, h, h * 0.2, 1.1);
  if (lod > 24) wheelsAt(g, [u(0.2), u(0.8)], hw * 0.98, L * 0.06, h * 0.12);
  g.fillStyle = bodyGrad(g, spec.paint, hw);
  rr(g, x0, -hw, L, h, h * 0.2);
  g.strokeStyle = 'rgba(20,22,28,.45)'; g.lineWidth = Math.max(0.5, h * 0.03);
  rrPath(g, x0, -hw, L, h, h * 0.2); g.stroke();
  // livery band along the flanks + side window strips
  g.fillStyle = shade(spec.cab, 0);
  g.fillRect(u(0.02), -hw * 0.98, L * 0.96, hw * 0.16);
  g.fillRect(u(0.02), hw * 0.82, L * 0.96, hw * 0.16);
  if (lod > 14) {
    g.fillStyle = 'rgba(25,35,48,.8)';
    g.fillRect(u(0.06), -hw * 0.84, L * 0.86, hw * 0.13);
    g.fillRect(u(0.06), hw * 0.71, L * 0.86, hw * 0.13);
    // windshield wrap at the front
    g.fillStyle = glassGrad(g, u(0.95), u(1));
    rr(g, u(0.955), -hw * 0.86, L * 0.04, hw * 1.72, h * 0.08);
  }
  if (lod > 30) {
    // rooftop AC pods + escape hatches
    g.fillStyle = '#d9dcdf';
    rr(g, u(0.12), -hw * 0.45, L * 0.18, hw * 0.9, h * 0.1);
    g.fillStyle = 'rgba(0,0,0,.18)';
    g.fillRect(u(0.15), -hw * 0.3, L * 0.12, Math.max(0.4, h * 0.02));
    g.fillRect(u(0.15), hw * 0.28, L * 0.12, Math.max(0.4, h * 0.02));
    g.fillStyle = 'rgba(0,0,0,.12)';
    rr(g, u(0.45), -hw * 0.25, L * 0.07, hw * 0.5, h * 0.04);
    rr(g, u(0.68), -hw * 0.25, L * 0.07, hw * 0.5, h * 0.04);
  }
  lampsBaked(g, x0 + 0.2, u(1) - h * 0.02, hw * 0.9, h);
  if (spec.av) avSensor(g, u(0.55), h, lod);
}

// Emergency + incident vehicles (drawn live, never cached — there are few).
function paintEmergency(g, kind, len, h, lod) {
  const hw = h / 2, x0 = -len / 2, L = len, u = f => x0 + L * f;
  if (kind === 'police') {
    paintCarLike(g, 'sedan', { h: 220, s: 8, l: 14 }, len, h, lod, false);
    g.fillStyle = '#f1f2f4';                         // white doors / roof
    rr(g, u(0.3), -hw * 0.55, L * 0.26, hw * 1.1, h * 0.1);
    return;
  }
  const isFire = kind === 'fire';
  const p = isFire ? { h: 2, s: 74, l: 44 } : { h: 40, s: 6, l: 95 };
  dropShadow(g, len, h, h * 0.12, 1.1);
  if (lod > 24) wheelsAt(g, isFire ? [u(0.14), u(0.24), u(0.82)] : [u(0.16), u(0.8)], hw * 0.98, L * 0.07, h * 0.13);
  g.fillStyle = bodyGrad(g, p, hw);
  rr(g, x0, -hw, L, h, h * 0.12);
  g.strokeStyle = 'rgba(20,22,28,.45)'; g.lineWidth = Math.max(0.5, h * 0.03);
  rrPath(g, x0, -hw, L, h, h * 0.12); g.stroke();
  if (isFire) {
    // aerial ladder down the roof centre
    g.fillStyle = '#c9ccd2';
    g.fillRect(u(0.04), -hw * 0.22, L * 0.78, hw * 0.44);
    g.strokeStyle = '#7d8189'; g.lineWidth = Math.max(0.4, h * 0.025);
    g.beginPath();
    for (let k = 0; k < 14; k++) { const x = u(0.06 + k * 0.054); g.moveTo(x, -hw * 0.2); g.lineTo(x, hw * 0.2); }
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,.75)';           // reflective stripes
    g.fillRect(u(0.02), -hw * 0.95, L * 0.96, hw * 0.08); g.fillRect(u(0.02), hw * 0.87, L * 0.96, hw * 0.08);
  } else {
    g.fillStyle = '#d6332b';                         // ambulance stripe + cross
    g.fillRect(u(0.02), -hw * 0.95, L * 0.96, hw * 0.16); g.fillRect(u(0.02), hw * 0.79, L * 0.96, hw * 0.16);
    const cx = u(0.4), s = h * 0.3;
    g.fillRect(cx - s / 2, -s / 6, s, s / 3); g.fillRect(cx - s / 6, -s / 2, s / 3, s);
  }
  g.fillStyle = glassGrad(g, u(0.86), u(0.96));
  rr(g, u(0.87), -hw * 0.82, L * 0.08, hw * 1.64, h * 0.05);
  lampsBaked(g, x0 + 0.2, u(1) - h * 0.02, hw * 0.94, h);
}

// Paint any spec in the local frame. Public for parked cars / ramp queues.
export function paintVehicle(g, spec, len, h, lod) {
  const k = spec.kind;
  if (k === 'semi') paintSemi(g, spec, len, h, lod);
  else if (k === 'box') paintBox(g, spec, len, h, lod);
  else if (k === 'bus') paintBus(g, spec, len, h, lod);
  else if (k === 'police' || k === 'ambulance' || k === 'fire') paintEmergency(g, k, len, h, lod);
  else paintCarLike(g, k, spec.paint, len, h, lod, spec.av);
}

//──────────────────────── Sprite cache ────────────────────────
const sprites = new Map();
let budget = 0;                       // new sprites allowed this frame
const MAX_SPRITES = 700;
export function resetSpriteBudget() { budget = 28; }
export function clearSprites() { sprites.clear(); }
const SPRITE_MAX_PX = 420;            // above this on-screen length, draw vector

// Draw a vehicle centred at (cx, cy) world coords, rotated by rot, at exactly
// len × h world px. Uses a cached sprite when sensible.
export function drawVehicle(ctx, spec, cx, cy, len, h, rot) {
  const scale = cam.z * view.dpr;
  const lodPx = len * scale;
  if (lodPx > SPRITE_MAX_PX || lodPx < 3) {
    ctx.save();
    ctx.translate(cx, cy);
    if (rot) ctx.rotate(rot);
    paintVehicle(ctx, spec, len, h, lodPx);
    ctx.restore();
    return;
  }
  // Size bucket: ~12% steps of on-screen length (sprites are rendered a hair
  // above the bucket so downsampling keeps them crisp).
  const bucket = Math.ceil(Math.log2(lodPx) * 6);
  const aspect = Math.round((h / len) * 40);
  if (!spec.key) spec.key = autoKey(spec);
  const key = spec.key + '|' + bucket + '|' + aspect;
  let sp = sprites.get(key);
  if (!sp) {
    if (budget <= 0) {                // over this frame's budget: draw live
      ctx.save(); ctx.translate(cx, cy); if (rot) ctx.rotate(rot);
      paintVehicle(ctx, spec, len, h, lodPx);
      ctx.restore();
      return;
    }
    budget--;
    if (sprites.size > MAX_SPRITES) sprites.clear();
    sp = makeSprite(spec, Math.pow(2, bucket / 6), aspect / 40);
    sprites.set(key, sp);
  }
  const k = len / sp.L;               // world px per sprite px (length axis)
  const ky = h / (sp.L * sp.aspect);  // … and across
  const dw = sp.cv.width * k, dh = sp.cv.height * ky;
  if (rot) {
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.drawImage(sp.cv, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(sp.cv, cx - dw / 2, cy - dh / 2, dw, dh);
  }
}
function makeSprite(spec, L, aspect) {
  const h = L * aspect;
  const padX = L * 0.08 + h * 0.3, padY = h * 0.42;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(L + padX * 2);
  cv.height = Math.ceil(h + padY * 2);
  const g = cv.getContext('2d');
  g.translate(cv.width / 2, cv.height / 2);
  paintVehicle(g, spec, L, h, L);
  return { cv, L, aspect };
}

//──────────────────────── Live lamps, indicators, badges ────────────────────────
const glowCache = {};
function glowSprite(col) {
  if (glowCache[col]) return glowCache[col];
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, col.replace('A', '1'));
  gr.addColorStop(0.35, col.replace('A', '.45'));
  gr.addColorStop(1, col.replace('A', '0'));
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return (glowCache[col] = cv);
}
export const GLOW_RED = 'rgba(255,40,30,A)';
export const GLOW_AMBER = 'rgba(255,170,40,A)';
export const GLOW_WHITE = 'rgba(255,244,214,A)';
export const GLOW_BLUE = 'rgba(40,110,255,A)';
export const GLOW_TEAL = 'rgba(60,230,210,A)';
export function glow(ctx, col, x, y, rx, ry = rx) {
  ctx.drawImage(glowSprite(col), x - rx, y - ry, rx * 2, ry * 2);
}

let beamCv = null;
function beamSprite() {
  if (beamCv) return beamCv;
  beamCv = document.createElement('canvas');
  beamCv.width = 128; beamCv.height = 64;
  const g = beamCv.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 128, 0);
  gr.addColorStop(0, 'rgba(255,246,220,.75)');
  gr.addColorStop(0.5, 'rgba(255,246,220,.25)');
  gr.addColorStop(1, 'rgba(255,246,220,0)');
  g.fillStyle = gr;
  g.beginPath(); g.moveTo(0, 26); g.lineTo(128, 0); g.lineTo(128, 64); g.lineTo(0, 38); g.closePath(); g.fill();
  return beamCv;
}

// Dynamic lights for one vehicle in its local frame (ctx already translated &
// rotated to the vehicle centre). Drawn after all bodies.
//   brake: 0..1 intensity, signal: −1/0/+1 (blink-gated by caller),
//   beams: draw headlight cones (bad weather), hazard: both indicators.
export function drawLamps(ctx, len, h, brake, signal, beams, hazard) {
  const hw = h / 2, x0 = -len / 2, x1 = len / 2;
  const lw = Math.max(0.8, h * 0.1), lh = h * 0.22;
  if (beams) {
    const bl = Math.max(len * 1.1, h * 3.2), bw = h * 1.3;
    ctx.globalAlpha = 0.33 * beams;
    ctx.drawImage(beamSprite(), x1 - 1, -hw * 0.55 - bw / 2, bl, bw);
    ctx.drawImage(beamSprite(), x1 - 1, hw * 0.55 - bw / 2, bl, bw);
    ctx.globalAlpha = 1;
  }
  if (brake > 0.02) {
    ctx.globalAlpha = Math.min(1, brake);
    glow(ctx, GLOW_RED, x0, -hw * 0.62, h * 0.55, h * 0.42);
    glow(ctx, GLOW_RED, x0, hw * 0.62, h * 0.55, h * 0.42);
    ctx.fillStyle = '#ff2a1f';
    ctx.fillRect(x0, -hw + h * 0.06, lw, lh); ctx.fillRect(x0, hw - h * 0.06 - lh, lw, lh);
    ctx.globalAlpha = 1;
  }
  const sides = hazard ? [-1, 1] : signal ? [signal] : null;
  if (sides) {
    for (const s of sides) {
      const y = s > 0 ? hw - h * 0.1 : -hw + h * 0.1;
      glow(ctx, GLOW_AMBER, x0 + lw, y, h * 0.42);
      glow(ctx, GLOW_AMBER, x1 - lw, y, h * 0.42);
      ctx.fillStyle = '#ffb02e';
      const sz = Math.max(1, h * 0.17);
      ctx.fillRect(x0, y - sz / 2, sz, sz); ctx.fillRect(x1 - sz, y - sz / 2, sz, sz);
    }
  }
}

// Emergency light bar (alternating red/blue strobes) on a vehicle roof.
export function drawLightbar(ctx, len, h, t, kind) {
  const hw = h / 2, x = kind === 'police' ? len * -0.03 : len * 0.32;
  const phase = Math.floor(t / 140) % 4;
  const leftOn = phase === 0 || phase === 2, rightOn = phase === 1 || phase === 3;
  const bw = Math.max(1, len * 0.06), bh = h * 0.36;
  ctx.fillStyle = leftOn ? '#ff3b3b' : '#5a1414';
  ctx.fillRect(x - bw / 2, -hw * 0.75, bw, bh);
  ctx.fillStyle = rightOn ? '#3b7bff' : '#14235a';
  ctx.fillRect(x - bw / 2, hw * 0.75 - bh, bw, bh);
  if (leftOn) glow(ctx, GLOW_RED, x, -hw * 0.5, h * 1.5);
  if (rightOn) glow(ctx, GLOW_BLUE, x, hw * 0.5, h * 1.5);
}

// Distracted-driver badge: a little phone in a speech bubble above the car,
// fixed on-screen size regardless of zoom.
export function drawPhoneBadge(ctx, x, y, t) {
  const s = 1 / cam.z;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  const bob = Math.sin(t / 180) * 1.2;
  ctx.translate(0, bob);
  ctx.fillStyle = 'rgba(15,18,26,.82)';
  rr(ctx, -8, -19, 16, 15, 4);
  ctx.beginPath(); ctx.moveTo(-3, -4.5); ctx.lineTo(3, -4.5); ctx.lineTo(0, 0); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#ffd34d';                         // phone body
  rr(ctx, -3.6, -17, 7.2, 11, 1.6);
  ctx.fillStyle = '#26324a';                         // screen
  ctx.fillRect(-2.4, -15.6, 4.8, 7.6);
  ctx.fillStyle = 'rgba(140,200,255,.9)';
  ctx.fillRect(-1.6, -14.6, 3.2, 1.2); ctx.fillRect(-1.6, -12.6, 2.2, 1.2);
  ctx.restore();
}
