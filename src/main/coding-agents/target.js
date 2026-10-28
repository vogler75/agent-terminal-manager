'use strict';
// Execution target for agent setup: runs a script on the project's machine and builds file paths.
// "posix" = sh/bash on Linux/macOS (local, SSH or WSL), "powershell" = local Windows project.
// Scripts are passed via stdin, so there are no quoting or command-line length issues.
const { spawn } = require('child_process');
const os = require('os');
const { resolveTarget, sshBaseArgs, sshDest, projectDir, SSH_BIN } = require('../connect');

const IS_WIN = process.platform === 'win32';

// POSIX double-quote escaping (keeps the string literal inside "...").
const dq = (s) => String(s).replace(/(["\\$`])/g, '\\$1');
// PowerShell single-quote escaping.
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const BASH_OR_SH = 'command -v bash >/dev/null 2>&1 && exec bash -s || exec sh -s';
// PowerShell bootstrap: read the real script from stdin and run it as one block.
const PS_BOOTSTRAP = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $s=[Console]::In.ReadToEnd(); Invoke-Expression $s';

class Target {
  constructor(project, host) {
    this.project = project;
    this.host = host;
    this.kind = project.type === 'local' && IS_WIN ? 'powershell' : 'posix';
    const dir = projectDir(project, host);
    if (this.kind === 'powershell') this.dir = dir ? dir.replace(/^~(?=$|[\\/])/, os.homedir()) : os.homedir();
    else if (project.type === 'local') this.dir = dir ? dir.replace(/^~(?=$|\/)/, os.homedir()) : os.homedir();
    else this.dir = dir || '~';
  }

  spawnSpec() {
    const p = this.project;
    if (this.kind === 'powershell') {
      const enc = Buffer.from(PS_BOOTSTRAP, 'utf16le').toString('base64');
      return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc] };
    }
    if (p.type === 'ssh') {
      const t = resolveTarget(p, this.host);
      return { file: SSH_BIN, args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...sshBaseArgs({ ...p, keepAlive: false }, t), sshDest(t), BASH_OR_SH] };
    }
    if (p.type === 'wsl') {
      return { file: 'wsl.exe', args: [...(p.wslDistro ? ['-d', p.wslDistro] : []), '--', 'sh', '-c', BASH_OR_SH] };
    }
    return { file: '/bin/sh', args: ['-c', BASH_OR_SH] };
  }

  // Run a script; resolves {code, out, err}.
  run(script, { timeout = 120000 } = {}) {
    const spec = this.spawnSpec();
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let p;
      try { p = spawn(spec.file, spec.args, { windowsHide: true }); } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
      const t = setTimeout(() => { try { p.kill(); } catch {} err += '\n[timeout]'; }, timeout);
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); });
      p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
      p.stdin.on('error', () => {});
      p.stdin.end(this.kind === 'powershell' ? script : script.replace(/\r\n/g, '\n'));
    });
  }

  // A location is {base: 'home' | 'project', rel: 'a/b/c'}; returns a shell expression for the path.
  pathExpr(loc) {
    const rel = loc.rel.replace(/^\/+/, '');
    if (this.kind === 'powershell') {
      const base = loc.base === 'home' ? '$HOME' : psq(this.dir);
      return `(Join-Path ${base} ${psq(rel.replace(/\//g, '\\'))})`;
    }
    if (loc.base === 'home') return `"$HOME/${dq(rel)}"`;
    const d = this.dir;
    if (d === '~') return `"$HOME/${dq(rel)}"`;
    if (d.startsWith('~/')) return `"$HOME/${dq(d.slice(2).replace(/\/$/, ''))}/${dq(rel)}"`;
    return `"${dq(d.replace(/\/$/, ''))}/${dq(rel)}"`;
  }

  // Human-readable path for reports.
  displayPath(loc) {
    if (loc.base === 'home') return (this.kind === 'powershell' ? '%USERPROFILE%\\' : '~/') + (this.kind === 'powershell' ? loc.rel.replace(/\//g, '\\') : loc.rel);
    const sep = this.kind === 'powershell' ? '\\' : '/';
    return this.dir.replace(/[\\/]$/, '') + sep + (this.kind === 'powershell' ? loc.rel.replace(/\//g, '\\') : loc.rel);
  }

  // Preamble that makes user-installed CLIs (npm, nvm, bun, native installers) findable.
  preamble() {
    if (this.kind === 'powershell') {
      return [
        "$ErrorActionPreference = 'Continue'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$extra = @((Join-Path $HOME '.local\\bin'), (Join-Path $env:APPDATA 'npm'), (Join-Path $HOME '.bun\\bin'), (Join-Path $HOME '.opencode\\bin'))",
        "foreach ($d in $extra) { if ((Test-Path $d) -and -not (($env:Path -split ';') -contains $d)) { $env:Path = $d + ';' + $env:Path } }",
      ].join('\n');
    }
    return [
      'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$HOME/.opencode/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"',
      'for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done',
      'export PATH',
    ].join('\n');
  }

  // ---- script snippets ----
  // Prints @@V <first output line> and @@RC <exit code>, or @@NONE. On WSL, Windows binaries
  // reachable through /mnt/c are not Linux installs and count as missing.
  detectSnippet(key, bin, versionArgs = '--version') {
    if (this.kind === 'powershell') {
      return `Write-Output '@@ATM detect ${key}'\n` +
        `$c = Get-Command ${psq(bin)} -ErrorAction SilentlyContinue | Select-Object -First 1\n` +
        `if ($c) { $global:LASTEXITCODE = 0; try { $o = @(& $c.Source ${versionArgs} 2>&1); $rc = $LASTEXITCODE; $v = ($o | Select-Object -First 1) -as [string] } catch { $v = $_.Exception.Message; $rc = 1 }; Write-Output ('@@V ' + $v); Write-Output ('@@RC ' + $rc) } else { Write-Output '@@NONE' }`;
    }
    return `echo '@@ATM detect ${key}'\n` +
      `p=$(command -v ${bin} 2>/dev/null)\n` +
      `case "$p" in ''|/mnt/[a-z]/*) echo '@@NONE' ;; *) v=$(${bin} ${versionArgs} 2>&1 </dev/null); rc=$?; echo "@@V $(printf '%s\\n' "$v" | head -n 1)"; echo "@@RC $rc" ;; esac`;
  }

  readSnippet(key, loc) {
    const p = this.pathExpr(loc);
    if (this.kind === 'powershell') {
      return `Write-Output '@@ATM file ${key}'\n$p = ${p}\n` +
        `if (Test-Path -LiteralPath $p -PathType Leaf) { Write-Output ('@@B ' + [Convert]::ToBase64String([IO.File]::ReadAllBytes($p))) } else { Write-Output '@@NONE' }`;
    }
    return `echo '@@ATM file ${key}'\nif [ -f ${p} ]; then printf '@@B '; base64 < ${p} | tr -d '\\n\\r'; echo; else echo '@@NONE'; fi`;
  }

  // content: text, or {base64} for binary files.
  writeSnippet(loc, content) {
    const p = this.pathExpr(loc);
    const b64 = content && content.base64 !== undefined ? content.base64 : Buffer.from(content, 'utf8').toString('base64');
    if (this.kind === 'powershell') {
      return `$p = ${p}\nNew-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null\n` +
        `[IO.File]::WriteAllBytes($p, [Convert]::FromBase64String('${b64}'))`;
    }
    // Write through a temp file so a failed decode never truncates the original.
    return `mkdir -p "$(dirname ${p})" && printf '%s' '${b64}' | base64 -d > ${p}.atm-tmp && mv ${p}.atm-tmp ${p}`;
  }

  removeDirSnippet(loc) {
    const p = this.pathExpr(loc);
    if (this.kind === 'powershell') return `$p = ${p}\nif (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }`;
    return `rm -rf ${p}`;
  }

  // Stop at the first failing statement (used around file writes, so a failed write never reports success).
  strict(on) {
    if (this.kind === 'powershell') return on ? "$ErrorActionPreference = 'Stop'" : "$ErrorActionPreference = 'Continue'";
    return on ? 'set -e' : 'set +e';
  }

  echo(text) {
    return this.kind === 'powershell' ? `Write-Output ${psq(text)}` : `echo '${String(text).replace(/'/g, "'\\''")}'`;
  }

  // Run a command, then print its exit status as a marker line.
  commandSnippet(key, cmd) {
    if (this.kind === 'powershell') {
      return `Write-Output '@@ATM cmd ${key}'\n$global:LASTEXITCODE = 0\ntry { ${cmd} 2>&1 | ForEach-Object { "$_" } } catch { Write-Output $_.Exception.Message; $global:LASTEXITCODE = 1 }\nWrite-Output ('@@EXIT ' + $LASTEXITCODE)`;
    }
    return `echo '@@ATM cmd ${key}'\n( ${cmd} ) 2>&1; echo "@@EXIT $?"`;
  }
}

// Parse "@@ATM <type> <key>" sections from script output.
function parseSections(out) {
  const res = { detect: {}, file: {}, cmd: {} };
  let cur = null;
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    const m = /^@@ATM (detect|file|cmd) (\S+)$/.exec(line);
    if (m) { cur = { type: m[1], key: m[2], lines: [] }; res[m[1]][m[2]] = cur; continue; }
    if (cur) cur.lines.push(line);
  }
  const out2 = { detect: {}, file: {}, cmd: {} };
  for (const [k, s] of Object.entries(res.detect)) {
    const v = s.lines.find((l) => l.startsWith('@@V '));
    const rc = s.lines.find((l) => l.startsWith('@@RC '));
    if (!v) out2.detect[k] = { installed: false };
    else if (rc && rc.slice(5).trim() !== '0') out2.detect[k] = { installed: true, working: false, version: '', problem: v.slice(4).trim().slice(0, 200) };
    else out2.detect[k] = { installed: true, working: true, version: v.slice(4).trim() };
  }
  for (const [k, s] of Object.entries(res.file)) {
    const b = s.lines.find((l) => l.startsWith('@@B '));
    out2.file[k] = b ? Buffer.from(b.slice(4).trim(), 'base64').toString('utf8') : null;
  }
  for (const [k, s] of Object.entries(res.cmd)) {
    const e = s.lines.find((l) => l.startsWith('@@EXIT '));
    const status = e ? e.slice(7).trim() : '';
    out2.cmd[k] = { ok: status === '0' || status === 'True', output: s.lines.filter((l) => !l.startsWith('@@EXIT ')).join('\n').trim() };
  }
  return out2;
}

module.exports = { Target, parseSections, dq, psq };
