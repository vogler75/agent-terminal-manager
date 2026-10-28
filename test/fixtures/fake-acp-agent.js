#!/usr/bin/env node
'use strict';
// Minimal fake ACP agent for tests: answers prompts, asks for permission before a "tool call".
let buf = '';
let nextId = 1000;
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const update = (sessionId, u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
let model = 'fake/small';
let cancelled = false;

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
  if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 's1', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: model, options: [{ value: 'fake/small', name: 'fake/Small' }, { value: 'fake/large', name: 'fake/Large' }] }] } });
    update('s1', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review changes' }] });
    return;
  }
  if (method === 'session/set_config_option') { model = params.value; return send({ jsonrpc: '2.0', id, result: {} }); }
  if (method === 'session/cancel') { cancelled = true; return; }
  if (method === 'session/prompt') {
    const text = params.prompt.map((p) => p.text).join('');
    cancelled = false;
    if (/tool/.test(text)) {
      const kind = /read/.test(text) ? 'read' : 'edit';
      update('s1', { sessionUpdate: 'tool_call', toolCallId: 't1', title: kind === 'read' ? 'Read file' : 'Write file', kind, status: 'pending', rawInput: { path: 'x.txt' } });
      const r = await ask('session/request_permission', { sessionId: 's1', toolCall: { toolCallId: 't1', title: kind === 'read' ? 'Read file' : 'Write file' }, options: [{ optionId: 'ok', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }] });
      const allowed = r.outcome.outcome === 'selected' && r.outcome.optionId === 'ok';
      update('s1', { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: allowed ? 'written' : 'denied' } }] });
      return send({ jsonrpc: '2.0', id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } });
    }
    for (const part of ['Hello ', 'from ', `${model}`]) update('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } });
    update('s1', { sessionUpdate: 'usage_update', used: 1200, size: 100000, cost: { amount: 0.01, currency: 'USD' } });
    return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 } } });
  }
  if (id !== undefined && method) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'nope' } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n).trim();
    buf = buf.slice(n + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (!msg.method && waiting.has(msg.id)) { waiting.get(msg.id)(msg.result); waiting.delete(msg.id); continue; }
    handle(msg);
  }
});
