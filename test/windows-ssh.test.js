'use strict';
// SSH projects to Windows machines (OpenSSH server): PowerShell instead of the POSIX scripts.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const { buildSpawn, buildTmuxKill, buildRemoteExec, windowsTarget } = require('../src/main/connect');
const { normalizeProject } = require('../src/main/store');

const win = { id: 'w', name: 'win', type: 'ssh', host: 'win1', user: 'bob', port: 22, remoteOs: 'windows', tmux: true, directory: '~/src/app', keepAlive: false };
const decode = (spec) => Buffer.from(spec.args[spec.args.length - 1].split(' ').pop(), 'base64').toString('utf16le');

test('windows ssh: the session starts PowerShell with an encoded script, without tmux', () => {
  const spec = buildSpawn(win, null, { id: 's1', name: 'shell', command: 'claude' });
  assert.deepStrictEqual(spec.args.slice(0, 2), ['-t', 'bob@win1']);
  assert.match(spec.args[2], /^powershell\.exe -NoLogo -NoExit -EncodedCommand [A-Za-z0-9+/=]+$/);
  assert.strictEqual(spec.tmuxName, null);
  assert.strictEqual(spec.postStart, '');
  assert.strictEqual(decode(spec), "$env:TERMCLAW_SID = 's1'\nSet-Location -LiteralPath (Join-Path $HOME 'src/app') -ErrorAction Continue\nclaude");
  const plain = buildSpawn({ ...win, directory: "C:\\Projects\\o'neil" }, null, { id: '', name: 'x', command: '' });
  assert.strictEqual(decode(plain), "Set-Location -LiteralPath 'C:\\Projects\\o''neil' -ErrorAction Continue");
});

test('windows ssh: POSIX features are refused; Linux ssh projects are unchanged', () => {
  assert.strictEqual(windowsTarget(win), true);
  assert.strictEqual(windowsTarget({ ...win, remoteOs: 'posix' }), false);
  assert.strictEqual(buildTmuxKill(win, null, 'x'), null);
  assert.throws(() => buildRemoteExec(win, null, 'ls'), /not available for Windows machines/);
  assert.throws(() => require('../src/main/files').filesFor(win, null), /file browser is not available/);
  const linux = buildSpawn({ ...win, remoteOs: 'posix' }, null, { id: 's1', name: 'shell', command: '' });
  assert.match(linux.args[linux.args.length - 1], /tmux/);
});

test('windows ssh: former PowerShell remoting projects become SSH projects to the same machine', () => {
  const p = normalizeProject({ id: 'old', name: 'old', type: 'psremote', host: 'DESKTOP-1', user: 'vogler', port: 5985, tmux: false, psremote: { ssl: true, port: 5986 } });
  assert.deepStrictEqual([p.type, p.remoteOs, p.port, p.host, p.user, p.tmux, 'psremote' in p], ['ssh', 'windows', 22, 'DESKTOP-1', 'vogler', false, false]);
  assert.strictEqual(normalizeProject({ name: 'x', type: 'ssh' }).remoteOs, 'posix');
});

test('windows ssh: the encoded command runs from cmd.exe as the default shell (Windows only)', (t) => {
  if (process.platform !== 'win32') return t.skip('needs Windows');
  const spec = buildSpawn({ ...win, directory: '' }, null, { id: 's9', name: 'x', command: 'Write-Output "sid=$env:TERMCLAW_SID"; exit' });
  // what sshd does with the remote command when cmd.exe is the default shell
  const r = spawnSync('cmd.exe', ['/d', '/c', spec.args[2].replace(' -NoExit', '')], { encoding: 'utf8', timeout: 30000 });
  assert.match(r.stdout, /sid=s9/);
});
