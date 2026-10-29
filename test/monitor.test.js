'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseSample, parseDf, buildSnapshot, cpuUsage, monitorSpec, unsupported, SCRIPT } = require('../src/main/monitor');

const sample = (o) => `@@TC static
hostname=nuc3
kernel=Linux 6.1.0
arch=x86_64
clk=100
page=4096
os=Debian GNU/Linux 12
cpumodel= Intel(R) Core(TM) i5
user=bob
@@TC blocks
sda
nvme0n1
@@TC uptime
${o.up} 100.00
@@TC loadavg
0.50 0.40 0.30 2/300 1234
@@TC stat
cpu  ${o.cpu}
cpu0 ${o.cpu}
cpu1 100 0 100 ${o.cpu1idle} 0 0 0 0 0 0
@@TC meminfo
MemTotal:       8000000 kB
MemFree:        1000000 kB
MemAvailable:   4000000 kB
Buffers:         100000 kB
Cached:         2000000 kB
SwapTotal:      1000000 kB
SwapFree:        750000 kB
@@TC diskstats
   8       0 sda 100 0 ${o.rs} 5 50 0 ${o.ws} 7 0 ${o.io} 12
   8       1 sda1 100 0 100 5 50 0 100 7 0 10 12
   7       0 loop0 1 0 1 0 0 0 0 0 0 0 0
@@TC netdev
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: ${o.rx} 20 0 0 0 0 0 0 ${o.tx} 30 0 0 0 0 0 0
@@TC procstat
10 (my app) S 1 10 10 0 -1 4194560 100 0 0 0 ${o.ticks} 0 0 0 20 0 3 0 5000 1000000 ${o.rss} 18446744073709551615
11 (idle) S 1 11 11 0 -1 4194560 100 0 0 0 5 0 0 0 20 0 1 0 6000 1000000 10 18446744073709551615
@@TC ps
    PID USER                     COMMAND
     10 bob                      /usr/bin/my app --flag
     11 root                     /sbin/idle
@@TC df
Filesystem     Type     1024-blocks     Used Available Capacity Mounted on
/dev/sda1      ext4         1000000   400000    600000      40% /
tmpfs          tmpfs           1000        0      1000       0% /run
/dev/sdb1      xfs          2000000  1900000    100000      95% /data disk
`;

const a = parseSample(sample({ up: 1000, cpu: '1000 0 500 8000 100 0 0 0 0 0', cpu1idle: 800, rs: 1000, ws: 2000, io: 100, rx: 5000, tx: 7000, ticks: 100, rss: 500 }));
const b = parseSample(sample({ up: 1002, cpu: '1100 0 600 8100 100 0 0 0 0 0', cpu1idle: 900, rs: 3000, ws: 6000, io: 300, rx: 9000, tx: 8000, ticks: 160, rss: 600 }));

test('monitor: sample parsing', () => {
  assert.strictEqual(a.static.hostname, 'nuc3');
  assert.deepStrictEqual(a.static.blocks, ['sda', 'nvme0n1']);
  assert.strictEqual(a.uptime, 1000);
  assert.deepStrictEqual(a.load, [0.5, 0.4, 0.3]);
  assert.deepStrictEqual(a.running, [2, 300]);
  assert.strictEqual(a.mem.MemTotal, 8000000 * 1024);
  assert.strictEqual(a.procs.get(10).comm, 'my app');
  assert.strictEqual(a.procs.get(10).ticks, 100);
  assert.strictEqual(a.procs.get(10).threads, 3);
  assert.strictEqual(a.ps.get(10).args, '/usr/bin/my app --flag');
  assert.strictEqual(a.net.eth0.rx, 5000);
});

test('monitor: df rows skip pseudo file systems and keep mount names with spaces', () => {
  assert.deepStrictEqual(a.mounts.map((m) => m.mount), ['/', '/data disk']);
  assert.strictEqual(a.mounts[1].pct, 95);
  assert.strictEqual(a.mounts[0].total, 1000000 * 1024);
  // without the type column (busybox, macOS style)
  const plain = parseDf(['Filesystem 1024-blocks Used Available Capacity Mounted on', '/dev/root 1000 400 600 40% /', 'tmpfs 10 0 10 0% /tmp']);
  assert.deepStrictEqual(plain.map((m) => m.mount), ['/']);
});

test('monitor: rates from two samples', () => {
  const s = buildSnapshot(a, b, { static: a.static, mounts: a.mounts });
  assert.strictEqual(s.info.hostname, 'nuc3');
  assert.strictEqual(s.info.cores, 2);
  // delta: busy 100+100 of total 300 → 66.7 %
  assert.ok(Math.abs(s.cpu.total - 200 / 3) < 0.01, String(s.cpu.total));
  assert.strictEqual(s.cpu.cores.length, 2);
  assert.strictEqual(s.mem.available, 4000000 * 1024);
  assert.strictEqual(s.mem.swapUsed, 250000 * 1024);
  // whole disks only, 512-byte sectors over 2 s
  assert.deepStrictEqual(s.disks.map((d) => d.name), ['sda']);
  assert.strictEqual(s.disks[0].readBps, (2000 * 512) / 2);
  assert.strictEqual(s.disks[0].writeBps, (4000 * 512) / 2);
  assert.strictEqual(s.disks[0].util, 10); // 200 ms busy in 2 s
  assert.deepStrictEqual(s.net.map((n) => n.name), ['eth0']);
  assert.strictEqual(s.net[0].rxBps, 2000);
  assert.strictEqual(s.net[0].txBps, 500);
  // 60 ticks in 2 s at 100 Hz = 30 % of one core
  const app = s.procs.list.find((r) => r.pid === 10);
  assert.ok(Math.abs(app.cpu - 30) < 0.01);
  assert.strictEqual(app.user, 'bob');
  assert.strictEqual(app.mem, 600 * 4096);
  assert.strictEqual(s.procs.total, 2);
});

test('monitor: first sample has no rates yet', () => {
  const s = buildSnapshot(null, a, { static: a.static, mounts: a.mounts });
  assert.strictEqual(s.cpu.total, null);
  assert.strictEqual(s.disks[0].readBps, null);
  assert.strictEqual(s.procs.list.find((r) => r.pid === 10).cpu, null);
  assert.strictEqual(cpuUsage(null, [1, 2]), null);
});

test('monitor: runs the script through sh on the project machine', () => {
  const ssh = monitorSpec({ type: 'ssh', host: 'dev1', user: 'bob', port: 2200 }, null);
  assert.strictEqual(ssh.file, 'ssh');
  assert.ok(ssh.args[ssh.args.length - 1].startsWith("exec sh -c '"));
  assert.ok(ssh.args.includes('bob@dev1'));
  const wsl = monitorSpec({ type: 'wsl', wslDistro: 'Ubuntu' }, null);
  assert.deepStrictEqual(wsl.args.slice(0, 4), ['-d', 'Ubuntu', '--exec', 'bash']);
  assert.ok(SCRIPT.includes('/proc/diskstats'));
});

test('monitor: only for Linux machines', () => {
  assert.strictEqual(unsupported({ type: 'ssh' }), null);
  assert.strictEqual(unsupported({ type: 'wsl' }), null);
  assert.strictEqual(!!unsupported({ type: 'local' }), process.platform !== 'linux');
});
