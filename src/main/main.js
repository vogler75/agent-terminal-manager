'use strict';
const { app, BrowserWindow, ipcMain, Notification, dialog, Menu, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { SessionManager } = require('./sessions');
const { AgentSession } = require('./agent');
const { AcpSession, ACP_AGENTS } = require('./acp');
const { HostMonitor } = require('./hosts');
const { ForwardManager } = require('./forwards');
const { AuditLog } = require('./audit');
const { McpService } = require('./mcp');
const { OrchestratorManager } = require('./orchestrators');
const { filesFor, LocalFiles } = require('./files');
const { findOpencode } = require('./opencode');
const { AgentSetup } = require('./coding-agents/deploy');
const { SkillsRepo } = require('./coding-agents/skills');
const secrets = require('./secrets');
const crypto = require('crypto');

// Allow an isolated data directory (used by tests and for running several profiles).
if (process.env.TERMCLAW_USER_DATA) app.setPath('userData', path.resolve(process.env.TERMCLAW_USER_DATA));
else {
  // Renamed from Agent Terminal Manager: move the old data folder over so settings and projects are kept.
  // If that fails (old app still running, new folder already created), copy the app's own files.
  const old = path.join(app.getPath('appData'), 'Agent Terminal Manager');
  const dir = app.getPath('userData');
  if (fs.existsSync(path.join(old, 'config.json')) && !fs.existsSync(path.join(dir, 'config.json'))) {
    try { if (!fs.existsSync(dir)) fs.renameSync(old, dir); } catch {}
    for (const f of ['config.json', 'audit.log', 'skills']) {
      try { if (fs.existsSync(path.join(old, f)) && !fs.existsSync(path.join(dir, f))) fs.cpSync(path.join(old, f), path.join(dir, f), { recursive: true }); } catch {}
    }
  }
}

if (!process.env.TERMCLAW_USER_DATA && !app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;
let store, sessions, hosts, forwards, audit, mcp, orchestrators;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('event', { channel, payload });
}

// Batch terminal output per session to keep IPC traffic low.
const pendingData = new Map();
let flushScheduled = false;
function queueData(id, data) {
  pendingData.set(id, (pendingData.get(id) || '') + data);
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(() => {
      flushScheduled = false;
      for (const [sid, d] of pendingData) send('session:data', { id: sid, data: d });
      pendingData.clear();
    }, 8);
  }
}

const notificationLog = [];
function notify(title, body, onClick) {
  notificationLog.push({ title, body, time: Date.now() });
  if (!store.settings.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
    if (onClick) onClick();
  });
  n.show();
}

function setup() {
  const dataDir = app.getPath('userData');
  store = new Store(dataDir);
  audit = new AuditLog(dataDir);
  sessions = new SessionManager(store);
  sessions.agentFactory = (mgr, project, opts) => new AgentSession(mgr, project, opts);
  sessions.acpFactory = (mgr, project, opts) => new AcpSession(mgr, project, opts);
  hosts = new HostMonitor(store, sessions);
  forwards = new ForwardManager(store, sessions);
  mcp = new McpService({ store, sessions, hosts, audit });
  orchestrators = new OrchestratorManager({ store, sessions, mcp, audit, dataDir, notify: (t, b) => notify(t, b) });

  sessions.on('data', (s, d) => queueData(s.id, d));
  sessions.on('opened', (s) => send('session:opened', s.info()));
  sessions.on('closed', (s) => send('session:closed', { id: s.id, projectId: s.projectId }));
  sessions.on('updated', (s) => send('session:updated', s.info()));
  sessions.on('reordered', (projectId, ids) => send('sessions:reordered', { projectId, ids }));
  sessions.on('exit', (s) => send('session:updated', s.info()));
  sessions.on('agent-messages', (s, messages) => send('agent:messages', { id: s.id, messages }));
  sessions.on('agent-live', (s, text) => send('agent:live', { id: s.id, text }));
  sessions.on('agent-log', (s, line) => send('agent:log', { id: s.id, line }));
  sessions.on('agent-permission', (s, permission) => send('agent:permission', { id: s.id, permission }));
  sessions.on('status', (s, prev, reason) => {
    send('session:status', { id: s.id, status: s.status, prev, reason, lastOutputAt: s.lastOutputAt });
    // Notify when an agent switches to "waiting", but not for the first prompt of a fresh shell.
    if (s.status === 'waiting' && (prev === 'working') && (s.hadInput || s.kind !== 'terminal')) {
      const p = s.project;
      const focused = win && win.isFocused() && activeSessionId === s.id;
      if (!focused) notify(`${p ? p.name : ''} / ${s.name}`, reason === 'bell' ? 'Waiting for input (bell)' : 'Agent is waiting / finished', () => send('focus-session', { id: s.id }));
    }
  });
  hosts.on('changed', (snap) => send('hosts:status', snap));
  forwards.on('changed', (snap) => send('forwards:status', snap));
  audit.on('entry', (e) => send('audit:entry', e));
  mcp.on('status', (st) => send('mcp:status', st));
  mcp.oauth.on('request', (r) => {
    send('oauth:request', r);
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.flashFrame(true); }
    notify('MCP sign-in request', `${r.clientName} wants access (redirects to ${r.redirectHost}). Approve or deny in the app.`);
  });
  mcp.oauth.on('decided', (id) => send('oauth:decided', { id }));
  mcp.on('project-created', () => send('config:changed', publicConfig()));
  orchestrators.on('changed', (list) => send('orch:list', list));
  orchestrators.on('messages', (m) => send('orch:messages', m));
  orchestrators.on('live', (m) => send('orch:live', m));
  store.on('changed', () => send('config:changed', publicConfig()));
  // Test hook: give e2e tests access to the main-process services.
  if (process.env.TERMCLAW_USER_DATA) global.__termclaw = { store, sessions, hosts, forwards, audit, mcp, orchestrators, notificationLog, api: () => api, agentSetup: () => agentSetup(), targetClass: () => require('./coding-agents/target') };
}

let activeSessionId = null;

function publicConfig() {
  const { tokens, oauthClients, oauthGrants, mcpLibrary, ...rest } = store.data;
  // MCP secrets stay in the main process; the renderer only sees which keys exist.
  return { ...rest, mcpLibrary: mcpLibrary.map(({ secrets: s, ...e }) => ({ ...e, ...secretKeys(s) })) };
}

function secretKeys(blob) {
  const s = secrets.decrypt(blob);
  return { envKeys: Object.keys(s.env || {}), headerKeys: Object.keys(s.headers || {}) };
}

function projectFiles(projectId) {
  const p = store.getProject(projectId);
  if (!p) throw new Error('unknown project');
  return filesFor(p, p.hostId ? store.getHost(p.hostId) : null);
}

// Progress of a file transfer, at most every 200 ms.
function progress(jobId) {
  let last = 0;
  return (done, total) => {
    if (!jobId || (Date.now() - last < 200 && done < total)) return;
    last = Date.now();
    send('files:progress', { jobId, done, total });
  };
}

function agentSetup() {
  return new AgentSetup({ store, skills: skillsRepo(), audit });
}

function skillsRepo() {
  return new SkillsRepo(store.settings.skillsDir || path.join(app.getPath('userData'), 'skills'), store.data.skillSources || []);
}

// IPC API exposed to the renderer.
const api = {
  getState: () => ({
    config: publicConfig(),
    sessions: sessions.list().map((s) => s.info()),
    hosts: hosts.snapshot(),
    forwards: forwards.snapshot(),
    mcp: mcp.status,
    tokens: mcp.listTokens(),
    orchestrators: orchestrators.list(),
    templates: orchestrators.templates(),
    platform: process.platform,
    version: app.getVersion(),
    dataDir: app.getPath('userData'),
    stdioBridge: bridgePath(),
  }),

  // projects
  saveProject: (p) => {
    const before = p.id ? store.getProject(p.id) : null;
    const saved = store.saveProject(p);
    if (before && JSON.stringify(before.forwards) !== JSON.stringify(saved.forwards)) forwards.restart(saved.id);
    return saved;
  },
  deleteProject: (id) => {
    for (const s of sessions.list(id)) sessions.close(s.id);
    store.deleteProject(id);
  },
  moveProject: (id, delta) => store.moveProject(id, delta),
  moveProjectTo: (id, beforeId) => store.moveProjectTo(id, beforeId),
  moveSessionTo: (id, beforeId) => sessions.moveSessionTo(id, beforeId),
  moveSession: (id, delta) => sessions.moveSession(id, delta),
  setLayout: (id, layout) => { const p = store.getProject(id); if (p) { p.layout = { ...p.layout, ...layout }; store.save(); } },

  // hosts
  saveHost: (h) => { const r = store.saveHost(h); hosts.check(r); return r; },
  deleteHost: (id) => store.deleteHost(id),
  checkHosts: () => hosts.checkAll(),
  checkHostSsh: (id) => { const h = store.getHost(id); return h ? hosts.checkRemoteSessions(h) : null; },

  // sessions
  openSession: (projectId, opts) => sessions.open(projectId, opts || {}).info(),
  startAll: (projectId) => {
    const p = store.getProject(projectId);
    const existing = new Set(sessions.list(projectId).map((s) => s.name));
    const list = p.terminals && p.terminals.length ? p.terminals : [p.defaultSession];
    return list.filter((t) => !existing.has(t.name)).map((t) => sessions.open(projectId, { ...t, exactName: false }).info());
  },
  closeSession: (id, killTmux) => sessions.close(id, { killTmux }),
  renameSession: (id, name) => sessions.rename(id, name),
  setSessionFlags: (id, flags) => sessions.setFlags(id, flags),
  write: (id, data) => { const s = sessions.get(id); if (s) s.write(data); },
  resize: (id, cols, rows) => { const s = sessions.get(id); if (s) s.resize(cols, rows); },
  reconnect: (id) => { const s = sessions.get(id); if (s) s.reconnect(); },
  serialize: (id) => { const s = sessions.get(id); return s && s.serialize ? s.serialize() : ''; },
  setActive: (id) => { activeSessionId = id; },
  runCommand: async (id, command) => { const s = sessions.get(id); if (s) await s.send(command); },
  agentSend: (id, text) => { const s = sessions.get(id); if (!s) throw new Error('no session'); return s.send(text); },
  agentMessages: (id) => { const s = sessions.get(id); return s && s.refresh ? s.refresh() : []; },
  agentInterrupt: (id) => { const s = sessions.get(id); return s && s.interrupt ? s.interrupt() : null; },
  agentRefreshModel: (id) => { const s = sessions.get(id); return s && s.refreshModel ? s.refreshModel() : null; },
  acpAgents: () => Object.entries(ACP_AGENTS).map(([id, a]) => ({ id, name: a.name })),
  agentSetApproval: (id, policy) => { const s = sessions.get(id); if (!s || !s.setApproval) throw new Error('not an ACP session'); return s.setApproval(policy); },
  agentSetOption: (id, optionId, value) => { const s = sessions.get(id); if (!s || !s.setAgentOption) throw new Error('not an ACP session'); return s.setAgentOption(optionId, value); },
  agentPermission: (id, optionId) => { const s = sessions.get(id); if (!s || !s.answerPermission) throw new Error('not an ACP session'); return s.answerPermission(optionId); },
  agentSlashCommands: (id) => { const s = sessions.get(id); if (!s || !s.slashCommands) throw new Error('not an agent session'); return s.slashCommands(); },
  agentRunSlash: (id, text) => { const s = sessions.get(id); if (!s || !s.runSlash) throw new Error('not an agent session'); return s.runSlash(text); },
  agentModels: (id) => { const s = sessions.get(id); if (!s || !s.listModels) throw new Error('not an agent session'); return s.listModels(); },
  agentSetModel: (id, providerID, modelId, variant) => {
    const s = sessions.get(id);
    if (!s || !s.changeModel) throw new Error('not an agent session');
    return s.changeModel(providerID, modelId, variant);
  },
  // Opens a terminal in the agent's project running the interactive `opencode auth login`.
  // Credentials are stored per user and machine, so all OpenCode servers there use them.
  agentLogin: (id) => {
    const s = sessions.get(id);
    if (!s) throw new Error('no session');
    const p = s.project;
    let cmd;
    if (s.loginCommand) cmd = s.loginCommand();
    else if (p.type === 'local') {
      const bin = findOpencode(store.settings.opencodePath || (p.agentCommand !== 'opencode' ? p.agentCommand : ''));
      if (!bin) throw new Error('OpenCode binary not found. Set its path in Settings.');
      cmd = process.platform === 'win32' ? `& '${bin.replace(/'/g, "''")}' auth login` : `'${bin.replace(/'/g, "'\\''")}' auth login`;
    } else {
      cmd = `${p.agentCommand || 'opencode'} auth login`;
    }
    const t = sessions.open(p.id, { name: (s.acpAgent || 'opencode') + '-login', command: '', kind: 'terminal' });
    setTimeout(() => t.send(cmd).catch(() => {}), 1500);
    audit.add({ source: 'app', action: 'agents.provider-login', detail: `${p.name}/${s.name}` });
    return t.info();
  },

  // settings, import/export
  updateSettings: async (patch) => {
    // Only listener changes need a restart; permissions and OAuth settings are read per request.
    const listener = (m) => JSON.stringify([m.enabled, m.port, m.bind]);
    const prev = listener(store.settings.mcp);
    const s = store.updateSettings(patch);
    if (listener(s.mcp) !== prev) await mcp.restart();
    return s;
  },
  exportConfig: async () => {
    const r = await dialog.showSaveDialog(win, { defaultPath: 'termclaw.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, store.exportJson());
    return r.filePath;
  },
  importConfig: async (merge) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    store.importJson(fs.readFileSync(r.filePaths[0], 'utf8'), { merge });
    return r.filePaths[0];
  },
  importConfigText: (text, merge) => store.importJson(text, { merge }),
  exportConfigText: () => store.exportJson(),
  openDataDir: () => shell.openPath(app.getPath('userData')),
  detectOpencode: () => findOpencode(store.settings.opencodePath),
  copy: (text) => clipboard.writeText(String(text)),
  openExternal: (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); },
  showInFolder: (p) => shell.showItemInFolder(String(p)),

  // files on the project's machine (file browser, drag & drop onto a terminal)
  filesList: (projectId, dir) => projectFiles(projectId).list(dir),
  // Where a file dropped onto this terminal goes: the shell's current directory.
  filesDropTarget: async (sessionId) => {
    const s = sessions.get(sessionId);
    if (!s || s.kind !== 'terminal') throw new Error('not a terminal session');
    const f = projectFiles(s.projectId);
    return { projectId: s.projectId, dir: await f.sessionCwd(s), label: f.label, remote: !(f instanceof LocalFiles) };
  },
  filesExists: (projectId, dir, names) => projectFiles(projectId).exists(dir, names),
  filesMkdir: (projectId, dir, name) => projectFiles(projectId).mkdir(dir, name),
  filesUpload: async (projectId, localPaths, dir, jobId) => {
    const p = store.getProject(projectId);
    const r = await projectFiles(projectId).upload(localPaths, dir, { onProgress: progress(jobId) });
    audit.add({ source: 'app', action: 'files.upload', detail: `${p.name}: ${localPaths.map((x) => path.basename(x)).join(', ')} → ${dir}` });
    return r;
  },
  filesPickUpload: async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  },
  // items: [{path, type, size}]; asks for the local folder (default: Downloads).
  filesDownload: async (projectId, items, jobId) => {
    const r = await dialog.showOpenDialog(win, { title: 'Download to folder', defaultPath: app.getPath('downloads'), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = store.getProject(projectId);
    const out = await projectFiles(projectId).download(items, r.filePaths[0], { onProgress: progress(jobId) });
    audit.add({ source: 'app', action: 'files.download', detail: `${p.name}: ${items.map((i) => i.path).join(', ')} → ${r.filePaths[0]}` });
    return out;
  },

  // mcp
  mcpStatus: () => mcp.status,
  createToken: (opts) => mcp.createToken(opts),
  renewToken: (id) => mcp.renewToken(id),
  revokeToken: (id) => mcp.revokeToken(id),
  deleteToken: (id) => mcp.deleteToken(id),
  listTokens: () => mcp.listTokens(),
  oauthGrants: () => mcp.oauth.listGrants(),
  oauthPending: () => mcp.oauth.listPending(),
  oauthDecide: (id, decision) => mcp.oauth.decide(id, decision),
  oauthRevoke: (id) => mcp.oauth.revokeGrant(id),
  oauthDelete: (id) => mcp.oauth.deleteGrant(id),
  oauthTestIssuer: (issuer) => mcp.oauth.testIssuer(issuer),
  auditList: () => audit.list(),

  // orchestrators
  orchSave: (o) => orchestrators.save(o),
  orchRemove: (id) => orchestrators.remove(id),
  orchStart: (id) => orchestrators.start(id),
  orchStop: (id) => orchestrators.stop(id),
  orchPause: (id) => orchestrators.pause(id),
  orchResume: (id) => orchestrators.resume(id),
  orchInterrupt: (id) => orchestrators.interrupt(id),
  orchSend: (id, text) => orchestrators.send(id, text),
  orchMessages: (id) => orchestrators.refresh(id),

  // MCP library (servers to deploy to coding agents)
  libraryGet: (id) => {
    const e = store.data.mcpLibrary.find((x) => x.id === id);
    if (!e) return null;
    const { secrets: blob, ...rest } = e;
    return { ...rest, ...secrets.decrypt(blob) };
  },
  librarySave: (entry) => {
    const { env, headers, envKeys, headerKeys, ...rest } = entry;
    const e = { ...rest, id: rest.id || crypto.randomUUID(), secrets: secrets.encrypt({ env: env || {}, headers: headers || {} }) };
    const list = store.data.mcpLibrary;
    const i = list.findIndex((x) => x.id === e.id);
    if (i >= 0) list[i] = e; else list.push(e);
    store.save();
    return e.id;
  },
  libraryDelete: (id) => {
    store.data.mcpLibrary = store.data.mcpLibrary.filter((x) => x.id !== id);
    for (const p of store.data.projects) if (p.agentSetup) p.agentSetup.mcp = (p.agentSetup.mcp || []).filter((x) => x !== id);
    store.save();
  },

  // APM package library
  apmLibrarySave: (entry) => {
    const { validRef } = require('./coding-agents/apm');
    const ref = String(entry.ref || '').trim();
    if (!validRef(ref)) throw new Error('Invalid package reference. Use owner/repo[/path][#ref], plugin@marketplace or a Git URL.');
    const e = { id: entry.id || crypto.randomUUID(), ref, description: String(entry.description || '').trim() };
    const list = store.data.apmLibrary;
    const i = list.findIndex((x) => x.id === e.id);
    if (i >= 0) list[i] = e; else list.push(e);
    store.save();
    return e.id;
  },
  apmLibraryDelete: (id) => {
    store.data.apmLibrary = store.data.apmLibrary.filter((x) => x.id !== id);
    for (const p of store.data.projects) if (p.agentSetup) p.agentSetup.apm = (p.agentSetup.apm || []).filter((x) => x !== id);
    store.save();
  },
  apmDescribeRef: (ref) => require('./coding-agents/apm').describeRef(ref),
  apmAction: (projectId, action) => agentSetup().apmAction(store.getProject(projectId), action),
  agentsTools: () => agentSetup().tools(),

  // Git sources for skills: downloaded into the skills repository, deployed like own skills
  skillSourceSave: (entry) => {
    const { validSource } = require('./coding-agents/skills');
    const apmRef = require('./coding-agents/apm');
    let url = String(entry.url || '').trim();
    // APM notation (owner/repo[/path][#ref]) is converted to a GitHub source.
    if (validSource({ url }) && apmRef.validRef(url)) {
      const conv = apmRef.refToSource(url);
      url = conv.url;
      entry = { ...entry, ref: entry.ref || conv.ref, path: entry.path || conv.path, name: entry.name || conv.name };
    }
    const name = String(entry.name || '').trim() || url.replace(/\.git$/, '').split(/[/:\\]/).filter(Boolean).pop() || 'source';
    const src = { id: entry.id || crypto.randomUUID(), name, url, ref: String(entry.ref || '').trim(), path: String(entry.path || '').trim().replace(/^[\\/]+/, '') };
    const err = validSource(src);
    if (err) throw new Error(err);
    const list = store.data.skillSources;
    if (list.some((x) => x.id !== src.id && x.name.toLowerCase() === name.toLowerCase())) throw new Error('A source with this name already exists');
    const i = list.findIndex((x) => x.id === src.id);
    const prev = i >= 0 ? list[i] : null;
    if (prev && (prev.url !== src.url || prev.ref !== src.ref || prev.name !== src.name)) skillsRepo().removeSource(prev); // download again
    if (i >= 0) list[i] = { ...prev, ...src, lastSync: prev.url === src.url && prev.ref === src.ref && prev.name === src.name ? prev.lastSync : null };
    else list.push(src);
    store.save();
    return src.id;
  },
  // Downloads the skills of an APM package with the app's own Git (as a Git source) instead of APM on the target.
  apmToSkillSource: async (apmId) => {
    const apmRef = require('./coding-agents/apm');
    const e = store.data.apmLibrary.find((x) => x.id === apmId);
    if (!e) throw new Error('unknown APM package');
    const conv = apmRef.refToSource(e.ref);
    let src = store.data.skillSources.find((s) => s.fromApm === apmId || (s.url === conv.url && (s.path || '') === conv.path && (s.ref || '') === conv.ref));
    if (!src) {
      let name = conv.name;
      for (let i = 2; store.data.skillSources.some((s) => s.name.toLowerCase() === name.toLowerCase()); i++) name = `${conv.name}-${i}`;
      const id = api.skillSourceSave({ ...conv, name });
      src = store.data.skillSources.find((s) => s.id === id);
    }
    src.fromApm = apmId;
    store.save();
    const r = await api.skillSourceSync(src.id);
    return { ...r, source: src.name };
  },

  skillSourceDelete: (id) => {
    const src = store.data.skillSources.find((x) => x.id === id);
    if (src) skillsRepo().removeSource(src);
    store.data.skillSources = store.data.skillSources.filter((x) => x.id !== id);
    store.save();
  },
  skillSourceSync: async (id) => {
    const src = store.data.skillSources.find((x) => x.id === id);
    if (!src) throw new Error('unknown source');
    try {
      const r = await skillsRepo().syncSource(src);
      Object.assign(src, { lastSync: Date.now(), commit: r.commit, error: null, skillCount: r.skills.length - r.conflicts.length, conflictCount: r.conflicts.length });
      store.save();
      audit.add({ source: 'app', action: 'skills.source-sync', detail: `${src.name}: ${r.commit}` });
      return r;
    } catch (e) {
      Object.assign(src, { lastSync: Date.now(), error: e.message });
      store.save();
      throw e;
    }
  },
  // Updates the Git sources of the project's selected skills (all sources if unsure), then deploys.
  agentsUpdateSkillsAndDeploy: async (projectId) => {
    const p = store.getProject(projectId);
    const selected = new Set((p.agentSetup && p.agentSetup.skills) || []);
    const used = new Set(skillsRepo().list().filter((s) => s.source && selected.has(s.name)).map((s) => s.source));
    const sources = store.data.skillSources.filter((s) => used.has(s.name) || !s.lastSync);
    const synced = [];
    for (const src of sources) {
      try { const r = await api.skillSourceSync(src.id); synced.push({ name: src.name, commit: r.commit, ok: true }); }
      catch (e) { synced.push({ name: src.name, ok: false, error: e.message }); }
    }
    const report = await api.agentsDeploy(projectId);
    report.sources = synced;
    return report;
  },

  // Skills repository
  skillsList: () => ({ dir: skillsRepo().dir, skills: skillsRepo().list() }),
  skillsCreate: (name, description) => { const f = skillsRepo().create(name, description); shell.openPath(f); return f; },
  skillsImport: async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import skills (a skill folder or a folder of skills)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return skillsRepo().importFrom(r.filePaths[0]);
  },
  skillsOpenDir: () => { const repo = skillsRepo(); repo.ensure(); return shell.openPath(repo.dir); },
  skillsChooseDir: async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Skills repository folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    store.updateSettings({ skillsDir: r.filePaths[0] });
    return r.filePaths[0];
  },

  // Coding agents: install, detect, deploy MCP servers + skills
  agentsList: () => agentSetup().agents(),
  agentsDetect: (projectId) => agentSetup().detect(store.getProject(projectId)),
  agentsInstall: async (projectId, agentId, sessionId) => {
    const p = store.getProject(projectId);
    const { command } = agentSetup().installCommand(p, agentId);
    // Typed into a visible terminal, because installers may ask questions.
    let s = sessionId && sessions.get(sessionId);
    if (!s || s.kind !== 'terminal' || !s.pty) s = sessions.open(projectId, { name: 'install', command: '' });
    if (!s.pty) throw new Error('Could not start a terminal for the installation');
    setTimeout(() => s.send(command).catch(() => {}), s.createdAt > Date.now() - 1500 ? 1500 : 0);
    audit.add({ source: 'app', action: 'agents.install', detail: `${p.name}: ${agentId}` });
    return { sessionId: s.id, command };
  },
  agentsDeploy: async (projectId) => {
    const p = store.getProject(projectId);
    const report = await agentSetup().deploy(p);
    p.agentSetup = { ...(p.agentSetup || {}), lastDeploy: { time: report.time, ok: report.ok } };
    store.save();
    return report;
  },
};

function bridgePath() {
  const p = path.join(__dirname, '..', '..', 'dist', 'termclaw-mcp-stdio.js');
  return p.replace('app.asar', 'app.asar.unpacked');
}

ipcMain.handle('api', async (_e, method, ...args) => {
  const fn = api[method];
  if (!fn) throw new Error('Unknown API method ' + method);
  return fn(...args);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#14161b',
    title: 'TermClaw',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
  // If the renderer dies, sessions keep running in this process: log why and reload the window,
  // which restores all terminals from the main-process mirror.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[termclaw] renderer gone:', JSON.stringify(details));
    if (audit) audit.add({ source: 'app', action: 'renderer.crash', detail: JSON.stringify(details) });
    if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) setTimeout(() => { if (win && !win.isDestroyed()) win.reload(); }, 500);
  });
  win.webContents.on('unresponsive', () => console.error('[termclaw] renderer unresponsive'));
  // Links clicked in terminals open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Export configuration…', click: () => api.exportConfig() },
      { label: 'Import configuration…', click: () => api.importConfig(false) },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.vogler.termclaw');
  setup();
  buildMenu();
  createWindow();
  await mcp.start();
  win.webContents.once('did-finish-load', () => {
    if (process.env.TERMCLAW_NO_RESTORE !== '1') sessions.restoreAll();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

let quitting = false;
app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  try { orchestrators.shutdown(); } catch {}
  try { forwards.shutdown(); } catch {}
  try { hosts.stop(); } catch {}
  try { sessions.shutdown(); } catch {}
  try { mcp.stop(); } catch {}
  try { store.saveNow(); } catch {}
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

module.exports = { api };
