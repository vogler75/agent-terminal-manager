// Editors and secondary pages: project editor, hosts, orchestrators, MCP tokens, audit log, settings.
import { h, clear, toast, modal, field, confirmDialog, fmtTime, timeAgo } from './ui.js';
import { renderMessages, fillStatus } from './chat.js';
import { projectSetupSection } from './agents.js';
import { SCHEMES } from './schemes.js';

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

// Session types selectable per project; ACP agents are stored as {kind: 'acp', acpAgent}.
const SESSION_TYPES = [
  ['terminal', 'Terminal'],
  ['agent', 'OpenCode (server API)'],
  ['acp:opencode', 'OpenCode via ACP'],
  ['acp:copilot', 'GitHub Copilot via ACP'],
  ['acp:custom', 'Other ACP agent (own command)'],
];

// The "Agent command" field depends on the type: program for OpenCode server sessions, program
// override for the built-in ACP agents, or the full command line of another ACP agent.
const AGENT_COMMAND = {
  agent: { label: 'OpenCode command', fallback: 'opencode', hint: (c) => `Started on the target as: ${c} serve` },
  'acp:opencode': { label: 'OpenCode command', fallback: 'opencode', hint: (c) => `Started as: ${c} acp — leave as is to use opencode from the PATH` },
  'acp:copilot': { label: 'Copilot command', fallback: 'copilot', hint: (c) => `Started as: ${c} --acp — leave as is to use copilot from the PATH` },
  'acp:custom': { label: 'ACP command', fallback: '', hint: () => 'Full command line that starts the agent in ACP mode, e.g. my-agent --acp (program and arguments)', suggestions: ['opencode acp', 'copilot --acp'] },
};
const sessionType = (o) => (o && o.kind === 'acp' ? `acp:${o.acpAgent || 'opencode'}` : (o && o.kind) || 'terminal');
const fromSessionType = (v) => (String(v).startsWith('acp:') ? { kind: 'acp', acpAgent: v.slice(4) } : { kind: v || 'terminal', acpAgent: undefined });

// How to turn on the OpenSSH server of a Windows machine and log in with a key.
function windowsSshHelp(hostName, userName) {
  const h1 = hostName || '<host>';
  const u1 = userName || '<user>';
  const code = (text) => h('pre', { class: 'setup-code' }, text);
  modal({
    title: 'Windows machine: set up the SSH server',
    width: 760,
    okText: 'Close',
    cancelText: '',
    body: h('div', { class: 'setup-help' },
      h('p', null, 'Windows 10 and 11 and Windows Server include OpenSSH. With the SSH server running, TermClaw opens a PowerShell on the machine in a real terminal, so console programs and coding agents work.'),
      h('h4', null, '1. On the Windows machine (PowerShell as administrator)'),
      code("Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0\nSet-Service -Name sshd -StartupType 'Automatic'\nStart-Service sshd"),
      h('p', null, 'The installation adds the firewall rule “OpenSSH-Server-In-TCP” (port 22). Check it with:'),
      code("Get-Service sshd\nGet-NetFirewallRule -Name OpenSSH-Server-In-TCP | Select-Object Name, Enabled, Profile"),
      h('p', null, 'If the rule is missing or the network is “Public”:'),
      code("New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22"),
      h('h4', null, '2. Test from this computer'),
      code(`ssh ${u1}@${h1}`),
      h('p', null, 'For a local account use the plain user name; for a domain account user@domain or domain\\user.'),
      h('h4', null, '3. Recommended: log in with a key instead of a password'),
      h('p', null, 'On this computer, if you have no key yet (ssh-keygen keeps it in your .ssh folder):'),
      code('ssh-keygen -t ed25519'),
      h('p', null, 'On the Windows machine the key goes into a different file depending on the account. For a member of the Administrators group (PowerShell as administrator, paste the content of id_ed25519.pub):'),
      code("Add-Content -Path C:\\ProgramData\\ssh\\administrators_authorized_keys -Value '<content of id_ed25519.pub>'\nicacls C:\\ProgramData\\ssh\\administrators_authorized_keys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F'"),
      h('p', null, 'For other accounts, as that user:'),
      code("New-Item -ItemType Directory -Force $HOME\\.ssh | Out-Null\nAdd-Content -Path $HOME\\.ssh\\authorized_keys -Value '<content of id_ed25519.pub>'"),
      h('h4', null, '4. In TermClaw'),
      h('p', null, 'Connection type SSH, Remote system “Windows”. The start directory is a Windows path (C:\\Projects\\app) or ~\\src under the user’s profile. A start command runs in the PowerShell, e.g. claude.'),
      h('p', { class: 'muted' }, 'Common problems: “Connection refused” = sshd not running or firewall (step 1); “Permission denied (publickey)” for an administrator = the key is in the user’s .ssh folder instead of administrators_authorized_keys, or that file has the wrong permissions (step 3).')),
  });
}

export async function editProject(ctx, p) {
  const { S, call } = ctx;
  const [agentsList, skillsInfo] = await Promise.all([call('agentsList'), call('skillsList').catch(() => ({ skills: [] }))]);
  const isNew = !p;
  p = p ? structuredClone(p) : { type: 'local', tmux: S.platform !== 'win32', keepAlive: true, defaultSession: { name: 'shell', command: '', kind: 'terminal' }, terminals: [], commands: [], forwards: [], port: 22 };
  const I = (k, attrs = {}) => h('input', { value: p[k] ?? '', ...attrs });
  const name = I('name', { placeholder: 'e.g. backend' });
  const TYPES = [['local', 'Local'], ['ssh', 'SSH'], ['wsl', 'WSL']];
  const type = h('select', null, TYPES.map(([v, l]) => h('option', { value: v, selected: p.type === v }, l)));
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
  const X11_MODES = S.platform === 'win32'
    ? [['off', 'Off'], ['wsl', 'Through WSL (WSLg)'], ['display', 'Windows X server (VcXsrv, X410)']]
    : [['off', 'Off'], ['display', 'On (ssh -Y)']];
  const x11 = h('select', null, X11_MODES.map(([v, l]) => h('option', { value: v, selected: (p.x11 || 'off') === v }, l)));
  const x11Display = I('x11Display', { placeholder: S.platform === 'win32' ? 'localhost:0.0' : 'DISPLAY of the app' });
  const x11Hint = h('div', { class: 'hint' });
  const remoteOs = h('select', null, [['posix', 'Linux / macOS'], ['windows', 'Windows (OpenSSH server)']].map(([v, l]) => h('option', { value: v, selected: (p.remoteOs || 'posix') === v }, l)));
  const winHelp = h('button', { type: 'button', style: { whiteSpace: 'nowrap' }, title: 'How to set up the SSH server on a Windows machine', onclick: () => windowsSshHelp(host.value.trim(), user.value.trim()) }, 'ⓘ Windows SSH server setup');
  const remoteHint = h('div', { class: 'hint' });
  const auto = h('input', { type: 'checkbox', checked: p.autoReconnect });
  const dockerEnabled = h('input', { type: 'checkbox', checked: p.docker && p.docker.enabled });
  const monitorEnabled = h('input', { type: 'checkbox', checked: p.monitor && p.monitor.enabled });
  const gitCfg = p.git || {};
  const gitEnabled = h('input', { type: 'checkbox', checked: gitCfg.enabled });
  const gitPaths = h('textarea', { rows: 2, placeholder: 'One folder per line; empty = the start directory (or the home directory)' }, gitCfg.paths || '');
  const gitDepth = h('input', { type: 'number', value: gitCfg.depth || 3, min: 1, max: 8, style: { width: '70px' } });
  const dockerCmd = h('input', { value: (p.docker && p.docker.command) || '', placeholder: 'docker', style: { width: '160px' } });
  const thr = h('input', { type: 'number', value: p.thresholdSec ?? '', placeholder: `default (${S.config.settings.defaultThresholdSec || 5} s)`, min: 1 });
  const scheme = h('select', null, h('option', { value: '' }, 'App default'), SCHEMES.map((sc) => h('option', { value: sc.id, selected: p.colorScheme === sc.id }, sc.name)));
  const ls = p.localShell || {};
  const lsShell = h('select', null, h('option', { value: '' }, 'None'), ls.shell ? h('option', { value: ls.shell, selected: true }, ls.shell) : null);
  // Fill in the shells found on this computer (the saved one stays selected even when it is not found).
  call('localShells').then((list) => {
    clear(lsShell);
    lsShell.appendChild(h('option', { value: '' }, 'None'));
    for (const x of list) lsShell.appendChild(h('option', { value: x.id, selected: x.id === ls.shell }, x.label));
    if (ls.shell && !list.some((x) => x.id === ls.shell)) lsShell.appendChild(h('option', { value: ls.shell, selected: true }, ls.shell + ' (not found)'));
  }).catch(() => {});
  const lsDir = h('input', { value: ls.directory || '', placeholder: S.platform === 'win32' ? 'e.g. C:\\work\\project or, for WSL, ~/project' : 'e.g. ~/project' });
  const dsName = h('input', { value: p.defaultSession.name || 'shell' });
  const dsCmd = h('input', { value: p.defaultSession.command || '', placeholder: 'e.g. claude (optional)' });
  const dsKind = h('select', null, SESSION_TYPES.map(([v, l]) => h('option', { value: v, selected: sessionType(p.defaultSession) === v }, l)));
  // One input, one stored value per type (switching the type keeps what was typed for the other one).
  const acpCmds = p.acpCommands || {};
  const cmdValues = {
    agent: p.agentCommand || 'opencode',
    'acp:opencode': acpCmds.opencode || 'opencode',
    'acp:copilot': acpCmds.copilot || 'copilot',
    'acp:custom': acpCmds.custom || '',
  };
  const cmdList = h('datalist', { id: 'agent-cmd-suggestions' });
  const agentCmd = h('input', { list: 'agent-cmd-suggestions' });
  const agentCmdLabel = h('label', null, 'Agent command');
  const agentCmdHint = h('div', { class: 'hint' });
  let cmdType = null;
  const syncAgentCmd = () => {
    if (cmdType && AGENT_COMMAND[cmdType]) cmdValues[cmdType] = agentCmd.value.trim();
    cmdType = dsKind.value;
    const def = AGENT_COMMAND[cmdType];
    [agentCmdLabel, agentCmd, agentCmdHint].forEach((e) => (e.style.display = def ? '' : 'none'));
    if (!def) return;
    agentCmdLabel.textContent = def.label;
    agentCmd.value = cmdValues[cmdType] || def.fallback;
    agentCmd.placeholder = def.fallback || 'command line';
    clear(cmdList);
    for (const sgt of def.suggestions || [def.fallback]) cmdList.appendChild(h('option', { value: sgt }));
    agentCmdHint.textContent = def.hint(agentCmd.value || def.fallback || '…');
  };
  agentCmd.addEventListener('input', () => { const def = AGENT_COMMAND[cmdType]; if (def) agentCmdHint.textContent = def.hint(agentCmd.value || def.fallback || '…'); });
  const terms = rowsEditor((p.terminals || []).map((t) => ({ ...t, kind: sessionType(t) })), [{ key: 'name', placeholder: 'Name', small: true }, { key: 'command', placeholder: 'Start command (optional)' }, { key: 'kind', options: SESSION_TYPES }]);
  const cmds = rowsEditor(p.commands, [{ key: 'name', placeholder: 'Name, e.g. Start agent', small: false }, { key: 'command', placeholder: 'Command, e.g. claude --continue' }]);
  const fwds = rowsEditor(p.forwards, [{ key: 'local', placeholder: 'local', small: true, type: 'number' }, { key: 'remote', placeholder: 'remote', small: true, type: 'number' }, { key: 'remoteHost', placeholder: 'Target host (default localhost)' }]);

  // A default session name follows the chosen type until the user picks an own name.
  const DEFAULT_NAMES = { terminal: 'shell', agent: 'agent', 'acp:opencode': 'opencode', 'acp:copilot': 'copilot', 'acp:custom': 'acp-agent' };
  dsKind.addEventListener('change', () => {
    if (Object.values(DEFAULT_NAMES).includes(dsName.value.trim())) dsName.value = DEFAULT_NAMES[dsKind.value] || dsName.value;
    syncAgentCmd();
  });
  syncAgentCmd();
  const agentSection = projectSetupSection(ctx, p, agentsList, skillsInfo.skills);
  const sshOnly = [];
  const inlineOnly = [];
  const hostUserOnly = [];
  const posixOnly = [];
  const wslOnly = [];
  const displayOnly = [];
  const x11Only = [];
  const grp = (arr, ...els) => { arr.push(...els.filter(Boolean)); return els; };
  const form = h('div', { class: 'form' },
    field('Name', name),
    field('Connection type', type),
    grp(sshOnly, ...field('Developer host', hostSel, 'Projects reference a host from the host directory')),
    grp(hostUserOnly, ...field('Host', host)),
    grp(hostUserOnly, ...field('User', user)),
    grp(inlineOnly, ...field('Port', port)),
    grp(sshOnly, h('label', null, 'Remote system'), h('div', null, h('div', { class: 'row' }, remoteOs, winHelp), remoteHint)),
    grp(wslOnly, ...field('WSL distribution', distro)),
    field('Start directory', dir, 'Empty = the host’s workspace folder or the home directory'),
    grp(posixOnly, ...field('tmux', h('label', { class: 'row' }, tmux, 'One named tmux session per terminal (attach or create); agents keep running when the connection drops'))),
    grp(sshOnly, ...field('Keep-alive', h('div', { class: 'row' }, keep, h('span', { class: 'muted' }, 'ServerAliveInterval'), keepInt, h('span', { class: 'muted' }, 'CountMax'), keepMax))),
    grp(x11Only, h('label', null, 'X11 forwarding'), h('div', null, x11, x11Hint)),
    grp(displayOnly, ...field('X display', x11Display)),
    field('Auto-reconnect', h('label', { class: 'row' }, auto, 'Reconnect automatically when the connection drops')),
    ...field('Terminal colors', scheme, 'Color scheme for this project’s terminals, e.g. to tell production machines apart; single sessions can override it (session menu)'),
    grp(posixOnly, ...field('Docker', h('div', { class: 'row' }, h('label', { class: 'row' }, dockerEnabled, 'Docker tab: containers, logs, shell, images, volumes'), h('span', { class: 'muted' }, 'CLI'), dockerCmd),
      'Uses the Docker CLI on the project machine (docker system dial-stdio; no port is opened). The user must be allowed to use Docker, e.g. in the docker group.')),
    grp(posixOnly, ...field('Monitor', h('label', { class: 'row' }, monitorEnabled, 'Monitor tab: CPU, memory, disk and network I/O, disk usage per mount, programs'),
      'For Linux machines (SSH, WSL or local Linux). Reads /proc over one connection while the tab is open; nothing is installed on the machine.')),
    grp(posixOnly, ...field('Git', h('div', null,
      h('label', { class: 'row' }, gitEnabled, 'Git tab: changed files, diff, commit, push and pull, branches, history'),
      h('div', { class: 'row', style: { marginTop: '6px', alignItems: 'flex-start' } }, gitPaths, h('span', { class: 'muted', style: { whiteSpace: 'nowrap', paddingTop: '6px' } }, 'depth'), gitDepth)),
      'Searches these folders on the project machine for git repositories (.git), skipping hidden folders and node_modules. Uses the git command there; push and pull need keys or credentials that work without a prompt.')),
    field('Status threshold (s)', thr, 'No output for longer than this → green dot (waiting)'),
    h('h3', { class: 'full' }, 'Default session (plus button)'),
    field('Name', dsName),
    field('Start command', dsCmd),
    field('Type', dsKind),
    agentCmdLabel, h('div', null, agentCmd, cmdList), agentCmdHint,
    h('h3', { class: 'full' }, 'Local shell (Session ▾ menu)'),
    field('Shell', lsShell, 'A shell on this computer next to the project’s sessions, e.g. PowerShell or WSL for an SSH project. All shells found here are also in the menu, started in the home directory.'),
    field('Directory', lsDir, 'Empty = home directory'),
    h('h3', { class: 'full' }, 'Terminals (“Start all”)'),
    h('div', { class: 'full' }, terms.el),
    h('h3', { class: 'full' }, 'Saved commands'),
    h('div', { class: 'full' }, cmds.el),
    grp(sshOnly, h('h3', { class: 'full' }, 'Port forwarding (local port → remote port)')),
    grp(sshOnly, h('div', { class: 'full' }, fwds.el)),
    ...agentSection.elements);

  const sync = () => {
    const t = type.value;
    sshOnly.forEach((e) => (e.style.display = t === 'ssh' ? '' : 'none'));
    inlineOnly.forEach((e) => (e.style.display = t === 'ssh' && !hostSel.value ? '' : 'none'));
    const win = t === 'ssh' && remoteOs.value === 'windows';
    hostUserOnly.forEach((e) => (e.style.display = t === 'ssh' && !hostSel.value ? '' : 'none'));
    posixOnly.forEach((e) => (e.style.display = win ? 'none' : ''));
    remoteHint.textContent = win ? 'Sessions open a PowerShell on the machine (works with cmd or PowerShell as the server’s default shell). Coding agents are installed with the Windows installers. tmux, Docker, Monitor, Git, the file browser and agent sessions need Linux or macOS and are hidden.' : '';
    wslOnly.forEach((e) => (e.style.display = t === 'wsl' || (t === 'ssh' && x11.value === 'wsl') ? '' : 'none'));
    x11Only.forEach((e) => (e.style.display = t === 'ssh' && !win ? '' : 'none'));
    displayOnly.forEach((e) => (e.style.display = t === 'ssh' && !win && x11.value === 'display' ? '' : 'none'));
    x11Hint.textContent = {
      off: '',
      wsl: 'The session runs the ssh client of the WSL distribution above (empty = default) (its ~/.ssh keys and known_hosts); remote windows open through WSLg. File transfer and port forwarding still use the Windows ssh client. The server needs X11Forwarding yes and xauth.',
      display: 'Runs ssh -Y; an X server must be running locally. The server needs X11Forwarding yes and xauth.',
    }[x11.value];
  };
  type.addEventListener('change', sync);
  x11.addEventListener('change', sync);
  hostSel.addEventListener('change', sync);
  remoteOs.addEventListener('change', sync);
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
      if (dsKind.value === 'acp:custom' && !agentCmd.value.trim()) throw new Error('ACP command is missing (e.g. my-agent --acp)');
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
        remoteOs: type.value === 'ssh' ? remoteOs.value : 'posix',
        tmux: type.value === 'ssh' && remoteOs.value === 'windows' ? false : tmux.checked,
        keepAlive: keep.checked,
        keepAliveInterval: Number(keepInt.value) || 30,
        keepAliveCountMax: Number(keepMax.value) || 3,
        x11: x11.value,
        x11Display: x11Display.value.trim(),
        autoReconnect: auto.checked,
        colorScheme: scheme.value,
        docker: { enabled: dockerEnabled.checked, command: dockerCmd.value.trim() },
        monitor: { enabled: monitorEnabled.checked },
        git: { enabled: gitEnabled.checked, paths: gitPaths.value.trim(), depth: Math.max(1, Math.min(8, Number(gitDepth.value) || 3)) },
        localShell: { shell: lsShell.value, directory: lsDir.value.trim() },
        thresholdSec: thr.value ? Number(thr.value) : null,
        defaultSession: { name: dsName.value.trim() || 'shell', command: dsCmd.value.trim(), ...fromSessionType(dsKind.value) },
        ...(() => {
          syncAgentCmd(); // store what is typed for the current type
          const keep = (v, def) => (v && v !== def ? v : undefined);
          return {
            agentCommand: cmdValues.agent || 'opencode',
            acpCommands: {
              opencode: keep(cmdValues['acp:opencode'], 'opencode'),
              copilot: keep(cmdValues['acp:copilot'], 'copilot'),
              custom: cmdValues['acp:custom'] || undefined,
            },
          };
        })(),
        terminals: terms.get().map((t) => ({ ...t, name: t.name || 'term', ...fromSessionType(t.kind) })),
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
      h('p', { class: 'muted' }, 'Streamable HTTP at ', h('code', null, localUrl), '. Local clients send ', h('code', null, 'Authorization: Bearer <token>'), ' with a token below; web clients such as claude.ai sign in with OAuth (see below). For access from outside, publish the port through a reverse proxy or tunnel with HTTPS — see docs/nginx.conf. External requests are logged.')),
    oauthCard(ctx),
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
      h('p', null, 'claude.ai (web, desktop, mobile): turn on OAuth sign-in above, then Customize → Connectors → Add custom connector with the public URL ', h('code', null, cfg.publicUrl || 'https://<your host>/mcp'), '. Built-in mode: leave the OAuth client fields empty and approve the sign-in in this app. External provider: enter its client id under Advanced settings if it has no automatic registration.'),
      h('p', null, 'Claude Code (HTTP):'),
      h('pre', { class: 'secret' }, `claude mcp add --transport http termclaw ${localUrl} --header "Authorization: Bearer <token>"`),
      h('p', null, 'Clients that only support stdio (e.g. Claude Desktop) via the bridge:'),
      h('pre', { class: 'secret' }, JSON.stringify({ mcpServers: { termclaw: { command: 'node', args: [S.stdioBridge || 'termclaw-mcp-stdio.js', localUrl], env: { TERMCLAW_MCP_TOKEN: '<token>' } } } }, null, 2))));
  renderTokens();
}

// OAuth sign-in for web clients (claude.ai cannot send a fixed Authorization header).
function oauthCard(ctx) {
  const { S, call } = ctx;
  const cfg = S.config.settings.mcp || {};
  const publicUrl = h('input', { value: cfg.publicUrl || '', placeholder: 'https://termclaw.example.com/mcp' });
  const grantsBox = h('div');
  const renderGrants = async () => {
    const grants = await call('oauthGrants');
    clear(grantsBox);
    if (!grants.length) { grantsBox.appendChild(h('div', { class: 'muted' }, 'No sign-ins yet.')); return; }
    grantsBox.appendChild(h('table', { class: 'list' },
      h('tr', null, ['Client', 'Returns to', 'Access', 'Approved', 'Last used', 'Status', ''].map((t) => h('th', null, t))),
      grants.map((g) => h('tr', null,
        h('td', null, g.clientName),
        h('td', { class: 'mono' }, g.redirectHost),
        h('td', null, g.readOnly ? 'read-only' : 'full'),
        h('td', null, fmtTime(g.created)),
        h('td', null, g.lastUsed ? timeAgo(g.lastUsed) + ' ago' : '–'),
        h('td', null, g.revoked ? h('span', { class: 'bad' }, 'revoked') : h('span', { class: 'ok' }, 'active')),
        h('td', null, h('div', { class: 'row' },
          !g.revoked ? h('button', { onclick: async () => { await call('oauthRevoke', g.id); renderGrants(); } }, 'Revoke') : null,
          h('button', { class: 'icon danger', title: 'Delete', onclick: async () => { await call('oauthDelete', g.id); renderGrants(); } }, '✕')))))));
  };
  renderGrants();
  const mode = h('select', null,
    h('option', { value: 'builtin', selected: cfg.oauthMode !== 'external' }, 'Built-in — the app signs clients in; you approve each sign-in here'),
    h('option', { value: 'external', selected: cfg.oauthMode === 'external' }, 'External identity provider — authentik, Keycloak, Entra ID, …'));
  const inp = (key, placeholder, def = '') => h('input', { value: cfg[key] ?? def, placeholder });
  const issuer = inp('oauthIssuer', 'https://auth.example.com/application/o/termclaw/');
  const audience = inp('oauthAudience', 'client id of the provider application');
  const groupsClaim = inp('oauthGroupsClaim', 'groups', 'groups');
  const allowedGroup = inp('oauthAllowedGroup', 'empty = every user of the application');
  const fullGroup = inp('oauthFullGroup', 'empty = full access for everybody');
  const scopes = inp('oauthScopes', 'openid profile email', 'openid profile email');
  const testOut = h('div', { class: 'full muted', style: { fontSize: '12px', whiteSpace: 'pre-wrap' } });
  const builtinBox = h('div', null,
    h('p', { class: 'muted' }, 'The app is its own OAuth server (discovery metadata, client registration, PKCE, refresh tokens). In claude.ai leave the OAuth client fields empty; the sign-in shows up here for approval.'),
    h('div', { style: { marginTop: '10px' } }, grantsBox));
  const externalBox = h('div', null,
    h('div', { class: 'form' },
      field('Issuer URL', issuer, 'The provider’s issuer (authentik: OpenID Configuration Issuer of the OAuth2 provider)'),
      field('Allowed client ids / audience', audience, 'Tokens must name one of these in aud or azp (authentik: the provider’s Client ID); comma separated'),
      field('Group claim', groupsClaim, 'authentik / Entra: groups · Keycloak: realm_access.roles'),
      field('Required group', allowedGroup),
      field('Group with full access', fullGroup, 'Other users get read-only access'),
      field('Scopes', scopes, 'Requested by the client at sign-in'),
      h('div', { class: 'full row' }, h('button', { onclick: async () => {
        testOut.textContent = 'Testing…';
        try {
          const t = await call('oauthTestIssuer', issuer.value.trim());
          testOut.textContent = `✓ ${t.issuer} · ${t.keys} signing key(s) · PKCE S256: ${t.pkce ? 'yes' : 'no'}\n` +
            (t.registration || t.cimd ? 'Clients can register automatically.' : 'No automatic client registration: in claude.ai open Advanced settings and enter the Client ID (and secret) of the provider application.');
        } catch (e) { testOut.textContent = '✗ ' + e.message; }
      } }, 'Test provider')),
      testOut),
    h('p', { class: 'muted' }, 'In the provider create an OAuth2/OpenID application for the client with redirect URI https://claude.ai/api/mcp/auth_callback (Claude Code: http://localhost/callback, any port), signing with RS256/ES256 and JWT access tokens. The provider must be reachable from the internet as well. Access is ended in the provider; tokens expire on their own.'));
  const showMode = () => { builtinBox.style.display = mode.value === 'external' ? 'none' : ''; externalBox.style.display = mode.value === 'external' ? '' : 'none'; };
  mode.onchange = showMode;
  showMode();
  return h('div', { class: 'card' },
    h('h2', null, 'OAuth sign-in (claude.ai and other web clients)'),
    h('label', { class: 'row', style: { color: 'var(--fg)' } },
      h('input', { type: 'checkbox', checked: !!cfg.oauth, onchange: async (e) => { await call('updateSettings', { mcp: { oauth: e.target.checked } }); reloadConfig(ctx); } }),
      'Allow OAuth sign-in'),
    h('div', { class: 'form', style: { marginTop: '8px' } },
      field('Authorization server', mode),
      field('Public URL', publicUrl, 'The MCP URL as the client reaches it through your HTTPS reverse proxy or tunnel. Enter exactly this URL in the client. Empty = derived from the request.')),
    builtinBox,
    externalBox,
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('div', { class: 'spacer' }), h('button', { class: 'primary', onclick: async () => {
      const v = publicUrl.value.trim();
      if (v && !/^https:\/\/[^\s/]+(\/\S*)?\/mcp$/.test(v)) { toast('Public URL: use an https URL that ends with /mcp', { error: true }); return; }
      const patch = { publicUrl: v, oauthMode: mode.value };
      if (mode.value === 'external') {
        if (!/^https:\/\//.test(issuer.value.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(issuer.value.trim())) { toast('Issuer: use an https URL', { error: true }); return; }
        if (!audience.value.trim()) { toast('Enter the allowed client id(s) / audience', { error: true }); return; }
        Object.assign(patch, { oauthIssuer: issuer.value.trim(), oauthAudience: audience.value.trim(), oauthGroupsClaim: groupsClaim.value.trim() || 'groups', oauthAllowedGroup: allowedGroup.value.trim(), oauthFullGroup: fullGroup.value.trim(), oauthScopes: scopes.value.trim() || 'openid profile email' });
      }
      await call('updateSettings', { mcp: patch }); reloadConfig(ctx); toast('Saved');
    } }, 'Apply')),
    h('p', { class: 'muted' }, 'claude.ai connects from Anthropic’s servers, so the public URL must be reachable from the internet over HTTPS. Serve it on its own host name; the proxy must pass /.well-known/ and /oauth/ as well as /mcp.'));
}

// Sign-in request from an OAuth client: the user decides here, the client's browser page waits.
const oauthDialogs = new Map();
export function oauthApproval(ctx, r) {
  if (oauthDialogs.has(r.id)) return;
  let readOnly = !/mcp:full/.test(r.scope || '');
  const opt = (value, label) => h('label', { class: 'row', style: { color: 'var(--fg)' } },
    h('input', { type: 'radio', name: 'oauth-access-' + r.id, checked: readOnly === value, onchange: () => { readOnly = value; } }), label);
  const dlg = modal({
    title: 'MCP sign-in request',
    body: h('div', null,
      h('p', null, h('b', null, r.clientName), ' wants to access this app’s MCP server.'),
      h('table', { class: 'list' },
        h('tr', null, h('td', null, 'Returns to'), h('td', { class: 'mono' }, r.redirectHost)),
        h('tr', null, h('td', null, 'Client id'), h('td', { class: 'mono', style: { wordBreak: 'break-all' } }, r.clientId)),
        h('tr', null, h('td', null, 'Request from'), h('td', { class: 'mono' }, r.remote || '–'))),
      h('p', { class: 'muted' }, 'Approve only if you just started this sign-in yourself (e.g. adding a connector in claude.ai). The client sees the shared sessions and may use the tools allowed under Permissions.'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        opt(true, 'Read-only (list and read sessions)'),
        opt(false, 'Full access (send prompts, open sessions, … as allowed under Permissions)'))),
    okText: 'Approve',
    cancelText: 'Deny',
    onOk: () => { oauthDialogs.delete(r.id); return ctx.call('oauthDecide', r.id, { approve: true, readOnly }).then(() => toast(`Signed in: ${r.clientName}`)); },
    onCancel: () => { if (oauthDialogs.delete(r.id)) ctx.call('oauthDecide', r.id, { approve: false }); },
  });
  oauthDialogs.set(r.id, dlg);
}

// Request expired or decided elsewhere: close its dialog without answering again.
export function oauthDecided(ctx, id) {
  const dlg = oauthDialogs.get(id);
  if (!dlg) return;
  oauthDialogs.delete(id);
  dlg.close();
  if (ctx.S.view === 'mcp') ctx.render();
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
  const scheme = h('select', null, SCHEMES.map((sc) => h('option', { value: sc.id, selected: (st.terminalScheme || 'default') === sc.id }, sc.name)));
  const contrast = h('input', { type: 'checkbox', checked: !!st.terminalContrast });
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
        field('Terminal colors', scheme, 'Projects and single sessions can use another scheme (project editor, session menu)'),
        field('Contrast', h('label', { class: 'row' }, contrast, 'Increase contrast: adjust text colors that are hard to read on their background (e.g. blue on green)')),
        field('Notifications', h('label', { class: 'row' }, notif, 'Desktop notification when a session switches to “waiting”')),
        field('OpenCode program', h('div', { class: 'row' }, oc, h('button', { onclick: async () => { const p = await call('detectOpencode'); ocInfo.textContent = p ? 'found: ' + p : 'not found'; } }, 'Detect')), null),
        h('div', { class: 'hint' }, ocInfo),
        h('div', { class: 'full row' }, h('div', { class: 'spacer' }), h('button', { class: 'primary', onclick: async () => {
          await call('updateSettings', { defaultThresholdSec: Number(thr.value) || 5, fontSize: Number(fs.value) || 13, overviewFontSize: Number(ofs.value) || null, terminalScheme: scheme.value, terminalContrast: contrast.checked, notifications: notif.checked, opencodePath: oc.value.trim() });
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
