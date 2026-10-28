'use strict';
// APM (Agent Package Manager, github.com/microsoft/apm): installs packages of agent primitives
// (skills, prompts, instructions, agents, MCP servers) from Git repositories into each agent's own
// folders, with a lockfile (apm.lock.yaml). The app keeps a library of package references, lets a
// project select some of them, and runs apm on the project's machine to install, remove and update them.

const APM = {
  id: 'apm',
  name: 'APM (Agent Package Manager)',
  bin: 'apm',
  homepage: 'https://github.com/microsoft/apm',
  install: {
    posix: 'curl -sSL https://aka.ms/apm-unix | sh',
    powershell: 'irm https://aka.ms/apm-windows | iex',
  },
};

// Our agent ids -> APM target names (agents APM has no target for are left out).
const TARGETS = { claude: 'claude', copilot: 'copilot', codex: 'codex', opencode: 'opencode', cursor: 'cursor', agy: 'antigravity' };

// Accepted references: owner/repo[/path][#ref], plugin@marketplace, or an https/ssh Git URL.
// Only shell-safe characters, because references end up on a command line.
const REF_RE = /^(?:[A-Za-z0-9][\w.-]*\/[\w.-]+(?:\/[\w./-]+)?(?:#[\w./-]+)?|[\w.-]+@[\w.-]+|(?:https:\/\/|git@)[\w.@:/~-]+(?:#[\w./-]+)?)$/;

function validRef(ref) {
  return typeof ref === 'string' && REF_RE.test(ref.trim());
}

// An APM reference as a Git source the app can download itself: {url, path, ref, name}.
// GitHub shorthand owner/repo[/path][#ref] and Git URLs work; marketplace plugins need APM.
function refToSource(input) {
  const ref = String(input || '').trim();
  if (!validRef(ref)) throw new Error('Invalid package reference');
  const [base, pin = ''] = ref.split('#');
  if (/^(https:\/\/|git@)/.test(base)) {
    return { url: base, path: '', ref: pin, name: base.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() };
  }
  if (base.includes('@')) throw new Error('Marketplace plugins can only be installed with APM on the target');
  const [owner, repo, ...sub] = base.split('/');
  return { url: `https://github.com/${owner}/${repo}.git`, path: sub.join('/'), ref: pin, name: sub.length ? sub[sub.length - 1] : repo };
}

// What kind of reference was entered (for the live hint in the dialog).
function describeRef(input) {
  const ref = String(input || '').trim();
  if (!ref) return { valid: false, message: '' };
  if (!validRef(ref)) {
    if (/[\s;&|$`'"<>()]/.test(ref)) return { valid: false, message: 'Spaces and shell characters ( ; & | $ quotes ) are not allowed' };
    return { valid: false, message: 'Not a package reference: use owner/repo, a Git URL or plugin@marketplace' };
  }
  const [base, pin] = ref.split('#');
  const at = pin ? ` · pinned to ${pin}` : ' · latest commit (pinned in apm.lock.yaml)';
  if (/^https:\/\//.test(base)) return { valid: true, message: `Git repository over HTTPS (${base.replace(/^https:\/\/([^/]+).*/, '$1')})${at}` };
  if (/^git@/.test(base)) return { valid: true, message: `Git repository over SSH (${base.replace(/^git@([^:]+).*/, '$1')})${at}` };
  if (base.includes('@')) return { valid: true, message: `Plugin "${base.split('@')[0]}" from marketplace "${base.split('@')[1]}"` };
  const parts = base.split('/');
  return { valid: true, message: `GitHub ${parts[0]}/${parts[1]}${parts.length > 2 ? `, sub-folder ${parts.slice(2).join('/')}` : ''}${at}` };
}

function apmTargets(agentIds) {
  return [...new Set(agentIds.map((id) => TARGETS[id]).filter(Boolean))];
}

// What to change compared to the last deploy.
function planApm(selected, managed) {
  const sel = [...new Set(selected)];
  const prev = new Set(managed || []);
  return { add: sel.filter((r) => !prev.has(r)), remove: [...prev].filter((r) => !sel.includes(r)), keep: sel.filter((r) => prev.has(r)) };
}

// Commands for a deploy: remove deselected, add new, otherwise sync with the lockfile.
function apmDeployCommands({ add, remove }, { targets, global }) {
  const g = global ? ' -g' : '';
  const t = targets.length ? ` --target ${targets.join(',')}` : '';
  const cmds = [];
  if (remove.length) cmds.push(`apm uninstall${g} ${remove.join(' ')}`);
  if (add.length) cmds.push(`apm install${g}${t} ${add.join(' ')}`);
  else cmds.push(`apm install${g}${t}`);
  return cmds;
}

function apmActionCommand(action, { targets, global }) {
  const g = global ? ' -g' : '';
  const t = targets.length ? ` --target ${targets.join(',')}` : '';
  if (action === 'outdated') return `apm outdated${g}`;
  if (action === 'update') return `apm update --yes${g}${t}`;
  if (action === 'list') return `apm deps list${g}`;
  if (action === 'self-update') return 'apm self-update';
  throw new Error('unknown APM action ' + action);
}

// APM prints colors and box characters; keep the useful lines for reports.
function cleanOutput(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-60)
    .join('\n');
}

module.exports = { APM, TARGETS, validRef, describeRef, refToSource, apmTargets, planApm, apmDeployCommands, apmActionCommand, cleanOutput };
