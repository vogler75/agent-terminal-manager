'use strict';
// Smoke test for the packaged app: starts the built executable with an empty profile,
// opens a local terminal (native node-pty from app.asar.unpacked) and checks the MCP endpoint.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

function findExe() {
  const rel = path.join(__dirname, '..', 'release');
  if (process.platform === 'win32') return path.join(rel, 'win-unpacked', 'TermClaw.exe');
  // electron-builder names the folder mac, mac-x64 or mac-arm64 depending on the architecture.
  const dir = fs.readdirSync(rel).find((d) => /^mac/.test(d) && fs.existsSync(path.join(rel, d, 'TermClaw.app')));
  return path.join(rel, dir || 'mac', 'TermClaw.app', 'Contents', 'MacOS', 'TermClaw');
}
const exe = process.argv[2] || findExe();

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termclaw-pkg-'));
  const port = 47950;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ settings: { mcp: { port } }, projects: [{ id: 'p', name: 'pkg', type: 'local', tmux: false }] }));
  const app = await electron.launch({ executablePath: exe, env: { ...process.env, TERMCLAW_USER_DATA: dir }, timeout: 60000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.__termclaw && window.__termclaw.S);
  await page.click('text=+ Open session');
  const marker = 'pkg-ok-' + Date.now();
  await page.waitForTimeout(2500);
  await page.keyboard.type('echo ' + marker);
  await page.keyboard.press('Enter');
  const ok = await (async () => {
    for (let i = 0; i < 50; i++) {
      const out = await app.evaluate(() => globalThis.__termclaw.sessions.list().map((s) => s.readOutput({ lines: 20 }).text).join('\n'));
      if (out.split('\n').some((l) => l.trim().endsWith(marker) && !l.includes('echo'))) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })();
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
  const bridge = await page.evaluate(() => window.__termclaw.S.stdioBridge);
  console.log(JSON.stringify({ terminal: ok, mcpStatus: r.status, bridgeExists: fs.existsSync(bridge), bridge }));
  await app.close();
  process.exit(ok && r.status === 401 && fs.existsSync(bridge) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
