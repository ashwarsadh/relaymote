'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const registry = require('./registry');
const { reportLine } = require('./master-protocol');
const desktop = require('./desktop');
const worker = require('./worker');

const RESULTS = registry.RESULTS_DIR;
const AUTH_DIR = require('./config').AUTH;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MAX_PROMPT_CHARS = 24000;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const FINISH_GRACE_MS = 25000;

const CLEAN_RX_JS = "replace(/[\\u200B-\\u200D\\uFEFF\\u00AD\\u2060\\uE000-\\uF8FF]/g,'')";
const CLEAN_RX = /[\u200B-\u200D\uFEFF\u00AD\u2060\uE000-\uF8FF]/g;
const clean = s => String(s || '').replace(CLEAN_RX, '').trim();

let authCache = { at: 0, value: null };
const AUTH_TTL_MS = 60000;

function checkCliAuth(opts = {}) {
  const authDir = opts.authDir || AUTH_DIR;
  const useCache = !opts.force && !opts.authDir;
  if (useCache && authCache.value && Date.now() - authCache.at < AUTH_TTL_MS) return authCache.value;
  let out;
  try {
    const bin = worker.claudeBin();
    const env = { ...process.env, CLAUDE_CONFIG_DIR: authDir };
    let raw = '';
    try {
      raw = execFileSync(bin, ['auth', 'status'], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    } catch (e) {
      raw = e.stdout || '';
      if (!raw) throw new Error(String(e.message || 'auth probe produced no output').slice(0, 200));
    }
    let j = null;
    try { j = JSON.parse(String(raw).trim()); } catch {}
    if (!j || typeof j.loggedIn !== 'boolean') {
      out = { loggedIn: false, authMethod: 'unknown', detail: 'auth status output was not JSON: ' + String(raw).slice(0, 160) };
    } else {
      out = { loggedIn: !!j.loggedIn, authMethod: j.authMethod || 'none', apiProvider: j.apiProvider || null };
    }
  } catch (e) {
    out = { loggedIn: false, authMethod: 'error', detail: String(e.message || e).slice(0, 200) };
  }
  if (useCache || !opts.authDir) authCache = { at: Date.now(), value: out };
  return out;
}

// HEADLESS CLI ROUTE RETIRED (16-Oct-2026, owner decision: no Claude CLI; background work goes to in-session
// subagents and anything the user should see goes to task chips). dispatch:"headless" -- passed or set as
// the workers.dispatch setting -- is REFUSED; the automatic choice no longer probes the CLI.
const HEADLESS_RETIRED = "HEADLESS_RETIRED: Relaymote no longer runs the Claude CLI (claude -p). Use one of the two allowed routes: (1) background work -> an Agent-tool subagent inside your own session; (2) anything the user should see -> a task chip (ccd_session start_session / spawn_task, then relaymote_start_task), or relaymote_spawn without dispatch (a visible Desktop GUI session). Do not ask the user to log in to the CLI.";
function chooseDispatch(task = {}, opts = {}) {
  const pref = require('./config').get().workers.dispatch;
  const forced = opts.dispatch || task.dispatch || (pref === 'gui' || pref === 'headless' ? pref : null);
  if (forced === 'headless') return { dispatch: 'refused', reason: HEADLESS_RETIRED, auth: null };
  return { dispatch: 'gui', reason: forced === 'gui' ? 'forced: dispatch=gui' : 'GUI (the headless CLI route is retired)', auth: null };
}

function guiResultFile(taskId, attempt) {
  return path.join(RESULTS, `${taskId}.a${attempt}.gui.json`);
}

function wrapPrompt(task, resultFile) {
  const p = String(task.prompt || '');
  return [
    p,
    '',
    '---',
    `[Relaymote task ${task.id}] Report your result to a file, not just to this chat.`,
    '',
    'When the work above is finished, use the Write tool to create this exact file:',
    resultFile,
    '',
    'Its entire contents must be one JSON object, no prose around it and no code fence:',
    '{"ok": true, "result": "<your complete final answer, as a single JSON string>"}',
    '',
    'If you could not complete the task, write instead:',
    '{"ok": false, "result": "<what you did manage>", "error": "<what stopped you>"}',
    '',
    'This file is the ONLY way your work reaches Relaymote. A task whose file is missing is recorded as',
    'failed no matter how good the answer in this chat was, so write it as the last thing you do.',
    'Put the substance in "result" — whoever reads it will not see this conversation.',
    '',
    reportLine(task.masterId, { channel: 'file' }),
  ].join('\n');
}

function readGuiResult(file) {
  if (!file || !fs.existsSync(file)) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').trim(); } catch { return null; }
  if (!raw) return null;

  let body = raw.replace(/^﻿/, '');
  const fence = body.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) body = fence[1].trim();

  let j = null;
  try { j = JSON.parse(body); } catch {
    const a = body.indexOf('{'), b = body.lastIndexOf('}');
    if (a >= 0 && b > a) { try { j = JSON.parse(body.slice(a, b + 1)); } catch {} }
  }
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    const result = typeof j.result === 'string' ? j.result : JSON.stringify(j.result == null ? '' : j.result);
    return { ok: j.ok !== false, result, error: j.error ? String(j.error) : null, raw: false };
  }
  return { ok: true, result: raw.slice(0, 200000), error: null, raw: true };
}

const serializeUi = desktop.serializeUi;

const PTR_FN = `
  function relaymotePtr(el){
    var r=el.getBoundingClientRect();
    var vh=window.innerHeight||document.documentElement.clientHeight;
    var vw=window.innerWidth||document.documentElement.clientWidth;
    if(!(r.width>0 && r.height>0 && r.top>=0 && r.left>=0 && r.bottom<=vh && r.right<=vw)){
      try{ el.scrollIntoView({block:'center', behavior:'instant'}); }
      catch(e){ el.scrollIntoView({block:'center'}); }
      r=el.getBoundingClientRect();
    }
    var o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,isPrimary:true,pointerId:1,pointerType:'mouse'};
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
      el.dispatchEvent(new (t.indexOf('pointer')===0?PointerEvent:MouseEvent)(t,o));
    });
  }
  function relaymoteClean(e){ return (e && e.textContent || '').${CLEAN_RX_JS}.trim(); }`;

const CLICK_NEW_JS = `
(function(){ ${PTR_FN}
  /* Claude Desktop app-1.40609.1 emits aria-keyshortcuts="Control+n" (LOWERCASE n); earlier builds
     used "Control+N". CSS attribute selectors compare values case-SENSITIVELY, so the old exact
     selector silently stopped matching and GUI dispatch began failing with 'no-new-button' and no
     hint as to why. Normalise the value instead of pattern-matching it, so neither a casing change
     nor stray whitespace can break this again. */
  var all = Array.from(document.querySelectorAll('button[aria-keyshortcuts]'));
  var isNew = function(e){
    var v = (e.getAttribute('aria-keyshortcuts')||'').toLowerCase().split(' ').join('');
    return v === 'control+n';
  };
  var b = all.filter(function(e){ return isNew(e) && e.closest('[data-testid="sidebar"]'); })[0]
       || all.filter(isNew)[0];
  if(!b) return 'no-new-button';
  relaymotePtr(b);
  return 'clicked';
})()`;

const clickTriggerJs = (rxSrc, sel) => `
(function(){ ${PTR_FN}
  var rx=${rxSrc};
  var vis=Array.from(document.querySelectorAll('[aria-haspopup="menu"]')).filter(function(b){
    return b.offsetParent!==null && !b.closest('[data-testid="sidebar"]');
  });
  var bySel=${sel ? JSON.stringify(sel) : 'null'};
  var trig=(bySel && vis.find(function(b){ return b.matches(bySel); })) || vis.find(function(b){ return rx.test(relaymoteClean(b)); });
  if(!trig) return JSON.stringify({err:'no-trigger', seen:vis.map(relaymoteClean).slice(0,20)});
  window.__relaymoteTrig=trig;
  var was=relaymoteClean(trig);
  setTimeout(function(){
    var r=trig.getBoundingClientRect();
    var o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,
           button:0,isPrimary:true,pointerId:1};
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(n){
      trig.dispatchEvent(new (n.indexOf('pointer')===0?PointerEvent:MouseEvent)(n,o));
    });
  },0);   // and it must not run inside this eval, or the eval never returns
  return JSON.stringify({fired:true, was:was});
})()`;

const menuStateJs = `
(function(){
  var t=window.__relaymoteTrig;
  if(!t) return JSON.stringify({err:'trigger-lost'});
  var id=t.getAttribute('aria-controls')||'';
  return JSON.stringify({menuId:id,
    open:!!(id && document.getElementById(id) && t.getAttribute('aria-expanded')==='true')});
})()`;

async function openMenu(conn, CID, rxSrc, sel) {
  const fired = JSON.parse(await conn.evaluate(desktop.rEval(CID, clickTriggerJs(rxSrc, sel))) || '{}');
  if (fired.err) return fired;
  for (let i = 0; i < 25; i++) {
    await sleep(120);
    const st = JSON.parse(await conn.evaluate(desktop.rEval(CID, menuStateJs)) || '{}');
    if (st.open) return { menuId: st.menuId, was: fired.was };
  }
  return { err: 'menu-never-opened', was: fired.was };
}

const pickRadioJs = (menuId, rxSrc) => `
(function(){ ${PTR_FN}
  var m=document.getElementById(${JSON.stringify(String(menuId))});
  if(!m) return JSON.stringify({ok:false, err:'menu-gone'});
  var rx=${rxSrc};
  var items=Array.from(m.querySelectorAll('[role="menuitemradio"]')).filter(function(e){return e.offsetParent!==null;});
  /* The label is the item's FIRST child; the whole item also holds the keyboard-shortcut digit, so
     its text read "Sonnet 5.53" and the model matcher refused Sonnet (g1131). listModels reads it so. */
  var label=function(e){ var f=e.children && e.children[0]; return f ? relaymoteClean(f) : relaymoteClean(e); };
  var names=items.map(label);
  var hit=items.find(function(e){ return rx.test(label(e)); });
  if(!hit) return JSON.stringify({ok:false, err:'not-offered', offered:names});
  var already=hit.getAttribute('aria-checked')==='true';
  relaymotePtr(hit);
  return JSON.stringify({ok:true, offered:names, picked:label(hit), already:already});
})()`;

const readTriggerJs = rxSrc => `
(function(){ ${PTR_FN}
  var rx=${rxSrc};
  var t=Array.from(document.querySelectorAll('[aria-haspopup]')).filter(function(b){
    return b.offsetParent!==null && !b.closest('[data-testid="sidebar"]');
  }).find(function(b){ return rx.test(relaymoteClean(b)); });
  return t?relaymoteClean(t):'';
})()`;

function folderLabelFor(cwd) {
  const c = String(cwd || '').replace(/[\\/]+$/, '');
  return path.basename(c) || c;
}
const rxLiteral = s => new RegExp('^' + String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').toString();

const EFFORT_SLIDER = { low: 0, medium: 1, high: 2, xhigh: 3, extra: 3, max: 4, ultracode: 5 };

let LAST_FOLDER_STEPS = [];
const lastFolderSteps = () => LAST_FOLDER_STEPS.slice();

// ---- 16-Oct-2026 Desktop UI (folder-wise start view) ----
// The new-session view no longer has a "Select folder" composer trigger. It has an ENVIRONMENT BAR
// under the composer: [data-testid=environment-bar-trigger] ("This computer") and
// [data-testid=environment-bar-folder] (aria-label "Folder: Choose folder…", or "Folder: <path>"
// once set — measured as the FULL path). Its menu is the same role=menu of menuitemradio rows, but
// each row carries the FULL PATH in `title`, and a search <input> filters the list (only ~8 MRU
// folders show unfiltered). Above the composer, start cards (start-card-environment) offer a few
// folders and "Choose environment" (start-card-choose) opens the ENVIRONMENT menu, not a folder
// list — the old denylist fallback clicked that and every dispatch failed "menu-never-opened".
const FOLDER_SEL = '[data-testid="environment-bar-folder"]';
const readFolderBarJs = `
(function(){
  var t=document.querySelector(${JSON.stringify(FOLDER_SEL)});
  if(!t || t.offsetParent===null) return JSON.stringify({present:false});
  var al=(t.getAttribute('aria-label')||'').replace(/^\\s*folder:\\s*/i,'').trim();
  var none=/^(choose folder|choose)\\W*$/i.test(al) || /^no folder$/i.test(al);
  return JSON.stringify({present:true, label:none?'':al, raw:t.getAttribute('aria-label')||''});
})()`;
// Pick by FULL PATH (title) when we have one, else by basename. Only menuitemradio, so "Open
// folder…" (a native dialog that would wedge the UI) can never be hit.
const pickFolderJs = (menuId, rxSrc, wantPath) => `
(function(){ ${PTR_FN}
  var m=document.getElementById(${JSON.stringify(String(menuId))});
  if(!m) return JSON.stringify({ok:false, err:'menu-gone'});
  var rx=${rxSrc};
  var norm=function(s){ return String(s||'').replace(/[\\\\/]+/g,'\\\\').replace(/\\\\$/,'').toLowerCase(); };
  var want=norm(${JSON.stringify(String(wantPath || ''))});
  var items=Array.from(m.querySelectorAll('[role="menuitemradio"]')).filter(function(e){return e.offsetParent!==null;});
  var names=items.map(function(e){ return relaymoteClean(e) + (e.title ? ' ['+e.title+']' : ''); });
  var hit=(want && items.find(function(e){ return norm(e.title)===want; }))
       || items.find(function(e){ return rx.test(relaymoteClean(e)); });
  if(!hit) return JSON.stringify({ok:false, err:'not-offered', offered:names});
  relaymotePtr(hit);
  return JSON.stringify({ok:true, offered:names, picked:relaymoteClean(hit), path:hit.title||''});
})()`;
// Type into the menu's search box (React-owned: native setter + input event).
const searchFolderMenuJs = (menuId, text) => `
(function(){
  var m=document.getElementById(${JSON.stringify(String(menuId))});
  if(!m) return 'menu-gone';
  var inp=m.querySelector('input');
  if(!inp) return 'no-search';
  var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(inp, ${JSON.stringify(String(text))});
  inp.dispatchEvent(new Event('input',{bubbles:true}));
  return 'typed';
})()`;

async function selectFolderBar(conn, CID, label, cwd, fstep) {
  const normP = s => String(s || '').replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
  const sameLabel = s => {
    const v = clean(s || '');
    if (!v) return false;
    if (cwd && /[\\/]/.test(v)) return normP(v) === normP(cwd);
    return folderLabelFor(v).toLowerCase() === String(label).toLowerCase();
  };
  const cur = JSON.parse(await fstep('read-folder-bar', () => conn.evaluate(desktop.rEval(CID, readFolderBarJs))) || '{}');
  if (cur.label && sameLabel(cur.label)) return { ok: true, folder: cur.label, unchanged: true, ui: 'environment-bar' };
  const exactRx = '/^' + label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '$/i';
  const opened = await fstep('open-folder-bar', () => openMenu(conn, CID, '/^$/', FOLDER_SEL));
  if (opened.err) return { ok: false, error: 'GUI_NO_FOLDER_PICKER', detail: opened.err,
    message: `Folder menu (environment bar) failed: ${opened.err}` + (opened.was ? ` after clicking ${JSON.stringify(opened.was)}` : '') };
  let picked = JSON.parse(await fstep('pick-folder', () => conn.evaluate(desktop.rEval(CID, pickFolderJs(opened.menuId, exactRx, cwd)))) || '{}');
  if (!picked.ok && picked.err === 'not-offered') {
    const typed = await fstep('search-folder', () => conn.evaluate(desktop.rEval(CID, searchFolderMenuJs(opened.menuId, label))));
    if (typed === 'typed') {
      await sleep(600);
      picked = JSON.parse(await fstep('pick-folder-filtered', () => conn.evaluate(desktop.rEval(CID, pickFolderJs(opened.menuId, exactRx, cwd)))) || '{}');
    }
  }
  if (!picked.ok) {
    await desktop.closeMenus(conn, CID);
    return {
      ok: false, error: 'GUI_FOLDER_NOT_IN_RECENTS', wanted: cwd || label, offered: picked.offered || [],
      message: `"${cwd || label}" is not in Claude Desktop's folder list (searched for "${label}" too). Only folders opened before can be selected — the only other route is the native "Open folder…" dialog, which automation must never trigger. Open the folder once in Desktop. Offered: ${(picked.offered || []).join(', ')}`,
    };
  }
  await sleep(900);
  await desktop.closeMenus(conn, CID);
  const now = JSON.parse(await fstep('verify-folder-bar', () => conn.evaluate(desktop.rEval(CID, readFolderBarJs))) || '{}');
  return sameLabel(now.label) || (picked.picked && clean(now.label) === clean(picked.picked))
    ? { ok: true, folder: now.label, path: picked.path || null, ui: 'environment-bar' }
    : { ok: false, error: 'GUI_FOLDER_VERIFY_FAILED', expected: label, actual: now.raw || now.label || '', picked: picked.picked };
}

async function selectFolder(conn, CID, label, cwd) {
  LAST_FOLDER_STEPS = [];
  const fstep = async (name, run) => {
    const t = Date.now();
    try { const r = await run(); LAST_FOLDER_STEPS.push(`${name} ${Date.now() - t}ms`); return r; }
    catch (e) { LAST_FOLDER_STEPS.push(`${name} ${Date.now() - t}ms THREW ${e.message}`); throw e; }
  };
  // Current UI first; the legacy composer-trigger path below only runs on a build without the bar.
  const bar = JSON.parse(await fstep('probe-folder-bar', () => conn.evaluate(desktop.rEval(CID, readFolderBarJs))) || '{}');
  if (bar.present) return selectFolderBar(conn, CID, label, cwd, fstep);
  const rx = rxLiteral(label);
  const cur = clean(await fstep('read-trigger', () => conn.evaluate(desktop.rEval(CID, readTriggerJs(rx)))));
  if (cur && new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(cur)) {
    return { ok: true, folder: cur, unchanged: true };
  }
  let opened = await fstep('open-menu-literal', () => openMenu(conn, CID, '/select folder/i'));
  if (opened.err) {
    const NOT_FOLDER = '/^(?!\\s*(select folder|choose environment|this computer|local|worktree|bypass permissions|ask|accept edits|plan|opus|sonnet|haiku|fable|claude)\\b)\\S/i';
    opened = await fstep('open-menu-fallback', () => openMenu(conn, CID, NOT_FOLDER));
  }
  if (opened.err) return { ok: false, error: 'GUI_NO_FOLDER_PICKER', detail: opened.err, seen: opened.seen,
    message: `Folder menu failed: ${opened.err}` + (opened.was ? ` after clicking ${JSON.stringify(opened.was)}` : '')
             + `. Visible triggers: ${(opened.seen || []).map(x => JSON.stringify(x)).join(', ') || 'not recorded'}` };
  const picked = JSON.parse(await fstep('pick-radio', () =>
    conn.evaluate(desktop.rEval(CID, pickRadioJs(opened.menuId, rx)))) || '{}');
  if (!picked.ok) {
    await desktop.closeMenus(conn, CID);
    return {
      ok: false, error: 'GUI_FOLDER_NOT_IN_RECENTS', wanted: label, offered: picked.offered || [],
      message: `"${label}" is not in Claude Desktop's recent-folders list. Only folders that have been opened before can be selected — the only other route is the native "Open folder…" dialog, which automation must never trigger. Open the folder once in Desktop, or dispatch this task with a cwd whose basename is one of: ${(picked.offered || []).join(', ')}`,
    };
  }
  await sleep(900);
  await desktop.closeMenus(conn, CID);
  const now = clean(await conn.evaluate(desktop.rEval(CID, readTriggerJs(rx))));
  const ok = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(now || '');
  return ok ? { ok: true, folder: now } : { ok: false, error: 'GUI_FOLDER_VERIFY_FAILED', expected: label, actual: now };
}

/**
 * The menu label for a model, as a regex SOURCE. g498: the router's own default id,
 * "claude-opus-5-5", was matched as a prefix of the menu text ("Opus 5.5") and could never match,
 * so every GUI dispatch at the default model failed with GUI_MODEL_NOT_OFFERED. The id is normalised
 * the way desktop.normModel does it (opus-5-5), and its parts may be separated by space, dot or dash;
 * the version must END there, so "Opus 5" never matches "Opus 5.5" (the g378 rule). A bare family
 * word ("opus") still takes the first of its family, which is Desktop's own default for it.
 */
function modelLabelRx(model) {
  const id = desktop.normModel(model);
  if (!id) return null;
  const parts = id.split('-').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return parts.length === 1 ? '^' + parts[0] + '\\b' : '^' + parts.join('[\\s._-]*') + '(?![\\d.])';
}

async function selectModel(conn, CID, model) {
  if (model != null && typeof model !== 'string') return { ok: false, error: 'GUI_BAD_MODEL', wanted: String(model) };
  const key = String(model || '').trim();
  if (!key) return { ok: true, skipped: 'no model requested' };
  const src = modelLabelRx(key);
  if (!src) return { ok: false, error: 'GUI_BAD_MODEL', wanted: key };
  const want = new RegExp(src, 'i');
  const rx = '/' + src + '/i';
  const anyModel = '/^(opus|sonnet|haiku|fable)/i';
  const cur = clean(await conn.evaluate(desktop.rEval(CID, readTriggerJs(anyModel))));
  if (!cur) return { ok: false, error: 'GUI_NO_MODEL_PICKER' };
  if (want.test(cur)) return { ok: true, model: cur, unchanged: true };

  const opened = await openMenu(conn, CID, anyModel);
  if (opened.err) return { ok: false, error: 'GUI_MODEL_MENU_DID_NOT_OPEN', detail: opened.err };
  const picked = JSON.parse(await conn.evaluate(desktop.rEval(CID, pickRadioJs(opened.menuId, rx))) || '{}');
  if (!picked.ok) {
    await desktop.closeMenus(conn, CID);
    return { ok: false, error: 'GUI_MODEL_NOT_OFFERED', wanted: key, matcher: src, offered: picked.offered || [] };
  }
  await sleep(1000);
  await desktop.closeMenus(conn, CID);
  const now = clean(await conn.evaluate(desktop.rEval(CID, readTriggerJs(anyModel))));
  return want.test(now || '')
    ? { ok: true, model: now, was: cur }
    : { ok: false, error: 'GUI_MODEL_VERIFY_FAILED', expected: key, actual: now, was: cur };
}

// Effort is a SLIDER inside a dialog (aria-haspopup="dialog"), not a menu. React owns the input, so
// the value must go through the native setter followed by input+change — assigning .value does
// nothing at all.
//
// g498: the control is found the way desktop.setEffort has found it since 2026-09-06 -- data-cds
// "ModelSelectorEffort", else a button whose aria-label or text starts with "effort". The label moved
// OUT of the button text ("Extra" with aria-label "Effort: Extra"), and this copy still tested the
// text alone, so every GUI dispatch reported GUI_NO_EFFORT_CONTROL and ran at the default effort.
// Verified by NAME (desktop.sameEffort): the old /high/ also matched "Extra high" (the g378 rule).
const EFFORT_BTN_FN = `function relaymoteEffortBtn(){
  var b=document.querySelector('[data-cds="ModelSelectorEffort"]')
    || Array.from(document.querySelectorAll('button')).find(function(e){
      if(e.offsetParent===null || e.closest('[data-testid="sidebar"]')) return false;
      var l=(e.getAttribute('aria-label')||'').trim().toLowerCase();
      var t=((e.textContent)||'').trim().toLowerCase();
      return l.indexOf('effort')===0 || t.indexOf('effort')===0;
    });
  return (b && b.offsetParent!==null) ? b : null;
}`;
// ---- 16-Oct-2026 Desktop UI: effort is a SUBMENU of the model menu ----
// The model trigger ([data-testid=environment-row-model], aria-label "Model: Opus 5.5 High") opens a
// role=menu holding the model radios, then a role=menuitem[aria-haspopup=menu] "Effort<Level>" whose
// own aria-controls menu lists menuitemradio Low | Medium(Recommended) | High | Extra | Max | Ultracode.
// No effort button and no slider any more, hence GUI_NO_EFFORT_CONTROL. Verified from the last word
// of the trigger's aria-label.
const MODEL_SEL = '[data-cds="ModelSelector"],[data-testid="epitaxy-cds-model-selector"],[data-testid="environment-row-model"]';
const ANY_MODEL_RX = '/^(opus|sonnet|haiku|fable)/i';
const EFFORT_NAME = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra', extra: 'extra', max: 'max', ultracode: 'ultracode' };
const readModelEffortJs = `
(function(){
  var t=Array.from(document.querySelectorAll(${JSON.stringify(MODEL_SEL)})).find(function(b){ return b.offsetParent!==null && !b.closest('[data-testid="sidebar"]'); });
  if(!t) return '';
  var l=(t.getAttribute('aria-label')||'').trim().split(' ');
  return l.length ? l[l.length-1] : '';
})()`;
const openEffortSubJs = (menuId) => `
(function(){
  var m=document.getElementById(${JSON.stringify(String(menuId))});
  if(!m) return JSON.stringify({err:'menu-gone'});
  var eff=Array.from(m.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]')).find(function(e){
    return (e.textContent||'').trim().toLowerCase().indexOf('effort')===0; });
  if(!eff) return JSON.stringify({err:'no-effort-item'});
  window.__relaymoteEffortItem=eff;
  setTimeout(function(){
    var r=eff.getBoundingClientRect();
    var o={bubbles:true,cancelable:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0,isPrimary:true,pointerId:1};
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(n){ eff.dispatchEvent(new (n.indexOf('pointer')===0?PointerEvent:MouseEvent)(n,o)); });
  },0);
  return JSON.stringify({fired:true});
})()`;
const pickEffortSubJs = (name) => `
(function(){ ${PTR_FN}
  var eff=window.__relaymoteEffortItem; if(!eff) return JSON.stringify({err:'item-lost'});
  var id=eff.getAttribute('aria-controls'); var sub=id&&document.getElementById(id);
  if(!sub || eff.getAttribute('aria-expanded')!=='true') return JSON.stringify({err:'sub-not-open'});
  var items=Array.from(sub.querySelectorAll('[role="menuitemradio"]')).filter(function(e){return e.offsetParent!==null;});
  var names=items.map(relaymoteClean);
  var hit=items.find(function(e){ return relaymoteClean(e).toLowerCase().indexOf(${JSON.stringify(name)})===0; });
  if(!hit) return JSON.stringify({err:'not-offered', offered:names});
  if(hit.getAttribute('aria-disabled')==='true') return JSON.stringify({err:'disabled', offered:names});
  var already=hit.getAttribute('aria-checked')==='true';
  relaymotePtr(hit);
  return JSON.stringify({ok:true, already:already, offered:names});
})()`;

async function selectEffortSubmenu(conn, CID, key) {
  const name = EFFORT_NAME[key];
  const was = clean(await conn.evaluate(desktop.rEval(CID, readModelEffortJs)));
  if (!was) return { ok: false, error: 'GUI_NO_EFFORT_CONTROL', detail: 'no model trigger (effort submenu UI)' };
  if (desktop.sameEffort(was, name)) return { ok: true, effort: was, unchanged: true, ui: 'model-submenu' };
  const opened = await openMenu(conn, CID, ANY_MODEL_RX, MODEL_SEL);
  if (opened.err) return { ok: false, error: 'GUI_EFFORT_MENU_DID_NOT_OPEN', detail: opened.err, was };
  const fired = JSON.parse(await conn.evaluate(desktop.rEval(CID, openEffortSubJs(opened.menuId))) || '{}');
  if (fired.err) { await desktop.closeMenus(conn, CID); return { ok: false, error: 'GUI_NO_EFFORT_CONTROL', detail: fired.err, was }; }
  let picked = {};
  for (let i = 0; i < 15; i++) {
    await sleep(150);
    picked = JSON.parse(await conn.evaluate(desktop.rEval(CID, pickEffortSubJs(name))) || '{}');
    if (picked.err !== 'sub-not-open') break;
  }
  await sleep(700);
  await desktop.closeMenus(conn, CID);
  if (!picked.ok) return { ok: false, error: 'GUI_EFFORT_NOT_SET', detail: picked.err, offered: picked.offered || [], was };
  const now = clean(await conn.evaluate(desktop.rEval(CID, readModelEffortJs)));
  return desktop.sameEffort(now, name)
    ? { ok: true, effort: now, was, ui: 'model-submenu' }
    : { ok: false, error: 'GUI_EFFORT_VERIFY_FAILED', expected: name, actual: now, was };
}

async function selectEffort(conn, CID, effort) {
  const key = String(effort || '').trim().toLowerCase();
  if (!key) return { ok: true, skipped: 'no effort requested' };
  if (!(key in EFFORT_SLIDER)) return { ok: false, error: 'GUI_BAD_EFFORT', wanted: key, allowed: Object.keys(EFFORT_SLIDER) };
  const want = EFFORT_SLIDER[key];

  const readNow = async () => clean(await conn.evaluate(desktop.rEval(CID, `
    (function(){ ${PTR_FN} ${EFFORT_BTN_FN}
      var b=relaymoteEffortBtn(); return b?relaymoteClean(b):'';
    })()`)));
  const was = await readNow();
  if (!was) return selectEffortSubmenu(conn, CID, key);
  if (desktop.sameEffort(was, key)) return { ok: true, effort: was, unchanged: true };

  await conn.evaluate(desktop.rEval(CID, `
    (function(){ ${PTR_FN} ${EFFORT_BTN_FN}
      var b=relaymoteEffortBtn(); if(!b) return '';
      window.__relaymoteEffortBtn=b; relaymotePtr(b); return 'opened';
    })()`));
  await sleep(900);

  const set = await conn.evaluate(desktop.rEval(CID, `
    (function(){
      var id=(window.__relaymoteEffortBtn && window.__relaymoteEffortBtn.getAttribute('aria-controls'))||'';
      var sc=id?document.getElementById(id):null;
      var inp=sc?sc.querySelector('input[type=range]'):null;
      if(!inp) return 'no-slider';
      var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(inp, String(${want}));
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      inp.dispatchEvent(new Event('change',{bubbles:true}));
      return 'ok';
    })()`));
  if (set !== 'ok') { await desktop.closeMenus(conn, CID); return { ok: false, error: 'GUI_EFFORT_SLIDER_NOT_FOUND', detail: set, was }; }
  await sleep(800);
  await desktop.closeMenus(conn, CID);
  const now = await readNow();
  return desktop.sameEffort(now, key)
    ? { ok: true, effort: now, was }
    : { ok: false, error: 'GUI_EFFORT_VERIFY_FAILED', expected: key, actual: now, was };
}

async function ensureBypassPermissions(conn, CID) {
  const rx = '/^(bypass permissions|auto|manual|accept edits|plan)/i';
  const cur = clean(await conn.evaluate(desktop.rEval(CID, readTriggerJs(rx))));
  if (!cur) return { ok: true, skipped: 'no permission-mode control found' };
  if (/^bypass permissions/i.test(cur)) return { ok: true, mode: cur, unchanged: true };
  const opened = await openMenu(conn, CID, rx);
  if (opened.err) return { ok: false, error: 'GUI_PERM_MENU_DID_NOT_OPEN', detail: opened.err, was: cur };
  const picked = JSON.parse(await conn.evaluate(desktop.rEval(CID, pickRadioJs(opened.menuId, '/^bypass permissions/i'))) || '{}');
  await sleep(800);
  await desktop.closeMenus(conn, CID);
  if (!picked.ok) return { ok: false, error: 'GUI_PERM_NOT_OFFERED', offered: picked.offered || [], was: cur };
  const now = clean(await conn.evaluate(desktop.rEval(CID, readTriggerJs(rx))));
  return /^bypass permissions/i.test(now || '')
    ? { ok: true, mode: now, was: cur }
    : { ok: false, error: 'GUI_PERM_VERIFY_FAILED', expected: 'Bypass permissions', actual: now, was: cur };
}

function dispatch(taskId, opts = {}) {
  return serializeUi(() => dispatchInner(taskId, opts));
}

async function awaitQuietWindow(opts = {}) {
  const min = opts.idleMinMs !== undefined ? opts.idleMinMs
            : Number(process.env.RELAYMOTE_IDLE_MIN_MS ?? (require('./config').get().idleGateSeconds * 1000));
  if (opts.idle === false || !(min > 0)) return { waitedMs: 0, gated: false };
  const maxWait = opts.idleMaxWaitMs !== undefined ? opts.idleMaxWaitMs
                : Number(process.env.RELAYMOTE_IDLE_MAX_WAIT_MS ?? 240000);
  const idle = require('./idle');
  const t0 = Date.now();
  while (!idle.isIdle(min)) {
    if (Date.now() - t0 > maxWait) {
      return { waitedMs: Date.now() - t0, gated: true, timedOut: true, idleMs: idle.idleMs() };
    }
    await sleep(500);
  }
  return { waitedMs: Date.now() - t0, gated: true };
}

async function dispatchInner(taskId, opts = {}) {
  const task = registry.getTask(taskId);
  if (!task) throw new Error('no such task: ' + taskId);
  registry.ensureDirs();

  const attempt = (task.attempt || 0) + 1;
  const resultFile = guiResultFile(task.id, attempt);
  const logFile = path.join(RESULTS, `${task.id}.a${attempt}.gui.log`);
  const fullPrompt = wrapPrompt(task, resultFile);

  const fail = (error, extra = {}) => {
    const t = registry.updateTask(task.id, {
      status: 'failed', dispatch: 'gui', attempt,
      endedAt: new Date().toISOString(),
      launchFailed: true, error, resultFile, logFile,
      ...extra,
    });
    try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${error}\n${JSON.stringify(extra, null, 1)}\n`); } catch {}
    return { ok: false, error, task: t, ...extra };
  };

  if (fullPrompt.length > MAX_PROMPT_CHARS) {
    return fail(`GUI_PROMPT_TOO_LONG: ${fullPrompt.length} chars exceeds the ${MAX_PROMPT_CHARS} the composer is trusted with. Not truncating — a truncated prompt is a different task.`);
  }
  if (!(await desktop.cdpAvailable())) {
    return fail('GUI_CDP_UNAVAILABLE: Claude Desktop\'s debugger is not reachable on 127.0.0.1:9229, so no session can be dispatched. Is Desktop running?');
  }

  const quiet = await awaitQuietWindow(opts);
  if (quiet.timedOut) {
    return fail('GUI_USER_ACTIVE: the user has been at the keyboard for the whole wait, so this worker was NOT launched rather than yanking the window away mid-typing. Nothing was started; call again later, or pass idle:false to dispatch anyway.');
  }

  const conn = await desktop.connect(await desktop.wsUrl());
  try {
    const CID = await desktop.pickChat(conn);
    const before = JSON.parse(await conn.evaluate(desktop.rEval(CID, `JSON.stringify({active:location.href.split('/').pop()})`)));
    const original = before.active && String(before.active).startsWith('local_') ? before.active : null;

    const clicked = await conn.evaluate(desktop.rEval(CID, CLICK_NEW_JS));
    if (clicked !== 'clicked') return fail('GUI_NO_NEW_BUTTON: the sidebar "New" control (button[aria-keyshortcuts="Control+N"]) was not found.');
    await sleep(2600);

    const onNew = await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`));
    if (onNew !== 'epitaxy') {
      return fail(`GUI_NEW_VIEW_NOT_REACHED: expected the /epitaxy new-session route, got "${onNew}".`);
    }

    const wantFolder = folderLabelFor(task.cwd);
    const folder = await selectFolder(conn, CID, wantFolder, task.cwd);
    if (!folder.ok) { if (original) await desktop.restoreActive(conn, CID, original); return fail(`${folder.error}: ${folder.message || JSON.stringify(folder)}`, { folder }); }

    const model = await selectModel(conn, CID, task.model);
    if (!model.ok) { if (original) await desktop.restoreActive(conn, CID, original); return fail(`${model.error}: ${JSON.stringify(model)}`, { guiModelResult: model }); }

    const effort = await selectEffort(conn, CID, task.effort);
    const perm = await ensureBypassPermissions(conn, CID);
    if (!perm.ok) { if (original) await desktop.restoreActive(conn, CID, original); return fail(`${perm.error}: ${JSON.stringify(perm)} — a worker left on a prompting permission mode would stall on a yellow dot forever.`, { perm }); }

    const html = desktop.composerHtml(fullPrompt, MAX_PROMPT_CHARS);
    const res = await conn.evaluate(desktop.rEval(CID, `
      (async function(){
        if(location.href.split('/').pop() !== 'epitaxy') return 'nav-lost';
        var el=document.querySelector('.tiptap.ProseMirror');
        if(!el||!el.editor) return 'no-editor';
        el.editor.commands.focus();
        el.editor.commands.setContent('${html}');
        var b=null;
        for(var i=0;i<25;i++){
          await new Promise(function(r){setTimeout(r,100);});
          b=document.querySelector('button[aria-label="Send"]');
          if(b && !b.disabled) break;
        }
        var typed=(el.textContent||'').trim().length;
        if(location.href.split('/').pop() !== 'epitaxy') return 'nav-lost';
        if(${opts.dryRun ? 'true' : 'false'}){
          var ready=!!(b && !b.disabled);
          el.editor.commands.clearContent();
          return 'dry:'+(ready?'ready':'not-ready')+':'+typed;
        }
        if(b && !b.disabled){ b.click(); return 'sent-tentative:'+typed; }
        el.editor.commands.clearContent();
        return 'blocked';
      })()`));

    if (opts.dryRun) {
      const [, verdict, typed] = String(res || '').split(':');
      if (original) await desktop.restoreActive(conn, CID, original);
      return {
        ok: String(res || '').startsWith('dry:ready'), dryRun: true, result: res,
        charsTyped: Number(typed) || 0, sendButtonReady: verdict === 'ready',
        promptChars: fullPrompt.length, folder, model, effort, perm, restored: original,
        note: 'Composer was filled on the new-session view and cleared. No session was created and nothing was sent.',
      };
    }

    if (!String(res || '').startsWith('sent-tentative')) {
      if (original) await desktop.restoreActive(conn, CID, original);
      return fail(`GUI_SEND_${String(res || 'blocked').toUpperCase().replace(/[^A-Z_]/g, '_')}: the prompt could not be sent on the new-session view (${res}).`, { folder, model, effort, perm });
    }

    let sid = '';
    for (let i = 0; i < 40 && !sid; i++) {
      await sleep(400);
      const here = await conn.evaluate(desktop.rEval(CID, `location.href.split('/').pop()`));
      if (here && String(here).startsWith('local_')) sid = String(here);
    }
    if (!sid) {
      if (original) await desktop.restoreActive(conn, CID, original);
      return fail('GUI_NO_SESSION_ID: the prompt was sent but the URL never became a local_<uuid>, so the worker session could not be identified.', { folder, model, effort });
    }

    const started = registry.updateTask(task.id, {
      status: 'running', dispatch: 'gui', attempt,
      guiSessionId: sid, sessionId: sid,
      runCwd: task.cwd, pid: null, launchFailed: false,
      startedAt: new Date().toISOString(), endedAt: null,
      resultFile, logFile, error: null,
      guiTimeoutMs: opts.timeoutMs || task.guiTimeoutMs || DEFAULT_TIMEOUT_MS,
      guiFolder: folder.folder || null,
      guiModel: model.model || null,
      guiEffort: effort.ok ? (effort.effort || null) : null,
      guiEffortError: effort.ok ? null : (effort.error || null),
      tokensReported: false,
    });

    if (original) await desktop.restoreActive(conn, CID, original);

    return {
      ok: true, dispatch: 'gui', taskId: task.id, sessionId: sid,
      promptChars: fullPrompt.length, resultFile,
      folder, model, effort, perm, restored: original, task: started,
    };
  } finally { conn.close(); }
}

async function groupWorker(sessionId, groupName) {
  try { return await desktop.setGroup(sessionId, groupName); }
  catch (e) { return { ok: false, error: 'GROUP_FAILED', detail: String(e.message || e).slice(0, 200) }; }
}

async function sessionStillWorking(sessionId) {
  if (!sessionId) return false;
  let conn = null;
  try {
    conn = await desktop.connect(await desktop.wsUrl());
    const CID = await desktop.pickChat(conn);
    const j = await conn.evaluate(desktop.rEval(CID, `
      (async function(){
        var LS=window['claude.web'] && window['claude.web'].LocalSessions;
        if(!LS || typeof LS.getSession!=='function') return '';
        try{ var s=await LS.getSession(${JSON.stringify(String(sessionId))});
             if(!s) return '';
             return (s.isRunning || s.turnRunning) ? '1' : '0'; }catch(e){ return ''; }
      })()`));
    return j === '1';
  } catch { return false; }
  finally { try { if (conn) conn.close(); } catch {} }
}

async function poll(taskId, opts = {}) {
  let task = registry.getTask(taskId);
  if (!task || task.status !== 'running' || task.dispatch !== 'gui') return task;

  const res = readGuiResult(task.resultFile);
  if (res) return settle(task, res);

  let row = null, scraped = false;
  try {
    const snap = opts.sidebar || await desktop.scrapeSidebar();
    scraped = true;
    row = (snap.sessions || []).find(s => s.id === task.guiSessionId) || null;
  } catch { }

  const ageMs = Date.now() - Date.parse(task.startedAt || new Date().toISOString());
  const limit = task.guiTimeoutMs || DEFAULT_TIMEOUT_MS;

  if (scraped && !row) {
    if (ageMs < FINISH_GRACE_MS) return task;
    const late = readGuiResult(task.resultFile);
    if (late) return settle(task, late);
    return registry.updateTask(task.id, {
      status: 'failed', endedAt: new Date().toISOString(), pid: null,
      error: `GUI_SESSION_VANISHED: worker session ${task.guiSessionId} is no longer in the sidebar and no result file was written.`,
    });
  }

  if (row) {
    if (row.running) {
      return task.guiAwaiting ? registry.updateTask(task.id, { guiAwaiting: false }) : task;
    }
    if (row.awaiting) {
      return task.guiAwaiting ? task : registry.updateTask(task.id, {
        guiAwaiting: true,
        guiNote: `Worker session ${task.guiSessionId} is AWAITING INPUT — it asked a question. Read it with ccd_session_mgmt list_events (lossless) and reply with send_message.`,
      });
    }
    if (await sessionStillWorking(task.guiSessionId)) {
      return task.guiEndedSeenAt ? registry.updateTask(task.id, { guiEndedSeenAt: null, guiEndStatus: null }) : task;
    }
    if (!task.guiEndedSeenAt) return registry.updateTask(task.id, { guiEndedSeenAt: new Date().toISOString(), guiEndStatus: row.status });
    if (Date.now() - Date.parse(task.guiEndedSeenAt) < FINISH_GRACE_MS) return task;
    const late = readGuiResult(task.resultFile);
    if (late) return settle(task, late);
    return registry.updateTask(task.id, {
      status: 'failed', endedAt: new Date().toISOString(), pid: null, launchFailed: false,
      error: `GUI_NO_RESULT_FILE: worker session ${task.guiSessionId} finished (dot: "${row.status}") without writing ${path.basename(task.resultFile)}. Its answer may be in the session — read it with ccd_session_mgmt list_events.`,
    });
  }

  if (ageMs > limit) {
    return registry.updateTask(task.id, {
      status: 'failed', endedAt: new Date().toISOString(), pid: null,
      error: `GUI_TIMEOUT: worker session ${task.guiSessionId} produced no result within ${Math.round(limit / 60000)} minutes.`,
    });
  }
  return task;
}

function settle(task, res) {
  if (res.ok) {
    return registry.updateTask(task.id, {
      status: 'done', endedAt: new Date().toISOString(), pid: null,
      result: res.result,
      error: null,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      tokensReported: false, costUsd: 0,
      resultRaw: res.raw || false,
      guiAwaiting: false,
    });
  }
  return registry.updateTask(task.id, {
    status: 'failed', endedAt: new Date().toISOString(), pid: null,
    error: `gui worker reported failure: ${res.error || '(no reason given)'}${res.result ? ' :: ' + String(res.result).slice(0, 400) : ''}`,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    tokensReported: false,
    launchFailed: false,
    guiAwaiting: false,
  });
}

async function stop(taskId) {
  const task = registry.getTask(taskId);
  if (!task) return null;
  return registry.updateTask(task.id, {
    status: 'cancelled', endedAt: new Date().toISOString(), pid: null,
    error: task.guiSessionId
      ? `cancelled by master. NOTE: Desktop session ${task.guiSessionId} may still be running — Relaymote cannot kill a GUI session, only stop tracking it. Stop or archive it in the app if it should not finish.`
      : 'cancelled by master before dispatch',
  });
}

async function reconcile() {
  const out = { recovered: 0, failed: 0, stillRunning: 0 };
  const running = registry.allTasks().filter(t => t.status === 'running' && t.dispatch === 'gui');
  if (!running.length) return out;
  let sidebar = null;
  try { sidebar = await desktop.scrapeSidebar(); } catch {}
  for (const t of running) {
    const after = await poll(t.id, sidebar ? { sidebar } : {});
    if (!after) continue;
    if (after.status === 'done') out.recovered++;
    else if (after.status === 'failed') out.failed++;
    else out.stillRunning++;
  }
  return out;
}

module.exports = {
  sessionStillWorking,
  lastFolderSteps,
  checkCliAuth, chooseDispatch, HEADLESS_RETIRED, dispatch, poll, stop, reconcile, groupWorker,
  wrapPrompt, readGuiResult, guiResultFile, folderLabelFor,
  selectFolder, selectModel, selectEffort, modelLabelRx, ensureBypassPermissions,
  CLICK_NEW_JS, PTR_FN,
  EFFORT_SLIDER, MAX_PROMPT_CHARS, DEFAULT_TIMEOUT_MS, FINISH_GRACE_MS, RESULTS,
};
