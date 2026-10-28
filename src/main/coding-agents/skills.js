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
  constructor(dir) {
    this.dir = dir;
  }

  ensure() { fs.mkdirSync(this.dir, { recursive: true }); }

  // Skills found in the repository: [{name, description, files, path, error?}]
  list() {
    this.ensure();
    const out = [];
    for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(this.dir, e.name);
      const skillMd = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const fm = frontmatter(fs.readFileSync(skillMd, 'utf8'));
      const name = e.name;
      const item = { name, title: fm.name || name, description: fm.description || '', path: dir };
      try {
        item.files = listFiles(dir);
        if (!NAME_RE.test(name)) item.error = 'folder name must be letters, digits, dot, dash or underscore';
      } catch (err) { item.error = err.message; item.files = []; }
      out.push(item);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Files of a skill as [{rel, content}] for deployment.
  load(name) {
    if (!NAME_RE.test(name)) throw new Error('invalid skill name ' + name);
    const dir = path.join(this.dir, name);
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

module.exports = { SkillsRepo, frontmatter, NAME_RE };
