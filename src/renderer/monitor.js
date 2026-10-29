// Monitor tab of a project: basic information, CPU, memory, disk and network I/O, disk usage per mount
// point and the running programs of a Linux machine. The main process samples /proc while this tab is
// visible and sends a snapshot every couple of seconds; rates and histories are drawn here.
import { h, clear, toast } from './ui.js';
import { fmtSize } from './files.js';

const call = (m, ...a) => window.termclaw.call(m, ...a);
const HIST = 60; // samples kept for the charts (2 s apart = 2 minutes)

const snaps = new Map(); // projectId -> snapshot
const hist = new Map(); // projectId -> { cpu, mem, dr, dw, rx, tx }
const view = { filter: '', sort: { key: 'cpu', dir: -1 }, allMounts: false };
let mounted = null; // { ctx, projectId, root }

window.termclaw.on('monitor:update', ({ projectId, snap }) => {
  snaps.set(projectId, snap);
  if (snap.ok && snap.cpu && snap.cpu.total != null) {
    const hs = hist.get(projectId) || { cpu: [], mem: [], dr: [], dw: [], rx: [], tx: [] };
    const sum = (l, k) => l.reduce((a, x) => a + (x[k] || 0), 0);
    const push = (a, v) => { a.push(v); if (a.length > HIST) a.shift(); };
    push(hs.cpu, snap.cpu.total);
    push(hs.mem, snap.mem.total ? ((snap.mem.total - snap.mem.available) / snap.mem.total) * 100 : 0);
    push(hs.dr, sum(snap.disks, 'readBps'));
    push(hs.dw, sum(snap.disks, 'writeBps'));
    push(hs.rx, sum(snap.net, 'rxBps'));
    push(hs.tx, sum(snap.net, 'txBps'));
    hist.set(projectId, hs);
  }
  draw();
});

export function mount(ctx, el, projectId) {
  if (mounted && mounted.projectId !== projectId) call('monitorUnwatch', mounted.projectId);
  const watching = mounted && mounted.projectId === projectId;
  mounted = { ctx, projectId, root: h('div', { class: 'monitor' }) };
  el.appendChild(mounted.root);
  if (!watching) call('monitorWatch', projectId).then((snap) => { if (!snaps.has(projectId) || !snaps.get(projectId).updatedAt) snaps.set(projectId, snap); draw(); }).catch((e) => toast(e.message, { error: true }));
  draw();
}

// Called when the project view no longer shows the Monitor tab.
export function unmount() {
  if (!mounted) return;
  call('monitorUnwatch', mounted.projectId);
  mounted = null;
}
export const mountedProject = () => (mounted ? mounted.projectId : null);

// ---------- formatting ----------

const pct = (v) => (v == null ? '–' : v < 10 ? v.toFixed(1) + '%' : Math.round(v) + '%');
const rate = (v) => (v == null ? '–' : fmtSize(Math.round(v)) + '/s');
const level = (v) => (v > 90 ? 'bad' : v > 75 ? 'warn' : '');

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${hrs} h` : hrs ? `${hrs} h ${m} min` : `${m} min`;
}

// Line chart of the last samples; max fixes the scale (100 for percentages), otherwise it follows the data.
function spark(values, { w = 200, hgt = 34, max, cls = '' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('class', 'dk-spark mon-spark ' + cls);
  svg.setAttribute('preserveAspectRatio', 'none');
  if (values.length > 1) {
    const top = max || Math.max(1, ...values);
    const x = (i) => (i / (HIST - 1)) * w + (HIST - values.length) * (w / (HIST - 1));
    const pts = values.map((v, i) => [x(i), hgt - 1 - (Math.min(v, top) / top) * (hgt - 2)]);
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

const bar = (value, total, cls) => h('div', { class: 'dk-bar' }, h('span', { class: cls || level(total ? (value / total) * 100 : 0), style: { width: total ? Math.min(100, (value / total) * 100) + '%' : '0' } }));

function card(title, big, sub, ...extra) {
  return h('div', { class: 'dk-card' }, h('div', { class: 'dk-card-title' }, title), h('div', { class: 'dk-big' }, big), h('div', { class: 'dk-sub' }, sub), ...extra);
}

// ---------- drawing ----------

function sortTh(label, key, firstDir = -1) {
  const active = view.sort.key === key;
  return h('th', {
    class: 'dk-sortable' + (active ? ' sorted' : ''),
    title: 'Sort by ' + label.toLowerCase(),
    onclick: () => { view.sort = active ? { key, dir: -view.sort.dir } : { key, dir: firstDir }; draw(); },
  }, label, h('span', { class: 'dk-arrow' }, active ? (view.sort.dir > 0 ? ' ▲' : ' ▼') : ''));
}

const SORT_VALUE = {
  pid: (r) => r.pid, user: (r) => r.user, cpu: (r) => r.cpu, mem: (r) => r.mem, threads: (r) => r.threads, cmd: (r) => r.cmd,
};

function draw() {
  if (!mounted || !mounted.root.isConnected) return;
  const { ctx, projectId, root } = mounted;
  const p = ctx.project(projectId);
  const snap = snaps.get(projectId);
  const scroll = root.scrollTop;
  const focus = document.activeElement && document.activeElement.classList.contains('mon-filter') ? document.activeElement : null;
  const caret = focus ? [focus.selectionStart, focus.selectionEnd] : null;
  clear(root);
  if (!p) return;
  const where = p.type === 'ssh' ? (ctx.S.config.hosts.find((x) => x.id === p.hostId) || {}).name || p.host : p.type === 'wsl' ? `WSL ${p.wslDistro || ''}`.trim() : 'this computer';
  if (!snap || (snap.loading && !snap.ok)) {
    root.appendChild(h('div', { class: 'empty' }, h('div', null, `Connecting to ${where}…`)));
    return;
  }
  if (!snap.ok) {
    root.appendChild(h('div', { class: 'card dk-error' },
      h('div', { class: 'bad', style: { fontWeight: 600, marginBottom: '6px' } }, `Cannot monitor ${where}`),
      h('div', { class: 'mono', style: { whiteSpace: 'pre-wrap', marginBottom: '8px' } }, snap.error),
      h('button', { onclick: () => call('monitorRefresh', projectId).then((s) => { snaps.set(projectId, { ...s, loading: true }); draw(); }).catch((e) => toast(e.message, { error: true })) }, 'Retry')));
    return;
  }
  const hs = hist.get(projectId) || { cpu: [], mem: [], dr: [], dw: [], rx: [], tx: [] };
  const { info, cpu, mem } = snap;
  const memUsed = mem.total - mem.available;
  const memRatio = mem.total ? (memUsed / mem.total) * 100 : 0;
  const sum = (l, k) => l.reduce((a, x) => a + (x[k] || 0), 0);

  root.appendChild(h('div', { class: 'dk-head' },
    h('span', { class: 'title' }, `Monitor · ${info.hostname || where}`),
    h('span', { class: 'muted' }, where),
    h('span', { style: { flex: 1 } }),
    h('span', { class: 'muted' }, `updated ${new Date(snap.updatedAt).toLocaleTimeString()}`)));

  // Cards: CPU, memory, disk I/O, network I/O, host.
  const loadTxt = info.load ? info.load.map((x) => x.toFixed(2)).join('  ') : '–';
  root.appendChild(h('div', { class: 'dk-cards' },
    card('CPU', pct(cpu.total), `user ${pct(cpu.user)} · system ${pct(cpu.system)} · iowait ${pct(cpu.iowait)}${cpu.steal ? ` · steal ${pct(cpu.steal)}` : ''}`,
      spark(hs.cpu, { max: 100 }), h('div', { class: 'mon-cores' }, cpu.cores.map((c, i) => h('div', { class: 'mon-core', title: `cpu${i}: ${pct(c)}` }, h('span', { class: level(c || 0), style: { height: Math.max(2, c || 0) + '%' } }))))),
    card('Memory', pct(memRatio), `${fmtSize(memUsed)} of ${fmtSize(mem.total)} used · cache ${fmtSize(mem.cached + mem.buffers)}`,
      spark(hs.mem, { max: 100, cls: 'mem' }), bar(memUsed, mem.total), h('div', { class: 'dk-sub' }, mem.swapTotal ? `swap ${fmtSize(mem.swapUsed)} of ${fmtSize(mem.swapTotal)}` : 'no swap')),
    card('Disk I/O', rate(sum(snap.disks, 'readBps') + sum(snap.disks, 'writeBps')), `read ${rate(sum(snap.disks, 'readBps'))} · write ${rate(sum(snap.disks, 'writeBps'))}`,
      spark(hs.dr.map((v, i) => v + (hs.dw[i] || 0)), { cls: 'io' })),
    card('Network I/O', rate(sum(snap.net, 'rxBps') + sum(snap.net, 'txBps')), `in ${rate(sum(snap.net, 'rxBps'))} · out ${rate(sum(snap.net, 'txBps'))}`,
      spark(hs.rx.map((v, i) => v + (hs.tx[i] || 0)), { cls: 'net' }))));

  // Basic information.
  const kv = (k, v) => (v ? [h('dt', null, k), h('dd', null, v)] : []);
  root.appendChild(h('h3', { class: 'mon-h' }, 'Basic information'));
  root.appendChild(h('dl', { class: 'mon-info' },
    ...kv('Host', info.hostname), ...kv('System', info.os), ...kv('Kernel', info.kernel), ...kv('Architecture', info.arch),
    ...kv('CPU', info.cpuModel ? `${info.cpuModel}${info.cores ? ` · ${info.cores} logical cores` : ''}` : info.cores ? `${info.cores} logical cores` : ''),
    ...kv('Uptime', fmtUptime(info.uptime)), ...kv('Load average', `${loadTxt}  (1 / 5 / 15 min)`),
    ...kv('Tasks', `${snap.procs.total} processes${info.running ? ` · ${info.running[0]} running of ${info.running[1]} threads` : ''}`), ...kv('Logged in as', info.user)));

  // Disk usage per mount point.
  const mounts = snap.mounts.filter((m) => view.allMounts || !/^(\/boot|\/snap|\/var\/lib\/(docker|containers|snapd))(\/|$)/.test(m.mount));
  root.appendChild(h('h3', { class: 'mon-h' }, 'Disk usage',
    h('label', { class: 'row mon-opt' }, h('input', { type: 'checkbox', checked: view.allMounts, onchange: (e) => { view.allMounts = e.target.checked; draw(); } }), 'show all mounts')));
  root.appendChild(mounts.length
    ? h('table', { class: 'dk-table mon-table' },
      h('thead', null, h('tr', null, ...['Mount point', 'Volume', 'Type', 'Size', 'Used', 'Free', 'Use'].map((t, i) => h('th', { class: i >= 3 && i < 6 ? 'num' : '' }, t)))),
      h('tbody', null, mounts.map((m) => h('tr', null,
        h('td', { class: 'mono' }, m.mount), h('td', { class: 'mono muted' }, m.fs), h('td', { class: 'muted' }, m.type),
        h('td', { class: 'num' }, fmtSize(m.total)), h('td', { class: 'num' }, fmtSize(m.used)), h('td', { class: 'num' }, fmtSize(m.free)),
        h('td', { class: 'mon-use' }, h('div', { class: 'row' }, h('span', { class: 'mon-pct' }, m.pct + '%'), bar(m.used, m.total, level(m.pct))))))))
    : h('div', { class: 'muted' }, 'Reading mounts…'));

  // Disk I/O and network per device.
  root.appendChild(h('h3', { class: 'mon-h' }, 'Disk I/O'));
  root.appendChild(snap.disks.length
    ? h('table', { class: 'dk-table mon-table' },
      h('thead', null, h('tr', null, h('th', null, 'Device'), ...['Read', 'Write', 'Read IOPS', 'Write IOPS', 'Busy'].map((t) => h('th', { class: 'num' }, t)))),
      h('tbody', null, snap.disks.map((d) => h('tr', null,
        h('td', { class: 'mono' }, d.name), h('td', { class: 'num' }, rate(d.readBps)), h('td', { class: 'num' }, rate(d.writeBps)),
        h('td', { class: 'num' }, d.readIops == null ? '–' : Math.round(d.readIops)), h('td', { class: 'num' }, d.writeIops == null ? '–' : Math.round(d.writeIops)),
        h('td', { class: 'mon-use' }, h('div', { class: 'row' }, h('span', { class: 'mon-pct' }, pct(d.util)), bar(d.util || 0, 100, level(d.util || 0))))))))
    : h('div', { class: 'muted' }, 'No block devices reported by this machine.'));

  root.appendChild(h('h3', { class: 'mon-h' }, 'Network I/O'));
  root.appendChild(snap.net.length
    ? h('table', { class: 'dk-table mon-table' },
      h('thead', null, h('tr', null, h('th', null, 'Interface'), ...['In', 'Out', 'Received total', 'Sent total'].map((t) => h('th', { class: 'num' }, t)))),
      h('tbody', null, snap.net.map((n) => h('tr', null,
        h('td', { class: 'mono' }, n.name), h('td', { class: 'num' }, rate(n.rxBps)), h('td', { class: 'num' }, rate(n.txBps)),
        h('td', { class: 'num muted' }, fmtSize(n.rxTotal)), h('td', { class: 'num muted' }, fmtSize(n.txTotal))))))
    : h('div', { class: 'muted' }, 'No network interfaces.'));

  // Programs.
  const f = view.filter.trim().toLowerCase();
  const val = SORT_VALUE[view.sort.key] || SORT_VALUE.cpu;
  const rows = snap.procs.list
    .filter((r) => !f || r.cmd.toLowerCase().includes(f) || r.user.toLowerCase().includes(f) || String(r.pid) === f)
    .sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * view.sort.dir || a.pid - b.pid;
    })
    .slice(0, 100);
  const filter = h('input', { class: 'mon-filter', placeholder: 'Filter by command, user or PID', value: view.filter, oninput: (e) => { view.filter = e.target.value; draw(); } });
  root.appendChild(h('h3', { class: 'mon-h' }, `Programs (${snap.procs.total})`, filter));
  root.appendChild(h('table', { class: 'dk-table mon-table mon-procs' },
    h('thead', null, h('tr', null, sortTh('PID', 'pid', 1), sortTh('User', 'user', 1), sortTh('CPU', 'cpu'), sortTh('Memory', 'mem'), sortTh('Threads', 'threads'), sortTh('Command', 'cmd', 1))),
    h('tbody', null, rows.map((r) => h('tr', { class: r.state === 'Z' ? 'dk-stopped' : '' },
      h('td', { class: 'mono' }, r.pid), h('td', { class: 'muted' }, r.user), h('td', { class: 'num' }, pct(r.cpu)),
      h('td', { class: 'num', title: r.memPct == null ? '' : pct(r.memPct) + ' of memory' }, fmtSize(r.mem)), h('td', { class: 'num' }, r.threads || ''),
      h('td', { class: 'mono mon-cmd', title: r.cmd }, r.cmd))))));
  if (!rows.length) root.appendChild(h('div', { class: 'muted' }, 'No program matches.'));

  root.scrollTop = scroll;
  if (focus) { const n = root.querySelector('.mon-filter'); if (n) { n.focus(); try { n.setSelectionRange(caret[0], caret[1]); } catch {} } }
}
