'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findSkillDirs, validSource, sourceSlug } = require('../src/main/coding-agents/skills');

test('source validation: URLs, branch names, sub-folders', () => {
  for (const url of ['https://code.example.com/team/skills.git', 'git@gitlab.example.com:team/skills.git', 'ssh://git@host/team/skills.git', 'C:\\repos\\skills', '/srv/repos/skills']) {
    assert.strictEqual(validSource({ url }), null, url);
  }
  assert.ok(validSource({ url: 'skills' }));
  assert.ok(validSource({ url: 'https://x/y.git', ref: 'main; rm -rf ~' }));
  assert.ok(validSource({ url: 'https://x/y.git', path: '../etc' }));
  assert.strictEqual(validSource({ url: 'https://x/y.git', ref: 'release/1.2', path: 'skills/team' }), null);
  assert.strictEqual(sourceSlug({ name: 'Team Skills!' }), 'team-skills');
});

test('skill folders are found at any depth; a skill folder is not searched further', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termclaw-src-'));
  const mk = (rel) => { fs.mkdirSync(path.join(root, rel), { recursive: true }); fs.writeFileSync(path.join(root, rel, 'SKILL.md'), '---\nname: x\n---\n'); };
  mk('skills/a');
  mk('skills/group/b');
  mk('skills/a/nested-should-be-ignored');
  fs.mkdirSync(path.join(root, '.git', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'x', 'SKILL.md'), '');
  const found = findSkillDirs(root).map((d) => path.relative(root, d).replace(/\\/g, '/')).sort();
  assert.deepStrictEqual(found, ['skills/a', 'skills/group/b']);
  // A repository that is itself one skill
  const single = fs.mkdtempSync(path.join(os.tmpdir(), 'termclaw-src1-'));
  fs.writeFileSync(path.join(single, 'SKILL.md'), '---\nname: one\n---\n');
  assert.deepStrictEqual(findSkillDirs(single), [single]);
});
