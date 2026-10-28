'use strict';
// Smoke test for the packaged app: starts the built executable with an empty profile,
// opens a local terminal (native node-pty from app.asar.unpacked) and checks the MCP endpoint.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const exe = process.argv[2] || (process.platform === 'win32'
  ? path.join(__dirname, '..', 'release', 'win-unpacked', 'Agent Terminal Manager.exe')
  : path.join(__dirname, '..', 'release', 'mac', 'Agent Terminal Manager.app', 'Contents', 'MacOS', 'Agent Terminal Manager'));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atm-pkg-'));
  const port = 47950;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ settings: { mcp: { port } }, projects: [{ id: 'p', name: 'pkg', type: 'local', tmux: false }] }));
  const app = await electron.launch({ executablePath: exe, env: { ...process.env, ATM_USER_DATA: dir }, timeout: 60000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__atm && window.__atm.S);
  await page.click('text=+ Session öffnen');
  const marker = 'pkg-ok-' + Date.now();
  await page.waitForTimeout(2500);
  await page.keyboard.type('echo ' + marker);
  await page.keyboard.press('Enter');
  const ok = await (async () => {
    for (let i = 0; i < 50; i++) {
      const out = await app.evaluate(() => globalThis.__atm.sessions.list().map((s) => s.readOutput({ lines: 20 }).text).join('\n'));
      if (out.split('\n').some((l) => l.trim().endsWith(marker) && !l.includes('echo'))) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
  const bridge = await page.evaluate(() => window.__atm.S.stdioBridge);
  console.log(JSON.stringify({ terminal: ok, mcpStatus: r.status, bridgeExists: fs.existsSync(bridge), bridge }));
  await app.close();
  process.exit(ok && r.status === 401 && fs.existsSync(bridge) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
