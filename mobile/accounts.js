'use strict';
// The Accounts screen: several Claude accounts on one computer, kept looking the same.
// All reading and writing is done by lib/account-sync (dry run unless asked to apply).

const config = require('../lib/config');
const sync = require('../lib/account-sync');
const cycle = require('../lib/account-sync/desktop-cycle');
const launch = require('../lib/account-sync/launch');

const MODES = ['add', 'two-way'];
const ROLES = ['keep', 'add', 'two-way'];
const FIRST_RUN = ['baseline', 'archived-wins'];

function runOpts(body) {
  const o = {};
  if (MODES.includes(body.mode)) o.mode = body.mode;
  if (typeof body.target === 'string' && body.target) o.target = body.target;
  return o;
}

async function readAccounts() {
  const st = await sync.status();
  let hook = null;
  try { hook = await launch.hookStatus(); } catch {}
  return {
    ...st,
    settings: config.get().accounts || {},
    auto: sync.autoStatus(),
    journals: sync.journals().slice(0, 5),
    cycleSupported: process.platform === 'win32',
    manualSteps: cycle.MANUAL,
    advanced: {
      hold: sync.core.held(),
      frozen: sync.core.frozenIds(),
      groupBackups: sync.groupBackups().slice(-5).reverse(),
      verifyPending: sync.verify.pending() ? { at: sync.verify.pending().at } : null,
      launchHook: hook,
      lockFile: sync.core.lockFile(),
    },
  };
}

function syncNow(body = {}) {
  return sync.run({ ...runOpts(body), apply: body.dryRun === false });
}

function saveSettings(body = {}) {
  const a = {};
  for (const k of ['enabled', 'autoSync', 'foldGroups', 'syncArchive', 'syncState']) if (typeof body[k] === 'boolean') a[k] = body[k];
  if (Number(body.intervalMinutes) >= 5) a.intervalMinutes = Math.min(1440, Math.round(Number(body.intervalMinutes)));
  if (MODES.includes(body.mode)) a.mode = body.mode;
  if (FIRST_RUN.includes(body.firstRunMode)) a.firstRunMode = body.firstRunMode;
  if (typeof body.lockFile === 'string') a.lockFile = body.lockFile.trim();
  if (body.scope === 'all') a.scope = 'all';
  else if (Array.isArray(body.scope)) a.scope = body.scope.filter(x => typeof x === 'string');
  if (body.roles && typeof body.roles === 'object') {
    a.roles = {};
    for (const [k, v] of Object.entries(body.roles)) a.roles[k] = ROLES.includes(v) ? v : null;
  }
  return config.set({ accounts: a }, 'accounts').accounts;
}

function setLabel(body = {}) {
  if (!body.scope || typeof body.scope !== 'string') return { ok: false, error: 'scope required' };
  return { ok: true, labels: sync.setLabel(body.scope, body.label || '') };
}

// `running` lists the sessions that closing Claude Desktop would stop; the caller supplies it.
function closeSyncReopen(body = {}, running) {
  return cycle.closeSyncReopen({
    confirm: body.confirm, force: !!body.force, forceConfirm: body.forceConfirm,
    reopen: body.reopen !== false, runOpts: runOpts(body),
  }, { running, sync: o => sync.run(o) });
}

// The Advanced section: POST /api/accounts/<action>. Returns null for an action it does not know.
async function handle(p, body = {}) {
  const act = p.replace(/^\/api\/accounts\//, '');
  const done = r => ({ status: r && r.ok === false ? 409 : 200, body: r });
  switch (act) {
    case 'hold': return done(sync.setHold(!!body.on));
    case 'freeze': return done(body.on === false ? sync.unfreeze(String(body.id || '')) : sync.freeze(String(body.id || ''), body.why));
    case 'undo': {
      const j = body.journal || sync.journals()[0];
      if (!j) return done({ ok: false, error: 'NO_JOURNAL', message: 'Nothing has been synced yet.' });
      return done(await sync.undo(j));
    }
    case 'groups-restore': return done(await sync.restoreGroups(body.stamp || 'latest'));
    case 'forget': return done(sync.forgetGroup(String(body.scope || ''), String(body.group || '')));
    case 'launch-hook': return done(body.on ? await launch.hookInstall() : await launch.hookRemove());
    default: return null;
  }
}

module.exports = { readAccounts, syncNow, saveSettings, setLabel, closeSyncReopen, handle };
