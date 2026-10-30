'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildSpawn, buildForwardArgs, tmuxName, tmuxScript, shq, posixDir } = require('../src/main/connect');
const { containsBell, stripAnsi } = require('../src/main/sessions');
const { Store, stripSecrets } = require('../src/main/store');
const { simplifyMessages, messagesToText } = require('../src/main/opencode');

const sshProject = { name: 'Backend API', type: 'ssh', host: 'dev1', user: 'bob', port: 2200, directory: '~/workspace/api', tmux: true, keepAlive: true, keepAliveInterval: 30, keepAliveCountMax: 3 };

test('tmux session names are sanitized', () => {
  assert.strictEqual(tmuxName({ name: 'Backend API' }, 'shell.1:x'), 'termclaw-backend-api-shell-1-x');
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
  assert.match(script, /tmux has-session -t '=termclaw-backend-api-agent'/);
  assert.match(script, /tmux new-session -d -s 'termclaw-backend-api-agent' -c ~\/'workspace\/api'/);
  assert.match(script, /send-keys -t 'termclaw-backend-api-agent' 'claude' Enter/);
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

test('tmux script takes over sessions from before the rename (atm-…)', () => {
  const script = tmuxScript('termclaw-p-shell', '', '');
  assert.match(script, /has-session -t '=atm-p-shell'.*rename-session -t '=termclaw-p-shell' 'termclaw-p-shell-replaced'.*rename-session -t '=atm-p-shell' 'termclaw-p-shell'/);
  assert.ok(!tmuxScript('other', '', '').includes('atm-'));
});

test('ssh X11 forwarding: off, local X server, through WSL', () => {
  const off = buildSpawn({ ...sshProject, x11: 'off' }, null, { name: 'a' });
  assert.ok(!off.args.includes('-Y'));
  assert.strictEqual(off.env, undefined);

  const disp = buildSpawn({ ...sshProject, x11: 'display', x11Display: 'localhost:1.0' }, null, { name: 'a' });
  assert.match(disp.file, /^ssh(\.exe)?$/);
  assert.deepStrictEqual(disp.args.slice(0, 2), ['-Y', '-t']);
  assert.deepStrictEqual(disp.env, { DISPLAY: 'localhost:1.0' });

  const wsl = buildSpawn({ ...sshProject, x11: 'wsl', wslDistro: 'Ubuntu' }, null, { name: 'a' });
  if (process.platform === 'win32') {
    assert.strictEqual(wsl.file, 'wsl.exe');
    assert.deepStrictEqual(wsl.args.slice(0, 7), ['-d', 'Ubuntu', '--exec', 'ssh', '-Y', '-t', '-p']);
    assert.ok(wsl.args.includes('bob@dev1'));
  } else {
    assert.deepStrictEqual(wsl.args.slice(0, 2), ['-Y', '-t']); // no WSL: falls back to the local DISPLAY
  }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termclaw-unit-'));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termclaw-unit-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  const st = new Store(dir);
  assert.deepStrictEqual(st.data.projects, []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('config.json.broken-')));
});

test('OpenCode messages are simplified oldest first', () => {
  const msgs = [
    { id: 'm3', type: 'idle', time: { created: 3 }, outcome: 'succeeded' },
    { id: 'm2', type: 'assistant', time: { created: 2, completed: 3 }, content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Blue.' }, { type: 'tool', name: 'termclaw_read_output', state: { status: 'completed', input: {}, content: [{ type: 'text', text: 'ok' }] } }] },
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

test('local shell: any project can open one; no tmux, no default session, home directory when empty', () => {
  const { buildLocalShell, localShellName, localShellLabel } = require('../src/main/connect');
  const { SessionManager } = require('../src/main/sessions');
  const os = require('os');
  const ssh = { id: 'p', name: 'p', type: 'ssh', host: 'example.com', user: 'u', port: 22, tmux: true, directory: '/srv/app' };
  // session.shell wins over the project's connection
  const spec = buildSpawn(ssh, null, { id: 's', name: 'x', command: '', shell: { id: process.platform === 'win32' ? 'cmd' : '/bin/sh', dir: '' } });
  assert.strictEqual(spec.tmuxName, null);
  assert.strictEqual(spec.cwd, os.homedir());
  assert.ok(!/ssh/i.test(spec.file));
  if (process.platform === 'win32') {
    assert.deepStrictEqual(buildLocalShell({ id: 'wsl:Ubuntu', dir: '~/src' }).args, ['-d', 'Ubuntu', '--cd', '~/src']);
    assert.deepStrictEqual(buildLocalShell({ id: 'wsl' }).args, ['--cd', '~']);
    assert.strictEqual(buildLocalShell({ id: 'powershell', dir: 'C:\work' }).cwd, 'C:\work');
    assert.throws(() => buildLocalShell({ id: 'nope' }), /Unknown local shell/);
  }
  assert.strictEqual(localShellName('wsl:Ubuntu-22.04'), 'wsl-ubuntu-22-04');
  assert.strictEqual(localShellLabel('pwsh'), 'PowerShell 7');
  // The session manager does not apply the project's default session to a local shell and persists the choice.
  const store = { getProject: () => ({ ...ssh, defaultSession: { name: 'agent', command: 'claude', kind: 'agent' } }), save() {} };
  const mgr = Object.create(SessionManager.prototype);
  mgr.store = store; mgr.sessions = new Map(); mgr.emit = () => {}; mgr.persistOpen = () => {};
  let opened = null;
  mgr.agentFactory = () => { throw new Error('agent factory must not be used'); };
  const TS = require('../src/main/sessions').TerminalSession;
  const spawn = TS.prototype.spawn;
  TS.prototype.spawn = function () { opened = this; };
  try {
    const s = mgr.open('p', { shell: { id: 'cmd' } });
    assert.strictEqual(s.kind, 'terminal');
    assert.strictEqual(s.command, '');
    assert.strictEqual(s.name, 'cmd');
    assert.deepStrictEqual(s.persistExtra(), { shell: { id: 'cmd', dir: '' } });
    assert.strictEqual(opened, s);
  } finally { TS.prototype.spawn = spawn; }
});

test('git: porcelain v2 status with rename, untracked, conflict and branch header', () => {
  const { parseStatus } = require('../src/main/git');
  const z = [
    '# branch.oid 1234567890abcdef', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/a file.txt',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt', 'old name.txt',
    '1 A. N... 000000 100644 100644 000 bbb added.txt',
    'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
    '? untracked dir/x.js', '',
  ].join('\0');
  const s = parseStatus(z);
  assert.deepStrictEqual(s.branch, { oid: '1234567890abcdef', head: 'main', upstream: 'origin/main', ahead: 2, behind: 1 });
  assert.deepStrictEqual(s.files.map((f) => [f.path, f.status, f.orig || '']), [
    ['src/a file.txt', 'modified', ''], ['new name.txt', 'renamed', 'old name.txt'], ['added.txt', 'new', ''], ['conflict.txt', 'conflict', ''], ['untracked dir/x.js', 'new', ''],
  ]);
  assert.strictEqual(parseStatus('# branch.oid (initial)\0# branch.head master\0').branch.initial, true);
  assert.strictEqual(parseStatus('# branch.oid abc\0# branch.head (detached)\0').branch.detached, true);
});

test('git: batch output is split into stdout, exit code and stderr per command', () => {
  const { parseBatch, batchScript } = require('../src/main/git');
  const out = 'line1\nline2\n@@TCG 0 0\n@@TCGE warning: x\nsecond\0out\n@@TCG 1 128\n@@TCGE fatal: bad\n@@TCGE more\n';
  const r = parseBatch(out, 3);
  assert.deepStrictEqual(r[0], { code: 0, out: 'line1\nline2', err: 'warning: x' });
  assert.deepStrictEqual(r[1], { code: 128, out: 'second\0out', err: 'fatal: bad\nmore' });
  assert.strictEqual(r[2], null);
  const script = batchScript('~/src/my repo', [['commit', '-m', "it's done"]], { stop: true });
  assert.match(script, /cd ~\/'src\/my repo'/);
  assert.match(script, /git 'commit' '-m' 'it'\\''s done'/);
  assert.match(script, /exit 0/);
});

test('git: branches, log and name-status parsing; ref names are checked', () => {
  const { parseBranches, parseLog, parseNameStatus, badRef, parseScan } = require('../src/main/git');
  const US = '\x1f';
  const b = parseBranches([
    ['refs/heads/main', 'abc1234', 'origin/main', '[ahead 2, behind 3]', '1700000000', '*', 'Fix it'].join(US),
    ['refs/heads/old', 'def', 'origin/old', '[gone]', '1600000000', ' ', 'x'].join(US),
    ['refs/remotes/origin/HEAD', 'abc', '', '', '0', ' ', ''].join(US),
    ['refs/remotes/origin/feature/x', 'fff', '', '', '1700000001', ' ', 'y'].join(US),
  ].join('\n'));
  assert.deepStrictEqual(b.local.map((x) => [x.name, x.current, x.ahead, x.behind, x.gone]), [['main', true, 2, 3, false], ['old', false, 0, 0, true]]);
  assert.deepStrictEqual(b.remote.map((x) => x.name), ['origin/feature/x']);
  const log = parseLog(['h1', 'h1s', 'Anna', 'a@x', '1700000000', 'p1 p2', 'HEAD -> main, tag: v1', 'Merge'].join(US) + '\x1e\n' + ['h2', 'h2s', 'Bob', 'b@x', '1600000000', '', '', 'First'].join(US) + '\x1e\n');
  assert.deepStrictEqual(log.map((c) => [c.hash, c.parents.length, c.refs, c.subject]), [['h1', 2, ['HEAD -> main', 'tag: v1'], 'Merge'], ['h2', 0, [], 'First']]);
  assert.deepStrictEqual(parseNameStatus('M\0a.txt\0R087\0old.txt\0new.txt\0A\0b c.txt\0'), [
    { status: 'modified', path: 'a.txt' }, { status: 'renamed', orig: 'old.txt', path: 'new.txt' }, { status: 'new', path: 'b c.txt' },
  ]);
  for (const bad of ['-x', 'a b', 'a..b', 'a:b', '', 'x~1']) assert.ok(badRef(bad), bad);
  for (const ok of ['main', 'feature/x-1', 'release_2.0']) assert.ok(!badRef(ok), ok);
  const repos = parseScan('@@TCGR /home/u/src/app\n# branch.oid abc\n# branch.head main\n# branch.ab +1 -0\nchanges 4\n@@TCGR /home/u/tools\n# branch.head dev\nchanges 0\n');
  assert.deepStrictEqual(repos.map((r) => [r.name, r.head, r.ahead, r.changes]), [['app', 'main', 1, 4], ['tools', 'dev', 0, 0]]);
});

test('git: actions run in a real repository (local git)', async (t) => {
  const { spawnSync } = require('child_process');
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git not installed');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { GitManager } = require('../src/main/git');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-git-'));
  const repo = path.join(root, 'app');
  const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['init', '-q', path.join(root, 'node_modules', 'dep')]);
  g('config', 'user.email', 't@t'); g('config', 'user.name', 'T'); g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  g('add', '-A'); g('commit', '-qm', 'first');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  fs.writeFileSync(path.join(repo, 'c.txt'), 'junk\n');
  // On Windows the local project runs git.exe directly; elsewhere the same POSIX script as over ssh.
  const project = { id: 'p', type: 'local', git: { enabled: true, paths: root, depth: 3 } };
  const mgr = new GitManager({ getProject: () => project, getHost: () => null });
  const { repos } = await mgr.repos('p');
  assert.deepStrictEqual(repos.map((r) => [r.name, r.changes]), [['app', 3]]); // node_modules is skipped
  const real = repos[0].path;
  let st = await mgr.state('p', real);
  assert.deepStrictEqual(st.files.map((f) => f.path + ':' + f.status), ['a.txt:modified', 'b.txt:new', 'c.txt:new']);
  assert.match((await mgr.diff('p', real, st.files[0])).diff, /-one\n\+two/);
  assert.match((await mgr.diff('p', real, st.files[1])).diff, /\+new/);
  await mgr.commit('p', real, { files: [{ path: 'b.txt' }], summary: 'Add b', description: 'with body' });
  st = await mgr.state('p', real);
  assert.deepStrictEqual(st.files.map((f) => f.path), ['a.txt', 'c.txt']);
  assert.deepStrictEqual(st.log.map((c) => c.subject), ['Add b', 'first']);
  const info = await mgr.commitInfo('p', real, st.log[0].hash);
  assert.strictEqual(info.body, 'with body');
  assert.deepStrictEqual(info.files, [{ status: 'new', path: 'b.txt' }]);
  await mgr.discard('p', real, st.files);
  st = await mgr.state('p', real);
  assert.deepStrictEqual(st.files, []);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'one\n');
  assert.ok(!fs.existsSync(path.join(repo, 'c.txt')));
  await mgr.createBranch('p', real, 'topic');
  st = await mgr.state('p', real);
  assert.strictEqual(st.branch.head, 'topic');
  await mgr.undoCommit('p', real); // no upstream: the commit is local
  st = await mgr.state('p', real);
  assert.deepStrictEqual(st.files.map((f) => f.path + ':' + f.staged), ['b.txt:true']);
  fs.writeFileSync(path.join(repo, 'x.log'), 'l');
  await mgr.ignore('p', real, { patterns: ['*.log', '/b.txt'], untrack: ['b.txt'] });
  await mgr.ignore('p', real, { patterns: ['*.log'] }); // not added twice
  assert.strictEqual(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), '*.log\n/b.txt\n');
  st = await mgr.state('p', real);
  assert.deepStrictEqual(st.files.map((f) => f.path + ':' + f.status).sort(), ['.gitignore:new']);
  await assert.rejects(mgr.push('p', real), /no remote/);
  await assert.rejects(mgr.createBranch('p', real, '--force'), /Invalid branch/);
  fs.rmSync(root, { recursive: true, force: true });
});
