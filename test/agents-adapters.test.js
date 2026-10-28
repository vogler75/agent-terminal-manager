'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { registry, byId } = require('../src/main/coding-agents/registry');

const stdio = { name: 'gh', type: 'stdio', command: 'npx', args: ['-y', '@mcp/github'], env: { TOKEN: 'abc' }, url: '', headers: {} };
const http = { name: 'docs', type: 'http', command: '', args: [], env: {}, url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer t' } };

test('every adapter is complete: install command for both shells, scopes, files', () => {
  for (const a of registry) {
    assert.ok(a.id && a.name && a.bin, a.id);
    assert.ok(a.installCommand('posix'), `${a.id} posix install`);
    assert.ok(a.installCommand('powershell'), `${a.id} powershell install`);
    for (const scope of a.mcpScopes) {
      const f = a.mcpFile(scope, 'posix');
      assert.ok(f && f.rel && ['home', 'project'].includes(f.base), `${a.id} mcp file ${scope}`);
      const r = a.applyMcp(null, [stdio, http], [], 'posix', { installed: true, version: '9.9.9' });
      assert.deepStrictEqual(r.added.sort(), ['docs', 'gh'], a.id);
    }
    for (const scope of a.skillScopes) assert.ok(a.skillsDir(scope, 'posix').rel, `${a.id} skills ${scope}`);
  }
  assert.strictEqual(new Set(registry.map((a) => a.id)).size, registry.length);
});

const j = (r) => JSON.parse(r.content);

test('Claude Code: .mcp.json with typed entries', () => {
  const r = byId('claude').applyMcp('{"mcpServers":{"own":{"command":"x"}}}', [stdio, http], []);
  assert.deepStrictEqual(j(r).mcpServers.gh, { type: 'stdio', command: 'npx', args: ['-y', '@mcp/github'], env: { TOKEN: 'abc' } });
  assert.deepStrictEqual(j(r).mcpServers.docs, { type: 'http', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer t' } });
  assert.ok(j(r).mcpServers.own);
  assert.strictEqual(byId('claude').mcpFile('project').rel, '.mcp.json');
});

test('OpenCode: v2 uses mcp.servers, v1 uses mcp with enabled flag', () => {
  const v2 = j(byId('opencode').applyMcp(null, [stdio, http], [], 'posix', { version: 'opencode v2.0.30' }));
  assert.deepStrictEqual(v2.mcp.servers.gh, { type: 'local', command: ['npx', '-y', '@mcp/github'], environment: { TOKEN: 'abc' } });
  assert.deepStrictEqual(v2.mcp.servers.docs, { type: 'remote', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer t' } });
  const v1 = j(byId('opencode').applyMcp('{"$schema":"https://opencode.ai/config.json"}', [stdio], [], 'posix', { version: '1.19.5' }));
  assert.strictEqual(v1.mcp.gh.enabled, true);
  assert.strictEqual(v1.$schema, 'https://opencode.ai/config.json');
});

test('Codex: TOML block in ~/.codex/config.toml, global only', () => {
  const c = byId('codex');
  assert.strictEqual(c.mcpFile('project'), null);
  const r = c.applyMcp('model = "gpt-5"\n', [stdio, http], []);
  assert.match(r.content, /\[mcp_servers\.gh\]\ncommand = "npx"\nargs = \["-y", "@mcp\/github"\]\nenv = \{ TOKEN = "abc" \}/);
  assert.match(r.content, /\[mcp_servers\.docs\]\nurl = "https:\/\/x\.dev\/mcp"\nhttp_headers = \{ Authorization = "Bearer t" \}/);
  assert.strictEqual(c.skillsDir('user').rel, '.agents/skills');
});

test('agy uses serverUrl, Copilot adds tools, Amp uses a literal dotted key', () => {
  assert.deepStrictEqual(j(byId('agy').applyMcp(null, [http], [])).mcpServers.docs, { serverUrl: 'https://x.dev/mcp', headers: { Authorization: 'Bearer t' } });
  assert.deepStrictEqual(j(byId('copilot').applyMcp(null, [stdio], [])).mcpServers.gh.tools, ['*']);
  const amp = j(byId('amp').applyMcp('{"amp.notifications.enabled":true}', [stdio], []));
  assert.ok(amp['amp.mcpServers'].gh);
  assert.strictEqual(amp['amp.notifications.enabled'], true);
  assert.deepStrictEqual(j(byId('gemini').applyMcp(null, [http], [])).mcpServers.docs, { httpUrl: 'https://x.dev/mcp', headers: { Authorization: 'Bearer t' } });
});

test('removing a deselected managed server keeps user servers', () => {
  const first = byId('cursor').applyMcp('{"mcpServers":{"own":{"command":"x"}}}', [stdio, http], []);
  const second = byId('cursor').applyMcp(first.content, [http], ['gh', 'docs']);
  assert.deepStrictEqual(Object.keys(j(second).mcpServers).sort(), ['docs', 'own']);
  assert.deepStrictEqual(second.removed, ['gh']);
});
