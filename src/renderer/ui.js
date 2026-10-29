// Small DOM helpers: element builder, modal dialogs, context menus, toasts.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function toast(text, { error = false, ms = 3500 } = {}) {
  const root = document.getElementById('toast-root');
  const t = h('div', { class: 'toast' + (error ? ' error' : '') }, text);
  root.appendChild(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

// Modal with body content and buttons. Returns {close}. onOk may return false to keep it open.
export function modal({ title, body, okText = 'Save', onOk, onCancel, cancelText = 'Cancel', width, extraButtons = [] }) {
  const root = document.getElementById('modal-root');
  let done = false;
  // onCancel runs when the dialog closes any other way than OK (Cancel, Escape, close()).
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey, true); if (!done && onCancel) { done = true; onCancel(); } };
  const ok = async () => {
    try {
      const r = onOk ? await onOk() : true;
      if (r !== false) { done = true; close(); }
    } catch (e) {
      toast(e.message || String(e), { error: true, ms: 6000 });
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.stopPropagation(); ok(); }
  };
  // A click on the backdrop does not close the dialog, so typed input is not lost by accident.
  const bg = h('div', { class: 'modal-bg' },
    h('div', { class: 'modal', style: width ? { width } : null },
      h('div', { class: 'modal-head' }, title),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' },
        ...extraButtons,
        h('div', { class: 'spacer' }),
        cancelText ? h('button', { onclick: close }, cancelText) : null,
        okText ? h('button', { class: 'primary', onclick: ok }, okText) : null)));
  root.appendChild(bg);
  document.addEventListener('keydown', onKey, true);
  const first = bg.querySelector('input:not([type=checkbox]), textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
  return { close };
}

export function prompt(title, value = '') {
  return new Promise((resolve) => {
    const input = h('input', { value });
    let done = false;
    modal({
      title,
      body: input,
      okText: 'OK',
      onOk: () => { done = true; resolve(input.value.trim()); },
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.closest('.modal').querySelector('.primary').click(); } });
    // Resolve null when closed without OK.
    const obs = new MutationObserver(() => { if (!document.body.contains(input)) { obs.disconnect(); if (!done) resolve(null); } });
    obs.observe(document.getElementById('modal-root'), { childList: true });
  });
}

export function confirmDialog(title, text, okText = 'OK') {
  return new Promise((resolve) => {
    let done = false;
    modal({ title, body: h('div', null, text), okText, onOk: () => { done = true; resolve(true); } });
    const root = document.getElementById('modal-root');
    const obs = new MutationObserver(() => { if (!root.children.length) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(root, { childList: true });
  });
}

let openMenu = null;
export function contextMenu(x, y, items) {
  if (openMenu) openMenu.remove();
  const m = h('div', { class: 'menu' }, items.map((it) => it === '-' ? h('hr') : h('div', { onclick: () => { m.remove(); openMenu = null; it.action(); } }, it.label)));
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 4) + 'px';
  openMenu = m;
  setTimeout(() => document.addEventListener('mousedown', function off(e) {
    if (!m.contains(e.target)) { m.remove(); if (openMenu === m) openMenu = null; document.removeEventListener('mousedown', off); }
  }), 0);
}

export function field(label, input, hint) {
  return [h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null];
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  return Math.round(s / 3600) + ' h';
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
}
