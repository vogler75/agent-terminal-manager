'use strict';
// Builds the process command line for a session: local shell, WSL or ssh, optionally wrapped in tmux.
const os = require('os');

const IS_WIN = process.platform === 'win32';
// node-pty on Windows needs the extension to find the executable on PATH.
const SSH_BIN = IS_WIN ? 'ssh.exe' : 'ssh';

// POSIX single-quote escaping for remote / WSL shells.
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// tmux session names may not contain '.' or ':'.
function tmuxName(project, sessionName) {
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  return `termclaw-${slug(project.name)}-${slug(sessionName)}`;
}

// Directory for use inside a POSIX shell: keep a leading ~ unquoted so it expands.
function posixDir(dir) {
  if (!dir) return '';
  if (dir === '~') return '~';
  if (dir.startsWith('~/')) return '~/' + shq(dir.slice(2));
  return shq(dir);
}

// Shell script that attaches to (or creates) a named tmux session, running `command` on creation.
// Falls back to a plain login shell when tmux is missing on the target.
// Sessions from before the rename (atm-…) are taken over: renamed to the new name; a session that
// already has the new name is kept as <name>-replaced, not killed.
function tmuxScript(name, dir, command) {
  const d = posixDir(dir);
  const cdPart = d ? `cd ${d} 2>/dev/null; ` : '';
  const create = `tmux new-session -d -s ${shq(name)}${d ? ` -c ${d}` : ''}` +
    (command ? ` && tmux send-keys -t ${shq(name)} ${shq(command)} Enter` : '');
  const legacy = name.startsWith('termclaw-') ? 'atm-' + name.slice('termclaw-'.length) : '';
  const takeOver = legacy
    ? `if tmux has-session -t ${shq('=' + legacy)} 2>/dev/null; then ` +
      `tmux has-session -t ${shq('=' + name)} 2>/dev/null && tmux rename-session -t ${shq('=' + name)} ${shq(name + '-replaced')}; ` +
      `tmux rename-session -t ${shq('=' + legacy)} ${shq(name)}; fi; `
    : '';
  return `${cdPart}if command -v tmux >/dev/null 2>&1; then ` + takeOver +
    `tmux has-session -t ${shq('=' + name)} 2>/dev/null || { ${create}; }; ` +
    `exec tmux attach-session -t ${shq('=' + name)}; ` +
    `else echo '[termclaw] tmux not found, starting plain shell'; ${command ? command + '; ' : ''}exec "\${SHELL:-/bin/sh}" -l; fi`;
}

// sid: marker in the shell's environment, so file transfers can find its current directory.
function plainScript(dir, sid) {
  const d = posixDir(dir);
  return `${sid ? `export TERMCLAW_SID=${shq(sid)}; ` : ''}${d ? `cd ${d} && ` : ''}exec "\${SHELL:-/bin/sh}" -l`;
}

// Resolve connection data: a project either references a dev host or has inline host/user/port.
function resolveTarget(project, host) {
  if (host) {
    return { hostname: host.hostname, user: host.user, port: host.port || 22 };
  }
  return { hostname: project.host, user: project.user, port: project.port || 22 };
}

function sshBaseArgs(project, target) {
  const args = [];
  if (target.port && Number(target.port) !== 22) args.push('-p', String(target.port));
  if (project.keepAlive) {
    args.push('-o', `ServerAliveInterval=${project.keepAliveInterval || 30}`);
    args.push('-o', `ServerAliveCountMax=${project.keepAliveCountMax || 3}`);
  }
  return args;
}

function sshDest(target) {
  if (!target.hostname) throw new Error('No host configured for this project');
  return target.user ? `${target.user}@${target.hostname}` : target.hostname;
}

// X11 forwarding for ssh sessions: 'off', 'wsl' (ssh inside WSL, shown by WSLg; Windows only)
// or 'display' (ssh -Y to the X server in DISPLAY, e.g. VcXsrv, X410 or XQuartz).
function x11Mode(project) {
  const m = project.x11 || 'off';
  if (m === 'wsl' && !IS_WIN) return 'display';
  return ['wsl', 'display'].includes(m) ? m : 'off';
}

// PowerShell remoting (WinRM) to a Windows machine: the session runs a local powershell.exe that connects with
// New-PSSession / Enter-PSSession. No password is stored: with a user name the password is asked in the terminal,
// without one the current Windows account is used (Kerberos / NTLM).
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const PS_AUTH = ['Default', 'Negotiate', 'Kerberos'];

function psPort(project) {
  const c = project.psremote || {};
  return Number(c.port) || (c.ssl ? 5986 : 5985);
}

function psremoteScript(project, session = {}) {
  const c = project.psremote || {};
  const hostName = project.host;
  if (!hostName) throw new Error('No host configured for this project');
  const auth = PS_AUTH.includes(c.auth) ? c.auth : 'Default';
  const dir = projectDir(project, null);
  const lines = ["$ErrorActionPreference = 'Stop'", `$h = ${psq(hostName)}`];
  if (project.user) {
    lines.push(`$u = ${psq(project.user)}`,
      'Write-Host "[termclaw] Connecting to $h as $u"',
      '$pw = Read-Host -AsSecureString "Password for $u"',
      '$cred = New-Object System.Management.Automation.PSCredential($u, $pw)');
  } else {
    lines.push('Write-Host "[termclaw] Connecting to $h with the current Windows account"');
  }
  const opt = ['-OpenTimeout 20000'];
  if (c.skipCertCheck) opt.push('-SkipCACheck', '-SkipCNCheck', '-SkipRevocationCheck');
  lines.push(`$so = New-PSSessionOption ${opt.join(' ')}`);
  lines.push('try {',
    `  $s = New-PSSession -ComputerName $h -Port ${psPort(project)}${c.ssl ? ' -UseSSL' : ''} -Authentication ${auth}${project.user ? ' -Credential $cred' : ''} -SessionOption $so`);
  if (dir) lines.push(`  Invoke-Command -Session $s -ScriptBlock { param($d) Set-Location -LiteralPath $d } -ArgumentList ${psq(dir)}`);
  if (session.command) lines.push(`  Invoke-Command -Session $s -ScriptBlock { ${session.command} }`);
  lines.push('  Enter-PSSession -Session $s',
    '  Remove-PSSession $s',
    '  exit',
    '} catch {',
    '  Write-Host ""',
    '  Write-Host "[termclaw] Could not connect to ${h}: $($_.Exception.Message)" -ForegroundColor Red',
    '  Write-Host "On the remote machine (as administrator): Enable-PSRemoting -Force" -ForegroundColor Yellow',
    '  Write-Host "On this machine, if the remote machine is not in your domain (as administrator): Set-Item WSMan:\\localhost\\Client\\TrustedHosts -Value $h -Concatenate -Force" -ForegroundColor Yellow',
    '  Write-Host "More hints: project editor, PowerShell remoting, Setup help." -ForegroundColor Yellow',
    '}');
  return lines.join('\n');
}

function projectDir(project, host) {
  if (project.directory) return project.directory;
  if (host && host.workspace) return host.workspace;
  return '';
}

/**
 * Returns { file, args, cwd, postStart } where postStart is text typed into the terminal
 * once the shell is up (used for start commands when tmux does not run them).
 */
function buildSpawn(project, host, session) {
  const command = session.command || '';
  const useTmux = !!project.tmux;
  const name = tmuxName(project, session.name);
  const dir = projectDir(project, host);

  if (project.type === 'ssh') {
    const target = resolveTarget(project, host);
    const script = useTmux ? tmuxScript(name, dir, command) : plainScript(dir, session.id);
    const sshArgs = ['-t', ...sshBaseArgs(project, target), sshDest(target), script];
    const spec = { file: SSH_BIN, args: sshArgs, cwd: os.homedir(), postStart: !useTmux && command ? command : '', tmuxName: useTmux ? name : null };
    const x11 = x11Mode(project);
    if (x11 === 'wsl') {
      // WSLg's X server is only reachable inside WSL, so the ssh client of the distribution runs the session.
      spec.file = 'wsl.exe';
      spec.args = [...(project.wslDistro ? ['-d', project.wslDistro] : []), '--exec', 'ssh', '-Y', ...sshArgs];
    } else if (x11 === 'display') {
      spec.args = ['-Y', ...sshArgs];
      const display = project.x11Display || process.env.DISPLAY || (IS_WIN ? 'localhost:0.0' : '');
      if (display) spec.env = { DISPLAY: display };
    }
    return spec;
  }

  if (project.type === 'psremote') {
    if (!IS_WIN) throw new Error('PowerShell remoting (WinRM) needs the Windows version of TermClaw. Use an SSH project (OpenSSH on the Windows machine) from here.');
    const enc = Buffer.from(psremoteScript(project, { command }), 'utf16le').toString('base64');
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], cwd: os.homedir(), postStart: '', tmuxName: null };
  }

  if (project.type === 'wsl') {
    const args = [];
    if (project.wslDistro) args.push('-d', project.wslDistro);
    if (dir) args.push('--cd', dir);
    if (useTmux) args.push('--', 'bash', '-lc', tmuxScript(name, '', command));
    return { file: 'wsl.exe', args, cwd: os.homedir(), postStart: !useTmux && command ? command : '', tmuxName: useTmux ? name : null };
  }

  // local
  const cwd = dir ? dir.replace(/^~(?=$|[\\/])/, os.homedir()) : os.homedir();
  if (IS_WIN) {
    return { file: 'powershell.exe', args: ['-NoLogo'], cwd, postStart: command, tmuxName: null };
  }
  const shell = process.env.SHELL || '/bin/zsh';
  if (useTmux) {
    return { file: shell, args: ['-lc', tmuxScript(name, cwd, command)], cwd, postStart: '', tmuxName: name };
  }
  return { file: shell, args: ['-l'], cwd, postStart: command, tmuxName: null };
}

// Command used to kill a tmux session on the target when the user closes a session for good.
function buildTmuxKill(project, host, name) {
  if (project.type === 'psremote') return null;
  const script = `tmux kill-session -t ${shq('=' + name)} 2>/dev/null; true`;
  if (project.type === 'ssh') {
    const target = resolveTarget(project, host);
    return { file: 'ssh', args: ['-o', 'BatchMode=yes', ...sshBaseArgs(project, target), sshDest(target), script] };
  }
  if (project.type === 'wsl') {
    const args = project.wslDistro ? ['-d', project.wslDistro] : [];
    return { file: 'wsl.exe', args: [...args, '--exec', 'bash', '-lc', script] };
  }
  if (!IS_WIN) return { file: process.env.SHELL || '/bin/sh', args: ['-lc', script] };
  return null;
}

// Arguments for a background ssh process that only does port forwarding.
function buildForwardArgs(project, host) {
  const target = resolveTarget(project, host);
  const args = ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', ...sshBaseArgs(project, target)];
  for (const f of project.forwards || []) {
    if (!f.local || !f.remote) continue;
    args.push('-L', `127.0.0.1:${Number(f.local)}:${f.remoteHost || 'localhost'}:${Number(f.remote)}`);
  }
  args.push(sshDest(target));
  return args;
}

// Run one command on the target and capture its output (used by MCP create_directory, host checks).
function buildRemoteExec(project, host, script) {
  if (project.type === 'psremote') throw new Error('This feature is not available for PowerShell remoting projects (use an SSH project).');
  if (project.type === 'ssh' || (!project.type && host)) {
    const target = resolveTarget(project, host);
    return { file: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...sshBaseArgs(project, target), sshDest(target), script] };
  }
  if (project.type === 'wsl') {
    const args = project.wslDistro ? ['-d', project.wslDistro] : [];
    return { file: 'wsl.exe', args: [...args, '--exec', 'bash', '-lc', script] };
  }
  if (IS_WIN) return { file: 'powershell.exe', args: ['-NoProfile', '-Command', script] };
  return { file: process.env.SHELL || '/bin/sh', args: ['-lc', script] };
}

module.exports = {
  SSH_BIN, psremoteScript, psPort, psq, buildSpawn, buildTmuxKill, buildForwardArgs, buildRemoteExec,
  tmuxName, tmuxScript, shq, posixDir, resolveTarget, sshBaseArgs, sshDest, projectDir, x11Mode,
};
