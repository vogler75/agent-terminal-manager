'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseJsonc, mergeJsonServers, mergeTomlBlock, tomlArr, tomlStr, BLOCK_START } = require('../src/main/coding-agents/base');
const { Target, parseSections } = require('../src/main/coding-agents/target');

const toEntry = (s) => ({ command: s.command, args: s.args });

test('parseJsonc accepts comments and trailing commas', () => {
  assert.deepStrictEqual(parseJsonc('{\n // c\n "a": "x//y", /* b */ "b": [1,],\n}'), { a: 'x//y', b: [1] });
  assert.deepStrictEqual(parseJsonc(''), {});
  assert.deepStrictEqual(parseJsonc(null), {});
});

test('JSON merge keeps user entries, replaces managed ones, removes deselected', () => {
  const content = JSON.stringify({ theme: 'dark', mcpServers: { mine: { command: 'x' }, old: { command: 'o' }, keep: { command: 'k' } } });
  const r = mergeJsonServers(content, [{ name: 'gh', command: 'npx', args: ['-y', 'gh'] }, { name: 'mine', command: 'y', args: [] }], ['old', 'keep-gone'], { key: 'mcpServers', toEntry });
  const d = JSON.parse(r.content);
  assert.strictEqual(d.theme, 'dark');
  assert.deepStrictEqual(Object.keys(d.mcpServers).sort(), ['gh', 'keep', 'mine']);
  assert.deepStrictEqual(d.mcpServers.mine, { command: 'x' }, 'user-defined server untouched');
  assert.deepStrictEqual(r.added, ['gh']);
  assert.deepStrictEqual(r.removed, ['old']);
  assert.strictEqual(r.skipped[0].name, 'mine');
});

test('JSON merge creates nested keys in an empty file', () => {
  const r = mergeJsonServers(null, [{ name: 'a', command: 'c', args: [] }], [], { key: 'mcp.servers', toEntry });
  assert.deepStrictEqual(JSON.parse(r.content), { mcp: { servers: { a: { command: 'c', args: [] } } } });
});

test('TOML managed block is replaced idempotently and user tables are kept', () => {
  const toLines = (s) => [`command = ${tomlStr(s.command)}`, `args = ${tomlArr(s.args)}`];
  const user = 'model = "o3"\n\n[mcp_servers.mine]\ncommand = "x"\n';
  const r1 = mergeTomlBlock(user, [{ name: 'gh', command: 'npx', args: ['-y', 'a b'] }, { name: 'mine', command: 'y', args: [] }], { tablePrefix: 'mcp_servers', toLines });
  assert.match(r1.content, /^model = "o3"/);
  assert.match(r1.content, /\[mcp_servers\.gh\]\ncommand = "npx"\nargs = \["-y", "a b"\]/);
  assert.strictEqual(r1.content.split(BLOCK_START).length, 2);
  assert.deepStrictEqual(r1.skipped.map((s) => s.name), ['mine']);
  const r2 = mergeTomlBlock(r1.content, [{ name: 'gh', command: 'npx', args: ['-y', 'a b'] }], { tablePrefix: 'mcp_servers', toLines });
  assert.strictEqual(r2.content, r1.content, 'second run is a no-op');
  const r3 = mergeTomlBlock(r2.content, [], { tablePrefix: 'mcp_servers', toLines });
  assert.deepStrictEqual(r3.removed, ['gh']);
  assert.ok(!r3.content.includes(BLOCK_START));
  assert.match(r3.content, /\[mcp_servers\.mine\]/);
});

test('path expressions for POSIX and PowerShell targets', () => {
  const posix = new Target({ type: 'ssh', host: 'h', directory: '~/work/my app', tmux: false }, null);
  assert.strictEqual(posix.kind, 'posix');
  assert.strictEqual(posix.pathExpr({ base: 'project', rel: '.mcp.json' }), '"$HOME/work/my app/.mcp.json"');
  assert.strictEqual(posix.pathExpr({ base: 'home', rel: '.claude/skills/x' }), '"$HOME/.claude/skills/x"');
  const abs = new Target({ type: 'ssh', host: 'h', directory: '/srv/$x', tmux: false }, null);
  assert.strictEqual(abs.pathExpr({ base: 'project', rel: 'a' }), '"/srv/\\$x/a"');
  if (process.platform === 'win32') {
    const ps = new Target({ type: 'local', directory: "C:\\Users\\o'neil\\proj" }, null);
    assert.strictEqual(ps.kind, 'powershell');
    assert.strictEqual(ps.pathExpr({ base: 'project', rel: '.claude/skills' }), "(Join-Path 'C:\\Users\\o''neil\\proj' '.claude\\skills')");
    assert.strictEqual(ps.pathExpr({ base: 'home', rel: '.codex/config.toml' }), "(Join-Path $HOME '.codex\\config.toml')");
  }
});

test('script output sections are parsed', () => {
  const out = [
    'noise', '@@ATM detect claude', '@@V 2.1.0 (Claude Code)', '@@RC 0', '@@ATM detect codex', '@@NONE', '@@ATM detect oc', '@@V Error: postinstall not run', '@@RC 1',
    '@@ATM file f0', '@@B ' + Buffer.from('{"a":1}').toString('base64'), '@@ATM file f1', '@@NONE',
    '@@ATM cmd c1', 'Added server', '@@EXIT 0', '@@ATM cmd c2', 'boom', '@@EXIT 1',
  ].join('\r\n');
  const p = parseSections(out);
  assert.deepStrictEqual(p.detect.claude, { installed: true, working: true, version: '2.1.0 (Claude Code)' });
  assert.deepStrictEqual(p.detect.oc, { installed: true, working: false, version: '', problem: 'Error: postinstall not run' });
  assert.deepStrictEqual(p.detect.codex, { installed: false });
  assert.strictEqual(p.file.f0, '{"a":1}');
  assert.strictEqual(p.file.f1, null);
  assert.deepStrictEqual(p.cmd.c1, { ok: true, output: 'Added server' });
  assert.strictEqual(p.cmd.c2.ok, false);
});

test('a failing file write stops the write phase, so the deploy cannot report success', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { Target } = require('../src/main/coding-agents/target');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-strict-'));
  fs.writeFileSync(path.join(dir, 'blocker'), 'a file, not a folder');
  const t = new Target({ type: 'local', directory: dir }, null);
  const script = [
    t.preamble(),
    t.strict(true),
    t.writeSnippet({ base: 'project', rel: 'blocker/sub/x.txt' }, 'cannot be written'),
    t.strict(false),
    t.echo('@@ATM_DONE'),
  ].join('\n');
  const r = await t.run(script, { timeout: 30000 });
  assert.ok(!r.out.includes('@@ATM_DONE'), 'done marker must not be printed after a failed write: ' + r.out);
  const ok = await t.run([t.preamble(), t.strict(true), t.writeSnippet({ base: 'project', rel: 'good/x.txt' }, 'hi'), t.strict(false), t.echo('@@ATM_DONE')].join('\n'), { timeout: 30000 });
  assert.ok(ok.out.includes('@@ATM_DONE'));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'good', 'x.txt'), 'utf8'), 'hi');
});
