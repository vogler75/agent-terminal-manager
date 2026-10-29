'use strict';
// File access for a project's machine: list directories, upload and download files and folders.
// SSH and WSL go through `ssh` / `wsl.exe` with the data on stdin/stdout (cat for files, tar for folders);
// local projects use the file system directly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { buildRemoteExec, shq, posixDir, projectDir } = require('./connect');

const IS_WIN = process.platform === 'win32';
const LOCAL_TAR = IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

// Lists a directory as "type\tsize\tmtime\tname\0" entries after the resolved path line.
// GNU find (Linux), else stat -c (busybox), else BSD stat (macOS).
const LIST_SCRIPT = (dir) => `cd ${dir} || exit 3; pwd -P; printf '\\0'
if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then
  find . -mindepth 1 -maxdepth 1 -printf '%Y\\t%s\\t%T@\\t%f\\0' 2>/dev/null
elif stat -c '%F' . >/dev/null 2>&1; then
  for f in .[!.]* ..?* *; do [ -e "$f" ] || [ -L "$f" ] || continue; if [ -d "$f" ]; then t=d; else t=f; fi; printf '%s\\t%s\\t%s\\t%s\\0' "$t" "$(stat -c %s "$f")" "$(stat -c %Y "$f")" "$f"; done
else
  for f in .[!.]* ..?* *; do [ -e "$f" ] || [ -L "$f" ] || continue; if [ -d "$f" ]; then t=d; else t=f; fi; printf '%s\\t%s\\t%s\\t%s\\0' "$t" "$(stat -f %z "$f")" "$(stat -f %m "$f")" "$f"; done
fi`;

// Working directory of the session's shell, found by the TERMCLAW_SID marker in its environment (Linux /proc):
// the newest shell process carrying the marker (so a nested shell wins).
const CWD_SCRIPT = (sid) => `bn=0; best=
for f in /proc/[0-9]*/environ; do
  grep -qzs ${shq('^TERMCLAW_SID=' + sid + '$')} "$f" 2>/dev/null || continue
  p=\${f%/environ}; n=\${p#/proc/}
  case "$(cat "$p/comm" 2>/dev/null)" in bash|zsh|sh|fish|dash|ksh|mksh|ash) [ "$n" -gt "$bn" ] && { bn=$n; best=$p; } ;; esac
done
[ -n "$best" ] && readlink "$best/cwd"`;

function parseList(out) {
  const parts = out.split('\0');
  const dir = parts.shift().trim();
  const entries = [];
  for (const rec of parts) {
    if (!rec) continue;
    const [t, size, mtime, ...rest] = rec.replace(/^\n/, '').split('\t');
    const name = rest.join('\t');
    if (!name || name === '.' || name === '..') continue;
    entries.push({ name, type: t === 'd' ? 'dir' : 'file', size: Number(size) || 0, mtime: Math.round(Number(mtime) * 1000) || 0 });
  }
  return { path: dir, entries: sortEntries(entries) };
}

const sortEntries = (list) => list.sort((a, b) => (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

const posixJoin = (dir, name) => (dir.endsWith('/') ? dir : dir + '/') + name;
const validName = (n) => typeof n === 'string' && n && n !== '.' && n !== '..' && !/[/\0]/.test(n);

// Bytes passing through a stream, for progress reports.
function counter(onBytes) {
  const { Transform } = require('stream');
  return new Transform({ transform(chunk, _e, cb) { onBytes(chunk.length); cb(null, chunk); } });
}

function localSize(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of fs.readdirSync(p)) { try { total += localSize(path.join(p, e)); } catch {} }
  return total;
}

class RemoteFiles {
  constructor(project, host) {
    this.project = project;
    this.host = host;
    this.label = project.type === 'wsl' ? `WSL ${project.wslDistro || ''}`.trim() : (host ? host.name : project.host);
  }

  // Runs a POSIX script on the target. stdin: Buffer/stream; stdout: a writable to stream into (else collected).
  run(script, { stdin, stdout, timeout = 30000 } = {}) {
    const spec = buildRemoteExec(this.project, this.host, script);
    return new Promise((resolve, reject) => {
      const p = spawn(spec.file, spec.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const out = [];
      let err = '';
      let timer = timeout ? setTimeout(() => { p.kill(); reject(new Error('timed out')); }, timeout) : null;
      const touch = () => { if (timer) { clearTimeout(timer); timer = setTimeout(() => { p.kill(); reject(new Error('timed out')); }, timeout); } };
      if (stdout) { p.stdout.on('data', touch); p.stdout.pipe(stdout, { end: false }); } else p.stdout.on('data', (d) => out.push(d));
      p.stderr.on('data', (d) => (err += d));
      p.on('error', (e) => { clearTimeout(timer); reject(new Error(/ENOENT/.test(e.message) ? `${spec.file} not found` : e.message)); });
      p.on('close', (code) => {
        clearTimeout(timer);
        const text = Buffer.concat(out).toString('utf8');
        if (code === 0) resolve(text);
        else reject(new Error(cleanErr(err) || `exit code ${code}`));
      });
      if (stdin && typeof stdin.pipe === 'function') { stdin.on('data', touch); stdin.on('error', (e) => { p.kill(); reject(e); }); stdin.pipe(p.stdin); } else p.stdin.end(stdin || undefined);
    });
  }

  async home() {
    return (await this.run(`cd ${posixDir(projectDir(this.project, this.host)) || '~'} 2>/dev/null || cd; pwd -P`)).trim();
  }

  async list(dir) {
    const d = dir ? posixDir(dir) : posixDir(projectDir(this.project, this.host)) || '~';
    return parseList(await this.run(LIST_SCRIPT(d)));
  }

  // Current directory of a terminal session: tmux pane path, else the shell found by its marker.
  async sessionCwd(session) {
    if (session.cwd) return session.cwd; // reported by the shell itself (OSC 7)
    if (session.tmuxName) {
      // "=name:" = active pane of exactly that session ("=name" alone does not resolve to a pane)
      const r = await this.run(`tmux display-message -p -t ${shq('=' + session.tmuxName + ':')} '#{pane_current_path}' 2>/dev/null`).catch(() => '');
      if (r.trim()) return r.trim();
    }
    const r = await this.run(CWD_SCRIPT(session.id)).catch(() => '');
    return r.trim() || this.home();
  }

  async exists(dir, names) {
    const checks = names.filter(validName).map((n) => `[ -e ${shq(posixJoin(dir, n))} ] && printf '%s\\0' ${shq(n)}`).join('; ');
    if (!checks) return [];
    return (await this.run(`${checks}; true`)).split('\0').filter(Boolean);
  }

  async mkdir(dir, name) {
    if (!validName(name)) throw new Error('Invalid folder name');
    await this.run(`mkdir -- ${shq(posixJoin(dir, name))}`);
  }

  // Upload local files/folders into dir. onProgress(bytesDone, bytesTotal).
  async upload(localPaths, dir, { onProgress } = {}) {
    const total = localPaths.reduce((s, p) => s + localSize(p), 0);
    let done = 0;
    const tick = (n) => { done += n; onProgress && onProgress(Math.min(done, total), total); }; // tar adds headers
    for (const lp of localPaths) {
      const name = path.basename(lp);
      if (!validName(name)) throw new Error('Invalid file name ' + name);
      const dest = posixJoin(dir, name);
      if (fs.statSync(lp).isDirectory()) {
        const tar = spawn(LOCAL_TAR, ['-cf', '-', '-C', path.dirname(lp), name], { windowsHide: true });
        let tarErr = '';
        tar.stderr.on('data', (d) => (tarErr += d));
        const piped = tar.stdout.pipe(counter(tick));
        await this.run(`mkdir -p ${shq(dir)} && tar -xf - --no-same-owner -C ${shq(dir)}`, { stdin: piped, timeout: 120000 })
          .catch((e) => { throw new Error(`${name}: ${tarErr.trim() || e.message}`); });
      } else {
        // Write to a temporary name first so an aborted transfer leaves no half file behind.
        const tmp = `${dest}.termclaw-part`;
        await this.run(`cat > ${shq(tmp)} && mv -f ${shq(tmp)} ${shq(dest)} || { rm -f ${shq(tmp)}; exit 1; }`, { stdin: fs.createReadStream(lp).pipe(counter(tick)), timeout: 120000 })
          .catch((e) => { throw new Error(`${name}: ${e.message}`); });
      }
    }
    return { count: localPaths.length, bytes: total, dir };
  }

  // Download remote entries [{path, type, size}] into a local folder.
  async download(items, localDir, { onProgress } = {}) {
    const total = items.reduce((s, i) => s + (i.type === 'file' ? i.size || 0 : 0), 0);
    let done = 0;
    const tick = (n) => { done += n; onProgress && onProgress(done, Math.max(total, done)); };
    const saved = [];
    for (const it of items) {
      const name = it.path.split('/').pop();
      if (!validName(name)) throw new Error('Invalid file name ' + name);
      if (it.type === 'dir') {
        const tar = spawn(LOCAL_TAR, ['-xf', '-', '-C', localDir], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        let tarErr = '';
        tar.stderr.on('data', (d) => (tarErr += d));
        const closed = new Promise((res) => tar.on('close', res));
        const c = counter(tick);
        c.pipe(tar.stdin);
        await this.run(`cd ${shq(it.path.replace(/\/[^/]*$/, '') || '/')} && tar -cf - ${shq(name)}`, { stdout: c, timeout: 120000 });
        c.end();
        const code = await closed;
        if (code !== 0) throw new Error(`${name}: ${tarErr.trim() || 'tar failed'}`);
      } else {
        const target = path.join(localDir, name);
        const tmp = target + '.termclaw-part';
        const file = fs.createWriteStream(tmp);
        const c = counter(tick);
        c.pipe(file);
        try {
          await this.run(`cat ${shq(it.path)}`, { stdout: c, timeout: 120000 });
          c.end();
          await new Promise((res, rej) => { file.on('finish', res); file.on('error', rej); });
          fs.renameSync(tmp, target);
        } catch (e) {
          c.destroy(); file.destroy();
          try { fs.unlinkSync(tmp); } catch {}
          throw new Error(`${name}: ${e.message}`);
        }
      }
      saved.push(path.join(localDir, name));
    }
    return { saved, bytes: done };
  }
}

// Same interface for a project on this computer.
class LocalFiles {
  constructor(project, host) {
    this.project = project;
    this.host = host;
    this.label = 'this computer';
  }

  _resolve(p) { return path.resolve(String(p || '').replace(/^~(?=$|[\\/])/, os.homedir())); }

  async home() { return this._resolve(projectDir(this.project, this.host) || os.homedir()); }

  async list(dir) {
    const d = dir ? this._resolve(dir) : await this.home();
    const entries = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      try {
        const st = fs.statSync(path.join(d, e.name));
        entries.push({ name: e.name, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
      } catch {}
    }
    return { path: d, entries: sortEntries(entries) };
  }

  async sessionCwd() { return this.home(); }

  async exists(dir, names) { return names.filter((n) => validName(n) && fs.existsSync(path.join(dir, n))); }

  async mkdir(dir, name) {
    if (!validName(name) || /[\\]/.test(name)) throw new Error('Invalid folder name');
    fs.mkdirSync(path.join(dir, name));
  }

  async upload(localPaths, dir) {
    for (const lp of localPaths) fs.cpSync(lp, path.join(dir, path.basename(lp)), { recursive: true });
    return { count: localPaths.length, dir };
  }

  async download(items, localDir) {
    const saved = [];
    for (const it of items) {
      const to = path.join(localDir, path.basename(it.path));
      fs.cpSync(it.path, to, { recursive: true });
      saved.push(to);
    }
    return { saved };
  }
}

function filesFor(project, host) {
  return project.type === 'ssh' || project.type === 'wsl' ? new RemoteFiles(project, host) : new LocalFiles(project, host);
}

function cleanErr(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^\*\*|^Warning: Permanently added/.test(l)).slice(-3).join(' ').slice(0, 400);
}

module.exports = { filesFor, RemoteFiles, LocalFiles, parseList, LIST_SCRIPT, CWD_SCRIPT };
