// config.js — where Relaymote keeps its data, and the user's settings.
//
// Everything Relaymote writes lives under ONE directory (default ~/.relaymote, override with RELAYMOTE_HOME):
//   settings.json   what the Settings screen edits
//   state/          queue, logs, snapshots, caches
//   mobile/         access token, push keys, sub-users
//   uploads/        files sent from the phone
//   results/        worker results
//   auth/           private Claude config dir for headless workers
//
// Settings are read fresh on every get() (mtime-cached), so a change made in the Settings screen
// takes effect on the next tick without restarting the daemon, except where noted (ports).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const ROOT = path.join(__dirname, '..');
const DATA = process.env.RELAYMOTE_HOME || path.join(HOME, '.relaymote');
const STATE = process.env.RELAYMOTE_STATE_DIR || path.join(DATA, 'state');
const MOBILE = path.join(DATA, 'mobile');
const UPLOADS = path.join(DATA, 'uploads');
const RESULTS = path.join(DATA, 'results');
const AUTH = path.join(DATA, 'auth');
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const APPDATA = process.env.APPDATA || (process.platform === 'darwin' ? path.join(HOME, 'Library', 'Application Support') : process.platform === 'win32' ? path.join(HOME, 'AppData', 'Roaming') : path.join(HOME, '.config'));
const SETTINGS_FILE = path.join(DATA, 'settings.json');

for (const d of [DATA, STATE, MOBILE, UPLOADS, RESULTS]) { try { fs.mkdirSync(d, { recursive: true }); } catch {} }

// Every key the Settings screen knows about, with its default. Unknown keys in settings.json are
// preserved but ignored.
const DEFAULTS = {
  // Ports. Changing either needs a daemon restart.
  port: 8788,            // control API + dashboard, loopback only
  appPort: 8790,         // the phone/desktop app, token-protected
  appBind: 'auto',       // 'auto' = loopback + Tailscale (if present) + LAN when remote.mode is 'lan'

  cdpPort: 9229,         // Claude Desktop's main-process debugger (Developer > Enable Main Process Debugger)
  autoEnableDebugger: true, // Windows: switch the debugger back on after Claude Desktop restarts (3-2-1 countdown on screen, once signed in)
  followClaude: false,   // Windows tray: start Relaymote when Claude Desktop opens; when Desktop exits, run the account sync, then stop

  modules: {
    app: true,            // phone + desktop web app: sessions, chat, send, model/effort, push
    autoResume: true,     // resume sessions stopped by a usage limit or a Desktop crash
    orchestrator: true,   // master/worker MCP tools: spawn, fleet, goals, await
    chipAutostart: false, // press Start on background-task chips in sessions a master owns
    masterNotify: true,   // wake the master when a worker finishes or asks something
    board: false,         // a tappable to-do board read from a JSON file (see docs/BOARD.md)
    routines: true,       // show Claude Code scheduled tasks in the app
    accounts: false,      // multiple Claude accounts on one machine (experimental)
    organizer: true,      // put each new, ungrouped session into its project's sidebar group
    goalChaser: false,    // goal register: route goals to owners, nudge owners that stop before finishing
    cacheKeeper: false,   // time those nudges inside the owner's 1-hour prompt cache window
    finishHook: false,    // Stop hook: a session may not end its turn on a question it can answer (`relaymote hooks install`)
    transcriptIndex: true, // read transcripts (incrementally) into the project index: prompts, pending state, context, buried asks
    digests: false,       // keep a lean per-session digest (your messages + each turn's final answer) under <data>/conductor/digests
    osTasks: false,       // list the OS scheduled tasks (schtasks / launchd / cron) and the project that owns each
    summaries: false,     // 5-line overview per changed session (needs a model engine; see `engine` below)
    roles: true,          // roles DB for owner routing; FREE heuristic (title/tags/project) unless an engine is set
    directives: false,    // daily: your own words per project from the digests -> <project>/DIRECTIVES.md (writes into project folders)
    inbox: true,          // things only you can do: an append-only inbox (relaymote_inbox_add, `relaymote inbox`); passive until something adds to it
    inboxAutoResolve: false, // move inbox items to "resolved?" on evidence (a tap, the session reporting after it); never straight to done
    hygiene: true,        // context hygiene report every 30 min (HYGIENE.md, hygiene.json) + archive candidates + daily wake roll-up; writes files only
    autoCompact: false,   // type /compact into COMPACT sessions in their last warm cycle (state on disk, idle, confirmed by the app); capped
    reaper: false,        // release the CLI (~400 MB) of a session idle 3 h+ through the app's own teardown; dry for its first 24 h
    autoUpdate: true,     // install new releases by itself (Windows installer copies; others only report); signed + checksummed
  },

  // Never drive the Desktop window while you are using the computer. Actions queue until you have
  // been idle this long. 0 disables the gate. Where idle time cannot be read (Linux without
  // xprintidle) the user counts as ACTIVE, so actions wait; set 0 there to run them anyway.
  idleGateSeconds: 120,

  // Folders whose immediate subfolders headless workers may open without Claude Code's trust
  // prompt (e.g. your projects folder). [] = only Relaymote's own folders and the task's own folder.
  // Absolute paths; a drive/filesystem root is refused. Settings › Advanced.
  trustedRoots: [],

  remote: {
    mode: 'off',          // off | lan | tailscale | cloudflare-quick | cloudflare-named
    hostname: '',         // cloudflare-named: e.g. relaymote.example.com
    tunnelName: 'relaymote',  // cloudflare-named: tunnel name created in your Cloudflare account
    cloudflaredPath: '',  // blank = find cloudflared on PATH
    access: { team: '', aud: '' }, // optional Cloudflare Access verification (team.cloudflareaccess.com + AUD tag)
  },

  // pushSubject: your contact for push services (mailto: or https:). Blank = a placeholder that
  // Apple's push service may refuse; Settings › Notifications asks for a real one.
  // backup: a second route when web push reaches no phone (mobile/alerts.js). kind: off | ntfy |
  // webhook | command; url for ntfy/webhook; command for command; always = also when push worked.
  // maxPer10Min caps backup sends (counted before sending, never retried).
  notifications: { enabled: true, awaiting: true, done: true, pushSubject: '',
                   backup: { kind: 'off', url: '', command: '', always: false }, maxPer10Min: 6,
                   // healthAlarm: where "no phone is subscribed any more" is said (mobile/pushhealth.js),
                   // since push itself cannot say it. kind: backup (use the backup channel) | off | ntfy |
                   // webhook | command. Sent only on a change of state, never on a timer.
                   healthAlarm: { kind: 'backup', url: '', command: '' } },

  workers: {
    concurrency: 3,
    guiConcurrency: 2,
    dispatch: 'auto',     // auto | headless | gui
    defaultModel: 'claude-opus-5-5',
  },

  // Settings > Models. Workers are graded easy..extraHard and started on the model + effort mapped
  // here; "escalate" moves one level up. Model: a name from the Desktop picker or a model id.
  levels: {
    easy:      { model: 'claude-opus-5-5', effort: 'low' },
    medium:    { model: 'claude-opus-5-5', effort: 'medium' },
    hard:      { model: 'claude-opus-5-5', effort: 'high' },
    extraHard: { model: 'claude-opus-5-5', effort: 'max' },
  },
  // Sessions you start from the app. Blank = whatever Claude Desktop would pick.
  newSession: { model: '', effort: '', instructions: '' },
  // g551: before Relaymote wakes an existing session, switch it to newSession's model/effort (lib/tier-policy.js) ...
  tierBeforeWake: true,
  // ... except within this many hours of the user changing that session's model or effort by hand.
  tierOverrideHours: 4,

  // Optional integrations; blank = feature hidden.
  // board.json folder (default <data>/board); html: where board.html is written (default <data>/board.html);
  // finishedKeepDays: finished goals shown in the Finished drawer; generate: overwrite a board written by something else.
  board: { dir: '', html: '', finishedKeepDays: 3, generate: false },
  // Inbox (lib/inbox.js). ownerName: how cards address you. graceDays: a "resolved?" item closes after this
  // only when its evidence was strong. recordDays: an old record-type item is flagged, low confidence.
  // criticalWords / recordWords / undecidedWords: null = the built-in generic list; an array REPLACES it
  // (critical = money, deletion, anything sent outward: never auto-resolved on weak evidence).
  // notOwnerPrefixes: text prefixes meaning "a session reporting", not you speaking.
  inbox: { ownerName: 'you', graceDays: 4, recordDays: 5, sweepDays: 2, visibleChars: 178, askMaxChars: 200,
    criticalWords: null, recordWords: null, undecidedWords: null, notOwnerPrefixes: [] },
  conductorSession: '',   // the Conductor: set by relaymote_become_conductor; receives Board taps and master reports
  ownerIndex: '',         // an external owner index directory; blank = Relaymote's own (<data>/conductor)
  // Project index / transcript intelligence (lib/projects.js, lib/transcripts.js, lib/digests.js, lib/ostasks.js).
  // ctx thresholds are on a BYTE estimate (a hint, not a liveness signal); compactions are the ground truth.
  // criticalWords / skipSlugs: null = the built-in generic list; an array REPLACES it. noticePatterns: extra regex sources.
  // taskOwners: { "<path prefix>": "<project>" } for OS scheduled tasks. projectsRoot: where `newproject` creates folders.
  index: { budgetMs: 4000, bytesPerToken: 4, ctxFull: 400000, ctxTight: 250000, criticalWords: null, noticePatterns: [],
    skipSlugs: null, ownerLabel: 'USER', taskOwners: {}, projectsRoot: '', osTasksMaxAgeMinutes: 360 },
  teachingsFile: '',      // where the Conductor appends the user's standing teachings, verbatim; blank = <data>/TEACHINGS.md
  // Directives module (lib/directions.js). runAt: local "HH:MM" of the daily pass. ownerName: how the files name you
  // (blank = "you"). include/exclude: project names (include [] = every project with a folder). ACTIVE window: start
  // startDays, shrink while > activeKb (not below minDays), widen while < minItems (not past maxDays); "substantial" =
  // substantialChars. acks / machinePatterns / envelopeTags: null = built-in generic list, an array REPLACES it;
  // extraMachinePatterns / extraCredentialLabels ADD regex sources. elsewhereFiles: paths inside a project folder that
  // hold older history, named on a thin page. knownStatusFile: per-project judged status, [{ask,date,status,evidence}].
  directives: { runAt: '05:00', ownerName: '', include: [], exclude: [], substantialChars: 400, activeKb: 40, startDays: 30,
    minDays: 3, maxDays: 120, minItems: 5, staleHours: 24, headChars: 200, envelopePrefixMin: 15, acks: null,
    machinePatterns: null, extraMachinePatterns: [], envelopeTags: null, extraCredentialLabels: [], elsewhereFiles: [],
    knownStatusFile: '.relaymote/known-status.json' },
  // The optional finish-the-task Stop hook (hooks/finish-the-task.js). Extra patterns are regex sources.
  finishHook: { tailChars: 320, extraAskPatterns: [], extraCriticalPatterns: [], reason: '' },

  // Organizer module: groupBy 'project' is the only mode; rename maps a project name to a group name.
  organizer: { autoGroup: true, groupBy: 'project', rename: {} },

  // Goal chaser (lib/goals.js). A goal is STUCK after quietHours (health threshold) without a report; a warm
  // owner is pinged once it has been quiet warmPingMinQuietHours; a stuck goal is re-chased after rechaseHours;
  // after maxChases unanswered chases it waits for your judgement. requireVerification: an owner's DONE makes the
  // goal DELIVERED (you close it with evidence) instead of closing it. (Old key stuckHours is read as quietHours.)
  goals: { autoSpawn: false, quietHours: 36, warmPingMinQuietHours: 4, maxChasesPerCycle: 5, rechaseHours: 96, maxChases: 3, blockedStaleDays: 7,
    warmRechaseHours: 12, autoRehome: false, dryRun: false, requireVerification: true },
  // Cache keeper: warm owners (last reply < windowMinutes ago) are pinged pingFrom..pingUntil minutes
  // after they stopped; cold owners only when a goal is late or quiet for coldAfterHours.
  cacheKeeper: { windowMinutes: 60, pingFromMinutes: 25, pingUntilMinutes: 55, coldAfterHours: 72, keepConductorWarm: false },
  // Context hygiene (lib/hygiene.js). Token thresholds null = index.ctxFull / index.ctxTight. A session is
  // compacted only mid-task, over fullTokens, with its state authored on disk (a doc >= minStateBytes it
  // wrote in its project, and one of stateFiles newer than the session), idle compactFrom..compactUntil
  // minutes (its last warm cycle). stateFiles: names that count as a written state/handoff doc.
  hygiene: { intervalMinutes: 30, fullTokens: null, tightTokens: null, dormantDays: 7, maxCompactions: 2, compactPerCycle: 2,
    compactFromMinutes: 25, compactUntilMinutes: 55, verifyAfterHours: 6, recompactHours: 24, retryFailedMinutes: 60,
    minStateBytes: 2048, stateFiles: ['STATE.md', 'HANDOFF.md', 'PLAN.md', 'NOTES.md', 'CLAUDE.md', 'DIRECTIVES.md'] },
  // Idle-CLI reaper (lib/reaper.js; module `reaper`). A released session respawns with --resume on its next
  // message. A Remote Control session is never released (not configurable: it would vanish from the phone).
  reaper: { idleHours: 3, dryHours: 24, maxPerTick: 6 },
  // Self-update (lib/updater.js; module `autoUpdate`). Checks GitHub Releases every checkHours; installs only a
  // release whose SHA256SUMS.txt carries a valid signature by the release key, and only while no task runs.
  update: { checkHours: 6, repo: 'ashwarsadh/relaymote' },
  // Archive candidates (lib/archive.js; relaymote_archive_candidates). Never archives. idleDays default 14.
  // disposablePatterns / completionPatterns: regex sources; null = the built-in generic lists, an array REPLACES them.
  archive: { idleDays: 14, supersedeJaccard: 0.6, mentionMinTokens: 3, masterEndedDays: 7, disposablePatterns: null, completionPatterns: null },

  // Accounts module (docs/ACCOUNTS.md). mode: 'add' (never removes; also carries archive state and
  // session details unless syncArchive/syncState are off) | 'two-way' (also routine edits, group moves).
  // scope: 'all' or a list of scope keys. roles: per scope 'keep' | 'add' | 'two-way'.
  // foldGroups: bring sidebar groups that exist only in another account into each account (off:
  // each account's groups are only healed). firstRunMode: 'baseline' | 'archived-wins'.
  // lockFile: share another sync tool's lock file (blank = Relaymote's own); only one tool should sync.
  accounts: { enabled: true, scope: 'all', mode: 'add', roles: {}, autoSync: false, intervalMinutes: 30,
    syncArchive: true, syncState: true, foldGroups: false, firstRunMode: 'baseline', lockFile: '' },

  // Model engine (lib/engine.js): the ONE place Relaymote asks a language model for text (session overviews,
  // roles DB). kind: none (default: nothing is ever sent) | openai (any OpenAI-compatible server) |
  // claude-cli (`claude -p`, headless, no tools) | baton-worker (Relaymote's own headless queue). claude-cli
  // and baton-worker run on YOUR Claude plan. openai: the key is read from the environment variable named
  // in apiKeyEnv — a key written into this file is refused. requireModel: refuse an answer whose serving
  // model differs from `model` (or cannot be verified). fallbackKind/fallbackModel: a second engine the
  // roles DB may try on a failure (capped by roles.fallbackCap). refusalPatterns: extra regex sources.
  engine: { kind: 'none', model: '', requireModel: false, timeoutSec: 180,
    openai: { baseUrl: '', apiKeyEnv: '', responseFormat: false, servedHeader: '' },
    claudeCli: { bin: '', allowApiKey: false },
    fallbackKind: 'none', fallbackModel: '', refusalPatterns: [] },
  // Summaries module: cap per run, time budget, activity window (days), minutes between daemon passes.
  summaries: { cap: 6, budgetMin: 20, days: 14, intervalMinutes: 30 },
  // Roles module: engine classifications per run, time budget, activity window, fallback-engine cap.
  roles: { budget: 60, budgetMin: 15, activeDays: 30, fallbackCap: 12 },
};

function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k])) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

let cache = null, cacheMtime = -1;
function readRaw() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}
function get() {
  let m = 0; try { m = fs.statSync(SETTINGS_FILE).mtimeMs; } catch {}
  if (cache && m === cacheMtime) return cache;
  cache = merge(DEFAULTS, readRaw()); cacheMtime = m;
  // Environment overrides win (useful for tests and service managers).
  if (process.env.RELAYMOTE_PORT) cache.port = Number(process.env.RELAYMOTE_PORT);
  if (process.env.RELAYMOTE_APP_PORT) cache.appPort = Number(process.env.RELAYMOTE_APP_PORT);
  if (process.env.RELAYMOTE_CDP_PORT) cache.cdpPort = Number(process.env.RELAYMOTE_CDP_PORT);
  return cache;
}
/** Deep-merge a patch into settings.json and return the new effective settings. */
function set(patch) {
  const next = merge(readRaw(), patch || {});
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
  cache = null;
  return get();
}
const mod = name => !!(get().modules || {})[name];

module.exports = {
  HOME, ROOT, DATA, STATE, MOBILE, UPLOADS, RESULTS, AUTH, CLAUDE_HOME, APPDATA, SETTINGS_FILE,
  DEFAULTS, get, set, mod,
};
