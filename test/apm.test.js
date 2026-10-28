'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validRef, apmTargets, planApm, apmDeployCommands, apmActionCommand, cleanOutput } = require('../src/main/coding-agents/apm');

test('APM references: accepted forms and rejected shell injection', () => {
  for (const ok of ['microsoft/apm-sample-package', 'microsoft/apm-sample-package#v1.0.0', 'github/awesome-copilot/skills/review-and-refactor',
    'anthropics/skills/skills/frontend-design#a1b2c3d', 'azure-cloud-development@awesome-copilot', 'https://gitlab.com/team/pkg.git#main', 'git@github.com:team/pkg.git']) {
    assert.ok(validRef(ok), ok);
  }
  for (const bad of ['', 'just-a-name', 'owner/repo; rm -rf ~', 'owner/repo && x', 'owner/repo $(id)', "owner/'repo'", 'owner/repo|x', 'owner /repo']) {
    assert.ok(!validRef(bad), bad);
  }
});

test('APM reference descriptions for the live hint', () => {
  const { describeRef } = require('../src/main/coding-agents/apm');
  assert.match(describeRef('microsoft/apm-sample-package#v1.0.0').message, /^GitHub microsoft\/apm-sample-package · pinned to v1\.0\.0$/);
  assert.match(describeRef('anthropics/skills/skills/frontend-design').message, /sub-folder skills\/frontend-design/);
  assert.match(describeRef('https://code.example.com/team/skills.git').message, /^Git repository over HTTPS \(code\.example\.com\)/);
  assert.match(describeRef('git@gitlab.example.com:team/skills.git#main').message, /^Git repository over SSH \(gitlab\.example\.com\) · pinned to main$/);
  assert.match(describeRef('azure-cloud-development@awesome-copilot').message, /marketplace "awesome-copilot"/);
  assert.deepStrictEqual(describeRef('owner/repo; rm -rf ~').valid, false);
  assert.deepStrictEqual(describeRef(''), { valid: false, message: '' });
});

test('APM references become Git sources the app can download itself', () => {
  const { refToSource } = require('../src/main/coding-agents/apm');
  assert.deepStrictEqual(refToSource('microsoft/apm-sample-package#v1.0.0'), { url: 'https://github.com/microsoft/apm-sample-package.git', path: '', ref: 'v1.0.0', name: 'apm-sample-package' });
  assert.deepStrictEqual(refToSource('anthropics/skills/skills/frontend-design'), { url: 'https://github.com/anthropics/skills.git', path: 'skills/frontend-design', ref: '', name: 'frontend-design' });
  assert.deepStrictEqual(refToSource('git@gitlab.example.com:team/skills.git#main'), { url: 'git@gitlab.example.com:team/skills.git', path: '', ref: 'main', name: 'skills' });
  assert.throws(() => refToSource('azure-cloud-development@awesome-copilot'), /only be installed with APM/);
});

test('a SKILL.md without frontmatter uses its first paragraph as description', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { SkillsRepo } = require('../src/main/coding-agents/skills');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-fp-'));
  fs.mkdirSync(path.join(d, 'x'));
  fs.writeFileSync(path.join(d, 'x', 'SKILL.md'), '# Style Checker\n\nCheck code against the style guide.\n\n## When\n- a\n');
  assert.strictEqual(new SkillsRepo(d).list()[0].description, 'Check code against the style guide.');
});

test('APM targets map our agents to APM target names', () => {
  assert.deepStrictEqual(apmTargets(['claude', 'copilot', 'agy', 'pi', 'qwen', 'claude']), ['claude', 'copilot', 'antigravity']);
});

test('APM deploy plan: uninstall deselected, install all selected, sync when nothing selected', () => {
  const plan = planApm(['a/b', 'c/d'], ['c/d', 'x/y']);
  assert.deepStrictEqual(plan, { add: ['a/b'], remove: ['x/y'], keep: ['c/d'] });
  assert.deepStrictEqual(apmDeployCommands({ add: ['a/b', 'c/d'], remove: ['x/y'] }, { targets: ['claude', 'copilot'], global: false }),
    ['apm uninstall x/y', 'apm install --target claude,copilot a/b c/d']);
  assert.deepStrictEqual(apmDeployCommands({ add: [], remove: ['x/y'] }, { targets: [], global: true }), ['apm uninstall -g x/y', 'apm install -g']);
  assert.strictEqual(apmActionCommand('update', { targets: ['claude'], global: false }), 'apm update --yes --target claude');
  assert.strictEqual(apmActionCommand('outdated', { targets: [], global: true }), 'apm outdated -g');
});

test('APM output is cleaned of color codes and empty lines', () => {
  assert.strictEqual(cleanOutput('\x1b[32m[*] Installed\x1b[0m\n\n  done  \n'), '[*] Installed\n  done  ');
});
