'use strict';
// Read-aloud audio (g808). The phone's own speechSynthesis is silenced by Chrome the moment the screen
// locks or the page is hidden, so the text is spoken HERE with the desktop's own voice, saved as a WAV
// and played by the phone through a plain <audio> element, which keeps playing with the screen off.
// Nothing runs when nothing is being read: one short-lived synth process per new text, then a cache hit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DATA } = require('../lib/config');

const DIR = path.join(DATA, 'tts-cache');
const MAX_CHARS = 60000;
const KEEP_MS = 3 * 24 * 3600 * 1000;
const KEEP_BYTES = 300 * 1024 * 1024;
const RATE = 22050;                                   // 16-bit mono: ~44 KB per second of speech

const PS = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
  "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(" + RATE + ", [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); " +
  "$s.SetOutputToWaveFile($env:RM_TTS_OUT, $f); $s.Speak([System.IO.File]::ReadAllText($env:RM_TTS_IN, [System.Text.Encoding]::UTF8)); $s.Dispose()";

function engine(inFile, outFile) {
  if (process.platform === 'win32') return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', PS] };
  if (process.platform === 'darwin') return { cmd: 'say', args: ['-o', outFile, '--data-format=LEI16@' + RATE, '-f', inFile] };
  return { cmd: 'espeak-ng', args: ['-w', outFile, '-f', inFile], alt: { cmd: 'espeak', args: ['-w', outFile, '-f', inFile] } };
}

// Natural voice first: Microsoft's free Edge neural voices through the python `edge-tts` package (no key,
// no account, needs internet). Without python/edge-tts/internet the desktop's own voice below is used.
const VOICE = process.env.RELAYMOTE_TTS_VOICE || 'en-IN-NeerjaNeural';
let edgePy = null;                                    // the python command that has edge_tts, once found

function keyOf(text) { return crypto.createHash('sha1').update('edge1|' + VOICE + '|' + process.platform + '\n' + text).digest('hex'); }
function fileOf(key) {
  if (!/^[0-9a-f]{40}$/.test(key || '')) return null;
  const mp3 = path.join(DIR, key + '.mp3');
  return fs.existsSync(mp3) ? mp3 : path.join(DIR, key + '.wav');
}

function run(spec, env) {
  return new Promise((resolve) => {
    let done = false, err = '';
    const fin = (ok, why) => { if (!done) { done = true; clearTimeout(t); resolve({ ok, why }); } };
    let c;
    try { c = spawn(spec.cmd, spec.args, { env: Object.assign({}, process.env, env), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { return resolve({ ok: false, why: e.message, missing: e.code === 'ENOENT' }); }
    const t = setTimeout(() => { try { c.kill(); } catch {} fin(false, 'timed out'); }, 180000);
    c.stderr.on('data', d => { err += d; });
    c.on('error', e => fin(false, e.message + (e.code === 'ENOENT' ? ' (no speech engine installed)' : '')));
    c.on('close', code => fin(code === 0, err.trim().slice(0, 300) || ('exit ' + code)));
  });
}

let chain = Promise.resolve();                        // one synth at a time; the long ones must not pile up
const inflight = new Map();

function prune() {
  try {
    const now = Date.now();
    const rows = fs.readdirSync(DIR).filter(n => n.endsWith('.wav') || n.endsWith('.mp3')).map(n => {
      const p = path.join(DIR, n); const st = fs.statSync(p); return { p, at: st.mtimeMs, size: st.size };
    }).sort((a, b) => b.at - a.at);
    let total = 0;
    for (const r of rows) { total += r.size; if (now - r.at > KEEP_MS || total > KEEP_BYTES) { try { fs.unlinkSync(r.p); } catch {} } }
  } catch {}
}

// A python process that stays up with edge_tts imported: each request then skips ~0.9 s of start-up.
// One line of JSON in, one line out. If it dies, the next request falls back to a one-shot run.
const WORKER_PY = [
  'import sys, json, asyncio, edge_tts',
  'async def one(j):',
  '    await edge_tts.Communicate(open(j["in"], encoding="utf-8").read(), j["voice"]).save(j["out"])',
  'for line in sys.stdin:',
  '    try:',
  '        j = json.loads(line); asyncio.run(one(j)); print(json.dumps({"id": j["id"], "ok": True}), flush=True)',
  '    except Exception as e:',
  '        print(json.dumps({"id": (j or {}).get("id") if isinstance(j, dict) else None, "ok": False, "err": str(e)[:200]}), flush=True)',
].join('\n');
let worker = null, wSeq = 0;
const wWait = new Map();
function getWorker() {
  if (worker || !edgePy) return worker;
  try {
    const c = spawn(edgePy, ['-u', '-c', WORKER_PY], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    c.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        const w = wWait.get(m.id); if (w) { wWait.delete(m.id); w(!!m.ok); }
      }
    });
    const dead = () => { if (worker === c) worker = null; for (const [, w] of wWait) w(null); wWait.clear(); };
    c.on('exit', dead); c.on('error', dead);
    c.stdin.on('error', () => {});
    c.unref(); try { c.stdout.unref(); c.stdin.unref(); } catch {}   // never keeps the daemon (or a test) alive
    worker = c;
  } catch { worker = null; }
  return worker;
}
function workerSynth(inFile, outFile) {
  const c = getWorker();
  if (!c) return Promise.resolve(null);
  const id = ++wSeq;
  return new Promise(res => {
    const t = setTimeout(() => { wWait.delete(id); res(null); }, 120000);
    wWait.set(id, (v) => { clearTimeout(t); res(v); });
    try { c.stdin.write(JSON.stringify({ id, in: inFile, out: outFile, voice: VOICE }) + '\n'); }
    catch { clearTimeout(t); wWait.delete(id); res(null); }
  });
}

async function edgeSynth(inFile, outFile) {
  if (edgePy) {
    const w = await workerSynth(inFile, outFile);
    if (w === true) return true;
    if (w === false) { try { fs.unlinkSync(outFile); } catch {} return false; }   // the service failed (offline)
  }
  const cands = edgePy ? [edgePy] : [process.env.RELAYMOTE_TTS_PYTHON, 'python', 'python3', 'py',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe'),
    'C:\\Program Files\\Python\\Python311\\python.exe'].filter(Boolean);
  for (const py of cands) {
    if (!edgePy) { const chk = await run({ cmd: py, args: ['-c', 'import edge_tts'] }, {}); if (!chk.ok) continue; }
    const r = await run({ cmd: py, args: ['-m', 'edge_tts', '--voice', VOICE, '--file', inFile, '--write-media', outFile] }, {});
    if (r.ok) { edgePy = py; return true; }
    try { fs.unlinkSync(outFile); } catch {}
    return false;                                     // python is fine, the service is not (offline): fall back
  }
  return false;
}

// Called once at start-up: find python + edge_tts and start the worker, so the first tap is fast too.
async function warm() {
  if (edgePy) return getWorker() ? true : false;
  const cands = [process.env.RELAYMOTE_TTS_PYTHON, 'python', 'python3', 'py',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Python', 'Python311', 'python.exe'),
    'C:\\Program Files\\Python\\Python311\\python.exe'].filter(Boolean);
  for (const py of cands) {
    const chk = await run({ cmd: py, args: ['-c', 'import edge_tts'] }, {});
    if (chk.ok) { edgePy = py; return !!getWorker(); }
  }
  return false;
}

async function synth(rawText) {
  const text = String(rawText || '').replace(/\u0000/g, ' ').trim().slice(0, MAX_CHARS);
  if (!text) return { ok: false, error: 'NO_TEXT' };
  const key = keyOf(text), out = fileOf(key);
  try { const st = fs.statSync(out); if (st.size > 1000) { fs.utimesSync(out, new Date(), new Date()); return { ok: true, key, bytes: st.size, cached: true }; } } catch {}
  if (inflight.has(key)) return inflight.get(key);
  const job = chain.then(async () => {
    fs.mkdirSync(DIR, { recursive: true });
    const tmpIn = path.join(os.tmpdir(), 'rm-tts-' + key + '.txt'), tmpOut = out + '.part';
    fs.writeFileSync(tmpIn, text, 'utf8');
    try {
      const mp3 = path.join(DIR, key + '.mp3'), mp3Part = mp3 + '.part';
      if (await edgeSynth(tmpIn, mp3Part)) {
        const ms = (() => { try { return fs.statSync(mp3Part); } catch { return null; } })();
        if (ms && ms.size > 1000) { fs.renameSync(mp3Part, mp3); prune(); return { ok: true, key, bytes: ms.size, cached: false, voice: VOICE }; }
      }
      const spec = engine(tmpIn, tmpOut);
      let r = await run(spec, { RM_TTS_IN: tmpIn, RM_TTS_OUT: tmpOut });
      if (!r.ok && spec.alt) r = await run(spec.alt, {});
      const st = (() => { try { return fs.statSync(tmpOut); } catch { return null; } })();
      if (!r.ok || !st || st.size < 1000) {
        try { fs.unlinkSync(tmpOut); } catch {}
        return { ok: false, error: 'NO_SPEECH_ENGINE', message: 'This computer could not turn the text into speech: ' + (r.why || 'no output') };
      }
      fs.renameSync(tmpOut, out);
      prune();
      return { ok: true, key, bytes: st.size, cached: false };
    } finally { try { fs.unlinkSync(tmpIn); } catch {} }
  }).catch(e => ({ ok: false, error: 'TTS_FAILED', message: e.message }));
  chain = job.then(() => {}, () => {});
  inflight.set(key, job);
  job.finally(() => inflight.delete(key));
  return job;
}

module.exports = { synth, warm, _workerSynth: (a, b) => workerSynth(a, b), fileOf, keyOf, DIR, MAX_CHARS, RATE };
