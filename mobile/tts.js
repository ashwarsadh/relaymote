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

function keyOf(text) { return crypto.createHash('sha1').update(process.platform + '\n' + text).digest('hex'); }
function fileOf(key) { return /^[0-9a-f]{40}$/.test(key || '') ? path.join(DIR, key + '.wav') : null; }

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
    const rows = fs.readdirSync(DIR).filter(n => n.endsWith('.wav')).map(n => {
      const p = path.join(DIR, n); const st = fs.statSync(p); return { p, at: st.mtimeMs, size: st.size };
    }).sort((a, b) => b.at - a.at);
    let total = 0;
    for (const r of rows) { total += r.size; if (now - r.at > KEEP_MS || total > KEEP_BYTES) { try { fs.unlinkSync(r.p); } catch {} } }
  } catch {}
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

module.exports = { synth, fileOf, keyOf, DIR, MAX_CHARS, RATE };
