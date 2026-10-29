'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const { OAuthServer } = require('../src/main/mcp-oauth');
const { ExternalIssuer, claimList, validIssuer } = require('../src/main/mcp-oauth-external');

// A fake identity provider (like authentik) with discovery and JWKS, signing with RSA and EC keys.
async function fakeIdp() {
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwks = { keys: [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa1', use: 'sig', alg: 'RS256' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec1', use: 'sig', alg: 'ES256' }] };
  let issuer;
  const server = http.createServer((req, res) => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/application/o/termclaw/.well-known/openid-configuration') return json({ issuer, jwks_uri: issuer + 'jwks/', authorization_endpoint: issuer + 'authorize/', code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'profile', 'email', 'offline_access'] });
    if (req.url === '/application/o/termclaw/jwks/') return json(jwks);
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${server.address().port}/application/o/termclaw/`;
  const sign = (claims, { kid = 'rsa1', alg = 'RS256' } = {}) => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = enc({ alg, kid, typ: 'JWT' }) + '.' + enc({ iss: issuer, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), ...claims });
    const sig = alg === 'ES256'
      ? crypto.sign('sha256', Buffer.from(data), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' })
      : crypto.sign('sha256', Buffer.from(data), rsa.privateKey);
    return data + '.' + sig.toString('base64url');
  };
  return { server, issuer, sign };
}

test('external issuer: discovery, RS256 and ES256 tokens, issuer / audience / expiry checks', async () => {
  const idp = await fakeIdp();
  try {
    const ext = new ExternalIssuer();
    const opts = { issuer: idp.issuer, audiences: ['claude-client'] };
    const t = await ext.test(idp.issuer);
    assert.strictEqual(t.keys, 2);
    assert.strictEqual(t.registration, false);
    assert.strictEqual((await ext.verify(idp.sign({ sub: 'u1', aud: 'claude-client' }), opts)).sub, 'u1');
    assert.strictEqual((await ext.verify(idp.sign({ sub: 'u2', aud: ['x', 'claude-client'] }, { kid: 'ec1', alg: 'ES256' }), opts)).sub, 'u2');
    await assert.rejects(ext.verify(idp.sign({ sub: 'u', aud: 'other-app' }), opts), /audience/);
    await assert.rejects(ext.verify(idp.sign({ sub: 'u', aud: 'claude-client', exp: 1000 }), opts), /expired/);
    await assert.rejects(ext.verify(idp.sign({ sub: 'u', aud: 'claude-client', iss: 'https://evil.example.com/' }), opts), /wrong issuer/);
    const good = idp.sign({ sub: 'u', aud: 'claude-client' });
    const [hd, pl, sg] = good.split('.');
    const forged = hd + '.' + Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pl, 'base64url')), sub: 'admin' })).toString('base64url') + '.' + sg;
    await assert.rejects(ext.verify(forged, opts), /invalid signature/);
    const none = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + pl + '.';
    await assert.rejects(ext.verify(none, opts), /unsupported/);
    await assert.rejects(ext.verify('opaque-token', opts), /not a JWT/);
  } finally { idp.server.close(); }
});

test('external mode in the MCP OAuth server: metadata points at the provider, groups map to access', async () => {
  const idp = await fakeIdp();
  const store = { data: {}, save() {}, settings: { mcp: { oauth: true, oauthMode: 'external', publicUrl: 'https://termclaw.example.com/mcp', oauthIssuer: idp.issuer, oauthAudience: 'claude-client', oauthGroupsClaim: 'groups', oauthAllowedGroup: 'termclaw-users', oauthFullGroup: 'termclaw-admins', oauthScopes: 'openid profile email' } } };
  const oauth = new OAuthServer({ store, audit: { add() {} } });
  const server = http.createServer(async (req, res) => { if (!(await oauth.handle(req, res, new URL(req.url, 'http://x'), '127.0.0.1'))) { res.writeHead(401, { 'www-authenticate': oauth.challenge(req) }); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const prm = await (await fetch(base + '/.well-known/oauth-protected-resource')).json();
    assert.strictEqual(prm.resource, 'https://termclaw.example.com/mcp');
    assert.deepStrictEqual(prm.authorization_servers, [idp.issuer]);
    assert.deepStrictEqual(prm.scopes_supported, ['openid', 'profile', 'email']);
    assert.strictEqual((await fetch(base + '/oauth/register', { method: 'POST' })).status, 404);
    assert.strictEqual((await fetch(base + '/.well-known/oauth-authorization-server')).status, 404);
    assert.match((await fetch(base + '/mcp')).headers.get('www-authenticate'), /scope="openid profile email"/);

    const admin = await oauth.authenticate(idp.sign({ sub: 'a', preferred_username: 'alice', aud: 'claude-client', groups: ['termclaw-users', 'termclaw-admins'] }));
    assert.deepStrictEqual({ readOnly: admin.readOnly, name: admin.tokenName }, { readOnly: false, name: 'alice (127.0.0.1:' + new URL(idp.issuer).port + ')' });
    const user = await oauth.authenticate(idp.sign({ sub: 'b', aud: 'claude-client', groups: ['termclaw-users'] }));
    assert.strictEqual(user.readOnly, true);
    assert.strictEqual(await oauth.authenticate(idp.sign({ sub: 'c', aud: 'claude-client', groups: ['others'] })), null);
    assert.strictEqual(await oauth.authenticate('atmo_builtin-token'), null);
  } finally { server.close(); idp.server.close(); }
});

test('group claims and issuer URLs', () => {
  assert.deepStrictEqual(claimList({ groups: ['a', 'b'] }, 'groups'), ['a', 'b']);
  assert.deepStrictEqual(claimList({ realm_access: { roles: ['x'] } }, 'realm_access.roles'), ['x']);
  assert.deepStrictEqual(claimList({ scp: 'a b' }, 'scp'), ['a', 'b']);
  assert.ok(validIssuer('https://auth.example.com/application/o/termclaw/'));
  assert.ok(!validIssuer('http://auth.example.com/'));
});
