'use strict';
// Persistent configuration, stored as one JSON file in the app data directory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const uid = () => crypto.randomUUID();

const DEFAULT_SETTINGS = {
  defaultThresholdSec: 5,
  notifications: true,
  fontSize: 13,
  opencodePath: '',
  mcp: {
    enabled: true,
    port: 47900,
    bind: '127.0.0.1',
    // Permissions for MCP actions with side effects.
    allowSend: true,
    allowOpenSession: true,
    allowCreateProject: false,
    allowCreateDirectory: false,
    allowRunCommand: false,
    // Only sessions marked "shared" are visible to general MCP tokens.
    restrictToShared: true,
  },
};

const PROJECT_DEFAULTS = {
  type: 'local', // local | ssh | wsl
  hostId: '',
  host: '',
  user: '',
  port: 22,
  directory: '',
  wslDistro: '',
  keepAlive: true,
  keepAliveInterval: 30,
  keepAliveCountMax: 3,
  tmux: true,
  autoReconnect: false,
  thresholdSec: null, // null = global default
  defaultSession: { name: 'shell', command: '', kind: 'terminal' },
  terminals: [], // [{name, command, kind}] opened by "start all"
  commands: [], // saved commands [{name, command}]
  forwards: [], // [{local, remote, remoteHost}]
  agentCommand: 'opencode',
  layout: { mode: 'tabs', active: null },
  openSessions: [], // [{name, command, kind, shared, orchestrator}] restored on start
};

function normalizeProject(p) {
  const out = { ...structuredClone(PROJECT_DEFAULTS), ...p };
  out.id = out.id || uid();
  out.defaultSession = { ...PROJECT_DEFAULTS.defaultSession, ...(p.defaultSession || {}) };
  out.layout = { ...PROJECT_DEFAULTS.layout, ...(p.layout || {}) };
  out.port = Number(out.port) || 22;
  return out;
}

function normalizeHost(h) {
  return {
    id: h.id || uid(),
    name: h.name || h.hostname || 'host',
    hostname: h.hostname || '',
    port: Number(h.port) || 22,
    user: h.user || '',
    workspace: h.workspace || '~/workspace',
    tags: Array.isArray(h.tags) ? h.tags : String(h.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

function normalize(data) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS, ...(d.settings || {}), mcp: { ...DEFAULT_SETTINGS.mcp, ...((d.settings || {}).mcp || {}) } },
    hosts: (d.hosts || []).map(normalizeHost),
    projects: (d.projects || []).map(normalizeProject),
    tokens: d.tokens || [],
    orchestrators: d.orchestrators || [],
  };
}

// Passwords are never stored: strip anything that looks like one on save/import.
function stripSecrets(obj) {
  if (Array.isArray(obj)) return obj.map(stripSecrets);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/^(password|passwd|passphrase)$/i.test(k)) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return obj;
}

class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = normalize(this._read());
    this._timer = null;
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep a copy of a broken file instead of overwriting it silently.
        try { fs.copyFileSync(this.file, this.file + '.broken-' + Date.now()); } catch {}
      }
      return {};
    }
  }

  saveNow() {
    clearTimeout(this._timer);
    this._timer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stripSecrets(this.data), null, 2));
    fs.renameSync(tmp, this.file);
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 200);
    this.emit('changed', this.data);
  }

  get settings() { return this.data.settings; }

  updateSettings(patch) {
    const mcp = { ...this.data.settings.mcp, ...(patch.mcp || {}) };
    this.data.settings = { ...this.data.settings, ...patch, mcp };
    this.save();
    return this.data.settings;
  }

  // Projects
  getProject(id) { return this.data.projects.find((p) => p.id === id); }
  findProject(idOrName) {
    return this.data.projects.find((p) => p.id === idOrName) || this.data.projects.find((p) => p.name === idOrName);
  }
  saveProject(p) {
    const proj = normalizeProject(stripSecrets(p));
    const i = this.data.projects.findIndex((x) => x.id === proj.id);
    if (i >= 0) this.data.projects[i] = proj; else this.data.projects.push(proj);
    this.save();
    return proj;
  }
  patchProject(id, patch) {
    const p = this.getProject(id);
    if (!p) return null;
    Object.assign(p, patch);
    this.save();
    return p;
  }
  deleteProject(id) {
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    this.save();
  }
  moveProject(id, delta) {
    const i = this.data.projects.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.data.projects.length) return;
    const arr = this.data.projects;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    this.save();
  }

  // Hosts
  getHost(id) { return this.data.hosts.find((h) => h.id === id); }
  findHost(idOrName) {
    return this.data.hosts.find((h) => h.id === idOrName) || this.data.hosts.find((h) => h.name === idOrName || h.hostname === idOrName);
  }
  saveHost(h) {
    const host = normalizeHost(stripSecrets(h));
    const i = this.data.hosts.findIndex((x) => x.id === host.id);
    if (i >= 0) this.data.hosts[i] = host; else this.data.hosts.push(host);
    this.save();
    return host;
  }
  deleteHost(id) {
    this.data.hosts = this.data.hosts.filter((h) => h.id !== id);
    for (const p of this.data.projects) if (p.hostId === id) p.hostId = '';
    this.save();
  }

  // Import / export
  exportJson() {
    const { tokens, ...rest } = this.data; // tokens are machine-local secrets (hashes), not exported
    return JSON.stringify(stripSecrets(rest), null, 2);
  }
  importJson(text, { merge = false } = {}) {
    const incoming = normalize(JSON.parse(text));
    if (merge) {
      const byId = (arr, items) => {
        for (const it of items) {
          const i = arr.findIndex((x) => x.id === it.id);
          if (i >= 0) arr[i] = it; else arr.push(it);
        }
      };
      byId(this.data.projects, incoming.projects);
      byId(this.data.hosts, incoming.hosts);
      byId(this.data.orchestrators, incoming.orchestrators);
    } else {
      incoming.tokens = this.data.tokens;
      this.data = incoming;
    }
    this.save();
  }
}

module.exports = { Store, normalizeProject, normalizeHost, stripSecrets, uid, DEFAULT_SETTINGS };
