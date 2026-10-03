'use strict';
// New session = ONE call to Claude Desktop's own LocalSessions.start (the call its New button makes),
// with the folder, model id, effort and permission mode, then a read-back of what Desktop recorded.
//
// g1131 (04-Oct): this used to drive the New-session view with clicks. That could only pick a folder
// from Desktop's recent-folders list ("my pc" refused), read model names with the menu's shortcut
// digit glued on ("Sonnet 5.53", so Sonnet was refused), took 10-40 s, and a slow run left him on
// "Creating…" while the session started anyway. start() takes any folder that exists, takes the
// model by id, and returns the session id in well under a second.
const fs = require('fs');
const path = require('path');
const desktop = require('../lib/desktop');
const gui = require('../lib/gui-worker');

const FAMILIES = /^(opus|sonnet|haiku|fable)\b/i;

// "Sonnet 5.5" / "sonnet" / "claude-sonnet-5-5" -> a model id Desktop accepts. `ids` is the live
// picker's { label: id } (read with listModels); a label it lacks is derived, never guessed silently.
function resolveModel(model, ids = {}) {
  const key = String(model || '').trim();
  if (!key) return { ok: true, id: undefined };
  if (/^claude-/i.test(key)) return { ok: true, id: key.toLowerCase() };
  const byLabel = Object.entries(ids).find(([label]) => label.toLowerCase() === key.toLowerCase());
  if (byLabel && byLabel[1]) return { ok: true, id: byLabel[1], label: byLabel[0] };
  const fam = (key.match(FAMILIES) || [])[1];
  if (!fam) return { ok: false, error: 'BAD_MODEL', message: `"${key}" is not a model this app knows (offered: ${Object.keys(ids).join(', ') || 'none read yet'}).` };
  const ver = key.match(/(\d+)\.(\d+)/);
  if (!ver) {
    const first = Object.entries(ids).find(([label]) => label.toLowerCase().startsWith(fam.toLowerCase()));
    if (first && first[1]) return { ok: true, id: first[1], label: first[0] };
    return { ok: false, error: 'BAD_MODEL', message: `No ${fam} model is offered right now.` };
  }
  const derived = `claude-${fam.toLowerCase()}-${ver[1]}-${ver[2]}`;
  const near = Object.values(ids).find(v => v && v.startsWith(derived));
  return { ok: true, id: near || derived, label: key };
}

// The picker's label -> id map the server saves with the model list (callers other than the phone,
// such as the goal chaser's spawn, do not pass one).
function savedModelIds() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(require('../lib/config').STATE, 'models.json'), 'utf8'));
    return (j && j.ids && typeof j.ids === 'object') ? j.ids : {};
  } catch { return {}; }
}

const sameDir = (a, b) => path.resolve(String(a || '')).replace(/[\\/]+$/, '').toLowerCase()
                       === path.resolve(String(b || '')).replace(/[\\/]+$/, '').toLowerCase();

async function newSession(opts = {}) {
  const { cwd, prompt, model, effort, group, dryRun, modelIds } = opts;
  const t0 = Date.now();
  if (!cwd) return { ok: false, error: 'NO_CWD', message: 'Pick a folder.' };
  if (!String(prompt || '').trim() && !dryRun) return { ok: false, error: 'EMPTY_PROMPT', message: 'Type something to start with.' };
  if (String(prompt || '').length > gui.MAX_PROMPT_CHARS) {
    return { ok: false, error: 'PROMPT_TOO_LONG',
             message: `${prompt.length} characters exceeds the ${gui.MAX_PROMPT_CHARS} the composer is trusted with.` };
  }
  // Everything that can refuse is checked BEFORE anything is created, so a refusal leaves nothing.
  let st = null;
  try { st = fs.statSync(cwd); } catch {}
  if (!st || !st.isDirectory()) {
    return { ok: false, error: 'FOLDER_MISSING', message: `The folder "${cwd}" does not exist on the PC (a removed worktree?). Nothing was created.` };
  }
  const m = resolveModel(model, modelIds || savedModelIds());
  if (!m.ok) return { ...m, message: m.message + ' Nothing was created.' };
  const wantEffort = effort && !/haiku/i.test(m.id || '') ? String(effort).toLowerCase() : undefined;
  if (dryRun) {
    return { ok: true, dryRun: true, cwd, model: m.id, effort: wantEffort || null,
             note: 'Folder and model checked. No session was created.' };
  }
  if (!(await desktop.cdpAvailable())) {
    return { ok: false, error: 'CDP_UNAVAILABLE', message: "Claude Desktop's debugger is not reachable on 127.0.0.1:9229. Nothing was created." };
  }

  const conn = await desktop.connect(await desktop.wsUrl(), { evalTimeout: 30000 });
  try {
    const CID = await desktop.pickChat(conn);
    const LS = `window['claude.web'].LocalSessions`;
    const args = { cwd, message: String(prompt), permissionMode: 'bypassPermissions' };
    if (m.id) args.model = m.id;
    if (wantEffort) args.effort = wantEffort;
    const started = JSON.parse(await conn.evaluate(desktop.rEval(CID, `(async function(){
      try { var r = await ${LS}.start(${JSON.stringify(args)}); return JSON.stringify({ ok: true, sessionId: r && r.sessionId }); }
      catch (e) { return JSON.stringify({ ok: false, message: String(e && e.message || e) }); }
    })()`)) || '{}');
    if (!started.ok || !started.sessionId) {
      return { ok: false, error: 'START_FAILED',
               message: 'Claude Desktop refused to start the session: ' + (started.message || 'no session id returned') + '. Nothing was created.' };
    }
    const sid = started.sessionId;

    // Read back what Desktop recorded, and put right a model or effort it did not take.
    const read = async () => JSON.parse(await conn.evaluate(desktop.rEval(CID, `(async function(){
      var s = await ${LS}.getSession(${JSON.stringify(sid)});
      return JSON.stringify(s ? { cwd: s.cwd, model: s.model, effort: s.effort, permissionMode: s.permissionMode } : null);
    })()`)) || 'null');
    let got = await read();
    const fixes = [];
    if (got && m.id && got.model !== m.id) {
      fixes.push('model');
      await conn.evaluate(desktop.rEval(CID, `${LS}.setModel(${JSON.stringify(sid)}, ${JSON.stringify(m.id)}).then(function(){return 'ok'})`)).catch(() => {});
    }
    if (got && wantEffort && String(got.effort || '').toLowerCase() !== wantEffort) {
      fixes.push('effort');
      await conn.evaluate(desktop.rEval(CID, `${LS}.setEffort(${JSON.stringify(sid)}, ${JSON.stringify(wantEffort)}).then(function(){return 'ok'})`)).catch(() => {});
    }
    if (fixes.length) got = await read();
    const verified = {
      folder: !!(got && sameDir(got.cwd, cwd)),
      model: !m.id || !!(got && got.model === m.id),
      effort: !wantEffort || !!(got && String(got.effort || '').toLowerCase() === wantEffort),
      bypass: !!(got && got.permissionMode === 'bypassPermissions'),
    };

    // The sidebar group is cosmetic and drives the GUI, so it runs after he has his answer.
    if (group) {
      setTimeout(() => {
        desktop.serializeUi(() => desktop.setGroup(sid, group, { noEscape: true })).catch(() => {});
      }, 50);
    }

    return { ok: true, sessionId: sid, folder: path.basename(cwd), cwd, model: got ? got.model : m.id,
             effort: got ? got.effort : wantEffort, permissionMode: got && got.permissionMode,
             verified, corrected: fixes, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: 'EXCEPTION', message: e.message };
  } finally { conn.close(); }
}

module.exports = { newSession, resolveModel };
