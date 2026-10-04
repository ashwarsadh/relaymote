// g1162: typing "/" on the phone stopped opening the commands-and-skills list. One failed /api/commands
// (a daemon restart, or a stall) cached an EMPTY list for the life of the page, so "/" did nothing until
// a reload. The real client functions are run here against a server that fails and then comes back.
const fs = require('fs'), path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'public', 'app.js'), 'utf8');
let fails = 0;
const check = (ok, what, got) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (got !== undefined ? '  ' + JSON.stringify(got) : '')); if (!ok) fails++; };

const start = app.indexOf('let commandList = null');
const end = app.indexOf("$('cmdlist').addEventListener('click'");
check(start > 0 && end > start, 'the command-list code is found');
const src = app.slice(start, end);

function world() {
  const store = {};
  const box = { innerHTML: '', cls: new Set(['hidden']), classList: null, children: [] };
  box.classList = { add: c => box.cls.add(c), remove: c => box.cls.delete(c) };
  const input = { value: '' };
  const env = { up: true, calls: 0 };
  const LIST = [{ name: 'goal', kind: 'built-in' }, { name: 'conductor', kind: 'skill' }, { name: 'compact', kind: 'built-in' }]
    .concat(Array.from({ length: 24 }, (_, i) => ({ name: 'a-skill-' + String(i).padStart(2, '0'), kind: 'skill' })));
  const api = async (p) => { env.calls++; if (!env.up) throw new Error('Failed to fetch'); return { ok: true, commands: LIST }; };
  const localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const $ = id => (id === 'cmdlist' ? box : input);
  const esc = s => String(s);
  const f = new Function('api', 'localStorage', '$', 'esc', src + '\nreturn { ensureCommands, updateCommandList, get list() { return commandList; }, set at(v) { commandsAt = v; } };');
  return { env, box, input, store, fns: f(api, localStorage, $, esc) };
}
const shown = (w) => !w.box.cls.has('hidden');
const tick = () => new Promise(r => setTimeout(r, 0));

(async () => {
  // 1. The server is down for the first "/" (a restart). It must say so, and must NOT stay broken.
  let w = world();
  w.env.up = false;
  w.input.value = '/';
  await w.fns.updateCommandList();
  check(shown(w) && /could not be loaded/.test(w.box.innerHTML), 'with the PC unreachable and nothing saved, "/" says the list could not be loaded (not silence)');
  w.env.up = true;
  await w.fns.updateCommandList();
  check(shown(w) && /\/goal/.test(w.box.innerHTML) && /\/conductor/.test(w.box.innerHTML), 'once the PC answers, the next "/" opens the list with /goal and the skills', w.box.innerHTML.slice(0, 80));

  check((w.box.innerHTML.match(/class="cmd"/g) || []).length === 27, 'a bare "/" lists ALL 27 commands (it showed only the first 8, hiding /goal)');

  // 2. A list fetched once is kept on the device: a later outage still shows it.
  const w2 = world();
  Object.assign(w2.store, w.store);
  w2.env.up = false;
  w2.input.value = '/';
  await w2.fns.updateCommandList();
  check(shown(w2) && /\/goal/.test(w2.box.innerHTML), 'with the PC restarting, "/" shows the last list this phone saw');

  // 3. Typing narrows it; a match-less word hides it; text after the command hides it.
  w.input.value = '/co'; await w.fns.updateCommandList();
  check(shown(w) && /conductor/.test(w.box.innerHTML) && !/\/goal/.test(w.box.innerHTML), '"/co" narrows to the matching commands');
  w.input.value = '/zzz'; await w.fns.updateCommandList();
  check(!shown(w), 'a word nothing matches closes the list');
  w.input.value = 'hello /goal'; await w.fns.updateCommandList();
  check(!shown(w), 'a "/" inside a sentence does not open it');

  // 4. A stale list is refreshed behind the scenes, so newly added skills appear.
  const before = w.env.calls;
  w.fns.at = 0; w.input.value = '/'; await w.fns.updateCommandList(); await tick(); await tick();
  check(w.env.calls > before, 'a list older than its time-to-live is fetched again (new skills appear)');

  check(/setTimeout\(\(\) => \{ ensureCommands\(\)/.test(app), 'the list is fetched at load, so the first "/" does not wait');

  if (fails) { console.error(fails + ' failed'); process.exit(1); }
  console.log('slash-commands: all checks passed');
})();
