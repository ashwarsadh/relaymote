'use strict';
const https = require('https');
const crypto = require('crypto');
const config = require('../lib/config');

const cfgAccess = (config.get().remote || {}).access || {};
const TEAM = process.env.RELAYMOTE_ACCESS_TEAM || cfgAccess.team || '';
const AUD = process.env.RELAYMOTE_ACCESS_AUD || cfgAccess.aud || '';
const ENABLED = !!(TEAM && AUD);
const ISS = TEAM ? `https://${TEAM}` : '';
const CERTS = ISS ? `${ISS}/cdn-cgi/access/certs` : '';

let jwks = { at: 0, keys: new Map() };
let fetching = null;
const TTL_MS = 60 * 60 * 1000;
const REFRESH_AT_MS = TTL_MS * 0.8;
let lastMiss = 0;

const seen = new Map();
const SEEN_MAX = 200;

function fetchCerts() {
  if (!ENABLED) return Promise.resolve(false);
  if (fetching) return fetching;
  fetching = new Promise((resolve) => {
    const req = https.get(CERTS, { timeout: 12000 }, res => {
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        try {
          const body = JSON.parse(d);
          const keys = new Map();
          for (const jwk of body.keys || []) {
            if (!jwk.kid || jwk.kty !== 'RSA') continue;
            try { keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' })); } catch {}
          }
          if (keys.size) jwks = { at: Date.now(), keys };
          resolve(keys.size > 0);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  }).finally(() => { fetching = null; });
  return fetching;
}

const b64 = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function verify(token) {
  if (!ENABLED) return null; // Access verification disabled: no team/aud configured
  if (!token || typeof token !== 'string') return null;

  const hit = seen.get(token);
  if (hit) {
    if (Date.now() < hit.until) return hit.id;
    seen.delete(token);
  }

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h64, p64, s64] = parts;

  let head, payload;
  try {
    head = JSON.parse(b64(h64).toString('utf8'));
    payload = JSON.parse(b64(p64).toString('utf8'));
  } catch { return null; }

  if (head.alg !== 'RS256' || !head.kid) return null;

  const age = Date.now() - jwks.at;
  if (!jwks.keys.size) await fetchCerts();
  else if (age > REFRESH_AT_MS) fetchCerts();
  let key = jwks.keys.get(head.kid);
  if (!key) {
    if (Date.now() - lastMiss < 60000) return null;
    lastMiss = Date.now();
    await fetchCerts();
    key = jwks.keys.get(head.kid);
    if (!key) return null;
  }

  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h64}.${p64}`), key, b64(s64));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) return null;
  if (typeof payload.nbf === 'number' && now < payload.nbf - 60) return null;
  if (payload.iss !== ISS) return null;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(AUD)) return null;

  const id = { email: payload.email || null, sub: payload.sub || null };
  const until = typeof payload.exp === 'number' ? Math.min(payload.exp * 1000, Date.now() + TTL_MS) : Date.now() + 60000;
  if (until > Date.now()) {
    if (seen.size >= SEEN_MAX) seen.clear();
    seen.set(token, { until, id });
  }
  return id;
}

fetchCerts();

function tokenFrom(req) {
  const h = req.headers['cf-access-jwt-assertion'];
  if (h) return Array.isArray(h) ? h[0] : h;
  return require('./cookies').cookieValue(req, 'CF_Authorization');
}

async function identify(req) { return verify(tokenFrom(req)); }

module.exports = { verify, identify, tokenFrom, TEAM, AUD, CERTS };
