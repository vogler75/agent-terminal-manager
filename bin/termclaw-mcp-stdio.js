#!/usr/bin/env node
'use strict';
// stdio <-> Streamable HTTP bridge for MCP clients that only speak stdio (e.g. Claude Desktop, Claude Code).
// Usage: TERMCLAW_MCP_TOKEN=termclaw_... node termclaw-mcp-stdio.js [url]   (default url http://127.0.0.1:47900/mcp)
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const url = process.argv[2] || process.env.TERMCLAW_MCP_URL || 'http://127.0.0.1:47900/mcp';
const token = process.env.TERMCLAW_MCP_TOKEN;
if (!token) {
  process.stderr.write('TERMCLAW_MCP_TOKEN is not set. Create a token in TermClaw → MCP.\n');
  process.exit(1);
}

const stdio = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });

stdio.onmessage = (msg) => remote.send(msg).catch((e) => {
  if (msg.id !== undefined) stdio.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Bridge: ' + e.message } });
});
remote.onmessage = (msg) => stdio.send(msg);
remote.onerror = (e) => process.stderr.write('remote error: ' + e.message + '\n');
stdio.onclose = () => { remote.close().finally(() => process.exit(0)); };
remote.onclose = () => process.exit(0);

(async () => {
  await remote.start();
  await stdio.start();
})();
