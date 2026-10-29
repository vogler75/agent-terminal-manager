'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildSpawn, buildRemoteExec, buildTmuxKill, psremoteScript, psPort, psq } = require('../src/main/connect');
const { trustedMatches, hintsFor } = require('../src/main/psremote');
const { Store } = require('../src/main/store');
const { unsupported } = require('../src/main/monitor');
const { dialSpec } = require('../src/main/docker');

const win = { name: 'Win Box', type: 'psremote', host: 'win1', user: '', directory: 'C:\work dir', psremote: { ssl: false, port: '', auth: 'Default', skipCertCheck: false } };

test('psremote: quoting and default ports', () => {
  assert.strictEqual(psq("it's"), "'it''s'");
  assert.strictEqual(psPort(win), 5985);
  assert.strictEqual(psPort({ psremote: { ssl: true } }), 5986);
  assert.strictEqual(psPort({ psremote: { ssl: true, port: 6000 } }), 6000);
});

test('psremote: script uses the current account without a user and never stores a password', () => {
  const s = psremoteScript(win);
  assert.match(s, /\$h = 'win1'/);
  assert.match(s, /New-PSSession -ComputerName \$h -Port 5985 -Authentication Default -SessionOption \$so/);
  assert.ok(!s.includes('-Credential'));
  assert.match(s, /Set-Location -LiteralPath \$d } -ArgumentList 'C:\work dir'/);
  assert.match(s, /Enter-PSSession -Session \$s/);
  assert.match(s, /Enable-PSRemoting -Force/);
});

test('psremote: with a user the password is asked in the terminal; HTTPS and self-signed options', () => {
  const s = psremoteScript({ ...win, user: "WIN1\o'brien", psremote: { ssl: true, port: '', auth: 'Negotiate', skipCertCheck: true } }, { command: 'hostname' });
  assert.match(s, /\$u = 'WIN1\o''brien'/);
  assert.match(s, /Read-Host -AsSecureString/);
  assert.match(s, /-Port 5986 -UseSSL -Authentication Negotiate -Credential \$cred/);
  assert.match(s, /New-PSSessionOption -OpenTimeout 20000 -SkipCACheck -SkipCNCheck -SkipRevocationCheck/);
  assert.match(s, /ScriptBlock { hostname }/);
  assert.throws(() => psremoteScript({ ...win, host: '' }), /No host/);
  assert.match(psremoteScript({ ...win, psremote: { auth: 'Basic' } }), /-Authentication Default/); // unknown values fall back
});

test('psremote: session spawn is an encoded local PowerShell (Windows only)', () => {
  if (process.platform !== 'win32') return assert.throws(() => buildSpawn(win, null, { name: 'a' }), /Windows version/);
  const spec = buildSpawn(win, null, { name: 'a' });
  assert.strictEqual(spec.file, 'powershell.exe');
  assert.ok(spec.args.includes('-NoExit'));
  const script = Buffer.from(spec.args[spec.args.length - 1], 'base64').toString('utf16le');
  assert.strictEqual(script, psremoteScript(win, {}));
  assert.strictEqual(spec.tmuxName, null);
});

test('psremote: features that need a POSIX machine say so', () => {
  assert.throws(() => buildRemoteExec(win, null, 'true'), /PowerShell remoting/);
  assert.throws(() => dialSpec(win, null), /PowerShell remoting/);
  assert.strictEqual(buildTmuxKill(win, null, 'x'), null);
  assert.match(unsupported(win), /Linux/);
});

test('psremote: TrustedHosts matching', () => {
  assert.ok(trustedMatches('a, win1 ,b', 'WIN1'));
  assert.ok(trustedMatches('*', 'x'));
  assert.ok(trustedMatches('*.corp.local', 'srv.corp.local'));
  assert.ok(!trustedMatches('*.corp.local', 'srv.other.local'));
  assert.ok(!trustedMatches('', 'win1'));
});

test('psremote: hints name the next step', () => {
  const c = { project: win };
  const closed = hintsFor(c, { tcp: { ok: false, error: 'ETIMEDOUT' }, wsman: { ok: false }, trusted: { known: false } });
  assert.ok(closed.some((x) => /Enable-PSRemoting -Force/.test(x)));
  assert.ok(closed.some((x) => /SkipNetworkProfileCheck/.test(x)));
  const untrusted = hintsFor(c, { tcp: { ok: true }, wsman: { ok: true }, trusted: { known: true, match: false } });
  assert.ok(untrusted.some((x) => /TrustedHosts -Value win1/.test(x)));
  const https = hintsFor({ project: { ...win, psremote: { ssl: true } } }, { tcp: { ok: true }, wsman: { ok: true }, trusted: { known: true, match: false } });
  assert.ok(!https.some((x) => /TrustedHosts -Value/.test(x)));
});

test('psremote: project defaults are filled in by the store', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termclaw-ps-'));
  const st = new Store(dir);
  const p = st.saveProject({ name: 'w', type: 'psremote', host: 'win1', psremote: { ssl: true } });
  assert.deepStrictEqual(p.psremote, { ssl: true, port: '', auth: 'Default', skipCertCheck: false });
  assert.strictEqual(st.saveProject({ name: 'x', type: 'ssh', host: 'h' }).psremote.ssl, false);
});

test('psremote: the generated script is valid PowerShell (checked with the PowerShell parser on Windows)', () => {
  if (process.platform !== 'win32') return;
  const { spawnSync } = require('child_process');
  const variants = [win, { ...win, user: 'WIN1\bob', psremote: { ssl: true, port: 6000, auth: 'Kerberos', skipCertCheck: true } }];
  for (const p of variants) {
    const script = psremoteScript(p, { command: 'hostname' });
    const check = '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.Message }; exit 1 }';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', check], { input: script, encoding: 'utf8', timeout: 30000 });
    assert.strictEqual(r.status, 0, 'PowerShell parse errors: ' + r.stdout + r.stderr);
  }
});
