#!/usr/bin/env node
'use strict';
// Demo ACP agent for the README screenshots: answers with tool calls, Markdown and token usage.
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'demo', update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANSWER = `I reviewed the checkout flow. Two things need attention:

### Findings

1. **Race condition** in \`cart/submit.ts\`: the stock check and the order insert run in separate transactions, so two buyers can get the last item.
2. **Missing retry** for the payment webhook — a single timeout leaves the order in \`pending\`.

### Suggested fix

\`\`\`ts
await db.transaction(async (tx) => {
  const item = await tx.stock.lockForUpdate(sku);
  if (item.count < qty) throw new OutOfStock(sku);
  await tx.orders.insert(order);
});
\`\`\`

Shall I implement both changes and add tests for them?`;

async function handle({ id, method }) {
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
  if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 'demo', configOptions: [
      { id: 'model', category: 'model', type: 'select', currentValue: 'anthropic/claude-sonnet', options: [{ value: 'anthropic/claude-sonnet', name: 'Claude Sonnet' }, { value: 'anthropic/claude-opus', name: 'Claude Opus' }] },
      { id: 'mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
    ] } });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review the current changes' }, { name: 'test', description: 'Run the test suite' }] });
    return;
  }
  if (method === 'session/prompt') {
    const tools = [['t1', 'Read src/cart/submit.ts', 'read'], ['t2', 'Search "createOrder"', 'search'], ['t3', 'Read src/payments/webhook.ts', 'read']];
    for (const [tid, title, kind] of tools) {
      update({ sessionUpdate: 'tool_call', toolCallId: tid, title, kind, status: 'in_progress' });
      await sleep(80);
      update({ sessionUpdate: 'tool_call_update', toolCallId: tid, status: 'completed' });
    }
    for (const part of ANSWER.match(/[\s\S]{1,40}/g)) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: part } }); await sleep(10); }
    update({ sessionUpdate: 'usage_update', used: 18400, size: 200000 });
    return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', usage: { inputTokens: 16900, outputTokens: 1500, totalTokens: 18400 } } });
  }
  if (method === 'session/set_config_option') return send({ jsonrpc: '2.0', id, result: {} });
  if (id !== undefined && method) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'not supported in the demo' } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, n).trim();
    buf = buf.slice(n + 1);
    if (line) handle(JSON.parse(line));
  }
});
