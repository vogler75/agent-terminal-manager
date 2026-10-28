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

module.exports = { APM, TARGETS, validRef, apmTargets, planApm, apmDeployCommands, apmActionCommand, cleanOutput };
