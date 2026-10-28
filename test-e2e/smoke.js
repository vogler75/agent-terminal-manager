'use strict';
// Quick manual smoke run: one local project, open a session, type a command, screenshot.
const path = require('path');
const { launch, sleep } = require('./launch');

(async () => {
  const shots = process.argv[2] || path.join(__dirname, 'shots');
  require('fs').mkdirSync(shots, { recursive: true });
  const { app, page, errors } = await launch({
    config: { projects: [{ id: 'p1', name: 'demo', type: 'local', tmux: false, directory: '' }] },
  });
  await page.setViewportSize({ width: 1300, height: 800 }).catch(() => {});
  await page.screenshot({ path: path.join(shots, '1-start.png') });
  await page.click('text=+ Session öffnen');
  await sleep(2500);
  await page.keyboard.type('echo hello-from-atm');
  await page.keyboard.press('Enter');
  await sleep(1500);
  await page.screenshot({ path: path.join(shots, '2-session.png') });
  const out = await app.evaluate(async ({ BrowserWindow }) => 'ok');
  console.log('errors:', errors);
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
