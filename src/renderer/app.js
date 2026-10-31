// Renderer entry: state, sidebar (project tree), project views (tabs / tiles), overview and shortcuts.
import { h, clear, toast, contextMenu, prompt, confirmDialog, timeAgo, modal } from './ui.js';
import { TermView } from './terms.js';
import { SCHEMES, schemeById } from './schemes.js';
import { renderChat, renderChatLog, renderPermission } from './chat.js';
import * as pages from './pages.js';
import * as agents from './agents.js';
import * as files from './files.js';
import * as docker from './docker.js';
import * as monitor from './monitor.js';
import * as git from './git.js';

const call = (m, ...a) => window.termclaw.call(m, ...a);

export const S = {
  config: { projects: [], hosts: [], settings: {}, orchestrators: [] },
  sessions: new Map(),
  hosts: [],
  forwards: {},
  mcp: {},
  tokens: [],
  orchestrators: [],
  templates: [],
  audit: [],
  platform: 'win32',
  view: 'project', // project | overview | hosts | orch | mcp | audit | settings
  projectId: null,
  orchId: null,
  active: {}, // projectId -> sessionId
  collapsed: new Set(),
  agentMessages: new Map(),
  agentLive: new Map(),
  agentLog: new Map(),
  orchMessages: new Map(),
  orchLive: new Map(),
};
const terms = new Map(); // sessionId -> TermView
const isMac = () => S.platform === 'darwin';

// ---------- helpers ----------
export const project = (id) => S.config.projects.find((p) => p.id === id);
export const projectSessions = (pid) => [...S.sessions.values()].filter((s) => s.projectId === pid);
const mode = (p) => (p && p.layout && p.layout.mode) || 'tabs';
// Extra tabs of a project, before its sessions. Each module has mount(ctx, el, projectId) and unmount().
const GIT_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="4.5" cy="3.2" r="1.7"/><circle cx="4.5" cy="12.8" r="1.7"/><circle cx="11.5" cy="5.2" r="1.7"/><path d="M4.5 4.9v6.2M11.5 6.9c0 3.2-7 2.2-7 4.2"/></svg>';
const EXTRAS = [
  { key: 'docker', label: 'Docker', glyph: () => '🐳', title: 'Docker containers, images and volumes', on: (p) => !!(p.docker && p.docker.enabled), mod: docker },
  { key: 'monitor', label: 'Monitor', glyph: () => '📈', title: 'CPU, memory, disk and network I/O, mounts and programs of the machine', on: (p) => !!(p.monitor && p.monitor.enabled), mod: monitor },
  { key: 'git', label: 'Git', glyph: (p) => h('span', { class: 'git-glyph' + (gitClean.get(p.id) === true ? ' clean' : ''), 'data-git-glyph': p.id, title: gitTitle(p.id), html: GIT_SVG }), title: 'Git repositories: changes, commit, push and pull, branches, history', on: (p) => !!(p.git && p.git.enabled), mod: git },
];
// Git icon: green when every repository of the project is clean, orange when there are changes (or unknown yet).
const gitClean = new Map(); // projectId -> true | false
const gitTitle = (pid) => (gitClean.get(pid) === true ? 'Git: no local changes' : gitClean.get(pid) === false ? 'Git: uncommitted changes' : 'Git');
function setGitClean(pid, clean) {
  if (gitClean.get(pid) === clean) return;
  gitClean.set(pid, clean);
  document.querySelectorAll(`[data-git-glyph="${CSS.escape(pid)}"]`).forEach((el) => { el.classList.toggle('clean', clean === true); el.title = gitTitle(pid); });
}
git.onSummary(setGitClean);
// In the background (the Git tab reports its own updates): one cached repository search per project and minute.
async function pollGitSummaries() {
  for (const p of S.config.projects) {
    if (!(p.git && p.git.enabled) || git.mountedProject() === p.id) continue;
    try { const r = await call('gitRepos', p.id, false); setGitClean(p.id, git.isClean(r.repos)); } catch { gitClean.delete(p.id); }
  }
}
const extrasOn = (p) => (p ? EXTRAS.filter((x) => x.on(p)) : []);
// The extra tab that is shown: the chosen one, or the first one when the project has no session.
function activeExtra(p) {
  const on = extrasOn(p);
  return on.find((x) => x.key === S.active[p.id]) || (!projectSessions(p.id).length ? on[0] : null) || null;
}
function showExtra(pid, key) { S.projectId = pid; S.view = 'project'; S.active[pid] = key; render(); }

function projectStatus(pid) {
  const list = projectSessions(pid);
  if (!list.length) return 'none';
  if (list.some((s) => s.status === 'error')) return 'error';
  if (list.some((s) => s.status === 'working' || s.status === 'starting')) return 'working';
  if (list.some((s) => s.status === 'waiting')) return 'waiting';
  return 'exited';
}

const STATUS_LABEL = { working: 'working', waiting: 'waiting', starting: 'starting', error: 'error', exited: 'exited', none: 'no sessions' };
const dot = (status, attrs = {}) => h('span', { class: 'dot ' + status, title: STATUS_LABEL[status] || status, ...attrs });

// Font zoom per session, kept by project and session name so it survives restarts and reopening.
const zoomKey = (id) => { const s = S.sessions.get(id); return s ? s.projectId + '/' + s.name : id; };
function loadZooms() { try { return JSON.parse(localStorage.getItem('termZoom') || '{}'); } catch { return {}; } }
function saveZoom(id, zoom) {
  const all = loadZooms();
  if (zoom) all[zoomKey(id)] = zoom; else delete all[zoomKey(id)];
  try { localStorage.setItem('termZoom', JSON.stringify(all)); } catch {}
}

// The terminal a zoom shortcut applies to: the focused one, else the active session.
function zoomTarget() {
  const el = document.activeElement && document.activeElement.closest && document.activeElement.closest('.termwrap');
  const id = el ? el.dataset.sid : S.view === 'project' ? activeSessionId() : null;
  return id && terms.get(id) && terms.get(id).el.isConnected ? terms.get(id) : null;
}

// Color scheme: the session's own choice (kept like the zoom), else the project's, else the app setting.
function loadSchemes() { try { return JSON.parse(localStorage.getItem('termScheme') || '{}'); } catch { return {}; } }
function saveScheme(id, scheme) {
  const all = loadSchemes();
  if (scheme) all[zoomKey(id)] = scheme; else delete all[zoomKey(id)];
  try { localStorage.setItem('termScheme', JSON.stringify(all)); } catch {}
}
function projectScheme(s) {
  const p = s && project(s.projectId);
  return (p && p.colorScheme) || S.config.settings.terminalScheme || 'default';
}
function schemeFor(id) { return loadSchemes()[zoomKey(id)] || projectScheme(S.sessions.get(id)); }
function applyScheme(id) { const t = terms.get(id); if (t) t.setScheme(schemeFor(id), !!S.config.settings.terminalContrast); }

// Pick a session's color scheme; a click previews it in the terminal.
function schemeDialog(s) {
  const before = loadSchemes()[zoomKey(s.id)] || '';
  let chosen = before;
  const t = termFor(s.id);
  const preview = () => t.setScheme(chosen || projectScheme(s), !!S.config.settings.terminalContrast);
  const swatch = (sc) => h('div', { class: 'scheme-sw', style: { background: sc.theme.background, color: sc.theme.foreground } },
    h('span', null, 'Aa'), ...['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'].map((c) => h('i', { style: { background: sc.theme[c] } })));
  const items = [{ id: '', name: `Project default (${schemeById(projectScheme(s)).name})`, sc: schemeById(projectScheme(s)) }, ...SCHEMES.map((sc) => ({ id: sc.id, name: sc.name, sc }))];
  const list = h('div', { class: 'scheme-list' });
  const draw = () => {
    clear(list);
    for (const it of items) list.appendChild(h('div', { class: 'scheme-item' + (it.id === chosen ? ' active' : ''), onclick: () => { chosen = it.id; preview(); draw(); } }, swatch(it.sc), h('span', null, it.name)));
  };
  draw();
  modal({
    title: `Color scheme · ${s.name}`, body: list, okText: 'Apply', width: '420px',
    onOk: () => { saveScheme(s.id, chosen); applyScheme(s.id); },
    onCancel: () => { chosen = before; preview(); },
  });
}

function termFor(id) {
  let t = terms.get(id);
  if (!t) {
    t = new TermView(id, { fontSize: S.config.settings.fontSize || 13, zoom: loadZooms()[zoomKey(id)] || 0, scheme: schemeFor(id), contrast: !!S.config.settings.terminalContrast, onZoom: saveZoom, onKey: handleShortcut, onDropFiles: (sid, paths) => files.dropOnTerminal(ctx, sid, paths), onPasteImage: (sid) => files.pasteImage(ctx, sid), isMac: isMac() });
    terms.set(id, t);
  }
  return t;
}

function activeSessionId(pid = S.projectId) {
  const list = projectSessions(pid);
  const a = S.active[pid];
  if (a && S.sessions.has(a) && S.sessions.get(a).projectId === pid) return a;
  return list.length ? list[0].id : null;
}

export function selectSession(id, { tiles = false } = {}) {
  const s = S.sessions.get(id);
  if (!s) return;
  S.projectId = s.projectId;
  S.active[s.projectId] = id;
  S.view = 'project';
  const p = project(s.projectId);
  if (p && !tiles && mode(p) !== 'tabs') setMode(p, 'tabs', false);
  call('setActive', id);
  call('setLayout', s.projectId, { active: s.name });
  render();
  focusActive();
}

function focusActive() {
  const id = activeSessionId();
  if (!id) return;
  setTimeout(() => {
    const t = terms.get(id);
    if (t && S.view === 'project') t.focus();
    const ta = document.querySelector('.chat-input textarea');
    if (ta && S.sessions.get(id) && S.sessions.get(id).kind !== 'terminal') ta.focus();
  }, 30);
}

function setMode(p, m, rerender = true) {
  p.layout = { ...(p.layout || {}), mode: m };
  call('setLayout', p.id, { mode: m });
  if (rerender) render();
}

export function showView(view, extra = {}) {
  S.view = view;
  Object.assign(S, extra);
  render();
}

export async function openSession(pid, opts = {}) {
  try {
    const info = await call('openSession', pid, opts);
    S.sessions.set(info.id, info);
    S.projectId = pid;
    S.active[pid] = info.id;
    S.view = 'project';
    render();
    focusActive();
    return info;
  } catch (e) {
    toast(e.message, { error: true });
  }
}

async function closeSession(id, killTmux = false) {
  const s = S.sessions.get(id);
  if (!s) return;
  await call('closeSession', id, killTmux);
}

// ---------- sidebar ----------
function renderSidebar() {
  const sb = clear(document.getElementById('sidebar'));
  const runningCount = S.sessions.size;
  sb.appendChild(h('div', { class: 'sb-top' },
    h('button', { class: S.view === 'overview' ? 'active' : '', title: 'Overview of all sessions (Ctrl+Shift+O)', onclick: () => showView('overview') }, '▦ Overview ', h('span', { class: 'muted' }, runningCount)),
    h('button', { title: 'New project', onclick: () => pages.editProject(ctx, null) }, '+ Project')));
  sb.appendChild(h('div', { class: 'sb-section' }, 'Projects'));

  const tree = h('div', { class: 'tree' });
  S.config.projects.forEach((p, idx) => {
    const list = projectSessions(p.id);
    const collapsed = S.collapsed.has(p.id);
    const selected = S.view === 'project' && S.projectId === p.id;
    const host = p.hostId ? S.config.hosts.find((x) => x.id === p.hostId) : null;
    const head = h('div', {
      class: 'proj-head',
      ...dragProps({ type: 'project', id: p.id }),
      title: `${p.type.toUpperCase()}${host ? ' · ' + host.name : p.host ? ' · ' + p.host : ''}${p.directory ? ' · ' + p.directory : ''}  (Ctrl+${idx + 1})`,
      onclick: () => { S.projectId = p.id; S.view = 'project'; render(); focusActive(); },
      oncontextmenu: (e) => { e.preventDefault(); projectMenu(e, p); },
    },
    h('span', { class: 'caret', onclick: (e) => { e.stopPropagation(); collapsed ? S.collapsed.delete(p.id) : S.collapsed.add(p.id); renderSidebar(); } }, list.length || extrasOn(p).length ? (collapsed ? '▸' : '▾') : ''),
    dot(projectStatus(p.id), { 'data-pdot': p.id }),
    h('span', { class: 'proj-name' }, p.name),
    h('span', { class: 'proj-type' }, p.type === 'ssh' ? (host ? host.name : 'ssh') : p.type),
    h('span', { class: 'proj-actions' },
      h('button', { class: 'icon', title: 'New session (default)', onclick: (e) => { e.stopPropagation(); openSession(p.id); } }, '+'),
      h('button', { class: 'icon', title: 'Tile view', onclick: (e) => { e.stopPropagation(); S.projectId = p.id; S.view = 'project'; setMode(p, mode(p) === 'tiles' ? 'tabs' : 'tiles'); } }, '▦'),
      h('button', { class: 'icon', title: 'Edit project', onclick: (e) => { e.stopPropagation(); pages.editProject(ctx, p); } }, '⚙')));
    const node = h('div', { class: 'proj' + (selected ? ' selected' : '') }, head);
    if (!collapsed) {
      const ax = selected ? activeExtra(p) : null;
      for (const x of extrasOn(p)) {
        node.appendChild(h('div', { class: 'sess dk-sess' + (ax === x ? ' active' : ''), title: x.title, onclick: () => showExtra(p.id, x.key) },
          h('span', { class: 'dk-sess-icon' }, x.glyph(p)), h('span', { class: 'sess-name' }, x.label)));
      }
      for (const s of list) {
        const isActive = selected && activeSessionId(p.id) === s.id;
        node.appendChild(h('div', {
          class: 'sess' + (isActive ? ' active' : ''),
          ...dragProps({ type: 'session', id: s.id, projectId: p.id }),
          title: `${s.name} — ${STATUS_LABEL[s.status] || s.status}${s.command ? ' — ' + s.command : ''}`,
          onclick: () => selectSession(s.id),
          ondblclick: () => renameSession(s.id),
          oncontextmenu: (e) => { e.preventDefault(); sessionMenu(e, s); },
        },
        dot(s.status, { 'data-dot': s.id }),
        h('span', { class: 'sess-name' }, s.name),
        s.shell ? h('span', { class: 'badge', title: 'Local shell: ' + s.shell.label + (s.shell.dir ? ' · ' + s.shell.dir : '') }, 'local') : null,
        s.kind !== 'terminal' ? h('span', { class: 'badge', title: s.kind === 'acp' ? (s.agentName || '') + ' via ACP' : 'OpenCode server API' }, s.kind === 'acp' ? 'acp' : 'agent') : null,
        s.orchestrator ? h('span', { class: 'badge', title: 'Orchestrator-Session' }, 'orch') : null,
        !s.shared ? h('span', { class: 'badge', title: 'Not shared with MCP' }, 'private') : null));
      }
    }
    tree.appendChild(node);
  });
  if (!S.config.projects.length) {
    tree.appendChild(h('div', { style: { padding: '12px', color: 'var(--fg3)' } }, 'No projects yet. Create one with “+ Project”.'));
  }
  sb.appendChild(tree);

  const orchRunning = S.orchestrators.filter((o) => o.state !== 'stopped').length;
  const navBtn = (view, label, count, countClass) => h('button', { class: S.view === view ? 'active' : '', onclick: () => showView(view) }, label, count !== undefined ? h('span', { class: 'count' + (countClass ? ' ' + countClass : '') }, count) : null);
  sb.appendChild(h('div', { class: 'sb-bottom' },
    navBtn('hosts', 'Hosts', S.config.hosts.length),
    navBtn('orch', 'Orchestrators', orchRunning || undefined),
    navBtn('mcp', 'MCP', S.mcp.running ? '●' : '○', S.mcp.running ? 'running' : ''),
    navBtn('audit', 'Audit log'),
    navBtn('library', 'Library', (S.config.mcpLibrary || []).length || undefined),
    navBtn('settings', 'Settings'),
    h('div', { class: 'sb-version', title: 'Version and data folder: Settings', onclick: () => showView('settings') }, `TermClaw ${S.version ? 'v' + S.version : ''}`)));
}

// Drag & drop in the sidebar: projects among projects, sessions within their project.
// The drop target shows a line above or below itself; dropping moves the item there.
let drag = null;
function dragProps(item) {
  const accepts = () => drag && drag.type === item.type && drag.id !== item.id && (item.type === 'project' || drag.projectId === item.projectId);
  const clearMarks = () => document.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  const below = (e) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  return {
    draggable: 'true',
    ondragstart: (e) => { drag = item; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id); e.currentTarget.classList.add('dragging'); e.stopPropagation(); },
    ondragend: (e) => { drag = null; e.currentTarget.classList.remove('dragging'); clearMarks(); },
    ondragover: (e) => {
      if (!accepts()) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      clearMarks();
      e.currentTarget.classList.add(below(e) ? 'drop-after' : 'drop-before');
    },
    ondragleave: (e) => e.currentTarget.classList.remove('drop-before', 'drop-after'),
    ondrop: (e) => {
      if (!accepts()) return;
      e.preventDefault();
      e.stopPropagation();
      const after = below(e);
      clearMarks();
      const src = drag;
      drag = null;
      if (src.type === 'project') {
        const ids = S.config.projects.map((x) => x.id).filter((x) => x !== src.id);
        const i = ids.indexOf(item.id);
        call('moveProjectTo', src.id, after ? ids[i + 1] || null : item.id);
      } else {
        const ids = projectSessions(item.projectId).map((x) => x.id).filter((x) => x !== src.id);
        const i = ids.indexOf(item.id);
        call('moveSessionTo', src.id, after ? ids[i + 1] || null : item.id);
      }
    },
  };
}

function projectMenu(e, p) {
  contextMenu(e.clientX, e.clientY, [
    { label: 'New session', action: () => openSession(p.id) },
    { label: 'New agent session (OpenCode server)', action: () => openSession(p.id, { kind: 'agent', name: 'agent', command: '' }) },
    { label: 'New ACP agent: OpenCode', action: () => openSession(p.id, { kind: 'acp', acpAgent: 'opencode', name: 'opencode', command: '' }) },
    { label: 'New ACP agent: GitHub Copilot', action: () => openSession(p.id, { kind: 'acp', acpAgent: 'copilot', name: 'copilot', command: '' }) },
    { label: 'Start all terminals', action: () => startAll(p.id) },
    { label: 'Browse files…', action: () => files.openBrowser(ctx, p.id) },
    ...extrasOn(p).map((x) => ({ label: x.label, action: () => showExtra(p.id, x.key) })),
    '-',
    { label: 'Tile view', action: () => { S.projectId = p.id; S.view = 'project'; setMode(p, 'tiles'); } },
    { label: 'Edit…', action: () => pages.editProject(ctx, p) },
    { label: 'Move up', action: () => call('moveProject', p.id, -1) },
    { label: 'Move down', action: () => call('moveProject', p.id, 1) },
    '-',
    { label: 'Delete…', action: async () => {
      if (await confirmDialog('Delete project', `Delete project “${p.name}”? Running sessions will be closed.`, 'Delete')) call('deleteProject', p.id);
    } },
  ]);
}

function sessionMenu(e, s) {
  contextMenu(e.clientX, e.clientY, [
    { label: 'Rename…', action: () => renameSession(s.id) },
    { label: 'Move up', action: () => call('moveSession', s.id, -1) },
    { label: 'Move down', action: () => call('moveSession', s.id, 1) },
    { label: s.shared ? '✓ Shared with MCP' : 'Share with MCP', action: () => call('setSessionFlags', s.id, { shared: !s.shared }) },
    { label: s.orchestrator ? '✓ Orchestrator session' : 'Mark as orchestrator', action: () => call('setSessionFlags', s.id, { orchestrator: !s.orchestrator }) },
    { label: 'Reconnect', action: () => call('reconnect', s.id) },
    { label: 'Browse files…', action: () => browseFrom(s) },
    ...(s.kind === 'terminal' ? ['-',
      { label: 'Larger font  (Ctrl +)', action: () => termFor(s.id).zoomBy(1) },
      { label: 'Smaller font  (Ctrl −)', action: () => termFor(s.id).zoomBy(-1) },
      { label: 'Reset font size  (Ctrl 0)', action: () => termFor(s.id).zoomBy(0) },
      { label: 'Color scheme…', action: () => schemeDialog(s) }] : []),
    '-',
    { label: 'Close (tmux keeps running)', action: () => closeSession(s.id, false) },
    { label: 'Close and kill tmux session', action: () => closeSession(s.id, true) },
  ]);
}

// File browser in the shell's current directory (terminals) or the project folder.
async function browseFrom(s) {
  let dir = '';
  if (s.kind === 'terminal') dir = await call('filesDropTarget', s.id).then((t) => t.dir).catch(() => '');
  files.openBrowser(ctx, s.projectId, dir);
}

// Structured agent sessions: OpenCode server API or any agent via ACP.
// Session ▾: the default session, the project's local shell and every shell found on this computer.
async function sessionTypeMenu(e, p) {
  const r = e.currentTarget.getBoundingClientRect();
  if (!S.localShells) S.localShells = await call('localShells').catch(() => []);
  const ls = p.localShell || {};
  const label = (id) => (S.localShells.find((x) => x.id === id) || { label: id }).label;
  contextMenu(r.left, r.bottom + 2, [
    { label: `Default session (${p.type === 'local' ? 'local' : p.type.toUpperCase()}${p.directory ? ' · ' + p.directory : ''})`, action: () => openSession(p.id) },
    ...(ls.shell ? [{ label: `Local: ${label(ls.shell)}${ls.directory ? ' · ' + ls.directory : ''}`, action: () => openSession(p.id, { shell: { id: ls.shell, dir: ls.directory || '' } }) }] : []),
    '-',
    ...S.localShells.map((x) => ({ label: x.label, action: () => openSession(p.id, { shell: { id: x.id } }) })),
    '-',
    { label: 'Configure local shell…', action: () => pages.editProject(ctx, p) },
  ]);
}

function agentMenu(e, p) {
  const r = e.currentTarget.getBoundingClientRect();
  contextMenu(r.left, r.bottom + 2, [
    { label: 'OpenCode (server API)', action: () => openSession(p.id, { kind: 'agent', name: 'agent', command: '' }) },
    '-',
    { label: 'OpenCode via ACP', action: () => openSession(p.id, { kind: 'acp', acpAgent: 'opencode', name: 'opencode', command: '' }) },
    { label: 'GitHub Copilot via ACP', action: () => openSession(p.id, { kind: 'acp', acpAgent: 'copilot', name: 'copilot', command: '' }) },
    ...(p.acpCommands && p.acpCommands.custom ? [{ label: `Other ACP agent: ${p.acpCommands.custom}`, action: () => openSession(p.id, { kind: 'acp', acpAgent: 'custom', name: 'acp-agent', command: '' }) }] : []),
    { label: 'Configure agent commands…', action: () => pages.editProject(ctx, p) },
  ]);
}

async function renameSession(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  const name = await prompt('Rename session', s.name);
  if (name) call('renameSession', id, name);
}

async function startAll(pid) {
  const list = await call('startAll', pid);
  for (const info of list) S.sessions.set(info.id, info);
  S.projectId = pid;
  S.view = 'project';
  render();
}

// ---------- main area ----------
let extraShown = null;
function renderMain() {
  // Re-rendering moves the terminal element, which drops its focus: give it back.
  const a = document.activeElement;
  const focused = a && a.closest('.xterm') && a.closest('[data-sid]');
  extraShown = null;
  renderMainView();
  for (const x of EXTRAS) if (x.key !== extraShown) x.mod.unmount();
  const t = focused && terms.get(focused.dataset.sid);
  if (t && t.el.isConnected) t.focus();
}

function renderMainView() {
  const main = clear(document.getElementById('main'));
  if (S.view === 'overview') return renderOverview(main);
  if (S.view === 'hosts') return pages.renderHosts(ctx, main);
  if (S.view === 'orch') return pages.renderOrchestrators(ctx, main);
  if (S.view === 'mcp') return pages.renderMcp(ctx, main);
  if (S.view === 'audit') return pages.renderAudit(ctx, main);
  if (S.view === 'settings') return pages.renderSettings(ctx, main);
  if (S.view === 'library') return agents.renderLibrary(ctx, main);
  renderProject(main);
}

function forwardInfo(p) {
  const f = S.forwards[p.id];
  if (!(p.forwards || []).length) return null;
  const list = p.forwards.map((x) => `${x.local}→${x.remote}`).join(', ');
  if (!f) return h('span', { class: 'muted', title: 'Active while a session is running' }, '⇄ ' + list);
  const cls = f.status === 'active' ? 'ok' : f.status === 'error' ? 'bad' : 'warn';
  return h('span', { class: cls, title: f.error || f.status }, '⇄ ' + list + (f.status === 'error' ? ' (error)' : ''));
}

function renderProject(main) {
  let p = project(S.projectId);
  if (!p && S.config.projects.length) { p = S.config.projects[0]; S.projectId = p.id; }
  if (!p) {
    main.appendChild(h('div', { class: 'content' }, h('div', { class: 'empty' },
      h('div', { style: { fontSize: '18px', color: 'var(--fg2)' } }, 'TermClaw'),
      h('div', null, 'Create a project to open terminals.'),
      h('button', { class: 'primary', onclick: () => pages.editProject(ctx, null) }, '+ Create project'))));
    return;
  }
  const list = projectSessions(p.id);
  const host = p.hostId ? S.config.hosts.find((x) => x.id === p.hostId) : null;
  const m = mode(p);
  const ax = activeExtra(p);
  main.appendChild(h('div', { class: 'main-head' },
    dot(projectStatus(p.id), { 'data-pdot': p.id }),
    h('span', { class: 'title' }, p.name),
    h('span', { class: 'muted' }, [p.type.toUpperCase(), host ? `${host.user ? host.user + '@' : ''}${host.hostname}` : p.host, p.wslDistro, p.directory, p.tmux ? 'tmux' : null].filter(Boolean).join(' · ')),
    forwardInfo(p),
    h('div', { class: 'spacer' }),
    h('span', { class: 'split-btn' },
      h('button', { onclick: () => openSession(p.id), title: 'New session with the default configuration (Ctrl+Shift+T)' }, '+ Session'),
      h('button', { onclick: (e) => sessionTypeMenu(e, p), title: 'Local shells on this computer and the project’s local shell' }, '▾')),
    h('button', { onclick: (e) => agentMenu(e, p), title: 'Start a structured agent session (chat view)' }, '+ Agent ▾'),
    (p.terminals || []).length ? h('button', { onclick: () => startAll(p.id), title: 'Start all configured terminals' }, '▶ All') : null,
    h('button', { class: m === 'tabs' ? 'active' : '', onclick: () => setMode(p, 'tabs') }, 'Tabs'),
    h('button', { class: m === 'tiles' ? 'active' : '', onclick: () => setMode(p, 'tiles'), title: 'Tile view (Ctrl+Shift+G)' }, 'Tiles'),
    h('button', { title: 'Browse files on the project machine, upload and download (or drop files onto a terminal)', onclick: () => { const sid = activeSessionId(p.id); const s = sid && S.sessions.get(sid); s ? browseFrom(s) : files.openBrowser(ctx, p.id); } }, 'Files'),
    extrasOn(p).map((x) => h('button', { class: ax === x ? 'active' : '', title: x.title, onclick: () => (ax === x && list.length ? selectSession(activeSessionId(p.id)) : showExtra(p.id, x.key)) }, x.label)),
    h('button', { title: 'Install coding agents, deploy MCP servers and skills', onclick: (e) => agents.agentsMenu(ctx, e, p, activeSessionId(p.id)) }, 'Agents ▾'),
    h('button', { class: 'icon', title: 'Edit project', onclick: () => pages.editProject(ctx, p) }, '⚙')));

  if ((p.commands || []).length) {
    const aid = activeSessionId(p.id);
    main.appendChild(h('div', { class: 'cmdbar' },
      h('span', { class: 'muted' }, 'Commands:'),
      p.commands.map((c) => h('button', {
        title: `${c.command}\n→ run in the active session`,
        disabled: !aid,
        onclick: () => { const id = activeSessionId(p.id); if (id) { call('runCommand', id, c.command); focusActive(); } },
      }, c.name))));
  }

  if (!list.length && !extrasOn(p).length) {
    main.appendChild(h('div', { class: 'content' }, h('div', { class: 'empty' },
      h('div', null, 'No running sessions in this project.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => openSession(p.id) }, '+ Open session'),
        (p.terminals || []).length ? h('button', { onclick: () => startAll(p.id) }, `▶ Start ${p.terminals.length} terminals`) : null))));
    return;
  }

  if (m === 'tiles' && list.length > 1 && !ax) return renderTiles(main, p, list);

  const aid = ax ? null : activeSessionId(p.id);
  main.appendChild(h('div', { class: 'tabs' },
    extrasOn(p).map((x) => h('div', { class: 'tab dk-tab' + (ax === x ? ' active' : ''), title: x.title, onclick: () => showExtra(p.id, x.key) }, h('span', { style: { fontSize: '12px' } }, x.glyph(p)), x.label)),
    list.map((s) => h('div', {
    class: 'tab' + (s.id === aid ? ' active' : ''),
    onclick: () => selectSession(s.id),
    ondblclick: () => renameSession(s.id),
    onauxclick: (e) => { if (e.button === 1) closeSession(s.id); },
    oncontextmenu: (e) => { e.preventDefault(); sessionMenu(e, s); },
    title: s.shell ? `Local shell: ${s.shell.label}${s.shell.dir ? ' · ' + s.shell.dir : ''}` : null,
  }, dot(s.status, { 'data-dot': s.id }), s.shell ? h('span', { class: 'local-tag', title: 'Local shell on this computer' }, '⌂') : null, s.name, h('span', { class: 'x', title: 'Close', onclick: (e) => { e.stopPropagation(); closeSession(s.id); } }, '×')))));
  const content = h('div', { class: 'content' });
  main.appendChild(content);
  if (ax) { extraShown = ax.key; ax.mod.mount(ctx, content, p.id); return; }
  mountSession(content, S.sessions.get(aid), { fontSize: S.config.settings.fontSize || 13 });
}

// Place a session's view (terminal or agent chat) into a container.
function mountSession(container, s, { fontSize, compact = false } = {}) {
  const box = h('div', { class: 'single' });
  container.appendChild(box);
  if (s.kind !== 'terminal') {
    renderChat(ctx, box, s, { compact });
    return;
  }
  const t = termFor(s.id);
  t.setFontSize(fontSize);
  applyScheme(s.id);
  t.attach(box);
  if (!compact && (s.status === 'error') && s.error) {
    box.appendChild(h('div', { class: 'overlay-err' },
      h('div', { class: 'msg' }, s.error),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => call('reconnect', s.id) }, 'Reconnect'),
        h('button', { onclick: () => closeSession(s.id) }, 'Close'))));
  }
}

// Grid layout by count: 2 = side by side, 3 = three columns (or one big + two small), 4 = 2×2, more = fitting grid.
function gridStyle(n, three) {
  if (n === 3 && three === 'big') return { cols: '2fr 1fr', rows: '1fr 1fr', big: true };
  if (n <= 3) return { cols: `repeat(${n}, 1fr)`, rows: '1fr' };
  if (n === 4) return { cols: 'repeat(2, 1fr)', rows: 'repeat(2, 1fr)' };
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return { cols: `repeat(${cols}, 1fr)`, rows: `repeat(${rows}, 1fr)` };
}

function renderTiles(main, p, list) {
  const g = gridStyle(list.length, p.layout.three);
  const content = h('div', { class: 'content' });
  main.appendChild(content);
  const grid = h('div', { class: 'grid', style: { gridTemplateColumns: g.cols, gridTemplateRows: g.rows } });
  content.appendChild(grid);
  const fs = Math.max(9, (S.config.settings.fontSize || 13) - (list.length > 4 ? 2 : list.length > 2 ? 1 : 0));
  const aid = activeSessionId(p.id);
  list.forEach((s, i) => {
    const body = h('div', { class: 'tile-body' });
    const tile = h('div', { class: 'tile' + (s.id === aid ? ' focused' : ''), style: g.big && i === 0 ? { gridRow: '1 / 3' } : null },
      h('div', { class: 'tile-head', title: 'Click: single view', onclick: () => selectSession(s.id), oncontextmenu: (e) => { e.preventDefault(); sessionMenu(e, s); } },
        dot(s.status, { 'data-dot': s.id }), h('span', null, s.name), s.kind !== 'terminal' ? h('span', { class: 'tag' }, s.kind === 'acp' ? 'acp' : 'agent') : null,
        h('span', { class: 'spacer' }), h('span', { class: 'muted' }, '⤢')),
      body);
    tile.addEventListener('mousedown', () => {
      S.active[p.id] = s.id;
      call('setActive', s.id);
      grid.querySelectorAll('.tile').forEach((t) => t.classList.toggle('focused', t === tile));
    });
    grid.appendChild(tile);
    mountSession(body, s, { fontSize: fs, compact: true });
  });
  if (list.length === 3) {
    const head = main.querySelector('.main-head');
    head.insertBefore(h('button', { title: 'Layout for 3 sessions', onclick: () => { p.layout.three = p.layout.three === 'big' ? 'cols' : 'big'; call('setLayout', p.id, { three: p.layout.three }); render(); } }, p.layout.three === 'big' ? '1+2' : '3 columns'), head.querySelector('.spacer').nextSibling);
  }
}

// Overview of all running sessions, grouped per project. Scaling uses smaller xterm font sizes, not CSS zoom.
function renderOverview(main) {
  const groups = S.config.projects.map((p) => ({ p, list: projectSessions(p.id) })).filter((g) => g.list.length);
  const total = groups.reduce((a, g) => a + g.list.length, 0);
  main.appendChild(h('div', { class: 'main-head' },
    h('span', { class: 'title' }, 'Overview'),
    h('span', { class: 'muted' }, `${total} sessions in ${groups.length} projects · click a tile to open it`),
    h('div', { class: 'spacer' }),
    h('span', { class: 'muted', title: 'Small tiles have fewer rows and columns; programs receive the new size and may re-wrap.' }, 'ⓘ Size')));
  const content = h('div', { class: 'content' });
  main.appendChild(content);
  if (!total) {
    content.appendChild(h('div', { class: 'empty' }, 'No running sessions.'));
    return;
  }
  const auto = total <= 2 ? 12 : total <= 4 ? 11 : total <= 9 ? 9 : total <= 16 ? 8 : 7;
  const fs = S.config.settings.overviewFontSize || auto;
  const wrap = h('div', { class: 'overview' });
  content.appendChild(wrap);
  // Pick the column count that gives the largest terminal-shaped cells (wider than tall).
  const W = (content.clientWidth || 1000) - 16;
  const H = (content.clientHeight || 700) - 16;
  let perRow = 1;
  let best = 0;
  for (let c = 1; c <= total; c++) {
    const rowsAll = groups.reduce((acc, g) => acc + Math.ceil(g.list.length / c), 0);
    const r = Math.min(rowsAll, Math.ceil(total / c) + groups.length - 1);
    const score = Math.min(W / c, ((H - groups.length * 34) / r) * 1.8);
    if (score > best) { best = score; perRow = c; }
  }
  const cellW = W / perRow;
  const rowsUsed = Math.min(groups.reduce((acc, g) => acc + Math.ceil(g.list.length / perRow), 0), Math.ceil(total / perRow) + groups.length - 1);
  const groupRowH = Math.max(150, Math.floor((H - groups.length * 38) / Math.max(1, rowsUsed)));
  for (const { p, list } of groups) {
    const cols = Math.min(list.length, perRow);
    const rows = Math.ceil(list.length / cols);
    const grid = h('div', { class: 'ov-grid', style: { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, ${groupRowH}px)` } });
    const group = h('div', { class: 'ov-group', style: { flex: `${cols} 1 ${cols * cellW - 20}px` } },
      h('div', { class: 'ov-head', onclick: () => { S.projectId = p.id; S.view = 'project'; setMode(p, 'tiles'); } },
        dot(projectStatus(p.id), { 'data-pdot': p.id }), p.name, h('span', { class: 'muted', style: { fontWeight: 400 } }, `(${list.length})`)),
      grid);
    wrap.appendChild(group);
    for (const s of list) {
      const body = h('div', { class: 'tile-body' });
      const tile = h('div', { class: 'tile' },
        h('div', { class: 'tile-head' }, dot(s.status, { 'data-dot': s.id }), s.name, h('span', { class: 'spacer' }), h('span', { class: 'muted' }, timeAgo(s.lastOutputAt))),
        body,
        h('div', { class: 'tile-click', title: `Open ${p.name} / ${s.name}`, onclick: () => selectSession(s.id) }));
      grid.appendChild(tile);
      mountSession(body, s, { fontSize: fs, compact: true });
    }
  }
}

// ---------- status updates without full re-render ----------
function updateDots() {
  document.querySelectorAll('[data-dot]').forEach((el) => {
    const s = S.sessions.get(el.dataset.dot);
    if (s) { el.className = 'dot ' + s.status; el.title = STATUS_LABEL[s.status] || s.status; }
  });
  document.querySelectorAll('[data-pdot]').forEach((el) => {
    const st = projectStatus(el.dataset.pdot);
    el.className = 'dot ' + st;
    el.title = STATUS_LABEL[st];
  });
}

export function render() {
  renderSidebar();
  renderMain();
}

let renderTimer = null;
export function renderSoon() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 30);
}

// ---------- shortcuts ----------
function handleShortcut(e) {
  const mod = isMac() ? e.metaKey : e.ctrlKey;
  if (!mod) return false;
  const p = project(S.projectId);
  // Font size of the terminal: Ctrl + / Ctrl - / Ctrl 0 (main keyboard or numpad, any layout).
  if (!e.altKey) {
    const z = e.key === '+' || e.key === '=' || e.code === 'NumpadAdd' ? 1
      : e.key === '-' || e.code === 'NumpadSubtract' ? -1
      : (e.code === 'Digit0' || e.code === 'Numpad0') && !e.shiftKey ? 0 : null;
    if (z !== null) { const t = zoomTarget(); if (t) { t.zoomBy(z); return true; } }
  }
  if (e.shiftKey && e.code === 'KeyT') { if (p) openSession(p.id); return true; }
  if (e.shiftKey && e.code === 'KeyG') { if (p) { S.view = 'project'; setMode(p, mode(p) === 'tiles' ? 'tabs' : 'tiles'); } return true; }
  if (e.shiftKey && e.code === 'KeyO') { showView(S.view === 'overview' ? 'project' : 'overview'); return true; }
  if (e.shiftKey && e.code === 'KeyW') { const id = activeSessionId(); if (id) closeSession(id); return true; }
  if (e.code === 'Tab') {
    const list = p ? projectSessions(p.id) : [];
    if (list.length) {
      const i = list.findIndex((s) => s.id === activeSessionId());
      const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
      selectSession(next.id, { tiles: mode(p) === 'tiles' });
    }
    return true;
  }
  if (!e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
    const pr = S.config.projects[Number(e.code.slice(5)) - 1];
    if (pr) { S.projectId = pr.id; S.view = 'project'; render(); focusActive(); }
    return true;
  }
  return false;
}

document.addEventListener('keydown', (e) => {
  if (document.getElementById('modal-root').children.length) return;
  if (handleShortcut(e)) { e.preventDefault(); e.stopPropagation(); }
}, true);

// Sidebar resize
(() => {
  const sp = document.getElementById('splitter');
  const sb = document.getElementById('sidebar');
  try { const w = localStorage.getItem('sbw'); if (w) sb.style.width = w + 'px'; } catch {}
  sp.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => { sb.style.width = Math.max(180, Math.min(600, ev.clientX)) + 'px'; };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      try { localStorage.setItem('sbw', parseInt(sb.style.width, 10)); } catch {}
      for (const t of terms.values()) t.scheduleFit();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
})();

// ---------- events from main ----------
const on = window.termclaw.on;
on('session:data', ({ id, data }) => { termFor(id).write(data); });
on('session:opened', (info) => { S.sessions.set(info.id, info); renderSoon(); });
on('sessions:reordered', ({ projectId, ids }) => {
  // Rebuild the local session order: the project's sessions in the new order, others unchanged.
  const all = [...S.sessions.values()];
  const moved = ids.map((id) => S.sessions.get(id)).filter(Boolean);
  let k = 0;
  S.sessions = new Map(all.map((s) => (s.projectId === projectId ? moved[k++] : s)).filter(Boolean).map((s) => [s.id, s]));
  renderSoon();
});
on('session:closed', ({ id }) => {
  S.sessions.delete(id);
  const t = terms.get(id);
  if (t) { t.dispose(); terms.delete(id); }
  renderSoon();
});
on('session:updated', (info) => {
  const prev = S.sessions.get(info.id);
  S.sessions.set(info.id, info);
  if (info.kind !== 'terminal') { pages.refreshChatStatus(ctx, info.id); renderPermission(ctx, info.id); }
  if (!prev || prev.name !== info.name || prev.shared !== info.shared || prev.orchestrator !== info.orchestrator || prev.error !== info.error || (prev.status !== info.status && (prev.status === 'error' || info.status === 'error'))) renderSoon();
  else updateDots(); // plain status changes only recolor the dots, so clicks and double-clicks are not lost to a re-render
});
on('session:status', ({ id, status, lastOutputAt }) => {
  const s = S.sessions.get(id);
  if (!s) return;
  const wasError = s.status === 'error';
  s.status = status;
  s.lastOutputAt = lastOutputAt;
  if (status === 'error' || wasError) { call('getState').then((st) => { for (const i of st.sessions) S.sessions.set(i.id, i); renderSoon(); }); }
  updateDots();
  if (s.kind !== 'terminal') pages.refreshChatStatus(ctx, id);
});
on('agent:messages', ({ id, messages }) => { S.agentMessages.set(id, messages); S.agentLive.delete(id); renderChatLog(ctx, id); });
on('agent:live', ({ id, text }) => { S.agentLive.set(id, text); renderChatLog(ctx, id); });
on('agent:permission', ({ id, permission }) => { const s = S.sessions.get(id); if (s) s.permission = permission; renderPermission(ctx, id); });
on('agent:log', ({ id, line }) => { const l = S.agentLog.get(id) || []; l.push(line); S.agentLog.set(id, l.slice(-50)); });
on('hosts:status', (snap) => { S.hosts = snap; if (S.view === 'hosts') pages.renderHostsTable(ctx); });
on('forwards:status', (snap) => { S.forwards = snap; if (S.view === 'project') renderSoon(); });
on('audit:entry', (e) => { S.audit.push(e); if (S.audit.length > 1000) S.audit.shift(); if (S.view === 'audit') pages.appendAudit(ctx, e); });
on('mcp:status', (st) => { S.mcp = st; renderSoon(); });
on('oauth:request', (r) => pages.oauthApproval(ctx, r));
on('oauth:decided', ({ id }) => pages.oauthDecided(ctx, id));
on('config:changed', (cfg) => {
  const structural = JSON.stringify(cfg.projects.map((p) => [p.id, p.name, p.type, p.commands, p.forwards, p.layout, p.terminals, p.hostId, p.directory, p.docker, p.monitor, p.git])) + JSON.stringify(cfg.hosts) !==
    JSON.stringify(S.config.projects.map((p) => [p.id, p.name, p.type, p.commands, p.forwards, p.layout, p.terminals, p.hostId, p.directory, p.docker, p.monitor, p.git])) + JSON.stringify(S.config.hosts);
  S.config = cfg;
  if (structural && !['settings', 'orch', 'mcp'].includes(S.view)) renderSoon();
});
on('orch:list', (list) => { S.orchestrators = list; pages.onOrchestratorsChanged(ctx); renderSidebar(); });
on('orch:messages', ({ id, messages }) => { S.orchMessages.set(id, messages); S.orchLive.delete(id); pages.onOrchMessages(ctx, id); });
on('orch:live', ({ id, text }) => { S.orchLive.set(id, text); pages.onOrchMessages(ctx, id); });
on('focus-session', ({ id }) => selectSession(id));

// A file dropped anywhere else must not make the window navigate to it.
for (const ev of ['dragover', 'drop']) document.addEventListener(ev, (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });

export const ctx = { S, call, render, renderSoon, showView, openSession, selectSession, project, projectSessions, terms, dot, STATUS_LABEL, closeSession, editProject: (p) => pages.editProject(ctx, p) };

// ---------- boot ----------
(async () => {
  const st = await call('getState');
  S.config = st.config;
  S.platform = st.platform;
  call('localShells').then((l) => { S.localShells = l; }).catch(() => {});
  setTimeout(pollGitSummaries, 2000);
  setInterval(pollGitSummaries, 60000);
  S.hosts = st.hosts;
  S.forwards = st.forwards;
  S.mcp = st.mcp;
  S.tokens = st.tokens;
  S.orchestrators = st.orchestrators;
  S.templates = st.templates;
  S.version = st.version;
  document.title = `TermClaw ${st.version}`;
  S.dataDir = st.dataDir;
  S.stdioBridge = st.stdioBridge;
  S.audit = await call('auditList');
  for (const r of await call('oauthPending')) pages.oauthApproval(ctx, r);
  for (const info of st.sessions) {
    S.sessions.set(info.id, info);
    if (info.kind === 'terminal') {
      // After a renderer reload, restore screen content from the main-process mirror.
      const data = await call('serialize', info.id);
      if (data) termFor(info.id).write(data);
    } else {
      call('agentMessages', info.id).then((m) => { S.agentMessages.set(info.id, m || []); renderChatLog(ctx, info.id); });
    }
  }
  // Restore the active session per project from the saved layout.
  for (const p of S.config.projects) {
    const name = p.layout && p.layout.active;
    const s = name && [...S.sessions.values()].find((x) => x.projectId === p.id && x.name === name);
    if (s) S.active[p.id] = s.id;
  }
  S.projectId = (S.config.projects[0] || {}).id || null;
  render();
  window.__termclaw = { S, ctx, terms }; // for tests and debugging
})();
