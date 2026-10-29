'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { OAuthServer, validRedirect, redirectMatches } = require('../src/main/mcp-oauth');

const fakeStore = (mcp = {}) => ({ data: {}, settings: { mcp: { oauth: true, publicUrl: '', ...mcp } }, save() {} });
const audit = { add() {} };

async function serve(oauth) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await oauth.handle(req, res, url, '127.0.0.1'))) { res.writeHead(401, { 'www-authenticate': oauth.challenge(req) }); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};
const form = (o) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

test('redirect URIs: https or loopback http; loopback matches on any port', () => {
  assert.ok(validRedirect('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(validRedirect('http://localhost:3118/callback'));
  assert.ok(!validRedirect('http://evil.example.com/cb'));
  assert.ok(!validRedirect('javascript:alert(1)'));
  assert.ok(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:5555/callback'));
  assert.ok(!redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:5555/other'));
  assert.ok(!redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback2'));
});

test('OAuth flow: discovery, DCR, approval in the app, PKCE token, refresh rotation, revoke', async () => {
  const oauth = new OAuthServer({ store: fakeStore(), audit });
  const { server, base } = await serve(oauth);
  try {
    // 401 points at the protected resource metadata
    const r401 = await fetch(base + '/mcp', { method: 'POST' });
    assert.strictEqual(r401.status, 401);
    assert.match(r401.headers.get('www-authenticate'), new RegExp(`resource_metadata="${base}/.well-known/oauth-protected-resource"`));
    const prm = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
    assert.strictEqual(prm.resource, base + '/mcp');
    assert.deepStrictEqual(prm.authorization_servers, [base]);
    const asm = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    assert.deepStrictEqual(asm.code_challenge_methods_supported, ['S256']);
    assert.ok(asm.client_id_metadata_document_supported && asm.token_endpoint_auth_methods_supported.includes('none'));

    // Dynamic client registration
    const reg = await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) });
    assert.strictEqual(reg.status, 201);
    const client = await reg.json();
    const bad = await fetch(asm.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example.com/cb'] }) });
    assert.strictEqual(bad.status, 400);

    // Authorization: waits for the user in the app
    const { verifier, challenge } = pkce();
    let request;
    oauth.once('request', (r) => { request = r; });
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'mcp:read mcp:full', resource: base + '/mcp' });
    const page = await fetch(asm.authorization_endpoint + '?' + q);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Approve in TermClaw/);
    assert.strictEqual(request.clientName, 'Claude');
    assert.strictEqual(request.redirectHost, 'claude.ai');
    assert.deepStrictEqual(await (await fetch(`${base}/oauth/authorize/status?request=${request.id}`)).json(), { done: false });
    assert.ok(oauth.decide(request.id, { approve: true, readOnly: false }));
    const st = await (await fetch(`${base}/oauth/authorize/status?request=${request.id}`)).json();
    const loc = new URL(st.location);
    assert.strictEqual(loc.origin + loc.pathname, 'https://claude.ai/api/mcp/auth_callback');
    assert.strictEqual(loc.searchParams.get('state'), 'xyz');
    assert.strictEqual(loc.searchParams.get('iss'), base);
    const code = loc.searchParams.get('code');

    // Token exchange: wrong verifier fails, right one works, code is single use
    const wrong = await fetch(asm.token_endpoint, form({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: 'nope' }));
    assert.strictEqual(wrong.status, 400);
    assert.strictEqual((await wrong.json()).error, 'invalid_grant');
    // the failed attempt consumed the code: start a new one
    let req2;
    oauth.once('request', (r) => { req2 = r; });
    await fetch(asm.authorization_endpoint + '?' + q);
    oauth.decide(req2.id, { approve: true, readOnly: false });
    const code2 = new URL((await (await fetch(`${base}/oauth/authorize/status?request=${req2.id}`)).json()).location).searchParams.get('code');
    const tok = await (await fetch(asm.token_endpoint, form({ grant_type: 'authorization_code', code: code2, client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier }))).json();
    assert.strictEqual(tok.token_type, 'Bearer');
    assert.ok(tok.access_token.startsWith('atmo_') && tok.refresh_token);
    assert.deepStrictEqual((await oauth.authenticate(tok.access_token)).readOnly, false);
    assert.strictEqual((await fetch(asm.token_endpoint, form({ grant_type: 'authorization_code', code: code2, code_verifier: verifier }))).status, 400);

    // Refresh rotates: the old refresh token and the old access token stop working
    const tok2 = await (await fetch(asm.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: client.client_id }))).json();
    assert.ok(tok2.access_token && tok2.refresh_token !== tok.refresh_token);
    assert.strictEqual(await oauth.authenticate(tok.access_token), null);
    assert.ok(await oauth.authenticate(tok2.access_token));
    const reuse = await fetch(asm.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token }));
    assert.strictEqual((await reuse.json()).error, 'invalid_grant');

    // Revoke in the app
    const [g] = oauth.listGrants();
    assert.strictEqual(g.clientName, 'Claude');
    assert.ok(!('refreshHash' in g));
    oauth.revokeGrant(g.id);
    assert.strictEqual(await oauth.authenticate(tok2.access_token), null);
  } finally { server.close(); }
});

test('OAuth: denial redirects with access_denied; unknown redirect URI is not redirected; disabled = 404', async () => {
  const store = fakeStore({ publicUrl: 'https://termclaw.example.com/mcp' });
  const oauth = new OAuthServer({ store, audit });
  const { server, base } = await serve(oauth);
  try {
    const prm = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
    assert.strictEqual(prm.resource, 'https://termclaw.example.com/mcp');
    const client = await (await fetch(base + '/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://127.0.0.1/callback'] }) })).json();
    const { challenge } = pkce();
    const evil = await fetch(`${base}/oauth/authorize?` + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.example.com/cb', code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' });
    assert.strictEqual(evil.status, 400);
    const noPkce = await fetch(`${base}/oauth/authorize?` + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9999/callback' }), { redirect: 'manual' });
    assert.strictEqual(noPkce.status, 302);
    assert.match(noPkce.headers.get('location'), /error=invalid_request/);
    let request;
    oauth.once('request', (r) => { request = r; });
    await fetch(`${base}/oauth/authorize?` + new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://127.0.0.1:9999/callback', code_challenge: challenge, code_challenge_method: 'S256', state: 's1' }));
    oauth.decide(request.id, { approve: false });
    const loc = new URL((await (await fetch(`${base}/oauth/authorize/status?request=${request.id}`)).json()).location);
    assert.strictEqual(loc.port, '9999');
    assert.strictEqual(loc.searchParams.get('error'), 'access_denied');
    assert.strictEqual(loc.searchParams.get('state'), 's1');
    store.settings.mcp.oauth = false;
    assert.strictEqual((await fetch(base + '/.well-known/oauth-authorization-server')).status, 404);
    assert.strictEqual((await fetch(base + '/mcp')).headers.get('www-authenticate'), 'Bearer');
  } finally { server.close(); }
});

test('OAuth: Client ID Metadata Document as client_id', async () => {
  const docUrl = 'https://claude.ai/oauth/mcp-client-metadata';
  const fetchImpl = async (u) => ({ ok: u === docUrl, status: 200, text: async () => JSON.stringify({ client_id: docUrl, client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }) });
  const oauth = new OAuthServer({ store: fakeStore(), audit, fetchImpl });
  const { server, base } = await serve(oauth);
  try {
    let request;
    oauth.once('request', (r) => { request = r; });
    const { challenge } = pkce();
    const r = await fetch(`${base}/oauth/authorize?` + new URLSearchParams({ response_type: 'code', client_id: docUrl, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(request.clientName, 'Claude');
    assert.ok(request.cimd);
  } finally { server.close(); }
});
