'use strict';
// OpenCode (v2) server-mode integration: process management, HTTP API client and SSE event stream.
const { EventEmitter } = require('events');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Locate the opencode binary. The npm shim on Windows needs a postinstall step, so prefer the platform binary.
function findOpencode(configured) {
  const candidates = [];
  if (configured) candidates.push(configured);
  if (process.platform === 'win32') {
    const npmDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    candidates.push(
      path.join(npmDir, '@opencode', 'cli', 'node_modules', '@opencode', `cli-windows-${arch}`, 'bin', 'opencode.exe'),
      path.join(npmDir, '@opencode', `cli-windows-${arch}`, 'bin', 'opencode.exe'),
      path.join(npmDir, 'opencode-ai', 'node_modules', `opencode-windows-${arch}`, 'bin', 'opencode.exe'),
      path.join(os.homedir(), '.opencode', 'bin', 'opencode.exe'),
    );
  } else {
    candidates.push(path.join(os.homedir(), '.opencode', 'bin', 'opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode');
  }
  candidates.push('opencode');
  for (const c of candidates) {
    if (c !== 'opencode' && !fs.existsSync(c)) continue;
    try {
      execFileSync(c, ['--version'], { timeout: 15000, windowsHide: true, stdio: 'pipe' });
      return c;
    } catch {}
  }
  return null;
}

class OpenCodeClient extends EventEmitter {
  constructor({ url, password }) {
    super();
    this.url = url.replace(/\/$/, '');
    this.auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
    this._abort = null;
    this._closed = false;
  }

  async api(method, p, body, { timeout = 30000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(this.url + p, {
        method,
        headers: { authorization: this.auth, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`OpenCode ${method} ${p}: ${r.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(t);
    }
  }

  async waitReady(timeoutMs = 30000, isAlive = () => true) {
    const end = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < end) {
      if (!isAlive()) throw new Error('OpenCode process exited');
      try { return await this.api('GET', '/api/info', undefined, { timeout: 2000 }); } catch (e) { lastErr = e; }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('OpenCode server not reachable: ' + (lastErr && lastErr.message));
  }

  // Subscribe to the server event stream; reconnects until close().
  async streamEvents() {
    while (!this._closed) {
      this._abort = new AbortController();
      try {
        const r = await fetch(this.url + '/api/event', { headers: { authorization: this.auth, accept: 'text/event-stream' }, signal: this._abort.signal });
        if (!r.ok || !r.body) throw new Error('event stream ' + r.status);
        this.emit('connected');
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of r.body) {
          buf += decoder.decode(chunk, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
            if (!data) continue;
            try { this.emit('event', JSON.parse(data)); } catch {}
          }
        }
      } catch (e) {
        if (this._closed) return;
        this.emit('stream-error', e);
      }
      if (!this._closed) await new Promise((r) => setTimeout(r, 1500));
    }
  }

  close() {
    this._closed = true;
    if (this._abort) this._abort.abort();
  }

  // Convenience wrappers
  createSession(directory) {
    return this.api('POST', '/api/session', directory ? { location: { directory } } : {}).then((r) => r.data);
  }
  getSession(id) { return this.api('GET', `/api/session/${id}`).then((r) => r.data); }
  setInstructions(id, key, value) {
    return this.api('PUT', `/api/experimental/session/${id}/instructions/entries/${encodeURIComponent(key)}`, { value });
  }
  setModel(id, model) {
    // model: "provider/model"
    const [providerID, ...rest] = String(model).split('/');
    return this.api('POST', `/api/session/${id}/model`, { model: { providerID, id: rest.join('/') } });
  }
  prompt(id, text) { return this.api('POST', `/api/session/${id}/prompt`, { text }); }
  interrupt(id) { return this.api('POST', `/api/session/${id}/interrupt`); }
  messages(id) { return this.api('GET', `/api/session/${id}/message`).then((r) => r.data || []); }
  active() { return this.api('GET', '/api/session/active').then((r) => r.data || {}); }
  addMcp(name, config) { return this.api('PUT', `/api/experimental/mcp/${encodeURIComponent(name)}`, { config }); }
  models() { return this.api('GET', '/api/model').then((r) => r.data || []); }
}

// A locally spawned `opencode serve` process with its client.
class LocalOpenCodeServer extends EventEmitter {
  constructor({ bin, cwd }) {
    super();
    this.bin = bin;
    this.cwd = cwd;
    this.password = crypto.randomBytes(24).toString('base64url');
    this.proc = null;
    this.client = null;
    this.log = '';
  }

  async start() {
    if (!this.bin) throw new Error('OpenCode binary not found. Set its path in Settings.');
    this.port = await freePort();
    fs.mkdirSync(this.cwd, { recursive: true });
    this.proc = spawn(this.bin, ['serve', '--hostname', '127.0.0.1', '--port', String(this.port)], {
      cwd: this.cwd,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: this.password },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onOut = (d) => { this.log = (this.log + d.toString()).slice(-20000); };
    this.proc.stdout.on('data', onOut);
    this.proc.stderr.on('data', onOut);
    let alive = true;
    this.proc.on('exit', (code) => { alive = false; this.proc = null; this.emit('exit', code); });
    this.proc.on('error', (e) => { alive = false; this.log += '\n' + e.message; });
    this.client = new OpenCodeClient({ url: `http://127.0.0.1:${this.port}`, password: this.password });
    await this.client.waitReady(30000, () => alive);
    this.client.streamEvents();
    return this.client;
  }

  stop() {
    if (this.client) this.client.close();
    if (this.proc) {
      const pid = this.proc.pid;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        else this.proc.kill();
      } catch {}
    }
  }
}

// Flatten OpenCode messages into simple {role, text, ...} entries for UI, MCP and orchestrator events.
function simplifyMessages(msgs) {
  const out = [];
  for (const m of msgs) {
    if (m.type === 'user') out.push({ id: m.id, role: 'user', text: m.text || (m.payload && m.payload.text) || '', time: m.time && m.time.created });
    else if (m.type === 'assistant') {
      const parts = [];
      const tools = [];
      for (const c of m.content || []) {
        if (c.type === 'text') parts.push(c.text);
        else if (c.type === 'tool') {
          const st = c.state || {};
          let result = '';
          if (st.status === 'completed') result = (st.content || []).map((x) => x.text || '').join('\n');
          else if (st.status === 'error') result = st.error ? (st.error.message || JSON.stringify(st.error)) : 'error';
          tools.push({ name: c.name, status: st.status, input: st.input, result: result.slice(0, 4000) });
        }
      }
      out.push({ id: m.id, role: 'assistant', text: parts.join('\n'), tools, time: m.time && m.time.created, done: !!(m.time && m.time.completed), error: m.error && (m.error.message || String(m.error)) });
    } else if (m.type === 'synthetic' || m.type === 'system') out.push({ id: m.id, role: 'system', text: m.text || '', time: m.time && m.time.created });
    else if (m.type === 'shell') out.push({ id: m.id, role: 'shell', text: `$ ${m.command}\n${(m.output && m.output.output) || ''}`, time: m.time && m.time.created });
    else if (m.type === 'idle') out.push({ id: m.id, role: 'idle', outcome: m.outcome, time: m.time && m.time.created });
  }
  // The API lists newest first; present oldest first.
  out.sort((a, b) => (a.time || 0) - (b.time || 0));
  return out;
}

function messagesToText(simple, n = 20) {
  return simple.filter((m) => m.role !== 'idle').slice(-n).map((m) => {
    let s = `[${m.role}] ${m.text || ''}`;
    for (const t of m.tools || []) s += `\n  (tool ${t.name}: ${t.status})`;
    return s;
  }).join('\n\n');
}

module.exports = { OpenCodeClient, LocalOpenCodeServer, findOpencode, freePort, simplifyMessages, messagesToText };
