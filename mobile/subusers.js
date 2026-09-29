'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../lib/config');

const FILE = path.join(config.MOBILE, 'subusers.json');

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
function writeAll(db) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, FILE);
}

function list() {
  const db = readAll();
  return Object.entries(db).map(([token, r]) => ({ token, ...r }));
}

function find(token) {
  if (!token || typeof token !== 'string') return null;
  const db = readAll();
  // Own keys only: "constructor", "__proto__", "toString"… are on every object, and db[token] for one
  // of them used to come back as an unrevoked sub-user, so ?k=constructor signed anyone in.
  if (!Object.prototype.hasOwnProperty.call(db, token)) return null;
  const r = db[token];
  if (!r || typeof r !== 'object' || r.revoked) return null;
  return { token, name: r.name, sessions: new Set(r.sessions || []) };
}

function mintToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function create(name, sessionIds) {
  const db = readAll();
  const token = mintToken();
  db[token] = { name: String(name), sessions: [...new Set(sessionIds || [])], createdAt: new Date().toISOString(), revoked: false };
  writeAll(db);
  return { token, ...db[token] };
}

function grant(name, sessionIds) {
  const db = readAll();
  const entry = Object.entries(db).find(([, r]) => r.name === name && !r.revoked);
  if (!entry) return { ok: false, error: 'NOT_FOUND' };
  const [token, r] = entry;
  r.sessions = [...new Set([...(r.sessions || []), ...sessionIds])];
  writeAll(db);
  return { ok: true, token, ...r };
}

function revokeSessions(name, sessionIds) {
  const db = readAll();
  const entry = Object.entries(db).find(([, r]) => r.name === name && !r.revoked);
  if (!entry) return { ok: false, error: 'NOT_FOUND' };
  const [token, r] = entry;
  const drop = new Set(sessionIds);
  r.sessions = (r.sessions || []).filter(id => !drop.has(id));
  writeAll(db);
  return { ok: true, token, ...r };
}

// Every live record with that name: a name reused after an earlier revoke has two records, and taking
// the first one re-revoked the old record and left the live link working while reporting success.
function revoke(name) {
  const db = readAll();
  const all = Object.values(db).filter(r => r.name === name);
  if (!all.length) return { ok: false, error: 'NOT_FOUND' };
  const live = all.filter(r => !r.revoked);
  for (const r of live) r.revoked = true;
  if (live.length) writeAll(db);
  return { ok: true, revoked: live.length };
}

function remove(name) {
  const db = readAll();
  const entry = Object.entries(db).find(([, r]) => r.name === name);
  if (!entry) return { ok: false, error: 'NOT_FOUND' };
  delete db[entry[0]];
  writeAll(db);
  return { ok: true };
}

module.exports = { list, find, create, grant, revokeSessions, revoke, remove };

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  const PORT = Number(process.env.RELAYMOTE_MOBILE_PORT || require('../lib/config').get().appPort);
  const printLink = (token) => {
    console.log('  link: http://<this-machine>:' + PORT + '/?k=' + token);
    console.log('  (or through your public URL, if remote access is set up: https://<your-domain>/?k=' + token + ')');
  };
  if (cmd === 'create') {
    const [name, ...ids] = rest;
    if (!name || !ids.length) { console.error('usage: node subusers.js create "<name>" <sessionId...>'); process.exit(1); }
    const r = create(name, ids);
    console.log(`created "${r.name}" with ${r.sessions.length} session(s) granted.`);
    printLink(r.token);
  } else if (cmd === 'grant') {
    const [name, ...ids] = rest;
    const r = grant(name, ids);
    if (!r.ok) { console.error('no such sub-user: ' + name); process.exit(1); }
    console.log(`"${name}" now has ${r.sessions.length} session(s) granted.`);
  } else if (cmd === 'revoke-sessions') {
    const [name, ...ids] = rest;
    const r = revokeSessions(name, ids);
    if (!r.ok) { console.error('no such sub-user: ' + name); process.exit(1); }
    console.log(`"${name}" now has ${r.sessions.length} session(s) granted.`);
  } else if (cmd === 'revoke') {
    const [name] = rest;
    const r = revoke(name);
    if (!r.ok) { console.error('no such sub-user: ' + name); process.exit(1); }
    console.log(`"${name}" revoked. Their link stops working immediately.`);
  } else if (cmd === 'remove') {
    const [name] = rest;
    const r = remove(name);
    if (!r.ok) { console.error('no such sub-user: ' + name); process.exit(1); }
    console.log(`"${name}" removed from the record entirely.`);
  } else if (cmd === 'list') {
    for (const r of list()) {
      console.log(`${r.revoked ? '(revoked) ' : ''}${r.name}  —  ${r.sessions.length} session(s)  —  created ${r.createdAt}`);
      for (const id of r.sessions) console.log('    ' + id);
    }
  } else {
    console.log('usage:');
    console.log('  node subusers.js create "<name>" <sessionId...>');
    console.log('  node subusers.js grant "<name>" <sessionId...>');
    console.log('  node subusers.js revoke-sessions "<name>" <sessionId...>');
    console.log('  node subusers.js revoke "<name>"');
    console.log('  node subusers.js list');
  }
}
