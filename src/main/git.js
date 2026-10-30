'use strict';
// Git tab: finds the git repositories under a project's folders and runs git there, on the project machine
// (ssh, WSL, local). Everything is plain git on the command line: several commands go into one shell script
// (one ssh connection per refresh); on local Windows git.exe runs directly.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildRemoteExec, shq, posixDir, projectDir } = require('./connect');

const IS_WIN = process.platform === 'win32';
const MARK = '@@TCG';
const SCAN_TTL_MS = 30000;
const MAX_DIFF = 1024 * 1024; // larger diffs are cut
const LOG_LIMIT = 300;
const PRUNE = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'target', 'dist', 'build', 'vendor']);
// git never asks for passwords here (there is no terminal); ssh remotes fail instead of hanging.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

// The scripts are POSIX sh; the login shell on the machine may be another one (zsh, fish).
const posixSh = (script) => `exec sh -c ${shq(script)}`;
const localWindows = (project) => IS_WIN && (project.type === 'local' || !project.type);
const US = '\x1f';
const RS = '\x1e';

function checkProject(project) {
  if (project.type === 'psremote') throw new Error('The Git tab needs an SSH, WSL or local project.');
}

function badRef(name) {
  return !name || typeof name !== 'string' || name.startsWith('-') || /[\s~^:?*[\\\x00-\x1f]/.test(name) || name.includes('..');
}

// ---------- running ----------

// Spawns a script on the project machine and collects stdout / stderr.
function runSpec(spec, { timeout = 60000, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(spec.file, spec.args, { windowsHide: true, env: { ...process.env, ...(env || {}) } });
    const out = [];
    const err = [];
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} reject(new Error('git timed out')); } }, timeout);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
    p.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') });
    });
  });
}

// Shell script running several git commands in one repository; each one's stdout, exit code and stderr
// are separated by marker lines. stop = do not run the next command after a failing one.
function batchScript(repo, cmds, { stop = false } = {}) {
  const lines = [
    'export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0',
    '[ -n "$GIT_SSH_COMMAND" ] || export GIT_SSH_COMMAND="ssh -o BatchMode=yes"',
    'e=$(mktemp 2>/dev/null || echo /tmp/tc-git-$$)',
    `cd ${posixDir(repo)} 2>/dev/null || { echo "not a folder: ${repo.replace(/["$`\\]/g, '')}" >&2; exit 97; }`,
  ];
  cmds.forEach((args, i) => {
    lines.push(`git ${args.map(shq).join(' ')} 2>"$e"; c=$?; printf '\\n${MARK} %d %d\\n' ${i} $c; sed 's/^/${MARK}E /' "$e"`);
    if (stop) lines.push('[ $c -eq 0 ] || { rm -f "$e"; exit 0; }');
  });
  lines.push('rm -f "$e"');
  return lines.join('\n');
}

// Splits the output of batchScript into [{code, out, err}] (missing entries = not run).
function parseBatch(text, n) {
  const res = [];
  const re = new RegExp(`\\n${MARK} (\\d+) (\\d+)\\n`, 'g');
  let last = 0;
  let m;
  const takeErr = (seg) => {
    const errs = [];
    while (seg.startsWith(MARK + 'E ')) {
      const nl = seg.indexOf('\n');
      errs.push(seg.slice(MARK.length + 2, nl < 0 ? undefined : nl));
      seg = nl < 0 ? '' : seg.slice(nl + 1);
    }
    return { errs: errs.join('\n'), rest: seg };
  };
  let prevIndex = -1;
  while ((m = re.exec(text))) {
    let seg = text.slice(last, m.index);
    if (prevIndex >= 0) {
      const t = takeErr(seg);
      res[prevIndex].err = t.errs;
      seg = t.rest;
    }
    const i = Number(m[1]);
    res[i] = { code: Number(m[2]), out: seg, err: '' };
    prevIndex = i;
    last = m.index + m[0].length;
  }
  if (prevIndex >= 0) res[prevIndex].err = takeErr(text.slice(last)).errs;
  for (let i = 0; i < n; i++) if (!res[i]) res[i] = null;
  return res;
}

function execGit(cwd, args, timeout) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...GIT_ENV } }, (err, out, stderr) => {
      if (err && err.code === 'ENOENT') return resolve({ code: 127, out: '', err: 'git not found on this computer (install Git for Windows)' });
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out), err: String(stderr) });
    });
  });
}

// Runs git commands in a repository: [{code, out, err} | null].
async function runGit(project, host, repo, cmds, { timeout = 60000, stop = false } = {}) {
  checkProject(project);
  if (localWindows(project)) {
    const res = [];
    for (const args of cmds) {
      const r = await execGit(repo, args, timeout);
      res.push(r);
      if (stop && r.code !== 0) break;
    }
    while (res.length < cmds.length) res.push(null);
    return res;
  }
  const spec = buildRemoteExec(project, host, posixSh(batchScript(repo, cmds, { stop })));
  const r = await runSpec(spec, { timeout });
  if (r.code === 97) throw new Error(`Repository folder not found: ${repo}`);
  const res = parseBatch(r.out, cmds.length);
  if (res.every((x) => !x)) throw new Error((r.err || r.out).trim().split('\n').slice(-3).join('\n') || `git could not run (exit ${r.code})`);
  return res;
}

// ---------- parsing ----------

function parseBranchHeader(lines) {
  const b = { oid: '', head: '', upstream: '', ahead: 0, behind: 0 };
  for (const l of lines) {
    if (l.startsWith('# branch.oid ')) b.oid = l.slice(13);
    else if (l.startsWith('# branch.head ')) b.head = l.slice(14);
    else if (l.startsWith('# branch.upstream ')) b.upstream = l.slice(18);
    else if (l.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(l);
      if (m) { b.ahead = Number(m[1]); b.behind = Number(m[2]); }
    }
  }
  if (b.head === '(detached)') b.detached = true;
  if (b.oid === '(initial)') b.initial = true;
  return b;
}

// git status --porcelain=v2 --branch -z
function parseStatus(text) {
  const parts = text.split('\0');
  const headers = [];
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    if (e.startsWith('# ')) { headers.push(e); continue; }
    const t = e[0];
    if (t === '?') { files.push({ path: e.slice(2), x: '?', y: '?', status: 'new', staged: false }); continue; }
    if (t === '!') continue;
    const xy = e.slice(2, 4);
    const x = xy[0];
    const y = xy[1];
    let p;
    let orig;
    if (t === '1') p = e.split(' ').slice(8).join(' ');
    else if (t === '2') { p = e.split(' ').slice(9).join(' '); orig = parts[++i]; }
    else if (t === 'u') p = e.split(' ').slice(10).join(' ');
    else continue;
    const letter = t === 'u' ? 'U' : t === '2' ? x : y !== '.' ? y : x;
    const status = t === 'u' ? 'conflict' : { M: 'modified', T: 'modified', A: 'new', D: 'deleted', R: 'renamed', C: 'copied' }[letter] || 'modified';
    files.push({ path: p, orig, x, y, status, staged: x !== '.' && t !== 'u' });
  }
  return { branch: parseBranchHeader(headers), files };
}

// Summary lines of the repository scan: "# branch.*" headers and "changes N".
function parseSummary(lines) {
  const b = parseBranchHeader(lines);
  const c = lines.find((l) => l.startsWith('changes '));
  return { ...b, changes: c ? Number(c.slice(8)) : 0 };
}

const BRANCH_FMT = ['%(refname)', '%(objectname:short)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:unix)', '%(HEAD)', '%(contents:subject)'].join('%1f');

function parseBranches(text) {
  const local = [];
  const remote = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [ref, sha, upstream, track, date, head, subject] = line.split(US);
    const t = track || '';
    const ahead = Number((/ahead (\d+)/.exec(t) || [])[1] || 0);
    const behind = Number((/behind (\d+)/.exec(t) || [])[1] || 0);
    const item = { sha, upstream: upstream || '', ahead, behind, gone: /gone/.test(t), date: Number(date) * 1000 || 0, current: head === '*', subject: subject || '' };
    if (ref.startsWith('refs/heads/')) local.push({ ...item, name: ref.slice(11) });
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) remote.push({ ...item, name: ref.slice(13) });
  }
  return { local, remote };
}

const LOG_FMT = ['%H', '%h', '%an', '%ae', '%at', '%P', '%D', '%s'].join('%x1f') + '%x1e';

function parseLog(text) {
  return text.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, short, author, email, at, parents, refs, subject] = r.split(US);
    return { hash, short, author, email, date: Number(at) * 1000 || 0, parents: parents ? parents.split(' ') : [], refs: refs ? refs.split(', ').filter(Boolean) : [], subject: subject || '' };
  });
}

// git log --name-status -z: "M\0path\0", "R100\0old\0new\0"
function parseNameStatus(text) {
  const parts = text.split('\0').map((s) => s.replace(/^\n+/, ''));
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const c = code[0];
    if (c === 'R' || c === 'C') { files.push({ status: c === 'R' ? 'renamed' : 'copied', orig: parts[i + 1], path: parts[i + 2] }); i += 2; continue; }
    files.push({ status: { A: 'new', D: 'deleted', M: 'modified', T: 'modified' }[c] || 'modified', path: parts[i + 1] });
    i += 1;
  }
  return files;
}

function cutDiff(text) {
  if (text.length <= MAX_DIFF) return { diff: text, truncated: false };
  return { diff: text.slice(0, MAX_DIFF).replace(/\n[^\n]*$/, '\n'), truncated: true };
}

const errText = (r, what) => {
  const t = r ? (r.err || r.out || '').trim() : '';
  return t ? t.split('\n').filter((l) => !/^hint:/.test(l)).slice(-6).join('\n') : `${what} failed${r ? ` (exit ${r.code})` : ''}`;
};

// ---------- repository search ----------

function searchRoots(project, host) {
  const list = String((project.git && project.git.paths) || '').split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean);
  if (list.length) return list;
  const d = projectDir(project, host);
  if (d) return [d];
  return [localWindows(project) ? os.homedir() : '~'];
}

function scanScript(roots, depth) {
  const max = Math.max(1, Math.min(8, Number(depth) || 3)) + 1;
  const prune = [...PRUNE].map((n) => `-name ${shq(n)}`).join(' -o ');
  return [
    'export LC_ALL=C GIT_OPTIONAL_LOCKS=0',
    `for d in ${roots.map(posixDir).join(' ')}; do`,
    '  [ -d "$d" ] || continue',
    `  find "$d" -maxdepth ${max} \\( -name .git -print -prune \\) -o \\( \\( -name '.*' ! -path "$d" \\) -o ${prune} \\) -prune 2>/dev/null`,
    "done | sed 's#/\\.git$##' | sort -u | while IFS= read -r r; do",
    `  printf '${MARK}R %s\\n' "$r"`,
    "  git -C \"$r\" status --porcelain=v2 --branch 2>/dev/null | awk '/^#/ {print; next} {n++} END {print \"changes \" n+0}'",
    'done',
  ].join('\n');
}

function parseScan(text) {
  const repos = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith(MARK + 'R ')) { cur = { path: line.slice(MARK.length + 2), lines: [] }; repos.push(cur); continue; }
    if (cur && line) cur.lines.push(line);
  }
  return repos.map((r) => ({ path: r.path, name: r.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop(), ...parseSummary(r.lines) }));
}

// Local search with Node (Windows): same rules as the find command.
function walkLocal(root, depth) {
  const found = [];
  const max = Math.max(1, Math.min(8, Number(depth) || 3));
  const visit = (dir, level) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.name === '.git')) { found.push(dir); return; }
    if (level >= max) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || PRUNE.has(e.name)) continue;
      visit(path.join(dir, e.name), level + 1);
    }
  };
  visit(root.replace(/^~(?=$|[\\/])/, os.homedir()), 0);
  return found;
}

async function scanRepos(project, host) {
  checkProject(project);
  const roots = searchRoots(project, host);
  const depth = (project.git && project.git.depth) || 3;
  if (localWindows(project)) {
    const paths = [...new Set(roots.flatMap((r) => walkLocal(r, depth)))].sort();
    const out = [];
    for (const p of paths) {
      const r = await execGit(p, ['status', '--porcelain=v2', '--branch'], 20000);
      if (r.code === 127) throw new Error(r.err);
      const lines = r.out.split('\n').filter(Boolean);
      const summary = parseSummary([...lines.filter((l) => l.startsWith('#')), `changes ${lines.filter((l) => !l.startsWith('#')).length}`]);
      out.push({ path: p, name: path.basename(p), ...summary, error: r.code ? errText(r, 'git status') : undefined });
    }
    return { roots, repos: out };
  }
  const r = await runSpec(buildRemoteExec(project, host, posixSh(scanScript(roots, depth))), { timeout: 60000 });
  if (r.code !== 0 && !r.out.includes(MARK)) throw new Error((r.err || '').trim().split('\n').slice(-3).join('\n') || `Repository search failed (exit ${r.code})`);
  return { roots, repos: parseScan(r.out) };
}

// ---------- per project ----------

class GitManager {
  constructor(store) {
    this.store = store;
    this.scans = new Map(); // projectId -> { at, result, pending }
    this.busy = new Map(); // repo key -> action name
  }

  _ctx(projectId) {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error('Unknown project');
    if (!project.git || !project.git.enabled) throw new Error('Git is not enabled for this project');
    const host = project.hostId ? this.store.getHost(project.hostId) : null;
    return { project, host };
  }

  _repo(repo) {
    if (!repo || typeof repo !== 'string' || repo.startsWith('-')) throw new Error('Invalid repository path');
    return repo;
  }

  async repos(projectId, { force = false } = {}) {
    const { project, host } = this._ctx(projectId);
    const c = this.scans.get(projectId);
    if (!force && c && c.result && Date.now() - c.at < SCAN_TTL_MS) return c.result;
    if (c && c.pending) return c.pending;
    const pending = scanRepos(project, host).then((result) => {
      this.scans.set(projectId, { at: Date.now(), result });
      return result;
    }).finally(() => { const x = this.scans.get(projectId); if (x && x.pending === pending) delete x.pending; });
    this.scans.set(projectId, { ...(c || {}), pending });
    return pending;
  }

  // Status, branches, history and remote of one repository.
  async state(projectId, repo) {
    const { project, host } = this._ctx(projectId);
    const [st, br, log, unpushed, remotes, stash] = await runGit(project, host, this._repo(repo), [
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
      ['for-each-ref', `--format=${BRANCH_FMT}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'],
      ['log', `-n${LOG_LIMIT}`, `--format=${LOG_FMT}`, 'HEAD', '--'],
      ['rev-list', '@{upstream}..HEAD', '--'],
      ['remote', '-v'],
      ['stash', 'list', '--format=%gd'],
    ], { timeout: 30000 });
    if (!st || st.code !== 0) throw new Error(errText(st, 'git status'));
    const status = parseStatus(st.out);
    const remoteList = [];
    for (const l of (remotes && remotes.code === 0 ? remotes.out : '').split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+\(fetch\)/.exec(l);
      if (m) remoteList.push({ name: m[1], url: m[2] });
    }
    const unpushedSet = unpushed && unpushed.code === 0 ? unpushed.out.split('\n').filter(Boolean) : null;
    return {
      repo,
      branch: status.branch,
      files: status.files,
      branches: br && br.code === 0 ? parseBranches(br.out) : { local: [], remote: [] },
      log: log && log.code === 0 ? parseLog(log.out) : [],
      unpushed: unpushedSet,
      remotes: remoteList,
      stashes: stash && stash.code === 0 ? stash.out.split('\n').filter(Boolean).length : 0,
      at: Date.now(),
    };
  }

  // Diff of a changed file against HEAD (staged and unstaged together, like GitHub Desktop).
  async diff(projectId, repo, file) {
    const { project, host } = this._ctx(projectId);
    const f = file || {};
    if (!f.path) throw new Error('No file');
    const base = ['--no-pager', 'diff', '--no-color', '--no-ext-diff', '-M'];
    let cmd;
    if (f.status === 'new' && f.x === '?') cmd = ['--no-pager', 'diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', f.path];
    else if (f.initial) cmd = [...base, '--cached', '--', f.path];
    else cmd = [...base, 'HEAD', '--', ...(f.orig ? [f.orig] : []), f.path];
    if (f.status === 'new' && f.x === '?' && localWindows(project)) cmd[cmd.indexOf('/dev/null')] = 'NUL';
    const [r] = await runGit(project, host, this._repo(repo), [cmd], { timeout: 30000 });
    // diff --no-index exits 1 when there are differences
    if (!r || r.code > 1) throw new Error(errText(r, 'git diff'));
    return cutDiff(r.out);
  }

  async commitInfo(projectId, repo, hash) {
    const { project, host } = this._ctx(projectId);
    if (!/^[0-9a-f]{4,64}$/i.test(hash || '')) throw new Error('Invalid commit');
    const [info, names] = await runGit(project, host, this._repo(repo), [
      ['show', '-s', `--format=%H%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%B`, hash, '--'],
      ['log', '-1', '-m', '--first-parent', '--format=', '--name-status', '-z', '-M', hash, '--'],
    ], { timeout: 30000 });
    if (!info || info.code !== 0) throw new Error(errText(info, 'git show'));
    const [h, author, email, at, parents, refs, ...body] = info.out.split(US);
    const message = body.join(US).replace(/\s+$/, '');
    const nl = message.indexOf('\n');
    return {
      hash: h, author, email, date: Number(at) * 1000 || 0, parents: parents ? parents.split(' ') : [], refs: refs ? refs.split(', ').filter(Boolean) : [],
      subject: nl < 0 ? message : message.slice(0, nl), body: nl < 0 ? '' : message.slice(nl + 1).trim(),
      files: names && names.code === 0 ? parseNameStatus(names.out) : [],
    };
  }

  async commitDiff(projectId, repo, hash, file) {
    const { project, host } = this._ctx(projectId);
    if (!/^[0-9a-f]{4,64}$/i.test(hash || '')) throw new Error('Invalid commit');
    const f = file || {};
    const [r] = await runGit(project, host, this._repo(repo), [
      ['--no-pager', 'log', '-1', '-m', '--first-parent', '--format=', '-p', '-M', '--no-color', '--no-ext-diff', hash, '--', ...(f.orig ? [f.orig] : []), f.path],
    ], { timeout: 30000 });
    if (!r || r.code !== 0) throw new Error(errText(r, 'git log'));
    return cutDiff(r.out);
  }

  // ---------- actions ----------

  async _action(projectId, repo, name, cmds, opts = {}) {
    const { project, host } = this._ctx(projectId);
    const key = projectId + '\n' + repo;
    if (this.busy.has(key)) throw new Error(`Please wait: ${this.busy.get(key)} is still running`);
    this.busy.set(key, name);
    try {
      const res = await runGit(project, host, this._repo(repo), cmds, { stop: true, timeout: opts.timeout || 120000 });
      const failed = res.findIndex((r) => !r || r.code !== 0);
      if (failed >= 0 && !(opts.okCodes && res[failed] && opts.okCodes.includes(res[failed].code))) throw new Error(errText(res[failed], name));
      this.scans.delete(projectId);
      return { ok: true, output: res.filter(Boolean).map((r) => (r.err + r.out).trim()).filter(Boolean).join('\n') };
    } finally {
      this.busy.delete(key);
    }
  }

  // files: [{path, orig}]; all = every changed file is selected (commit without pathspec).
  async commit(projectId, repo, { files = [], all = false, summary, description = '', amend = false }) {
    const msg = String(summary || '').trim() + (String(description || '').trim() ? '\n\n' + String(description).trim() : '');
    if (!String(summary || '').trim()) throw new Error('A commit summary is needed');
    const paths = [...new Set(files.flatMap((f) => [f.orig, f.path]).filter(Boolean))];
    if (!all && !paths.length && !amend) throw new Error('No files selected');
    const cmds = all || !paths.length
      ? [['add', '-A'], ['commit', '-q', ...(amend ? ['--amend'] : []), '-m', msg]]
      // the old name of a staged rename is gone from the index: only the new names are added, both are committed
      : [['add', '-A', '--', ...[...new Set(files.map((f) => f.path))]], ['commit', '-q', ...(amend ? ['--amend'] : []), '-m', msg, '--', ...paths]];
    return this._action(projectId, repo, 'Commit', cmds, { timeout: 120000 });
  }

  async push(projectId, repo) {
    const st = await this.state(projectId, repo);
    const b = st.branch;
    if (b.detached) throw new Error('Not on a branch (detached HEAD)');
    let cmd = ['push'];
    if (!b.upstream) {
      const remote = (st.remotes.find((r) => r.name === 'origin') || st.remotes[0] || {}).name;
      if (!remote) throw new Error('This repository has no remote to push to');
      cmd = ['push', '-u', remote, 'HEAD'];
    }
    return this._action(projectId, repo, 'Push', [cmd], { timeout: 300000 });
  }

  async pull(projectId, repo) { return this._action(projectId, repo, 'Pull', [['pull', '--ff-only']], { timeout: 300000 }); }
  async fetch(projectId, repo) { return this._action(projectId, repo, 'Fetch', [['fetch', '--all', '--prune']], { timeout: 300000 }); }

  // Throws away local changes of the given files (untracked and newly added files are deleted).
  async discard(projectId, repo, files) {
    const list = (files || []).filter((f) => f && f.path && f.status !== 'conflict');
    if (!list.length) throw new Error('Nothing to discard');
    const untracked = list.filter((f) => f.x === '?').map((f) => f.path);
    const added = list.filter((f) => f.x === 'A' || f.status === 'renamed' || f.status === 'copied').map((f) => f.path);
    const restore = [...new Set(list.filter((f) => f.x !== '?' && f.x !== 'A').flatMap((f) => (f.status === 'renamed' ? [f.orig] : f.status === 'copied' ? [] : [f.path])).filter(Boolean))];
    const cmds = [];
    if (added.length) cmds.push(['rm', '-q', '-f', '-r', '--', ...added]);
    if (restore.length) cmds.push(['checkout', '-q', 'HEAD', '--', ...restore]);
    if (untracked.length) cmds.push(['clean', '-f', '-q', '--', ...untracked]);
    return this._action(projectId, repo, 'Discard', cmds);
  }

  // Switches to a local branch, or creates a tracking branch for a remote one.
  async checkout(projectId, repo, { name, remote = false }) {
    if (badRef(name)) throw new Error('Invalid branch name');
    if (!remote) return this._action(projectId, repo, 'Checkout', [['checkout', '-q', name, '--']]);
    const local = name.split('/').slice(1).join('/');
    const st = await this.state(projectId, repo);
    if (st.branches.local.some((b) => b.name === local)) return this._action(projectId, repo, 'Checkout', [['checkout', '-q', local, '--']]);
    return this._action(projectId, repo, 'Checkout', [['checkout', '-q', '-b', local, '--track', name]]);
  }

  async createBranch(projectId, repo, name) {
    if (badRef(name)) throw new Error('Invalid branch name');
    return this._action(projectId, repo, 'New branch', [['checkout', '-q', '-b', name]]);
  }

  async deleteBranch(projectId, repo, name, { force = false } = {}) {
    if (badRef(name)) throw new Error('Invalid branch name');
    return this._action(projectId, repo, 'Delete branch', [['branch', force ? '-D' : '-d', name]]);
  }

  // Last commit back into the changes (only offered for commits that are not pushed).
  async undoCommit(projectId, repo) {
    const st = await this.state(projectId, repo);
    const head = st.log[0];
    if (!head) throw new Error('There is no commit to undo');
    if (st.unpushed && !st.unpushed.includes(head.hash)) throw new Error('The last commit is already pushed; use Revert instead');
    if (head.parents.length !== 1) throw new Error(head.parents.length ? 'A merge commit cannot be undone here' : 'The first commit of a repository cannot be undone here');
    return this._action(projectId, repo, 'Undo commit', [['reset', '--soft', '-q', 'HEAD~1']]);
  }

  async revertCommit(projectId, repo, hash) {
    if (!/^[0-9a-f]{4,64}$/i.test(hash || '')) throw new Error('Invalid commit');
    return this._action(projectId, repo, 'Revert', [['revert', '--no-edit', hash]]);
  }

  reset(projectId) { this.scans.delete(projectId); }
}

module.exports = { GitManager, parseStatus, parseBranches, parseLog, parseNameStatus, parseBatch, batchScript, parseScan, scanScript, parseSummary, walkLocal, badRef };
