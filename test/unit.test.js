'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSpawn, buildForwardArgs, tmuxName, shq, posixDir } = require('../src/main/connect');
const { containsBell, stripAnsi } = require('../src/main/sessions');
const { Store, stripSecrets } = require('../src/main/store');
const { simplifyMessages, messagesToText } = require('../src/main/opencode');

const sshProject = { name: 'Backend API', type: 'ssh', host: 'dev1', user: 'bob', port: 2200, directory: '~/workspace/api', tmux: true, keepAlive: true, keepAliveInterval: 30, keepAliveCountMax: 3 };

test('tmux session names are sanitized', () => {
  assert.strictEqual(tmuxName({ name: 'Backend API' }, 'shell.1:x'), 'atm-backend-api-shell-1-x');
});

test('shell quoting', () => {
  assert.strictEqual(shq("it's"), "'it'\\''s'");
  assert.strictEqual(posixDir('~/my dir'), "~/'my dir'");
  assert.strictEqual(posixDir('/opt/x'), "'/opt/x'");
});

test('ssh spawn: -t, port, keep-alive, tmux attach-or-create in directory', () => {
  const s = buildSpawn(sshProject, null, { name: 'agent', command: 'claude' });
  assert.match(s.file, /^ssh(\.exe)?$/);
  assert.deepStrictEqual(s.args.slice(0, 7), ['-t', '-p', '2200', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3']);
  assert.strictEqual(s.args[7], 'bob@dev1');
  const script = s.args[8];
  assert.match(script, /tmux has-session -t '=atm-backend-api-agent'/);
  assert.match(script, /tmux new-session -d -s 'atm-backend-api-agent' -c ~\/'workspace\/api'/);
  assert.match(script, /send-keys -t 'atm-backend-api-agent' 'claude' Enter/);
  assert.match(script, /exec tmux attach-session/);
  assert.strictEqual(s.postStart, '');
});

test('ssh spawn without tmux: cd + exec $SHELL, start command typed afterwards', () => {
  const s = buildSpawn({ ...sshProject, tmux: false, keepAlive: false, port: 22 }, null, { name: 'x', command: 'ls' });
  assert.deepStrictEqual(s.args.slice(0, 2), ['-t', 'bob@dev1']);
  assert.strictEqual(s.args[2], `cd ~/'workspace/api' && exec "\${SHELL:-/bin/sh}" -l`);
  assert.strictEqual(s.postStart, 'ls');
});

test('host reference replaces inline connection data; workspace is default directory', () => {
  const host = { hostname: '10.0.0.5', user: 'alice', port: 22, workspace: '~/ws' };
  const s = buildSpawn({ ...sshProject, directory: '', hostId: 'h' }, host, { name: 'a' });
  assert.ok(s.args.includes('alice@10.0.0.5'));
  assert.ok(!s.args.includes('-p'));
  assert.match(s.args[s.args.length - 1], /-c ~\/'ws'/);
});

test('wsl spawn: distribution, --cd, tmux via bash -lc', () => {
  const s = buildSpawn({ name: 'p', type: 'wsl', wslDistro: 'Ubuntu', directory: '/tmp', tmux: true }, null, { name: 'w' });
  assert.strictEqual(s.file, 'wsl.exe');
  assert.deepStrictEqual(s.args.slice(0, 7), ['-d', 'Ubuntu', '--cd', '/tmp', '--', 'bash', '-lc']);
  const plain = buildSpawn({ name: 'p', type: 'wsl', wslDistro: 'Ubuntu', directory: '/tmp', tmux: false }, null, { name: 'w' });
  assert.deepStrictEqual(plain.args, ['-d', 'Ubuntu', '--cd', '/tmp']);
});

test('local spawn uses the configured directory', () => {
  const s = buildSpawn({ name: 'p', type: 'local', directory: os.tmpdir(), tmux: false }, null, { name: 'l', command: 'echo hi' });
  assert.strictEqual(s.cwd, os.tmpdir());
  assert.strictEqual(s.postStart, 'echo hi');
  if (process.platform === 'win32') assert.strictEqual(s.file, 'powershell.exe');
});

test('port forward args', () => {
  const a = buildForwardArgs({ ...sshProject, forwards: [{ local: 8080, remote: 3000 }, { local: 9000, remote: 9001, remoteHost: 'db' }, { local: '', remote: 1 }] }, null);
  assert.ok(a.includes('-N'));
  assert.ok(a.includes('127.0.0.1:8080:localhost:3000'));
  assert.ok(a.includes('127.0.0.1:9000:db:9001'));
  assert.strictEqual(a.filter((x) => x === '-L').length, 2);
});

test('bell detection ignores OSC title sequences', () => {
  assert.strictEqual(containsBell('\x1b]0;title\x07prompt$ '), false);
  assert.strictEqual(containsBell('done\x07'), true);
  assert.strictEqual(containsBell('\x1b]0;t\x07\x07'), true);
  assert.strictEqual(containsBell('plain'), false);
});

test('stripAnsi removes escapes and handles carriage returns', () => {
  assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  assert.strictEqual(stripAnsi('progress 10%\rprogress 100%\r\n'), 'progress 100%\n');
  assert.strictEqual(stripAnsi('\x1b]0;x\x07a\x1b[?25lb'), 'ab');
});

test('store persists, strips passwords, imports and exports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-unit-'));
  const st = new Store(dir);
  const p = st.saveProject({ name: 'x', type: 'ssh', host: 'h', password: 'secret' });
  assert.ok(!('password' in p));
  st.saveNow();
  const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  assert.ok(!raw.includes('secret'));
  const st2 = new Store(dir);
  assert.strictEqual(st2.getProject(p.id).name, 'x');
  assert.strictEqual(st2.getProject(p.id).keepAlive, true);
  st2.data.tokens.push({ id: 't', hash: 'h' });
  const exp = JSON.parse(st2.exportJson());
  assert.ok(!exp.tokens);
  st2.importJson(JSON.stringify({ projects: [{ id: 'n', name: 'neu' }] }), { merge: true });
  assert.strictEqual(st2.data.projects.length, 2);
  st2.importJson(JSON.stringify({ projects: [{ id: 'n', name: 'neu' }] }), { merge: false });
  assert.strictEqual(st2.data.projects.length, 1);
  assert.strictEqual(st2.data.tokens.length, 1, 'tokens survive a replacing import');
  assert.deepStrictEqual(stripSecrets({ a: { passphrase: 1, b: 2 } }), { a: { b: 2 } });
});

test('broken config file is kept as backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-unit-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  const st = new Store(dir);
  assert.deepStrictEqual(st.data.projects, []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('config.json.broken-')));
});

test('OpenCode messages are simplified oldest first', () => {
  const msgs = [
    { id: 'm3', type: 'idle', time: { created: 3 }, outcome: 'succeeded' },
    { id: 'm2', type: 'assistant', time: { created: 2, completed: 3 }, content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Blue.' }, { type: 'tool', name: 'atm_read_output', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'ok' }] } }] },
    { id: 'm1', type: 'user', time: { created: 1 }, text: 'Sky?' },
  ];
  const s = simplifyMessages(msgs);
  assert.deepStrictEqual(s.map((m) => m.role), ['user', 'assistant', 'idle']);
  assert.strictEqual(s[1].text, 'Blue.');
  assert.strictEqual(s[1].tools[0].result, 'ok');
  assert.match(messagesToText(s), /\[user\] Sky\?\n\n\[assistant\] Blue\./);
});

test('session lookup accepts "project/name" together with a project argument', () => {
  const { SessionManager } = require('../src/main/sessions');
  const projects = [{ id: 'p1', name: 'lokal' }, { id: 'p2', name: 'other' }];
  const mgr = Object.create(SessionManager.prototype);
  mgr.store = { findProject: (r) => projects.find((p) => p.id === r || p.name === r) };
  const dev1 = { id: 'a', projectId: 'p1', name: 'dev' };
  const dev2 = { id: 'b', projectId: 'p2', name: 'dev' };
  mgr.sessions = new Map([['a', dev1], ['b', dev2]]);
  assert.strictEqual(mgr.find('lokal/dev', 'lokal'), dev1);
  assert.strictEqual(mgr.find('other/dev'), dev2);
  assert.strictEqual(mgr.find('dev', 'other'), dev2);
  assert.strictEqual(mgr.find('b'), dev2);
  assert.strictEqual(mgr.find('nope/dev'), null);
});
