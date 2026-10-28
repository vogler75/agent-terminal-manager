// Editors and secondary pages: project editor, hosts, orchestrators, MCP tokens, audit log, settings.
import { h, clear, toast, modal, field, confirmDialog, fmtTime, timeAgo } from './ui.js';
import { renderMessages, fillStatus } from './chat.js';

// Editable list of rows (terminals, saved commands, port forwards).
function rowsEditor(items, cols) {
  const wrap = h('div', { class: 'rows' });
  const list = h('div');
  const addRow = (it = {}) => {
    const inputs = cols.map((c) => c.options
      ? h('select', { 'data-k': c.key, style: { flex: '0 0 110px' } }, c.options.map(([v, l]) => h('option', { value: v, selected: (it[c.key] || c.options[0][0]) === v }, l)))
      : h('input', { 'data-k': c.key, placeholder: c.placeholder, value: it[c.key] ?? '', class: c.small ? 'small' : '', type: c.type || 'text' }));
    const r = h('div', { class: 'r' }, inputs, h('button', { class: 'icon', title: 'Entfernen', onclick: () => r.remove() }, '✕'));
    list.appendChild(r);
  };
  (items || []).forEach(addRow);
  wrap.append(list, h('button', { onclick: () => addRow() }, '+ hinzufügen'));
  return {
    el: wrap,
    get: () => [...list.children].map((r) => {
      const o = {};
      r.querySelectorAll('[data-k]').forEach((i) => { o[i.dataset.k] = i.type === 'number' ? Number(i.value) || '' : i.value.trim(); });
      return o;
    }).filter((o) => Object.entries(o).some(([k, v]) => v !== '' && !(cols.find((c) => c.key === k) || {}).options)),
  };
}

export function editProject(ctx, p) {
  const { S, call } = ctx;
  const isNew = !p;
  p = p ? structuredClone(p) : { type: S.platform === 'win32' ? 'local' : 'local', tmux: S.platform !== 'win32', keepAlive: true, defaultSession: { name: 'shell', command: '', kind: 'terminal' }, terminals: [], commands: [], forwards: [], port: 22 };
  const I = (k, attrs = {}) => h('input', { value: p[k] ?? '', ...attrs });
  const name = I('name', { placeholder: 'z. B. backend' });
  const type = h('select', null, [['local', 'Lokal'], ['ssh', 'SSH'], ['wsl', 'WSL']].map(([v, l]) => h('option', { value: v, selected: p.type === v }, l)));
  const hostSel = h('select', null, h('option', { value: '' }, '— eigene Verbindungsdaten —'), S.config.hosts.map((x) => h('option', { value: x.id, selected: p.hostId === x.id }, `${x.name} (${x.user ? x.user + '@' : ''}${x.hostname})`)));
  const host = I('host', { placeholder: 'hostname oder IP' });
  const user = I('user', { placeholder: 'Benutzer' });
  const port = I('port', { type: 'number' });
  const dir = I('directory', { placeholder: 'z. B. ~/workspace/backend oder C:\\Projekte\\x' });
  const distro = I('wslDistro', { placeholder: 'z. B. Ubuntu' });
  const tmux = h('input', { type: 'checkbox', checked: p.tmux });
  const keep = h('input', { type: 'checkbox', checked: p.keepAlive });
  const keepInt = h('input', { type: 'number', value: p.keepAliveInterval || 30, style: { width: '80px' } });
  const keepMax = h('input', { type: 'number', value: p.keepAliveCountMax || 3, style: { width: '80px' } });
  const auto = h('input', { type: 'checkbox', checked: p.autoReconnect });
  const thr = h('input', { type: 'number', value: p.thresholdSec ?? '', placeholder: `Standard (${S.config.settings.defaultThresholdSec || 5} s)`, min: 1 });
  const dsName = h('input', { value: p.defaultSession.name || 'shell' });
  const dsCmd = h('input', { value: p.defaultSession.command || '', placeholder: 'z. B. claude (optional)' });
  const dsKind = h('select', null, [['terminal', 'Terminal'], ['agent', 'Agent (OpenCode)']].map(([v, l]) => h('option', { value: v, selected: (p.defaultSession.kind || 'terminal') === v }, l)));
  const agentCmd = h('input', { value: p.agentCommand || 'opencode' });
  const terms = rowsEditor(p.terminals, [{ key: 'name', placeholder: 'Name', small: true }, { key: 'command', placeholder: 'Startbefehl (optional)' }, { key: 'kind', options: [['terminal', 'Terminal'], ['agent', 'Agent']] }]);
  const cmds = rowsEditor(p.commands, [{ key: 'name', placeholder: 'Name, z. B. Agent starten', small: false }, { key: 'command', placeholder: 'Befehl, z. B. claude --continue' }]);
  const fwds = rowsEditor(p.forwards, [{ key: 'local', placeholder: 'lokal', small: true, type: 'number' }, { key: 'remote', placeholder: 'remote', small: true, type: 'number' }, { key: 'remoteHost', placeholder: 'Ziel-Host (Standard localhost)' }]);

  const sshOnly = [];
  const inlineOnly = [];
  const wslOnly = [];
  const grp = (arr, ...els) => { arr.push(...els.filter(Boolean)); return els; };
  const form = h('div', { class: 'form' },
    field('Name', name),
    field('Verbindungstyp', type),
    grp(sshOnly, ...field('Entwickler-Host', hostSel, 'Projekte verweisen auf einen Host aus dem Host-Verzeichnis')),
    grp(inlineOnly, ...field('Host', host)),
    grp(inlineOnly, ...field('Benutzer', user)),
    grp(inlineOnly, ...field('Port', port)),
    grp(wslOnly, ...field('WSL-Distribution', distro)),
    field('Startverzeichnis', dir, 'Leer = Workspace-Ordner des Hosts bzw. Home-Verzeichnis'),
    field('tmux', h('label', { class: 'row' }, tmux, 'Pro Terminal eine benannte tmux-Session (attach or create), Agents laufen bei Abbruch weiter')),
    grp(sshOnly, ...field('Keep-Alive', h('div', { class: 'row' }, keep, h('span', { class: 'muted' }, 'ServerAliveInterval'), keepInt, h('span', { class: 'muted' }, 'CountMax'), keepMax))),
    field('Auto-Reconnect', h('label', { class: 'row' }, auto, 'Bei Verbindungsabbruch automatisch neu verbinden')),
    field('Statusschwelle (s)', thr, 'Kein Output länger als diese Zeit → grüner Punkt (wartet)'),
    h('h3', { class: 'full' }, 'Standard-Session (Plus-Button)'),
    field('Name', dsName),
    field('Startbefehl', dsCmd),
    field('Typ', dsKind),
    field('Agent-Befehl', agentCmd, 'Programm für Agent-Sessions auf dem Ziel (OpenCode im Server-Modus)'),
    h('h3', { class: 'full' }, 'Terminals („Alle starten“)'),
    h('div', { class: 'full' }, terms.el),
    h('h3', { class: 'full' }, 'Gespeicherte Befehle'),
    h('div', { class: 'full' }, cmds.el),
    grp(sshOnly, h('h3', { class: 'full' }, 'Port-Forwarding (lokaler Port → Remote-Port)')),
    grp(sshOnly, h('div', { class: 'full' }, fwds.el)));

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
    title: isNew ? 'Neues Projekt' : `Projekt „${p.name}“ bearbeiten`,
    body: form,
    width: '780px',
    extraButtons: isNew ? [] : [h('button', { class: 'danger', onclick: async () => {
      if (await confirmDialog('Projekt löschen', `Projekt „${p.name}“ löschen?`, 'Löschen')) { await call('deleteProject', p.id); document.querySelector('.modal-bg')?.remove(); }
    } }, 'Löschen')],
    onOk: async () => {
      if (!name.value.trim()) throw new Error('Name fehlt');
      if (type.value === 'ssh' && !hostSel.value && !host.value.trim()) throw new Error('Host fehlt');
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
    h('span', { class: 'title' }, 'Entwickler-Hosts'),
    h('span', { class: 'muted' }, 'Anmeldung über SSH-Keys / ssh-agent / ~/.ssh/config — es werden keine Passwörter gespeichert'),
    h('div', { class: 'spacer' }),
    h('button', { onclick: () => ctx.call('checkHosts') }, '↻ Prüfen'),
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
    el.appendChild(h('div', { class: 'muted' }, 'Noch keine Hosts. Lege die Linux-Entwicklungsrechner einmalig an; Projekte verweisen dann auf einen Host.'));
    return;
  }
  const byId = new Map(S.hosts.map((x) => [x.id, x]));
  el.appendChild(h('table', { class: 'list' },
    h('tr', null, ['', 'Name', 'Verbindung', 'Workspace', 'Tags', 'Erreichbar', 'Sessions (App / tmux)', ''].map((t) => h('th', null, t))),
    S.config.hosts.map((host) => {
      const st = byId.get(host.id) || {};
      return h('tr', null,
        h('td', null, h('span', { class: 'dot ' + (st.reachable ? 'waiting' : st.checkedAt ? 'error' : 'none') })),
        h('td', null, h('b', null, host.name)),
        h('td', { class: 'mono' }, `${host.user ? host.user + '@' : ''}${host.hostname}:${host.port}`),
        h('td', { class: 'mono' }, host.workspace),
        h('td', null, (host.tags || []).map((t) => h('span', { class: 'tag' }, t))),
        h('td', null, st.checkedAt ? (st.reachable ? h('span', { class: 'ok' }, `ja (${st.ms} ms)`) : h('span', { class: 'bad', title: st.error }, 'nein')) : '…',
          st.sshError ? h('div', { class: 'bad', style: { fontSize: '11px' } }, 'ssh: ' + st.sshError) : null),
        h('td', null, `${st.appSessions ?? 0} / ${st.remoteTmux ?? '–'}`),
        h('td', null, h('div', { class: 'row' },
          h('button', { onclick: () => call('checkHostSsh', host.id), title: 'Per SSH (BatchMode) tmux-Sessions zählen' }, 'SSH prüfen'),
          h('button', { onclick: () => quickProject(ctx, host) }, '+ Projekt'),
          h('button', { class: 'icon', onclick: () => editHost(ctx, host) }, '✎'),
          h('button', { class: 'icon danger', onclick: async () => { if (await confirmDialog('Host löschen', `Host „${host.name}“ löschen?`, 'Löschen')) call('deleteHost', host.id); } }, '✕'))));
    })));
}

function quickProject(ctx, host) {
  editProject(ctx, null);
  // Preselect SSH + host in the freshly opened editor.
  setTimeout(() => {
    const m = document.querySelector('.modal');
    if (!m) return;
    const selects = m.querySelectorAll('select');
    selects[0].value = 'ssh';
    selects[0].dispatchEvent(new Event('change'));
    selects[1].value = host.id;
    selects[1].dispatchEvent(new Event('change'));
  }, 20);
}

function editHost(ctx, host) {
  const x = host || { port: 22, workspace: '~/workspace', tags: [] };
  const name = h('input', { value: x.name || '' });
  const hostname = h('input', { value: x.hostname || '', placeholder: 'Hostname oder IP (oder Alias aus ~/.ssh/config)' });
  const port = h('input', { type: 'number', value: x.port || 22 });
  const user = h('input', { value: x.user || '' });
  const ws = h('input', { value: x.workspace || '~/workspace' });
  const tags = h('input', { value: (x.tags || []).join(', '), placeholder: 'gpu, gross, …' });
  modal({
    title: host ? 'Host bearbeiten' : 'Neuer Host',
    body: h('div', { class: 'form' }, field('Name', name), field('Hostname/IP', hostname), field('Port', port), field('Benutzer', user), field('Workspace-Ordner', ws), field('Tags', tags, 'Kommagetrennt')),
    onOk: async () => {
      if (!hostname.value.trim()) throw new Error('Hostname fehlt');
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
    h('span', { class: 'title' }, 'MCP-Server'),
    h('span', { class: st.running ? 'ok' : 'bad' }, st.running ? '● läuft · ' + st.url : st.error ? '● Fehler: ' + st.error : '○ aus'),
    h('div', { class: 'spacer' }),
    h('button', { onclick: async () => { await call('updateSettings', { mcp: { enabled: !cfg.enabled } }); reloadConfig(ctx); } }, cfg.enabled ? 'Ausschalten' : 'Einschalten')));
  const page = h('div', { class: 'page page-narrow' });
  main.appendChild(h('div', { class: 'content' }, page));

  const tokensBox = h('div');
  const renderTokens = async () => {
    S.tokens = await call('listTokens');
    clear(tokensBox);
    if (!S.tokens.length) tokensBox.appendChild(h('div', { class: 'muted' }, 'Keine Tokens. Ohne gültigen Token antwortet der Server nicht.'));
    else tokensBox.appendChild(h('table', { class: 'list' },
      h('tr', null, ['Name', 'Zugriff', 'Präfix', 'Erstellt', 'Zuletzt benutzt', 'Status', ''].map((t) => h('th', null, t))),
      S.tokens.map((t) => h('tr', null,
        h('td', null, t.name),
        h('td', null, t.readOnly ? 'nur lesen' : 'voll'),
        h('td', { class: 'mono' }, t.prefix + '…'),
        h('td', null, fmtTime(t.created)),
        h('td', null, t.lastUsed ? timeAgo(t.lastUsed) : '–'),
        h('td', null, t.revoked ? h('span', { class: 'bad' }, 'widerrufen') : h('span', { class: 'ok' }, 'aktiv')),
        h('td', null, h('div', { class: 'row' },
          h('button', { onclick: async () => showSecret(ctx, await call('renewToken', t.id), renderTokens) }, 'Erneuern'),
          !t.revoked ? h('button', { onclick: async () => { await call('revokeToken', t.id); renderTokens(); } }, 'Widerrufen') : null,
          h('button', { class: 'icon danger', onclick: async () => { await call('deleteToken', t.id); renderTokens(); } }, '✕')))))));
  };

  const perm = (key, label) => h('label', { class: 'row', style: { color: 'var(--fg)' } },
    h('input', { type: 'checkbox', checked: cfg[key], onchange: async (e) => { await call('updateSettings', { mcp: { [key]: e.target.checked } }); reloadConfig(ctx); } }), label);
  const bind = h('input', { value: cfg.bind });
  const port = h('input', { type: 'number', value: cfg.port });
  const localUrl = `http://${cfg.bind === '0.0.0.0' ? '127.0.0.1' : cfg.bind}:${cfg.port}/mcp`;

  page.append(
    h('div', { class: 'card' },
      h('h2', null, 'Endpunkt'),
      h('div', { class: 'form' },
        field('Bind-Adresse', bind, '127.0.0.1 = nur lokal (empfohlen hinter Nginx auf demselben Rechner); 0.0.0.0 = alle Interfaces'),
        field('Port', port),
        h('div', { class: 'full row' }, h('div', { class: 'spacer' }), h('button', { onclick: async () => { await call('updateSettings', { mcp: { bind: bind.value.trim() || '127.0.0.1', port: Number(port.value) || 47900 } }); reloadConfig(ctx); toast('MCP-Server neu gestartet'); } }, 'Übernehmen'))),
      h('p', { class: 'muted' }, 'Streamable HTTP unter ', h('code', null, localUrl), '. Jede Anfrage braucht ', h('code', null, 'Authorization: Bearer <token>'), '. Für den Zugriff von außen (Claude App, Web, Sprachmodus) den Port per Nginx-Reverse-Proxy mit HTTPS veröffentlichen — Beispiel in docs/nginx.conf. Externe Zugriffe werden protokolliert.')),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Tokens'), h('div', { class: 'spacer' }),
        h('button', { onclick: () => newToken(ctx, false, renderTokens) }, '+ Token (voll)'),
        h('button', { onclick: () => newToken(ctx, true, renderTokens) }, '+ Token (nur lesen)')),
      h('div', { style: { marginTop: '10px' } }, tokensBox)),
    h('div', { class: 'card' },
      h('h2', null, 'Freigaben'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        perm('restrictToShared', 'Nur freigegebene Sessions sichtbar (Kontextmenü einer Session → „Für MCP freigeben“)'),
        perm('allowSend', 'send_to_session: Text an Sessions senden'),
        perm('allowOpenSession', 'open_session: neue Sessions öffnen'),
        perm('allowRunCommand', 'run_command: gespeicherte Befehle ausführen'),
        perm('allowCreateDirectory', 'create_directory: Verzeichnisse im Workspace-Ordner anlegen'),
        perm('allowCreateProject', 'create_project: Projekte anlegen')),
      h('p', { class: 'muted' }, 'Lese-Tools: list_projects, list_sessions, read_output, wait_until_idle, wait_for_any_idle, list_hosts, find_free_host. Ressourcen: session://<projekt>/<name>/status (abonnierbar). Orchestrator-Sessions sind nie Ziel von Tools.')),
    h('div', { class: 'card' },
      h('h2', null, 'Einbinden'),
      h('p', null, 'Claude Code (HTTP):'),
      h('pre', { class: 'secret' }, `claude mcp add --transport http atm ${localUrl} --header "Authorization: Bearer <token>"`),
      h('p', null, 'Clients nur mit stdio (z. B. Claude Desktop) über die Bridge:'),
      h('pre', { class: 'secret' }, JSON.stringify({ mcpServers: { atm: { command: 'node', args: [S.stdioBridge || 'atm-mcp-stdio.js', localUrl], env: { ATM_MCP_TOKEN: '<token>' } } } }, null, 2))));
  renderTokens();
}

function newToken(ctx, readOnly, after) {
  const name = h('input', { value: readOnly ? 'lesen' : 'claude', placeholder: 'Name' });
  modal({
    title: readOnly ? 'Neuer Token (nur lesen)' : 'Neuer Token (voller Zugriff)',
    body: h('div', { class: 'form' }, field('Name', name)),
    okText: 'Erzeugen',
    onOk: async () => { const t = await ctx.call('createToken', { name: name.value.trim(), readOnly }); setTimeout(() => showSecret(ctx, t, after), 50); },
  });
}

function showSecret(ctx, t, after) {
  modal({
    title: `Token „${t.name}“`,
    body: h('div', null, h('p', null, 'Der Token wird nur jetzt angezeigt. Er wird gehasht gespeichert.'), h('div', { class: 'secret' }, t.secret)),
    okText: 'Kopieren und schließen',
    cancelText: 'Schließen',
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
  main.appendChild(h('div', { class: 'main-head' }, h('span', { class: 'title' }, 'Protokoll'), h('span', { class: 'muted' }, 'MCP-, Orchestrator- und externe Zugriffe (auch in audit.log im Datenverzeichnis)'), h('div', { class: 'spacer' }),
    h('button', { onclick: () => ctx.call('openDataDir') }, 'Datenverzeichnis öffnen')));
  const tbody = h('tbody', { id: 'audit-body' });
  const page = h('div', { class: 'page', id: 'audit-page' }, h('table', { class: 'list audit' },
    h('thead', null, h('tr', null, ['Zeit', 'Quelle', 'Token', 'Aktion', 'Details', 'Remote', 'Ergebnis'].map((t) => h('th', null, t)))), tbody));
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
  main.appendChild(h('div', { class: 'main-head' }, h('span', { class: 'title' }, 'Einstellungen'), h('span', { class: 'muted' }, `Version ${S.version || ''} · ${S.dataDir || ''}`)));
  const thr = h('input', { type: 'number', value: st.defaultThresholdSec || 5, min: 1 });
  const fs = h('input', { type: 'number', value: st.fontSize || 13, min: 8, max: 24 });
  const ofs = h('input', { type: 'number', value: st.overviewFontSize || '', placeholder: 'automatisch', min: 5, max: 16 });
  const notif = h('input', { type: 'checkbox', checked: st.notifications });
  const oc = h('input', { value: st.opencodePath || '', placeholder: 'automatisch suchen' });
  const ocInfo = h('span', { class: 'muted' });
  const page = h('div', { class: 'page page-narrow' },
    h('div', { class: 'card' },
      h('h2', null, 'Allgemein'),
      h('div', { class: 'form' },
        field('Statusschwelle (s)', thr, 'Standard für Projekte ohne eigene Schwelle'),
        field('Schriftgröße', fs),
        field('Schrift Übersicht', ofs, 'Leer = abhängig von der Anzahl der Kacheln'),
        field('Benachrichtigungen', h('label', { class: 'row' }, notif, 'Desktop-Benachrichtigung beim Wechsel auf „wartet“')),
        field('OpenCode-Programm', h('div', { class: 'row' }, oc, h('button', { onclick: async () => { const p = await call('detectOpencode'); ocInfo.textContent = p ? 'gefunden: ' + p : 'nicht gefunden'; } }, 'Suchen')), null),
        h('div', { class: 'hint' }, ocInfo),
        h('div', { class: 'full row' }, h('div', { class: 'spacer' }), h('button', { class: 'primary', onclick: async () => {
          await call('updateSettings', { defaultThresholdSec: Number(thr.value) || 5, fontSize: Number(fs.value) || 13, overviewFontSize: Number(ofs.value) || null, notifications: notif.checked, opencodePath: oc.value.trim() });
          for (const t of ctx.terms.values()) t.baseFontSize = Number(fs.value) || 13;
          await reloadConfig(ctx);
          toast('Gespeichert');
        } }, 'Speichern')))),
    h('div', { class: 'card' },
      h('h2', null, 'Konfiguration'),
      h('p', { class: 'muted' }, 'Projekte, Hosts und Orchestratoren werden als JSON im Datenverzeichnis gespeichert (config.json). Tokens werden nicht exportiert.'),
      h('div', { class: 'row' },
        h('button', { onclick: async () => { const f = await call('exportConfig'); if (f) toast('Exportiert: ' + f); } }, 'Exportieren…'),
        h('button', { onclick: async () => { if (await call('importConfig', true)) { toast('Importiert (zusammengeführt)'); reloadConfig(ctx); } } }, 'Importieren (zusammenführen)…'),
        h('button', { onclick: async () => { if (await confirmDialog('Importieren', 'Aktuelle Konfiguration ersetzen?', 'Ersetzen') && await call('importConfig', false)) { toast('Importiert'); reloadConfig(ctx); } } }, 'Importieren (ersetzen)…'),
        h('button', { onclick: () => call('openDataDir') }, 'Datenverzeichnis öffnen'))),
    h('div', { class: 'card' },
      h('h2', null, 'Tastenkürzel'),
      h('table', { class: 'list' }, [
        ['Strg/⌘ + Shift + T', 'Neue Session im aktuellen Projekt'],
        ['Strg/⌘ + 1…9', 'Projekt wechseln'],
        ['Strg/⌘ + Tab', 'Nächste Session'],
        ['Strg/⌘ + Shift + G', 'Kachelansicht umschalten'],
        ['Strg/⌘ + Shift + O', 'Gesamtübersicht'],
        ['Strg/⌘ + Shift + W', 'Session schließen'],
        ['Strg/⌘ + Shift + C / V', 'Kopieren / Einfügen im Terminal'],
      ].map(([k, d]) => h('tr', null, h('td', null, h('span', { class: 'kbd' }, k)), h('td', null, d))))));
  main.appendChild(h('div', { class: 'content' }, page));
}

// ---------- orchestrators ----------
export function renderOrchestrators(ctx, main) {
  const { S } = ctx;
  const list = S.orchestrators;
  if (!S.orchId || !list.find((o) => o.id === S.orchId)) S.orchId = list[0] ? list[0].id : null;
  main.appendChild(h('div', { class: 'main-head' },
    h('span', { class: 'title' }, 'Orchestratoren'),
    h('span', { class: 'muted' }, 'OpenCode im Server-Modus + MCP-Tools der App'),
    h('div', { class: 'spacer' }),
    list.map((o) => h('button', { class: o.id === S.orchId ? 'active' : '', onclick: () => { S.orchId = o.id; ctx.render(); } }, h('span', { class: 'dot ' + orchDot(o), style: { marginRight: '6px' } }), o.name)),
    h('button', { class: 'primary', onclick: () => editOrchestrator(ctx, null) }, '+ Orchestrator')));
  const content = h('div', { class: 'content', id: 'orch-content' });
  main.appendChild(content);
  renderOrchDetail(ctx);
}

const orchDot = (o) => ({ stopped: 'none', starting: 'starting', idle: 'waiting', running: 'working', paused: 'exited', error: 'error' }[o.state] || 'none');
const ORCH_STATE = { stopped: 'gestoppt', starting: 'startet', idle: 'bereit', running: 'arbeitet', paused: 'pausiert', error: 'Fehler' };

function renderOrchDetail(ctx) {
  const { S, call } = ctx;
  const content = document.getElementById('orch-content');
  if (!content) return;
  clear(content);
  const o = S.orchestrators.find((x) => x.id === S.orchId);
  if (!o) {
    content.appendChild(h('div', { class: 'empty' },
      h('div', null, 'Noch kein Orchestrator.'),
      h('div', { class: 'muted', style: { maxWidth: '520px', textAlign: 'center' } }, 'Ein Orchestrator ist ein OpenCode-Agent mit System-Prompt, der überwachte Sessions über die MCP-Tools steuert, z. B. Entwickler + Reviewer. Wird eine überwachte Session fertig, bekommt er automatisch eine Nachricht mit dem letzten Output.'),
      h('button', { class: 'primary', onclick: () => editOrchestrator(ctx, null) }, '+ Orchestrator anlegen')));
    return;
  }
  const running = o.state !== 'stopped' && o.state !== 'error';
  const watchedLabels = (o.watched || []).map((k) => {
    const [pid, name] = k.split('/');
    const p = ctx.project(pid);
    const s = [...S.sessions.values()].find((x) => x.projectId === pid && x.name === name);
    return h('span', { class: 'tag', title: s ? ctx.STATUS_LABEL[s.status] : 'nicht aktiv' }, h('span', { class: 'dot ' + (s ? s.status : 'none'), style: { width: '7px', height: '7px', marginRight: '4px' } }), `${p ? p.name : '?'}/${name}`);
  });
  const status = h('div', { class: 'chat-status' },
    h('span', { class: 'dot ' + orchDot(o) }),
    h('b', null, ORCH_STATE[o.state] || o.state),
    o.currentAction ? h('span', { class: 'muted' }, '· ' + o.currentAction) : null,
    h('span', { class: 'muted' }, `· Runden ${o.rounds}/${o.maxRounds}`),
    o.queue && o.queue.length ? h('span', { class: 'warn' }, `· ${o.queue.length} Ereignis(se) in Warteschlange`) : null,
    o.error ? h('span', { class: 'bad' }, '· ' + o.error) : null,
    h('span', { class: 'spacer' }),
    !running ? h('button', { class: 'primary', onclick: () => call('orchStart', o.id).catch((e) => toast(e.message, { error: true })) }, '▶ Start') : null,
    running && o.state !== 'paused' ? h('button', { onclick: () => call('orchPause', o.id) }, '⏸ Pause') : null,
    o.state === 'paused' ? h('button', { onclick: () => call('orchResume', o.id) }, '▶ Fortsetzen') : null,
    running ? h('button', { onclick: () => call('orchInterrupt', o.id), title: 'Aktuelle Antwort abbrechen' }, 'Abbrechen') : null,
    running ? h('button', { class: 'danger', onclick: () => call('orchStop', o.id) }, '■ Stopp') : null,
    h('button', { onclick: () => editOrchestrator(ctx, o) }, 'Bearbeiten'));
  const watched = h('div', { class: 'chat-status' }, h('span', { class: 'muted' }, 'Überwacht:'), watchedLabels.length ? watchedLabels : h('span', { class: 'bad' }, 'keine Sessions — unter „Bearbeiten“ auswählen'),
    o.conflicts && o.conflicts.length ? h('span', { class: 'bad' }, 'Konflikt: ' + o.conflicts.map((c) => c.orchestrator).join(', ')) : null,
    o.model ? h('span', { class: 'muted' }, '· Modell ' + o.model) : null);
  const log = h('div', { class: 'chat-log', id: 'orch-log' });
  const ta = h('textarea', { placeholder: running ? 'Aufgabe oder Nachricht an den Orchestrator… (Enter senden)' : 'Orchestrator starten, um Nachrichten zu senden', disabled: !running });
  const sendIt = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    try { await call('orchSend', o.id, text); } catch (e) { toast(e.message, { error: true }); ta.value = text; }
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendIt(); } });
  content.appendChild(h('div', { class: 'chat' }, status, watched, log, h('div', { class: 'chat-input' }, ta, h('button', { class: 'primary', onclick: sendIt, disabled: !running }, 'Senden'))));
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
  const model = h('input', { value: x.model || '', placeholder: 'provider/model, leer = Standardmodell von OpenCode' });
  const rounds = h('input', { type: 'number', value: x.maxRounds, min: 1 });
  const prompt = h('textarea', { style: { height: '220px' } });
  prompt.value = x.systemPrompt;
  const tpl = h('select', { onchange: (e) => { const t = S.templates.find((t) => t.id === e.target.value); if (t) prompt.value = t.prompt; } },
    h('option', { value: '' }, 'Vorlage einsetzen…'), S.templates.map((t) => h('option', { value: t.id }, t.name)));
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
    return h('label', { title: taken ? 'Wird bereits von ' + taken + ' gesteuert' : '' },
      h('input', { type: 'checkbox', 'data-k': k, checked: (x.watched || []).includes(k), disabled: !!taken }),
      h('span', { class: 'dot ' + (s ? s.status : 'none') }), `${p ? p.name : '?'} / ${nm}`,
      s && s.kind === 'agent' ? h('span', { class: 'tag' }, 'agent') : null,
      !s ? h('span', { class: 'muted' }, '(nicht aktiv)') : null,
      taken ? h('span', { class: 'bad' }, `(${taken})`) : null);
  }) : h('div', { class: 'muted' }, 'Keine aktiven Sessions. Öffne zuerst die Sessions, die gesteuert werden sollen.'));
  modal({
    title: o ? 'Orchestrator bearbeiten' : 'Neuer Orchestrator',
    width: '820px',
    body: h('div', { class: 'form' },
      field('Name', name),
      field('Modell', model),
      field('Max. Runden', rounds, 'Nach so vielen Ereignis-Runden ohne Benutzereingabe wird pausiert'),
      field('Überwachte Sessions', checks, 'Eine Session kann nur von einem Orchestrator gleichzeitig gesteuert werden'),
      field('System-Prompt', h('div', null, tpl, h('div', { style: { height: '6px' } }), prompt))),
    extraButtons: o ? [h('button', { class: 'danger', onclick: async () => {
      if (await confirmDialog('Orchestrator löschen', `„${o.name}“ löschen?`, 'Löschen')) { await call('orchRemove', o.id); document.querySelector('.modal-bg')?.remove(); }
    } }, 'Löschen')] : [],
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
