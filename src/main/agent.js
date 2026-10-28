'use strict';
// Session type "agent": OpenCode in server mode, controlled over its HTTP API instead of terminal text.
const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { BaseSession } = require('./sessions');
const { OpenCodeClient, LocalOpenCodeServer, findOpencode, freePort, simplifyMessages, messagesToText } = require('./opencode');
const { resolveTarget, sshBaseArgs, sshDest, projectDir, posixDir, shq, tmuxName, SSH_BIN } = require('./connect');
const { Target } = require('./coding-agents/target');

class AgentSession extends BaseSession {
  constructor(mgr, project, opts) {
    super(mgr, project, { ...opts, kind: 'agent' });
    // Stable per-session values so a restarted app can re-attach to a still running remote server.
    this.agentKey = opts.agentKey || crypto.randomBytes(18).toString('base64url');
    this.remotePort = opts.remotePort || 20000 + Math.floor(Math.random() * 30000);
    this.agentSessionId = opts.agentSessionId || null;
    this.chosenModel = opts.model || null; // {providerID, id, variant} picked by the user
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
      if (this.chosenModel) {
        const m = this.chosenModel;
        await this.client.setModel(this.agentSessionId, m, m.variant || undefined)
          .catch((e) => this._log(`could not apply model ${m.providerID}/${m.id}: ${e.message}`));
      }
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
    this.tmuxName = name;
    const target = new Target(project, host);
    const started = await this._startRemote(target, name, agentCmd, dir, false);

    if (project.type === 'wsl') {
      // WSL2 forwards localhost ports to Windows.
      this.client = new OpenCodeClient({ url: `http://127.0.0.1:${this.remotePort}`, password: this.agentKey });
    } else {
      const t = resolveTarget(project, host);
      const base = [...sshBaseArgs(project, t)];
      const localPort = await freePort();
      const fwd = spawn(SSH_BIN, ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', ...base,
        '-L', `127.0.0.1:${localPort}:127.0.0.1:${this.remotePort}`, sshDest(t)], { windowsHide: true, stdio: 'ignore' });
      this.procs.push(fwd);
      fwd.on('exit', () => { if (!this._closed) { this._log('ssh forward closed'); this.setStatus('error', 'Connection lost'); } });
      this.client = new OpenCodeClient({ url: `http://127.0.0.1:${localPort}`, password: this.agentKey });
    }
    try {
      await this.client.waitReady(started === 'running' ? 8000 : 45000);
    } catch (e) {
      if (started === 'running') {
        // A tmux session from an earlier run (other port or password): replace it once.
        this._log('existing OpenCode tmux session not reachable, restarting it');
        await this._startRemote(target, name, agentCmd, dir, true);
        try { await this.client.waitReady(45000); } catch (e2) { throw new Error(await this._remoteFailure(target, name, e2)); }
      } else {
        throw new Error(await this._remoteFailure(target, name, e));
      }
    }
    this.client.streamEvents();
  }

  // Starts `opencode serve` in a tmux session on the target. Resolves the binary with the user's
  // PATH (npm, nvm, ~/.opencode/bin, ...) so tmux does not depend on it, checks for OpenCode v2 and
  // tmux, and logs the server output to a file for error reports. Returns 'started' or 'running'.
  async _startRemote(target, name, agentCmd, dir, restart) {
    const d = posixDir(dir);
    const log = `$HOME/.cache/agent-terminal-manager/${name}.log`;
    const script = [
      target.preamble(),
      `BIN=$(command -v ${shq(agentCmd)} 2>/dev/null)`,
      `case "$BIN" in '') echo "@@ERR notfound"; exit 0 ;; /mnt/[a-z]/*) echo "@@ERR windows $BIN"; exit 0 ;; esac`,
      'echo "@@BIN $BIN"',
      'echo "@@VERSION $("$BIN" --version 2>&1 </dev/null | head -n 1)"',
      'command -v tmux >/dev/null 2>&1 || { echo "@@ERR notmux"; exit 0; }',
      `mkdir -p "$HOME/.cache/agent-terminal-manager"`,
      restart ? `tmux kill-session -t ${shq('=' + name)} 2>/dev/null; sleep 0.5` : ':',
      `if tmux has-session -t ${shq('=' + name)} 2>/dev/null; then echo "@@RUNNING"; else`,
      `  tmux new-session -d -s ${shq(name)} "${d ? `cd ${d.replace(/"/g, '\\"')} && ` : ''}OPENCODE_SERVER_PASSWORD=${shq(this.agentKey)} exec \\"$BIN\\" serve --hostname 127.0.0.1 --port ${this.remotePort} > \\"${log}\\" 2>&1" && echo "@@STARTED" || echo "@@ERR tmuxfail"`,
      'fi',
    ].join('\n');
    const r = await target.run(script, { timeout: 60000 });
    const line = (tag) => (r.out.split(/\r?\n/).find((l) => l.startsWith(tag)) || '').slice(tag.length).trim();
    const where = this.project.type === 'wsl' ? `in WSL (${this.project.wslDistro || 'default distribution'})` : 'on the remote host';
    const err = r.out.split(/\r?\n/).find((l) => l.startsWith('@@ERR '));
    if (err) {
      const [, kind, extra] = /^@@ERR (\S+)\s*(.*)$/.exec(err);
      if (kind === 'notfound') throw new Error(`"${agentCmd}" was not found ${where}. Install OpenCode v2 there (Agents ▾ → Install OpenCode) or set the agent command in the project settings.`);
      if (kind === 'windows') throw new Error(`Only the Windows OpenCode was found (${extra}). Install OpenCode for Linux inside WSL (Agents ▾ → Install OpenCode).`);
      if (kind === 'notmux') throw new Error(`tmux is not installed ${where}; agent sessions run OpenCode inside tmux.`);
      throw new Error(`Could not start the tmux session ${where}.`);
    }
    if (!r.out.includes('@@BIN ')) throw new Error(`Could not run commands ${where}: ${(r.err || r.out).trim().slice(0, 300)}`);
    const version = line('@@VERSION ');
    const major = Number((/(\d+)\.\d+/.exec(version) || [])[1]);
    if (major && major < 2) throw new Error(`OpenCode ${version} found ${where}; agent sessions need OpenCode v2 (Agents ▾ → Install OpenCode installs v2).`);
    this._log(`OpenCode ${version} at ${line('@@BIN ')} ${r.out.includes('@@RUNNING') ? '(already running)' : '(started)'}`);
    return r.out.includes('@@RUNNING') ? 'running' : 'started';
  }

  // Builds an error message with the end of the server log and whether the tmux session still runs.
  async _remoteFailure(target, name, err) {
    const r = await target.run([
      `if tmux has-session -t ${shq('=' + name)} 2>/dev/null; then echo "@@ALIVE"; fi`,
      `tail -n 15 "$HOME/.cache/agent-terminal-manager/${name}.log" 2>/dev/null`,
    ].join('\n'), { timeout: 30000 }).catch(() => ({ out: '' }));
    const alive = r.out.includes('@@ALIVE');
    const log = r.out.replace('@@ALIVE', '').trim();
    return `OpenCode did not answer on port ${this.remotePort} (${err.message}). ` +
      (alive ? 'The server is running but not reachable through the tunnel.' : 'The server process exited.') +
      (log ? `\nServer log (~/.cache/agent-terminal-manager/${name}.log):\n${log}` : '');
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

  // Current model of this OpenCode session (falls back to the server default).
  async refreshModel() {
    try {
      const s = await this.client.getSession(this.agentSessionId);
      let ref = s && s.model;
      if (!ref || !ref.id) {
        const d = (await this.client.api('GET', '/api/model/default')).data;
        ref = d ? { providerID: d.providerID, id: d.modelID || d.id } : null;
      }
      const models = await this.client.listModels().catch(() => []);
      const m = ref && models.find((x) => x.providerID === ref.providerID && x.id === ref.id);
      this.modelRef = ref ? { providerID: ref.providerID, id: ref.id, variant: ref.variant && ref.variant !== 'default' ? ref.variant : '' } : null;
      this.model = ref ? `${ref.providerID}/${ref.id}${m && m.name ? ' (' + m.name + ')' : ''}${this.modelRef.variant ? ' · ' + this.modelRef.variant : ''}` : '';
    } catch { this.model = ''; }
    this.mgr.emit('updated', this);
  }

  async listModels() {
    if (!this.client) throw new Error(`Agent ${this.name} is not connected`);
    return { current: this.modelRef || null, models: await this.client.listModels() };
  }

  // Switch the model of this session; remembered so it is applied again after a reconnect or restart.
  async changeModel(providerID, id, variant) {
    if (!this.client || !this.agentSessionId) throw new Error(`Agent ${this.name} is not connected`);
    await this.client.setModel(this.agentSessionId, { providerID, id }, variant || undefined);
    this.chosenModel = { providerID, id, variant: variant || '' };
    this.mgr.persistOpen(this.projectId);
    await this.refreshModel();
    this._log(`model set to ${providerID}/${id}${variant ? ' (' + variant + ')' : ''}`);
  }

  info() {
    return { ...super.info(), agentSessionId: this.agentSessionId, url: this.client && this.client.url, model: this.model || '' };
  }

  // Values persisted with the open-session list so the agent can be re-attached after restart.
  persistExtra() {
    return { agentKey: this.agentKey, remotePort: this.remotePort, agentSessionId: this.agentSessionId, model: this.chosenModel || null };
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
