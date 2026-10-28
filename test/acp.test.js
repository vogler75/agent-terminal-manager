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

test('splitCommand keeps quoted parts together', () => {
  const { splitCommand } = require('../src/main/acp');
  assert.deepStrictEqual(splitCommand('my-agent --acp'), ['my-agent', '--acp']);
  assert.deepStrictEqual(splitCommand('"C:\\Program Files\\x\\agent.exe" acp --name \'a b\''), ['C:\\Program Files\\x\\agent.exe', 'acp', '--name', 'a b']);
});

test('custom ACP agent: command line from the project, no login command', async () => {
  const mgr = harness();
  const script = path.join(__dirname, 'fixtures', 'fake-acp-agent.js');
  mgr.store.getProject().acpCommands = { custom: `"${process.execPath}" "${script}"` };
  const s = new AcpSession(mgr, mgr.store.getProject(), { acpAgent: 'custom', name: 'custom' });
  try {
    assert.strictEqual(s.agentDef.name, 'node');
    await until(() => s.status === 'waiting');
    await s.send('hi');
    await until(() => s.lastAssistantText() === 'Hello from fake/small');
    assert.throws(() => s.loginCommand(), /No login command/);
  } finally {
    s.close();
    delete ACP_AGENTS.fake;
  }
});

test('ACP session: approval policy answers permission requests; token usage is summed up', async () => {
  const mgr = harness();
  const s = new AcpSession(mgr, mgr.store.getProject(), { acpAgent: 'fake', name: 'fake', approval: 'reads' });
  try {
    await until(() => s.status === 'waiting');
    await s.send('hi');
    await until(() => s.status === 'waiting' && s.usage && s.usage.turns === 1);
    await s.send('hi again');
    await until(() => s.usage.turns === 2);
    assert.deepStrictEqual({ used: s.usage.used, size: s.usage.size, total: s.usage.totalTokens, input: s.usage.inputTokens }, { used: 1200, size: 100000, total: 2400, input: 2000 });
    assert.strictEqual(s.info().usage.cost.amount, 0.01);
    // "reads": a read tool is approved automatically ...
    await s.send('use a tool to read');
    await until(() => s.messages.some((m) => m.role === 'system' && m.text.startsWith('Auto-approved (read-only): Read file')));
    await until(() => s.status === 'waiting' && !s.permission);
    // ... an edit tool still asks
    await s.send('use a tool to write');
    await until(() => s.permission);
    assert.strictEqual(s.permission.kind, 'edit');
    // switching to "all" answers the pending request
    s.setApproval('all');
    await until(() => !s.permission && s.status === 'waiting');
    assert.strictEqual(s.persistExtra().approval, 'all');
    assert.ok(s.messages.some((m) => (m.tools || []).some((t) => t.result === 'written')));
  } finally {
    s.close();
    delete ACP_AGENTS.fake;
  }
});

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
