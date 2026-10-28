'use strict';
// End-to-end acceptance test. Drives the real Electron app via Playwright.
//
// Optional environment:
//   ATM_E2E_SSH=user@host:port   SSH target with key auth and tmux (enables SSH/tmux/forward tests)
//   ATM_E2E_WSL=Ubuntu           WSL distribution with tmux (Windows only)
//   ATM_E2E_OPENCODE=1           run OpenCode agent + orchestrator tests (needs a working model)
//   ATM_E2E_SHOTS=dir            write screenshots there
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { launch, sleep } = require('./launch');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { ResourceUpdatedNotificationSchema } = require('@modelcontextprotocol/sdk/types.js');

const IS_WIN = process.platform === 'win32';
const SHOTS = process.env.ATM_E2E_SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const MCP_PORT = 47000 + Math.floor(Math.random() * 800);

const sshSpec = process.env.ATM_E2E_SSH ? /^(?:(.+)@)?([^:]+)(?::(\d+))?$/.exec(process.env.ATM_E2E_SSH) : null;
const SSH = sshSpec ? { user: sshSpec[1] || '', hostname: sshSpec[2], port: Number(sshSpec[3] || 22) } : null;
const WSL = IS_WIN ? process.env.ATM_E2E_WSL : null;
const OPENCODE = process.env.ATM_E2E_OPENCODE === '1';
const RUN = 'r' + Date.now().toString(36).slice(-5);

const results = [];
async function step(name, fn, { skip } = {}) {
  if (skip) { results.push({ name, status: 'skip', info: skip }); console.log(`- SKIP ${name} (${skip})`); return; }
  const t = Date.now();
  try {
    await fn();
    results.push({ name, status: 'pass', ms: Date.now() - t });
    console.log(`✓ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    results.push({ name, status: 'fail', error: e.stack || String(e) });
    console.log(`✗ ${name}\n   ${String(e.message || e).split('\n').join('\n   ')}`);
  }
}

async function waitFor(fn, { timeout = 15000, interval = 200, msg = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`Timeout waiting for ${msg}${last instanceof Error ? ': ' + last.message : ''}`);
}

function sshRun(script) {
  const args = ['-o', 'BatchMode=yes', '-p', String(SSH.port), (SSH.user ? SSH.user + '@' : '') + SSH.hostname, script];
  const r = spawnSync('ssh', args, { encoding: 'utf8', timeout: 20000 });
  return (r.stdout || '') + (r.stderr || '');
}

// Main-process helpers (run inside Electron main via app.evaluate).
const M = (app) => ({
  sessions: () => app.evaluate(() => globalThis.__atm.sessions.list().map((s) => s.info())),
  output: (id, lines = 60) => app.evaluate((_e, a) => { const s = globalThis.__atm.sessions.get(a.id); return s ? s.readOutput({ lines: a.lines }).text : null; }, { id, lines }),
  send: (id, text) => app.evaluate((_e, a) => globalThis.__atm.sessions.get(a.id).send(a.text), { id, text }),
  status: (id) => app.evaluate((_e, id) => { const s = globalThis.__atm.sessions.get(id); return s && s.status; }, id),
  info: (id) => app.evaluate((_e, id) => { const s = globalThis.__atm.sessions.get(id); return s && { ...s.info(), cols: s.cols, rows: s.rows, spec: s.spec }; }, id),
  open: (pid, opts) => app.evaluate((_e, a) => globalThis.__atm.sessions.open(a.pid, a.opts || {}).info(), { pid, opts }),
  close: (id, killTmux) => app.evaluate((_e, a) => globalThis.__atm.sessions.close(a.id, { killTmux: a.killTmux }), { id, killTmux }),
  find: (pid, name) => app.evaluate((_e, a) => { const s = globalThis.__atm.sessions.list(a.pid).find((x) => x.name === a.name); return s ? s.id : null; }, { pid, name }),
});

const cfgBase = () => {
  const projects = [
    { id: 'p-local', name: 'lokal', type: 'local', tmux: false, thresholdSec: 2, directory: '', commands: [{ name: 'Hallo', command: 'echo saved-cmd-ok' }], terminals: [{ name: 'dev', command: '' }, { name: 'rev', command: '' }] },
  ];
  const hosts = [];
  if (SSH) {
    hosts.push({ id: 'h1', name: 'devbox', hostname: SSH.hostname, port: SSH.port, user: SSH.user, workspace: `~/atm-e2e-${RUN}`, tags: ['test'] });
    projects.push({ id: 'p-ssh', name: 'remote', type: 'ssh', hostId: 'h1', directory: `~/atm-e2e-${RUN}/proj1`, tmux: true, keepAlive: true, thresholdSec: 2, forwards: [{ local: MCP_PORT + 900, remote: MCP_PORT + 901 }] });
  }
  if (WSL) projects.push({ id: 'p-wsl', name: 'wsl', type: 'wsl', wslDistro: WSL, directory: '/tmp', tmux: true, thresholdSec: 2 });
  return { settings: { mcp: { enabled: true, port: MCP_PORT, bind: '127.0.0.1', allowCreateProject: true, allowCreateDirectory: true, allowRunCommand: true }, notifications: true }, hosts, projects };
};

(async () => {
  if (SSH) sshRun(`mkdir -p ~/atm-e2e-${RUN}/proj1`);
  let { app, page, dir, errors } = await launch({ config: cfgBase(), env: { ATM_NO_RESTORE: '0' } });
  let m = M(app);
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') }).catch(() => {});
  const ids = {};

  // ---------------- Phase 1 ----------------
  await step('P1 window shows project tree and terminal area', async () => {
    await page.waitForSelector('#sidebar .proj-name');
    assert.ok(await page.isVisible('text=lokal'));
    assert.ok(await page.isVisible('#main'));
  });

  await step('P1 local shell starts and runs commands', async () => {
    await page.click('#sidebar .proj-name:text("lokal")');
    await page.click('text=+ Open session');
    ids.local = await waitFor(async () => (await m.sessions()).find((s) => s.projectId === 'p-local')?.id, { msg: 'session' });
    await waitFor(async () => /PS |\$ |% /.test((await m.output(ids.local)) || ''), { msg: 'prompt', timeout: 20000 });
    await page.keyboard.type('echo hello-atm-' + RUN);
    await page.keyboard.press('Enter');
    await waitFor(async () => ((await m.output(ids.local)) || '').split('\n').some((l) => l.trim() === 'hello-atm-' + RUN), { msg: 'echo output' });
    await shot('p1-local');
  });

  await step('P1 terminal resize is passed to the shell', async () => {
    const before = await m.info(ids.local);
    await page.setViewportSize({ width: 900, height: 600 });
    await waitFor(async () => (await m.info(ids.local)).cols < before.cols, { msg: 'smaller cols' });
    await page.setViewportSize({ width: 1400, height: 860 });
    await waitFor(async () => (await m.info(ids.local)).cols > before.cols - 5, { msg: 'larger cols' });
    if (IS_WIN) {
      await m.send(ids.local, '$Host.UI.RawUI.WindowSize.Width');
      const cols = (await m.info(ids.local)).cols;
      await waitFor(async () => (await m.output(ids.local)).split('\n').some((l) => l.trim() === String(cols)), { msg: 'shell reports width ' + cols });
    }
  });

  // ---------------- Phase 2 ----------------
  await step('P2 create, edit and delete a project in the UI; saved as JSON', async () => {
    await page.click('text=+ Project');
    const modal = page.locator('.modal');
    await modal.locator('input').first().fill('ui-projekt');
    // An accidental click outside the dialog must not close it.
    await page.mouse.click(5, 5);
    assert.ok(await modal.isVisible(), 'dialog stays open after clicking the backdrop');
    assert.strictEqual(await modal.locator('input').first().inputValue(), 'ui-projekt');
    await modal.locator('select').first().selectOption('ssh');
    await modal.locator('input[placeholder="hostname or IP"]').fill('example.invalid');
    await modal.locator('input[placeholder="user"]').fill('bob');
    await modal.locator('button.primary').click();
    await page.waitForSelector('#sidebar .proj-name:text("ui-projekt")');
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    await waitFor(() => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).projects.some((p) => p.name === 'ui-projekt' && p.user === 'bob'), { msg: 'saved json' });
    // edit
    await page.click('#main .main-head button.icon[title="Edit project"]');
    await page.locator('.modal input').first().fill('ui-projekt-2');
    await page.locator('.modal button.primary').click();
    await page.waitForSelector('#sidebar .proj-name:text("ui-projekt-2")');
    // delete
    await page.click('#main .main-head button.icon[title="Edit project"]');
    await page.locator('.modal button.danger').click();
    await page.locator('.modal button.primary').last().click();
    await waitFor(async () => !(await page.isVisible('#sidebar .proj-name:text("ui-projekt-2")')), { msg: 'deleted' });
    assert.ok(cfg);
  });

  await step('P2 export / import JSON and no passwords stored', async () => {
    const text = await page.evaluate(() => window.atm.call('exportConfigText'));
    const data = JSON.parse(text);
    assert.ok(data.projects.length >= 1);
    data.projects.push({ id: 'p-imp', name: 'importiert', type: 'local', password: 'geheim' });
    await page.evaluate((t) => window.atm.call('importConfigText', t, true), JSON.stringify(data));
    await page.waitForSelector('#sidebar .proj-name:text("importiert")');
    await waitFor(() => { const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8'); return raw.includes('importiert') && !raw.includes('geheim'); }, { msg: 'password stripped' });
    await page.evaluate(() => window.atm.call('deleteProject', 'p-imp'));
  });

  // ---------------- Phase 5 (local) ----------------
  await step('P5 status: output → working, quiet > threshold → waiting', async () => {
    await m.send(ids.local, IS_WIN ? '1..4 | % { "tick$_"; Start-Sleep -Milliseconds 700 }' : 'for i in 1 2 3 4; do echo tick$i; sleep 0.7; done');
    await waitFor(async () => (await m.status(ids.local)) === 'working', { msg: 'working', timeout: 5000 });
    await sleep(2000);
    assert.strictEqual(await m.status(ids.local), 'working', 'still working while output flows');
    await waitFor(async () => (await m.status(ids.local)) === 'waiting', { msg: 'waiting', timeout: 10000 });
    const cls = await page.getAttribute(`[data-dot="${ids.local}"]`, 'class');
    assert.match(cls, /waiting/);
  });

  await step('P5 BEL sets status to waiting immediately; desktop notification', async () => {
    await app.evaluate(() => { globalThis.__atm.store.getProject('p-local').thresholdSec = 30; });
    await page.click('#sidebar button:has-text("Overview")'); // not focused on the session -> notification expected
    const n0 = await app.evaluate(() => globalThis.__atm.notificationLog.length);
    await m.send(ids.local, IS_WIN ? 'Start-Sleep 1; Write-Host "bell$([char]7)"' : 'sleep 1; printf "bell\\a\\n"');
    await waitFor(async () => (await m.status(ids.local)) === 'working', { msg: 'working', timeout: 5000 });
    const t = Date.now();
    await waitFor(async () => (await m.status(ids.local)) === 'waiting', { msg: 'waiting by bell', timeout: 8000 });
    assert.ok(Date.now() - t < 6000, 'waiting much earlier than threshold 30 s');
    await waitFor(async () => (await app.evaluate(() => globalThis.__atm.notificationLog.length)) > n0, { msg: 'notification' });
    const last = await app.evaluate(() => globalThis.__atm.notificationLog.slice(-1)[0]);
    assert.match(last.body, /bell|waiting/i);
    await app.evaluate(() => { globalThis.__atm.store.getProject('p-local').thresholdSec = 2; });
  });

  // ---------------- Phase 6 (saved command) ----------------
  await step('P6 saved command runs in active terminal by click', async () => {
    await page.click('#sidebar .proj-name:text("lokal")');
    await page.click('.cmdbar button:has-text("Hallo")');
    await waitFor(async () => (await m.output(ids.local)).split('\n').some((l) => l.trim() === 'saved-cmd-ok'), { msg: 'saved command output' });
  });

  // ---------------- Phase 4 ----------------
  await step('P4 tabs, tiles (2/3/4) and click back to single view', async () => {
    await page.click('#main button:has-text("▶ All")');
    await waitFor(async () => (await m.sessions()).filter((s) => s.projectId === 'p-local').length === 3, { msg: '3 sessions' });
    await page.waitForSelector('.tabs .tab >> nth=2');
    await page.click('#main .main-head button:has-text("Tiles")');
    await page.waitForSelector('.grid .tile >> nth=2');
    let cols = await page.$eval('.grid', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
    assert.strictEqual(cols, 3, '3 sessions -> 3 columns');
    await shot('p4-tiles-3');
    await page.click('#main .main-head button:has-text("3 columns")');
    await waitFor(async () => /1 \/ 3/.test(await page.$eval('.grid .tile', (t) => t.style.gridRow)), { msg: 'one big + two small' });
    await shot('p4-tiles-1plus2');
    ids.extra = (await m.open('p-local', {})).id;
    await waitFor(async () => (await page.$$('.grid .tile')).length === 4, { msg: '4 tiles' });
    const tpl = await page.$eval('.grid', (g) => [getComputedStyle(g).gridTemplateColumns.split(' ').length, getComputedStyle(g).gridTemplateRows.split(' ').length]);
    assert.deepStrictEqual(tpl, [2, 2], '4 -> 2x2');
    await shot('p4-tiles-4');
    await page.click('.grid .tile >> nth=1 >> .tile-head');
    await page.waitForSelector('.tabs .tab.active');
    assert.strictEqual(await page.$$eval('.grid', (g) => g.length), 0, 'back to single view');
  });

  await step('P4 overview groups per project; scaling via font size; click opens session', async () => {
    await page.click('#sidebar button:has-text("Overview")');
    await page.waitForSelector('.ov-group');
    const groups = await page.$$eval('.ov-group .ov-head', (els) => els.map((e) => e.textContent));
    assert.ok(groups.some((g) => g.includes('lokal')));
    const fs = await page.evaluate((id) => window.__atm.terms.get(id).term.options.fontSize, ids.local);
    assert.ok(fs < 13, 'overview uses smaller font size, got ' + fs);
    const zoom = await page.$eval('.ov-group .termwrap', (e) => getComputedStyle(e).zoom + '|' + getComputedStyle(e).transform);
    assert.ok(/^1\|none$/.test(zoom) || zoom.startsWith('1|none'), 'no CSS zoom/transform: ' + zoom);
    await shot('p4-overview');
    await page.click('.ov-group .tile-click >> nth=0');
    await page.waitForSelector('.tabs .tab.active');
    const fs2 = await page.evaluate((id) => window.__atm.terms.get(id).term.options.fontSize, ids.local);
    assert.strictEqual(fs2, 13);
  });

  await step('P3 sessions keep running and keep scrollback when switching projects', async () => {
    await m.send(ids.local, 'echo before-switch-' + RUN);
    await page.click('#sidebar button:has-text("Hosts")');
    await m.send(ids.local, 'echo while-hidden-' + RUN);
    await sleep(800);
    await page.click('#sidebar .proj-name:text("lokal")');
    await page.click(`#sidebar .sess:has-text("shell")`);
    const text = await page.evaluate((id) => { const t = window.__atm.terms.get(id).term; const b = t.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\n'; return s; }, ids.local);
    assert.ok(text.includes('before-switch-' + RUN) && text.includes('while-hidden-' + RUN), 'renderer buffer has both lines');
  });

  await step('P3 rename and close sessions in the tree', async () => {
    await page.dblclick(`#sidebar .sess:has-text("rev")`);
    await page.locator('.modal input').fill('reviewer');
    await page.locator('.modal button.primary').click();
    await page.waitForSelector('#sidebar .sess:has-text("reviewer")');
    await page.click(`.tab:has-text("shell-2") .x`).catch(async () => { await m.close(ids.extra); });
    await waitFor(async () => !(await m.sessions()).some((s) => s.id === ids.extra), { msg: 'closed' });
  });

  // ---------------- Phase 3 / 0: SSH + tmux ----------------
  await step('P0/P3 SSH session connects and lands in configured directory', async () => {
    await page.click('#sidebar .proj-name:text("remote")');
    await page.click('text=+ Open session');
    ids.ssh = await waitFor(async () => (await m.sessions()).find((s) => s.projectId === 'p-ssh')?.id, { msg: 'ssh session' });
    await waitFor(async () => /\$ *$/m.test((await m.output(ids.ssh)) || ''), { msg: 'remote prompt', timeout: 25000 });
    await m.send(ids.ssh, 'pwd; tmux display -p "tmux:#S"');
    await waitFor(async () => { const o = await m.output(ids.ssh); return o.includes(`/atm-e2e-${RUN}/proj1`) && o.includes('tmux:atm-remote-shell'); }, { msg: 'pwd + tmux name' });
    await shot('p3-ssh');
  }, { skip: SSH ? null : 'ATM_E2E_SSH not set' });

  await step('P3 keep-alive sets ServerAliveInterval / ServerAliveCountMax', async () => {
    const info = await m.info(ids.ssh);
    const a = info.spec.args.join(' ');
    assert.match(a, /ServerAliveInterval=30/);
    assert.match(a, /ServerAliveCountMax=3/);
  }, { skip: SSH ? null : 'ATM_E2E_SSH not set' });

  await step('P0/P3 tmux: process keeps running after disconnect; re-attach', async () => {
    await m.send(ids.ssh, 'for i in $(seq 1 2000); do echo tick-$i; sleep 0.5; done');
    await waitFor(async () => /tick-3/.test(await m.output(ids.ssh)), { msg: 'ticks' });
    // Simulate a lost connection: kill the local ssh process.
    await app.evaluate((_e, id) => { globalThis.__atm.sessions.get(id).pty.kill(); }, ids.ssh);
    await waitFor(async () => ['error', 'exited'].includes(await m.status(ids.ssh)), { msg: 'disconnected status' });
    await page.waitForSelector('.overlay-err button:has-text("Reconnect")', { timeout: 8000 });
    await shot('p3-disconnected');
    const before = Math.max(...(await m.output(ids.ssh, 200)).match(/tick-(\d+)/g).map((x) => Number(x.slice(5))));
    await sleep(2500);
    await page.click('.overlay-err button:has-text("Reconnect")');
    await waitFor(async () => {
      const nums = ((await m.output(ids.ssh, 200)).match(/tick-(\d+)/g) || []).map((x) => Number(x.slice(5)));
      return Math.max(...nums) > before + 3;
    }, { msg: 'ticks continued while disconnected', timeout: 20000 });
    const remote = sshRun('tmux ls');
    assert.match(remote, /atm-remote-shell/);
  }, { skip: SSH ? null : 'ATM_E2E_SSH not set' });

  await step('Open point: automatic reconnect after a dropped connection', async () => {
    await app.evaluate(() => { globalThis.__atm.store.getProject('p-ssh').autoReconnect = true; });
    await app.evaluate((_e, id) => { globalThis.__atm.sessions.get(id).pty.kill(); }, ids.ssh);
    await waitFor(async () => ['error', 'exited'].includes(await m.status(ids.ssh)), { msg: 'dropped' });
    await waitFor(async () => /Reconnecting in/.test(await m.output(ids.ssh, 300)), { msg: 'reconnect notice' });
    await waitFor(async () => ['working', 'waiting'].includes(await m.status(ids.ssh)), { msg: 'reconnected automatically', timeout: 20000 });
    await app.evaluate(() => { globalThis.__atm.store.getProject('p-ssh').autoReconnect = false; });
  }, { skip: SSH ? null : 'ATM_E2E_SSH not set' });

  await step('P6 port forwarding active while session runs', async () => {
    const lp = MCP_PORT + 900;
    const rp = MCP_PORT + 901;
    sshRun(`tmux new-session -d -s atm-e2e-http-${RUN} "cd /tmp && python3 -m http.server ${rp} --bind 127.0.0.1"`);
    await waitFor(async () => (await app.evaluate(() => globalThis.__atm.forwards.snapshot()))['p-ssh']?.status === 'active', { msg: 'forward active', timeout: 10000 });
    const body = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${lp}/`); return r.ok ? r.text() : null; }, { msg: 'http via forward', timeout: 15000 });
    assert.match(body, /Directory listing|<html/i);
    sshRun(`tmux kill-session -t atm-e2e-http-${RUN}`);
  }, { skip: SSH ? null : 'ATM_E2E_SSH not set' });

  await step('P3 connection errors are shown with reconnect button', async () => {
    const p = await app.evaluate(() => globalThis.__atm.store.saveProject({ id: 'p-bad', name: 'kaputt', type: 'ssh', host: '127.0.0.1', port: 1, tmux: false, keepAlive: false }));
    await page.click('#sidebar .proj-name:text("kaputt")');
    await page.click('text=+ Open session');
    await page.waitForSelector('.overlay-err', { timeout: 15000 });
    const msg = await page.textContent('.overlay-err .msg');
    assert.match(msg, /exit code|Connection/i);
    await shot('p3-error');
    await app.evaluate(() => { for (const s of globalThis.__atm.sessions.list('p-bad')) globalThis.__atm.sessions.close(s.id); globalThis.__atm.store.deleteProject('p-bad'); });
    assert.ok(p);
  });

  await step('P3 WSL session starts in distribution and directory (tmux)', async () => {
    await page.click('#sidebar .proj-name:text("wsl")');
    await page.click('text=+ Open session');
    ids.wsl = await waitFor(async () => (await m.sessions()).find((s) => s.projectId === 'p-wsl')?.id, { msg: 'wsl session' });
    await waitFor(async () => /\$ *$/m.test((await m.output(ids.wsl)) || ''), { msg: 'wsl prompt', timeout: 25000 });
    await m.send(ids.wsl, 'pwd; tmux display -p "tmux:#S"');
    await waitFor(async () => { const o = await m.output(ids.wsl); return /^\/tmp$/m.test(o) && o.includes('tmux:atm-wsl-shell'); }, { msg: 'pwd /tmp in tmux' });
  }, { skip: WSL ? null : 'ATM_E2E_WSL not set' });

  // ---------------- Phase 7: MCP ----------------
  let client, token, roToken;
  const mcpUrl = `http://127.0.0.1:${MCP_PORT}/mcp`;
  const connect = async (tok) => {
    const c = new Client({ name: 'e2e', version: '1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { Authorization: 'Bearer ' + tok } } }));
    return c;
  };
  const callTool = async (c, name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const text = r.content[0].text;
    if (r.isError) throw new Error(text);
    try { return JSON.parse(text); } catch { return text; }
  };

  await step('P7 MCP over HTTP rejects requests without valid token', async () => {
    const r = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    assert.strictEqual(r.status, 401);
    const r2 = await fetch(mcpUrl, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
    assert.strictEqual(r2.status, 401);
  });

  await step('P7 tokens can be created in the UI (shown once)', async () => {
    await page.click('#sidebar button:has-text("MCP")');
    await page.click('button:has-text("+ Token (full)")');
    await page.locator('.modal input').fill('e2e');
    await page.locator('.modal button.primary').click();
    await page.waitForSelector('.modal .secret');
    token = (await page.textContent('.modal .secret')).trim();
    assert.match(token, /^atm_/);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await shot('p7-mcp');
    roToken = (await page.evaluate(() => window.atm.call('createToken', { name: 'ro', readOnly: true }))).secret;
    client = await connect(token);
  });

  await step('P7 list_sessions / send_to_session / wait_until_idle / read_output', async () => {
    const list = await callTool(client, 'list_sessions');
    assert.ok(list.some((s) => s.name === 'dev' && s.project === 'lokal'));
    const devId = list.find((s) => s.name === 'dev').id;
    ids.dev = devId;
    await callTool(client, 'send_to_session', { session: 'lokal/dev', text: IS_WIN ? '1..3 | % { "mcp-step$_"; Start-Sleep -Milliseconds 500 }' : 'for i in 1 2 3; do echo mcp-step$i; sleep 0.5; done' });
    const w = await callTool(client, 'wait_until_idle', { session: 'dev', project: 'lokal', timeout_sec: 30 });
    assert.strictEqual(w.status, 'waiting');
    assert.match(w.output, /mcp-step3/);
    const r = await callTool(client, 'read_output', { session: devId, lines: 20 });
    assert.match(r.output, /mcp-step2/);
    const r2 = await callTool(client, 'read_output', { session: devId, since: r.marker });
    assert.strictEqual(r2.output.trim(), '');
  });

  await step('P7 wait_for_any_idle returns the first finished session', async () => {
    await callTool(client, 'send_to_session', { session: 'lokal/dev', text: IS_WIN ? '1..12 | % { "dev-busy$_"; Start-Sleep -Milliseconds 500 }' : 'for i in $(seq 1 12); do echo dev-busy$i; sleep 0.5; done' });
    await callTool(client, 'send_to_session', { session: 'lokal/reviewer', text: IS_WIN ? 'Start-Sleep 1; "rev-fertig"' : 'sleep 1; echo rev-fertig' });
    const r = await callTool(client, 'wait_for_any_idle', { sessions: ['lokal/dev', 'lokal/reviewer'], timeout_sec: 30, only_new: true });
    assert.strictEqual(r.session, 'reviewer');
    await callTool(client, 'wait_until_idle', { session: 'lokal/dev', timeout_sec: 30 });
  });

  await step('P7 resources: subscribe → notifications/resources/updated on status change', async () => {
    const res = await client.listResources();
    const uri = res.resources.find((x) => x.name === 'lokal/dev').uri;
    assert.strictEqual(uri, 'session://lokal/dev/status');
    const got = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => got.push(n.params.uri));
    await client.subscribeResource({ uri });
    await callTool(client, 'send_to_session', { session: 'lokal/dev', text: 'echo sub-test' });
    await waitFor(() => got.includes(uri), { msg: 'resource update notification', timeout: 10000 });
    const read = await client.readResource({ uri });
    assert.ok(JSON.parse(read.contents[0].text).status);
  });

  await step('P7 open_session, run_command, list_hosts, find_free_host, create_directory, create_project', async () => {
    const s = await callTool(client, 'open_session', { project: 'lokal', name: 'mcp-opened' });
    assert.strictEqual(s.name, 'mcp-opened');
    await sleep(2500);
    const rc = await callTool(client, 'run_command', { session: 'lokal/mcp-opened', command: 'Hallo' });
    assert.strictEqual(rc.ran, 'echo saved-cmd-ok');
    const hostsList = await callTool(client, 'list_hosts');
    assert.ok(Array.isArray(hostsList));
    if (SSH) {
      const free = await callTool(client, 'find_free_host', {});
      assert.strictEqual(free.name, 'devbox');
      const d = await callTool(client, 'create_directory', { host: 'devbox', path: 'neu/projekt' });
      assert.match(d.absolute, new RegExp(`atm-e2e-${RUN}/neu/projekt$`));
      await assert.rejects(callTool(client, 'create_directory', { host: 'devbox', path: '../x' }));
      const cp = await callTool(client, 'create_project', { name: 'mcp-proj', host: 'devbox', directory: `~/atm-e2e-${RUN}/neu/projekt`, start_command: 'echo started-by-mcp' });
      assert.strictEqual(cp.project.name, 'mcp-proj');
      await waitFor(async () => { const o = await callTool(client, 'read_output', { session: 'mcp-proj/shell', lines: 40 }); return o.output.includes('started-by-mcp') && o.output.includes('neu/projekt'); }, { msg: 'mcp project session ran start command', timeout: 25000 }).catch(async (e) => { throw e; });
    }
  });

  await step('P7 permissions: disabled action is refused; read-only token has no write tools', async () => {
    await page.evaluate(() => window.atm.call('updateSettings', { mcp: { allowRunCommand: false } }));
    client = await connect(token);
    await assert.rejects(callTool(client, 'run_command', { session: 'lokal/dev', command: 'Hallo' }), /disabled/);
    const ro = await connect(roToken);
    const tools = (await ro.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes('read_output') && !tools.includes('send_to_session'));
    await ro.close();
  });

  await step('P7 only shared sessions; orchestrator sessions are never targets', async () => {
    const devId = await m.find('p-local', 'dev');
    await app.evaluate((_e, id) => globalThis.__atm.sessions.setFlags(id, { shared: false }), devId);
    await assert.rejects(callTool(client, 'send_to_session', { session: 'lokal/dev', text: 'x' }), /not shared/);
    await app.evaluate((_e, id) => globalThis.__atm.sessions.setFlags(id, { shared: true, orchestrator: true }), devId);
    const list = await callTool(client, 'list_sessions');
    assert.ok(!list.some((s) => s.name === 'dev'));
    await app.evaluate((_e, id) => globalThis.__atm.sessions.setFlags(id, { orchestrator: false }), devId);
  });

  await step('P7 token revoke / renew', async () => {
    const t = await page.evaluate(() => window.atm.call('createToken', { name: 'tmp' }));
    const c = await connect(t.secret);
    await c.close();
    await page.evaluate((id) => window.atm.call('revokeToken', id), t.id);
    await assert.rejects(connect(t.secret));
    const renewed = await page.evaluate((id) => window.atm.call('renewToken', id), t.id);
    const c2 = await connect(renewed.secret);
    await c2.close();
  });

  await step('P7 orchestration flow via MCP: task to developer, wait, review request to reviewer, read result', async () => {
    // Simulated agents: the "developer" changes a file in a git repo, the "reviewer" runs git diff.
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'alt\n');
    spawnSync('git', ['add', '.'], { cwd: repo });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: repo });
    const cd = IS_WIN ? `Set-Location '${repo}'` : `cd '${repo}'`;
    await callTool(client, 'send_to_session', { session: 'lokal/dev', text: cd });
    await callTool(client, 'send_to_session', { session: 'lokal/reviewer', text: cd });
    await sleep(1000);
    await callTool(client, 'send_to_session', { session: 'lokal/dev', text: IS_WIN ? 'Set-Content a.txt "neu-von-dev"; "DEV-DONE"' : 'echo neu-von-dev > a.txt; echo DEV-DONE' });
    const w1 = await callTool(client, 'wait_until_idle', { session: 'lokal/dev', timeout_sec: 30 });
    assert.match(w1.output, /DEV-DONE/);
    await callTool(client, 'send_to_session', { session: 'lokal/reviewer', text: 'git --no-pager diff' });
    const w2 = await callTool(client, 'wait_until_idle', { session: 'lokal/reviewer', timeout_sec: 30 });
    assert.strictEqual(w2.status, 'waiting');
    const r = await callTool(client, 'read_output', { session: 'lokal/reviewer', lines: 30 });
    assert.match(r.output, /\+neu-von-dev/);
    assert.match(r.output, /-alt/);
  });

  await step('P7 stdio bridge (for stdio-only MCP clients) forwards to the HTTP server', async () => {
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
    const c = new Client({ name: 'e2e-stdio', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, '..', 'dist', 'atm-mcp-stdio.js'), mcpUrl], env: { ...process.env, ATM_MCP_TOKEN: token } }));
    const list = await callTool(c, 'list_sessions');
    assert.ok(list.some((s) => s.name === 'dev'));
    await c.close();
  });

  await step('P7 MCP server can be switched off and on', async () => {
    await page.evaluate(() => window.atm.call('updateSettings', { mcp: { enabled: false } }));
    await assert.rejects(fetch(mcpUrl, { method: 'POST' }));
    await page.evaluate(() => window.atm.call('updateSettings', { mcp: { enabled: true } }));
    await waitFor(async () => (await fetch(mcpUrl, { method: 'POST' })).status === 401, { msg: 'server back' });
    client = await connect(token);
  });

  await step('P7 all MCP actions are logged and visible in the app', async () => {
    await page.click('#sidebar button:has-text("Audit log")');
    await page.waitForSelector('#audit-body tr');
    const txt = await page.textContent('#audit-body');
    for (const a of ['send_to_session', 'wait_until_idle', 'read_output', 'auth.denied', 'token.revoke']) assert.ok(txt.includes(a), 'audit contains ' + a);
    assert.ok(fs.readFileSync(path.join(dir, 'audit.log'), 'utf8').includes('send_to_session'));
    await shot('p7-audit');
  });

  // ---------------- OpenCode agent session + Phase 8 ----------------
  await step('Agent session (OpenCode): structured prompt / answer / status via API', async () => {
    const info = await m.open('p-local', { kind: 'agent', name: 'oc' });
    ids.agent = info.id;
    await waitFor(async () => (await m.status(ids.agent)) === 'waiting', { msg: 'agent ready', timeout: 60000 });
    await page.click('#sidebar .proj-name:text("lokal")');
    await page.click('#sidebar .sess:has-text("oc")');
    await page.fill('.chat-input textarea', 'Reply with exactly the word PONG and nothing else. Do not use tools.');
    await page.keyboard.press('Enter');
    await waitFor(async () => (await m.status(ids.agent)) === 'working', { msg: 'agent working', timeout: 20000 });
    await waitFor(async () => (await m.status(ids.agent)) === 'waiting', { msg: 'agent done', timeout: 180000 });
    const out = await callTool(client, 'read_output', { session: 'lokal/oc' });
    assert.ok(out.messages.some((x) => x.role === 'assistant' && /PONG/i.test(x.text)), 'assistant answered PONG: ' + JSON.stringify(out.messages).slice(0, 500));
    await page.waitForSelector('.chat-log .msg.assistant');
    await shot('agent-session');
  }, { skip: OPENCODE ? null : 'ATM_E2E_OPENCODE not set' });

  await step('P8 orchestrator: start, MCP tools, conflict check, events, pause/stop, max rounds', async () => {
    const devKey = 'p-local/dev';
    const revKey = 'p-local/reviewer';
    const o1 = await page.evaluate((w) => window.atm.call('orchSave', { name: 'O1', watched: w, maxRounds: 2, systemPrompt: 'You are a test orchestrator. Follow user instructions exactly. Use the atm MCP tools. Keep answers very short.' }), [devKey, revKey]);
    await assert.rejects(page.evaluate((w) => window.atm.call('orchSave', { name: 'O2', watched: w }), [devKey]), /already controlled/);
    const o2 = await page.evaluate(() => window.atm.call('orchSave', { name: 'O2', watched: [] }));
    await page.click('#sidebar button:has-text("Orchestrators")');
    await page.click('#main .main-head button:has-text("O1")');
    await page.click('button:has-text("▶ Start")');
    await waitFor(async () => (await page.evaluate((id) => window.__atm.S.orchestrators.find((o) => o.id === id).state, o1.id)) === 'idle', { msg: 'orchestrator idle', timeout: 60000 });
    // Task via UI input: orchestrator must use send_to_session + wait_until_idle + read_output.
    await page.fill('#orch-content textarea', `Use the atm tool send_to_session to send the text "echo ORCH_${RUN}" to session "lokal/dev". Then call wait_until_idle for "lokal/dev" and read_output. Finally answer with the word DONE.`);
    await page.keyboard.press('Enter');
    await waitFor(async () => (await m.output(ids.dev, 80)).includes(`ORCH_${RUN}`), { msg: 'orchestrator sent command to dev', timeout: 180000 });
    await waitFor(async () => {
      const msgs = await page.evaluate((id) => window.atm.call('orchMessages', id), o1.id);
      return msgs.some((x) => x.role === 'assistant' && /DONE/i.test(x.text));
    }, { msg: 'orchestrator answered', timeout: 240000 });
    await shot('p8-orchestrator');
    // Event-driven: a watched session becomes idle -> message to orchestrator.
    await waitFor(async () => (await page.evaluate((id) => window.__atm.S.orchestrators.find((o) => o.id === id).busy, o1.id)) === false, { msg: 'orch not busy', timeout: 120000 });
    await m.send(ids.dev, 'echo event-trigger');
    await waitFor(async () => {
      const msgs = await page.evaluate((id) => window.atm.call('orchMessages', id), o1.id);
      return msgs.some((x) => x.role === 'user' && x.text.startsWith('[ATM event]') && x.text.includes('event-trigger'));
    }, { msg: 'event delivered to orchestrator', timeout: 60000 });
    // Max rounds: further events beyond maxRounds pause the orchestrator.
    for (let i = 0; i < 3; i++) {
      await waitFor(async () => (await page.evaluate((id) => window.__atm.S.orchestrators.find((o) => o.id === id), o1.id)).busy === false || (await page.evaluate((id) => window.__atm.S.orchestrators.find((o) => o.id === id).state, o1.id)) === 'paused', { msg: 'idle between events', timeout: 120000 });
      await m.send(ids.dev, 'echo round-' + i);
      await sleep(3500);
    }
    await waitFor(async () => (await page.evaluate((id) => window.__atm.S.orchestrators.find((o) => o.id === id).state, o1.id)) === 'paused', { msg: 'paused by max rounds', timeout: 120000 });
    await page.click('button:has-text("■ Stop")');
    await waitFor(async () => (await page.evaluate((id) => window.__atm.S.orchestrators.find((o) => o.id === id).state, o1.id)) === 'stopped', { msg: 'stopped' });
    const audit = await page.evaluate(() => window.atm.call('auditList'));
    assert.ok(audit.some((e) => e.source === 'orchestrator' && e.action === 'send_to_session'), 'orchestrator MCP calls logged');
    await page.evaluate((id) => window.atm.call('orchRemove', id), o2.id);
  }, { skip: OPENCODE ? null : 'ATM_E2E_OPENCODE not set' });

  // ---------------- Coding agents: install menu, MCP library, skills, deploy ----------------
  const agentWork = path.join(dir, 'agent-proj');
  await step('Agents: MCP library keeps secrets encrypted; skills repository is scanned', async () => {
    ids.mcpGh = await page.evaluate(() => window.atm.call('librarySave', { name: 'GitHub Tools', type: 'stdio', command: 'npx', args: ['-y', '@mcp/gh'], env: { GH_TOKEN: 'secret-123' } }));
    ids.mcpDocs = await page.evaluate(() => window.atm.call('librarySave', { name: 'docs', type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer hdr-456' } }));
    await waitFor(() => { const raw = fs.readFileSync(path.join(dir, 'config.json'), 'utf8'); return raw.includes('GitHub Tools') && !raw.includes('secret-123') && !raw.includes('hdr-456'); }, { msg: 'library saved without clear-text secrets' });
    const back = await page.evaluate((id) => window.atm.call('libraryGet', id), ids.mcpGh);
    assert.strictEqual(back.env.GH_TOKEN, 'secret-123');
    const skillDir = path.join(dir, 'skills', 'e2e-skill');
    fs.mkdirSync(path.join(skillDir, 'ref'), { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: e2e-skill\ndescription: Test skill\n---\n# Test\n');
    fs.writeFileSync(path.join(skillDir, 'ref', 'notes.md'), 'notes');
    const { skills } = await page.evaluate(() => window.atm.call('skillsList'));
    assert.deepStrictEqual(skills.map((s) => [s.name, s.description, s.files.length]), [['e2e-skill', 'Test skill', 2]]);
    await page.click('#sidebar button:has-text("Library")');
    await page.waitForSelector('#library-page td:has-text("e2e-skill")');
    await shot('agents-library');
  });

  await step('Agents: detect, deploy and update on a local project (PowerShell on Windows)', async () => {
    fs.mkdirSync(agentWork, { recursive: true });
    fs.writeFileSync(path.join(agentWork, '.mcp.json'), JSON.stringify({ mcpServers: { own: { command: 'mine' } } }));
    await app.evaluate((_e, a) => globalThis.__atm.store.saveProject({ id: 'p-agents', name: 'agents', type: 'local', tmux: false, directory: a.dir, agentSetup: { scope: 'project', agents: 'auto', mcp: [a.gh, a.docs], skills: ['e2e-skill'] } }), { dir: agentWork, gh: ids.mcpGh, docs: ids.mcpDocs });
    await page.click('#sidebar .proj-name:text("agents")');
    await page.click('#main .main-head button:has-text("Agents ▾")');
    await page.click('.menu div:has-text("Detect installed agents")');
    await page.waitForSelector('.modal td:has-text("Claude Code")', { timeout: 60000 });
    await shot('agents-detect');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.click('#main .main-head button:has-text("Agents ▾")');
    await page.click('.menu div:has-text("Deploy MCP & skills")');
    await page.waitForSelector('.modal .modal-head:text-matches("Deployed")', { timeout: 120000 });
    await shot('agents-deploy');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const manifest = JSON.parse(fs.readFileSync(path.join(agentWork, '.agent-terminal-manager', 'deployed.json'), 'utf8'));
    const detected = await page.evaluate(() => window.atm.call('agentsDetect', 'p-agents'));
    const installed = detected.filter((a) => a.installed).map((a) => a.id);
    for (const id of installed) assert.ok(manifest[id], 'manifest has ' + id);
    if (installed.includes('claude')) {
      const mcp = JSON.parse(fs.readFileSync(path.join(agentWork, '.mcp.json'), 'utf8')).mcpServers;
      assert.deepStrictEqual(mcp.own, { command: 'mine' }, 'user server kept');
      assert.deepStrictEqual(mcp['github-tools'], { type: 'stdio', command: 'npx', args: ['-y', '@mcp/gh'], env: { GH_TOKEN: 'secret-123' } });
      assert.deepStrictEqual(mcp.docs, { type: 'http', url: 'https://docs.example/mcp', headers: { Authorization: 'Bearer hdr-456' } });
      assert.strictEqual(fs.readFileSync(path.join(agentWork, '.claude', 'skills', 'e2e-skill', 'ref', 'notes.md'), 'utf8'), 'notes');
    }
    if (installed.includes('codex')) assert.ok(fs.existsSync(path.join(agentWork, '.agents', 'skills', 'e2e-skill', 'SKILL.md')), 'codex skills');
    if (installed.includes('agy')) assert.ok(JSON.parse(fs.readFileSync(path.join(agentWork, '.agents', 'mcp_config.json'), 'utf8')).mcpServers.docs.serverUrl);
    // Update: deselect one server and the skill; they are removed, the user's own server stays.
    await app.evaluate((_e, a) => { const p = globalThis.__atm.store.getProject('p-agents'); p.agentSetup = { ...p.agentSetup, mcp: [a.docs], skills: [] }; }, { docs: ids.mcpDocs });
    const rep = await page.evaluate(() => window.atm.call('agentsDeploy', 'p-agents'));
    assert.ok(rep.ok, JSON.stringify(rep.errors));
    if (installed.includes('claude')) {
      const mcp = JSON.parse(fs.readFileSync(path.join(agentWork, '.mcp.json'), 'utf8')).mcpServers;
      assert.deepStrictEqual(Object.keys(mcp).sort(), ['docs', 'own']);
      assert.ok(!fs.existsSync(path.join(agentWork, '.claude', 'skills', 'e2e-skill')), 'skill removed on update');
      assert.deepStrictEqual(rep.agents.find((a) => a.id === 'claude').mcp.removed, ['github-tools']);
    }
  });

  await step('Agents: install command is typed into the terminal for the right shell', async () => {
    const r = await page.evaluate(() => window.atm.call('agentsList'));
    assert.ok(r.find((a) => a.id === 'claude').install.powershell.includes('install.ps1'));
    const cmd = await app.evaluate(() => {
      const s = globalThis.__atm.agentSetup();
      return [s.installCommand(globalThis.__atm.store.getProject('p-agents'), 'claude'), s.installCommand({ type: 'ssh', host: 'x' }, 'claude')];
    });
    assert.strictEqual(cmd[0].kind, IS_WIN ? 'powershell' : 'posix');
    assert.strictEqual(cmd[1].command, 'curl -fsSL https://claude.ai/install.sh | bash');
  });

  await step('Agents: deploy over a POSIX shell (WSL)', async () => {
    const wdir = `/tmp/atm-agents-${RUN}`;
    await app.evaluate((_e, a) => globalThis.__atm.store.saveProject({ id: 'p-agents-wsl', name: 'agents-wsl', type: 'wsl', wslDistro: a.distro, tmux: false, directory: a.wdir, agentSetup: { scope: 'project', agents: 'auto', mcp: [a.docs], skills: ['e2e-skill'] } }), { distro: WSL, wdir, docs: ids.mcpDocs });
    spawnSync('wsl.exe', ['-d', WSL, '--', 'mkdir', '-p', wdir]);
    const rep = await page.evaluate(() => window.atm.call('agentsDeploy', 'p-agents-wsl'));
    assert.ok(rep.ok, JSON.stringify(rep.errors));
    assert.strictEqual(rep.target, 'posix');
    const m = spawnSync('wsl.exe', ['-d', WSL, '--', 'cat', `${wdir}/.agent-terminal-manager/deployed.json`], { encoding: 'utf8' }).stdout;
    assert.ok(JSON.parse(m)._updated, 'manifest written via POSIX shell');
    spawnSync('wsl.exe', ['-d', WSL, '--', 'rm', '-rf', wdir]);
  }, { skip: WSL ? null : 'ATM_E2E_WSL not set' });

  // ---------------- Phase 2/6: persistence after restart ----------------
  await step('P2/P6 configuration and open sessions/layout survive restart (tmux re-attach)', async () => {
    await page.click('#sidebar .proj-name:text("lokal")');
    await page.click('#main .main-head button:has-text("Tiles")');
    await sleep(500);
    const before = (await m.sessions()).map((s) => `${s.projectId}/${s.name}`).sort();
    await app.close();
    ({ app, page, errors } = await launch({ dataDir: dir }));
    m = M(app);
    await page.waitForSelector('#sidebar .proj-name:text("lokal")');
    const after = await waitFor(async () => { const l = (await m.sessions()).map((s) => `${s.projectId}/${s.name}`).sort(); return l.length >= before.length ? l : null; }, { msg: 'sessions restored', timeout: 20000 });
    assert.deepStrictEqual(after, before);
    const layout = await app.evaluate(() => globalThis.__atm.store.getProject('p-local').layout.mode);
    assert.strictEqual(layout, 'tiles');
    if (SSH) {
      const sid = await m.find('p-ssh', 'shell');
      await waitFor(async () => /tick-\d+/.test(await m.output(sid, 100)), { msg: 'tmux re-attached with running loop', timeout: 25000 });
    }
    await shot('restart');
  });

  await step('General: keyboard shortcuts for new session, project switch, tiles, overview', async () => {
    await page.click('#sidebar .proj-name:text("lokal")');
    const n = (await m.sessions()).filter((s) => s.projectId === 'p-local').length;
    await page.keyboard.press('ControlOrMeta+Shift+KeyT');
    await waitFor(async () => (await m.sessions()).filter((s) => s.projectId === 'p-local').length === n + 1, { msg: 'Ctrl+Shift+T opened session' });
    await page.keyboard.press('ControlOrMeta+Shift+KeyO');
    await page.waitForSelector('.ov-group');
    await page.keyboard.press('ControlOrMeta+Digit1');
    await page.waitForSelector('#main .main-head .title:text("lokal")');
    const before = await app.evaluate(() => globalThis.__atm.store.getProject('p-local').layout.mode);
    await page.keyboard.press('ControlOrMeta+Shift+KeyG');
    await waitFor(async () => (await app.evaluate(() => globalThis.__atm.store.getProject('p-local').layout.mode)) !== before, { msg: 'Ctrl+Shift+G toggled tiles' });
  });

  await step('General: stable with 5 projects and 15 concurrent sessions', async () => {
    for (let i = 1; i <= 4; i++) await app.evaluate((_e, i) => globalThis.__atm.store.saveProject({ id: 'p-load' + i, name: 'last' + i, type: 'local', tmux: false, thresholdSec: 2 }), i);
    const target = 15;
    const pids = ['p-local', 'p-load1', 'p-load2', 'p-load3', 'p-load4'];
    const count = async () => (await m.sessions()).filter((s) => s.kind === 'terminal' && pids.includes(s.projectId)).length;
    let k = 0;
    while ((await count()) < target) await m.open(pids[k++ % pids.length], { name: 'load' });
    const terminals = (await m.sessions()).filter((s) => s.kind === 'terminal' && pids.includes(s.projectId));
    assert.ok(terminals.length >= 15, 'sessions: ' + terminals.length);
    await sleep(4000);
    await Promise.all(terminals.map((s) => m.send(s.id, 'echo alive-' + s.id.slice(0, 6))));
    await waitFor(async () => {
      const outs = await Promise.all(terminals.map((s) => m.output(s.id, 30)));
      return outs.every((o, i) => o.includes('alive-' + terminals[i].id.slice(0, 6)));
    }, { msg: 'all 15 sessions respond', timeout: 30000 });
    await page.keyboard.press('ControlOrMeta+Shift+KeyO');
    await page.waitForSelector('.ov-group >> nth=4');
    const tiles = await page.$$eval('.ov-group .tile', (t) => t.length);
    assert.ok(tiles >= 15, 'overview tiles ' + tiles);
    await shot('general-15-sessions');
    const mem = await app.evaluate(() => process.memoryUsage().rss);
    console.log(`   main RSS ${(mem / 1e6).toFixed(0)} MB with ${tiles} sessions`);
  });

  await step('General: no renderer errors', async () => {
    assert.deepStrictEqual(errors.filter((e) => !/Autofill|DevTools/.test(e)), []);
  });

  // cleanup
  try {
    await app.evaluate(() => { for (const s of globalThis.__atm.sessions.list()) globalThis.__atm.sessions.close(s.id, { killTmux: true }); });
    await sleep(1500);
    await app.close();
  } catch {}
  if (SSH) sshRun(`tmux ls 2>/dev/null | grep -o '^atm-[^:]*' | xargs -r -n1 tmux kill-session -t; rm -rf ~/atm-e2e-${RUN}`);

  const failed = results.filter((r) => r.status === 'fail');
  const passed = results.filter((r) => r.status === 'pass');
  console.log(`\n${passed.length} passed, ${failed.length} failed, ${results.length - passed.length - failed.length} skipped`);
  fs.writeFileSync(path.join(SHOTS, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
