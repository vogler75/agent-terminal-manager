'use strict';
// Shared helper: launch the app with an isolated data directory via Playwright's Electron support.
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

async function launch({ config, env = {}, dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'atm-e2e-'));
  if (config) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, ATM_USER_DATA: dir, ...env },
    timeout: 60000,
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.waitForFunction(() => window.__atm && window.__atm.S, null, { timeout: 30000 });
  return { app, page, dir, errors };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { launch, sleep };
