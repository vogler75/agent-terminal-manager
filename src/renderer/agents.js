// Coding agents UI: MCP/skills library page, project setup section, install/deploy menu and report.
import { h, clear, toast, modal, field, confirmDialog, contextMenu, fmtTime } from './ui.js';

const lines = (t) => String(t || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const kvParse = (t, sep) => Object.fromEntries(lines(t).map((l) => {
  const i = l.indexOf(sep);
  return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null;
}).filter(Boolean));
const kvFormat = (o, sep) => Object.entries(o || {}).map(([k, v]) => `${k}${sep}${v}`).join('\n');

// ---------- library page ----------
export function renderLibrary(ctx, main) {
  main.appendChild(h('div', { class: 'main-head' },
    h('span', { class: 'title' }, 'Library'),
    h('span', { class: 'muted' }, 'MCP servers and skills that projects can deploy to their coding agents')));
  const page = h('div', { class: 'page page-narrow', id: 'library-page' });
  main.appendChild(h('div', { class: 'content' }, page));
  fillLibrary(ctx, page);
}

async function fillLibrary(ctx, page) {
  const { S, call } = ctx;
  clear(page);
  const lib = S.config.mcpLibrary || [];
  const mcpCard = h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'MCP servers'), h('div', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: () => editServer(ctx, null, () => fillLibrary(ctx, page)) }, '+ MCP server')),
    lib.length ? h('table', { class: 'list', style: { marginTop: '10px' } },
      h('tr', null, ['Name', 'Type', 'Command / URL', 'Secrets', ''].map((t) => h('th', null, t))),
      lib.map((e) => h('tr', null,
        h('td', null, h('b', null, e.name)),
        h('td', null, e.type === 'http' ? 'HTTP' : 'stdio'),
        h('td', { class: 'mono' }, e.type === 'http' ? e.url : [e.command, ...(e.args || [])].join(' ')),
        h('td', { class: 'muted' }, [...(e.envKeys || []).map((k) => '$' + k), ...(e.headerKeys || [])].join(', ') || '–'),
        h('td', null, h('div', { class: 'row' },
          h('button', { class: 'icon', title: 'Edit', onclick: () => editServer(ctx, e, () => fillLibrary(ctx, page)) }, '✎'),
          h('button', { class: 'icon danger', title: 'Delete', onclick: async () => {
            if (await confirmDialog('Delete MCP server', `Delete “${e.name}” from the library? Projects stop deploying it.`, 'Delete')) { await call('libraryDelete', e.id); await reload(ctx); fillLibrary(ctx, page); }
          } }, '✕')))))) : h('p', { class: 'muted' }, 'No MCP servers yet.'),
    h('p', { class: 'muted' }, 'Environment variables and headers are stored encrypted with the operating system keychain. On deploy they are written in clear text into the agents’ config files on the target machine, because the agents need them there.'));

  const skillsBox = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
  const skillsCard = h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Skills'), h('div', { class: 'spacer' }),
      h('button', { onclick: () => newSkill(ctx, () => fillLibrary(ctx, page)) }, '+ New skill'),
      h('button', { onclick: async () => { try { const r = await call('skillsImport'); if (r) { toast('Imported: ' + r.join(', ')); fillLibrary(ctx, page); } } catch (e) { toast(e.message, { error: true }); } } }, 'Import folder…'),
      h('button', { onclick: () => call('skillsOpenDir') }, 'Open folder'),
      h('button', { title: 'Use another folder, e.g. a git clone of your skills repository', onclick: async () => { if (await call('skillsChooseDir')) { await reload(ctx); fillLibrary(ctx, page); } } }, 'Change folder…'),
      h('button', { class: 'icon', title: 'Rescan', onclick: () => fillLibrary(ctx, page) }, '↻')),
    skillsBox);
  const apmLib = S.config.apmLibrary || [];
  const apmCard = h('div', { class: 'card' },
    h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'APM packages'), h('div', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: () => editApm(ctx, null, () => fillLibrary(ctx, page)) }, '+ APM package')),
    apmLib.length ? h('table', { class: 'list', style: { marginTop: '10px' } },
      h('tr', null, ['Package', 'Description', ''].map((t) => h('th', null, t))),
      apmLib.map((e) => h('tr', null,
        h('td', { class: 'mono' }, e.ref),
        h('td', null, e.description || h('span', { class: 'muted' }, '–')),
        h('td', null, h('div', { class: 'row' },
          h('button', { class: 'icon', title: 'Edit', onclick: () => editApm(ctx, e, () => fillLibrary(ctx, page)) }, '✎'),
          h('button', { class: 'icon danger', title: 'Delete', onclick: async () => {
            if (await confirmDialog('Delete APM package', `Remove “${e.ref}” from the library? Projects uninstall it on their next deploy.`, 'Delete')) { await call('apmLibraryDelete', e.id); await reload(ctx); fillLibrary(ctx, page); }
          } }, '✕')))))) : h('p', { class: 'muted' }, 'No APM packages yet.'),
    h('p', { class: 'muted' }, 'APM (Agent Package Manager, github.com/microsoft/apm) installs packages of skills, prompts, instructions, agents and MCP servers from Git repositories into each agent’s own folders and pins them in apm.lock.yaml. Select packages per project; Deploy installs them with APM on the project machine, “APM: update packages” moves them to newer versions.'));
  page.append(mcpCard, skillsCard, apmCard);

  const { dir, skills } = await call('skillsList');
  clear(skillsBox);
  skillsBox.append(
    h('p', { class: 'muted' }, 'Repository folder: ', h('code', null, dir), ' — one sub-folder per skill with a SKILL.md (Agent Skills format). It can be a git clone; pull it and press Update in the projects to deploy again.'),
    skills.length ? h('table', { class: 'list' },
      h('tr', null, ['Skill', 'Description', 'Files'].map((t) => h('th', null, t))),
      skills.map((s) => h('tr', null,
        h('td', null, h('b', null, s.name)),
        h('td', null, s.description || h('span', { class: 'muted' }, 'no description'), s.error ? h('div', { class: 'bad' }, s.error) : null),
        h('td', { class: 'muted' }, String((s.files || []).length))))) : h('p', { class: 'muted' }, 'No skills found in this folder.'));
}

async function reload(ctx) {
  const st = await ctx.call('getState');
  ctx.S.config = st.config;
}

async function editServer(ctx, entry, after) {
  const { call } = ctx;
  const e = entry ? await call('libraryGet', entry.id) : { type: 'stdio', args: [], env: {}, headers: {} };
  const name = h('input', { value: e.name || '', placeholder: 'e.g. github' });
  const type = h('select', null, [['stdio', 'stdio (local command)'], ['http', 'HTTP (remote URL)']].map(([v, l]) => h('option', { value: v, selected: e.type === v }, l)));
  const command = h('input', { value: e.command || '', placeholder: 'e.g. npx' });
  const args = h('textarea', { style: { height: '70px' }, placeholder: 'one argument per line, e.g.\n-y\n@modelcontextprotocol/server-github' });
  args.value = (e.args || []).join('\n');
  const env = h('textarea', { style: { height: '60px' }, placeholder: 'KEY=value, one per line' });
  env.value = kvFormat(e.env, '=');
  const url = h('input', { value: e.url || '', placeholder: 'https://example.com/mcp' });
  const headers = h('textarea', { style: { height: '60px' }, placeholder: 'Header: value, one per line' });
  headers.value = kvFormat(e.headers, ': ');
  const stdioRows = [];
  const httpRows = [];
  const grp = (arr, ...els) => { arr.push(...els.filter(Boolean)); return els; };
  const form = h('div', { class: 'form' },
    field('Name', name, 'Used as the server name in every agent'),
    field('Type', type),
    grp(stdioRows, ...field('Command', command)),
    grp(stdioRows, ...field('Arguments', args)),
    grp(stdioRows, ...field('Environment', env, 'Stored encrypted')),
    grp(httpRows, ...field('URL', url)),
    grp(httpRows, ...field('Headers', headers, 'Stored encrypted, e.g. Authorization: Bearer …')));
  const sync = () => {
    stdioRows.forEach((x) => (x.style.display = type.value === 'stdio' ? '' : 'none'));
    httpRows.forEach((x) => (x.style.display = type.value === 'http' ? '' : 'none'));
  };
  type.addEventListener('change', sync);
  sync();
  modal({
    title: entry ? `Edit MCP server “${entry.name}”` : 'New MCP server',
    body: form,
    onOk: async () => {
      if (!name.value.trim()) throw new Error('Name is missing');
      if (type.value === 'stdio' && !command.value.trim()) throw new Error('Command is missing');
      if (type.value === 'http' && !/^https?:\/\//.test(url.value.trim())) throw new Error('URL must start with http:// or https://');
      await call('librarySave', {
        id: e.id, name: name.value.trim(), type: type.value,
        command: command.value.trim(), args: lines(args.value), env: kvParse(env.value, '='),
        url: url.value.trim(), headers: kvParse(headers.value, ':'),
      });
      await reload(ctx);
      after && after();
    },
  });
}

function editApm(ctx, entry, after) {
  const ref = h('input', { value: entry ? entry.ref : '', placeholder: 'owner/repo[/path][#ref], e.g. microsoft/apm-sample-package#v1.0.0' });
  const desc = h('input', { value: entry ? entry.description : '', placeholder: 'What the package contains (optional)' });
  modal({
    title: entry ? 'Edit APM package' : 'New APM package',
    body: h('div', { class: 'form' },
      ...field('Package', ref, 'GitHub owner/repo, optional sub-path and #tag/#commit; plugin@marketplace; or an https Git URL'),
      ...field('Description', desc)),
    onOk: async () => {
      await ctx.call('apmLibrarySave', { id: entry && entry.id, ref: ref.value, description: desc.value });
      await reload(ctx);
      after && after();
    },
  });
}

// Runs an APM action on the project machine and shows its output.
async function apmAction(ctx, p, action) {
  const labels = { outdated: 'Checking APM packages for updates', update: 'Updating APM packages', list: 'Listing APM packages', 'self-update': 'Updating the APM CLI' };
  const t = toast(`${labels[action]} on ${p.name}…`, { ms: 900000 });
  try {
    const r = await ctx.call('apmAction', p.id, action);
    modal({
      title: `${{ outdated: 'APM package updates', update: 'APM packages updated', list: 'Installed APM packages', 'self-update': 'APM CLI update' }[action]}${r.ok ? '' : ' — failed'}`,
      okText: null, cancelText: 'Close', width: '900px',
      body: h('div', null, h('p', { class: 'muted mono' }, r.command), h('pre', { class: 'tool-pre', style: { maxHeight: '420px' } }, r.output || '(no output)')),
    });
  } catch (e) {
    toast(e.message, { error: true, ms: 8000 });
  } finally { t && t.remove && t.remove(); }
}

function newSkill(ctx, after) {
  const name = h('input', { placeholder: 'e.g. code-review' });
  const desc = h('input', { placeholder: 'When should the agent use this skill?' });
  modal({
    title: 'New skill',
    body: h('div', { class: 'form' }, field('Name', name, 'Folder name: letters, digits, dot, dash, underscore'), field('Description', desc)),
    okText: 'Create and open',
    onOk: async () => { await ctx.call('skillsCreate', name.value.trim(), desc.value.trim()); after && after(); },
  });
}

// ---------- project editor section ----------
// Returns {elements, get()} to embed in the project form.
export function projectSetupSection(ctx, p, agentsList, skillsList) {
  const { S } = ctx;
  const setup = { scope: 'project', agents: 'auto', mcp: [], skills: [], ...(p.agentSetup || {}) };
  const scope = h('select', null, [['project', 'Project folder (recommended)'], ['user', 'User (home directory, all projects on this machine)']].map(([v, l]) => h('option', { value: v, selected: setup.scope === v }, l)));
  const agentsMode = h('select', null, [['auto', 'All installed agents'], ['pick', 'Only selected agents']].map(([v, l]) => h('option', { value: v, selected: (setup.agents === 'auto') === (v === 'auto') }, l)));
  const agentChecks = h('div', { class: 'checklist', style: { maxHeight: '150px' } }, agentsList.map((a) => h('label', null,
    h('input', { type: 'checkbox', 'data-k': a.id, checked: Array.isArray(setup.agents) && setup.agents.includes(a.id) }), a.name)));
  const lib = S.config.mcpLibrary || [];
  const mcpChecks = h('div', { class: 'checklist', style: { maxHeight: '150px' } }, lib.length ? lib.map((e) => h('label', null,
    h('input', { type: 'checkbox', 'data-k': e.id, checked: setup.mcp.includes(e.id) }), e.name, h('span', { class: 'muted' }, e.type === 'http' ? e.url : e.command))) : h('div', { class: 'muted' }, 'No MCP servers in the library yet (Library page).'));
  const skillChecks = h('div', { class: 'checklist', style: { maxHeight: '150px' } }, skillsList.length ? skillsList.map((s) => h('label', { title: s.description },
    h('input', { type: 'checkbox', 'data-k': s.name, checked: setup.skills.includes(s.name) }), s.name, h('span', { class: 'muted' }, s.description.slice(0, 80)))) : h('div', { class: 'muted' }, 'No skills in the repository yet (Library page).'));
  const apmLib = S.config.apmLibrary || [];
  const apmChecks = h('div', { class: 'checklist', style: { maxHeight: '150px' } }, apmLib.length ? apmLib.map((e) => h('label', { title: e.description },
    h('input', { type: 'checkbox', 'data-k': e.id, checked: (setup.apm || []).includes(e.id) }), h('span', { class: 'mono' }, e.ref), h('span', { class: 'muted' }, e.description.slice(0, 80)))) : h('div', { class: 'muted' }, 'No APM packages in the library yet (Library page).'));
  const syncAgents = () => { agentChecks.style.display = agentsMode.value === 'pick' ? '' : 'none'; };
  agentsMode.addEventListener('change', syncAgents);
  syncAgents();
  const checked = (box) => [...box.querySelectorAll('input[data-k]')].filter((c) => c.checked).map((c) => c.dataset.k);
  return {
    elements: [
      h('h3', { class: 'full' }, 'Coding agents (MCP servers and skills)'),
      ...field('Install to', scope, 'Project scope writes into the project folder (e.g. .mcp.json, .claude/skills)'),
      ...field('Agents', h('div', null, agentsMode, h('div', { style: { height: '6px' } }), agentChecks)),
      ...field('MCP servers', mcpChecks),
      ...field('Skills', skillChecks),
      ...field('APM packages', apmChecks, 'Installed with APM (Agent Package Manager) on the project machine'),
      h('div', { class: 'hint' }, 'Apply with “Agents ▾ → Deploy MCP & skills” in the project header; run it again after changes (Update).'),
    ],
    get: () => ({
      ...setup,
      scope: scope.value,
      agents: agentsMode.value === 'auto' ? 'auto' : checked(agentChecks),
      mcp: checked(mcpChecks),
      skills: checked(skillChecks),
      apm: checked(apmChecks),
    }),
  };
}

// ---------- project header menu ----------
export async function agentsMenu(ctx, e, p, activeSessionId) {
  const { call } = ctx;
  // Read the button position before awaiting; currentTarget is cleared once the event is done.
  const r = e.currentTarget.getBoundingClientRect();
  const list = ctx.S.agentsList || (ctx.S.agentsList = await call('agentsList'));
  contextMenu(r.left, r.bottom + 2, [
    { label: 'Deploy MCP & skills (update)', action: () => deploy(ctx, p) },
    { label: 'Detect installed agents', action: () => detect(ctx, p) },
    { label: 'Configure…', action: () => ctx.editProject(p) },
    '-',
    { label: 'APM: check for package updates', action: () => apmAction(ctx, p, 'outdated') },
    { label: 'APM: update packages', action: () => apmAction(ctx, p, 'update') },
    { label: 'APM: list installed packages', action: () => apmAction(ctx, p, 'list') },
    '-',
    ...list.map((a) => ({ label: `Install ${a.name}`, action: () => install(ctx, p, a, activeSessionId) })),
    { label: 'Install APM (Agent Package Manager)', action: () => install(ctx, p, { id: 'apm', name: 'APM' }, activeSessionId) },
    { label: 'Update APM itself (apm self-update)', action: () => apmAction(ctx, p, 'self-update') },
  ]);
}

async function install(ctx, p, a, sessionId) {
  try {
    const r = await ctx.call('agentsInstall', p.id, a.id, sessionId);
    toast(`Installing ${a.name}: ${r.command}`, { ms: 6000 });
    ctx.selectSession(r.sessionId);
  } catch (e) { toast(e.message, { error: true, ms: 6000 }); }
}

async function detect(ctx, p) {
  const t = toast(`Detecting agents on ${p.name}…`, { ms: 60000 });
  try {
    const res = await ctx.call('agentsDetect', p.id);
    t && t.remove && t.remove();
    modal({
      title: `Coding agents on “${p.name}”`,
      okText: null, cancelText: 'Close',
      body: h('table', { class: 'list' }, res.map((a) => h('tr', null,
        h('td', null, h('span', { class: 'dot ' + (!a.installed ? 'none' : a.working === false ? 'error' : 'waiting') })),
        h('td', null, h('b', null, a.name)),
        h('td', { class: !a.installed ? 'muted' : a.working === false ? 'bad' : '' },
          !a.installed ? 'not installed' : a.working === false ? 'found but not working: ' + a.problem : a.version || 'installed')))),
    });
  } catch (e) { toast(e.message, { error: true, ms: 8000 }); }
}

export async function deploy(ctx, p) {
  const t = toast(`Deploying MCP servers and skills to ${p.name}…`, { ms: 120000 });
  let report;
  try {
    report = await ctx.call('agentsDeploy', p.id);
  } catch (e) {
    toast(e.message, { error: true, ms: 8000 });
    return;
  } finally { t && t.remove && t.remove(); }
  showReport(report);
  return report;
}

function showReport(rep) {
  const installed = rep.agents.filter((a) => a.installed);
  const body = h('div', null,
    h('p', { class: 'muted' }, `${rep.scope === 'project' ? 'Project folder ' + rep.dir : 'User scope'} · ${rep.target === 'powershell' ? 'Windows PowerShell' : 'Linux/macOS shell'} · ${fmtTime(rep.time)}`),
    rep.errors.map((e) => h('div', { class: 'bad', style: { whiteSpace: 'pre-wrap' } }, e)),
    installed.length ? null : h('p', { class: 'warn' }, 'No coding agent found on this machine. Install one with Agents ▾ → Install.'),
    h('table', { class: 'list' },
      h('tr', null, ['', 'Agent', 'MCP servers', 'Skills'].map((x) => h('th', null, x))),
      rep.agents.map((a) => h('tr', null,
        h('td', null, h('span', { class: 'dot ' + (!a.installed ? 'none' : (a.mcp && a.mcp.error) || !a.working ? 'error' : 'waiting') })),
        h('td', null, h('b', null, a.name), h('div', { class: 'muted', style: { fontSize: '11px' } }, a.installed ? a.version : 'not installed')),
        h('td', null, !a.installed ? '' : a.mcp ? (a.mcp.error ? h('span', { class: 'bad' }, a.mcp.error) : h('div', null,
          a.mcp.added.length ? '✓ ' + a.mcp.added.join(', ') : h('span', { class: 'muted' }, 'none'),
          a.mcp.removed.length ? h('div', { class: 'muted' }, 'removed: ' + a.mcp.removed.join(', ')) : null,
          (a.mcp.skipped || []).map((s) => h('div', { class: 'warn' }, `${s.name}: ${s.reason}`)),
          h('div', { class: 'muted mono', style: { fontSize: '10px' } }, a.mcp.file))) : h('span', { class: 'muted' }, '–')),
        h('td', null, !a.installed ? '' : a.skills ? h('div', null,
          a.skills.written.length ? '✓ ' + a.skills.written.join(', ') : h('span', { class: 'muted' }, 'none'),
          a.skills.removed.length ? h('div', { class: 'muted' }, 'removed: ' + a.skills.removed.join(', ')) : null,
          h('div', { class: 'muted mono', style: { fontSize: '10px' } }, a.skills.dir)) : h('span', { class: 'muted' }, '–'),
        a.warnings.map((w) => h('div', { class: 'warn', style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, w)))))));
  if (rep.apm) {
    const a = rep.apm;
    body.appendChild(h('div', { class: 'card', style: { marginTop: '12px' } },
      h('div', { class: 'row' }, h('span', { class: 'dot ' + (a.ok ? 'waiting' : 'error') }), h('b', null, 'APM packages'), h('span', { class: 'muted' }, a.version || '')),
      a.error ? h('p', { class: 'bad' }, a.error) : null,
      h('p', null, a.packages.length ? '✓ ' + a.packages.join(', ') : h('span', { class: 'muted' }, 'none selected'),
        a.removed && a.removed.length ? h('span', { class: 'muted' }, ' · removed: ' + a.removed.join(', ')) : null,
        a.targets && a.targets.length ? h('span', { class: 'muted' }, ' · targets: ' + a.targets.join(', ')) : null),
      (a.commands || []).map((c) => h('details', { class: 'tool-call' },
        h('summary', { class: 'tool-head' }, h('span', { class: 'tool-icon ' + (c.ok ? 'ok' : 'bad') }, c.ok ? '✓' : '✗'), h('span', { class: 'tool-subject mono' }, c.cmd)),
        h('div', { class: 'tool-body' }, h('pre', { class: 'tool-pre' }, c.output || '(no output)'))))));
  }
  modal({ title: rep.ok ? 'Deployed' : 'Deployed with problems', body, okText: null, cancelText: 'Close', width: '900px' });
}
