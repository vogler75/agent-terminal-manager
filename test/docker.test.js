'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DockerClient, dialSpec, FrameDecoder, cpuPercent, memUsage, parseHostStats, containerInfo, execCommand } = require('../src/main/docker');

test('dial-stdio command per connection type', () => {
  const ssh = dialSpec({ type: 'ssh', host: 'dev1', user: 'bob', port: 2200, docker: { command: '' } }, null);
  assert.match(ssh.file, /^ssh(\.exe)?$/);
  assert.deepStrictEqual(ssh.args.slice(0, 4), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']);
  assert.ok(ssh.args.includes('bob@dev1') && ssh.args.includes('2200'));
  assert.strictEqual(ssh.args[ssh.args.length - 1], "'docker' 'system' 'dial-stdio'");

  const wsl = dialSpec({ type: 'wsl', wslDistro: 'Ubuntu', docker: { command: '/usr/local/bin/docker' } }, null);
  assert.deepStrictEqual([wsl.file, ...wsl.args], ['wsl.exe', '-d', 'Ubuntu', '--exec', '/usr/local/bin/docker', 'system', 'dial-stdio']);

  const local = dialSpec({ type: 'local', docker: { enabled: true } }, null);
  assert.deepStrictEqual([local.file, ...local.args], ['docker', 'system', 'dial-stdio']);
});

test('log frames: stdout/stderr headers removed, split chunks reassembled', () => {
  const frame = (stream, text) => { const b = Buffer.from(text); const hd = Buffer.alloc(8); hd[0] = stream; hd.writeUInt32BE(b.length, 4); return Buffer.concat([hd, b]); };
  const all = Buffer.concat([frame(1, 'out 1\n'), frame(2, 'err 1\n'), frame(1, 'out 2\n')]);
  const d = new FrameDecoder();
  assert.strictEqual(d.push(all.subarray(0, 5)) + d.push(all.subarray(5, 17)) + d.push(all.subarray(17)), 'out 1\nerr 1\nout 2\n');
});

test('CPU and memory like docker stats', () => {
  const s = (total, system) => ({ cpu_stats: { cpu_usage: { total_usage: total }, system_cpu_usage: system, online_cpus: 4 } });
  assert.strictEqual(cpuPercent(null, s(1, 1)), null);
  assert.strictEqual(cpuPercent(s(100, 1000), s(150, 2000)), 20); // 50/1000 * 4 CPUs
  assert.strictEqual(memUsage({ memory_stats: { usage: 1000, stats: { inactive_file: 300 } } }), 700);
  assert.strictEqual(memUsage({ memory_stats: { usage: 1000, stats: { cache: 100 } } }), 900);
  assert.strictEqual(memUsage({ memory_stats: {} }), null);
});

test('host stats: df, meminfo, loadavg', () => {
  const h = parseHostStats('/dev/sdd 1055762868 16551016 985508380 2% /var/lib/docker\nMemTotal:       32648844 kB\nMemAvailable:   31798496 kB\n0.03 0.05 0.01 1/341 808\n');
  assert.deepStrictEqual(h.disk, { total: 1055762868 * 1024, used: 16551016 * 1024, free: 985508380 * 1024, mount: '/var/lib/docker' });
  assert.strictEqual(h.memTotal, 32648844 * 1024);
  assert.strictEqual(h.memAvailable, 31798496 * 1024);
  assert.deepStrictEqual(h.load, [0.03, 0.05, 0.01]);
});

test('container list entry: name, ports without duplicates, compose project, volumes', () => {
  const c = containerInfo({
    Id: 'abc', Names: ['/web-1'], Image: 'nginx', State: 'running', Status: 'Up 2 hours', Created: 1700000000,
    Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }, { IP: '::', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }, { PrivatePort: 443, Type: 'tcp' }],
    Labels: { 'com.docker.compose.project': 'shop' }, Mounts: [{ Type: 'volume', Name: 'data', Source: '/var/lib/docker/volumes/data/_data', Destination: '/data' }],
  });
  assert.strictEqual(c.name, 'web-1');
  assert.deepStrictEqual(c.ports, ['8080→80/tcp']);
  assert.strictEqual(c.compose, 'shop');
  assert.deepStrictEqual(c.mounts[0], { type: 'volume', name: 'data', source: '/var/lib/docker/volumes/data/_data', destination: '/data' });
});

test('shell command prefers bash and works in POSIX shells and PowerShell (no $)', () => {
  const cmd = execCommand({ docker: { command: '' } }, 'web-1');
  assert.strictEqual(cmd, 'docker exec -it web-1 sh -c "if command -v bash >/dev/null; then exec bash; else exec sh; fi"');
  assert.ok(!cmd.includes('$'));
});

// A stand-in for `docker system dial-stdio`: an HTTP/1.1 server on stdin/stdout.
const FAKE = `
let buf = '';
process.stdin.setEncoding('latin1');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\r\\n\\r\\n')) >= 0) {
    const head = buf.slice(0, i); buf = buf.slice(i + 4);
    const path = head.split(' ')[1];
    if (path.startsWith('/logs')) {
      const frame = (t) => { const b = Buffer.from(t); const h = Buffer.alloc(8); h[0] = 1; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
      process.stdout.write('HTTP/1.1 200 OK\\r\\nContent-Type: application/vnd.docker.multiplexed-stream\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n');
      for (const t of ['a\\n', 'b\\n']) { const f = frame(t); process.stdout.write(f.length.toString(16) + '\\r\\n'); process.stdout.write(f); process.stdout.write('\\r\\n'); }
      process.stdout.write('0\\r\\n\\r\\n');
      continue;
    }
    const status = path === '/missing' ? '404 Not Found' : '200 OK';
    const body = path === '/missing' ? JSON.stringify({ message: 'No such container: x' }) : JSON.stringify({ path, pid: process.pid });
    process.stdout.write('HTTP/1.1 ' + status + '\\r\\nContent-Type: application/json\\r\\nContent-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
  }
});
`;

test('Engine API over a stdio process: JSON, Docker errors, keep-alive reuse, streams', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dial-'));
  const script = path.join(dir, 'fake-dial.js');
  fs.writeFileSync(script, FAKE);
  const c = new DockerClient({ file: process.execPath, args: [script] });
  try {
    const a = await c.request('GET', '/info');
    const b = await c.request('GET', '/containers/json?all=1');
    assert.strictEqual(a.path, '/info');
    assert.strictEqual(b.path, '/containers/json?all=1');
    assert.strictEqual(a.pid, b.pid, 'the second request reuses the first connection');
    await assert.rejects(c.request('GET', '/missing'), /No such container: x/);
    const text = await new Promise((resolve, reject) => {
      const dec = new FrameDecoder();
      let out = '';
      c.stream('/logs', (chunk) => { out += dec.push(chunk); }, (err) => (err ? reject(err) : resolve(out)));
    });
    assert.strictEqual(text, 'a\nb\n');
  } finally {
    c.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dial process that fails reports its stderr', async () => {
  const c = new DockerClient({ file: process.execPath, args: ['-e', "process.stderr.write('permission denied while trying to connect to the docker API\\n'); process.exit(1)"] });
  try {
    await assert.rejects(c.request('GET', '/info'), /permission denied/);
  } finally { c.close(); }
});

// Records every request (method + path) in a file and answers like the Engine API.
const RECORDER = `
const fs = require('fs');
const log = process.argv[2];
let buf = '';
process.stdin.setEncoding('latin1');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\r\\n\\r\\n')) >= 0) {
    const head = buf.slice(0, i); buf = buf.slice(i + 4);
    const len = Number((head.match(/content-length: *(\\d+)/i) || [0, 0])[1]);
    const chunked = /transfer-encoding: *chunked/i.test(head);
    if (chunked) buf = buf.replace(/^0\\r\\n\\r\\n/, ''); else buf = buf.slice(len);
    const [method, path] = head.split(' ');
    fs.appendFileSync(log, method + ' ' + path + '\\n');
    let status = '200 OK';
    let body = { method, path };
    if (path.includes('in-use')) { status = '409 Conflict'; body = { message: 'conflict: unable to remove (in use)' }; }
    else if (path.startsWith('/containers/prune')) body = { ContainersDeleted: ['a', 'b'], SpaceReclaimed: 2048 };
    else if (path.startsWith('/images/prune')) body = { ImagesDeleted: [{ Untagged: 'x:1' }, { Deleted: 'sha256:1' }], SpaceReclaimed: 4096 };
    else if (path.startsWith('/volumes/prune')) body = { VolumesDeleted: null, SpaceReclaimed: 0 };
    const text = JSON.stringify(body);
    process.stdout.write('HTTP/1.1 ' + status + '\\r\\nContent-Type: application/json\\r\\nContent-Length: ' + Buffer.byteLength(text) + '\\r\\n\\r\\n' + text);
  }
});
`;

function recorderDocker() {
  const { ProjectDocker } = require('../src/main/docker');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rec-'));
  const script = path.join(dir, 'rec.js');
  const log = path.join(dir, 'requests.log');
  fs.writeFileSync(script, RECORDER);
  fs.writeFileSync(log, '');
  const d = new ProjectDocker({ store: { getProject: () => ({ id: 'p', type: 'local', docker: { enabled: true } }) }, emit() {} }, { id: 'p' });
  d.client = new DockerClient({ file: process.execPath, args: [script, log] });
  const requests = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).sort();
  const done = () => { d.stop(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { d, requests, done };
}

test('container, image and volume operations map to the Engine API', async () => {
  const { d, requests, done } = recorderDocker();
  try {
    for (const a of ['start', 'stop', 'restart', 'pause', 'unpause', 'kill']) await d.operate('container', a, { id: 'c1' });
    await d.operate('container', 'remove', { id: 'c1' }, { force: true, volumes: true });
    await d.operate('image', 'remove', { id: 'sha256:abc', tags: ['app:1'] });
    await d.operate('image', 'remove', { id: 'sha256:def', tags: ['web:1', 'web:latest'] }); // several tags: each tag
    await d.operate('image', 'remove', { id: 'sha256:def', tags: ['web:1', 'web:latest'] }, { force: true }); // force: by ID
    await d.operate('volume', 'remove', { id: 'data vol' });
    await assert.rejects(d.operate('network', 'remove', { id: 'n' }), /Unknown action/);
    assert.deepStrictEqual(requests(), [
      'DELETE /containers/c1?force=1&v=1',
      'DELETE /images/sha256%3Aabc?force=0',
      'DELETE /images/sha256%3Adef?force=1',
      'DELETE /images/web%3A1',
      'DELETE /images/web%3Alatest',
      'DELETE /volumes/data%20vol?force=0',
      'POST /containers/c1/kill',
      'POST /containers/c1/pause',
      'POST /containers/c1/restart?t=10',
      'POST /containers/c1/start',
      'POST /containers/c1/stop?t=10',
      'POST /containers/c1/unpause',
    ]);
  } finally { done(); }
});

test('bulk: every item is tried, failures are reported per item', async () => {
  const { d, requests, done } = recorderDocker();
  try {
    const r = await d.bulk('container', 'remove', [{ id: 'a', name: 'web' }, { id: 'in-use', name: 'db' }, { id: 'c', name: 'cache' }, { id: 'd', name: 'worker' }]);
    assert.deepStrictEqual(r.map((x) => [x.name, x.ok]), [['web', true], ['db', false], ['cache', true], ['worker', true]]);
    assert.match(r[1].error, /in use/);
    assert.strictEqual(requests().length, 4);
  } finally { done(); }
});

test('prune: stopped containers, unused or dangling images, anonymous or all unused volumes', async () => {
  const { d, requests, done } = recorderDocker();
  try {
    assert.deepStrictEqual(await d.prune('container'), { count: 2, space: 2048 });
    assert.deepStrictEqual(await d.prune('image', { all: true }), { count: 1, space: 4096 });
    await d.prune('image');
    assert.deepStrictEqual(await d.prune('volume', { all: true }), { count: 0, space: 0 });
    await d.prune('volume');
    const dec = requests().map(decodeURIComponent);
    assert.deepStrictEqual(dec, [
      'POST /containers/prune',
      'POST /images/prune?filters={"dangling":["false"]}',
      'POST /images/prune?filters={"dangling":["true"]}',
      'POST /volumes/prune',
      'POST /volumes/prune?filters={"all":["true"]}',
    ]);
  } finally { done(); }
});
