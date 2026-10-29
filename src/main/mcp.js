'use strict';
// MCP server of the app: Streamable HTTP with bearer tokens (app tokens or OAuth), session tools, status resources with subscriptions.
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { McpServer, ResourceTemplate } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SubscribeRequestSchema, UnsubscribeRequestSchema, isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const { OAuthServer } = require('./mcp-oauth');

// Sent to MCP clients on initialize; most clients put it into the model's context.
const SERVER_INSTRUCTIONS = `Agent Terminal Manager: control coding agents and terminals running in projects.

Session kinds (see list_sessions):
- "agent" (OpenCode server API) and "acp" (Agent Client Protocol, e.g. OpenCode or GitHub Copilot): agent sessions. Prefer these when you delegate work to an agent: send_to_session sends a prompt, the status comes from the agent itself (working until the turn is done), and read_output returns structured messages including tool calls. Slash commands like "/compact" can be sent as text.
- "terminal": a text terminal. It can run a plain shell or an agent TUI (e.g. Claude Code). send_to_session types the text and presses Enter, read_output returns the screen text. Its status is guessed: "waiting" means no output for a few seconds (or a terminal bell), so a long silent command can look idle. Use terminals for shell commands, or for agents that only run in a terminal.

Typical loop: list_sessions -> send_to_session -> wait_until_idle (or wait_for_any_idle for several sessions) -> read_output. Read the output before deciding; do not assume a result.
If a session reports waiting_for a permission, the user must answer it in the app.`;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const VERSION = require('../../package.json').version;

function statusUri(s) {
  const p = s.project;
  return `session://${encodeURIComponent(p ? p.name : '?')}/${encodeURIComponent(s.name)}/status`;
}

function isLoopback(addr) {
  return !addr || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

class McpService extends EventEmitter {
  constructor({ store, sessions, hosts, audit }) {
    super();
    this.store = store;
    this.sessions = sessions;
    this.hosts = hosts;
    this.audit = audit;
    this.http = null;
    this.clients = new Map(); // mcp session id -> {transport, server, ctx, subs}
    this.internalTokens = new Map(); // hash -> ctx (orchestrator tokens, memory only)
    this.status = { running: false, error: null, url: null };
    this.oauth = new OAuthServer({ store, audit });
    this.oauth.on('revoked', (g) => this._dropClients((c) => c.ctx.tokenId === 'oauth:' + g.id));

    sessions.on('status', (s) => this._notifyStatus(s));
    for (const ev of ['opened', 'closed', 'updated']) sessions.on(ev, () => this._notifyListChanged());
  }

  // ---------- tokens ----------
  listTokens() {
    return this.store.data.tokens.map(({ hash, ...t }) => t);
  }

  createToken({ name, readOnly = false }) {
    const secret = 'atm_' + crypto.randomBytes(24).toString('base64url');
    const t = { id: crypto.randomUUID(), name: name || 'token', readOnly: !!readOnly, prefix: secret.slice(0, 10), hash: sha256(secret), created: Date.now(), revoked: false, lastUsed: null };
    this.store.data.tokens.push(t);
    this.store.save();
    this.audit.add({ source: 'app', action: 'token.create', detail: `${t.name}${t.readOnly ? ' (read-only)' : ''}` });
    return { ...this._public(t), secret };
  }

  renewToken(id) {
    const t = this.store.data.tokens.find((x) => x.id === id);
    if (!t) throw new Error('unknown token');
    const secret = 'atm_' + crypto.randomBytes(24).toString('base64url');
    t.hash = sha256(secret);
    t.prefix = secret.slice(0, 10);
    t.revoked = false;
    t.renewed = Date.now();
    this.store.save();
    this._dropClients((c) => c.ctx.tokenId === id);
    this.audit.add({ source: 'app', action: 'token.renew', detail: t.name });
    return { ...this._public(t), secret };
  }

  revokeToken(id) {
    const t = this.store.data.tokens.find((x) => x.id === id);
    if (!t) return;
    t.revoked = true;
    this.store.save();
    this._dropClients((c) => c.ctx.tokenId === id);
    this.audit.add({ source: 'app', action: 'token.revoke', detail: t.name });
  }

  deleteToken(id) {
    this.revokeToken(id);
    this.store.data.tokens = this.store.data.tokens.filter((x) => x.id !== id);
    this.store.save();
  }

  _public(t) { const { hash, ...rest } = t; return rest; }

  // Token for an orchestrator: limited to its watched sessions, never persisted.
  createInternalToken(name, sessionKeys) {
    const secret = 'atmi_' + crypto.randomBytes(24).toString('base64url');
    const ctx = { tokenId: 'internal:' + name, tokenName: name, readOnly: false, sessionKeys: new Set(sessionKeys), internal: true };
    this.internalTokens.set(sha256(secret), ctx);
    return { secret, ctx };
  }

  dropInternalToken(secret) {
    const h = sha256(secret);
    const ctx = this.internalTokens.get(h);
    this.internalTokens.delete(h);
    if (ctx) this._dropClients((c) => c.ctx.base === ctx);
  }

  updateInternalScope(ctx, sessionKeys) { ctx.sessionKeys = new Set(sessionKeys); }

  async _authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const oauth = await this.oauth.authenticate(m[1].trim(), req);
    if (oauth) return oauth;
    const hash = sha256(m[1].trim());
    const internal = this.internalTokens.get(hash);
    if (internal) return internal;
    const t = this.store.data.tokens.find((x) => x.hash === hash && !x.revoked);
    if (!t) return null;
    t.lastUsed = Date.now();
    return { tokenId: t.id, tokenName: t.name, readOnly: t.readOnly };
  }

  // ---------- http ----------
  async start() {
    const cfg = this.store.settings.mcp;
    if (!cfg.enabled) { this.status = { running: false, error: null, url: null }; this.emit('status', this.status); return; }
    if (this.http) return;
    const server = http.createServer((req, res) => this._handle(req, res).catch((e) => {
      if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); }
      res.end(JSON.stringify({ error: e.message }));
    }));
    await new Promise((resolve) => {
      server.once('error', (e) => { this.status = { running: false, error: e.message, url: null }; resolve(); });
      server.listen(cfg.port, cfg.bind, () => {
        this.status = { running: true, error: null, url: `http://${cfg.bind}:${cfg.port}/mcp` };
        this.http = server;
        resolve();
      });
    });
    this.emit('status', this.status);
  }

  async stop() {
    this._dropClients(() => true);
    if (this.http) {
      const s = this.http;
      this.http = null;
      await new Promise((r) => { s.close(() => r()); s.closeAllConnections && s.closeAllConnections(); });
    }
    this.status = { running: false, error: null, url: null };
    this.emit('status', this.status);
  }

  async restart() { await this.stop(); await this.start(); }

  localUrl() {
    const cfg = this.store.settings.mcp;
    const host = cfg.bind === '0.0.0.0' || cfg.bind === '::' ? '127.0.0.1' : cfg.bind;
    return `http://${host}:${cfg.port}/mcp`;
  }

  _dropClients(pred) {
    for (const [sid, c] of this.clients) {
      if (pred(c)) { try { c.transport.close(); } catch {} this.clients.delete(sid); }
    }
  }

  async _handle(req, res) {
    const remote = req.socket.remoteAddress;
    const fwd = req.headers['x-forwarded-for'];
    const external = !isLoopback(remote) || !!fwd;
    const url = new URL(req.url, 'http://x');
    // OAuth metadata, registration, sign-in and token endpoints need no bearer token.
    if (await this.oauth.handle(req, res, url, fwd || remote)) return;
    const ctx = await this._authenticate(req);
    if (!ctx) {
      this.audit.add({ source: external ? 'external' : 'mcp', action: 'auth.denied', detail: `${req.method} ${url.pathname}`, remote: fwd || remote });
      res.writeHead(401, { 'www-authenticate': this.oauth.challenge(req) });
      res.end();
      return;
    }
    if (external && ctx.tokenId) {
      this.audit.add({ source: 'external', action: 'request', token: ctx.tokenName, detail: `${req.method} ${url.pathname}`, remote: fwd || remote });
    }
    if (url.pathname !== '/mcp') { res.writeHead(404); res.end(); return; }

    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      try { body = text ? JSON.parse(text) : undefined; } catch { res.writeHead(400); res.end('invalid json'); return; }
    }

    const sid = req.headers['mcp-session-id'];
    let client = sid ? this.clients.get(sid) : null;
    if (client && client.ctx.tokenId !== ctx.tokenId) { res.writeHead(403); res.end(); return; }

    if (!client) {
      if (req.method !== 'POST' || !(Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body))) {
        res.writeHead(sid ? 404 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sid ? 'Unknown session' : 'No session; send initialize first' }, id: null }));
        return;
      }
      client = { ctx: { ...ctx, base: ctx, remote: fwd || remote, external }, subs: new Set() };
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => { this.clients.set(id, client); client.id = id; },
      });
      transport.onclose = () => { if (client.id) this.clients.delete(client.id); };
      client.transport = transport;
      client.server = this._buildServer(client);
      await client.server.connect(transport);
      this.audit.add({ source: external ? 'external' : 'mcp', action: 'connect', token: ctx.tokenName, remote: fwd || remote });
    }
    await client.transport.handleRequest(req, res, body);
  }

  // ---------- access control ----------
  _visible(ctx) {
    const base = ctx.base || ctx;
    let list = this.sessions.list();
    if (base.sessionKeys) {
      list = list.filter((s) => base.sessionKeys.has(`${s.projectId}/${s.name}`) || base.sessionKeys.has(s.id));
    } else if (this.store.settings.mcp.restrictToShared) {
      list = list.filter((s) => s.shared);
    }
    return list.filter((s) => !s.orchestrator);
  }

  _resolve(ctx, ref, project) {
    const s = this.sessions.find(ref, project);
    if (!s || !this._visible(ctx).includes(s)) throw new Error(`Session not found or not shared: ${project ? project + '/' : ''}${ref}`);
    return s;
  }

  _sessionInfo(s) {
    const i = s.info();
    const r = {
      id: i.id, project: i.project, name: i.name, kind: i.kind,
      interface: i.kind === 'terminal' ? 'terminal (text screen; status guessed from output pauses)' : 'agent (structured messages; exact status)',
      status: i.status, idle_seconds: Math.round((Date.now() - i.lastOutputAt) / 1000), command: i.command, resource: statusUri(s),
    };
    if (i.kind === 'acp') r.agent = i.agentName;
    if (i.kind === 'agent') r.agent = 'OpenCode';
    if (i.model) r.model = i.model;
    if (i.permission) r.waiting_for = `permission: ${i.permission.title} (answer in the app)`;
    return r;
  }

  _require(flag, label) {
    if (!this.store.settings.mcp[flag]) throw new Error(`${label} is disabled in the app settings (MCP permissions)`);
  }

  // ---------- server ----------
  _buildServer(client) {
    const ctx = client.ctx;
    const server = new McpServer(
      { name: 'agent-terminal-manager', version: VERSION },
      { capabilities: { resources: { subscribe: true, listChanged: true }, logging: {} }, instructions: SERVER_INSTRUCTIONS },
    );
    const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });

    const tool = (name, description, shape, handler, { write = false } = {}) => {
      if (write && ctx.readOnly) return;
      server.registerTool(name, { description, inputSchema: shape, annotations: { readOnlyHint: !write } }, async (args, extra) => {
        const started = Date.now();
        try {
          const r = await handler(args || {}, extra);
          this.audit.add({ source: ctx.internal ? 'orchestrator' : ctx.external ? 'external' : 'mcp', token: ctx.tokenName, action: name, detail: summarizeArgs(args), ms: Date.now() - started });
          return text(r);
        } catch (e) {
          this.audit.add({ source: ctx.internal ? 'orchestrator' : ctx.external ? 'external' : 'mcp', token: ctx.tokenName, action: name, detail: summarizeArgs(args), error: e.message });
          return { ...text('Error: ' + e.message), isError: true };
        }
      });
    };

    const sessionRef = { session: z.string().describe('Session id, name, or "project/name"'), project: z.string().optional().describe('Project name or id (to disambiguate names)') };

    tool('list_projects', 'List configured projects.', {}, async () =>
      this.store.data.projects.map((p) => ({ id: p.id, name: p.name, type: p.type, host: p.hostId ? (this.store.getHost(p.hostId) || {}).name : p.host, directory: p.directory, commands: (p.commands || []).map((c) => c.name) })));

    tool('list_sessions', 'List running sessions with project, name, kind and status (working | waiting | starting | exited | error). kind "agent"/"acp" = agent session with structured messages (preferred for delegating work); kind "terminal" = text terminal (a plain shell or an agent TUI running in it).', { project: z.string().optional() }, async ({ project }) => {
      let list = this._visible(ctx);
      if (project) { const p = this.store.findProject(project); list = list.filter((s) => p && s.projectId === p.id); }
      return list.map((s) => this._sessionInfo(s));
    });

    tool('read_output', 'Read output of a session: the last N rendered lines, or everything since a marker returned by a previous call. Agent sessions return their latest messages.', {
      ...sessionRef,
      lines: z.number().int().min(1).max(2000).optional().describe('Number of last lines (default 50)'),
      since: z.number().int().min(0).optional().describe('Marker from a previous read_output; returns output since then'),
    }, async ({ session, project, lines, since }) => {
      const s = this._resolve(ctx, session, project);
      const out = s.readOutput({ lines: lines || 50, since });
      const r = { session: s.name, project: s.project.name, status: s.status, marker: out.marker, output: out.text };
      if (s.kind !== 'terminal') r.messages = s.messages.slice(-(lines || 20));
      return r;
    });

    const waitIdle = (s, timeoutSec, signal) => new Promise((resolve) => {
      if (s.status === 'waiting' || s.status === 'exited' || s.status === 'error') return resolve({ status: s.status, timed_out: false });
      const onStatus = (x) => { if (x === s && (x.status === 'waiting' || x.status === 'exited' || x.status === 'error')) finish(false); };
      const finish = (timedOut) => {
        clearTimeout(t);
        this.sessions.off('status', onStatus);
        resolve({ status: s.status, timed_out: timedOut });
      };
      const t = setTimeout(() => finish(true), timeoutSec * 1000);
      this.sessions.on('status', onStatus);
      if (signal) signal.addEventListener('abort', () => finish(true), { once: true });
    });

    tool('wait_until_idle', 'Block until the session has status "waiting" (agent finished / waiting for input), or until the timeout. Returns the status and the last output lines.', {
      ...sessionRef,
      timeout_sec: z.number().int().min(1).max(3600).optional().describe('Default 600'),
      tail_lines: z.number().int().min(0).max(500).optional().describe('Lines of output to include (default 40)'),
    }, async ({ session, project, timeout_sec, tail_lines }, extra) => {
      const s = this._resolve(ctx, session, project);
      const started = Date.now();
      const r = await waitIdle(s, timeout_sec || 600, extra && extra.signal);
      return { session: s.name, project: s.project.name, ...r, waited_sec: Math.round((Date.now() - started) / 1000), output: s.readOutput({ lines: tail_lines === undefined ? 40 : tail_lines }).text };
    });

    tool('wait_for_any_idle', 'Block until any of the given sessions is "waiting" and return which one. Sessions already waiting count immediately unless only_new is true.', {
      sessions: z.array(z.string()).min(1).describe('Session ids, names or "project/name"'),
      timeout_sec: z.number().int().min(1).max(3600).optional(),
      only_new: z.boolean().optional().describe('Ignore sessions that are already waiting when called'),
    }, async ({ sessions: refs, timeout_sec, only_new }, extra) => {
      const list = refs.map((r) => this._resolve(ctx, r));
      const done = (s) => ({ session: s.name, project: s.project.name, status: s.status, timed_out: false, output: s.readOutput({ lines: 40 }).text });
      if (!only_new) { const ready = list.find((s) => s.status === 'waiting'); if (ready) return done(ready); }
      return new Promise((resolve) => {
        const onStatus = (x) => { if (list.includes(x) && x.status === 'waiting') { cleanup(); resolve(done(x)); } };
        const cleanup = () => { clearTimeout(t); this.sessions.off('status', onStatus); };
        const t = setTimeout(() => { cleanup(); resolve({ timed_out: true, statuses: list.map((s) => ({ session: s.name, status: s.status })) }); }, (timeout_sec || 600) * 1000);
        this.sessions.on('status', onStatus);
        if (extra && extra.signal) extra.signal.addEventListener('abort', () => { cleanup(); resolve({ timed_out: true, aborted: true }); }, { once: true });
      });
    });

    tool('send_to_session', 'Send text (a prompt or command) to a session, followed by Enter unless enter=false.', {
      ...sessionRef,
      text: z.string().describe('Text to send'),
      enter: z.boolean().optional().describe('Press Enter after the text (default true)'),
    }, async ({ session, project, text: t, enter }) => {
      this._require('allowSend', 'Sending to sessions');
      const s = this._resolve(ctx, session, project);
      await s.send(t, { enter: enter !== false });
      return { ok: true, session: s.name, project: s.project.name };
    }, { write: true });

    tool('open_session', 'Open a new session in a project with its default session configuration. Optional: custom name, start command, kind "agent" (OpenCode server API) or "acp" (Agent Client Protocol, with acp_agent "opencode" or "copilot").', {
      project: z.string(),
      name: z.string().optional(),
      command: z.string().optional(),
      kind: z.enum(['terminal', 'agent', 'acp']).optional(),
      acp_agent: z.enum(['opencode', 'copilot', 'custom']).optional().describe('"custom" uses the ACP command configured in the project'),
    }, async ({ project, name, command, kind, acp_agent }) => {
      this._require('allowOpenSession', 'Opening sessions');
      const p = this.store.findProject(project);
      if (!p) throw new Error('Unknown project ' + project);
      const opts = {};
      if (name) opts.name = name;
      if (command !== undefined) opts.command = command;
      if (kind) opts.kind = kind;
      if (kind === 'acp') opts.acpAgent = acp_agent || 'opencode';
      const s = this.sessions.open(p.id, opts);
      if (ctx.base && ctx.base.sessionKeys) ctx.base.sessionKeys.add(`${s.projectId}/${s.name}`);
      return this._sessionInfo(s);
    }, { write: true });

    tool('run_command', 'Run one of the project\'s saved commands (by name) in a session.', {
      ...sessionRef,
      command: z.string().describe('Name of the saved command'),
    }, async ({ session, project, command }) => {
      this._require('allowRunCommand', 'Running saved commands');
      const s = this._resolve(ctx, session, project);
      const c = (s.project.commands || []).find((x) => x.name === command);
      if (!c) throw new Error(`No saved command "${command}" in project ${s.project.name}. Available: ${(s.project.commands || []).map((x) => x.name).join(', ')}`);
      await s.send(c.command);
      return { ok: true, ran: c.command, session: s.name };
    }, { write: true });

    tool('list_hosts', 'List developer hosts with reachability and number of running sessions.', {}, async () =>
      this.hosts.snapshot().map((h) => ({ id: h.id, name: h.name, hostname: h.hostname, port: h.port, user: h.user, workspace: h.workspace, tags: h.tags, reachable: h.reachable, app_sessions: h.appSessions, remote_tmux_sessions: h.remoteTmux ?? null })));

    tool('find_free_host', 'Find a reachable developer host with the fewest running sessions.', { tag: z.string().optional() }, async ({ tag }) => {
      const h = await this.hosts.findFree({ tag });
      if (!h) throw new Error('No reachable host found');
      return { id: h.id, name: h.name, hostname: h.hostname, workspace: h.workspace, app_sessions: h.appSessions, remote_tmux_sessions: h.remoteTmux ?? null };
    });

    tool('create_directory', 'Create a directory inside a host\'s workspace folder.', {
      host: z.string().describe('Host id or name'),
      path: z.string().describe('Path relative to the workspace folder'),
    }, async ({ host, path }) => {
      this._require('allowCreateDirectory', 'Creating directories');
      const h = this.store.findHost(host);
      if (!h) throw new Error('Unknown host ' + host);
      return this.hosts.createDirectory(h, path);
    }, { write: true });

    tool('create_project', 'Create a project on a developer host (SSH). Optionally opens a first session that runs start_command.', {
      name: z.string(),
      host: z.string().describe('Host id or name'),
      directory: z.string().optional().describe('Directory on the host; default <workspace>/<name>'),
      start_command: z.string().optional(),
      open: z.boolean().optional().describe('Open a session right away (default true)'),
      kind: z.enum(['terminal', 'agent']).optional(),
    }, async ({ name, host, directory, start_command, open, kind }) => {
      this._require('allowCreateProject', 'Creating projects');
      if (this.store.findProject(name)) throw new Error('A project with this name already exists');
      const h = this.store.findHost(host);
      if (!h) throw new Error('Unknown host ' + host);
      const dir = directory || `${(h.workspace || '~/workspace').replace(/\/$/, '')}/${name}`;
      const p = this.store.saveProject({
        name, type: 'ssh', hostId: h.id, directory: dir, tmux: true, keepAlive: true,
        defaultSession: { name: kind === 'agent' ? 'agent' : 'shell', command: start_command || '', kind: kind || 'terminal' },
      });
      const result = { project: { id: p.id, name: p.name, host: h.name, directory: dir } };
      if (open !== false) {
        const s = this.sessions.open(p.id, {});
        if (ctx.base && ctx.base.sessionKeys) ctx.base.sessionKeys.add(`${s.projectId}/${s.name}`);
        result.session = this._sessionInfo(s);
      }
      this.emit('project-created', p);
      return result;
    }, { write: true });

    // ----- resources -----
    server.registerResource('session-status', new ResourceTemplate('session://{project}/{name}/status', {
      list: async () => ({
        resources: this._visible(ctx).map((s) => ({ uri: statusUri(s), name: `${s.project.name}/${s.name}`, mimeType: 'application/json', description: `Status of session ${s.name}` })),
      }),
    }), { description: 'Status of a session (working / waiting / ...)', mimeType: 'application/json' }, async (uri, vars) => {
      const s = this._resolve(ctx, decodeURIComponent(vars.name), decodeURIComponent(vars.project));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(this._sessionInfo(s)) }] };
    });

    server.server.setRequestHandler(SubscribeRequestSchema, async (req) => { client.subs.add(req.params.uri); return {}; });
    server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => { client.subs.delete(req.params.uri); return {}; });
    return server;
  }

  _notifyStatus(s) {
    const uri = statusUri(s);
    for (const c of this.clients.values()) {
      if (c.subs.has(uri) && this._visible(c.ctx).includes(s)) {
        c.server.server.sendResourceUpdated({ uri }).catch(() => {});
      }
    }
  }

  _notifyListChanged() {
    clearTimeout(this._lc);
    this._lc = setTimeout(() => {
      for (const c of this.clients.values()) { try { c.server.sendResourceListChanged(); } catch {} }
    }, 200);
  }
}

function summarizeArgs(args) {
  if (!args) return '';
  const s = JSON.stringify(args);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

module.exports = { McpService, statusUri, sha256 };
