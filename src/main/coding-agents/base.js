'use strict';
// Base class for coding agent adapters.
//
// An adapter describes one CLI coding agent: how to detect and install it, where it keeps MCP
// configuration and skills, and how to merge our managed MCP servers into its config.
// Adapters are pure: they turn file contents into new file contents (or into commands), so they can be
// unit-tested; the deploy runner does all I/O on the target machine.
//
// MCP server (library entry, resolved):
//   { name, type: 'stdio' | 'http', command, args: [], env: {}, url, headers: {} }

class CodingAgent {
  constructor(def) {
    Object.assign(this, {
      id: '',
      name: '',
      bin: '',
      versionArgs: '--version',
      homepage: '',
      // install: { posix: '...', powershell: '...' }
      install: {},
      // Scopes the agent supports for MCP config: 'project' and/or 'user'.
      mcpScopes: [],
      skillScopes: [],
      notes: '',
    }, def);
  }

  installCommand(kind) {
    return this.install[kind] || this.install.npm || null;
  }

  // Config file for MCP servers: {base, rel, format} or null if not supported in this scope.
  mcpFile(/* scope, kind */) { return null; }

  // Merge servers into the config file content. `managed` = names this app added before (to remove).
  // Returns {content, added: [], removed: [], skipped: [{name, reason}]}.
  applyMcp(/* content, servers, managed, kind */) { throw new Error(`${this.name}: MCP configuration not supported`); }

  // Directory that holds skill folders ({base, rel}) or null.
  skillsDir(/* scope, kind */) { return null; }

  supportsMcp(scope) { return this.mcpScopes.includes(scope); }
  supportsSkills(scope) { return this.skillScopes.includes(scope); }
}

// ---------- helpers for adapters ----------

// Parse JSON that may contain comments / trailing commas (JSONC). Empty input = {}.
function parseJsonc(text) {
  if (text === null || text === undefined || !String(text).trim()) return {};
  try { return JSON.parse(text); } catch {}
  const stripped = String(text)
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

// Generic JSON merge: obj[key] is a map of servers; replace managed ones, keep everything else.
// key is a dotted path ("mcp.servers") or an array of literal keys (["amp.mcpServers"]).
function mergeJsonServers(content, servers, managed, { key, toEntry, wrap }) {
  const data = parseJsonc(content);
  let container = data;
  const path = Array.isArray(key) ? key : key.split('.');
  for (let i = 0; i < path.length - 1; i++) {
    if (!container[path[i]] || typeof container[path[i]] !== 'object') container[path[i]] = {};
    container = container[path[i]];
  }
  const last = path[path.length - 1];
  if (!container[last] || typeof container[last] !== 'object') container[last] = {};
  const map = container[last];
  const wanted = new Set(servers.map((s) => s.name));
  const removed = [];
  for (const name of managed || []) {
    if (!wanted.has(name) && name in map) { delete map[name]; removed.push(name); }
  }
  const added = [];
  const skipped = [];
  for (const s of servers) {
    if (s.name in map && !(managed || []).includes(s.name)) {
      skipped.push({ name: s.name, reason: 'already defined by the user — left unchanged' });
      continue;
    }
    map[s.name] = toEntry(s);
    added.push(s.name);
  }
  const result = wrap ? wrap(data) : data;
  return { content: JSON.stringify(result, null, 2) + '\n', added, removed, skipped };
}

// TOML: we own a marked block; everything outside it stays untouched.
const BLOCK_START = '# >>> agent-terminal-manager (managed, do not edit) >>>';
const BLOCK_END = '# <<< agent-terminal-manager <<<';

const tomlStr = (s) => JSON.stringify(String(s)); // TOML basic strings use JSON-compatible escapes
const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k));
const tomlArr = (a) => '[' + (a || []).map(tomlStr).join(', ') + ']';
const tomlInline = (o) => '{ ' + Object.entries(o || {}).map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`).join(', ') + ' }';

function mergeTomlBlock(content, servers, { tablePrefix, toLines }) {
  const text = content || '';
  const re = new RegExp(`\\n?${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n?`, 'g');
  const outside = text.replace(re, '\n').replace(/\n{3,}/g, '\n\n');
  const prev = (text.match(re) || []).join('\n');
  const prevNames = [...prev.matchAll(new RegExp(`^\\[${escapeRe(tablePrefix)}\\.("?)([^\\]"]+)\\1\\]`, 'gm'))].map((m) => m[2]);
  const added = [];
  const skipped = [];
  const lines = [];
  for (const s of servers) {
    const header = new RegExp(`^\\[${escapeRe(tablePrefix)}\\.("?)${escapeRe(s.name)}\\1\\]`, 'm');
    if (header.test(outside)) { skipped.push({ name: s.name, reason: 'already defined by the user — left unchanged' }); continue; }
    lines.push(`[${tablePrefix}.${tomlKey(s.name)}]`, ...toLines(s), '');
    added.push(s.name);
  }
  const removed = prevNames.filter((n) => !added.includes(n));
  let body = outside.replace(/\s+$/, '');
  if (lines.length) body += (body ? '\n\n' : '') + BLOCK_START + '\n' + lines.join('\n').replace(/\n+$/, '') + '\n' + BLOCK_END;
  return { content: body + '\n', added, removed, skipped };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = { CodingAgent, parseJsonc, mergeJsonServers, mergeTomlBlock, tomlStr, tomlArr, tomlInline, tomlKey, BLOCK_START, BLOCK_END };
