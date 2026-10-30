'use strict';
// Builds the process command line for a session: local shell, WSL or ssh, optionally wrapped in tmux.
const os = require('os');
const path = require('path');
const fs = require('fs');

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

// SSH to a Windows machine (OpenSSH server): its default shell is cmd.exe or PowerShell, so the session starts
// PowerShell with an encoded script (no quoting differences between the two) instead of the POSIX scripts.
const windowsTarget = (project) => project.type === 'ssh' && project.remoteOs === 'windows';
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function windowsSessionCommand(dir, sid, command) {
  const lines = [];
  if (sid) lines.push(`$env:TERMCLAW_SID = ${psq(sid)}`);
  if (dir) {
    const home = /^~(?:[\\/](.*))?$/.exec(dir); // ~ and ~/x are relative to the user's profile folder
    const target = home ? (home[1] ? `(Join-Path $HOME ${psq(home[1])})` : '$HOME') : psq(dir);
    lines.push(`Set-Location -LiteralPath ${target} -ErrorAction Continue`);
  }
  if (command) lines.push(command);
  const enc = Buffer.from(lines.join('\n') || ' ', 'utf16le').toString('base64');
  return `powershell.exe -NoLogo -NoExit -EncodedCommand ${enc}`;
}

function windowsOnlyTerminal(what) {
  return `${what} is not available for Windows machines (it needs a Linux or macOS shell on the machine).`;
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
// Shells on this computer, independent of the project type. Ids: powershell, pwsh, cmd, gitbash, wsl, wsl:<distro>,
// or an absolute shell path on macOS / Linux.
const GIT_BASH = ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)', 'LOCALAPPDATA']
  .map((v) => process.env[v] && path.join(process.env[v], v === 'LOCALAPPDATA' ? path.join('Programs', 'Git') : 'Git', 'bin', 'bash.exe'))
  .filter(Boolean);
const findGitBash = () => GIT_BASH.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

function localShellLabel(id) {
  if (!id) return '';
  if (id === 'powershell') return 'Windows PowerShell';
  if (id === 'pwsh') return 'PowerShell 7';
  if (id === 'cmd') return 'Command Prompt';
  if (id === 'gitbash') return 'Git Bash';
  if (id === 'wsl') return 'WSL (default distribution)';
  if (id.startsWith('wsl:')) return 'WSL: ' + id.slice(4);
  return id.split('/').pop();
}

// Short session name for a local shell.
function localShellName(id) {
  if (id.startsWith('wsl:')) return 'wsl-' + id.slice(4).toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return { powershell: 'powershell', pwsh: 'pwsh', cmd: 'cmd', gitbash: 'bash', wsl: 'wsl' }[id] || id.split('/').pop();
}

// Shells available on this computer: [{id, label}]. Cached for a minute (wsl.exe -l is slow-ish).
let shellCache = null;
async function detectLocalShells() {
  if (shellCache && Date.now() - shellCache.at < 60000) return shellCache.list;
  const { execFile } = require('child_process');
  const run = (file, args) => new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 8000, encoding: 'buffer' }, (err, out) => resolve(err ? null : out)));
  const ids = [];
  if (IS_WIN) {
    ids.push('powershell');
    if (await run('where.exe', ['pwsh.exe'])) ids.push('pwsh');
    ids.push('cmd');
    if (findGitBash()) ids.push('gitbash');
    // wsl.exe -l -q prints UTF-16LE, one distribution per line.
    const out = await run('wsl.exe', ['-l', '-q']);
    const distros = out ? out.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
    for (const d of distros) if (!/^docker-desktop/.test(d)) ids.push('wsl:' + d);
  } else {
    let shells = [];
    try { shells = fs.readFileSync('/etc/shells', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')); } catch {}
    const seen = new Set();
    for (const sh of [process.env.SHELL, ...shells].filter(Boolean)) {
      const base = sh.split('/').pop();
      if (seen.has(base) || !fs.existsSync(sh)) continue;
      seen.add(base);
      ids.push(sh);
    }
  }
  const list = ids.map((id) => ({ id, label: localShellLabel(id) }));
  shellCache = { at: Date.now(), list };
  return list;
}

// Spawn spec for a local shell (no tmux). dir empty = home directory.
function buildLocalShell(shell, command = '') {
  const id = shell.id || '';
  const dir = (shell.dir || '').trim();
  const winDir = dir ? dir.replace(/^~(?=$|[\\/])/, os.homedir()) : os.homedir();
  const base = { cwd: winDir, postStart: command, tmuxName: null };
  if (id === 'wsl' || id.startsWith('wsl:')) {
    if (!IS_WIN) throw new Error('WSL shells are only available on Windows');
    const distro = id.startsWith('wsl:') ? id.slice(4) : '';
    return { ...base, cwd: os.homedir(), file: 'wsl.exe', args: [...(distro ? ['-d', distro] : []), '--cd', dir || '~'] };
  }
  if (IS_WIN) {
    if (id === 'powershell' || !id) return { ...base, file: 'powershell.exe', args: ['-NoLogo'] };
    if (id === 'pwsh') return { ...base, file: 'pwsh.exe', args: ['-NoLogo'] };
    if (id === 'cmd') return { ...base, file: 'cmd.exe', args: [] };
    if (id === 'gitbash') {
      const bash = findGitBash();
      if (!bash) throw new Error('Git Bash not found (looked for Git\\bin\\bash.exe in the program folders)');
      return { ...base, file: bash, args: ['--login', '-i'], env: { CHERE_INVOKING: '1' } };
    }
    throw new Error('Unknown local shell: ' + id);
  }
  const file = id && id.startsWith('/') ? id : process.env.SHELL || '/bin/sh';
  return { ...base, cwd: dir ? dir.replace(/^~(?=$|\/)/, os.homedir()) : os.homedir(), file, args: ['-l'] };
}

function buildSpawn(project, host, session) {
  const command = session.command || '';
  // A local shell can be opened in any project, also next to remote sessions.
  if (session.shell && session.shell.id !== undefined) return buildLocalShell(session.shell, command);
  const useTmux = !!project.tmux;
  const name = tmuxName(project, session.name);
  const dir = projectDir(project, host);

  if (project.type === 'ssh') {
    const target = resolveTarget(project, host);
    const win = windowsTarget(project); // no tmux on Windows; the start command runs in the PowerShell
    const tmuxOn = useTmux && !win;
    const script = win ? windowsSessionCommand(dir, session.id, command) : tmuxOn ? tmuxScript(name, dir, command) : plainScript(dir, session.id);
    const sshArgs = ['-t', ...sshBaseArgs(project, target), sshDest(target), script];
    const spec = { file: SSH_BIN, args: sshArgs, cwd: os.homedir(), postStart: !tmuxOn && !win && command ? command : '', tmuxName: tmuxOn ? name : null };
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
  if (windowsTarget(project)) return null;
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
  if (windowsTarget(project)) throw new Error(windowsOnlyTerminal('This feature'));
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
  SSH_BIN, windowsTarget, windowsOnlyTerminal, windowsSessionCommand, psq, buildSpawn, buildTmuxKill, buildForwardArgs, buildRemoteExec,
  tmuxName, tmuxScript, shq, posixDir, resolveTarget, sshBaseArgs, sshDest, projectDir, x11Mode,
  buildLocalShell, localShellLabel, localShellName, findGitBash, detectLocalShells,
};
