'use strict';
// External authorization server (authentik, Keycloak, Entra ID, …) for the MCP server: the identity
// provider signs users in and issues JWT access tokens; the app only validates them (signature via the
// provider's JWKS, issuer, audience, expiry) and maps a group claim to full or read-only access.
const crypto = require('crypto');

const META_TTL = 3600 * 1000;
const JWKS_REFRESH_MIN = 60 * 1000; // at most one JWKS reload per minute for unknown key ids
const SKEW = 60; // seconds of clock skew allowed

const isLoopbackUrl = (u) => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname); } catch { return false; } };

// The issuer must be https (http only on loopback, for tests and local providers).
function validIssuer(issuer) {
  try {
    const u = new URL(issuer);
    return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackUrl(issuer));
  } catch { return false; }
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Signature check for the JWS algorithms identity providers use.
function verifySignature(alg, key, data, sig) {
  const m = /^(RS|PS|ES)(256|384|512)$/.exec(alg);
  if (alg === 'EdDSA') return crypto.verify(null, data, key, sig);
  if (!m) throw new Error('unsupported token algorithm ' + alg);
  const hash = 'sha' + m[2];
  if (m[1] === 'RS') return crypto.verify(hash, data, key, sig);
  if (m[1] === 'PS') return crypto.verify(hash, data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(m[2]) / 8 }, sig);
  return crypto.verify(hash, data, { key, dsaEncoding: 'ieee-p1363' }, sig);
}

class ExternalIssuer {
  constructor({ fetchImpl } = {}) {
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.meta = null; // {issuer, metadata, expires}
    this.keys = new Map(); // kid -> KeyObject
    this.keysLoaded = 0;
  }

  async _get(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await this.fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
      return JSON.parse(await r.text());
    } finally { clearTimeout(t); }
  }

  // OpenID Connect discovery, falling back to RFC 8414 authorization server metadata.
  async metadata(issuer) {
    if (this.meta && this.meta.issuer === issuer && this.meta.expires > Date.now()) return this.meta.metadata;
    if (!validIssuer(issuer)) throw new Error('Issuer must be an https URL');
    const base = issuer.replace(/\/+$/, '');
    const u = new URL(issuer);
    const candidates = [
      base + '/.well-known/openid-configuration',
      `${u.origin}/.well-known/oauth-authorization-server${u.pathname.replace(/\/+$/, '')}`,
    ];
    let md;
    let lastErr;
    for (const c of candidates) {
      try { md = await this._get(c); break; } catch (e) { lastErr = e; }
    }
    if (!md) throw new Error(`No discovery metadata for ${issuer}: ${lastErr && lastErr.message}`);
    if (!md.jwks_uri) throw new Error('The provider metadata has no jwks_uri');
    if (md.issuer && md.issuer.replace(/\/+$/, '') !== base) throw new Error(`Issuer mismatch: the provider calls itself ${md.issuer}`);
    this.meta = { issuer, metadata: md, expires: Date.now() + META_TTL };
    if (this.jwksUri !== md.jwks_uri) { this.keys.clear(); this.keysLoaded = 0; this.jwksUri = md.jwks_uri; }
    return md;
  }

  async _loadKeys() {
    const set = await this._get(this.jwksUri);
    this.keys.clear();
    for (const jwk of set.keys || []) {
      if (jwk.use && jwk.use !== 'sig') continue;
      try { this.keys.set(jwk.kid || '', crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch {}
    }
    this.keysLoaded = Date.now();
  }

  async _key(kid) {
    if (!this.keysLoaded) await this._loadKeys();
    if (!this.keys.has(kid || '') && Date.now() - this.keysLoaded > JWKS_REFRESH_MIN) await this._loadKeys(); // key rotation
    const k = this.keys.get(kid || '') || (!kid && this.keys.size === 1 ? [...this.keys.values()][0] : null);
    if (!k) throw new Error('unknown signing key ' + kid);
    return k;
  }

  // Validates a JWT access token; returns its claims or throws.
  async verify(token, { issuer, audiences }) {
    const md = await this.metadata(issuer);
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new Error('not a JWT (the provider must issue JWT access tokens)');
    const header = b64json(parts[0]);
    if (!header.alg || header.alg === 'none' || /^HS/.test(header.alg)) throw new Error('unsupported token algorithm ' + header.alg);
    const key = await this._key(header.kid);
    if (!verifySignature(header.alg, key, Buffer.from(parts[0] + '.' + parts[1]), Buffer.from(parts[2], 'base64url'))) throw new Error('invalid signature');
    const c = b64json(parts[1]);
    const now = Math.floor(Date.now() / 1000);
    const iss = (md.issuer || issuer).replace(/\/+$/, '');
    if (String(c.iss || '').replace(/\/+$/, '') !== iss) throw new Error('wrong issuer ' + c.iss);
    if (typeof c.exp !== 'number' || c.exp < now - SKEW) throw new Error('token expired');
    if (typeof c.nbf === 'number' && c.nbf > now + SKEW) throw new Error('token not yet valid');
    const aud = [].concat(c.aud || [], c.azp ? [c.azp] : []);
    if (!audiences.length || !aud.some((a) => audiences.includes(a))) throw new Error(`audience ${aud.join(', ') || '(none)'} is not allowed`);
    return c;
  }

  // Connection test for the settings page.
  async test(issuer) {
    this.meta = null;
    const md = await this.metadata(issuer);
    await this._loadKeys();
    return {
      issuer: md.issuer || issuer,
      keys: this.keys.size,
      authorizationEndpoint: md.authorization_endpoint,
      registration: !!md.registration_endpoint,
      cimd: !!md.client_id_metadata_document_supported,
      pkce: (md.code_challenge_methods_supported || []).includes('S256'),
      scopes: md.scopes_supported || [],
    };
  }
}

// Group / role names from the configured claim (authentik: "groups", Entra: "groups" or "roles").
function claimList(claims, name) {
  const v = name.split('.').reduce((o, k) => (o == null ? undefined : o[k]), claims);
  return Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : [];
}

module.exports = { ExternalIssuer, validIssuer, claimList, verifySignature };
