'use strict';
// Built-in orchestrators: each one is an OpenCode server + session with a system prompt and the app's MCP tools.
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { LocalOpenCodeServer, findOpencode, simplifyMessages } = require('./opencode');

const TEMPLATES = [
  {
    id: 'dev-review',
    name: 'Developer + reviewer',
    prompt: `You are an orchestrator that coordinates two coding agents running in terminal sessions of the Agent Terminal Manager.
You control them only through the MCP tools of the "atm" server (list_sessions, send_to_session, read_output, wait_until_idle, wait_for_any_idle).

Roles:
- The DEVELOPER session implements tasks.
- The REVIEWER session reviews the developer's changes (for example with "git diff") and reports problems.

Workflow:
1. When the user gives you a task, send it to the developer with send_to_session.
2. When the developer is finished (you receive an [ATM event] or wait_until_idle returns), read its output with read_output.
3. Send the reviewer a review request such as: "Review the latest changes with git diff and list concrete problems."
4. When the reviewer is finished, read the result. If there are problems, send them to the developer to fix, then repeat the review.
5. When the review is clean, summarize the result for the user and stop.

Rules: keep prompts to the agents short and concrete. Do not invent output; always read it. If an agent asks a question you cannot answer, ask the user.`,
  },
  {
    id: 'watch',
    name: 'Watch',
    prompt: `You watch agent sessions of the Agent Terminal Manager through the MCP tools of the "atm" server.
When you receive an [ATM event] that a session is waiting, read its output and decide:
- If the agent finished its task, summarize the result in one or two sentences.
- If the agent is asking for confirmation of a safe, obvious step, answer it with send_to_session.
- If the agent is stuck, has an error, or asks something risky, describe the situation and ask the user what to do.`,
  },
  {
    id: 'empty',
    name: 'Empty',
    prompt: 'You are an orchestrator for the Agent Terminal Manager. Use the MCP tools of the "atm" server to control the sessions you are allowed to access.',
  },
];

class OrchestratorManager extends EventEmitter {
  constructor({ store, sessions, mcp, audit, dataDir, notify }) {
    super();
    this.store = store;
    this.sessions = sessions;
    this.mcp = mcp;
    this.audit = audit;
    this.dataDir = dataDir;
    this.notify = notify || (() => {});
    this.runtime = new Map(); // id -> runtime state
    sessions.on('status', (s, prev) => this._onSessionStatus(s, prev));
  }

  templates() { return TEMPLATES; }

  list() {
    return this.store.data.orchestrators.map((o) => this.describe(o.id));
  }

  get(id) { return this.store.data.orchestrators.find((o) => o.id === id); }

  describe(id) {
    const o = this.get(id);
    if (!o) return null;
    const rt = this.runtime.get(id) || {};
    return {
      ...o,
      state: rt.state || 'stopped',
      busy: !!rt.busy,
      rounds: rt.rounds || 0,
      queue: (rt.queue || []).map((e) => e.key),
      error: rt.error || null,
      currentAction: rt.currentAction || null,
      conflicts: this.conflictsFor(id, o.watched || []),
    };
  }

  save(o) {
    const list = this.store.data.orchestrators;
    const existing = o.id ? this.get(o.id) : null;
    const merged = {
      id: o.id || crypto.randomUUID(),
      name: 'Orchestrator',
      systemPrompt: TEMPLATES[0].prompt,
      model: '',
      watched: [],
      maxRounds: 20,
      ...(existing || {}),
      ...o,
    };
    merged.maxRounds = Math.max(1, Number(merged.maxRounds) || 20);
    const conflicts = this.conflictsFor(merged.id, merged.watched || []);
    if (conflicts.length) {
      const names = conflicts.map((c) => `${this._keyLabel(c.key)} (${c.orchestrator})`).join(', ');
      throw new Error('Session already controlled by another orchestrator: ' + names);
    }
    if (existing) Object.assign(existing, merged); else list.push(merged);
    this.store.save();
    const rt = this.runtime.get(merged.id);
    if (rt && rt.tokenCtx) this.mcp.updateInternalScope(rt.tokenCtx, merged.watched);
    if (rt && rt.client && rt.sessionId && rt.state !== 'stopped') {
      rt.client.setInstructions(rt.sessionId, 'atm-system', this._systemText(merged)).catch(() => {});
    }
    this._emit(merged.id);
    return this.describe(merged.id);
  }

  remove(id) {
    this.stop(id);
    this.store.data.orchestrators = this.store.data.orchestrators.filter((o) => o.id !== id);
    this.store.save();
    this.emit('changed', this.list());
  }

  // A session can only be controlled by one orchestrator at a time.
  conflictsFor(id, keys) {
    const out = [];
    for (const other of this.store.data.orchestrators) {
      if (other.id === id) continue;
      for (const k of other.watched || []) if (keys.includes(k)) out.push({ key: k, orchestrator: other.name, orchestratorId: other.id });
    }
    return out;
  }

  _keyLabel(key) {
    const [pid, name] = key.split('/');
    const p = this.store.getProject(pid);
    return `${p ? p.name : '?'}/${name}`;
  }

  _emit(id) {
    this.emit('changed', this.list());
    if (id) this.emit('orchestrator', this.describe(id));
  }

  async start(id) {
    const o = this.get(id);
    if (!o) throw new Error('unknown orchestrator');
    if (this.runtime.get(id) && this.runtime.get(id).state !== 'stopped' && this.runtime.get(id).state !== 'error') return this.describe(id);
    if (!this.mcp.status.running) throw new Error('The MCP server of the app must be running (Settings → MCP).');
    const rt = { state: 'starting', rounds: 0, queue: [], busy: false, messages: [], live: '', error: null };
    this.runtime.set(id, rt);
    this._emit(id);
    try {
      const bin = findOpencode(this.store.settings.opencodePath);
      rt.server = new LocalOpenCodeServer({ bin, cwd: path.join(this.dataDir, 'orchestrators', id) });
      rt.server.on('exit', () => { if (rt.state !== 'stopped') { rt.state = 'error'; rt.error = 'OpenCode exited'; this._emit(id); } });
      const client = await rt.server.start();
      rt.client = client;
      const tok = this.mcp.createInternalToken(o.name, o.watched || []);
      rt.token = tok.secret;
      rt.tokenCtx = tok.ctx;
      await client.addMcp('atm', { type: 'remote', url: this.mcp.localUrl(), headers: { Authorization: 'Bearer ' + tok.secret }, oauth: false });
      const sess = await client.createSession();
      rt.sessionId = sess.id;
      if (o.model) await client.setModel(sess.id, o.model).catch((e) => { rt.error = 'model: ' + e.message; });
      await client.setInstructions(sess.id, 'atm-system', this._systemText(o));
      client.on('event', (ev) => this._onEvent(id, ev));
      rt.state = 'idle';
      this.audit.add({ source: 'orchestrator', action: 'start', detail: o.name });
    } catch (e) {
      rt.state = 'error';
      rt.error = e.message;
      if (rt.server) rt.server.stop();
      this.audit.add({ source: 'orchestrator', action: 'start', detail: o.name, error: e.message });
    }
    this._emit(id);
    return this.describe(id);
  }

  _systemText(o) {
    const watched = (o.watched || []).map((k) => `- ${this._keyLabel(k)}`).join('\n') || '- (none yet)';
    return `${o.systemPrompt}

---
Context from the Agent Terminal Manager:
Your name is "${o.name}". You may access exactly these sessions (project/name):
${watched}
Use "project/name" as the session argument of the atm tools.
Sessions of kind "agent" or "acp" are agent sessions: their status is exact and read_output returns structured messages, so prefer them for delegating work. Sessions of kind "terminal" are text terminals (a shell or an agent TUI); their "waiting" status is guessed from output pauses, so always read the output before you continue.
When a watched session becomes idle, you receive a message starting with "[ATM event]" that contains its latest output.
Be economical: you have at most ${o.maxRounds} event rounds before you are paused.`;
  }

  _onEvent(id, ev) {
    const rt = this.runtime.get(id);
    if (!rt || !ev.data || ev.data.sessionID !== rt.sessionId) return;
    const t = ev.type || '';
    if (t === 'session.execution.started') {
      rt.busy = true;
      rt.live = '';
      rt.currentAction = 'thinking';
      if (rt.state === 'idle') rt.state = 'running';
      this._emit(id);
    } else if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(t)) {
      rt.busy = false;
      rt.currentAction = null;
      if (rt.state === 'running') rt.state = 'idle';
      this.refresh(id).then(() => this._drain(id));
      this._emit(id);
    } else if (t === 'session.text.delta') {
      rt.live += ev.data.delta || '';
      rt.currentAction = 'writing';
      this.emit('live', { id, text: rt.live });
    } else if (t === 'session.tool.started' || t === 'session.tool.called' || t === 'session.tool.input.started') {
      rt.currentAction = 'tool: ' + (ev.data.name || ev.data.tool || '');
      this._emit(id);
      this._refreshSoon(id);
    } else if (/^session\.(step|tool|text)\.ended$/.test(t) || t === 'session.inbox.delivered') {
      this._refreshSoon(id);
    }
  }

  _refreshSoon(id) {
    const rt = this.runtime.get(id);
    if (!rt) return;
    clearTimeout(rt.rt);
    rt.rt = setTimeout(() => this.refresh(id), 300);
  }

  async refresh(id) {
    const rt = this.runtime.get(id);
    if (!rt || !rt.client || !rt.sessionId) return [];
    try {
      rt.messages = simplifyMessages(await rt.client.messages(rt.sessionId));
      this.emit('messages', { id, messages: rt.messages });
    } catch {}
    return rt.messages;
  }

  messages(id) {
    const rt = this.runtime.get(id);
    return rt ? rt.messages : [];
  }

  async send(id, text) {
    const rt = this.runtime.get(id);
    if (!rt || !rt.client || rt.state === 'stopped' || rt.state === 'error') throw new Error('Orchestrator is not running');
    rt.rounds = 0; // a user message starts a new task
    if (rt.state === 'paused') rt.state = 'idle';
    await rt.client.prompt(rt.sessionId, text);
    this.audit.add({ source: 'orchestrator', action: 'user-input', detail: `${this.get(id).name}: ${text.slice(0, 200)}` });
    this._refreshSoon(id);
    this._emit(id);
  }

  _onSessionStatus(s, prev) {
    if (s.status !== 'waiting' || !(prev === 'working' || prev === 'starting')) return;
    if (s.kind === 'terminal' && !s.hadInput) return; // ignore the initial prompt of a fresh shell
    const key = `${s.projectId}/${s.name}`;
    for (const o of this.store.data.orchestrators) {
      if (!(o.watched || []).includes(key)) continue;
      const rt = this.runtime.get(o.id);
      if (!rt || rt.state === 'stopped' || rt.state === 'error' || rt.state === 'starting') continue;
      const out = s.kind !== 'terminal' ? s.lastAssistantText() : s.readOutput({ lines: 40 }).text;
      rt.queue = rt.queue.filter((e) => e.key !== key);
      rt.queue.push({ key, label: this._keyLabel(key), output: out, at: Date.now() });
      this._drain(o.id);
      this._emit(o.id);
    }
  }

  async _drain(id) {
    const rt = this.runtime.get(id);
    const o = this.get(id);
    if (!rt || !o || rt.busy || rt.state !== 'idle' || !rt.queue.length || rt.sending) return;
    if (rt.rounds >= o.maxRounds) {
      rt.state = 'paused';
      rt.error = `Maximum of ${o.maxRounds} rounds reached — paused`;
      this.audit.add({ source: 'orchestrator', action: 'max-rounds', detail: o.name });
      this.notify(`Orchestrator ${o.name} paused`, rt.error);
      this._emit(id);
      return;
    }
    const events = rt.queue.splice(0);
    const text = events.map((e) => `[ATM event] Session "${e.label}" is now waiting (finished or waiting for input).\nLast output:\n\`\`\`\n${e.output.slice(-6000)}\n\`\`\``).join('\n\n');
    rt.rounds++;
    rt.sending = true;
    rt.busy = true;
    try {
      await rt.client.prompt(rt.sessionId, text);
      this.audit.add({ source: 'orchestrator', action: 'event', detail: `${o.name} ← ${events.map((e) => e.label).join(', ')} (round ${rt.rounds}/${o.maxRounds})` });
    } catch (e) {
      rt.busy = false;
      rt.error = e.message;
    } finally {
      rt.sending = false;
    }
    this._emit(id);
  }

  pause(id) {
    const rt = this.runtime.get(id);
    if (!rt || rt.state === 'stopped') return;
    rt.state = 'paused';
    this.audit.add({ source: 'orchestrator', action: 'pause', detail: this.get(id).name });
    this._emit(id);
  }

  resume(id) {
    const rt = this.runtime.get(id);
    if (!rt || rt.state !== 'paused') return;
    rt.state = rt.busy ? 'running' : 'idle';
    rt.error = null;
    rt.rounds = 0;
    this.audit.add({ source: 'orchestrator', action: 'resume', detail: this.get(id).name });
    this._emit(id);
    this._drain(id);
  }

  async interrupt(id) {
    const rt = this.runtime.get(id);
    if (rt && rt.client && rt.sessionId) await rt.client.interrupt(rt.sessionId).catch(() => {});
  }

  stop(id) {
    const rt = this.runtime.get(id);
    if (!rt) return;
    rt.state = 'stopped';
    if (rt.client && rt.sessionId && rt.busy) rt.client.interrupt(rt.sessionId).catch(() => {});
    if (rt.server) rt.server.stop();
    if (rt.token) this.mcp.dropInternalToken(rt.token);
    rt.queue = [];
    rt.busy = false;
    const o = this.get(id);
    if (o) this.audit.add({ source: 'orchestrator', action: 'stop', detail: o.name });
    this._emit(id);
  }

  shutdown() { for (const id of this.runtime.keys()) this.stop(id); }
}

module.exports = { OrchestratorManager, TEMPLATES };
