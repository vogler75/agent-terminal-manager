'use strict';
// Developer host directory: reachability checks, session counts and free-host selection.
const net = require('net');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { buildRemoteExec, shq, posixDir } = require('./connect');

function tcpCheck(hostname, port, timeout = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const sock = net.connect({ host: hostname, port: Number(port) || 22 });
    const done = (ok, err) => { sock.destroy(); resolve({ ok, ms: Date.now() - start, error: err }); };
    sock.setTimeout(timeout, () => done(false, 'timeout'));
    sock.once('connect', () => done(true));
    sock.once('error', (e) => done(false, e.code || e.message));
  });
}

function runCapture(file, args, timeout = 20000) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(file, args, { windowsHide: true }); } catch (e) { return resolve({ code: -1, out: e.message }); }
    const t = setTimeout(() => { try { p.kill(); } catch {} }, timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

class HostMonitor extends EventEmitter {
  constructor(store, sessions) {
    super();
    this.store = store;
    this.sessions = sessions;
    this.state = new Map(); // hostId -> {reachable, ms, error, checkedAt, remoteTmux}
    this.timer = setInterval(() => this.checkAll(), 30000);
    setTimeout(() => this.checkAll(), 1500);
  }

  appSessionCount(hostId) {
    const projects = new Set(this.store.data.projects.filter((p) => p.hostId === hostId).map((p) => p.id));
    return this.sessions.list().filter((s) => projects.has(s.projectId) && s.status !== 'exited').length;
  }

  // Resolve aliases from ~/.ssh/config (HostName / Port) so reachability checks match what ssh does.
  async resolve(host) {
    const args = ['-G'];
    if (host.port && Number(host.port) !== 22) args.push('-p', String(host.port));
    args.push(host.user ? `${host.user}@${host.hostname}` : host.hostname);
    const r = await runCapture('ssh', args, 5000);
    if (r.code !== 0) return { hostname: host.hostname, port: host.port };
    const get = (k) => (r.out.split(/\r?\n/).find((l) => l.startsWith(k + ' ')) || '').slice(k.length + 1).trim();
    return { hostname: get('hostname') || host.hostname, port: Number(get('port')) || host.port };
  }

  async check(host) {
    let r = await tcpCheck(host.hostname, host.port);
    if (!r.ok && r.error === 'ENOTFOUND') {
      const t = await this.resolve(host);
      if (t.hostname !== host.hostname || t.port !== host.port) r = await tcpCheck(t.hostname, t.port);
    }
    const prev = this.state.get(host.id) || {};
    const st = { ...prev, reachable: r.ok, ms: r.ms, error: r.error || null, checkedAt: Date.now() };
    this.state.set(host.id, st);
    this.emit('changed', this.snapshot());
    return st;
  }

  // Count tmux sessions on the host (requires key-based ssh, BatchMode).
  async checkRemoteSessions(host) {
    const ex = buildRemoteExec({ type: 'ssh', keepAlive: false }, host, 'tmux ls 2>/dev/null | wc -l');
    const r = await runCapture(ex.file, ex.args);
    const n = parseInt(String(r.out).trim().split(/\s+/).pop(), 10);
    const st = this.state.get(host.id) || {};
    st.remoteTmux = r.code === 0 && !Number.isNaN(n) ? n : null;
    st.sshOk = r.code === 0;
    st.sshError = r.code === 0 ? null : String(r.out).trim().slice(0, 200);
    this.state.set(host.id, st);
    this.emit('changed', this.snapshot());
    return st;
  }

  async checkAll() {
    await Promise.all(this.store.data.hosts.map((h) => this.check(h).catch(() => {})));
  }

  snapshot() {
    return this.store.data.hosts.map((h) => ({ ...h, ...(this.state.get(h.id) || {}), appSessions: this.appSessionCount(h.id) }));
  }

  async findFree({ tag } = {}) {
    let hosts = this.store.data.hosts;
    if (tag) hosts = hosts.filter((h) => (h.tags || []).includes(tag));
    await Promise.all(hosts.map((h) => this.check(h)));
    await Promise.all(hosts.filter((h) => this.state.get(h.id).reachable).map((h) => this.checkRemoteSessions(h).catch(() => {})));
    const list = this.snapshot().filter((h) => hosts.some((x) => x.id === h.id) && h.reachable);
    list.sort((a, b) => (a.appSessions + (a.remoteTmux || 0)) - (b.appSessions + (b.remoteTmux || 0)) || a.ms - b.ms);
    return list[0] || null;
  }

  async createDirectory(host, relPath) {
    if (!relPath || /(^|\/)\.\.(\/|$)/.test(relPath) || relPath.startsWith('/')) throw new Error('Path must be relative to the workspace folder and must not contain ..');
    const ws = (host.workspace || '~/workspace').replace(/\/$/, '');
    const full = `${ws}/${relPath}`;
    const ex = buildRemoteExec({ type: 'ssh', keepAlive: false }, host, `mkdir -p ${posixDir(full)} && cd ${posixDir(full)} && pwd`);
    const r = await runCapture(ex.file, ex.args);
    if (r.code !== 0) throw new Error('mkdir failed: ' + r.out.trim());
    return { path: full, absolute: r.out.trim().split('\n').pop() };
  }

  stop() { clearInterval(this.timer); }
}

module.exports = { HostMonitor, tcpCheck, runCapture, shq };
