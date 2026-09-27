'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { URL } = require('url');
const config = require('../lib/config');

const STORE = path.join(config.MOBILE, 'push.json');
// The VAPID contact ("sub"). Read on EVERY send, so a contact entered in Settings applies at once.
// Apple's push service refuses a JWT whose contact is not a real mailto:/https: address, so the
// placeholder is only a last resort and Settings asks for a real one while it is in use.
const PLACEHOLDER_SUBJECT = 'mailto:admin@localhost';
const validSubject = (s) => /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(s) || /^https:\/\/[^\s/]+\.[^\s]+/i.test(s);
function subject() {
  const set = String(process.env.RELAYMOTE_PUSH_SUBJECT || (config.get().notifications || {}).pushSubject || '').trim();
  return validSubject(set) ? set : PLACEHOLDER_SUBJECT;
}
function subjectStatus() {
  const set = String(process.env.RELAYMOTE_PUSH_SUBJECT || (config.get().notifications || {}).pushSubject || '').trim();
  return { subject: subject(), set, valid: validSubject(set), placeholder: !validSubject(set) };
}

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return null; }
}
function save(d) {
  fs.writeFileSync(STORE, JSON.stringify(d, null, 2), { mode: 0o600 });
}

function keys() {
  let d = load();
  if (d && d.vapid && d.vapid.publicKey) return d;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(spki.length - 65);
  d = {
    vapid: {
      publicKey: raw.toString('base64url'),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    subs: (d && d.subs) || [],
  };
  save(d);
  return d;
}

function publicKey() { return keys().vapid.publicKey; }

function subscribe(sub) {
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    throw new Error('invalid subscription');
  }
  const d = keys();
  d.subs = (d.subs || []).filter(s => s.endpoint !== sub.endpoint);
  d.subs.push({ endpoint: sub.endpoint, keys: sub.keys, at: new Date().toISOString() });
  save(d);
  return d.subs.length;
}

function drop(endpoint) {
  const d = keys();
  d.subs = (d.subs || []).filter(s => s.endpoint !== endpoint);
  save(d);
}

function count() { return (keys().subs || []).length; }

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function hkdf(salt, ikm, info, len) {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, len);
}

function encrypt(plaintext, uaPublicB64, authSecretB64) {
  const uaPublic = Buffer.from(uaPublicB64, 'base64url');
  const authSecret = Buffer.from(authSecretB64, 'base64url');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'), uaPublic, asPublic,
  ]);
  const ikm = hkdf(authSecret, shared, keyInfo, 32);

  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  const padded = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

function vapidJwt(audience) {
  const d = keys();
  const header = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject(),
  })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(d.vapid.privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${sig.toString('base64url')}`;
}

// The JWT audience is the push service's ORIGIN: scheme + '//' + host (a missing '//' made every
// push service reject the token).
function audience(u) { if (typeof u === 'string') u = new URL(u); return `${u.protocol}//${u.host}`; }

function post(endpoint, payload) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(endpoint); } catch { return resolve({ ok: false, status: 0, error: 'bad endpoint' }); }
    const jwt = vapidJwt(audience(u));
    const req = https.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      timeout: 15000,
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': payload.length,
        TTL: '86400',
        Urgency: 'normal',
        Authorization: `vapid t=${jwt}, k=${keys().vapid.publicKey}`,
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
    });
    req.on('error', e => resolve({ ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    req.end(payload);
  });
}

async function send(data) {
  const d = keys();
  const subs = d.subs || [];
  if (!subs.length) return { sent: 0, gone: 0 };
  const text = JSON.stringify(data);
  let sent = 0, gone = 0;
  for (const s of subs) {
    let payload;
    try { payload = encrypt(text, s.keys.p256dh, s.keys.auth); }
    catch { continue; }
    const r = await post(s.endpoint, payload);
    if (r.ok) sent++;
    else if (r.status === 404 || r.status === 410) { drop(s.endpoint); gone++; }
  }
  return { sent, gone };
}

module.exports = { publicKey, subscribe, drop, count, send, keys, subject, subjectStatus, audience, vapidJwt, PLACEHOLDER_SUBJECT };
