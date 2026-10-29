'use strict';
// OAuth 2.1 for the MCP server, so web clients like claude.ai can connect (they sign in with OAuth and
// cannot send a fixed Authorization header). The app is its own authorization server:
//   protected resource metadata (RFC 9728), authorization server metadata (RFC 8414),
//   Dynamic Client Registration (RFC 7591) and Client ID Metadata Documents, authorization code + PKCE S256,
//   refresh tokens with rotation. Every sign-in is approved by the user in the app.
// Alternatively (mode "external") an identity provider such as authentik is the authorization server and
// the app only validates its JWT access tokens (see mcp-oauth-external.js).
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { ExternalIssuer, claimList } = require('./mcp-oauth-external');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url');

const ACCESS_TTL = 3600; // seconds
const CODE_TTL = 120 * 1000;
const REQUEST_TTL = 5 * 60 * 1000; // time the user has to approve in the app
const MAX_PENDING = 3;
const MAX_CLIENTS = 200;
const SCOPES = ['mcp:read', 'mcp:full'];

const isLoopbackHost = (h) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]';

// Redirect URIs: https, or http on a loopback address (native clients such as Claude Code).
function validRedirect(uri) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname));
  } catch { return false; }
}

// Exact match, except that loopback redirects match on any port (RFC 8252 7.3).
function redirectMatches(registered, uri) {
  if (registered === uri) return true;
  try {
    const a = new URL(registered);
    const b = new URL(uri);
    return a.protocol === 'http:' && isLoopbackHost(a.hostname) && isLoopbackHost(b.hostname) && a.hostname === b.hostname &&
      a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

class OAuthServer extends EventEmitter {
  // store.data.oauthClients: registered clients; store.data.oauthGrants: approved sign-ins (hashes only).
  constructor({ store, audit, fetchImpl }) {
    super();
    this.store = store;
    this.audit = audit;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.pending = new Map(); // request id -> authorization request waiting for the user
    this.codes = new Map(); // code hash -> {grant data, expires}
    this.cimdCache = new Map(); // client_id URL -> {client, expires}
    this.issuer = new ExternalIssuer({ fetchImpl });
    this.verified = new Map(); // token hash -> {ctx, exp} for external JWTs
  }

  get enabled() { return !!this.store.settings.mcp.oauth; }
  get external() { return this.enabled && this.store.settings.mcp.oauthMode === 'external'; }

  _ext() {
    const m = this.store.settings.mcp;
    return {
      issuer: String(m.oauthIssuer || '').trim(),
      audiences: String(m.oauthAudience || '').split(/[\s,]+/).filter(Boolean),
      groupsClaim: String(m.oauthGroupsClaim || 'groups').trim(),
      allowedGroup: String(m.oauthAllowedGroup || '').trim(),
      fullGroup: String(m.oauthFullGroup || '').trim(),
      scopes: String(m.oauthScopes || 'openid profile email').split(/\s+/).filter(Boolean),
    };
  }

  testIssuer(issuer) { return this.issuer.test(String(issuer || '').trim()); }

  // Base URL of the server as clients see it: the configured public MCP URL without /mcp,
  // otherwise derived from the request (reverse proxies set X-Forwarded-Proto / -Host).
  baseUrl(req) {
    const pub = String(this.store.settings.mcp.publicUrl || '').trim().replace(/\/+$/, '');
    if (pub) return pub.replace(/\/mcp$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    return `${proto}://${host}`;
  }

  resourceUrl(req) { return this.baseUrl(req) + '/mcp'; }

  // WWW-Authenticate value for a 401 on /mcp.
  challenge(req) {
    if (!this.enabled) return 'Bearer';
    const scopes = this.external ? this._ext().scopes : SCOPES;
    return `Bearer resource_metadata="${this.baseUrl(req)}/.well-known/oauth-protected-resource", scope="${scopes.join(' ')}"`;
  }

  // ---------- grants ----------
  listGrants() {
    return (this.store.data.oauthGrants || []).map(({ refreshHash, accessHash, accessExp, ...g }) => g);
  }

  revokeGrant(id) {
    const g = this._grants().find((x) => x.id === id);
    if (!g) return;
    g.revoked = true;
    g.refreshHash = null;
    g.accessHash = null;
    this.store.save();
    this.emit('revoked', g);
    this.audit.add({ source: 'app', action: 'oauth.revoke', detail: g.clientName });
  }

  deleteGrant(id) {
    this.revokeGrant(id);
    this.store.data.oauthGrants = this._grants().filter((x) => x.id !== id);
    this.store.save();
  }

  _grants() { return (this.store.data.oauthGrants = this.store.data.oauthGrants || []); }
  _clients() { return (this.store.data.oauthClients = this.store.data.oauthClients || []); }

  // Context for a bearer token issued by OAuth (built-in or the external provider), or null.
  async authenticate(token, req) {
    if (!this.enabled || !token) return null;
    if (this.external) return this._authenticateExternal(token, req);
    if (!token.startsWith('atmo_')) return null;
    const h = sha256(token);
    const g = this._grants().find((x) => x.accessHash === h && !x.revoked);
    if (!g || g.accessExp < Date.now()) return null;
    g.lastUsed = Date.now();
    return { tokenId: 'oauth:' + g.id, tokenName: `${g.clientName} (OAuth)`, readOnly: !!g.readOnly };
  }

  async _authenticateExternal(token, req) {
    if (!token.includes('.')) return null; // app tokens (termclaw_…) are checked by the caller
    const h = sha256(token);
    const hit = this.verified.get(h);
    if (hit && hit.exp > Date.now()) return hit.ctx;
    const cfg = this._ext();
    let claims;
    try {
      claims = await this.issuer.verify(token, { issuer: cfg.issuer, audiences: cfg.audiences });
    } catch (e) {
      this.audit.add({ source: 'external', action: 'oauth.reject', detail: e.message, remote: req && (req.headers['x-forwarded-for'] || req.socket.remoteAddress) });
      return null;
    }
    const groups = claimList(claims, cfg.groupsClaim);
    const user = claims.preferred_username || claims.email || claims.name || claims.sub;
    if (cfg.allowedGroup && !groups.includes(cfg.allowedGroup)) {
      this.audit.add({ source: 'external', action: 'oauth.reject', detail: `${user}: not in group ${cfg.allowedGroup}` });
      return null;
    }
    const ctx = { tokenId: 'ext:' + claims.sub, tokenName: `${user} (${hostOf(cfg.issuer)})`, readOnly: !!cfg.fullGroup && !groups.includes(cfg.fullGroup) };
    if (this.verified.size > 500) this.verified.clear();
    this.verified.set(h, { ctx, exp: Math.min(claims.exp * 1000, Date.now() + 5 * 60 * 1000) });
    return ctx;
  }

  // ---------- user decisions ----------
  listPending() {
    return [...this.pending.values()].filter((r) => !r.decision).map((r) => this._publicRequest(r));
  }

  _publicRequest(r) {
    return { id: r.id, clientName: r.client.client_name, clientId: r.client.client_id, redirectHost: r.redirectHost, scope: r.scope, remote: r.remote, created: r.created, cimd: !!r.client.cimd };
  }

  decide(id, { approve, readOnly = true } = {}) {
    const r = this.pending.get(id);
    if (!r || r.decision) return false;
    if (!approve) {
      r.decision = { location: this._redirect(r, { error: 'access_denied', error_description: 'The user denied access in TermClaw' }) };
      this.audit.add({ source: 'app', action: 'oauth.deny', detail: `${r.client.client_name} → ${r.redirectHost}` });
    } else {
      const code = rnd();
      this.codes.set(sha256(code), {
        clientId: r.client.client_id, clientName: r.client.client_name, redirectUri: r.redirectUri, challenge: r.challenge,
        resource: r.resource, readOnly: !!readOnly, redirectHost: r.redirectHost, expires: Date.now() + CODE_TTL,
      });
      r.decision = { location: this._redirect(r, { code }) };
      this.audit.add({ source: 'app', action: 'oauth.approve', detail: `${r.client.client_name} → ${r.redirectHost}${readOnly ? ' (read-only)' : ' (full)'}` });
    }
    this.emit('decided', id);
    setTimeout(() => this.pending.delete(id), 60000).unref?.();
    return true;
  }

  _redirect(r, params) {
    const u = new URL(r.redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    if (r.state != null) u.searchParams.set('state', r.state);
    u.searchParams.set('iss', r.issuer);
    return u.toString();
  }

  // ---------- HTTP ----------
  // Handles OAuth paths; returns false for everything else.
  async handle(req, res, url, remote) {
    const p = url.pathname;
    const isMeta = p.startsWith('/.well-known/oauth-protected-resource') || p.startsWith('/.well-known/oauth-authorization-server') || p.startsWith('/.well-known/openid-configuration');
    if (!isMeta && !p.startsWith('/oauth/')) return false;
    if (!this.enabled) { res.writeHead(404); res.end(); return true; }
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return true; }
    const json = (code, obj, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors, ...extra }); res.end(JSON.stringify(obj)); };
    const base = this.baseUrl(req);

    if (p.startsWith('/.well-known/oauth-protected-resource')) {
      if (this.external) {
        const cfg = this._ext();
        return json(200, { resource: base + '/mcp', authorization_servers: [cfg.issuer], scopes_supported: cfg.scopes, bearer_methods_supported: ['header'], resource_name: 'TermClaw' }), true;
      }
      return json(200, { resource: base + '/mcp', authorization_servers: [base], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'TermClaw' }), true;
    }
    // With an external provider the app has no authorization server endpoints of its own.
    if (this.external) { res.writeHead(404, cors); res.end(); return true; }
    if (isMeta) {
      return json(200, {
        issuer: base,
        authorization_endpoint: base + '/oauth/authorize',
        token_endpoint: base + '/oauth/token',
        registration_endpoint: base + '/oauth/register',
        revocation_endpoint: base + '/oauth/revoke',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        scopes_supported: [...SCOPES, 'offline_access'],
        authorization_response_iss_parameter_supported: true,
      }), true;
    }
    try {
      if (p === '/oauth/register' && req.method === 'POST') return json(...this._register(await readBody(req), remote)), true;
      if (p === '/oauth/token' && req.method === 'POST') return json(...this._token(await readBody(req), remote)), true;
      if (p === '/oauth/revoke' && req.method === 'POST') { this._revokeToken(await readBody(req)); return json(200, {}), true; }
      if (p === '/oauth/authorize' && req.method === 'GET') { await this._authorize(req, res, url, base, remote); return true; }
      if (p === '/oauth/authorize/status' && req.method === 'GET') {
        const r = this.pending.get(url.searchParams.get('request') || '');
        return json(200, r ? (r.decision ? { done: true, location: r.decision.location } : { done: false }) : { done: true, error: 'This sign-in request expired. Start again in your client.' }), true;
      }
    } catch (e) {
      return json(e.status || 400, { error: e.code || 'invalid_request', error_description: e.message }), true;
    }
    res.writeHead(404); res.end();
    return true;
  }

  // RFC 7591: public clients only (no secret); redirect URIs must be https or loopback.
  _register(body, remote) {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10 || !uris.every(validRedirect)) throw oauthError('invalid_redirect_uri', 'redirect_uris must be https URLs or http loopback URLs');
    const name = String(body.client_name || 'MCP client').slice(0, 100);
    const client = {
      client_id: 'atmc_' + rnd(16), client_name: name, redirect_uris: uris,
      client_id_issued_at: Math.floor(Date.now() / 1000), registered: Date.now(), remote,
    };
    const list = this._clients();
    list.push(client);
    // Keep the list bounded: drop the oldest clients without an approved sign-in.
    const used = new Set(this._grants().map((g) => g.clientId));
    while (list.length > MAX_CLIENTS) {
      const i = list.findIndex((c) => !used.has(c.client_id));
      list.splice(i >= 0 ? i : 0, 1);
    }
    this.store.save();
    this.audit.add({ source: 'external', action: 'oauth.register', detail: `${name} (${uris.map(hostOf).join(', ')})`, remote });
    const { registered, remote: _r, ...out } = client;
    return [201, { ...out, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }];
  }

  async _client(clientId) {
    if (/^https:\/\//.test(clientId)) return this._cimd(clientId);
    const c = this._clients().find((x) => x.client_id === clientId);
    if (!c) throw oauthError('invalid_client', 'Unknown client_id');
    return c;
  }

  // Client ID Metadata Document: the client_id is an https URL serving the client's metadata.
  async _cimd(clientId) {
    const hit = this.cimdCache.get(clientId);
    if (hit && hit.expires > Date.now()) return hit.client;
    let doc;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const r = await this.fetch(clientId, { signal: ctrl.signal, redirect: 'error', headers: { accept: 'application/json' } });
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      if (text.length > 64 * 1024) throw new Error('document too large');
      doc = JSON.parse(text);
    } catch (e) {
      throw oauthError('invalid_client', `Client metadata document ${clientId} could not be read: ${e.message}`);
    }
    if (doc.client_id !== clientId) throw oauthError('invalid_client', 'client_id in the metadata document does not match its URL');
    const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.map(String).filter(validRedirect) : [];
    if (!uris.length) throw oauthError('invalid_client', 'Client metadata document has no valid redirect_uris');
    const client = { client_id: clientId, client_name: String(doc.client_name || hostOf(clientId)).slice(0, 100), redirect_uris: uris, cimd: true };
    this.cimdCache.set(clientId, { client, expires: Date.now() + 3600 * 1000 });
    return client;
  }

  async _authorize(req, res, url, base, remote) {
    const q = Object.fromEntries(url.searchParams);
    const page = (status, title, body) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
      res.end(htmlPage(title, body));
    };
    // Errors before the redirect URI is verified are shown here, never redirected.
    let client;
    try { client = await this._client(String(q.client_id || '')); } catch (e) { return page(400, 'Sign-in failed', `<p>${esc(e.message)}</p>`); }
    const redirectUri = String(q.redirect_uri || (client.redirect_uris.length === 1 ? client.redirect_uris[0] : ''));
    if (!client.redirect_uris.some((r) => redirectMatches(r, redirectUri))) return page(400, 'Sign-in failed', '<p>The redirect URI is not registered for this client.</p>');
    const r = {
      id: rnd(18), client, redirectUri, redirectHost: hostOf(redirectUri), state: q.state, issuer: base,
      challenge: q.code_challenge, resource: q.resource || base + '/mcp', scope: q.scope || '', remote, created: Date.now(),
    };
    const fail = (error, desc) => { res.writeHead(302, { location: this._redirect(r, { error, error_description: desc }) }); res.end(); };
    if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    if (q.resource && q.resource.replace(/\/+$/, '') !== base + '/mcp') return fail('invalid_target', `Unknown resource; use ${base}/mcp`);
    for (const [id, x] of this.pending) if (Date.now() - x.created > REQUEST_TTL) this.pending.delete(id);
    if (this.listPending().length >= MAX_PENDING) return fail('temporarily_unavailable', 'Too many sign-in requests are waiting for approval');

    this.pending.set(r.id, r);
    setTimeout(() => { if (!r.decision) { this.pending.delete(r.id); this.emit('decided', r.id); } }, REQUEST_TTL).unref?.();
    this.audit.add({ source: 'external', action: 'oauth.authorize', detail: `${client.client_name} → ${r.redirectHost}`, remote });
    this.emit('request', this._publicRequest(r));
    page(200, 'Approve in TermClaw', `
<p><b>${esc(client.client_name)}</b> wants to access your TermClaw.</p>
<p>Open the TermClaw app on your computer and approve or deny the request there.<br>You will be sent back to <b>${esc(r.redirectHost)}</b> afterwards.</p>
<p id="st" class="muted">Waiting for approval…</p>
<script>
(function poll(){fetch('authorize/status?request=${r.id}').then(function(r){return r.json()}).then(function(s){
  if(s.location){document.getElementById('st').textContent='Done, returning…';location.replace(s.location);}
  else if(s.error){document.getElementById('st').textContent=s.error;}
  else setTimeout(poll,1500);
}).catch(function(){setTimeout(poll,3000)});})();
</script>`);
  }

  _token(body, remote) {
    const grantType = body.grant_type;
    if (grantType === 'authorization_code') {
      const c = this.codes.get(sha256(String(body.code || '')));
      if (c) this.codes.delete(sha256(String(body.code)));
      if (!c || c.expires < Date.now()) throw oauthError('invalid_grant', 'Authorization code is invalid or expired');
      if (body.client_id && body.client_id !== c.clientId) throw oauthError('invalid_grant', 'Code was issued to another client');
      if (body.redirect_uri && body.redirect_uri !== c.redirectUri) throw oauthError('invalid_grant', 'redirect_uri does not match');
      const verifier = String(body.code_verifier || '');
      if (!verifier || crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) throw oauthError('invalid_grant', 'PKCE verification failed');
      const g = { id: crypto.randomUUID(), clientId: c.clientId, clientName: c.clientName, redirectHost: c.redirectHost, readOnly: c.readOnly, created: Date.now(), lastUsed: null, revoked: false };
      this._grants().push(g);
      const out = this._issue(g);
      this.audit.add({ source: 'external', action: 'oauth.token', detail: g.clientName, remote });
      return [200, out];
    }
    if (grantType === 'refresh_token') {
      const h = sha256(String(body.refresh_token || ''));
      const g = this._grants().find((x) => x.refreshHash === h && !x.revoked);
      if (!g) throw oauthError('invalid_grant', 'Refresh token is invalid or revoked');
      if (body.client_id && body.client_id !== g.clientId) throw oauthError('invalid_grant', 'Refresh token was issued to another client');
      return [200, this._issue(g)];
    }
    throw oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token');
  }

  // New access token and rotated refresh token for a grant.
  _issue(g) {
    const access = 'atmo_' + rnd();
    const refresh = 'atmr_' + rnd();
    g.accessHash = sha256(access);
    g.accessExp = Date.now() + ACCESS_TTL * 1000;
    g.refreshHash = sha256(refresh);
    g.lastUsed = Date.now();
    this.store.save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh, scope: g.readOnly ? 'mcp:read' : 'mcp:read mcp:full' };
  }

  // RFC 7009: revoking an access or refresh token ends the grant.
  _revokeToken(body) {
    const h = sha256(String(body.token || ''));
    const g = this._grants().find((x) => x.accessHash === h || x.refreshHash === h);
    if (g) this.revokeGrant(g.id);
  }
}

function oauthError(code, message, status = 400) {
  const e = new Error(message);
  e.code = code;
  e.status = status;
  return e;
}

function hostOf(u) { try { return new URL(u).host; } catch { return String(u); } }

// Token and revoke requests are form-urlencoded (RFC 6749); registration is JSON.
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 64 * 1024) throw oauthError('invalid_request', 'Request too large'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (/json/i.test(req.headers['content-type'] || '')) {
    try { return JSON.parse(text || '{}'); } catch { throw oauthError('invalid_request', 'Invalid JSON'); }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

function htmlPage(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#222;background:#fafafa;line-height:1.5}
h1{font-size:20px}.muted{color:#777}@media(prefers-color-scheme:dark){body{background:#1b1b1d;color:#ddd}.muted{color:#999}}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}

module.exports = { OAuthServer, validRedirect, redirectMatches };
