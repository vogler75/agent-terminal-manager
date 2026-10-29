'use strict';
// Host monitor per project: CPU, memory, disk and network I/O, disk usage per mount point and the
// running programs of a Linux machine (ssh, WSL or local Linux). One long-running process on the machine
// prints a sample of /proc every few seconds (one ssh connection, no agent to install); rates are
// computed here from two consecutive samples. Polling runs while the Monitor tab is visible.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { buildRemoteExec, shq } = require('./connect');

const SAMPLE_SEC = 2;
const IDLE_STOP_MS = 15000; // stop the remote loop this long after the tab was left
const MARK = '@@TC ';

// Runs on the machine under sh. Static facts every 30th round, mounts every 5th (df can be slow on network mounts).
const SCRIPT = `export LC_ALL=C
i=0
while :; do
echo '${MARK}BEGIN'
if [ $((i % 30)) -eq 0 ]; then
echo '${MARK}static'
echo "hostname=$(hostname 2>/dev/null)"
echo "kernel=$(uname -sr 2>/dev/null)"
echo "arch=$(uname -m 2>/dev/null)"
echo "clk=$(getconf CLK_TCK 2>/dev/null)"
echo "page=$(getconf PAGESIZE 2>/dev/null)"
echo "os=$(. /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"
echo "cpumodel=$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2)"
echo "user=$(id -un 2>/dev/null)"
echo '${MARK}blocks'
ls /sys/block 2>/dev/null
fi
echo '${MARK}uptime'
cat /proc/uptime 2>/dev/null
echo '${MARK}loadavg'
cat /proc/loadavg 2>/dev/null
echo '${MARK}stat'
grep '^cpu' /proc/stat 2>/dev/null
echo '${MARK}meminfo'
grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
echo '${MARK}diskstats'
cat /proc/diskstats 2>/dev/null
echo '${MARK}netdev'
cat /proc/net/dev 2>/dev/null
echo '${MARK}procstat'
cat /proc/[0-9]*/stat 2>/dev/null
echo '${MARK}ps'
ps -eo pid,user:24,args 2>/dev/null || ps -eo pid,user,args 2>/dev/null
if [ $((i % 5)) -eq 0 ]; then
echo '${MARK}df'
df -PkT 2>/dev/null || df -Pk 2>/dev/null
fi
echo '${MARK}END'
i=$((i + 1))
sleep ${SAMPLE_SEC}
done`;

// Pseudo file systems that are not worth a row.
const PSEUDO_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'efivarfs', 'ramfs', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'securityfs', 'debugfs', 'tracefs', 'configfs', 'fusectl', 'pstore', 'bpf', 'autofs', 'mqueue', 'hugetlbfs', 'binfmt_misc', 'nsfs', 'rootfs', 'fuse.lxcfs', 'fuse.gvfsd-fuse']);

// ---------- parsing ----------

function splitSections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith(MARK)) { cur = line.slice(MARK.length).trim(); out[cur] = []; continue; }
    if (cur && line !== '') out[cur].push(line);
  }
  return out;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// One sample (text between BEGIN and END) into raw counters.
function parseSample(text) {
  const s = splitSections(text);
  const raw = { at: Date.now() };
  if (s.static) {
    const st = {};
    for (const l of s.static) { const i = l.indexOf('='); if (i > 0) st[l.slice(0, i)] = l.slice(i + 1).trim(); }
    raw.static = { ...st, clk: num(st.clk) || 100, page: num(st.page) || 4096, blocks: s.blocks || [] };
  }
  raw.uptime = s.uptime && s.uptime[0] ? num(s.uptime[0].split(/\s+/)[0]) : 0;
  raw.load = s.loadavg && s.loadavg[0] ? s.loadavg[0].split(/\s+/).slice(0, 3).map(num) : null;
  raw.running = s.loadavg && s.loadavg[0] ? (s.loadavg[0].split(/\s+/)[3] || '').split('/').map(num) : null; // running/total threads

  raw.cpu = {};
  for (const l of s.stat || []) {
    const f = l.trim().split(/\s+/);
    if (/^cpu\d*$/.test(f[0])) raw.cpu[f[0]] = f.slice(1).map(num);
  }

  raw.mem = {};
  for (const l of s.meminfo || []) {
    const m = l.match(/^(\w+):\s+(\d+)\s+kB/);
    if (m) raw.mem[m[1]] = Number(m[2]) * 1024;
  }

  raw.disks = {};
  for (const l of s.diskstats || []) {
    const f = l.trim().split(/\s+/);
    if (f.length < 14) continue;
    raw.disks[f[2]] = { reads: num(f[3]), rSectors: num(f[5]), writes: num(f[7]), wSectors: num(f[9]), ioMs: num(f[12]) };
  }

  raw.net = {};
  for (const l of s.netdev || []) {
    const m = l.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(num);
    raw.net[m[1]] = { rx: f[0], rxPackets: f[1], tx: f[8], txPackets: f[9] };
  }

  raw.procs = new Map();
  for (const l of s.procstat || []) {
    const m = l.match(/^(\d+) \((.*)\) (\S) (.*)$/);
    if (!m) continue;
    const r = m[4].split(' ');
    raw.procs.set(Number(m[1]), { pid: Number(m[1]), comm: m[2], state: m[3], ticks: num(r[10]) + num(r[11]), threads: num(r[16]), start: num(r[18]), rssPages: num(r[20]) });
  }

  raw.ps = new Map();
  for (const l of s.ps || []) {
    const m = l.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (m) raw.ps.set(Number(m[1]), { user: m[2], args: m[3] });
  }

  if (s.df) raw.mounts = parseDf(s.df);
  return raw;
}

// `df -PkT` (or `df -Pk` without type) into mount rows; pseudo file systems are left out.
function parseDf(lines) {
  const rows = [];
  for (const l of lines) {
    if (/^Filesystem\b/i.test(l)) continue;
    const f = l.trim().split(/\s+/);
    let fs, type, total, used, avail, mount;
    if (f.length >= 7 && /^\d+$/.test(f[2])) [fs, type, total, used, avail, , ...mount] = f;
    else if (f.length >= 6 && /^\d+$/.test(f[1])) { [fs, total, used, avail, , ...mount] = f; type = ''; }
    else continue;
    mount = mount.join(' ');
    if (PSEUDO_FS.has(type) || (!type && /^(tmpfs|devtmpfs|overlay|none|udev)$/.test(fs))) continue;
    if (/^\/(proc|sys|run\/user|run\/lock|dev)(\/|$)/.test(mount) && !/^\/dev\/shm$/.test(mount) && type !== 'zfs') continue;
    total = num(total) * 1024; used = num(used) * 1024; avail = num(avail) * 1024;
    if (!total) continue;
    rows.push({ fs, type, mount, total, used, free: avail, pct: Math.round((used / (used + avail || total)) * 100) });
  }
  return rows.sort((a, b) => a.mount.localeCompare(b.mount));
}

// ---------- rates ----------

const cpuBusy = (t) => t.slice(0, 8).reduce((a, b) => a + b, 0) - (t[3] || 0) - (t[4] || 0); // all but idle and iowait
const cpuTotal = (t) => t.slice(0, 8).reduce((a, b) => a + b, 0);

function cpuUsage(prev, cur) {
  if (!prev || !cur) return null;
  const d = cur.map((v, i) => v - (prev[i] || 0));
  const total = cpuTotal(d);
  if (total <= 0) return null;
  const pct = (v) => Math.max(0, Math.min(100, (v / total) * 100));
  return { total: pct(cpuBusy(d)), user: pct(d[0] + d[1]), system: pct(d[2] + d[5] + d[6]), iowait: pct(d[4]), steal: pct(d[7] || 0) };
}

// Whole disks only: the names under /sys/block (partitions are not listed there).
function diskRates(prev, cur, dt, blocks) {
  const out = [];
  for (const [name, c] of Object.entries(cur)) {
    if (blocks && blocks.length && !blocks.includes(name)) continue;
    if (/^(loop|ram|zram|sr|fd)\d*$/.test(name)) continue;
    const p = prev && prev[name];
    if (!p || dt <= 0) { out.push({ name, readBps: null, writeBps: null, readIops: null, writeIops: null, util: null }); continue; }
    out.push({
      name,
      readBps: Math.max(0, (c.rSectors - p.rSectors) * 512 / dt),
      writeBps: Math.max(0, (c.wSectors - p.wSectors) * 512 / dt),
      readIops: Math.max(0, (c.reads - p.reads) / dt),
      writeIops: Math.max(0, (c.writes - p.writes) / dt),
      util: Math.max(0, Math.min(100, (c.ioMs - p.ioMs) / (dt * 10))),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function netRates(prev, cur, dt) {
  const out = [];
  for (const [name, c] of Object.entries(cur)) {
    if (name === 'lo') continue;
    const p = prev && prev[name];
    out.push(!p || dt <= 0
      ? { name, rxBps: null, txBps: null, rxTotal: c.rx, txTotal: c.tx }
      : { name, rxBps: Math.max(0, (c.rx - p.rx) / dt), txBps: Math.max(0, (c.tx - p.tx) / dt), rxTotal: c.rx, txTotal: c.tx });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_PROCS = 150;

// Programs with CPU % (of one core, like top) from the tick delta, memory from RSS. The busiest by CPU and by memory.
function processList(prev, cur, dt, clk, page, memTotal) {
  const rows = [];
  for (const [pid, c] of cur.procs) {
    const p = prev && prev.procs.get(pid);
    const cpu = p && p.start === c.start && dt > 0 ? Math.max(0, ((c.ticks - p.ticks) / clk / dt) * 100) : null;
    const info = cur.ps.get(pid) || {};
    const mem = c.rssPages * page;
    rows.push({ pid, user: info.user || '', cmd: (info.args || `[${c.comm}]`).slice(0, 300), name: c.comm, state: c.state, threads: c.threads, cpu, mem, memPct: memTotal ? (mem / memTotal) * 100 : null });
  }
  const byCpu = [...rows].sort((a, b) => (b.cpu || 0) - (a.cpu || 0)).slice(0, MAX_PROCS);
  const byMem = [...rows].sort((a, b) => b.mem - a.mem).slice(0, MAX_PROCS);
  const keep = new Map();
  for (const r of [...byCpu, ...byMem]) keep.set(r.pid, r);
  return { total: rows.length, list: [...keep.values()] };
}

// Next snapshot from the previous raw sample and the new one.
function buildSnapshot(prev, cur, state) {
  const dt = prev ? cur.uptime - prev.uptime : 0;
  const st = state.static || {};
  const mem = cur.mem;
  const cores = Object.keys(cur.cpu).filter((k) => k !== 'cpu').sort((a, b) => num(a.slice(3)) - num(b.slice(3)));
  const usage = (k) => cpuUsage(prev && prev.cpu[k], cur.cpu[k]);
  const swapTotal = mem.SwapTotal || 0;
  return {
    ok: true,
    error: null,
    loading: false,
    updatedAt: cur.at,
    info: {
      hostname: st.hostname || '', os: st.os || '', kernel: st.kernel || '', arch: st.arch || '', user: st.user || '',
      cpuModel: st.cpumodel || '', cores: cores.length, uptime: cur.uptime, load: cur.load, running: cur.running,
    },
    cpu: { ...(usage('cpu') || { total: null, user: null, system: null, iowait: null, steal: null }), cores: cores.map((k) => { const u = usage(k); return u ? u.total : null; }) },
    mem: {
      total: mem.MemTotal || 0,
      available: mem.MemAvailable != null ? mem.MemAvailable : (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0),
      free: mem.MemFree || 0, buffers: mem.Buffers || 0, cached: mem.Cached || 0,
      swapTotal, swapUsed: swapTotal - (mem.SwapFree || 0),
    },
    disks: diskRates(prev && prev.disks, cur.disks, dt, st.blocks),
    net: netRates(prev && prev.net, cur.net, dt),
    mounts: state.mounts || [],
    procs: processList(prev, cur, dt, st.clk || 100, st.page || 4096, mem.MemTotal || 0),
  };
}

// ---------- process management ----------

function monitorSpec(project, host) {
  return buildRemoteExec(project, host, `exec sh -c ${shq(SCRIPT)}`);
}

function unsupported(project) {
  if (project.type === 'local' && process.platform !== 'linux') return 'The monitor needs a Linux machine: an SSH host, a WSL distribution or a project on this computer when it runs Linux.';
  return null;
}

class ProjectMonitor {
  constructor(mgr, project) {
    this.mgr = mgr;
    this.projectId = project.id;
    this.watchers = 0;
    this.proc = null;
    this.stopTimer = null;
    this.prev = null;
    this.state = { static: null, mounts: [] };
    this.snap = { ok: false, error: null, loading: true, updatedAt: 0 };
  }

  get project() { return this.mgr.store.getProject(this.projectId); }

  watch() {
    this.watchers++;
    clearTimeout(this.stopTimer);
    if (!this.proc) this.start();
  }

  unwatch() {
    this.watchers = Math.max(0, this.watchers - 1);
    if (!this.watchers) { clearTimeout(this.stopTimer); this.stopTimer = setTimeout(() => this.stop(), IDLE_STOP_MS); }
  }

  start() {
    const p = this.project;
    const err = unsupported(p);
    if (err) return this._fail(err);
    const host = p.hostId ? this.mgr.store.getHost(p.hostId) : null;
    let spec;
    try { spec = monitorSpec(p, host); } catch (e) { return this._fail(e.message); }
    this.prev = null;
    this.snap = { ...this.snap, loading: true, error: null };
    let buf = '';
    let errText = '';
    const proc = spawn(spec.file, spec.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout.on('data', (d) => {
      buf += d;
      for (;;) {
        const end = buf.indexOf(`${MARK}END\n`);
        if (end < 0) break;
        const chunk = buf.slice(0, end);
        buf = buf.slice(end + MARK.length + 4);
        const begin = chunk.lastIndexOf(`${MARK}BEGIN\n`);
        if (begin >= 0) this._sample(chunk.slice(begin + MARK.length + 6));
      }
      if (buf.length > 4e6) buf = '';
    });
    proc.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
    proc.on('error', (e) => { if (this.proc === proc) { this.proc = null; this._fail(/ENOENT/.test(e.message) ? `${spec.file} not found` : e.message); } });
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.watchers) this._fail(errText.trim().split('\n').pop() || `Connection closed (exit code ${code})`);
    });
  }

  _sample(text) {
    let raw;
    try { raw = parseSample(text); } catch (e) { return this._fail(e.message); }
    if (!Object.keys(raw.cpu).length) return this._fail('This machine does not look like Linux (no /proc/stat).');
    if (raw.static) this.state.static = raw.static;
    if (raw.mounts) this.state.mounts = raw.mounts;
    this.snap = buildSnapshot(this.prev, raw, this.state);
    this.prev = raw;
    this.mgr.emit('update', this.projectId, this.snap);
  }

  _fail(message) {
    this.snap = { ...this.snap, ok: false, loading: false, error: message, updatedAt: Date.now() };
    this.stop();
    this.mgr.emit('update', this.projectId, this.snap);
  }

  stop() {
    clearTimeout(this.stopTimer);
    const p = this.proc;
    this.proc = null;
    if (p) { try { p.kill(); } catch {} }
  }

  // Reconnect after an error (or restart the loop) when the user asks for a refresh.
  refresh() {
    if (this.watchers && !this.proc) this.start();
    return this.snap;
  }
}

class MonitorManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.projects = new Map();
  }

  _get(projectId) {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error('Unknown project');
    if (!p.monitor || !p.monitor.enabled) throw new Error('The monitor is not enabled for this project');
    let m = this.projects.get(projectId);
    if (!m) { m = new ProjectMonitor(this, p); this.projects.set(projectId, m); }
    return m;
  }

  watch(projectId) { const m = this._get(projectId); m.watch(); return m.snap; }
  unwatch(projectId) { const m = this.projects.get(projectId); if (m) m.unwatch(); }
  refresh(projectId) { return this._get(projectId).refresh(); }

  // Project changed (monitor switched off, connection changed) or deleted.
  reset(projectId) {
    const m = this.projects.get(projectId);
    if (!m) return;
    m.stop();
    this.projects.delete(projectId);
    const p = this.store.getProject(projectId);
    if (p && p.monitor && p.monitor.enabled && m.watchers) { const n = this._get(projectId); for (let i = 0; i < m.watchers; i++) n.watch(); }
  }

  shutdown() { for (const m of this.projects.values()) m.stop(); }
}

module.exports = { MonitorManager, ProjectMonitor, SCRIPT, monitorSpec, parseSample, parseDf, buildSnapshot, cpuUsage, diskRates, netRates, unsupported };
