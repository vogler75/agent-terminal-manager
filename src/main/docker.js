'use strict';
// Lightweight Docker management per project: the Docker Engine API reached through
// `docker system dial-stdio` on the project machine (over ssh, in WSL or locally) — the same
// transport as DOCKER_HOST=ssh://. No local port is opened: each HTTP connection is one
// dial-stdio process; connections are kept alive and reused.
const http = require('http');
const { spawn } = require('child_process');
const { Duplex } = require('stream');
const { EventEmitter } = require('events');
const { resolveTarget, sshBaseArgs, sshDest, SSH_BIN, buildRemoteExec, shq } = require('./connect');

const FAST_MS = 3000; // container list and stats
const SLOW_MS = 60000; // engine info, disk usage (system df), host memory/disk
const IDLE_CLOSE_MS = 60000; // close the connections this long after the Docker tab was left

const dockerCli = (project) => ((project.docker && project.docker.command) || 'docker').trim().split(/\s+/);

// Process that connects its stdin/stdout to the Docker Engine API of the project machine.
function dialSpec(project, host) {
  const cli = dockerCli(project);
  if (project.type === 'ssh') {
    const t = resolveTarget(project, host);
    return { file: SSH_BIN, args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...sshBaseArgs(project, t), sshDest(t), [...cli, 'system', 'dial-stdio'].map(shq).join(' ')] };
  }
  if (project.type === 'wsl') {
    return { file: 'wsl.exe', args: [...(project.wslDistro ? ['-d', project.wslDistro] : []), '--exec', ...cli, 'system', 'dial-stdio'] };
  }
  // GUI apps on macOS start without the shell's PATH.
  const env = process.platform === 'darwin' ? { PATH: `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin` } : undefined;
  return { file: cli[0], args: [...cli.slice(1), 'system', 'dial-stdio'], env };
}

// A child process's stdio as a socket for the http module.
function stdioSocket(spec) {
  const p = spawn(spec.file, spec.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: spec.env ? { ...process.env, ...spec.env } : process.env });
  let stderr = '';
  const sock = new Duplex({
    read() { p.stdout.resume(); },
    write(chunk, _enc, cb) { if (p.stdin.writable) p.stdin.write(chunk, cb); else cb(new Error('connection closed')); },
    final(cb) { p.stdin.end(); cb(); },
    destroy(err, cb) { try { p.kill(); } catch {} cb(err); },
  });
  p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  p.stdout.on('data', (d) => { if (!sock.push(d)) p.stdout.pause(); });
  p.stdin.on('error', () => {});
  p.on('error', (e) => sock.destroy(new Error(/ENOENT/.test(e.message) ? `${spec.file} not found` : e.message)));
  // End of stream only after the process is gone, so a failure surfaces with its message
  // (e.g. "permission denied … docker.sock") instead of a bare "socket hang up".
  p.on('close', (code) => {
    if (sock.destroyed) return;
    if (code) sock.destroy(new Error(stderr.trim().split('\n').pop() || `${spec.file} exited with code ${code}`));
    else sock.push(null);
  });
  // The http module calls these on real sockets.
  for (const m of ['setKeepAlive', 'setNoDelay', 'setTimeout', 'ref', 'unref']) sock[m] = () => sock;
  return sock;
}

class DialAgent extends http.Agent {
  constructor(spec) {
    super({ keepAlive: true, maxSockets: 6, maxFreeSockets: 3 });
    this.spec = spec;
  }
  createConnection() { return stdioSocket(this.spec); }
}

// Docker multiplexes stdout/stderr of containers without a TTY into frames: 8-byte header + payload.
class FrameDecoder {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let out = '';
    while (this.buf.length >= 8) {
      const len = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + len) break;
      out += this.buf.subarray(8, 8 + len).toString('utf8');
      this.buf = this.buf.subarray(8 + len);
    }
    return out;
  }
}

class DockerClient {
  constructor(spec) { this.agent = new DialAgent(spec); }

  // Plain request, JSON response. Errors carry Docker's message.
  request(method, path, { timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ agent: this.agent, host: 'docker', method, path, headers: { host: 'docker' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          const text = Buffer.concat(chunks).toString('utf8');
          let data = text;
          try { data = text ? JSON.parse(text) : null; } catch {}
          if (res.statusCode >= 400) return reject(new Error((data && data.message) || `Docker API ${res.statusCode}`));
          resolve(data);
        });
        res.on('error', reject);
      });
      const timer = setTimeout(() => req.destroy(new Error('Docker API timeout')), timeout);
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
      req.end();
    });
  }

  // Streaming GET (logs). onData gets each chunk; returns a function that stops the stream.
  stream(path, onData, onEnd) {
    const req = http.request({ agent: this.agent, host: 'docker', path, headers: { host: 'docker' } }, (res) => {
      if (res.statusCode >= 400) {
        let t = '';
        res.on('data', (c) => (t += c));
        res.on('end', () => { let m = t; try { m = JSON.parse(t).message; } catch {} onEnd(new Error(m || `Docker API ${res.statusCode}`)); });
        return;
      }
      res.on('data', onData);
      res.on('end', () => onEnd(null));
      res.on('error', (e) => onEnd(e));
    });
    req.on('error', (e) => onEnd(e));
    req.end();
    return () => req.destroy();
  }

  close() { this.agent.destroy(); }
}

// --- stats ---

function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const dc = cur.cpu_stats.cpu_usage.total_usage - prev.cpu_stats.cpu_usage.total_usage;
  const ds = (cur.cpu_stats.system_cpu_usage || 0) - (prev.cpu_stats.system_cpu_usage || 0);
  const cpus = cur.cpu_stats.online_cpus || (cur.cpu_stats.cpu_usage.percpu_usage || []).length || 1;
  if (dc < 0 || ds <= 0) return null;
  return (dc / ds) * cpus * 100;
}

function memUsage(st) {
  const m = st.memory_stats || {};
  if (m.usage == null) return null;
  const s = m.stats || {};
  // Same as `docker stats`: page cache does not count (cgroup v2: inactive_file, v1: total_inactive_file / cache).
  const cache = s.inactive_file ?? s.total_inactive_file ?? s.cache ?? 0;
  return Math.max(0, m.usage - cache);
}

function sumNet(st) {
  let rx = 0;
  let tx = 0;
  for (const n of Object.values(st.networks || {})) { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0; }
  return { rx, tx };
}

function sumBlk(st) {
  let read = 0;
  let write = 0;
  for (const e of (st.blkio_stats && st.blkio_stats.io_service_bytes_recursive) || []) {
    const op = String(e.op).toLowerCase();
    if (op === 'read') read += e.value;
    if (op === 'write') write += e.value;
  }
  return { read, write };
}

// `df -Pk <dir>` line plus /proc/meminfo and /proc/loadavg from the project machine.
function parseHostStats(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const df = line.match(/^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(\/.*)$/);
    if (df && !out.disk) out.disk = { total: Number(df[1]) * 1024, used: Number(df[2]) * 1024, free: Number(df[3]) * 1024, mount: df[4] };
    const mem = line.match(/^(MemTotal|MemAvailable):\s+(\d+)\s+kB/);
    if (mem) out[mem[1] === 'MemTotal' ? 'memTotal' : 'memAvailable'] = Number(mem[2]) * 1024;
    const load = line.match(/^(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+\d+\/\d+/);
    if (load) out.load = [Number(load[1]), Number(load[2]), Number(load[3])];
  }
  return out;
}

function hostStatsScript(dir) {
  return `{ df -Pk ${shq(dir || '/')} 2>/dev/null || df -Pk /; } | tail -1; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo 2>/dev/null; cat /proc/loadavg 2>/dev/null; true`;
}

function containerInfo(c) {
  const name = (c.Names && c.Names[0] ? c.Names[0] : c.Id.slice(0, 12)).replace(/^\//, '');
  const ports = (c.Ports || [])
    .filter((p) => p.PublicPort)
    .map((p) => `${p.IP && p.IP !== '0.0.0.0' && p.IP !== '::' ? p.IP + ':' : ''}${p.PublicPort}→${p.PrivatePort}/${p.Type}`);
  return {
    id: c.Id,
    name,
    image: c.Image,
    state: c.State, // created | running | paused | restarting | removing | exited | dead
    status: c.Status,
    created: c.Created * 1000,
    ports: [...new Set(ports)],
    compose: (c.Labels || {})['com.docker.compose.project'] || '',
    mounts: (c.Mounts || []).map((m) => ({ type: m.Type, name: m.Name || '', source: m.Source, destination: m.Destination })),
  };
}

// --- per project ---

class ProjectDocker {
  constructor(mgr, project) {
    this.mgr = mgr;
    this.projectId = project.id;
    this.watchers = 0;
    this.client = null;
    this.timer = null;
    this.closeTimer = null;
    this.prevStats = new Map(); // container id -> last stats sample (CPU needs two)
    this.snap = { ok: false, error: null, loading: true, info: null, containers: [], df: null, host: null, updatedAt: 0, slowAt: 0 };
    this.lastSlow = 0;
    this.busy = false;
  }

  get project() { return this.mgr.store.getProject(this.projectId); }

  _client() {
    if (!this.client) {
      const p = this.project;
      const host = p.hostId ? this.mgr.store.getHost(p.hostId) : null;
      this.client = new DockerClient(dialSpec(p, host));
    }
    return this.client;
  }

  watch() {
    this.watchers++;
    clearTimeout(this.closeTimer);
    if (!this.timer) { this.lastSlow = 0; this.tick(); this.timer = setInterval(() => this.tick(), FAST_MS); }
  }

  unwatch() {
    this.watchers = Math.max(0, this.watchers - 1);
    if (this.watchers) return;
    clearInterval(this.timer);
    this.timer = null;
    this.closeTimer = setTimeout(() => this.closeConnections(), IDLE_CLOSE_MS);
  }

  closeConnections() {
    if (this.client) { this.client.close(); this.client = null; }
  }

  async tick(forceSlow = false) {
    if (this.busy) { if (forceSlow) this.lastSlow = 0; return; }
    this.busy = true;
    try {
      const c = this._client();
      const list = await c.request('GET', '/containers/json?all=1');
      const containers = list.map(containerInfo);
      await this._stats(c, containers);
      this.snap = { ...this.snap, ok: true, error: null, loading: false, containers, updatedAt: Date.now() };
      this.mgr.emit('update', this.projectId, this.snap);
      // system df can take seconds (it measures every volume): runs beside the 3-second rounds.
      if (forceSlow || Date.now() - this.lastSlow > SLOW_MS) {
        if (this.slowBusy) {
          if (forceSlow) this.slowAgain = true; // requested while one runs: run again right after it
        } else {
          this.lastSlow = Date.now();
          this.slowBusy = true;
          this._slow(c)
            .then(() => this.mgr.emit('update', this.projectId, this.snap))
            .catch(() => {})
            .finally(() => {
              this.slowBusy = false;
              if (this.slowAgain) { this.slowAgain = false; this.lastSlow = 0; }
            });
        }
      }
    } catch (e) {
      this.snap = { ...this.snap, ok: false, loading: false, error: e.message, updatedAt: Date.now() };
      this.closeConnections(); // a broken connection must not be reused
      this.mgr.emit('update', this.projectId, this.snap);
    } finally {
      this.busy = false;
    }
  }

  async _stats(c, containers) {
    const running = containers.filter((x) => x.state === 'running');
    const seen = new Set();
    let i = 0;
    const worker = async () => {
      while (i < running.length) {
        const ct = running[i++];
        seen.add(ct.id);
        try {
          const st = await c.request('GET', `/containers/${ct.id}/stats?stream=false&one-shot=true`, { timeout: 10000 });
          const prev = this.prevStats.get(ct.id);
          this.prevStats.set(ct.id, st);
          ct.cpu = cpuPercent(prev, st);
          ct.mem = memUsage(st);
          ct.memLimit = (st.memory_stats && st.memory_stats.limit) || null;
          ct.net = sumNet(st);
          ct.blk = sumBlk(st);
          ct.pids = (st.pids_stats && st.pids_stats.current) || null;
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, running.length) }, worker));
    for (const id of this.prevStats.keys()) if (!seen.has(id)) this.prevStats.delete(id);
  }

  async _slow(c) {
    const [info, df] = await Promise.all([
      c.request('GET', '/info'),
      c.request('GET', '/system/df', { timeout: 60000 }).catch((e) => ({ error: e.message })),
    ]);
    this.snap.info = {
      name: info.Name, serverVersion: info.ServerVersion, os: info.OperatingSystem, kernel: info.KernelVersion,
      arch: info.Architecture, ncpu: info.NCPU, memTotal: info.MemTotal, rootDir: info.DockerRootDir, driver: info.Driver,
      containers: info.Containers, running: info.ContainersRunning, paused: info.ContainersPaused, stopped: info.ContainersStopped, images: info.Images,
    };
    this.snap.df = df.error ? { error: df.error } : {
      layersSize: df.LayersSize || 0,
      images: (df.Images || []).map((im) => ({ id: im.Id, tags: (im.RepoTags || []).filter((t) => t !== '<none>:<none>'), size: im.Size, shared: im.SharedSize, containers: im.Containers, created: im.Created * 1000 })),
      volumes: (df.Volumes || []).map((v) => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint, size: v.UsageData ? v.UsageData.Size : -1, refs: v.UsageData ? v.UsageData.RefCount : -1, created: v.CreatedAt, labels: v.Labels || {} })),
      containersSize: (df.Containers || []).reduce((a, x) => a + (x.SizeRw || 0), 0),
      buildCache: (df.BuildCache || []).reduce((a, x) => a + (x.Size || 0), 0),
    };
    this.snap.host = await this._hostStats(this.snap.info.rootDir).catch(() => null);
    this.snap.slowAt = Date.now();
  }

  // Memory, load and the disk that holds Docker's data, read on the project machine (not for Windows-local Docker Desktop).
  _hostStats(dir) {
    const p = this.project;
    if (p.type === 'local' && process.platform === 'win32') return Promise.resolve(null);
    const host = p.hostId ? this.mgr.store.getHost(p.hostId) : null;
    const ex = buildRemoteExec(p, host, hostStatsScript(dir));
    return new Promise((resolve, reject) => {
      const proc = spawn(ex.file, ex.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 15000);
      proc.stdout.on('data', (d) => (out += d));
      proc.on('error', reject);
      proc.on('close', () => { clearTimeout(timer); resolve(parseHostStats(out)); });
    });
  }

  // One operation on a container, image or volume. item: {id, name, tags} (tags for images).
  async operate(kind, action, item, opts = {}) {
    const c = this._client();
    const id = encodeURIComponent(item.id);
    const flag = (b) => (b ? 1 : 0);
    if (kind === 'container') {
      const post = { start: 'start', stop: 'stop?t=10', restart: 'restart?t=10', pause: 'pause', unpause: 'unpause', kill: 'kill' };
      if (post[action]) return c.request('POST', `/containers/${id}/${post[action]}`, { timeout: 60000 });
      if (action === 'remove') return c.request('DELETE', `/containers/${id}?force=${flag(opts.force)}&v=${flag(opts.volumes)}`, { timeout: 60000 });
    }
    if (kind === 'image' && action === 'remove') {
      // An image with several tags can be removed by ID only with force; removing each tag removes it as well.
      if (!opts.force && item.tags && item.tags.length > 1) {
        for (const t of item.tags) await c.request('DELETE', `/images/${encodeURIComponent(t)}`, { timeout: 120000 });
        return null;
      }
      return c.request('DELETE', `/images/${id}?force=${flag(opts.force)}`, { timeout: 120000 });
    }
    if (kind === 'volume' && action === 'remove') return c.request('DELETE', `/volumes/${id}?force=${flag(opts.force)}`, { timeout: 60000 });
    throw new Error(`Unknown action: ${action} ${kind}`);
  }

  // The same operation on several items (three at a time); one failure does not stop the others.
  async bulk(kind, action, items, opts = {}) {
    const results = new Array(items.length);
    let i = 0;
    const worker = async () => {
      while (i < items.length) {
        const k = i++;
        try { await this.operate(kind, action, items[k], opts); results[k] = { id: items[k].id, name: items[k].name, ok: true }; } catch (e) { results[k] = { id: items[k].id, name: items[k].name, ok: false, error: e.message }; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
    this._refreshSoon(kind !== 'container' || action === 'remove'); // removals change disk usage
    return results;
  }

  // Remove what is not used: stopped containers, unused images (all, or only untagged), unused volumes.
  async prune(kind, { all = false } = {}) {
    const c = this._client();
    let r;
    if (kind === 'container') r = await c.request('POST', '/containers/prune', { timeout: 300000 });
    else if (kind === 'image') r = await c.request('POST', `/images/prune?filters=${encodeURIComponent(JSON.stringify({ dangling: [all ? 'false' : 'true'] }))}`, { timeout: 300000 });
    else if (kind === 'volume') r = await c.request('POST', `/volumes/prune${all ? `?filters=${encodeURIComponent(JSON.stringify({ all: ['true'] }))}` : ''}`, { timeout: 300000 });
    else throw new Error('Unknown kind ' + kind);
    this._refreshSoon(true);
    const list = r.ContainersDeleted || r.VolumesDeleted || (r.ImagesDeleted || []).filter((x) => x.Deleted) || [];
    return { count: (list || []).length, space: r.SpaceReclaimed || 0 };
  }

  // Only while the Docker tab is open; slow = also disk usage, images and volumes.
  _refreshSoon(slow) {
    setTimeout(() => { if (this.timer) this.tick(slow); }, 300);
  }

  async logs(containerId, { tail = 500, follow = true, timestamps = false } = {}, onText, onEnd) {
    const c = this._client();
    const inspect = await c.request('GET', `/containers/${encodeURIComponent(containerId)}/json`);
    const tty = inspect.Config && inspect.Config.Tty;
    const dec = new FrameDecoder();
    const q = new URLSearchParams({ stdout: '1', stderr: '1', follow: follow ? '1' : '0', tail: String(tail), timestamps: timestamps ? '1' : '0' });
    return c.stream(`/containers/${encodeURIComponent(containerId)}/logs?${q}`, (chunk) => {
      const text = tty ? chunk.toString('utf8') : dec.push(chunk);
      if (text) onText(text);
    }, onEnd);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.closeTimer);
    this.timer = null;
    this.closeConnections();
  }
}

class DockerManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.projects = new Map();
    this.logStreams = new Map(); // streamId -> stop function
    this.seq = 0;
  }

  _get(projectId) {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error('Unknown project');
    if (!p.docker || !p.docker.enabled) throw new Error('Docker is not enabled for this project');
    let d = this.projects.get(projectId);
    if (!d) { d = new ProjectDocker(this, p); this.projects.set(projectId, d); }
    return d;
  }

  watch(projectId) { const d = this._get(projectId); d.watch(); return d.snap; }
  unwatch(projectId) { const d = this.projects.get(projectId); if (d) d.unwatch(); }
  refresh(projectId) { return this._get(projectId).tick(true); }
  bulk(projectId, kind, action, items, opts) { return this._get(projectId).bulk(kind, action, items, opts); }
  prune(projectId, kind, opts) { return this._get(projectId).prune(kind, opts); }

  async logs(projectId, containerId, opts) {
    const id = `log${++this.seq}`;
    const stop = await this._get(projectId).logs(containerId, opts,
      (text) => this.emit('logs', { id, text }),
      (err) => { this.logStreams.delete(id); this.emit('logs', { id, end: true, error: err ? err.message : null }); });
    this.logStreams.set(id, stop);
    return id;
  }

  stopLogs(id) { const stop = this.logStreams.get(id); if (stop) { stop(); this.logStreams.delete(id); } }

  // Project changed (Docker switched off, connection or CLI changed) or deleted.
  reset(projectId) {
    const d = this.projects.get(projectId);
    if (!d) return;
    d.stop();
    this.projects.delete(projectId);
    const p = this.store.getProject(projectId);
    if (p && p.docker && p.docker.enabled && d.watchers) { const n = this._get(projectId); for (let i = 0; i < d.watchers; i++) n.watch(); }
  }

  shutdown() {
    for (const stop of this.logStreams.values()) { try { stop(); } catch {} }
    for (const d of this.projects.values()) d.stop();
  }
}

// Shell into a container, typed into a terminal session on the project machine.
function execCommand(project, container) {
  const cli = dockerCli(project).join(' ');
  return `${cli} exec -it ${container} sh -c "if command -v bash >/dev/null; then exec bash; else exec sh; fi"`;
}

module.exports = { DockerManager, ProjectDocker, DockerClient, dialSpec, stdioSocket, FrameDecoder, cpuPercent, memUsage, parseHostStats, containerInfo, execCommand };
