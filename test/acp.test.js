'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { AcpSession, ACP_AGENTS } = require('../src/main/acp');

// AcpSession against the fake agent, with a minimal session manager.
function harness() {
  ACP_AGENTS.fake = { name: 'Fake', bin: process.execPath, args: [path.join(__dirname, 'fixtures', 'fake-acp-agent.js')], login: ['login'] };
  const project = { id: 'p', name: 'p', type: 'local', directory: os.tmpdir(), acpCommands: { fake: process.execPath } };
  const mgr = new EventEmitter();
  mgr.store = { getProject: () => project, getHost: () => null, settings: { defaultThresholdSec: 5 } };
  mgr.persistOpen = () => {};
  return mgr;
}

const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error('timeout');
};

test('ACP session: start, streamed answer, models, commands, permission, close', async () => {
  const mgr = harness();
  const s = new AcpSession(mgr, mgr.store.getProject(), { acpAgent: 'fake', name: 'fake' });
  try {
    await until(() => s.status === 'waiting');
    assert.strictEqual(s.acpSessionId, 's1');

    await s.send('hi');
    assert.strictEqual(s.status, 'working');
    await until(() => s.status === 'waiting' && s.lastAssistantText());
    assert.strictEqual(s.lastAssistantText(), 'Hello from fake/small');

    const { models, current } = await s.listModels();
    assert.deepStrictEqual(models.map((m) => m.value), ['fake/small', 'fake/large']);
    assert.strictEqual(current.id, 'small');
    await s.changeModel('fake', 'large');
    await s.send('again');
    await until(() => s.lastAssistantText() === 'Hello from fake/large');

    const cmds = await s.slashCommands();
    assert.deepStrictEqual(cmds.commands.map((c) => c.name), ['review']);
    assert.deepStrictEqual(await s.runSlash('/model'), { handled: 'ui', name: 'model' });

    // Tool call -> permission request -> waiting until answered.
    await s.send('use a tool');
    await until(() => s.permission);
    assert.strictEqual(s.status, 'waiting');
    assert.deepStrictEqual(s.permissionInfo().options.map((o) => o.id), ['ok', 'no']);
    s.answerPermission('ok');
    await until(() => s.status === 'waiting' && !s.permission);
    await until(() => s.messages.some((m) => (m.tools || []).some((t) => t.status === 'completed' && t.result === 'written')));

    const out = s.readOutput({ lines: 20 });
    assert.match(out.text, /\[user\] use a tool/);
    assert.match(out.text, /tool Write file: completed/);
  } finally {
    s.close();
    delete ACP_AGENTS.fake;
  }
});
