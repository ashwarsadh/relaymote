'use strict';
// tier-policy.js (g551): a hand change of model/effort is respected for tierOverrideHours; before a wake the
// session is put on Settings › New session (tierBeforeWake); every start path sets the tier before the prompt.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-tier-'));
process.env.RELAYMOTE_STATE_DIR = dir;
const root = path.join(__dirname, '..');
const tp = require(path.join(root, 'lib', 'tier-policy.js'));
const config = require(path.join(root, 'lib', 'config.js'));
let n = 0;
const ok = (c, name) => { assert.ok(c, name); n++; console.log('ok ' + name); };
const H = 3600000;

// A fake Claude Desktop: sessions with a model and effort, and a log of every change and start.
function fakeDesk(sessions) {
  const log = [];
  return {
    log, sessions,
    readTier: async id => sessions[id] ? { ok: true, sessionId: id, ...sessions[id] } : { ok: false, error: 'NO_SUCH_SESSION' },
    setTierBackground: async (kind, id, v) => { log.push(`${kind} ${id} ${v}`); sessions[id][kind] = v; return { ok: true }; },
  };
}
const S = (o = {}) => ({ newSession: { model: 'sonnet', effort: 'medium' }, tierBeforeWake: true, tierOverrideHours: 4, ...o });

(async () => {
  try {
    ok(config.DEFAULTS.tierBeforeWake === true && config.DEFAULTS.tierOverrideHours === 4, 'on by default, with a 4-hour window');

    // (a) the pure decision
    const want = { model: 'sonnet', effort: 'medium' }, cur = { model: 'opus', effort: 'max' }, now = 10 * H;
    ok(tp.decide({ current: cur, record: { by: 'user', at: now - 1 * H }, want, now, hours: 4 }).skip === 'MANUAL_OVERRIDE', 'a hand change 1 h ago is respected');
    const old = tp.decide({ current: cur, record: { by: 'user', at: now - 5 * H }, want, now, hours: 4 });
    ok(!old.skip && old.apply.model === 'sonnet' && old.apply.effort === 'medium', 'a hand change 5 h ago may be replaced by the default');
    ok(!tp.decide({ current: cur, record: { by: 'relaymote', at: now }, want, now, hours: 4 }).skip, "Relaymote's own change is never treated as the user's");
    ok(tp.decide({ current: want, record: null, want, now, hours: 4 }).skip === 'ALREADY', 'nothing is changed when it already matches');
    ok(tp.decide({ current: cur, record: null, want: { model: '', effort: '' }, now, hours: 4 }).skip === 'NO_DEFAULT', 'no default set: nothing is touched');

    // (a) detection: a tier that differs from Relaymote's last record is a hand change
    const d = fakeDesk({ s1: { model: 'opus', effort: 'max' } }); tp._setDesktop(d);
    let r = await tp.beforeWake('s1', { settings: S(), now: 0 });
    ok(r.ok && r.applied.model === 'sonnet' && r.applied.effort === 'medium', 'a never-seen session is put on the default before the wake');
    d.sessions.s1 = { model: 'opus', effort: 'high' };            // the user changes it by hand
    r = await tp.beforeWake('s1', { settings: S(), now: 1 * H });
    ok(r.skipped === 'MANUAL_OVERRIDE' && d.sessions.s1.model === 'opus', 'the user\'s change, first seen at the next wake, is respected');
    r = await tp.beforeWake('s1', { settings: S(), now: 3 * H });
    ok(r.skipped === 'MANUAL_OVERRIDE', 'still respected 2 h after it was seen');
    r = await tp.beforeWake('s1', { settings: S(), now: 5.5 * H });
    ok(r.ok && d.sessions.s1.model === 'sonnet' && d.sessions.s1.effort === 'medium', 'after the window the default goes back on');
    tp.recordUser('s1', { effort: 'low' }); d.sessions.s1.effort = 'low';
    r = await tp.beforeWake('s1', { settings: S() });
    ok(r.skipped === 'MANUAL_OVERRIDE' && d.sessions.s1.effort === 'low', 'a change made from the phone or relaymote_set_effort counts as the user\'s');

    // (b) the setting
    const d2 = fakeDesk({ s2: { model: 'opus', effort: 'max' } }); tp._setDesktop(d2);
    r = await tp.beforeWake('s2', { settings: S({ tierBeforeWake: false }) });
    ok(r.skipped === 'SETTING_OFF' && d2.log.length === 0, 'with the setting off a wake changes nothing');
    const brSrc = fs.readFileSync(path.join(root, 'lib', 'bridge.js'), 'utf8');
    ok(/beforeWake\(sessionId\)[\s\S]{0,300}setTimeout[\s\S]{0,600}connectRaw\(await wsUrl\(\), 45000\)/.test(brSrc), "every Relaymote wake (bridge.sendMessage) sets the tier first, bounded so the wake is never blocked");
    const d3 = { readTier: async () => { throw new Error('bridge down'); } }; tp._setDesktop(d3);
    r = await tp.beforeWake('s3', { settings: S() });
    ok(r.ok === false && r.skipped === 'ERROR', 'an unreadable session never throws into the wake');

    // (c) start paths
    const d4 = fakeDesk({ conductor: { model: 'opus', effort: 'high' }, newchip: { model: 'opus', effort: 'high' } }); tp._setDesktop(d4);
    tp.recordUser('conductor', { model: 'opus', effort: 'high' });
    let seenAtStart = null;
    const out = await tp.withStarterTier('conductor', async () => { seenAtStart = { ...d4.sessions.conductor }; return { ok: true, startedSessionId: 'newchip' }; }, { settings: S() });
    ok(out.ok && seenAtStart.model === 'sonnet' && seenAtStart.effort === 'medium', 'a chip starts from a starter already on the default (it inherits model and effort)');
    ok(d4.sessions.conductor.model === 'opus' && d4.sessions.conductor.effort === 'high', 'the starter is put back exactly as it was');
    ok(JSON.parse(fs.readFileSync(tp.file(), 'utf8')).conductor.by === 'user', "the starter's own hand change is still on record as the user's");
    ok(d4.sessions.newchip.model === 'sonnet' && d4.sessions.newchip.effort === 'medium', 'the new chip session carries the default');
    const dsk = fs.readFileSync(path.join(root, 'lib', 'desktop.js'), 'utf8');
    ok(/startTask: \(opts = \{\}\) => require\('\.\/tier-policy'\)\.withStarterTier/.test(dsk), 'every chip start (Conductor, masters, chipwatch, phone) goes through the tier wrapper');
    const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    ok(/forceModel: body\.model \|\| ns\.model \|\| undefined, forceEffort: body\.effort \|\| ns\.effort \|\| undefined/.test(srv), 'relaymote_spawn workers start on the default when none is given');
    const nsSrc = fs.readFileSync(path.join(root, 'mobile', 'newsession.js'), 'utf8');
    ok(nsSrc.indexOf("'pick-model'") < nsSrc.indexOf("'send-prompt'") && nsSrc.indexOf("'pick-effort'") < nsSrc.indexOf("'send-prompt'"), 'a GUI-started session picks model and effort before the first prompt');
    const cw = fs.readFileSync(path.join(root, 'lib', 'chipwatch.js'), 'utf8');
    ok(/if \(!require\('\.\/tier-policy'\)\.defaults\(\)\.model\)/.test(cw), 'chipwatch no longer overwrites the default with its own model');
    const ui = fs.readFileSync(path.join(root, 'mobile', 'public', 'settings-ui.js'), 'utf8');
    ok(/toggle\('tierBeforeWake'/.test(ui) && /field\('tierOverrideHours'/.test(ui), 'Settings has the switch and the hours');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(`\n${n}/${n} passed`);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
