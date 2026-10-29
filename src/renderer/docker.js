// Docker tab of a project: dashboard (containers, CPU, memory, disk), container list with
// start/stop/restart, logs and a shell, plus images and volumes. Data comes from the main process,
// which polls the Docker Engine API while this tab is visible.
import { h, clear, toast, modal, timeAgo } from './ui.js';
import { fmtSize } from './files.js';

const call = (m, ...a) => window.termclaw.call(m, ...a);
const HIST = 40; // samples kept for sparklines (3 s apart = 2 minutes)

const snaps = new Map(); // projectId -> snapshot
const hist = new Map(); // projectId -> { cpu: [], mem: [], c: Map(containerId -> [cpu]) }
const view = { sub: 'containers', filter: '', stopped: true }; // UI choices, kept across re-renders
let mounted = null; // { ctx, projectId, root }
let pointerDown = false;
let pendingDraw = false;
const busy = new Map(); // containerId -> action in progress

const pct = (v) => (v == null ? '–' : v < 10 ? v.toFixed(1) + '%' : Math.round(v) + '%');
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

window.termclaw.on('docker:update', ({ projectId, snap }) => {
  const prev = snaps.get(projectId);
  snaps.set(projectId, snap);
  if (snap.ok && (!prev || prev.updatedAt !== snap.updatedAt)) record(projectId, snap);
  if (mounted && mounted.projectId === projectId) draw();
});

function record(projectId, snap) {
  let hh = hist.get(projectId);
  if (!hh) { hh = { cpu: [], mem: [], c: new Map(), at: 0 }; hist.set(projectId, hh); }
  if (snap.updatedAt === hh.at) return;
  hh.at = snap.updatedAt;
  const run = snap.containers.filter((c) => c.state === 'running');
  const push = (arr, v) => { arr.push(v); if (arr.length > HIST) arr.shift(); };
  const ncpu = (snap.info && snap.info.ncpu) || 1;
  push(hh.cpu, run.reduce((a, c) => a + (c.cpu || 0), 0) / ncpu);
  push(hh.mem, run.reduce((a, c) => a + (c.mem || 0), 0));
  for (const c of run) { if (!hh.c.has(c.id)) hh.c.set(c.id, []); push(hh.c.get(c.id), c.cpu || 0); }
  for (const id of hh.c.keys()) if (!run.some((c) => c.id === id)) hh.c.delete(id);
}

// SVG sparkline; max defaults to the largest value (at least `floor`).
function spark(values, { w = 90, hgt = 22, max, floor = 1, cls = '' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('class', 'dk-spark ' + cls);
  svg.setAttribute('width', w);
  svg.setAttribute('height', hgt);
  if (values.length > 1) {
    const top = max || Math.max(floor, ...values);
    const pts = values.map((v, i) => [(i / (HIST - 1)) * w + (HIST - values.length) * (w / (HIST - 1)), hgt - 1 - (Math.min(v, top) / top) * (hgt - 2)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', `${line} L${pts[pts.length - 1][0].toFixed(1)} ${hgt} L${pts[0][0].toFixed(1)} ${hgt} Z`);
    area.setAttribute('class', 'area');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', line);
    path.setAttribute('class', 'line');
    svg.append(area, path);
  }
  return svg;
}

// Horizontal bar; parts = [{value, cls, title}] of total.
function bar(parts, total, title) {
  return h('div', { class: 'dk-bar', title: title || '' }, parts.map((p) => h('span', { class: p.cls || '', title: p.title || '', style: { width: total ? Math.min(100, (p.value / total) * 100) + '%' : '0' } })));
}
const level = (ratio) => (ratio > 0.9 ? 'bad' : ratio > 0.75 ? 'warn' : '');

export function mount(ctx, el, projectId) {
  if (mounted && mounted.projectId !== projectId) call('dockerUnwatch', mounted.projectId);
  const watching = mounted && mounted.projectId === projectId;
  mounted = { ctx, projectId, root: h('div', { class: 'docker' }) };
  mounted.root.addEventListener('pointerdown', () => { pointerDown = true; });
  el.appendChild(mounted.root);
  if (!watching) call('dockerWatch', projectId).then((snap) => { if (!snaps.has(projectId) || !snaps.get(projectId).updatedAt) snaps.set(projectId, snap); draw(); }).catch((e) => toast(e.message, { error: true }));
  draw();
}

// Called when the project view no longer shows the Docker tab.
export function unmount() {
  if (!mounted) return;
  call('dockerUnwatch', mounted.projectId);
  mounted = null;
}
export const mountedProject = () => (mounted ? mounted.projectId : null);

document.addEventListener('pointerup', () => { pointerDown = false; if (pendingDraw) { pendingDraw = false; draw(); } });

function draw() {
  if (!mounted || !mounted.root.isConnected) return;
  // A re-render between mousedown and mouseup would swallow the click.
  if (pointerDown) { pendingDraw = true; return; }
  const { ctx, projectId, root } = mounted;
  const p = ctx.project(projectId);
  const snap = snaps.get(projectId);
  const scroll = root.scrollTop;
  const focused = document.activeElement && document.activeElement.classList.contains('dk-filter');
  clear(root);
  if (!p) return;
  const where = p.type === 'ssh' ? (ctx.S.config.hosts.find((x) => x.id === p.hostId) || {}).name || p.host : p.type === 'wsl' ? `WSL ${p.wslDistro || ''}`.trim() : 'this computer';
  if (!snap || (snap.loading && !snap.ok)) {
    root.appendChild(h('div', { class: 'empty' }, h('div', null, `Connecting to Docker on ${where}…`)));
    return;
  }
  if (!snap.ok) {
    root.appendChild(h('div', { class: 'card dk-error' },
      h('div', { class: 'bad', style: { fontWeight: 600, marginBottom: '6px' } }, `Docker on ${where} is not reachable`),
      h('div', { class: 'mono', style: { whiteSpace: 'pre-wrap', marginBottom: '8px' } }, snap.error),
      h('div', { class: 'muted' }, `TermClaw runs “${(p.docker && p.docker.command) || 'docker'} system dial-stdio” ${p.type === 'ssh' ? 'over ssh' : p.type === 'wsl' ? 'in WSL' : 'locally'}. The Docker CLI must be installed there, the engine running, and the user allowed to use it (e.g. member of the docker group).`),
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'primary', onclick: () => call('dockerRefresh', projectId) }, 'Retry'))));
    return;
  }
  root.append(header(snap, where, projectId), cards(snap, projectId), tableArea(ctx, p, snap));
  root.scrollTop = scroll;
  if (focused) { const f = root.querySelector('.dk-filter'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
}

function header(snap, where, projectId) {
  const i = snap.info || {};
  return h('div', { class: 'dk-head' },
    h('span', { class: 'dk-whale' }, '🐳'),
    h('span', { class: 'title' }, `Docker ${i.serverVersion || ''}`),
    h('span', { class: 'muted' }, [where, i.os, i.arch, i.ncpu ? `${i.ncpu} CPUs` : null, i.memTotal ? fmtSize(i.memTotal) + ' RAM' : null].filter(Boolean).join(' · ')),
    h('div', { class: 'spacer' }),
    h('span', { class: 'muted', title: 'Containers and stats every 3 s, disk usage every minute' }, `updated ${timeAgo(snap.updatedAt) || 'now'} ago`),
    h('button', { title: 'Refresh everything now, including disk usage', onclick: () => call('dockerRefresh', projectId) }, '⟳'));
}

function cards(snap, projectId) {
  const i = snap.info || {};
  const hh = hist.get(projectId) || { cpu: [], mem: [] };
  const run = snap.containers.filter((c) => c.state === 'running');
  const stopped = snap.containers.filter((c) => c.state === 'exited' || c.state === 'dead' || c.state === 'created');
  const other = snap.containers.length - run.length - stopped.length;
  const ncpu = i.ncpu || 1;
  const cpu = run.reduce((a, c) => a + (c.cpu || 0), 0) / ncpu;
  const mem = run.reduce((a, c) => a + (c.mem || 0), 0);
  const host = snap.host || {};
  const memTotal = host.memTotal || i.memTotal || 0;
  const memUsed = host.memTotal && host.memAvailable != null ? host.memTotal - host.memAvailable : null;
  const df = snap.df && !snap.df.error ? snap.df : null;
  const volSize = df ? df.volumes.reduce((a, v) => a + Math.max(0, v.size), 0) : 0;
  const card = (title, big, sub, extra) => h('div', { class: 'dk-card' }, h('div', { class: 'dk-card-title' }, title), h('div', { class: 'dk-big' }, big), h('div', { class: 'dk-sub' }, sub), extra);

  return h('div', { class: 'dk-cards' },
    card('Containers', h('span', null, h('span', { class: 'ok' }, run.length), h('span', { class: 'muted' }, ` / ${snap.containers.length}`)),
      [`${run.length} running`, stopped.length ? `${stopped.length} stopped` : null, other ? `${other} other` : null, i.images != null ? `${i.images} images` : null].filter(Boolean).join(' · '),
      bar([{ value: run.length, cls: 'run' }, { value: other, cls: 'warn' }, { value: stopped.length, cls: 'stop' }], snap.containers.length || 1)),
    card('CPU (containers)', pct(cpu),
      [`of ${ncpu} CPUs`, host.load ? `load ${host.load.map((x) => x.toFixed(2)).join(' ')}` : null].filter(Boolean).join(' · '),
      spark(hh.cpu, { w: 220, hgt: 34, floor: 5, cls: 'cpu' })),
    card('Memory', fmtSize(mem),
      memTotal ? `containers${memUsed != null ? ` · host ${fmtSize(memUsed)} used` : ''} · ${fmtSize(memTotal)} total` : 'used by containers',
      memTotal ? bar([{ value: mem, cls: 'mem', title: 'Containers' }, { value: memUsed != null ? Math.max(0, memUsed - mem) : 0, cls: 'mem-other', title: 'Other processes' }], memTotal, `${fmtSize(memUsed ?? mem)} of ${fmtSize(memTotal)}`) : spark(hh.mem, { w: 220, hgt: 34, cls: 'mem' })),
    card('Disk', host.disk ? `${Math.round((host.disk.used / host.disk.total) * 100)}%` : df ? fmtSize(df.layersSize + df.containersSize + volSize + df.buildCache) : '…',
      host.disk ? `${fmtSize(host.disk.used)} of ${fmtSize(host.disk.total)} on ${host.disk.mount}` : df ? 'used by Docker' : snap.df && snap.df.error ? snap.df.error : 'calculating…',
      df ? h('div', null,
        host.disk ? bar([{ value: host.disk.used, cls: level(host.disk.used / host.disk.total) || 'disk' }], host.disk.total) : null,
        h('div', { class: 'dk-legend' },
          h('span', null, h('i', { class: 'img' }), `Images ${fmtSize(df.layersSize)}`),
          h('span', null, h('i', { class: 'vol' }), `Volumes ${fmtSize(volSize)}`),
          h('span', null, h('i', { class: 'ctr' }), `Containers ${fmtSize(df.containersSize)}`),
          df.buildCache ? h('span', null, h('i', { class: 'bc' }), `Build cache ${fmtSize(df.buildCache)}`) : null)) : null));
}

function tableArea(ctx, p, snap) {
  const df = snap.df && !snap.df.error ? snap.df : null;
  const counts = { containers: snap.containers.length, images: df ? df.images.length : '…', volumes: df ? df.volumes.length : '…' };
  const filter = h('input', { class: 'dk-filter', placeholder: 'Filter', value: view.filter, oninput: (e) => { view.filter = e.target.value; draw(); } });
  const subBtn = (k, label) => h('button', { class: view.sub === k ? 'active' : '', onclick: () => { view.sub = k; draw(); } }, `${label} (${counts[k]})`);
  const bar = h('div', { class: 'dk-tabs' },
    subBtn('containers', 'Containers'), subBtn('images', 'Images'), subBtn('volumes', 'Volumes'),
    h('div', { class: 'spacer' }),
    view.sub === 'containers' ? h('label', { class: 'row', style: { gap: '4px' } }, h('input', { type: 'checkbox', checked: view.stopped, onchange: (e) => { view.stopped = e.target.checked; draw(); } }), 'Show stopped') : null,
    filter);
  const q = view.filter.trim().toLowerCase();
  const match = (...xs) => !q || xs.some((x) => String(x || '').toLowerCase().includes(q));
  let table;
  if (view.sub === 'images') table = imagesTable(df, snap, match);
  else if (view.sub === 'volumes') table = volumesTable(df, snap, match);
  else table = containersTable(ctx, p, snap, match);
  return h('div', null, bar, table);
}

function containersTable(ctx, p, snap, match) {
  const hh = hist.get(p.id) || { c: new Map() };
  const order = { running: 0, restarting: 1, paused: 2, created: 3, exited: 4, dead: 5 };
  const list = snap.containers
    .filter((c) => (view.stopped || c.state === 'running') && match(c.name, c.image, c.compose, c.status, c.ports.join(' ')))
    .sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.name.localeCompare(b.name));
  if (!list.length) return h('div', { class: 'muted', style: { padding: '16px 8px' } }, snap.containers.length ? 'No containers match.' : 'No containers on this host.');
  const stateCls = (s) => (s === 'running' ? 'dk-run' : s === 'paused' || s === 'restarting' ? 'dk-warn' : s === 'dead' ? 'error' : 'exited');
  return h('table', { class: 'list dk-table' },
    h('tr', null, ['', 'Name', 'Status', 'Ports', 'CPU', 'Memory', 'Net I/O', ''].map((x) => h('th', null, x))),
    list.map((c) => {
      const run = c.state === 'running';
      const b = busy.get(c.id);
      const act = (action, label, title) => h('button', { class: 'icon', title, 'aria-label': title, disabled: !!b, onclick: () => doAction(p.id, c, action) }, label);
      return h('tr', { class: run ? '' : 'dk-stopped' },
        h('td', null, h('span', { class: 'dot ' + stateCls(c.state), title: c.state })),
        h('td', null, h('div', { class: 'dk-name' }, c.name, c.compose ? h('span', { class: 'tag', title: 'Compose project' }, c.compose) : null), h('div', { class: 'muted dk-image', title: c.image }, c.image)),
        h('td', { class: 'muted' }, b ? h('span', { class: 'warn' }, b + '…') : c.status),
        h('td', { class: 'mono dk-ports' }, c.ports.map((x) => h('div', null, x))),
        h('td', { class: 'dk-cpu' }, run ? h('div', { class: 'row' }, spark(hh.c.get(c.id) || [], { w: 60, hgt: 18, floor: 5, cls: 'cpu' }), h('span', { class: 'mono' }, pct(c.cpu))) : ''),
        h('td', { class: 'dk-mem' }, run && c.mem != null ? h('div', null,
          h('div', { class: 'mono' }, fmtSize(c.mem), c.memLimit && c.memLimit < ((snap.info && snap.info.memTotal) || Infinity) ? h('span', { class: 'muted' }, ' / ' + fmtSize(c.memLimit)) : null),
          bar([{ value: c.mem, cls: level(c.mem / (c.memLimit || 1)) || 'mem' }], c.memLimit || c.mem)) : ''),
        h('td', { class: 'mono muted' }, run && c.net ? `↓${fmtSize(c.net.rx)} ↑${fmtSize(c.net.tx)}` : ''),
        h('td', { class: 'dk-actions' },
          run ? act('stop', '■', 'Stop') : act('start', '▶', 'Start'),
          act('restart', '↻', 'Restart'),
          h('button', { class: 'icon', title: 'Logs', onclick: () => openLogs(ctx, p, c) }, 'Logs'),
          h('button', { class: 'icon', title: run ? 'Open a shell in the container (new terminal session)' : 'Start the container to open a shell', disabled: !run, onclick: () => openShell(ctx, p, c) }, 'Shell')));
    }));
}

function imagesTable(df, snap, match) {
  if (!df) return h('div', { class: 'muted', style: { padding: '16px 8px' } }, snap.df && snap.df.error ? snap.df.error : 'Loading disk usage…');
  const used = new Set(snap.containers.map((c) => c.image));
  const list = df.images.filter((im) => match(im.tags.join(' '), im.id)).sort((a, b) => b.size - a.size);
  return h('table', { class: 'list dk-table' },
    h('tr', null, ['Image', 'ID', 'Size', 'Containers', 'Created'].map((x) => h('th', null, x))),
    list.map((im) => h('tr', null,
      h('td', null, im.tags.length ? im.tags.map((t) => h('div', { class: used.has(t) ? '' : 'muted' }, t)) : h('span', { class: 'muted' }, '<none>')),
      h('td', { class: 'mono muted' }, im.id.replace(/^sha256:/, '').slice(0, 12)),
      h('td', { class: 'mono' }, fmtSize(im.size)),
      h('td', null, im.containers > 0 ? im.containers : h('span', { class: 'muted' }, im.containers < 0 ? '?' : 'unused')),
      h('td', { class: 'muted' }, timeAgo(im.created) + ' ago'))));
}

function volumesTable(df, snap, match) {
  if (!df) return h('div', { class: 'muted', style: { padding: '16px 8px' } }, snap.df && snap.df.error ? snap.df.error : 'Loading disk usage…');
  const usedBy = (name) => snap.containers.filter((c) => c.mounts.some((m) => m.type === 'volume' && m.name === name));
  const list = df.volumes.filter((v) => match(v.name, v.driver, v.mountpoint)).sort((a, b) => b.size - a.size);
  if (!list.length) return h('div', { class: 'muted', style: { padding: '16px 8px' } }, 'No volumes.');
  return h('table', { class: 'list dk-table' },
    h('tr', null, ['Volume', 'Driver', 'Size', 'Used by', 'Mount point'].map((x) => h('th', null, x))),
    list.map((v) => {
      const cs = usedBy(v.name);
      return h('tr', null,
        h('td', { class: 'mono dk-vol', title: v.name }, v.name, v.labels['com.docker.compose.project'] ? h('span', { class: 'tag' }, v.labels['com.docker.compose.project']) : null),
        h('td', { class: 'muted' }, v.driver),
        h('td', { class: 'mono' }, v.size >= 0 ? fmtSize(v.size) : '?'),
        h('td', null, cs.length ? cs.map((c) => h('div', { class: c.state === 'running' ? '' : 'muted' }, c.name)) : h('span', { class: 'muted' }, 'unused')),
        h('td', { class: 'mono muted dk-mount', title: v.mountpoint }, v.mountpoint));
    }));
}

async function doAction(projectId, c, action) {
  const label = { start: 'starting', stop: 'stopping', restart: 'restarting' }[action];
  busy.set(c.id, label);
  draw();
  try {
    await call('dockerAction', projectId, c.id, action, c.name);
  } catch (e) {
    toast(`${c.name}: ${e.message}`, { error: true, ms: 8000 });
  } finally {
    busy.delete(c.id);
    draw();
  }
}

async function openShell(ctx, p, c) {
  try {
    const info = await call('dockerShell', p.id, c.name);
    ctx.S.sessions.set(info.id, info);
    ctx.selectSession(info.id);
  } catch (e) { toast(e.message, { error: true }); }
}

// --- logs ---

const logHandlers = new Map(); // stream id -> fn(event)
window.termclaw.on('docker:logs', (e) => { const f = logHandlers.get(e.id); if (f) f(e); });

function openLogs(ctx, p, c) {
  const MAX = 2 * 1024 * 1024; // characters kept in the view
  const pre = h('pre', { class: 'dk-logs' });
  const status = h('span', { class: 'muted' });
  const tail = h('select', null, [['200', 'last 200'], ['1000', 'last 1000'], ['5000', 'last 5000'], ['all', 'all']].map(([v, l]) => h('option', { value: v, selected: v === '1000' }, l)));
  const follow = h('input', { type: 'checkbox', checked: true });
  const stamps = h('input', { type: 'checkbox' });
  const wrap = h('input', { type: 'checkbox', checked: true, onchange: () => pre.classList.toggle('nowrap', !wrap.checked) });
  let streamId = null;
  let text = '';
  let flushTimer = null;
  let closed = false;

  const flush = () => {
    flushTimer = null;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = text;
    if (atBottom || follow.checked) pre.scrollTop = pre.scrollHeight;
  };
  const stop = () => { if (streamId) { call('dockerLogsStop', streamId); logHandlers.delete(streamId); streamId = null; } };
  const start = async () => {
    stop();
    text = '';
    flush();
    status.textContent = 'loading…';
    try {
      const id = await call('dockerLogs', p.id, c.id, { tail: tail.value, follow: follow.checked, timestamps: stamps.checked });
      if (closed) { call('dockerLogsStop', id); return; }
      streamId = id;
      status.textContent = follow.checked ? 'following' : '';
      logHandlers.set(id, (e) => {
        if (e.text) {
          text += stripAnsi(e.text);
          if (text.length > MAX) text = text.slice(text.length - MAX);
          if (!flushTimer) flushTimer = setTimeout(flush, 100);
        }
        if (e.end) { logHandlers.delete(id); if (streamId === id) streamId = null; status.textContent = e.error ? 'error: ' + e.error : follow.checked ? 'stream ended' : ''; flush(); }
      });
    } catch (e) { status.textContent = ''; toast(e.message, { error: true }); }
  };
  for (const el of [tail, follow, stamps]) el.addEventListener('change', start);

  modal({
    title: `Logs — ${c.name}`,
    width: 'min(1200px, calc(100vw - 40px))',
    body: h('div', { class: 'dk-logbox' },
      h('div', { class: 'row' },
        tail,
        h('label', { class: 'row', style: { gap: '4px' } }, follow, 'Follow'),
        h('label', { class: 'row', style: { gap: '4px' } }, stamps, 'Timestamps'),
        h('label', { class: 'row', style: { gap: '4px' } }, wrap, 'Wrap'),
        h('div', { class: 'spacer' }),
        status,
        h('button', { title: 'Copy all lines', onclick: () => { navigator.clipboard.writeText(text); toast('Copied'); } }, 'Copy'),
        h('button', { onclick: () => { text = ''; flush(); } }, 'Clear')),
      pre),
    okText: null,
    cancelText: 'Close',
    onCancel: () => { closed = true; stop(); },
  });
  start();
}
