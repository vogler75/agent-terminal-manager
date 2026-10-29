'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseList, filesFor, LIST_SCRIPT, CWD_SCRIPT } = require('../src/main/files');
const { buildSpawn } = require('../src/main/connect');

test('directory listing output is parsed: folders first, names with spaces and tabs', () => {
  const out = '/home/bob/proj\n\0f\t12\t1700000000.5\tz file.txt\0d\t4096\t1700000001\tsrc\0f\t3\t1700000002\ta\tb\0d\t0\t0\t.\0';
  const r = parseList(out);
  assert.strictEqual(r.path, '/home/bob/proj');
  assert.deepStrictEqual(r.entries.map((e) => [e.type, e.name]), [['dir', 'src'], ['file', 'a\tb'], ['file', 'z file.txt']]);
  assert.strictEqual(r.entries[2].mtime, 1700000000500);
  assert.strictEqual(r.entries[2].size, 12);
});

test('scripts quote paths and session ids for the remote shell', () => {
  assert.match(LIST_SCRIPT("'/tmp/a b'"), /^cd '\/tmp\/a b' \|\| exit 3; pwd -P/);
  assert.match(CWD_SCRIPT('abc-1'), /'\^ATM_SID=abc-1\$'/);
});

test('ssh shells without tmux carry the session marker for the directory lookup', () => {
  const s = buildSpawn({ name: 'p', type: 'ssh', host: 'dev1', user: 'bob', directory: '/srv', tmux: false }, null, { id: 's-42', name: 'x' });
  assert.match(s.args[s.args.length - 1], /^export ATM_SID='s-42'; cd '\/srv' && exec/);
});

test('local projects: list, exists, mkdir, upload and download copy files and folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-files-'));
  const proj = path.join(root, 'proj');
  const src = path.join(root, 'src');
  fs.mkdirSync(proj);
  fs.mkdirSync(path.join(src, 'folder'), { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'A');
  fs.writeFileSync(path.join(src, 'folder', 'b.txt'), 'B');
  const f = filesFor({ type: 'local', directory: proj }, null);
  await f.upload([path.join(src, 'a.txt'), path.join(src, 'folder')], proj);
  await f.mkdir(proj, 'new');
  const l = await f.list('');
  assert.strictEqual(l.path, path.resolve(proj));
  assert.deepStrictEqual(l.entries.map((e) => `${e.type}:${e.name}`), ['dir:folder', 'dir:new', 'file:a.txt']);
  assert.deepStrictEqual(await f.exists(proj, ['a.txt', 'x', '../a.txt']), ['a.txt']);
  await assert.rejects(f.mkdir(proj, '../escape'), /Invalid/);
  const dl = path.join(root, 'dl');
  fs.mkdirSync(dl);
  await f.download([{ path: path.join(proj, 'folder'), type: 'dir' }, { path: path.join(proj, 'a.txt'), type: 'file' }], dl);
  assert.strictEqual(fs.readFileSync(path.join(dl, 'folder', 'b.txt'), 'utf8'), 'B');
  assert.strictEqual(fs.readFileSync(path.join(dl, 'a.txt'), 'utf8'), 'A');
});
