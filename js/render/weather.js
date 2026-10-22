// Screen-space weather: rain streaks + splashes, drifting fog banks, falling
// snow. (Wet asphalt, puddles and snow cover live in the static layer; light
// reflections/headlight beams live in the vehicle pass.) Everything here is
// a pure function of wall time — no per-particle state — so it's cheap and
// deterministic, and it never interacts with the camera.
import { sim } from '../state.js';
import { view, cam } from './view.js';

let fogTex = null;
function fogTexture() {
  if (fogTex) return fogTex;
  fogTex = document.createElement('canvas');
  fogTex.width = 512; fogTex.height = 256;
  const g = fogTex.getContext('2d');
  let s = 7771;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 70; i++) {
    const x = r() * 512, y = r() * 256, rad = 30 + r() * 90;
    // draw wrapped copies so the texture tiles horizontally
    for (const ox of [-512, 0, 512]) {
      const gr = g.createRadialGradient(x + ox, y, 0, x + ox, y, rad);
      gr.addColorStop(0, `rgba(225,230,236,${(0.25 + r() * 0.2).toFixed(2)})`);
      gr.addColorStop(1, 'rgba(225,230,236,0)');
      g.fillStyle = gr;
      g.fillRect(x + ox - rad, y - rad, rad * 2, rad * 2);
    }
  }
  return fogTex;
}

export function drawWeather(ctx) {
  const w = sim.weather, W = view.W, H = view.H, t = view.nowMs;
  if (w === 'rain') rain(ctx, W, H, t);
  else if (w === 'fog') fog(ctx, W, H, t);
  else if (w === 'snow') snow(ctx, W, H, t);
}

function rain(ctx, W, H, t) {
  ctx.fillStyle = 'rgba(26,38,62,.20)';               // overcast storm cast
  ctx.fillRect(0, 0, W, H);
  const k = t / 1000;
  const slant = 0.22;
  const layers = [
    { n: Math.round(W * H / 9000), len: 9, sp: 900, a: 0.22, lw: 0.8 },
    { n: Math.round(W * H / 16000), len: 16, sp: 1400, a: 0.32, lw: 1.0 },
    { n: Math.round(W * H / 60000), len: 26, sp: 2100, a: 0.38, lw: 1.3 },
  ];
  for (let li = 0; li < layers.length; li++) {
    const L = layers[li];
    ctx.strokeStyle = `rgba(190,210,240,${L.a})`;
    ctx.lineWidth = L.lw;
    ctx.beginPath();
    for (let i = 0; i < L.n; i++) {
      const sx = hashf(i, li * 3 + 1), sy = hashf(i, li * 3 + 2);
      const y = ((sy * H + k * L.sp) % (H + 40)) - 20;
      const x = ((sx * (W + 60) + y * slant) % (W + 60)) - 30;
      ctx.moveTo(x, y); ctx.lineTo(x - L.len * slant, y - L.len);
    }
    ctx.stroke();
  }
  // splash ripples on the ground: short-lived expanding ellipses
  ctx.strokeStyle = 'rgba(200,220,245,.35)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  const n = Math.round(W * H / 12000);
  for (let i = 0; i < n; i++) {
    const period = 0.55 + hashf(i, 9) * 0.5;
    const ph = ((k + hashf(i, 7) * period) % period) / period;
    const cycle = Math.floor((k + hashf(i, 7) * period) / period);
    const x = hashf(i * 31 + cycle, 11) * W, y = hashf(i * 17 + cycle, 13) * H;
    const r = 1 + ph * 4 * Math.min(2, Math.sqrt(cam.z));
    ctx.moveTo(x + r, y);
    ctx.ellipse(x, y, r, r * 0.45, 0, 0, 7);
  }
  ctx.globalAlpha = 0.8;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function fog(ctx, W, H, t) {
  ctx.fillStyle = 'rgba(214,220,228,.30)';            // uniform veil (contrast loss)
  ctx.fillRect(0, 0, W, H);
  // thicker toward the screen edges, thinner mid-screen where the road is
  const gr = ctx.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, 'rgba(214,220,228,.45)');
  gr.addColorStop(0.42, 'rgba(214,220,228,.05)');
  gr.addColorStop(0.58, 'rgba(214,220,228,.05)');
  gr.addColorStop(1, 'rgba(214,220,228,.45)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  // two drifting banks of the tiling fog texture, parallax-offset
  const tex = fogTexture();
  const k = t / 1000;
  for (const [sp, sc, a, oy] of [[9, 2.2, 0.55, 0], [16, 3.4, 0.4, 0.35]]) {
    const tw = tex.width * sc, th = tex.height * sc;
    const ox = -((k * sp) % tw);
    ctx.globalAlpha = a;
    for (let y = -th * oy; y < H; y += th)
      for (let x = ox; x < W; x += tw) ctx.drawImage(tex, x, y, tw, th);
  }
  ctx.globalAlpha = 1;
}

function snow(ctx, W, H, t) {
  ctx.fillStyle = 'rgba(220,230,245,.10)';            // bright overcast
  ctx.fillRect(0, 0, W, H);
  const k = t / 1000;
  const layers = [
    { n: Math.round(W * H / 5000), r: 0.9, sp: 34, a: 0.55, sway: 6 },
    { n: Math.round(W * H / 11000), r: 1.6, sp: 58, a: 0.75, sway: 10 },
    { n: Math.round(W * H / 40000), r: 2.6, sp: 90, a: 0.9, sway: 16 },
  ];
  for (let li = 0; li < layers.length; li++) {
    const L = layers[li];
    ctx.fillStyle = `rgba(255,255,255,${L.a})`;
    ctx.beginPath();
    for (let i = 0; i < L.n; i++) {
      const sx = hashf(i, li * 5 + 21), sy = hashf(i, li * 5 + 22), ph = hashf(i, li * 5 + 23) * 6.28;
      const y = ((sy * H + k * L.sp * (0.8 + sx * 0.4)) % (H + 20)) - 10;
      const x = ((sx * W + k * 12 + Math.sin(k * 0.9 + ph) * L.sway) % (W + 20) + W + 20) % (W + 20) - 10;
      ctx.moveTo(x + L.r, y);
      ctx.arc(x, y, L.r, 0, 6.283);
    }
    ctx.fill();
  }
}

function hashf(i, s) {
  let x = (i * 374761393 + s * 668265263) | 0;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
