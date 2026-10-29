'use strict';
// Takes the README screenshots (docs/screenshots/*.png) from the real app with a demo configuration.
//   npm run build:renderer && node scripts/screenshots/take.js
// Windows: the terminals run PowerShell in this repository.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('../../test-e2e/launch');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const AGENT = `node ${path.join(__dirname, 'demo-acp-agent.js').replace(/\\/g, '/')}`;
const IS_WIN = process.platform === 'win32';

const config = {
  settings: { fontSize: 13, notifications: false, mcp: { enabled: true, port: 47000 + Math.floor(Math.random() * 800), bind: '127.0.0.1', oauth: true, oauthMode: 'builtin', publicUrl: 'https://termclaw.example.com/mcp' } },
  hosts: [
    { id: 'h1', name: 'devbox-1', hostname: 'devbox-1.lan', user: 'dev', port: 22, workspace: '~/work', tags: ['linux', 'gpu'] },
    { id: 'h2', name: 'devbox-2', hostname: 'devbox-2.lan', user: 'dev', port: 22, workspace: '~/work', tags: ['linux'] },
  ],
  projects: [
    {
      id: 'p-termclaw', name: 'termclaw', type: 'local', directory: ROOT, tmux: false, thresholdSec: 3,
      terminals: [{ name: 'tests', command: '' }, { name: 'git', command: '' }],
      commands: [{ name: 'Unit tests', command: 'npm test' }, { name: 'Git status', command: 'git status -sb' }, { name: 'Build', command: '.\\build.bat dir' }],
      acpCommands: { custom: AGENT },
      agentSetup: { scope: 'project', agents: 'auto', mcp: ['m-gh', 'm-pw'], skills: [], apm: ['a1'] },
    },
    { id: 'p-shop', name: 'web-shop', type: 'ssh', hostId: 'h1', directory: '~/work/web-shop', tmux: true, terminals: [], commands: [] },
    { id: 'p-api', name: 'payments-api', type: 'wsl', wslDistro: 'Ubuntu', directory: '/srv/payments', tmux: true, terminals: [], commands: [] },
  ],
  mcpLibrary: [
    { id: 'm-gh', name: 'github', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    { id: 'm-pw', name: 'playwright', type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp'] },
    { id: 'm-docs', name: 'company-docs', type: 'http', url: 'https://docs.example.com/mcp' },
  ],
  apmLibrary: [
    { id: 'a1', ref: 'microsoft/apm-sample-package#v1.0.0', description: 'Sample prompts and instructions' },
    { id: 'a2', ref: 'anthropics/skills/skills/frontend-design', description: 'Frontend design skill' },
  ],
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'termclaw-shot-skills-'));
  for (const [name, desc] of [['code-review', 'Review a change for bugs, tests and naming'], ['release-notes', 'Write release notes from the git log']]) {
    fs.mkdirSync(path.join(skills, name));
    fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`);
  }
  config.settings.skillsDir = skills;

  const { app, page } = await launch({ config });
  await page.setViewportSize({ width: 1440, height: 880 });
  const shot = async (name) => { await sleep(500); await page.screenshot({ path: path.join(OUT, name + '.png') }); console.log('saved', name); };
  const termclaw = (fn, arg) => app.evaluate(fn, arg);
  const send = (id, text) => termclaw((_e, a) => globalThis.__termclaw.sessions.get(a.id).send(a.text), { id, text });
  const open = (pid, opts) => termclaw((_e, a) => globalThis.__termclaw.sessions.open(a.pid, a.opts).info(), { pid, opts });
  const api = (name, ...a) => page.evaluate(([n, args]) => window.termclaw.call(n, ...args), [name, a]);

  try {
    // Terminals: tests and git log in this repository, plus a demo ACP agent session
    await page.click('#sidebar .proj-name:text("termclaw")');
    const tests = (await open('p-termclaw', { name: 'tests' })).id;
    const git = (await open('p-termclaw', { name: 'git' })).id;
    await sleep(2500);
    await send(git, 'git log --oneline --graph --decorate -25');
    await send(tests, IS_WIN ? 'Clear-Host; npm test' : 'clear; npm test');
    const agent = (await open('p-termclaw', { kind: 'acp', acpAgent: 'custom', name: 'reviewer' })).id;
    await sleep(2500);
    await api('agentSend', agent, 'Review the checkout flow for concurrency bugs.');
    await sleep(8000);
    await api('setSessionFlags', tests, { shared: true });

    // 1) Tabs with the test run
    await page.click(`.tab:has-text("tests")`).catch(() => {});
    await shot('terminal-tabs');

    // 2) Agent chat
    await page.click(`.tab:has-text("reviewer")`).catch(() => {});
    await shot('agent-chat');

    // 3) Tiles
    await page.getByRole('button', { name: 'Tiles', exact: true }).click();
    await shot('tiles');
    await page.getByRole('button', { name: 'Tabs', exact: true }).click();

    // 4) Overview
    await page.click('#sidebar button:has-text("Overview")');
    await shot('overview');

    // 5) File browser
    await page.click('#sidebar .proj-name:text("termclaw")');
    await page.click(`.tab:has-text("git")`).catch(() => {});
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.waitForSelector('.file-list td:has-text("src")');
    await shot('file-browser');
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // 6) Project editor
    await page.locator('#main button[title="Edit project"]').click();
    await page.waitForSelector('.modal');
    await shot('project-editor');
    await page.keyboard.press('Escape');

    // 7) MCP page with a token and an approved OAuth sign-in
    await api('createToken', { name: 'claude-code', readOnly: false });
    await api('createToken', { name: 'dashboard', readOnly: true });
    await page.click('#sidebar button:has-text("MCP")');
    await shot('mcp-server');

    // 8) OAuth approval dialog (sign-in started like claude.ai does)
    const port = config.settings.mcp.port;
    const reg = await (await fetch(`http://127.0.0.1:${port}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) })).json();
    fetch(`http://127.0.0.1:${port}/oauth/authorize?` + new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256', scope: 'mcp:read mcp:full' })).catch(() => {});
    await page.waitForSelector('.modal:has-text("MCP sign-in request")');
    await shot('oauth-approval');
    await page.locator('.modal button:has-text("Deny")').click();

    // 9) Library: MCP servers, skills, APM packages
    await page.click('#sidebar button:has-text("Library")');
    await shot('library');

    // 10) Coding agents menu of the project
    await page.click('#sidebar .proj-name:text("termclaw")');
    await page.getByRole('button', { name: 'Agents ▾' }).click();
    await shot('agents-menu');
    await page.keyboard.press('Escape');
  } finally {
    await app.close().catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
