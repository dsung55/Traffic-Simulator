// One shared, accessible info popover. Any element can attach explanatory
// content; it shows on hover (fine pointers, after a short delay), on keyboard
// focus, and toggles "pinned" on click/tap. Esc or a click elsewhere closes it.
import { $ } from '../dom.js';

let pop, owner = null, pinned = false, hoverT = 0, hideT = 0;
const finePointer = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function esc(s) {
  return String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
}

function render(content) {
  const c = typeof content === 'function' ? content() : content;
  let html = '';
  if (c.title) html += `<div class="popTitle">${esc(c.title)}</div>`;
  if (c.what) html += `<p><span class="popTag">What</span>${esc(c.what)}</p>`;
  if (c.why) html += `<p><span class="popTag why">Why it matters</span>${esc(c.why)}</p>`;
  if (c.extra) html += `<p class="popExtra">${esc(c.extra)}</p>`;
  if (c.kbd) html += `<p class="popKbd">Shortcut <kbd>${esc(c.kbd)}</kbd></p>`;
  return html;
}

function place(el) {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = r.left + r.width / 2 - pw / 2;
  x = Math.max(8, Math.min(vw - pw - 8, x));
  // Prefer below; flip above if there's no room (controls live in the bottom dock).
  let y = r.bottom + 8, above = false;
  if (y + ph > vh - 8) { y = r.top - ph - 8; above = true; }
  if (y < 8) y = 8;
  pop.style.left = Math.round(x) + 'px';
  pop.style.top = Math.round(y) + 'px';
  pop.classList.toggle('above', above);
  const ax = Math.max(14, Math.min(pw - 14, r.left + r.width / 2 - x));
  pop.style.setProperty('--ax', ax + 'px');
}

export function showPopover(el, content, pin = false) {
  clearTimeout(hideT);
  owner = el; pinned = pin;
  pop.innerHTML = render(content);
  pop.classList.add('show');
  pop.setAttribute('aria-hidden', 'false');
  el.setAttribute('aria-describedby', 'pop');
  place(el);
}

export function hidePopover() {
  clearTimeout(hoverT);
  if (owner) owner.removeAttribute('aria-describedby');
  owner = null; pinned = false;
  pop.classList.remove('show');
  pop.setAttribute('aria-hidden', 'true');
}

export function attachInfo(el, content) {
  el.addEventListener('click', e => {
    e.stopPropagation();
    if (owner === el && pinned) hidePopover();
    else showPopover(el, content, true);
  });
  el.addEventListener('pointerenter', () => {
    if (!finePointer() || pinned) return;
    clearTimeout(hoverT); clearTimeout(hideT);
    hoverT = setTimeout(() => showPopover(el, content, false), 280);
  });
  el.addEventListener('pointerleave', () => {
    clearTimeout(hoverT);
    if (owner === el && !pinned) hideT = setTimeout(hidePopover, 120);
  });
  el.addEventListener('focus', () => { if (el.matches(':focus-visible')) showPopover(el, content, false); });
  el.addEventListener('blur', () => { if (owner === el && !pinned) hidePopover(); });
}

export function initPopover() {
  pop = $('pop');
  document.addEventListener('click', e => { if (owner && !pop.contains(e.target)) hidePopover(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && owner) hidePopover(); });
  // Scrolling a panel or resizing moves the anchor: simplest correct thing is to close.
  document.addEventListener('scroll', () => { if (owner) hidePopover(); }, true);
  window.addEventListener('resize', () => { if (owner) hidePopover(); });
}
