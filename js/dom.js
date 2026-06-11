// Tiny shared DOM helpers.
export const $ = id => document.getElementById(id);
export function fmt(x, d = 0) { return Number.isFinite(x) ? x.toFixed(d) : '–'; }
