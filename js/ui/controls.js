// Builds the tabbed control dock from the declarative CONTROLS table and keeps
// every widget in sync with `sim` (values, units, availability per scenario,
// "modified from default" markers, live hint lines).
import { $ } from '../dom.js';
import {
  GROUPS, CONTROLS, resolve, inScenario, fmtValue, defaultsFor,
} from './spec.js';
import { attachInfo } from './popover.js';

const els = {};          // key -> { root, input, val, hint, reset, seg, sigOpts }
let activeTab = 'demand';
let handlers = { onSet() {}, onAction() {} };

function svgIcon(d, size = 15) {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor"
    stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
}
const RESET_ICON = 'M13.2 8a5.2 5.2 0 1 1-1.6-3.76M12.2 1.6v3h-3';

function h(tag, attrs = {}, html = '') {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v; else el.setAttribute(k, v === true ? '' : v);
  }
  if (html) el.innerHTML = html;
  return el;
}

function infoButton(c) {
  const b = h('button', { class: 'info', type: 'button', 'aria-label': `About ${c.label}` }, 'i');
  attachInfo(b, () => ({ title: c.label, what: c.info.what, why: c.info.why, kbd: c.kbd }));
  return b;
}

function resetButton(c) {
  const b = h('button', { class: 'ctlReset', type: 'button', title: 'Reset to default',
    'aria-label': `Reset ${c.label} to default` }, svgIcon(RESET_ICON, 12));
  b.addEventListener('click', () => {
    const d = defaultsFor(handlers.sim.scenario)[c.key];
    if (d !== undefined) handlers.onSet(c.key, d);
  });
  return b;
}

function buildControl(c) {
  const id = 'in-' + c.key;
  const root = h('div', { class: 'ctl t-' + c.type + (c.parent ? ' child' : ''), id: 'c-' + c.key, 'data-key': c.key });
  const head = h('div', { class: 'ctlHead' });
  const rec = { root };

  if (c.type === 'toggle') {
    const lab = h('label', { class: 'toggle', for: id });
    const input = h('input', { type: 'checkbox', id, role: 'switch' });
    lab.append(input, h('span', { class: 'tg', 'aria-hidden': 'true' }), h('span', { class: 'tgText' }, c.label));
    input.addEventListener('change', () => handlers.onSet(c.key, input.checked));
    head.append(lab, infoButton(c));
    rec.input = input;
  } else {
    const lab = c.type === 'seg' || c.type === 'action'
      ? h('span', { class: 'ctlLabel', id: 'lb-' + c.key })
      : h('label', { class: 'ctlLabel', for: id });
    lab.innerHTML = (c.dot ? `<i class="${c.dot}" aria-hidden="true"></i>` : '') + c.label;
    head.append(lab, infoButton(c));
    if (c.type === 'range') {
      rec.val = h('output', { class: 'val', for: id, 'aria-live': 'off' });
      head.append(rec.val);
    }
  }
  if (c.type !== 'action') { rec.reset = resetButton(c); head.append(rec.reset); }
  root.append(head);

  if (c.type === 'range') {
    const input = h('input', { type: 'range', id, 'aria-label': c.label });
    input.addEventListener('input', () => {
      handlers.onSet(c.key, +input.value);
      if (rec.val) { rec.val.classList.remove('bump'); void rec.val.offsetWidth; rec.val.classList.add('bump'); }
    });
    root.append(input);
    rec.input = input;
  } else if (c.type === 'select') {
    const input = h('select', { id });
    input.addEventListener('change', () => handlers.onSet(c.key, input.value));
    root.append(input);
    rec.input = input;
  } else if (c.type === 'seg') {
    const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'lb-' + c.key });
    seg.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();   // keep arrows from panning the camera
      const btns = [...seg.querySelectorAll('button')];
      const i = btns.indexOf(document.activeElement);
      const n = btns[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + btns.length) % btns.length];
      n.focus(); n.click();
    });
    root.append(seg);
    rec.seg = seg;
  } else if (c.type === 'action') {
    const btn = h('button', { class: 'btn action', type: 'button', id, 'aria-labelledby': 'lb-' + c.key },
      svgIcon('M8 2 1.8 13h12.4zM8 6.5v3M8 11.4v.01') + `<span>${c.button || c.label}</span>` +
      (c.kbd ? `<kbd>${c.kbd}</kbd>` : ''));
    btn.addEventListener('click', () => handlers.onAction(c.key));
    root.append(btn);
    rec.input = btn;
  }
  rec.hint = h('p', { class: 'ctlHint', id: 'hint-' + c.key });
  root.append(rec.hint);
  if (rec.input && c.type !== 'action') rec.input.setAttribute('aria-describedby', 'hint-' + c.key);
  els[c.key] = rec;
  return root;
}

function setTab(id, focus = false) {
  activeTab = id;
  for (const g of GROUPS) {
    const on = g.id === id;
    const t = $('tab-' + g.id), p = $('panel-' + g.id);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    p.hidden = !on;
    if (on && focus) t.focus();
  }
  try { localStorage.setItem('ts-tab', id); } catch { /* storage unavailable */ }
}

export function buildControls(opts) {
  handlers = opts;
  const tabs = $('tabs'), panels = $('controls');
  for (const g of GROUPS) {
    const tab = h('button', { class: 'tab', role: 'tab', id: 'tab-' + g.id, type: 'button',
      'aria-controls': 'panel-' + g.id, 'aria-selected': 'false' },
      svgIcon(g.icon) + `<span>${g.label}</span><b class="tabBadge" aria-label="settings changed"></b>`);
    tab.addEventListener('click', () => {
      setTab(g.id);
      // On mobile, tapping a tab while the sheet is closed opens it.
      if (document.body.classList.contains('is-mobile') && !document.body.classList.contains('controls-open')) {
        $('ctlToggle').click();
      }
    });
    tabs.append(tab);
    const panel = h('div', { class: 'panel', role: 'tabpanel', id: 'panel-' + g.id, 'aria-labelledby': 'tab-' + g.id });
    const grid = h('div', { class: 'ctlGrid' });
    for (const c of CONTROLS.filter(x => x.group === g.id)) grid.append(buildControl(c));
    panel.append(grid);
    if (opts.extraPanel && opts.extraPanel[g.id]) grid.append(opts.extraPanel[g.id]);
    panel.append(h('p', { class: 'naNote', id: 'na-' + g.id }));
    panels.append(panel);
  }
  // Roving focus across tabs with arrow keys (WAI-ARIA tabs pattern).
  tabs.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); e.stopPropagation();
    const i = GROUPS.findIndex(g => g.id === activeTab);
    const n = GROUPS[(i + (e.key === 'ArrowLeft' ? -1 : 1) + GROUPS.length) % GROUPS.length];
    setTab(n.id, true);
  });
  let saved = null;
  try { saved = localStorage.getItem('ts-tab'); } catch { /* ignore */ }
  setTab(GROUPS.some(g => g.id === saved) ? saved : 'demand');
}

export function showTab(id) { setTab(id); }

function sameVal(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return a === b;
}

// Push the current sim state into every widget.
export function syncControls(sim) {
  const defs = defaultsFor(sim.scenario);
  const badge = {};
  const na = {};
  for (const c of CONTROLS) {
    const rec = els[c.key];
    if (!rec) continue;
    const show = inScenario(c, sim);
    rec.root.hidden = !show;
    if (!show) { (na[c.group] ||= []).push(c.label); continue; }

    const parentOff = c.parent && !sim[c.parent];
    const whenOff = c.when && !c.when(sim);
    const off = parentOff || whenOff;
    rec.root.classList.toggle('disabled', !!off);
    if (rec.input) rec.input.disabled = !!off;
    rec.root.title = whenOff && c.whyOff ? c.whyOff : '';

    const v = sim[c.key];
    if (c.type === 'range') {
      const mn = resolve(c.min, sim), mx = resolve(c.max, sim), st = resolve(c.step, sim);
      if (rec.input.min !== String(mn)) rec.input.min = mn;
      if (rec.input.max !== String(mx)) rec.input.max = mx;
      if (rec.input.step !== String(st)) rec.input.step = st;
      if (Number.isFinite(v) && +rec.input.value !== v) rec.input.value = v;
      rec.val.textContent = fmtValue(c, v);
      rec.input.setAttribute('aria-valuetext', fmtValue(c, v));
      const p = mx > mn ? (Math.min(mx, Math.max(mn, v)) - mn) / (mx - mn) * 100 : 100;
      rec.input.style.setProperty('--p', p + '%');
    } else if (c.type === 'toggle') {
      rec.input.checked = !!v;
    } else if (c.type === 'select') {
      const opts = resolve(c.options, sim);
      const sig = JSON.stringify(opts);
      if (rec.sigOpts !== sig) {
        rec.input.innerHTML = opts.map(([val, lab]) => `<option value="${val}">${lab}</option>`).join('');
        rec.sigOpts = sig;
      }
      rec.input.value = v;
    } else if (c.type === 'seg') {
      const opts = resolve(c.options, sim);
      const sig = JSON.stringify(opts);
      if (rec.sigOpts !== sig) {
        rec.seg.innerHTML = '';
        for (const [val, lab] of opts) {
          const b = h('button', { type: 'button', role: 'radio', 'data-v': val }, lab);
          b.addEventListener('click', () => handlers.onSet(c.key, typeof val === 'number' ? val : String(val)));
          rec.seg.append(b);
        }
        rec.sigOpts = sig;
      }
      for (const b of rec.seg.querySelectorAll('button')) {
        const on = String(v) === b.dataset.v;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        b.disabled = !!off;
      }
    }

    if (c.hint) {
      const t = c.hint(sim) || '';
      if (rec.hint.textContent !== t) rec.hint.textContent = t;
    }
    rec.hint.hidden = !rec.hint.textContent;

    if (c.type !== 'action' && c.track !== false) {
      const mod = defs[c.key] !== undefined && v !== undefined && !sameVal(v, defs[c.key]);
      rec.root.classList.toggle('mod', mod);
      if (mod) badge[c.group] = (badge[c.group] || 0) + 1;
    }
  }
  for (const g of GROUPS) {
    const b = $('tab-' + g.id).querySelector('.tabBadge');
    b.textContent = badge[g.id] ? String(badge[g.id]) : '';
    b.setAttribute('aria-label', badge[g.id] ? `${badge[g.id]} changed from default` : '');
    const note = $('na-' + g.id);
    const other = sim.scenario === 'city' ? 'Highway' : 'City';
    note.textContent = na[g.id] ? `${other} scenario only: ${na[g.id].join(', ')}.` : '';
    note.hidden = !na[g.id];
  }
  const total = Object.values(badge).reduce((a, b) => a + b, 0);
  const cnt = $('ctlChanged');
  if (cnt) cnt.textContent = total ? `${total} changed` : '';
}
