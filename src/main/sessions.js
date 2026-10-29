'use strict';
// Session manager: owns all running terminals (node-pty) and agent sessions, tracks their status.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { buildSpawn, buildTmuxKill } = require('./connect');

let pty = null;
function getPty() {
  if (!pty) {
    ensureSpawnHelperExecutable();
    pty = require('node-pty');
  }
  return pty;
}

// node-pty's prebuilt spawn-helper (macOS) can lose its execute bit on npm install or packaging,
// which makes every spawn fail with "posix_spawnp failed".
function ensureSpawnHelperExecutable() {
  if (process.platform === 'win32') return;
  const fs = require('fs');
  const path = require('path');
  try {
    const base = path.dirname(require.resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked');
    for (const dir of ['prebuilds/' + process.platform + '-' + process.arch, 'build/Release']) {
      const helper = path.join(base, dir, 'spawn-helper');
      if (fs.existsSync(helper) && !(fs.statSync(helper).mode & 0o111)) fs.chmodSync(helper, 0o755);
    }
  } catch {}
}

const RAW_LIMIT = 512 * 1024;
const BELL_GRACE_MS = 1000;
const RESIZE_GRACE_MS = 800;

// Remove OSC sequences (they may end with BEL) so a remaining BEL really is a bell.
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
function containsBell(data) {
  return data.indexOf('\x07') >= 0 && data.replace(OSC_RE, '').indexOf('\x07') >= 0;
}

function stripAnsi(s) {
  return s
    .replace(OSC_RE, '')
    .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>78DEHMNOZc]/g, '')
    .replace(/\x07/g, '')
    .split('\n')
    .map((line) => {
      // Emulate carriage returns: keep the text after the last \r that has content.
      const parts = line.replace(/\r$/, '').split('\r');
      return parts[parts.length - 1];
    })
    .join('\n');
}

class BaseSession extends EventEmitter {
  constructor(mgr, project, opts) {
    super();
    this.mgr = mgr;
    this.id = opts.id || crypto.randomUUID();
    this.projectId = project.id;
    this.name = opts.name;
    this.command = opts.command || '';
    this.kind = opts.kind || 'terminal';
    this.shared = opts.shared !== undefined ? !!opts.shared : true;
    this.orchestrator = !!opts.orchestrator;
    this.status = 'starting'; // starting | working | waiting | exited | error
    this.lastOutputAt = Date.now();
    this.createdAt = Date.now();
    this.hadInput = false;
    this.exitCode = null;
    this.error = null;
  }

  get project() { return this.mgr.store.getProject(this.projectId); }

  setStatus(status, reason) {
    if (this.status === status) return;
    const prev = this.status;
    this.status = status;
    this.mgr.emit('status', this, prev, reason);
  }

  info() {
    const p = this.project;
    return {
      id: this.id,
      projectId: this.projectId,
      project: p ? p.name : '?',
      name: this.name,
      kind: this.kind,
      command: this.command,
      status: this.status,
      shared: this.shared,
      orchestrator: this.orchestrator,
      lastOutputAt: this.lastOutputAt,
      createdAt: this.createdAt,
      exitCode: this.exitCode,
      error: this.error,
      hostId: p ? p.hostId : '',
      type: p ? p.type : '',
    };
  }

  thresholdMs() {
    const p = this.project;
    const sec = (p && p.thresholdSec) || this.mgr.store.settings.defaultThresholdSec || 5;
    return sec * 1000;
  }
}

class TerminalSession extends BaseSession {
  constructor(mgr, project, opts) {
    super(mgr, project, opts);
    this.cols = opts.cols || 120;
    this.rows = opts.rows || 30;
    this.headless = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 5000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.headless.loadAddon(this.serializer);
    // Shells that report their directory (OSC 7, file://host/path) tell file transfers where they are.
    this.headless.parser.registerOscHandler(7, (data) => {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
      if (m) { try { this.cwd = decodeURIComponent(m[1]); } catch {} }
      return true;
    });
    this.raw = '';
    this.rawOffset = 0; // total characters ever received; raw holds the tail
    this.userClosed = false;
    this.reconnectAttempts = 0;
    this.spawn();
  }

  spawn() {
    const project = this.project;
    const host = project.hostId ? this.mgr.store.getHost(project.hostId) : null;
    let spec;
    try {
      spec = buildSpawn(project, host, { id: this.id, name: this.name, command: this.command });
    } catch (e) {
      this._fail(e.message);
      return;
    }
    this.tmuxName = spec.tmuxName;
    this.spec = spec;
    this.exitCode = null;
    this.error = null;
    this.status = 'starting';
    this.mgr.emit('status', this, 'exited', 'spawn');
    let p;
    try {
      p = getPty().spawn(spec.file, spec.args, {
        name: 'xterm-256color',
        cols: this.cols,
        rows: this.rows,
        cwd: spec.cwd,
        // TERMCLAW_SID marks the shell (WSLENV passes it into WSL) so file transfers can find its directory.
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERMCLAW_SESSION: this.name, TERMCLAW_SID: this.id, WSLENV: [process.env.WSLENV, 'TERMCLAW_SID/u'].filter(Boolean).join(':'), ...spec.env },
        useConpty: true,
      });
    } catch (e) {
      this._fail(`Could not start ${spec.file}: ${e.message}`);
      return;
    }
    this.pty = p;
    let pendingPost = spec.postStart;
    p.onData((data) => {
      this._onData(data);
      if (pendingPost) {
        const cmd = pendingPost;
        pendingPost = '';
        setTimeout(() => this.write(cmd + '\r', { internal: true }), 400);
      }
    });
    p.onExit(({ exitCode }) => this._onExit(exitCode));
    this.mgr.emit('spawned', this);
  }

  _fail(message) {
    this.error = message;
    this.exitCode = -1;
    const text = `\r\n\x1b[31m[termclaw] ${message}\x1b[0m\r\n`;
    this._onData(text, true);
    this.setStatus('error', message);
    this.mgr.emit('exit', this);
  }

  _onData(data, internal) {
    this.headless.write(data);
    this.raw += data;
    this.rawOffset += data.length;
    if (this.raw.length > RAW_LIMIT) this.raw = this.raw.slice(this.raw.length - RAW_LIMIT);
    this.mgr.emit('data', this, data);
    if (internal) return;
    const now = Date.now();
    this.lastOutputAt = now;
    if (containsBell(data)) {
      this.bellAt = now;
      this.setStatus('waiting', 'bell');
    } else if (this.status !== 'working') {
      // Output that directly follows a bell (prompt redraw) does not count as new work.
      if (this.status === 'waiting' && this.bellAt && now - this.bellAt < BELL_GRACE_MS) return;
      // Redraws caused by a resize (view change, overview) are not agent activity either.
      if (this.resizedAt && now - this.resizedAt < RESIZE_GRACE_MS) return;
      this.setStatus('working', 'output');
    }
  }

  _onExit(code) {
    this.pty = null;
    this.exitCode = code;
    if (this.userClosed) return;
    const msg = code === 0 ? 'Session ended' : `Connection closed (exit code ${code})`;
    this._onData(`\r\n\x1b[33m[termclaw] ${msg}\x1b[0m\r\n`, true);
    if (code !== 0) this.error = msg;
    this.setStatus(code === 0 ? 'exited' : 'error', msg);
    this.mgr.emit('exit', this);
    const project = this.project;
    if (project && project.autoReconnect && code !== 0 && this.reconnectAttempts < 20) {
      const delay = Math.min(30000, 2000 * 2 ** this.reconnectAttempts);
      this.reconnectAttempts++;
      this._onData(`\x1b[33m[termclaw] Reconnecting in ${Math.round(delay / 1000)} s...\x1b[0m\r\n`, true);
      this._reconnectTimer = setTimeout(() => { if (!this.pty && !this.userClosed) this.spawn(); }, delay);
    }
  }

  reconnect() {
    clearTimeout(this._reconnectTimer);
    if (this.pty) { try { this.pty.kill(); } catch {} this.pty = null; }
    this.reconnectAttempts = 0;
    this.spawn();
  }

  write(data, { internal } = {}) {
    if (!internal) this.hadInput = true;
    if (this.pty) this.pty.write(data);
  }

  // Send a prompt followed by Enter. Text and Enter are sent separately so TUIs treat it as typed input.
  async send(text, { enter = true } = {}) {
    this.hadInput = true;
    if (!this.pty) throw new Error(`Session ${this.name} is not running`);
    this.pty.write(text);
    if (enter) {
      await new Promise((r) => setTimeout(r, 120));
      if (this.pty) this.pty.write('\r');
    }
    // Sending input means the agent should start working again.
    this.lastOutputAt = Date.now();
    this.setStatus('working', 'input');
  }

  resize(cols, rows) {
    cols = Math.max(10, cols | 0);
    rows = Math.max(3, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.resizedAt = Date.now();
    this.headless.resize(cols, rows);
    if (this.pty) { try { this.pty.resize(cols, rows); } catch {} }
  }

  lines(n = 50) {
    const buf = this.headless.buffer.active;
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      out.push(line ? line.translateToString(true) : '');
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.slice(-n);
  }

  // Output since a marker (character offset) as plain text; returns the next marker.
  readSince(marker) {
    const start = Math.max(marker | 0, this.rawOffset - this.raw.length);
    const chunk = this.raw.slice(start - (this.rawOffset - this.raw.length));
    return { text: stripAnsi(chunk), marker: this.rawOffset, truncated: (marker | 0) < this.rawOffset - this.raw.length };
  }

  readOutput({ lines = 50, since } = {}) {
    if (since !== undefined && since !== null) return this.readSince(since);
    return { text: this.lines(lines).join('\n'), marker: this.rawOffset };
  }

  serialize() {
    return this.serializer.serialize({ scrollback: 2000 });
  }

  close({ killTmux = false } = {}) {
    this.userClosed = true;
    clearTimeout(this._reconnectTimer);
    if (this.pty) { try { this.pty.kill(); } catch {} this.pty = null; }
    if (killTmux && this.tmuxName) {
      const project = this.project;
      const host = project && project.hostId ? this.mgr.store.getHost(project.hostId) : null;
      const k = project && buildTmuxKill(project, host, this.tmuxName);
      if (k) {
        const { spawn } = require('child_process');
        try { spawn(k.file, k.args, { stdio: 'ignore', windowsHide: true }).on('error', () => {}); } catch {}
      }
    }
    this.headless.dispose();
  }
}

class SessionManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.sessions = new Map();
    this.agentFactory = null; // set by main: (mgr, project, opts) => AgentSession
    this.timer = setInterval(() => this._tick(), 500);
  }

  _tick() {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.kind !== 'terminal') continue;
      if ((s.status === 'working' || s.status === 'starting') && now - s.lastOutputAt > s.thresholdMs()) {
        s.setStatus('waiting', 'quiet');
      }
    }
  }

  uniqueName(projectId, base) {
    const names = new Set([...this.sessions.values()].filter((s) => s.projectId === projectId).map((s) => s.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  open(projectId, opts = {}) {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error('Unknown project ' + projectId);
    const tpl = { ...project.defaultSession, ...opts };
    if (project.type === 'psremote' && tpl.kind && tpl.kind !== 'terminal') throw new Error('Agent sessions need a POSIX shell; PowerShell remoting projects only open terminals.');
    const name = opts.exactName ? opts.name : this.uniqueName(projectId, tpl.name || 'shell');
    const o = { ...tpl, name };
    const s = o.kind === 'agent' ? this.agentFactory(this, project, o)
      : o.kind === 'acp' ? this.acpFactory(this, project, o)
      : new TerminalSession(this, project, o);
    this.sessions.set(s.id, s);
    this.emit('opened', s);
    this.persistOpen(projectId);
    return s;
  }

  get(id) { return this.sessions.get(id); }

  find(ref, projectRef) {
    if (!ref) return null;
    if (this.sessions.has(ref)) return this.sessions.get(ref);
    // "project/name" form; it names the project itself, so it wins over projectRef.
    if (ref.includes('/')) {
      const [pn, sn] = ref.split('/');
      const p = this.store.findProject(pn);
      const hit = p && [...this.sessions.values()].find((s) => s.projectId === p.id && s.name === sn);
      if (hit) return hit;
    }
    let list = [...this.sessions.values()];
    if (projectRef) {
      const p = this.store.findProject(projectRef);
      list = list.filter((s) => p && s.projectId === p.id);
    }
    return list.find((s) => s.name === ref) || null;
  }

  list(projectId) {
    const all = [...this.sessions.values()];
    return projectId ? all.filter((s) => s.projectId === projectId) : all;
  }

  // Moves a session before another session of the same project (or to the end of the project).
  // The session map is rebuilt in the new order; it defines tabs, tree and the restored order.
  moveSessionTo(id, beforeId) {
    const s = this.get(id);
    if (!s || id === beforeId) return;
    const before = beforeId ? this.get(beforeId) : null;
    if (before && before.projectId !== s.projectId) throw new Error('Sessions can only be moved within their project');
    const list = [...this.sessions.values()].filter((x) => x !== s);
    let idx = before ? list.indexOf(before) : -1;
    if (idx < 0) {
      // end of the project: after its last session
      const lastOfProject = list.map((x, i) => (x.projectId === s.projectId ? i : -1)).filter((i) => i >= 0).pop();
      idx = lastOfProject === undefined ? list.length : lastOfProject + 1;
    }
    list.splice(idx, 0, s);
    this.sessions = new Map(list.map((x) => [x.id, x]));
    this.persistOpen(s.projectId);
    this.emit('reordered', s.projectId, this.list(s.projectId).map((x) => x.id));
  }

  moveSession(id, delta) {
    const s = this.get(id);
    if (!s) return;
    const ids = this.list(s.projectId).map((x) => x.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    if (delta < 0) this.moveSessionTo(id, ids[j]);
    else this.moveSessionTo(id, ids[j + 1] || null);
  }

  rename(id, name) {
    const s = this.get(id);
    if (!s || !name) return;
    s.name = this.uniqueName(s.projectId, name);
    this.emit('updated', s);
    this.persistOpen(s.projectId);
  }

  setFlags(id, flags) {
    const s = this.get(id);
    if (!s) return;
    if ('shared' in flags) s.shared = !!flags.shared;
    if ('orchestrator' in flags) s.orchestrator = !!flags.orchestrator;
    this.emit('updated', s);
    this.persistOpen(s.projectId);
  }

  close(id, opts) {
    const s = this.get(id);
    if (!s) return;
    s.close(opts);
    this.sessions.delete(id);
    this.emit('closed', s);
    this.persistOpen(s.projectId);
  }

  // Remember open sessions per project so they come back (tmux re-attach) after an app restart.
  persistOpen(projectId) {
    if (this._shuttingDown) return;
    const p = this.store.getProject(projectId);
    if (!p) return;
    p.openSessions = this.list(projectId).map((s) => ({
      name: s.name, command: s.command, kind: s.kind, shared: s.shared, orchestrator: s.orchestrator,
      ...(s.persistExtra ? s.persistExtra() : {}),
    }));
    this.store.save();
  }

  restoreAll() {
    for (const p of this.store.data.projects) {
      for (const o of p.openSessions || []) {
        try { this.open(p.id, { ...o, exactName: true }); } catch (e) { console.error('restore failed', e); }
      }
    }
  }

  shutdown() {
    this._shuttingDown = true;
    clearInterval(this.timer);
    for (const s of this.sessions.values()) { try { s.close(); } catch {} }
  }
}

module.exports = { SessionManager, TerminalSession, BaseSession, containsBell, stripAnsi };
