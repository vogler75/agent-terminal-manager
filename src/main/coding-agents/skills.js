'use strict';
// Skills repository: a local folder with one sub-folder per skill (<name>/SKILL.md + optional files).
// It can be a plain folder or a git clone; the app scans it and deploys selected skills to agents.
const fs = require('fs');
const path = require('path');

const MAX_FILES = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function listFiles(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) out.push(r);
      if (out.length > MAX_FILES) throw new Error(`too many files in skill folder ${dir}`);
    }
  };
  walk(dir, '');
  return out;
}

class SkillsRepo {
  // sources: Git sources [{id, name, url, ref, path}] downloaded into <dir>/.sources/<name>
  constructor(dir, sources = []) {
    this.dir = dir;
    this.sources = sources;
  }

  // Downloads a Git source (clone) or brings it to the latest state of its branch/tag (fetch + reset).
  // git runs without a shell and without terminal prompts; credentials come from the user's git setup.
  async syncSource(source) {
    const dir = this.sourceDir(source);
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    const log = [];
    const git = (args, cwd) => runGit(args, { cwd, env }).then((r) => { log.push(`$ git ${args.join(' ')}`, r.out.trim()); return r; });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      const args = ['clone', '--depth', '1', ...(source.ref ? ['--branch', source.ref] : []), '--', source.url, dir];
      const r = await git(args, this.dir);
      if (r.code !== 0) throw new Error(gitError(r.out, source.url));
    } else {
      const r = await git(['fetch', '--depth', '1', 'origin', source.ref || 'HEAD'], dir);
      if (r.code !== 0) throw new Error(gitError(r.out, source.url));
      const r2 = await git(['reset', '--hard', 'FETCH_HEAD'], dir);
      if (r2.code !== 0) throw new Error(r2.out.trim());
    }
    const head = await runGit(['log', '-1', '--format=%h %cs %s'], { cwd: dir, env });
    const skills = this.list().filter((s) => s.source === source.name);
    return { commit: head.out.trim(), skills: skills.map((s) => s.name), conflicts: skills.filter((s) => s.error).map((s) => s.name), log: log.join('\n').trim() };
  }

  removeSource(source) {
    fs.rmSync(this.sourceDir(source), { recursive: true, force: true });
  }

  ensure() { fs.mkdirSync(this.dir, { recursive: true }); }

  // Local folder of a Git source (inside the repository, hidden from the plain skill scan).
  sourceDir(source) { return path.join(this.dir, '.sources', sourceSlug(source)); }

  _item(dir, name, source) {
    const fm = frontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
    const item = { name, title: fm.name || name, description: fm.description || '', path: dir, source: source ? source.name : null };
    try {
      item.files = listFiles(dir);
      if (!NAME_RE.test(name)) item.error = 'folder name must be letters, digits, dot, dash or underscore';
    } catch (err) { item.error = err.message; item.files = []; }
    return item;
  }

  // Skills found in the repository and in the downloaded Git sources:
  // [{name, description, files, path, source, error?}]. A name already taken is marked as a conflict.
  list() {
    this.ensure();
    const out = [];
    for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(this.dir, e.name);
      if (fs.existsSync(path.join(dir, 'SKILL.md'))) out.push(this._item(dir, e.name, null));
    }
    const taken = new Map(out.map((s) => [s.name, 'your skills']));
    for (const src of this.sources) {
      const root = path.join(this.sourceDir(src), src.path || '');
      if (!fs.existsSync(root)) continue;
      for (const dir of findSkillDirs(root)) {
        const item = this._item(dir, path.basename(dir), src);
        if (taken.has(item.name)) item.error = `name already used by ${taken.get(item.name)}; not deployed`;
        else taken.set(item.name, `source ${src.name}`);
        out.push(item);
      }
    }
    return out.sort((a, b) => (a.source || '').localeCompare(b.source || '') || a.name.localeCompare(b.name));
  }

  // Files of a skill as [{rel, content}] for deployment.
  load(name) {
    if (!NAME_RE.test(name)) throw new Error('invalid skill name ' + name);
    const found = this.list().find((s) => s.name === name && !s.error);
    const dir = found ? found.path : path.join(this.dir, name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`skill ${name} not found in ${this.dir}`);
    let total = 0;
    return listFiles(dir).map((rel) => {
      const buf = fs.readFileSync(path.join(dir, rel));
      total += buf.length;
      if (total > MAX_BYTES) throw new Error(`skill ${name} is larger than 2 MB`);
      return { rel, content: buf.toString('base64'), binary: true };
    });
  }

  create(name, description) {
    if (!NAME_RE.test(name)) throw new Error('Skill name: letters, digits, dot, dash or underscore');
    const dir = path.join(this.dir, name);
    if (fs.existsSync(dir)) throw new Error('A skill with this name already exists');
    fs.mkdirSync(dir, { recursive: true });
    const md = `---\nname: ${name}\ndescription: ${description || 'Describe when the agent should use this skill.'}\n---\n\n# ${name}\n\nInstructions for the agent.\n`;
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
    return path.join(dir, 'SKILL.md');
  }

  // Copy skill folders from another folder (a single skill or a folder of skills) into the repository.
  importFrom(src) {
    const imported = [];
    const copy = (from, name) => {
      const to = path.join(this.dir, name);
      fs.cpSync(from, to, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(s) });
      imported.push(name);
    };
    if (fs.existsSync(path.join(src, 'SKILL.md'))) copy(src, path.basename(src));
    else {
      for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        if (e.isDirectory() && fs.existsSync(path.join(src, e.name, 'SKILL.md'))) copy(path.join(src, e.name), e.name);
      }
    }
    if (!imported.length) throw new Error('No SKILL.md found in the selected folder');
    return imported;
  }
}

// ---------- Git sources ----------

const sourceSlug = (s) => String(s.name || s.id || 'source').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'source';

// Accepted source URLs: https, ssh (git@host:path or ssh://), or a local folder / file:// URL.
const SOURCE_URL_RE = /^(?:https:\/\/[\w.@:/~%-]+|ssh:\/\/[\w.@:/~%-]+|git@[\w.-]+:[\w./~-]+|file:\/\/\S+|[A-Za-z]:[\\/][^\0]*|\/[^\0]*)$/;
const REF_NAME_RE = /^[\w./-]{1,200}$/;

function validSource(src) {
  if (!src || !SOURCE_URL_RE.test(String(src.url || '').trim())) return 'Use an https or ssh Git URL (or a local repository folder)';
  if (src.ref && !REF_NAME_RE.test(src.ref)) return 'Branch / tag: letters, digits, dot, dash, underscore and slash only';
  if (src.path && (/(^|[\\/])\.\.([\\/]|$)/.test(src.path) || /^[\\/]/.test(src.path))) return 'Sub-folder must be relative and must not contain ..';
  return null;
}

// All folders below root that contain a SKILL.md (a skill folder is not searched further).
function findSkillDirs(root, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  if (depth > 0 && entries.some((e) => e.isFile() && e.name === 'SKILL.md')) { out.push(root); return out; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue;
    findSkillDirs(path.join(root, e.name), depth + 1, out);
  }
  // A repository that is itself one skill (SKILL.md at its root)
  if (depth === 0 && entries.some((e) => e.isFile() && e.name === 'SKILL.md')) out.push(root);
  return out;
}

function runGit(args, { cwd, env }) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn('git', args, { cwd, env, windowsHide: true }); } catch (e) { return resolve({ code: -1, out: e.message }); }
    const t = setTimeout(() => { try { p.kill(); } catch {} out += '\n[timeout after 5 minutes]'; }, 300000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: /ENOENT/.test(e.message) ? 'git is not installed or not on the PATH' : e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}

function gitError(out, url) {
  const text = String(out || '').trim();
  if (/Authentication failed|could not read Username|terminal prompts disabled|Permission denied|403|401/i.test(text)) {
    return `git has no access to ${url}. Log in once in a terminal (e.g. git clone ${url}) or use an SSH URL with a registered key.\n${text.slice(-400)}`;
  }
  return text.slice(-600) || 'git failed';
}

module.exports = { SkillsRepo, frontmatter, NAME_RE, validSource, findSkillDirs, sourceSlug };
