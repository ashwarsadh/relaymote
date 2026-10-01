// groups.js — sidebar groups, which live in TWO stores:
//
//   ORIGINAL  <profile>/Local Storage/leveldb, origin https://claude.ai,
//             key "LSS-persisted.dframe-group-scopes": the web app's own localStorage. The
//             sidebar renders from this.
//   MIRROR    <profile>/claude_desktop_config.json -> preferences.epitaxyPrefs["dframe-group-scopes"]:
//             pushed DOWN from the web app and never read back.
//
// A repair that writes only the mirror is overwritten the next time Desktop starts, so both are
// written, together, and only while Desktop is closed: Chromium holds the leveldb for the life of
// the process and rewrites the config from memory. Both stores hold every scope at once, so no
// scope's groups can be written while Desktop runs, active or not.
//
// Per scope, the stores are HEALED: localStorage > config > last snapshot, the lower layers only
// filling holes. That is always on, invisible and safe. FOLDING, bringing the groups and
// placements of the OTHER accounts into this one, is a different thing: it adds groups that
// exist only in one account, so it restructures a sidebar and is OFF unless `accounts.foldGroups`
// is set. When folding, a group whose name already exists in the target is mapped onto it rather
// than added twice, and groups/placements deleted in a scope are not brought back to it.
//
// A group deleted on purpose can be FORGOTTEN (forget()): it is then never restored by the heal
// or brought back by a fold.
//
// GATEWAY MODE (3p) is a third store: its own userData dir, its own leveldb under a different
// origin (expected app://localhost, discovered from the leveldb, never assumed), its own config
// mirror (created if missing) and its own snapshots. An empty Gateway scope is seeded ONCE from
// the subscription account used most recently; after that it is healed on its own, never folded.
//
// Every write re-checks, FRESH and immediately before the leveldb is opened, that Desktop is not
// running; apply() does this itself and refuses otherwise, whatever the caller believed.
// Reading always uses a throwaway copy of the leveldb, so a dry run never touches the live dir.
// The leveldb needs the optional `classic-level` package; without it groups are reported only.
// Windows: tested. macOS: same layout under ~/Library/Application Support/Claude, UNTESTED.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./core');
const pres = require('./presence');

const ORIGIN = 'https://claude.ai';
const ORIGIN_3P = 'app://localhost';   // expected for Gateway mode; always confirmed from the leveldb
const STORAGE_KEY = 'LSS-persisted.dframe-group-scopes';

function Level() { try { return require('classic-level').ClassicLevel; } catch { return null; } }
const available = () => !!Level();

const lsKey = (origin = ORIGIN) => Buffer.concat([Buffer.from('_' + origin, 'utf8'), Buffer.from([0x00, 0x01]), Buffer.from(STORAGE_KEY, 'utf8')]);
function decode(buf) {
  if (!buf || !buf.length) return null;
  if (buf[0] === 0x01) return buf.slice(1).toString('utf8');
  if (buf[0] === 0x00) return buf.slice(1).toString('utf16le');
  return buf.toString('utf8');
}
const encode = s => Buffer.concat([Buffer.from([0x01]), Buffer.from(s, 'utf8')]);

async function withDb(dir, fn) {
  const L = Level();
  if (!L) throw new Error('classic-level is not installed');
  const db = new L(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer', createIfMissing: false });
  await db.open();
  try { return await fn(db); } finally { await db.close(); }
}
async function readLs(dir, origin = ORIGIN) {
  return withDb(dir, async db => {
    let buf;
    try { buf = await db.get(lsKey(origin)); } catch (e) { if (e.code === 'LEVEL_NOT_FOUND') return null; throw e; }
    if (buf === undefined) return null;
    const wrapper = JSON.parse(decode(buf));
    if (!wrapper || typeof wrapper !== 'object' || !('value' in wrapper)) throw new Error('unexpected localStorage format; refusing to guess');
    let value = wrapper.value;
    const wasString = typeof value === 'string';
    if (wasString) value = JSON.parse(value);
    return { wrapper, scopes: value || {}, wasString };
  });
}
// Which origins hold the group key. Gateway mode's origin is read, never assumed.
async function discoverOrigins(dir) {
  const suffix = Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(STORAGE_KEY, 'utf8')]);
  return withDb(dir, async db => {
    const found = [];
    for await (const k of db.keys()) {
      if (k[0] !== 0x5f || k.length <= suffix.length) continue;
      if (!k.slice(k.length - suffix.length).equals(suffix)) continue;
      found.push(k.slice(1, k.length - suffix.length).toString('utf8'));
    }
    return found;
  });
}
function copyStore(dest, src) {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) if (f !== 'LOCK') fs.copyFileSync(path.join(src, f), path.join(dest, f));
  return dest;
}
async function onCopy(src, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relaymote-lss-'));
  try { copyStore(tmp, src); return await fn(tmp); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
const readLsCopy = (src, origin = ORIGIN) => onCopy(src, d => readLs(d, origin));

// createMirror (Gateway only): a fresh Gateway userData may have no config, or one without
// epitaxyPrefs, because its renderer has not pushed a preference yet. The mirror is write-only
// for the app, so creating it is harmless. For the 1p store a missing key stays an error: there
// it means we are looking at the wrong file.
function readConfig(file, createMirror = false) {
  let cfg = {};
  if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  else if (!createMirror) { const e = new Error('not found'); e.code = 'ENOENT'; throw e; }
  let ep = cfg.preferences && cfg.preferences.epitaxyPrefs;
  if (!ep) {
    if (!createMirror) return { cfg, ep: null, scopes: {}, wasString: false };
    cfg.preferences = cfg.preferences || {};
    ep = cfg.preferences.epitaxyPrefs = {};
  }
  let scopes = ep['dframe-group-scopes'];
  const wasString = typeof scopes === 'string';
  if (wasString) scopes = JSON.parse(scopes);
  return { cfg, ep, scopes: scopes && typeof scopes === 'object' ? scopes : {}, wasString };
}

const paths = prof => ({
  config: path.join(prof.dir, 'claude_desktop_config.json'),
  leveldb: path.join(prof.dir, 'Local Storage', 'leveldb'),
});
// A store = one leveldb + its config mirror + where its snapshots live.
function store1p() {
  const prof = core.groupsProfile(), p = paths(prof);
  return { id: '1p', profile: prof.dir, prefix: prof.prefix || '', origin: ORIGIN, createMirror: false, snapDir: core.SNAP_DIR, ...p };
}
function gatewayDir() {
  const appdata = path.dirname(core.PROFILE);
  const cands = process.platform === 'win32'
    ? [path.join(core.LOCALAPPDATA, 'Claude-3p'), path.join(appdata, 'Claude-3p')]
    : [path.join(appdata, 'Claude-3p')];
  return cands.find(d => fs.existsSync(path.join(d, 'Local Storage', 'leveldb')) || fs.existsSync(path.join(d, 'claude-code-sessions'))) || null;
}

async function readStores(prof) {
  const p = paths(prof);
  const out = { lib: available(), cfg: null, ls: null, errors: [] };
  try { out.cfg = readConfig(p.config); } catch (e) { out.errors.push('config: ' + (e.code === 'ENOENT' ? 'not found' : e.message)); }
  if (!out.lib) out.errors.push('localStorage: the optional classic-level package is not installed');
  else if (!fs.existsSync(p.leveldb)) out.errors.push('localStorage: no leveldb yet');
  else {
    try { out.ls = await readLsCopy(p.leveldb, prof.origin || ORIGIN); if (!out.ls) out.errors.push('localStorage: Desktop has not stored any groups yet'); }
    catch (e) { out.errors.push('localStorage: ' + e.message); }
  }
  return out;
}

// ---------------------------------------------------------------- merging
const gid = g => g.id || g.name;
const norm = s => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const count = s => ({ groups: ((s && s.groups) || []).length, assignments: Object.keys((s && s.assignments) || {}).length });

function mergeLayers(layers, dead) {
  const live = layers.find(Boolean) || {};
  const out = { groups: [], assignments: {}, order: {} };
  const seen = new Set();
  for (const l of layers) for (const g of (l && l.groups) || []) {
    const id = gid(g);
    if (!id || seen.has(id) || (dead && dead.has(id))) continue;
    seen.add(id); out.groups.push(g);
  }
  for (const l of layers.slice().reverse()) {
    Object.assign(out.assignments, (l && l.assignments) || {});
    Object.assign(out.order, (l && l.order) || {});
  }
  // A placement pointing at a forgotten group goes with it.
  if (dead && dead.size) {
    for (const [sk, g] of Object.entries(out.assignments)) if (dead.has(g)) delete out.assignments[sk];
    for (const g of Object.keys(out.order)) if (dead.has(g)) delete out.order[g];
  }
  return Object.assign({}, live, out);
}

function sameScope(a, b) {
  if (!a || !b) return false;
  const ids = x => (x.groups || []).map(gid).sort().join('\u0001');
  const asg = x => Object.entries(x.assignments || {}).sort().map(e => e.join('=')).join('\u0001');
  const ord = x => Object.entries(x.order || {}).sort().map(([k, v]) => k + ':' + (v || []).join(',')).join('\u0001');
  return ids(a) === ids(b) && asg(a) === asg(b) && ord(a) === ord(b);
}

function fold(target, sources, rules) {
  const out = { ...target, groups: (target.groups || []).map(g => ({ ...g })), assignments: { ...(target.assignments || {}) }, order: {} };
  for (const [k, v] of Object.entries(target.order || {})) out.order[k] = (v || []).slice();
  const ids = new Set(out.groups.map(gid));
  const byName = new Map(out.groups.map(g => [norm(g.name), gid(g)]).filter(([n]) => n));
  const n = { groups: 0, assignments: 0, moved: 0 };
  for (const src of sources) {
    const map = {};
    for (const g of (src.value.groups || [])) {
      const id = gid(g), name = norm(g.name);
      if (ids.has(id)) { map[id] = id; continue; }
      if (name && byName.has(name)) { map[id] = byName.get(name); continue; }
      if (rules.deadGroup(id, name)) continue;
      out.groups.push({ ...g }); ids.add(id); if (name) byName.set(name, id); map[id] = id; n.groups++;
    }
    for (const [sk, g] of Object.entries(src.value.assignments || {})) {
      const m = map[g]; if (!m) continue;
      const cur = out.assignments[sk];
      if (cur === undefined) {
        if (rules.deadAssign(sk)) continue;
        out.assignments[sk] = m; n.assignments++;
      } else if (cur !== m && rules.sourceNewer(src.key, sk)) {
        out.assignments[sk] = m; n.moved++;
        for (const k of Object.keys(out.order)) if (k !== m) out.order[k] = out.order[k].filter(x => x !== sk);
      }
    }
    for (const [g, arr] of Object.entries(src.value.order || {})) {
      const m = map[g]; if (!m) continue;
      const cur = out.order[m] || [];
      for (const sk of arr || []) if (!cur.includes(sk) && out.assignments[sk] === m) cur.push(sk);
      out.order[m] = cur;
    }
  }
  return { value: out, counts: n };
}

// What a fold WOULD add from the other scopes, so a preview can say what folding would change.
function foldPreview(target, sources, rules) {
  return fold(target, sources, rules).counts;
}

const snapFile = (snapDir, groupKey) => path.join(snapDir, groupKey.replace(/[\\/]/g, '__') + '.json');
const snapPath = key => snapFile(core.SNAP_DIR, key);
const readSnap = (snapDir, groupKey) => core.readJson(snapFile(snapDir, groupKey), null);

// ---------------------------------------------------------------- plan
async function plan(state, scopes, ctx) {
  const res = { lines: [], actions: [], status: 'ok', counts: {}, gateway: null };
  const one = await plan1p(state, scopes, ctx);
  Object.assign(res, { status: one.status, counts: one.counts, profile: one.profile });
  res.lines.push(...one.lines); res.actions.push(...one.actions);
  try {
    const g = await plan3p(state, scopes, ctx);
    res.gateway = { status: g.status, origin: g.origin || null, scope: g.scope || null };
    res.lines.push(...g.lines); res.actions.push(...g.actions);
    if (g.scope) res.counts['3p:' + g.scope] = g.count;
  } catch (e) { res.gateway = { status: 'error' }; res.lines.push('groups (Gateway mode): ' + e.message); }
  return res;
}

async function plan1p(state, scopes, ctx) {
  const st1 = store1p();
  const targets = scopes.filter(s => s.mode === '1p' && s.prefix === (st1.prefix || ''));
  const res = { lines: [], actions: [], status: 'ok', counts: {}, profile: st1.profile };
  if (!targets.length) { res.status = 'none'; return res; }
  const st = await readStores({ dir: st1.profile, origin: ORIGIN });
  const cfgScopes = (st.cfg && st.cfg.scopes) || {}, lsScopes = (st.ls && st.ls.scopes) || null;
  for (const s of targets) res.counts[s.key] = count(lsScopes ? lsScopes[s.groupKey] : cfgScopes[s.groupKey]);
  if (!st.ls || !st.cfg || !st.cfg.ep) {
    res.status = st.lib ? 'unreadable' : 'unavailable';
    res.lines.push('groups: reported only - ' + (st.errors.join('; ') || 'config has no group preferences yet'));
    return res;
  }
  const judge = ctx.groupsWritable;
  const syncedG = new Set(Object.keys(state.syncedGroupIds || {})), syncedA = new Set(Object.keys(state.syncedAssignIds || {}));
  const healed = {}, forgot = {};
  for (const s of targets) {
    const snap = readSnap(st1.snapDir, s.groupKey);
    const ls = lsScopes[s.groupKey];
    const names = {}; for (const g of (ls && ls.groups) || []) names[gid(g)] = norm(g.name);
    if (ls) {
      const opts = ids => ({ now: ctx.now, syncedIds: ids, noTombstones: !judge, noTombstonesReason: 'groups are only judged while Desktop is closed' });
      const asg = {};
      for (const [sk, g] of Object.entries(ls.assignments || {})) asg[sk] = names[g] || '';
      for (const ch of [core.observe(state, s.key, 'groups', names, opts(syncedG)), core.observe(state, s.key, 'assign', asg, opts(syncedA))]) {
        if (ch.tombstonesRefused && judge) res.lines.push(ctx.label(s) + ': ' + ch.tombstonesRefused.ids.length + ' group item(s) vanished, not treated as deletions (' + ch.tombstonesRefused.reason + ')');
      }
    }
    forgot[s.key] = { ids: new Set((snap && snap.forgotten) || []), names: new Set(((snap && snap.forgottenNames) || []).map(norm)) };
    const dead = new Set([...forgot[s.key].ids, ...Object.keys(core.tombBucket(state, s.key, 'groups'))]);
    healed[s.key] = mergeLayers([ls, cfgScopes[s.groupKey], snap], dead);
  }
  const folding = !!ctx.foldGroups;
  for (const s of targets) {
    const role = ctx.roleOf ? ctx.roleOf(s.key) : 'two-way';
    if (role === 'keep') continue;
    const tombG = core.tombBucket(state, s.key, 'groups');
    const deadNames = new Set([...Object.values(tombG).map(t => t.lastValue).filter(Boolean), ...forgot[s.key].names]);
    const rules = {
      deadGroup: (id, name) => !!tombG[id] || forgot[s.key].ids.has(id) || (name && deadNames.has(name)),
      deadAssign: sk => !!core.deletedHere(state, s.key, 'assign', sk),
      sourceNewer: (srcKey, sk) => {
        if (role !== 'two-way') return false;
        const a = core.changedAtOf(state, srcKey, 'assign', sk), b = core.changedAtOf(state, s.key, 'assign', sk);
        return !!(a && b && a !== b && Date.parse(a) > Date.parse(b));
      },
    };
    const others = targets.filter(o => o.key !== s.key).map(o => ({ key: o.key, value: healed[o.key] }));
    let value = healed[s.key], counts = { groups: 0, assignments: 0, moved: 0 };
    if (folding) ({ value, counts } = fold(healed[s.key], others, rules));
    else {
      const would = foldPreview(healed[s.key], others, rules);
      if (would.groups || would.assignments) {
        res.lines.push(ctx.label(s) + ': ' + would.groups + ' group(s) and ' + would.assignments + ' placement(s) exist only in other accounts - not added, because folding sidebar groups across accounts is off');
      }
    }
    const lsCur = lsScopes[s.groupKey], cfgCur = cfgScopes[s.groupKey];
    if (sameScope(value, lsCur) && sameScope(value, cfgCur)) continue;
    const before = count(lsCur);
    res.actions.push({
      kind: 'groups', op: 'groups', to: s.key, groupKey: s.groupKey, value, pending: !ctx.groupsWritable, store: st1,
      addGroups: Math.max(0, value.groups.length - before.groups), addAssignments: Math.max(0, Object.keys(value.assignments).length - before.assignments),
      moved: counts.moved, mirrorOnly: sameScope(value, lsCur), healOnly: !folding,
    });
  }
  return res;
}

// ---------------------------------------------------------------- Gateway mode (3p)
// Nothing is assumed about a store that may never have been set up: the dir is never created,
// the origin must be the ONLY one holding the key, and the scope must be nameable from the value
// or from exactly one <account>/<org> under the Gateway sessions dir.
async function discover3p(dir) {
  const leveldb = path.join(dir, 'Local Storage', 'leveldb');
  const res = await onCopy(leveldb, async copy => {
    const origins = await discoverOrigins(copy);
    if (origins.length !== 1) return { ok: false, origins, why: origins.length ? 'more than one origin holds the group key: ' + origins.join(', ') : 'Gateway mode has not stored any groups yet' };
    return { ok: true, origins, origin: origins[0], read: await readLs(copy, origins[0]) };
  });
  if (!res.ok) return res;
  const inValue = Object.keys((res.read && res.read.scopes) || {});
  let scope = inValue.length === 1 ? inValue[0] : null;
  if (!scope && inValue.length === 0) {
    const pairs = [], root = path.join(dir, 'claude-code-sessions');
    try {
      for (const a of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()))
        for (const o of fs.readdirSync(path.join(root, a.name), { withFileTypes: true }).filter(d => d.isDirectory())) pairs.push(a.name + '/' + o.name);
    } catch {}
    if (pairs.length === 1) scope = pairs[0];
    else return { ...res, ok: false, why: 'cannot name the Gateway scope: the stored value holds none and the sessions folder holds ' + pairs.length };
  }
  if (!scope) return { ...res, ok: false, why: 'cannot name the Gateway scope: the stored value holds ' + inValue.length + ' scopes' };
  const current = (res.read && res.read.scopes[scope]) || null;
  return { ...res, scope, current, empty: !current || !(current.groups || []).length };
}

// The subscription account used most recently: the 1p scope with the newest session record.
async function seedFrom1p(scopes) {
  const st1 = store1p();
  let best = null, bestMs = 0;
  for (const s of scopes.filter(x => x.mode === '1p' && x.prefix === st1.prefix)) {
    const ms = core.newestWriteMs(s); if (ms > bestMs) { bestMs = ms; best = s; }
  }
  if (!best || !fs.existsSync(st1.leveldb)) return null;
  const r = await readLsCopy(st1.leveldb, ORIGIN);
  const v = r && r.scopes[best.groupKey];
  if (!v || !(v.groups || []).length) return null;
  return { from: best.key, value: { groups: v.groups, assignments: v.assignments || {}, order: v.order || {} } };
}

async function plan3p(state, scopes, ctx) {
  const res = { lines: [], actions: [], status: 'absent', count: null };
  const dir = gatewayDir();
  if (!dir) return res;
  const leveldb = path.join(dir, 'Local Storage', 'leveldb');
  if (!fs.existsSync(leveldb)) { res.lines.push('groups (Gateway mode): no localStorage yet - nothing to do'); return res; }
  if (!available()) { res.status = 'unavailable'; return res; }
  const d = await discover3p(dir);
  if (!d.ok) { res.status = 'waiting'; res.lines.push('groups (Gateway mode): waiting - ' + d.why); return res; }
  Object.assign(res, { status: 'ok', origin: d.origin, scope: d.scope });
  const key = '3p:' + d.scope;
  const store = { id: '3p', profile: dir, prefix: '3p:', origin: d.origin, createMirror: true, snapDir: core.SNAP_DIR_3P, ...paths({ dir }) };
  const role = ctx.roleOf ? ctx.roleOf(key) : 'add';
  let cfg; try { cfg = readConfig(store.config, true); } catch (e) { res.status = 'unreadable'; res.lines.push('groups (Gateway mode): config unreadable - ' + e.message); return res; }
  const snap = readSnap(store.snapDir, d.scope);
  const cfgCur = cfg.scopes[d.scope];
  res.count = count(d.current);
  if (role === 'keep') return res;
  let seed = null;
  const seededBefore = (state.gatewaySeeded || {})[key];
  if (d.empty && !seededBefore) {
    seed = await seedFrom1p(scopes);
    if (seed) res.lines.push('groups (Gateway mode): the empty Gateway scope will be seeded once from ' + ctx.label(scopes.find(s => s.key === seed.from)) + ' (' + seed.value.groups.length + ' groups)');
  }
  const dead = new Set((snap && snap.forgotten) || []);
  const value = mergeLayers([d.current, cfgCur, snap, seed && seed.value], dead);
  if (sameScope(value, d.current) && sameScope(value, cfgCur)) return res;
  const before = count(d.current);
  res.actions.push({
    kind: 'groups', op: 'groups', to: key, groupKey: d.scope, value, pending: !ctx.groupsWritable, store,
    addGroups: Math.max(0, value.groups.length - before.groups), addAssignments: Math.max(0, Object.keys(value.assignments).length - before.assignments),
    moved: 0, mirrorOnly: sameScope(value, d.current), seeded: !!seed, healOnly: true,
  });
  return res;
}

// ---------------------------------------------------------------- apply (Desktop must be closed)
// `opts.presence` may be an injected probe FUNCTION. Anything else (nothing, or a state string
// someone measured earlier) means the real probe: this is the check that permits opening the
// leveldb, so it is taken here, fresh, immediately before the open, and it cannot be handed down.
function freshProbe(opts) {
  if (opts && typeof opts.presence === 'function') return pres.resolver(opts.presence);
  return () => pres.presence({ fresh: true });
}

function backupStore(store, reason) {
  const dir = path.join(core.BACKUP_DIR, 'groups-' + core.stamp() + (store.id === '3p' ? '-3p' : ''));
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(store.config)) fs.copyFileSync(store.config, path.join(dir, 'claude_desktop_config.json'));
  else fs.writeFileSync(path.join(dir, 'claude_desktop_config.json'), '{}');
  copyStore(path.join(dir, 'leveldb'), store.leveldb);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    at: new Date().toISOString(), reason, store: store.id, profile: store.profile, origin: store.origin,
    config: store.config, leveldb: store.leveldb, configExisted: fs.existsSync(store.config),
  }, null, 1));
  return dir;
}

async function apply(state, actions, journal, opts = {}) {
  const lines = [], wrote = [];
  if (!actions.length) return { lines, wrote };
  const probe = freshProbe(opts);
  const byStore = new Map();
  for (const a of actions) {
    const st = a.store || store1p();
    const k = st.leveldb + '|' + st.origin;
    if (!byStore.has(k)) byStore.set(k, { store: st, actions: [] });
    byStore.get(k).actions.push(a);
  }
  for (const { store, actions: acts } of byStore.values()) {
    // The ONLY check that permits this write. Fresh, inside the caller's lock, right before the
    // backup copy and the open. If Desktop is anything but confirmed absent, nothing is written.
    const p = await probe({ fresh: true });
    if (!pres.safeToWriteAll(p.state)) {
      throw new Error('Claude Desktop is ' + p.state + ' (checked just before opening its storage) - no group was written');
    }
    const pre = readConfig(store.config, store.createMirror);
    if (!pre.ep) throw new Error('the config has no group preferences yet; nothing written');
    const dir = backupStore(store, 'before-sync');
    journal.push({ kind: 'groups', op: 'stores', backup: dir, profile: store.profile, store: store.id, origin: store.origin, config: store.config, leveldb: store.leveldb });
    lines.push('groups' + (store.id === '3p' ? ' (Gateway mode)' : '') + ': backed up both stores to ' + dir);

    await withDb(store.leveldb, async db => {
      let buf; try { buf = await db.get(lsKey(store.origin)); } catch (e) { if (e.code !== 'LEVEL_NOT_FOUND') throw e; }
      if (!buf) throw new Error('the group key disappeared from localStorage; nothing written');
      const wrapper = JSON.parse(decode(buf));
      const wasString = typeof wrapper.value === 'string';
      const scopes = (wasString ? JSON.parse(wrapper.value) : wrapper.value) || {};
      for (const a of acts) scopes[a.groupKey] = a.value;
      wrapper.value = wasString ? JSON.stringify(scopes) : scopes;
      await db.put(lsKey(store.origin), encode(JSON.stringify(wrapper)));
    });
    const c = readConfig(store.config, store.createMirror);   // re-read: never write a stale object
    for (const a of acts) c.scopes[a.groupKey] = a.value;
    c.ep['dframe-group-scopes'] = c.wasString ? JSON.stringify(c.scopes) : c.scopes;
    core.writeJsonAtomic(store.config, c.cfg);

    core.ensureDir(store.snapDir);
    state.syncedGroupIds = state.syncedGroupIds || {};
    state.syncedAssignIds = state.syncedAssignIds || {};
    const now = new Date().toISOString();
    for (const a of acts) {
      const old = readSnap(store.snapDir, a.groupKey) || {};
      core.writeJsonAtomic(snapFile(store.snapDir, a.groupKey), { scope: a.groupKey, savedAt: now, groups: a.value.groups, assignments: a.value.assignments, order: a.value.order,
        forgotten: old.forgotten || [], forgottenNames: old.forgottenNames || [] });
      if (store.id === '3p') {
        if (a.seeded) { state.gatewaySeeded = state.gatewaySeeded || {}; state.gatewaySeeded[a.to] = now; }
        continue;
      }
      for (const g of a.value.groups) state.syncedGroupIds[gid(g)] = now;
      for (const sk of Object.keys(a.value.assignments)) state.syncedAssignIds[sk] = now;
    }
    const back = await readLs(store.leveldb, store.origin), cfgBack = readConfig(store.config, store.createMirror);
    for (const a of acts) {
      const want = count(a.value), gotLs = count(back && back.scopes[a.groupKey]), gotCfg = count(cfgBack.scopes[a.groupKey]);
      const ok = gotLs.groups === want.groups && gotLs.assignments === want.assignments && gotCfg.groups === want.groups && gotCfg.assignments === want.assignments;
      lines.push('groups: ' + a.to.slice(0, 11) + ' now ' + want.groups + ' groups, ' + want.assignments + ' assignments' + (ok ? ' (verified in both stores)' : ' - MISMATCH on re-read'));
      wrote.push({ store: { id: store.id, profile: store.profile, origin: store.origin, config: store.config, leveldb: store.leveldb, createMirror: store.createMirror },
                   groupKey: a.groupKey, to: a.to, want, ok });
    }
  }
  pruneGroupBackups(10);
  return { lines, wrote };
}

function pruneGroupBackups(keep) {
  let dirs = []; try { dirs = fs.readdirSync(core.BACKUP_DIR).filter(d => d.startsWith('groups-')).sort(); } catch { return; }
  for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) { try { fs.rmSync(path.join(core.BACKUP_DIR, d), { recursive: true, force: true }); } catch {} }
}

// ---------------------------------------------------------------- restore / undo
// Every write left a backup of BOTH stores. Restoring one first backs up what is there now, so
// an undo is itself undoable.
function listBackups() {
  let dirs = []; try { dirs = fs.readdirSync(core.BACKUP_DIR).filter(d => d.startsWith('groups-')).sort(); } catch { return []; }
  return dirs.map(d => {
    const dir = path.join(core.BACKUP_DIR, d);
    const meta = core.readJson(path.join(dir, 'meta.json'), null);
    return { stamp: d.slice('groups-'.length), dir, meta, complete: !!meta && fs.existsSync(path.join(dir, 'leveldb')) && fs.existsSync(path.join(dir, 'claude_desktop_config.json')) };
  }).filter(b => b.complete);
}

// entry: a journal 'stores' entry, or a backup from listBackups().
async function restore(entry, opts = {}) {
  const src = entry.dir || entry.backup;
  const meta = entry.meta || core.readJson(path.join(src, 'meta.json'), null) || entry;
  const store = {
    id: meta.store || '1p', profile: meta.profile, origin: meta.origin || ORIGIN,
    config: meta.config || path.join(meta.profile, 'claude_desktop_config.json'),
    leveldb: meta.leveldb || path.join(meta.profile, 'Local Storage', 'leveldb'),
  };
  const p = await freshProbe(opts)({ fresh: true });
  if (!pres.safeToWriteAll(p.state)) throw new Error('Claude Desktop is ' + p.state + ' - close it first; nothing was restored');
  const before = backupStore(store, 'before-restore');
  const cfgSrc = path.join(src, 'claude_desktop_config.json');
  if (meta.configExisted === false) fs.rmSync(store.config, { force: true });
  else fs.copyFileSync(cfgSrc, store.config);
  for (const f of fs.readdirSync(store.leveldb)) if (f !== 'LOCK') fs.rmSync(path.join(store.leveldb, f), { force: true });
  copyStore(store.leveldb, path.join(src, 'leveldb'));
  return { restored: src, savedCurrentAs: before };
}

async function restoreBackup(stamp, opts = {}) {
  const all = listBackups();
  const pick = !stamp || stamp === 'latest' ? all[all.length - 1] : all.find(b => b.stamp === stamp || path.basename(b.dir) === stamp);
  if (!pick) return { ok: false, error: 'NO_BACKUP', available: all.map(b => b.stamp) };
  try { const r = await restore(pick, opts); return { ok: true, stamp: pick.stamp, ...r }; }
  catch (e) { return { ok: false, error: 'REFUSED', message: e.message }; }
}

// ---------------------------------------------------------------- forget a deliberate deletion
// scopeKey: '<account>/<org>' or '3p:<account>/<org>'. The group is dropped from the snapshot and
// remembered as forgotten, so no heal restores it and no fold brings it back.
function forget(scopeKey, groupId) {
  if (!scopeKey || !groupId) return { ok: false, error: 'scope and group id required' };
  const is3p = /^3p:/.test(scopeKey);
  const groupKey = scopeKey.replace(/^(msix3p|msix|3p):/, '');
  const snapDir = is3p ? core.SNAP_DIR_3P : core.SNAP_DIR;
  core.ensureDir(snapDir);
  const snap = readSnap(snapDir, groupKey) || { scope: groupKey, groups: [], assignments: {}, order: {} };
  let g = (snap.groups || []).find(x => gid(x) === groupId);
  // The group may exist only in the config mirror (the snapshot is written after a sync): read its
  // name there too, so a fold from another account cannot bring it back under the same name.
  if (!g) {
    try {
      const dir = is3p ? gatewayDir() : store1p().profile;
      const c = dir && readConfig(path.join(dir, 'claude_desktop_config.json'));
      g = c && ((c.scopes[groupKey] && c.scopes[groupKey].groups) || []).find(x => gid(x) === groupId);
    } catch { /* no mirror: the id alone is remembered */ }
  }
  snap.forgotten = Array.from(new Set((snap.forgotten || []).concat([groupId])));
  if (g && g.name) snap.forgottenNames = Array.from(new Set((snap.forgottenNames || []).concat([norm(g.name)])));
  snap.groups = (snap.groups || []).filter(x => gid(x) !== groupId);
  for (const [sk, v] of Object.entries(snap.assignments || {})) if (v === groupId) delete snap.assignments[sk];
  if (snap.order) delete snap.order[groupId];
  core.writeJsonAtomic(snapFile(snapDir, groupKey), snap);
  core.log('FORGET group ' + groupId + ' in ' + scopeKey);
  return { ok: true, forgotten: snap.forgotten, message: 'Group ' + groupId + ' will not be restored or brought back in ' + scopeKey };
}

// ---------------------------------------------------------------- counting (relaunch check)
async function countStore(store) {
  const out = {};
  let ls = null, cfg = { scopes: {} };
  try { ls = await readLsCopy(store.leveldb, store.origin); } catch {}
  try { cfg = readConfig(store.config, !!store.createMirror); } catch {}
  for (const k of new Set([...Object.keys((ls && ls.scopes) || {}), ...Object.keys(cfg.scopes || {})])) {
    out[k] = { localStorage: count(ls && ls.scopes[k]), config: count(cfg.scopes[k]) };
  }
  return out;
}

module.exports = {
  ORIGIN, ORIGIN_3P, STORAGE_KEY, available, plan, apply, restore, restoreBackup, listBackups, forget, countStore,
  readStores, readConfig, readLs, readLsCopy, discoverOrigins, discover3p, gatewayDir, store1p,
  mergeLayers, fold, sameScope, norm, lsKey, encode, decode, count, snapPath, snapFile,
};
