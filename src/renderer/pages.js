// Editors and secondary pages: project editor, hosts, orchestrators, MCP tokens, audit log, settings.
import { h, clear, toast, modal, field, confirmDialog, fmtTime, timeAgo } from './ui.js';
import { renderMessages, fillStatus } from './chat.js';
import { projectSetupSection } from './agents.js';

// Editable list of rows (terminals, saved commands, port forwards).
function rowsEditor(items, cols) {
  const wrap = h('div', { class: 'rows' });
  const list = h('div');
  const addRow = (it = {}) => {
    const inputs = cols.map((c) => c.options
      ? h('select', { 'data-k': c.key, style: { flex: '0 0 110px' } }, c.options.map(([v, l]) => h('option', { value: v, selected: (it[c.key] || c.options[0][0]) === v }, l)))
      : h('input', { 'data-k': c.key, placeholder: c.placeholder, value: it[c.key] ?? '', class: c.small ? 'small' : '', type: c.type || 'text' }));
    const r = h('div', { class: 'r' }, inputs, h('button', { class: 'icon', title: 'Remove', onclick: () => r.remove() }, '✕'));
    list.appendChild(r);
  };
  (items || []).forEach(addRow);
  wrap.append(list, h('button', { onclick: () => addRow() }, '+ Add'));
  return {
    el: wrap,
    get: () => [...list.children].map((r) => {
      const o = {};
      r.querySelectorAll('[data-k]').forEach((i) => { o[i.dataset.k] = i.type === 'number' ? Number(i.value) || '' : i.value.trim(); });
      return o;
    }).filter((o) => Object.entries(o).some(([k, v]) => v !== '' && !(cols.find((c) => c.key === k) || {}).options)),
  };
}

export async function editProject(ctx, p) {
  const { S, call } = ctx;
  const [agentsList, skillsInfo] = await Promise.all([call('agentsList'), call('skillsList').catch(() => ({ skills: [] }))]);
  const isNew = !p;
  p = p ? structuredClone(p) : { type: 'local', tmux: S.platform !== 'win32', keepAlive: true, defaultSession: { name: 'shell', command: '', kind: 'terminal' }, terminals: [], commands: [], forwards: [], port: 22 };
  const I = (k, attrs = {}) => h('input', { value: p[k] ?? '', ...attrs });
  const name = I('name', { placeholder: 'e.g. backend' });
  const type = h('select', null, [['local', 'Local'], ['ssh', 'SSH'], ['wsl', 'WSL']].map(([v, l]) => h('option', { value: v, selected: p.type === v }, l)));
  const hostSel = h('select', null, h('option', { value: '' }, '— custom connection —'), S.config.hosts.map((x) => h('option', { value: x.id, selected: p.hostId === x.id }, `${x.name} (${x.user ? x.user + '@' : ''}${x.hostname})`)));
  const host = I('host', { placeholder: 'hostname or IP' });
  const user = I('user', { placeholder: 'user' });
  const port = I('port', { type: 'number' });
  const dir = I('directory', { placeholder: 'e.g. ~/workspace/backend or C:\\Projects\\x' });
  const distro = I('wslDistro', { placeholder: 'e.g. Ubuntu' });
  const tmux = h('input', { type: 'checkbox', checked: p.tmux });
  const keep = h('input', { type: 'checkbox', checked: p.keepAlive });
  const keepInt = h('input', { type: 'number', value: p.keepAliveInterval || 30, style: { width: '80px' } });
  const keepMax = h('input', { type: 'number', value: p.keepAliveCountMax || 3, style: { width: '80px' } });
  const auto = h('input', { type: 'checkbox', checked: p.autoReconnect });
  const thr = h('input', { type: 'number', value: p.thresholdSec ?? '', placeholder: `default (${S.config.settings.defaultThresholdSec || 5} s)`, min: 1 });
  const dsName = h('input', { value: p.defaultSession.name || 'shell' });
  const dsCmd = h('input', { value: p.defaultSession.command || '', placeholder: 'e.g. claude (optional)' });
  const dsKind = h('select', null, [['terminal', 'Terminal'], ['agent', 'Agent (OpenCode)']].map(([v, l]) => h('option', { value: v, selected: (p.defaultSession.kind || 'terminal') === v }, l)));
  const agentCmd = h('input', { value: p.agentCommand || 'opencode' });
  const terms = rowsEditor(p.terminals, [{ key: 'name', placeholder: 'Name', small: true }, { key: 'command', placeholder: 'Start command (optional)' }, { key: 'kind', options: [['terminal', 'Terminal'], ['agent', 'Agent']] }]);
  const cmds = rowsEditor(p.commands, [{ key: 'name', placeholder: 'Name, e.g. Start agent', small: false }, { key: 'command', placeholder: 'Command, e.g. claude --continue' }]);
  const fwds = rowsEditor(p.forwards, [{ key: 'local', placeholder: 'local', small: true, type: 'number' }, { key: 'remote', placeholder: 'remote', small: true, type: 'number' }, { key: 'remoteHost', placeholder: 'Target host (default localhost)' }]);

  const agentSection = projectSetupSection(ctx, p, agentsList, skillsInfo.skills);
  const sshOnly = [];
  const inlineOnly = [];
  const wslOnly = [];
  const grp = (arr, ...els) => { arr.push(...els.filter(Boolean)); return els; };
  const form = h('div', { class: 'form' },
    field('Name', name),
    field('Connection type', type),
    grp(sshOnly, ...field('Developer host', hostSel, 'Projects reference a host from the host directory')),
    grp(inlineOnly, ...field('Host', host)),
    grp(inlineOnly, ...field('User', user)),
    grp(inlineOnly, ...field('Port', port)),
    grp(wslOnly, ...field('WSL distribution', distro)),
    field('Start directory', dir, 'Empty = the host’s workspace folder or the home directory'),
    field('tmux', h('label', { class: 'row' }, tmux, 'One named tmux session per terminal (attach or create); agents keep running when the connection drops')),
    grp(sshOnly, ...field('Keep-alive', h('div', { class: 'row' }, keep, h('span', { class: 'muted' }, 'ServerAliveInterval'), keepInt, h('span', { class: 'muted' }, 'CountMax'), keepMax))),
    field('Auto-reconnect', h('label', { class: 'row' }, auto, 'Reconnect automatically when the connection drops')),
    field('Status threshold (s)', thr, 'No output for longer than this → green dot (waiting)'),
    h('h3', { class: 'full' }, 'Default session (plus button)'),
    field('Name', dsName),
    field('Start command', dsCmd),
    field('Type', dsKind),
    field('Agent command', agentCmd, 'Program for agent sessions on the target (OpenCode in server mode)'),
    h('h3', { class: 'full' }, 'Terminals (“Start all”)'),
    h('div', { class: 'full' }, terms.el),
    h('h3', { class: 'full' }, 'Saved commands'),
    h('div', { class: 'full' }, cmds.el),
    grp(sshOnly, h('h3', { class: 'full' }, 'Port forwarding (local port → remote port)')),
    grp(sshOnly, h('div', { class: 'full' }, fwds.el)),
    agentSection.elements);

  const sync = () => {
    const t = type.value;
    sshOnly.forEach((e) => (e.style.display = t === 'ssh' ? '' : 'none'));
    inlineOnly.forEach((e) => (e.style.display = t === 'ssh' && !hostSel.value ? '' : 'none'));
    wslOnly.forEach((e) => (e.style.display = t === 'wsl' ? '' : 'none'));
  };
  type.addEventListener('change', sync);
  hostSel.addEventListener('change', sync);
  sync();

  modal({
    title: isNew ? 'New project' : `Edit project “${p.name}”`,
    body: form,
    width: '780px',
    extraButtons: isNew ? [] : [h('button', { class: 'danger', onclick: async () => {
      if (await confirmDialog('Delete project', `Delete project “${p.name}”?`, 'Delete')) { await call('deleteProject', p.id); document.querySelector('.modal-bg')?.remove(); }
    } }, 'Delete')],
    onOk: async () => {
      if (!name.value.trim()) throw new Error('Name is missing');
      if (type.value === 'ssh' && !hostSel.value && !host.value.trim()) throw new Error('Host is missing');
      const out = {
        ...p,
        name: name.value.trim(),
        type: type.value,
        hostId: type.value === 'ssh' ? hostSel.value : '',
        host: host.value.trim(),
        user: user.value.trim(),
        port: Number(port.value) || 22,
        directory: dir.value.trim(),
        wslDistro: distro.value.trim(),
        tmux: tmux.checked,
        keepAlive: keep.checked,
        keepAliveInterval: Number(keepInt.value) || 30,
        keepAliveCountMax: Number(keepMax.value) || 3,
        autoReconnect: auto.checked,
        thresholdSec: thr.value ? Number(thr.value) : null,
        defaultSession: { name: dsName.value.trim() || 'shell', command: dsCmd.value.trim(), kind: dsKind.value },
        agentCommand: agentCmd.value.trim() || 'opencode',
        terminals: terms.get().map((t) => ({ ...t, name: t.name || 'term' })),
        commands: cmds.get().filter((c) => c.name && c.command),
        forwards: fwds.get().filter((f) => f.local && f.remote),
        agentSetup: agentSection.get(),
      };
      const saved = await call('saveProject', out);
      ctx.S.projectId = saved.id;
      ctx.S.view = 'project';
      const idx = ctx.S.config.projects.findIndex((x) => x.id === saved.id);
      if (idx >= 0) ctx.S.config.projects[idx] = saved; else ctx.S.config.projects.push(saved);
      ctx.render();
    },
  });
}

// ---------- hosts ----------
export function renderHosts(ctx, main) {
  main.appendChild(h('div', { class: 'main-head' },
    h('span', { class: 'title' }, 'Developer hosts'),
    h('span', { class: 'muted' }, 'Login via SSH keys / ssh-agent / ~/.ssh/config — no passwords are stored'),
    h('div', { class: 'spacer' }),
    h('button', { onclick: () => ctx.call('checkHosts') }, '↻ Check'),
    h('button', { class: 'primary', onclick: () => editHost(ctx, null) }, '+ Host')));
  const page = h('div', { class: 'content' }, h('div', { class: 'page', id: 'hosts-page' }));
  main.appendChild(page);
  renderHostsTable(ctx);
}

export function renderHostsTable(ctx) {
  const el = document.getElementById('hosts-page');
  if (!el) return;
  clear(el);
  const { S, call } = ctx;
  if (!S.config.hosts.length) {
    el.appendChild(h('div', { class: 'muted' }, 'No hosts yet. Add your Linux development machines once; projects then reference a host.'));
    return;
  }
  const byId = new Map(S.hosts.map((x) => [x.id, x]));
  el.appendChild(h('table', { class: 'list' },
    h('tr', null, ['', 'Name', 'Connection', 'Workspace', 'Tags', 'Reachable', 'Sessions (app / tmux)', ''].map((t) => h('th', null, t))),
    S.config.hosts.map((host) => {
      const st = byId.get(host.id) || {};
      return h('tr', null,
        h('td', null, h('span', { class: 'dot ' + (st.reachable ? 'waiting' : st.checkedAt ? 'error' : 'none') })),
        h('td', null, h('b', null, host.name)),
        h('td', { class: 'mono' }, `${host.user ? host.user + '@' : ''}${host.hostname}:${host.port}`),
        h('td', { class: 'mono' }, host.workspace),
        h('td', null, (host.tags || []).map((t) => h('span', { class: 'tag' }, t))),
        h('td', null, st.checkedAt ? (st.reachable ? h('span', { class: 'ok' }, `yes (${st.ms} ms)`) : h('span', { class: 'bad', title: st.error }, 'no')) : '…',
          st.sshError ? h('div', { class: 'bad', style: { fontSize: '11px' } }, 'ssh: ' + st.sshError) : null),
        h('td', null, `${st.appSessions ?? 0} / ${st.remoteTmux ?? '–'}`),
        h('td', null, h('div', { class: 'row' },
          h('button', { onclick: () => call('checkHostSsh', host.id), title: 'Count tmux sessions via SSH (BatchMode)' }, 'Check SSH'),
          h('button', { onclick: () => quickProject(ctx, host) }, '+ Project'),
          h('button', { class: 'icon', onclick: () => editHost(ctx, host) }, '✎'),
          h('button', { class: 'icon danger', onclick: async () => { if (await confirmDialog('Delete host', `Delete host “${host.name}”?`, 'Delete')) call('deleteHost', host.id); } }, '✕'))));
    })));
}

async function quickProject(ctx, host) {
  await editProject(ctx, null);
  // Preselect SSH + host in the freshly opened editor.
  const m = document.querySelector('.modal');
  if (!m) return;
  const selects = m.querySelectorAll('select');
  selects[0].value = 'ssh';
  selects[0].dispatchEvent(new Event('change'));
  selects[1].value = host.id;
  selects[1].dispatchEvent(new Event('change'));
}

function editHost(ctx, host) {
  const x = host || { port: 22, workspace: '~/workspace', tags: [] };
  const name = h('input', { value: x.name || '' });
  const hostname = h('input', { value: x.hostname || '', placeholder: 'Hostname or IP (or an alias from ~/.ssh/config)' });
  const port = h('input', { type: 'number', value: x.port || 22 });
  const user = h('input', { value: x.user || '' });
  const ws = h('input', { value: x.workspace || '~/workspace' });
  const tags = h('input', { value: (x.tags || []).join(', '), placeholder: 'gpu, large, …' });
  modal({
    title: host ? 'Edit host' : 'New host',
    body: h('div', { class: 'form' }, field('Name', name), field('Hostname/IP', hostname), field('Port', port), field('User', user), field('Workspace folder', ws), field('Tags', tags, 'Comma-separated')),
    onOk: async () => {
      if (!hostname.value.trim()) throw new Error('Hostname is missing');
      await ctx.call('saveHost', { ...x, name: name.value.trim() || hostname.value.trim(), hostname: hostname.value.trim(), port: Number(port.value) || 22, user: user.value.trim(), workspace: ws.value.trim(), tags: tags.value });
    },
  });
}

// ---------- MCP ----------
export function renderMcp(ctx, main) {
  const { S, call } = ctx;
  const st = S.mcp || {};
  const cfg = S.config.settings.mcp || {};
  main.appendChild(h('div', { class: 'main-head' },
    h('span', { class: 'title' }, 'MCP server'),
    h('span', { class: st.running ? 'ok' : 'bad' }, st.running ? '● running · ' + st.url : st.error ? '● error: ' + st.error : '○ off'),
    h('div', { class: 'spacer' }),
    h('button', { onclick: async () => { await call('updateSettings', { mcp: { enabled: !cfg.enabled } }); reloadConfig(ctx); } }, cfg.enabled ? 'Turn off' : 'Turn on')));
  const page = h('div', { class: 'page page-narrow' });
  main.appendChild(h('div', { class: 'content' }, page));

  const tokensBox = h('div');
  const renderTokens = async () => {
    S.tokens = await call('listTokens');
    clear(tokensBox);
    if (!S.tokens.length) tokensBox.appendChild(h('div', { class: 'muted' }, 'No tokens. Without a valid token the server does not answer.'));
    else tokensBox.appendChild(h('table', { class: 'list' },
      h('tr', null, ['Name', 'Access', 'Prefix', 'Created', 'Last used', 'Status', ''].map((t) => h('th', null, t))),
      S.tokens.map((t) => h('tr', null,
        h('td', null, t.name),
        h('td', null, t.readOnly ? 'read-only' : 'full'),
        h('td', { class: 'mono' }, t.prefix + '…'),
        h('td', null, fmtTime(t.created)),
        h('td', null, t.lastUsed ? timeAgo(t.lastUsed) + ' ago' : '–'),
        h('td', null, t.revoked ? h('span', { class: 'bad' }, 'revoked') : h('span', { class: 'ok' }, 'active')),
        h('td', null, h('div', { class: 'row' },
          h('button', { onclick: async () => showSecret(ctx, await call('renewToken', t.id), renderTokens) }, 'Renew'),
          !t.revoked ? h('button', { onclick: async () => { await call('revokeToken', t.id); renderTokens(); } }, 'Revoke') : null,
          h('button', { class: 'icon danger', title: 'Delete', onclick: async () => { await call('deleteToken', t.id); renderTokens(); } }, '✕')))))));
  };

  const perm = (key, label) => h('label', { class: 'row', style: { color: 'var(--fg)' } },
    h('input', { type: 'checkbox', checked: cfg[key], onchange: async (e) => { await call('updateSettings', { mcp: { [key]: e.target.checked } }); reloadConfig(ctx); } }), label);
  const bind = h('input', { value: cfg.bind });
  const port = h('input', { type: 'number', value: cfg.port });
  const localUrl = `http://${cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind}:${cfg.port}/mcp`;

  page.append(
    h('div', { class: 'card' },
      h('h2', null, 'Endpoint'),
      h('div', { class: 'form' },
        field('Bind address', bind, '127.0.0.1 = local only (recommended behind Nginx on the same machine); 0.0.0.0 = all interfaces'),
        field('Port', port),
        h('div', { class: 'full row' }, h('div', { class: 'spacer' }), h('button', { onclick: async () => { await call('updateSettings', { mcp: { bind: bind.value.trim() || '127.0.0.1', port: Number(port.value) || 47900 } }); reloadConfig(ctx); toast('MCP server restarted'); } }, 'Apply'))),
      h('p', { class: 'muted' }, 'Streamable HTTP at ', h('code', null, localUrl), '. Every request needs ', h('code', null, 'Authorization: Bearer <token>'), '. For access from outside (Claude app, web, voice mode), publish the port through an Nginx reverse proxy with HTTPS — see docs/nginx.conf. External requests are logged.')),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Tokens'), h('div', { class: 'spacer' }),
        h('button', { onclick: () => newToken(ctx, false, renderTokens) }, '+ Token (full)'),
        h('button', { onclick: () => newToken(ctx, true, renderTokens) }, '+ Token (read-only)')),
      h('div', { style: { marginTop: '10px' } }, tokensBox)),
    h('div', { class: 'card' },
      h('h2', null, 'Permissions'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        perm('restrictToShared', 'Only shared sessions are visible (session context menu → “Share with MCP”)'),
        perm('allowSend', 'send_to_session: send text to sessions'),
        perm('allowOpenSession', 'open_session: open new sessions'),
        perm('allowRunCommand', 'run_command: run saved commands'),
        perm('allowCreateDirectory', 'create_directory: create directories in the workspace folder'),
        perm('allowCreateProject', 'create_project: create projects')),
      h('p', { class: 'muted' }, 'Read tools: list_projects, list_sessions, read_output, wait_until_idle, wait_for_any_idle, list_hosts, find_free_host. Resources: session://<project>/<name>/status (subscribable). Orchestrator sessions are never a tool target.')),
    h('div', { class: 'card' },
      h('h2', null, 'Connect a client'),
      h('p', null, 'Claude Code (HTTP):'),
      h('pre', { class: 'secret' }, `claude mcp add --transport http atm ${localUrl} --header "Authorization: Bearer <token>"`),
      h('p', null, 'Clients that only support stdio (e.g. Claude Desktop) via the bridge:'),
      h('pre', { class: 'secret' }, JSON.stringify({ mcpServers: { atm: { command: 'node', args: [S.stdioBridge || 'atm-mcp-stdio.js', localUrl], env: { ATM_MCP_TOKEN: '<token>' } } } }, null, 2))));
  renderTokens();
}

function newToken(ctx, readOnly, after) {
  const name = h('input', { value: readOnly ? 'read' : 'claude', placeholder: 'Name' });
  modal({
    title: readOnly ? 'New token (read-only)' : 'New token (full access)',
    body: h('div', { class: 'form' }, field('Name', name)),
    okText: 'Create',
    onOk: async () => { const t = await ctx.call('createToken', { name: name.value.trim(), readOnly }); setTimeout(() => showSecret(ctx, t, after), 50); },
  });
}

function showSecret(ctx, t, after) {
  modal({
    title: `Token “${t.name}”`,
    body: h('div', null, h('p', null, 'The token is shown only now. It is stored as a hash.'), h('div', { class: 'secret' }, t.secret)),
    okText: 'Copy and close',
    cancelText: 'Close',
    onOk: () => ctx.call('copy', t.secret),
  });
  after && after();
}

async function reloadConfig(ctx) {
  const st = await ctx.call('getState');
  ctx.S.config = st.config;
  ctx.S.mcp = st.mcp;
  ctx.render();
}

// ---------- audit ----------
const auditRow = (e) => h('tr', null,
  h('td', { class: 'mono' }, new Date(e.time).toLocaleTimeString()),
  h('td', null, h('span', { class: 'src ' + e.source }, e.source)),
  h('td', null, e.token || ''),
  h('td', null, h('b', null, e.action)),
  h('td', { class: 'mono', style: { wordBreak: 'break-all' } }, e.detail || ''),
  h('td', null, e.remote || ''),
  h('td', { class: e.error ? 'bad' : 'ok' }, e.error || 'ok'));

export function renderAudit(ctx, main) {
  main.appendChild(h('div', { class: 'main-head' }, h('span', { class: 'title' }, 'Audit log'), h('span', { class: 'muted' }, 'MCP, orchestrator and external requests (also in audit.log in the data folder)'), h('div', { class: 'spacer' }),
    h('button', { onclick: () => ctx.call('openDataDir') }, 'Open data folder')));
  const tbody = h('tbody', { id: 'audit-body' });
  const page = h('div', { class: 'page', id: 'audit-page' }, h('table', { class: 'list audit' },
    h('thead', null, h('tr', null, ['Time', 'Source', 'Token', 'Action', 'Details', 'Remote', 'Result'].map((t) => h('th', null, t)))), tbody));
  main.appendChild(h('div', { class: 'content' }, page));
  for (const e of [...ctx.S.audit].reverse()) tbody.appendChild(auditRow(e));
}

export function appendAudit(ctx, e) {
  const tb = document.getElementById('audit-body');
  if (tb) tb.insertBefore(auditRow(e), tb.firstChild);
}

// ---------- settings ----------
export function renderSettings(ctx, main) {
  const { S, call } = ctx;
  const st = S.config.settings;
  main.appendChild(h('div', { class: 'main-head' }, h('span', { class: 'title' }, 'Settings'), h('span', { class: 'muted' }, `Version ${S.version || ''} · ${S.dataDir || ''}`)));
  const thr = h('input', { type: 'number', value: st.defaultThresholdSec || 5, min: 1 });
  const fs = h('input', { type: 'number', value: st.fontSize || 13, min: 8, max: 24 });
  const ofs = h('input', { type: 'number', value: st.overviewFontSize || '', placeholder: 'automatic', min: 5, max: 16 });
  const notif = h('input', { type: 'checkbox', checked: st.notifications });
  const oc = h('input', { value: st.opencodePath || '', placeholder: 'detect automatically' });
  const ocInfo = h('span', { class: 'muted' });
  const page = h('div', { class: 'page page-narrow' },
    h('div', { class: 'card' },
      h('h2', null, 'General'),
      h('div', { class: 'form' },
        field('Status threshold (s)', thr, 'Default for projects without their own threshold'),
        field('Font size', fs),
        field('Overview font size', ofs, 'Empty = depends on the number of tiles'),
        field('Notifications', h('label', { class: 'row' }, notif, 'Desktop notification when a session switches to “waiting”')),
        field('OpenCode program', h('div', { class: 'row' }, oc, h('button', { onclick: async () => { const p = await call('detectOpencode'); ocInfo.textContent = p ? 'found: ' + p : 'not found'; } }, 'Detect')), null),
        h('div', { class: 'hint' }, ocInfo),
        h('div', { class: 'full row' }, h('div', { class: 'spacer' }), h('button', { class: 'primary', onclick: async () => {
          await call('updateSettings', { defaultThresholdSec: Number(thr.value) || 5, fontSize: Number(fs.value) || 13, overviewFontSize: Number(ofs.value) || null, notifications: notif.checked, opencodePath: oc.value.trim() });
          for (const t of ctx.terms.values()) t.baseFontSize = Number(fs.value) || 13;
          await reloadConfig(ctx);
          toast('Saved');
        } }, 'Save')))),
    h('div', { class: 'card' },
      h('h2', null, 'Configuration'),
      h('p', { class: 'muted' }, 'Projects, hosts and orchestrators are stored as JSON in the data folder (config.json). Tokens are not exported.'),
      h('div', { class: 'row' },
        h('button', { onclick: async () => { const f = await call('exportConfig'); if (f) toast('Exported: ' + f); } }, 'Export…'),
        h('button', { onclick: async () => { if (await call('importConfig', true)) { toast('Imported (merged)'); reloadConfig(ctx); } } }, 'Import (merge)…'),
        h('button', { onclick: async () => { if (await confirmDialog('Import', 'Replace the current configuration?', 'Replace') && await call('importConfig', false)) { toast('Imported'); reloadConfig(ctx); } } }, 'Import (replace)…'),
        h('button', { onclick: () => call('openDataDir') }, 'Open data folder'))),
    h('div', { class: 'card' },
      h('h2', null, 'Keyboard shortcuts'),
      h('table', { class: 'list' }, [
        ['Ctrl/⌘ + Shift + T', 'New session in the current project'],
        ['Ctrl/⌘ + 1…9', 'Switch project'],
        ['Ctrl/⌘ + Tab', 'Next session'],
        ['Ctrl/⌘ + Shift + G', 'Toggle tile view'],
        ['Ctrl/⌘ + Shift + O', 'Overview'],
        ['Ctrl/⌘ + Shift + W', 'Close session'],
        ['Ctrl/⌘ + Shift + C / V', 'Copy / paste in the terminal'],
      ].map(([k, d]) => h('tr', null, h('td', null, h('span', { class: 'kbd' }, k)), h('td', null, d))))));
  main.appendChild(h('div', { class: 'content' }, page));
}

// ---------- orchestrators ----------
export function renderOrchestrators(ctx, main) {
  const { S } = ctx;
  const list = S.orchestrators;
  if (!S.orchId || !list.find((o) => o.id === S.orchId)) S.orchId = list[0] ? list[0].id : null;
  main.appendChild(h('div', { class: 'main-head' },
    h('span', { class: 'title' }, 'Orchestrators'),
    h('span', { class: 'muted' }, 'OpenCode in server mode + the app’s MCP tools'),
    h('div', { class: 'spacer' }),
    list.map((o) => h('button', { class: o.id === S.orchId ? 'active' : '', onclick: () => { S.orchId = o.id; ctx.render(); } }, h('span', { class: 'dot ' + orchDot(o), style: { marginRight: '6px' } }), o.name)),
    h('button', { class: 'primary', onclick: () => editOrchestrator(ctx, null) }, '+ Orchestrator')));
  const content = h('div', { class: 'content', id: 'orch-content' });
  main.appendChild(content);
  renderOrchDetail(ctx);
}

const orchDot = (o) => ({ stopped: 'none', starting: 'starting', idle: 'waiting', running: 'working', paused: 'exited', error: 'error' }[o.state] || 'none');
const ORCH_STATE = { stopped: 'stopped', starting: 'starting', idle: 'ready', running: 'working', paused: 'paused', error: 'error' };

function renderOrchDetail(ctx) {
  const { S, call } = ctx;
  const content = document.getElementById('orch-content');
  if (!content) return;
  clear(content);
  const o = S.orchestrators.find((x) => x.id === S.orchId);
  if (!o) {
    content.appendChild(h('div', { class: 'empty' },
      h('div', null, 'No orchestrator yet.'),
      h('div', { class: 'muted', style: { maxWidth: '520px', textAlign: 'center' } }, 'An orchestrator is an OpenCode agent with a system prompt that controls watched sessions through the MCP tools, e.g. developer + reviewer. When a watched session finishes, it automatically gets a message with the latest output.'),
      h('button', { class: 'primary', onclick: () => editOrchestrator(ctx, null) }, '+ Create orchestrator')));
    return;
  }
  const running = o.state !== 'stopped' && o.state !== 'error';
  const watchedLabels = (o.watched || []).map((k) => {
    const [pid, name] = k.split('/');
    const p = ctx.project(pid);
    const s = [...S.sessions.values()].find((x) => x.projectId === pid && x.name === name);
    return h('span', { class: 'tag', title: s ? ctx.STATUS_LABEL[s.status] : 'not running' }, h('span', { class: 'dot ' + (s ? s.status : 'none'), style: { width: '7px', height: '7px', marginRight: '4px' } }), `${p ? p.name : '?'}/${name}`);
  });
  const status = h('div', { class: 'chat-status' },
    h('span', { class: 'dot ' + orchDot(o) }),
    h('b', null, ORCH_STATE[o.state] || o.state),
    o.currentAction ? h('span', { class: 'muted' }, '· ' + o.currentAction) : null,
    h('span', { class: 'muted' }, `· rounds ${o.rounds}/${o.maxRounds}`),
    o.queue && o.queue.length ? h('span', { class: 'warn' }, `· ${o.queue.length} event(s) queued`) : null,
    o.error ? h('span', { class: 'bad' }, '· ' + o.error) : null,
    h('span', { class: 'spacer' }),
    !running ? h('button', { class: 'primary', onclick: () => call('orchStart', o.id).catch((e) => toast(e.message, { error: true })) }, '▶ Start') : null,
    running && o.state !== 'paused' ? h('button', { onclick: () => call('orchPause', o.id) }, '⏸ Pause') : null,
    o.state === 'paused' ? h('button', { onclick: () => call('orchResume', o.id) }, '▶ Resume') : null,
    running ? h('button', { onclick: () => call('orchInterrupt', o.id), title: 'Interrupt the current answer' }, 'Interrupt') : null,
    running ? h('button', { class: 'danger', onclick: () => call('orchStop', o.id) }, '■ Stop') : null,
    h('button', { onclick: () => editOrchestrator(ctx, o) }, 'Edit'));
  const watched = h('div', { class: 'chat-status' }, h('span', { class: 'muted' }, 'Watching:'), watchedLabels.length ? watchedLabels : h('span', { class: 'bad' }, 'no sessions — choose them under “Edit”'),
    o.conflicts && o.conflicts.length ? h('span', { class: 'bad' }, 'Conflict: ' + o.conflicts.map((c) => c.orchestrator).join(', ')) : null,
    o.model ? h('span', { class: 'muted' }, '· model ' + o.model) : null);
  const log = h('div', { class: 'chat-log', id: 'orch-log' });
  const ta = h('textarea', { placeholder: running ? 'Task or message for the orchestrator… (Enter to send)' : 'Start the orchestrator to send messages', disabled: !running });
  const sendIt = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    try { await call('orchSend', o.id, text); } catch (e) { toast(e.message, { error: true }); ta.value = text; }
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); } });
  content.appendChild(h('div', { class: 'chat' }, status, watched, log, h('div', { class: 'chat-input' }, ta, h('button', { class: 'primary', onclick: sendIt, disabled: !running }, 'Send'))));
  renderMessages(log, S.orchMessages.get(o.id), S.orchLive.get(o.id));
  if (running && !S.orchMessages.has(o.id)) call('orchMessages', o.id).then((m) => { S.orchMessages.set(o.id, m || []); onOrchMessages(ctx, o.id); });
}

export function onOrchestratorsChanged(ctx) {
  if (ctx.S.view !== 'orch') return;
  // Re-render header (state dots) and detail, but keep any typed text.
  const ta = document.querySelector('#orch-content textarea');
  const draft = ta ? ta.value : '';
  const hadFocus = ta && document.activeElement === ta;
  ctx.render();
  const nta = document.querySelector('#orch-content textarea');
  if (nta) { nta.value = draft; if (hadFocus) nta.focus(); }
}

export function onOrchMessages(ctx, id) {
  if (ctx.S.view !== 'orch' || ctx.S.orchId !== id) return;
  const log = document.getElementById('orch-log');
  if (log) renderMessages(log, ctx.S.orchMessages.get(id), ctx.S.orchLive.get(id));
}

function editOrchestrator(ctx, o) {
  const { S, call } = ctx;
  const x = o ? structuredClone(o) : { name: 'Orchestrator ' + (S.orchestrators.length + 1), systemPrompt: S.templates[0].prompt, model: '', watched: [], maxRounds: 20 };
  const name = h('input', { value: x.name });
  const model = h('input', { value: x.model || '', placeholder: 'provider/model, empty = OpenCode’s default model' });
  const rounds = h('input', { type: 'number', value: x.maxRounds, min: 1 });
  const prompt = h('textarea', { style: { height: '220px' } });
  prompt.value = x.systemPrompt;
  const tpl = h('select', { onchange: (e) => { const t = S.templates.find((t) => t.id === e.target.value); if (t) prompt.value = t.prompt; } },
    h('option', { value: '' }, 'Insert template…'), S.templates.map((t) => h('option', { value: t.id }, t.name)));
  // Candidate sessions: all running sessions, plus already watched ones that are not running.
  const others = new Map();
  for (const other of S.orchestrators) if (!o || other.id !== o.id) for (const k of other.watched || []) others.set(k, other.name);
  const keys = new Map();
  for (const s of S.sessions.values()) if (!s.orchestrator) keys.set(`${s.projectId}/${s.name}`, s);
  for (const k of x.watched || []) if (!keys.has(k)) keys.set(k, null);
  const checks = h('div', { class: 'checklist' }, keys.size ? [...keys.entries()].map(([k, s]) => {
    const [pid, nm] = k.split('/');
    const p = ctx.project(pid);
    const taken = others.get(k);
    return h('label', { title: taken ? 'Already controlled by ' + taken : '' },
      h('input', { type: 'checkbox', 'data-k': k, checked: (x.watched || []).includes(k), disabled: !!taken }),
      h('span', { class: 'dot ' + (s ? s.status : 'none') }), `${p ? p.name : '?'} / ${nm}`,
      s && s.kind !== 'terminal' ? h('span', { class: 'tag' }, s.kind === 'acp' ? 'acp' : 'agent') : null,
      !s ? h('span', { class: 'muted' }, '(not running)') : null,
      taken ? h('span', { class: 'bad' }, `(${taken})`) : null);
  }) : h('div', { class: 'muted' }, 'No running sessions. Open the sessions that should be controlled first.'));
  modal({
    title: o ? 'Edit orchestrator' : 'New orchestrator',
    width: '820px',
    body: h('div', { class: 'form' },
      field('Name', name),
      field('Model', model),
      field('Max. rounds', rounds, 'Pauses after this many event rounds without user input'),
      field('Watched sessions', checks, 'A session can only be controlled by one orchestrator at a time'),
      field('System prompt', h('div', null, tpl, h('div', { style: { height: '6px' } }), prompt))),
    extraButtons: o ? [h('button', { class: 'danger', onclick: async () => {
      if (await confirmDialog('Delete orchestrator', `Delete “${o.name}”?`, 'Delete')) { await call('orchRemove', o.id); document.querySelector('.modal-bg')?.remove(); }
    } }, 'Delete')] : [],
    onOk: async () => {
      const watched = [...checks.querySelectorAll('input[data-k]')].filter((c) => c.checked).map((c) => c.dataset.k);
      const saved = await call('orchSave', { ...x, name: name.value.trim() || 'Orchestrator', model: model.value.trim(), maxRounds: Number(rounds.value) || 20, systemPrompt: prompt.value, watched });
      S.orchId = saved.id;
      S.view = 'orch';
      ctx.render();
    },
  });
}

export function refreshChatStatus(ctx, id) {
  document.querySelectorAll(`[data-chat-status="${id}"]`).forEach((el) => fillStatus(ctx, el, ctx.S.sessions.get(id)));
}
