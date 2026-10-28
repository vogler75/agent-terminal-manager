'use strict';
// Session type "agent": OpenCode in server mode, controlled over its HTTP API instead of terminal text.
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { BaseSession } = require('./sessions');
const { OpenCodeClient, LocalOpenCodeServer, findOpencode, freePort, simplifyMessages, messagesToText } = require('./opencode');
const { resolveTarget, sshBaseArgs, sshDest, projectDir, posixDir, shq, tmuxName } = require('./connect');

class AgentSession extends BaseSession {
  constructor(mgr, project, opts) {
    super(mgr, project, { ...opts, kind: 'agent' });
    // Stable per-session values so a restarted app can re-attach to a still running remote server.
    this.agentKey = opts.agentKey || crypto.randomBytes(18).toString('base64url');
    this.remotePort = opts.remotePort || 20000 + Math.floor(Math.random() * 30000);
    this.agentSessionId = opts.agentSessionId || null;
    this.messages = [];
    this.live = '';
    this.procs = [];
    this.client = null;
    this.server = null;
    this.log = [];
    this.start();
  }

  _log(line) {
    this.log.push(line);
    if (this.log.length > 200) this.log.shift();
    this.mgr.emit('agent-log', this, line);
  }

  async start() {
    this.setStatus('starting');
    this.error = null;
    try {
      await this._connect();
      this.client.on('event', (ev) => this._onEvent(ev));
      this.client.on('stream-error', (e) => this._log('event stream: ' + e.message));
      if (this.agentSessionId) {
        try { await this.client.getSession(this.agentSessionId); } catch { this.agentSessionId = null; }
      }
      if (!this.agentSessionId) {
        const s = await this.client.createSession();
        this.agentSessionId = s.id;
        this.mgr.persistOpen(this.projectId);
      }
      if (this.command) await this.client.setInstructions(this.agentSessionId, 'atm-start', this.command).catch(() => {});
      const active = await this.client.active().catch(() => ({}));
      this.setStatus(active[this.agentSessionId] ? 'working' : 'waiting', 'api');
      await this.refresh();
      this._log('connected to OpenCode at ' + this.client.url);
      await this.refreshModel();
    } catch (e) {
      this.error = e.message;
      this._log('error: ' + e.message);
      this.setStatus('error', e.message);
    }
  }

  async _connect() {
    const project = this.project;
    const host = project.hostId ? this.mgr.store.getHost(project.hostId) : null;
    const agentCmd = project.agentCommand || 'opencode';
    const dir = projectDir(project, host);

    if (project.type === 'local') {
      const bin = findOpencode(this.mgr.store.settings.opencodePath || (agentCmd !== 'opencode' ? agentCmd : ''));
      const cwd = dir ? dir.replace(/^~(?=$|[\\/])/, os.homedir()) : os.homedir();
      this.server = new LocalOpenCodeServer({ bin, cwd });
      this.server.on('exit', (code) => { this._log('opencode exited ' + code); this.setStatus('error', 'OpenCode exited'); });
      this.client = await this.server.start();
      return;
    }

    // Remote (ssh) or WSL: run `opencode serve` inside tmux on the target, reach it through localhost.
    const name = tmuxName(project, this.name) + '-oc';
    const serve = `OPENCODE_SERVER_PASSWORD=${shq(this.agentKey)} exec ${agentCmd} serve --hostname 127.0.0.1 --port ${this.remotePort}`;
    const d = posixDir(dir);
    const inner = `${d ? `cd ${d} && ` : ''}${serve}`;
    const startScript = `tmux has-session -t ${shq('=' + name)} 2>/dev/null || tmux new-session -d -s ${shq(name)} ${shq(inner)}`;

    if (project.type === 'wsl') {
      const args = project.wslDistro ? ['-d', project.wslDistro] : [];
      await this._run('wsl.exe', [...args, '--', 'bash', '-lc', startScript]);
      // WSL2 forwards localhost ports to Windows.
      this.client = new OpenCodeClient({ url: `http://127.0.0.1:${this.remotePort}`, password: this.agentKey });
    } else {
      const target = resolveTarget(project, host);
      const base = [...sshBaseArgs(project, target)];
      await this._run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...base, sshDest(target), startScript]);
      const localPort = await freePort();
      const fwd = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', ...base,
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${this.remotePort}`, sshDest(target)], { windowsHide: true, stdio: 'ignore' });
      this.procs.push(fwd);
      fwd.on('exit', () => { if (!this._closed) { this._log('ssh forward closed'); this.setStatus('error', 'Connection lost'); } });
      this.client = new OpenCodeClient({ url: `http://127.0.0.1:${localPort}`, password: this.agentKey });
    }
    this.tmuxName = name;
    await this.client.waitReady(45000);
    this.client.streamEvents();
  }

  _run(file, args) {
    return new Promise((resolve, reject) => {
      const p = spawn(file, args, { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('error', reject);
      p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`${file} failed (${code}): ${out.trim().slice(0, 300)}`))));
    });
  }

  _onEvent(ev) {
    const data = ev.data || {};
    if (data.sessionID !== this.agentSessionId) return;
    const t = ev.type || '';
    this.lastOutputAt = Date.now();
    if (t === 'session.execution.started') {
      this.live = '';
      this.setStatus('working', 'api');
    } else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(t)) {
      this.live = '';
      this.setStatus('waiting', t.split('.').pop());
      this.refresh();
    } else if (t === 'session.text.delta') {
      this.live += data.delta || '';
      this.mgr.emit('agent-live', this, this.live);
    } else if (t === 'session.step.ended' || t === 'session.inbox.delivered' || t === 'session.tool.ended' || t === 'session.text.ended') {
      this.refreshSoon();
    }
  }

  refreshSoon() {
    clearTimeout(this._rt);
    this._rt = setTimeout(() => this.refresh(), 250);
  }

  async refresh() {
    if (!this.client || !this.agentSessionId) return this.messages;
    try {
      this.messages = simplifyMessages(await this.client.messages(this.agentSessionId));
      this.mgr.emit('agent-messages', this, this.messages);
    } catch (e) {
      this._log('refresh: ' + e.message);
    }
    return this.messages;
  }

  async send(text) {
    if (!this.client || !this.agentSessionId) throw new Error(`Agent ${this.name} is not connected`);
    this.hadInput = true;
    await this.client.prompt(this.agentSessionId, text);
    this.setStatus('working', 'input');
    this.refreshSoon();
  }

  async interrupt() {
    if (this.client && this.agentSessionId) await this.client.interrupt(this.agentSessionId);
  }

  // Terminal-compatible no-ops so generic code paths work.
  write() {}
  resize() {}

  readOutput({ lines = 20 } = {}) {
    return { text: messagesToText(this.messages, lines), marker: this.messages.length };
  }

  lastAssistantText() {
    const a = [...this.messages].reverse().find((m) => m.role === 'assistant');
    return a ? a.text : '';
  }

  reconnect() {
    this.close({ keep: true });
    this._closed = false;
    this.start();
  }

  // Default model of the OpenCode server (depends on which providers are logged in).
  async refreshModel() {
    try {
      const r = await this.client.api('GET', '/api/model/default');
      const m = r && r.data;
      this.model = m ? `${m.providerID}/${m.modelID || m.id}${m.name ? ' (' + m.name + ')' : ''}` : '';
    } catch { this.model = ''; }
    this.mgr.emit('updated', this);
  }

  info() {
    return { ...super.info(), agentSessionId: this.agentSessionId, url: this.client && this.client.url, model: this.model || '' };
  }

  // Values persisted with the open-session list so the agent can be re-attached after restart.
  persistExtra() {
    return { agentKey: this.agentKey, remotePort: this.remotePort, agentSessionId: this.agentSessionId };
  }

  close({ killTmux = false } = {}) {
    this._closed = true;
    if (this.client) this.client.close();
    if (this.server) this.server.stop();
    for (const p of this.procs) { try { p.kill(); } catch {} }
    this.procs = [];
    if (killTmux && this.tmuxName) {
      const project = this.project;
      const script = `tmux kill-session -t ${shq('=' + this.tmuxName)} 2>/dev/null; true`;
      try {
        if (project.type === 'wsl') spawn('wsl.exe', [...(project.wslDistro ? ['-d', project.wslDistro] : []), '--', 'bash', '-lc', script], { windowsHide: true, stdio: 'ignore' });
        else if (project.type === 'ssh') {
          const host = project.hostId ? this.mgr.store.getHost(project.hostId) : null;
          const target = resolveTarget(project, host);
          spawn('ssh', ['-o', 'BatchMode=yes', ...sshBaseArgs(project, target), sshDest(target), script], { windowsHide: true, stdio: 'ignore' });
        }
      } catch {}
    }
  }
}

module.exports = { AgentSession };
