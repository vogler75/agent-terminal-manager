'use strict';
// Bundles the renderer (xterm.js + UI) and the stdio MCP bridge with esbuild.
const esbuild = require('esbuild');
const path = require('path');

const root = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');

async function main() {
  const renderer = {
    entryPoints: [path.join(root, 'src/renderer/app.js')],
    bundle: true,
    outfile: path.join(root, 'dist/renderer.js'),
    format: 'iife',
    platform: 'browser',
    target: 'chrome130',
    sourcemap: true,
    loader: { '.css': 'css' },
    logLevel: 'info',
  };
  const bridge = {
    entryPoints: [path.join(root, 'bin/atm-mcp-stdio.js')],
    bundle: true,
    outfile: path.join(root, 'dist/atm-mcp-stdio.js'),
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    logLevel: 'info',
  };
  if (watch) {
    const ctx = await esbuild.context(renderer);
    await ctx.watch();
  } else {
    await esbuild.build(renderer);
    await esbuild.build(bridge);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
