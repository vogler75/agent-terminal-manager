'use strict';
// Port forwarding per SSH project: one background `ssh -N -L ...` while the project has running sessions.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { buildForwardArgs } = require('./connect');

class ForwardManager extends EventEmitter {
  constructor(store, sessions) {
    super();
    this.store = store;
    this.sessions = sessions;
    this.procs = new Map(); // projectId -> {proc, status, error, restarts}
    const sync = () => this.syncAll();
    sessions.on('opened', sync);
    sessions.on('closed', sync);
    sessions.on('exit', sync);
    sessions.on('spawned', sync);
  }

  wanted(project) {
    if (!project || project.type !== 'ssh' || !(project.forwards || []).some((f) => f.local && f.remote)) return false;
    return this.sessions.list(project.id).some((s) => s.kind === 'terminal' && s.pty);
  }

  syncAll() {
    for (const p of this.store.data.projects) this.sync(p.id);
    for (const id of [...this.procs.keys()]) if (!this.store.getProject(id)) this.stop(id);
  }

  sync(projectId) {
    const p = this.store.getProject(projectId);
    const want = this.wanted(p);
    const cur = this.procs.get(projectId);
    if (want && !cur) this.start(p);
    else if (!want && cur) this.stop(projectId);
  }

  restart(projectId) {
    this.stop(projectId);
    this.sync(projectId);
  }

  start(p) {
    const host = p.hostId ? this.store.getHost(p.hostId) : null;
    let args;
    try { args = buildForwardArgs(p, host); } catch (e) { return; }
    const entry = { status: 'starting', error: null, forwards: p.forwards, log: '' };
    const proc = spawn('ssh', args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    entry.proc = proc;
    proc.stderr.on('data', (d) => { entry.log = (entry.log + d).slice(-2000); });
    proc.on('error', (e) => { entry.status = 'error'; entry.error = e.message; this._emit(); });
    proc.on('exit', (code) => {
      if (entry.stopped) return;
      entry.status = 'error';
      entry.error = `ssh forward exited (${code}) ${entry.log.trim().split('\n').pop() || ''}`;
      this._emit();
    });
    // ssh gives no ready signal with -N; consider it active if it is still alive shortly after.
    setTimeout(() => { if (entry.status === 'starting' && proc.exitCode === null) { entry.status = 'active'; this._emit(); } }, 2500);
    this.procs.set(p.id, entry);
    this._emit();
  }

  stop(projectId) {
    const e = this.procs.get(projectId);
    if (!e) return;
    e.stopped = true;
    try { e.proc.kill(); } catch {}
    this.procs.delete(projectId);
    this._emit();
  }

  snapshot() {
    const out = {};
    for (const [id, e] of this.procs) out[id] = { status: e.status, error: e.error, forwards: e.forwards };
    return out;
  }

  _emit() { this.emit('changed', this.snapshot()); }

  shutdown() { for (const id of [...this.procs.keys()]) this.stop(id); }
}

module.exports = { ForwardManager };
