'use strict';
// All supported coding agents. Each one is a CodingAgent with its install commands, MCP config file
// (JSON or TOML) and skills folder, per scope. Sources and dates are noted where formats differ.
const { CodingAgent, mergeJsonServers, mergeTomlBlock, tomlStr, tomlArr, tomlInline } = require('./base');

const home = (rel) => ({ base: 'home', rel });
const proj = (rel) => ({ base: 'project', rel });
const nonEmpty = (o) => (o && Object.keys(o).length ? o : undefined);

// Adapter for agents whose MCP config is a JSON map of servers.
class JsonAgent extends CodingAgent {
  // def: { files: {project, user}, skills: {project, user}, key, stdio(s), http(s) }
  mcpFile(scope) { return this.files[scope] ? { ...this.files[scope], format: 'json' } : null; }
  skillsDir(scope) { return this.skills[scope] || null; }
  keyFor(/* det */) { return this.key; }
  applyMcp(content, servers, managed, kind, det) {
    return mergeJsonServers(content, servers, managed, {
      key: this.keyFor(det),
      toEntry: (s) => (s.type === 'http' ? this.http(s, det) : this.stdio(s, det)),
    });
  }
}

const jsonAgent = (def) => {
  const a = new JsonAgent(def);
  a.mcpScopes = Object.keys(def.files || {});
  a.skillScopes = Object.keys(def.skills || {});
  return a;
};

// --- Claude Code: https://code.claude.com/docs/en/mcp, /skills
const claude = jsonAgent({
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  homepage: 'https://code.claude.com/docs',
  install: { posix: 'curl -fsSL https://claude.ai/install.sh | bash', powershell: 'irm https://claude.ai/install.ps1 | iex' },
  files: { project: proj('.mcp.json'), user: home('.claude.json') },
  skills: { project: proj('.claude/skills'), user: home('.claude/skills') },
  key: 'mcpServers',
  stdio: (s) => ({ type: 'stdio', command: s.command, args: s.args, env: nonEmpty(s.env) }),
  http: (s) => ({ type: 'http', url: s.url, headers: nonEmpty(s.headers) }),
  notes: 'User scope edits ~/.claude.json; close running Claude sessions first, they rewrite that file. Project servers in .mcp.json need a one-time approval in Claude.',
});

// --- OpenAI Codex CLI: config.toml [mcp_servers.<name>] (global only); skills in .agents/skills
class CodexAgent extends CodingAgent {
  mcpFile(scope) { return scope === 'user' ? { ...home('.codex/config.toml'), format: 'toml' } : null; }
  skillsDir(scope) { return scope === 'user' ? home('.agents/skills') : proj('.agents/skills'); }
  applyMcp(content, servers) {
    return mergeTomlBlock(content, servers, {
      tablePrefix: 'mcp_servers',
      toLines: (s) => (s.type === 'http'
        ? [`url = ${tomlStr(s.url)}`, ...(nonEmpty(s.headers) ? [`http_headers = ${tomlInline(s.headers)}`] : [])]
        : [`command = ${tomlStr(s.command)}`, `args = ${tomlArr(s.args)}`, ...(nonEmpty(s.env) ? [`env = ${tomlInline(s.env)}`] : [])]),
    });
  }
}
const codex = new CodexAgent({
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  homepage: 'https://github.com/openai/codex',
  install: { posix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', powershell: 'irm https://chatgpt.com/codex/install.ps1 | iex' },
  mcpScopes: ['user'],
  skillScopes: ['project', 'user'],
  notes: 'MCP servers are global (~/.codex/config.toml); choose user scope to deploy them.',
});

// --- OpenCode: v2 keeps servers under mcp.servers, v1 directly under mcp.
class OpenCodeAgent extends JsonAgent {
  keyFor(det) { return isV1(det) ? 'mcp' : 'mcp.servers'; }
}
const isV1 = (det) => /\b1\.\d+\.\d+/.test((det && det.version) || '') && !/\bv?2\.\d+/.test(det.version);
const opencode = Object.assign(new OpenCodeAgent({
  id: 'opencode',
  name: 'OpenCode',
  bin: 'opencode',
  homepage: 'https://opencode.ai/docs',
  install: { posix: 'curl -fsSL https://opencode.ai/v2/install | bash', powershell: 'npm config set allow-scripts=@opencode/cli --location=user; npm install -g @opencode/cli' },
  files: { project: proj('opencode.json'), user: home('.config/opencode/opencode.json') },
  skills: { project: proj('.opencode/skills'), user: home('.config/opencode/skills') },
  stdio: (s, det) => ({ type: 'local', command: [s.command, ...s.args], environment: nonEmpty(s.env), ...(isV1(det) ? { enabled: true } : {}) }),
  http: (s, det) => ({ type: 'remote', url: s.url, headers: nonEmpty(s.headers), ...(isV1(det) ? { enabled: true } : {}) }),
  notes: 'Writes opencode.json; if you use opencode.jsonc, keep the servers there manually.',
}), { mcpScopes: ['project', 'user'], skillScopes: ['project', 'user'] });

// --- Google Antigravity CLI (agy): https://antigravity.google/docs/mcp?tab=cli
const agy = jsonAgent({
  id: 'agy',
  name: 'Antigravity CLI (agy)',
  bin: 'agy',
  homepage: 'https://antigravity.google/docs',
  install: { posix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', powershell: 'irm https://antigravity.google/cli/install.ps1 | iex' },
  files: { project: proj('.agents/mcp_config.json'), user: home('.gemini/config/mcp_config.json') },
  skills: { project: proj('.agents/skills'), user: home('.gemini/antigravity-cli/skills') },
  key: 'mcpServers',
  stdio: (s) => ({ command: s.command, args: s.args, env: nonEmpty(s.env) }),
  http: (s) => ({ serverUrl: s.url, headers: nonEmpty(s.headers) }),
});

// --- GitHub Copilot CLI: ~/.copilot/mcp-config.json
const copilot = jsonAgent({
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  bin: 'copilot',
  homepage: 'https://github.com/github/copilot-cli',
  install: { posix: 'curl -fsSL https://gh.io/copilot-install | bash', powershell: 'winget install --id GitHub.Copilot --exact --accept-source-agreements --accept-package-agreements --disable-interactivity' },
  files: { user: home('.copilot/mcp-config.json') },
  skills: { project: proj('.github/skills'), user: home('.copilot/skills') },
  key: 'mcpServers',
  stdio: (s) => ({ type: 'local', command: s.command, args: s.args, env: nonEmpty(s.env), tools: ['*'] }),
  http: (s) => ({ type: 'http', url: s.url, headers: nonEmpty(s.headers), tools: ['*'] }),
  notes: 'MCP servers are global (~/.copilot/mcp-config.json); choose user scope to deploy them.',
});

// --- pi (Earendil): MCP since 1.0
const pi = jsonAgent({
  id: 'pi',
  name: 'pi',
  bin: 'pi',
  homepage: 'https://pi.dev',
  install: { posix: 'curl -fsSL https://pi.dev/install.sh | sh', powershell: 'irm https://pi.dev/install.ps1 | iex' },
  files: { project: proj('.pi/mcp.json'), user: home('.pi/agent/mcp.json') },
  skills: { project: proj('.pi/skills'), user: home('.pi/agent/skills') },
  key: 'mcpServers',
  stdio: (s) => ({ command: s.command, args: s.args, env: nonEmpty(s.env) }),
  http: (s) => ({ url: s.url, headers: nonEmpty(s.headers) }),
  notes: 'On native Windows pi needs Git Bash for its bash tool.',
});

// --- Cursor CLI (binary "cursor-agent", newer installs also "agent")
const cursor = jsonAgent({
  id: 'cursor',
  name: 'Cursor CLI',
  bin: 'cursor-agent',
  homepage: 'https://cursor.com/docs/cli',
  install: { posix: 'curl https://cursor.com/install -fsS | bash', powershell: "irm 'https://cursor.com/install?win32=true' | iex" },
  files: { project: proj('.cursor/mcp.json'), user: home('.cursor/mcp.json') },
  skills: { project: proj('.cursor/skills'), user: home('.cursor/skills') },
  key: 'mcpServers',
  stdio: (s) => ({ type: 'stdio', command: s.command, args: s.args, env: nonEmpty(s.env) }),
  http: (s) => ({ type: 'http', url: s.url, headers: nonEmpty(s.headers) }),
});

// --- Qwen Code (Gemini CLI fork)
const qwen = jsonAgent({
  id: 'qwen',
  name: 'Qwen Code',
  bin: 'qwen',
  homepage: 'https://github.com/QwenLM/qwen-code',
  install: { npm: 'npm install -g @qwen-code/qwen-code@latest' },
  files: { project: proj('.qwen/settings.json'), user: home('.qwen/settings.json') },
  skills: {},
  key: 'mcpServers',
  stdio: (s) => ({ command: s.command, args: s.args, env: nonEmpty(s.env) }),
  http: (s) => ({ httpUrl: s.url, headers: nonEmpty(s.headers) }),
});

const registry = [claude, codex, opencode, agy, copilot, pi, cursor, qwen];

module.exports = { registry, byId: (id) => registry.find((a) => a.id === id) };
