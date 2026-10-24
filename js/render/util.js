// Small drawing / colour / randomness helpers shared by the render modules.

// Rounded-rect PATH (no fill). Radius clamped so tiny shapes stay valid.
export function rrPath(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  if (r <= 0.3) { g.rect(x, y, w, h); return; }
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
// Rounded-rect fill.
export function rr(g, x, y, w, h, r) {
  if (r <= 0.3 || w < 1 || h < 1) { g.fillRect(x, y, w, h); return; }
  rrPath(g, x, y, w, h, r);
  g.fill();
}

// Deterministic PRNG (Park–Miller) for scenery — identical across rebuilds,
// so a zoomed re-render paints exactly the same world as the 1× cache.
export function sceneRand(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

// Integer hash → [0,1). Used to derive stable per-vehicle variety from car.id.
export function hash01(n, salt = 0) {
  let x = (n * 374761393 + salt * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = t => t * t * (3 - 2 * t);

// Parse a CSS colour of the forms the engine produces ("hsl(h,s%,l%)" or
// "#rrggbb") into HSL numbers. Anything else falls back to a neutral grey.
export function parseColor(c) {
  if (typeof c === 'string') {
    const m = /hsla?\(\s*([-\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/.exec(c);
    if (m) return { h: ((+m[1] % 360) + 360) % 360, s: +m[2], l: +m[3] };
    const x = /^#([0-9a-f]{6})$/i.exec(c);
    if (x) {
      const n = parseInt(x[1], 16);
      const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
      let h = 0, s = 0;
      if (mx !== mn) {
        const d = mx - mn;
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h *= 60;
      }
      return { h, s: s * 100, l: l * 100 };
    }
  }
  return { h: 220, s: 6, l: 62 };
}
export function hsl(h, s, l, a = 1) {
  return a >= 1
    ? `hsl(${h.toFixed(0)},${clamp(s, 0, 100).toFixed(0)}%,${clamp(l, 0, 100).toFixed(0)}%)`
    : `hsla(${h.toFixed(0)},${clamp(s, 0, 100).toFixed(0)}%,${clamp(l, 0, 100).toFixed(0)}%,${a})`;
}

// Speed ratio (0 = stopped, 1 = free flow) → congestion colour (red → green).
export function speedColor(r, a = 1) {
  const hue = 120 * clamp(r, 0, 1);
  return hsl(hue, 78, 48, a);
}

// Cubic Bézier → arc-length lookup table of {x, y, a (heading), s}.
export function bezierLUT(p0, p1, p2, p3, n = 48) {
  const pts = [];
  let s = 0, px = p0.x, py = p0.y;
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const x = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
    const y = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
    const dx = 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
    const dy = 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
    if (i) s += Math.hypot(x - px, y - py);
    pts.push({ x, y, a: Math.atan2(dy, dx), s });
    px = x; py = y;
  }
  return { pts, len: s };
}
// Point on a LUT at arc length s (clamped), linearly interpolated.
export function lutAt(lut, s) {
  const p = lut.pts;
  if (s <= 0) return p[0];
  if (s >= lut.len) return p[p.length - 1];
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p[m].s < s) lo = m; else hi = m; }
  const a = p[lo], b = p[hi], t = (s - a.s) / Math.max(1e-6, b.s - a.s);
  let da = b.a - a.a;
  if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, a: a.a + da * t, s };
}
// Stroke a LUT as a polyline path (caller strokes).
export function lutPath(g, lut, s0 = 0, s1 = Infinity) {
  g.beginPath();
  let first = true;
  for (const p of lut.pts) {
    if (p.s < s0 || p.s > s1) continue;
    if (first) { g.moveTo(p.x, p.y); first = false; } else g.lineTo(p.x, p.y);
  }
}
