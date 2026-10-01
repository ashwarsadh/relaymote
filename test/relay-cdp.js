// relay-cdp.js — the link to Claude Desktop's debugger (lib/desktop.js connect()/wsUrl(), and the
// bridge's connectRaw()), under the things a reconnect does to it: Desktop not there, the debugger
// hanging, the socket dropping in the middle of a call, the debugger coming back on the same port,
// a call made while it is coming back, and the serialized UI queue a phone action waits in.
// Offline: every "desktop" is a local stand-in on 127.0.0.1 (relay-harness cdpStub / silentServer /
// mobile-harness fakeDesktop). Each guard is shown both passing and refusing.
'use strict';
const H = require('./relay-harness');
const W = H.world('relay-cdp', { demo: false, env: true });
const { check, knownBug, wait } = H;

const config = require('../lib/config');
const desktop = require('../lib/desktop');
const bridge = require('../lib/bridge');

const timed = async (fn) => { const t0 = Date.now(); try { return { v: await fn(), ms: Date.now() - t0 }; } catch (e) { return { err: e, ms: Date.now() - t0 }; } };

(async () => {
  if (!config.STATE.startsWith(W.dir)) { console.error('REFUSING TO RUN: state dir is not inside the temp world -', config.STATE); process.exit(1); }

  console.log('--- Desktop unreachable: every entry point fails fast and closed ---');
  {
    const dead = await H.deadPort();
    config.set({ cdpPort: dead });
    const a = await timed(() => desktop.wsUrl());
    check(!!a.err && /ECONNREFUSED/.test(a.err.message) && a.ms < 2000, 'wsUrl() on a closed port rejects with ECONNREFUSED at once', { ms: a.ms, err: a.err && a.err.message });
    check((await desktop.cdpAvailable()) === false, 'cdpAvailable() says false, it does not throw');
    const b = await timed(() => bridge.wsUrl());
    check(!!b.err && b.ms < 2000, 'the bridge\'s own wsUrl() fails the same way', { ms: b.ms });
    const q = await timed(() => desktop.sendQueued('local_x', 'hello from the phone'));
    check(!!q.err || (q.v && q.v.ok === false), 'sendQueued with no debugger never reports ok (it throws, the caller keeps the slip)', q.v || (q.err && q.err.message));
    const r = await desktop.sendQueued('', 'x');
    check(r.ok === false && r.error === 'NO_SESSION_ID', 'refusal before any desktop work: no session id -> NO_SESSION_ID');
    const e = await desktop.sendQueued('local_x', '   ');
    check(e.ok === false && e.error === 'EMPTY', 'refusal before any desktop work: blank text -> EMPTY');
  }

  console.log('\n--- the debugger hangs: the probe and the handshake time out ---');
  {
    const silent = await H.silentServer();
    config.set({ cdpPort: silent.port });
    const a = await timed(() => desktop.wsUrl());
    check(!!a.err && /cdp probe timeout/.test(a.err.message) && a.ms >= 3500 && a.ms < 7000, 'a /json probe that gets no answer gives up after ~4s with "cdp probe timeout"', { ms: a.ms, err: a.err && a.err.message });
    const before = silent.open.size;
    const c = await timed(() => desktop.connect(`ws://127.0.0.1:${silent.port}/main`, { evalTimeout: 1000 }));
    check(!!c.err && /cdp connect timeout/.test(c.err.message) && c.ms >= 7500 && c.ms < 11000, 'a WebSocket that never upgrades gives up after ~8s with "cdp connect timeout"', { ms: c.ms, err: c.err && c.err.message });
    await wait(500);
    knownBug(silent.open.size <= before, 'a connect that timed out also closes its socket (lib/desktop.js:26 rejects but never terminates it, so each hung attempt leaks one)',
      { openSocketsAfterTimeout: silent.open.size - before });
    await silent.close();
  }

  console.log('\n--- calls on a live debugger: reply, exception, timeout ---');
  const stub = await H.cdpStub((expr) => {
    if (expr === 'HANG') return { hang: true };
    if (expr === 'DROP') return { close: true };
    if (expr === 'BOOM') return { exception: 'ReferenceError: nope' };
    return { value: 'echo:' + expr };
  });
  config.set({ cdpPort: stub.port });
  {
    const url = await desktop.wsUrl();
    check(url === `ws://127.0.0.1:${stub.port}/main`, 'wsUrl() returns the debugger\'s WebSocket url', url);
    const conn = await desktop.connect(url, { evalTimeout: 900 });
    check((await conn.evaluate('1+1')) === 'echo:1+1', 'a reply resolves the matching call');
    const ex = await timed(() => conn.evaluate('BOOM'));
    check(!!ex.err && /ReferenceError: nope/.test(ex.err.message), 'an exception in Desktop rejects the call with its text', ex.err && ex.err.message);
    const t = await timed(() => conn.evaluate('HANG'));
    check(!!t.err && t.err.message === 'eval timeout' && t.ms >= 800 && t.ms < 2500, 'a call Desktop never answers rejects with "eval timeout" after evalTimeout', { ms: t.ms });
    check((await conn.evaluate('after')) === 'echo:after', 'the connection still works after one call timed out');
    conn.close();
  }

  console.log('\n--- the socket drops in the middle of a call ---');
  {
    const conn = await desktop.connect(await desktop.wsUrl(), { evalTimeout: 2500 });
    const d = await timed(() => conn.evaluate('DROP'));
    check(!!d.err, 'a call whose socket drops is rejected, never resolved with a made-up value', d.err && d.err.message);
    knownBug(d.ms < 1000, 'it is rejected when the socket closes (no "close" handler in lib/desktop.js:21-45, so it waits out the whole evalTimeout: 20s default, 60s for a composer send)',
      { rejectedAfterMs: d.ms, error: d.err && d.err.message });
    const after = await timed(() => conn.evaluate('1'));
    check(!!after.err, 'a call on the dead connection is rejected too', after.err && after.err.message);
    knownBug(after.ms < 1000, 'a call made on an already-closed socket fails at once (it is sent into a closed socket and waits for the timeout)', { rejectedAfterMs: after.ms });
    const raw = await bridge.connectRaw(await bridge.wsUrl(), 2500);
    const br = await timed(() => raw.evaluate('DROP'));
    knownBug(!!br.err && br.ms < 1000, 'the bridge (lib/bridge.js:21-48) rejects on close too — same missing handler', { rejectedAfterMs: br.ms, error: br.err && br.err.message });
  }

  console.log('\n--- the debugger goes away and comes back on the same port ---');
  {
    const n0 = stub.conns;
    check((await (await desktop.connect(await desktop.wsUrl(), { evalTimeout: 900 })).evaluate('up')) === 'echo:up', 'precondition: the debugger answers');
    await stub.stop();
    const down = await timed(() => desktop.wsUrl());
    check(!!down.err && down.ms < 2000, 'while it is gone, a new call fails fast (ECONNREFUSED), nothing waits on a dead link', down.err && down.err.message);
    check((await desktop.cdpAvailable()) === false, 'cdpAvailable() reports it down');
    await stub.start();
    check((await desktop.cdpAvailable()) === true, 'once it is back on the same port, cdpAvailable() reports it up — no restart of Relaymote needed');
    const c2 = await desktop.connect(await desktop.wsUrl(), { evalTimeout: 900 });
    check((await c2.evaluate('back')) === 'echo:back', 'and a call goes through again');
    c2.close();
    check(stub.conns > n0 + 1, 'every call opens its own connection, so no stale socket from before the outage is reused', { opened: stub.conns - n0 });
  }

  console.log('\n--- a call made while the debugger is restarting ---');
  {
    let release;
    stub.behave = (expr) => expr === 'SLOW' ? new Promise(r => { release = r; }).then(() => ({ value: 'late' })) : { value: 'echo:' + expr };
    const conn = await desktop.connect(await desktop.wsUrl(), { evalTimeout: 1800 });
    const inflight = timed(() => conn.evaluate('SLOW'));
    await wait(150);
    await stub.stop();                 // Desktop restarts while the call is in flight
    await stub.start();
    if (release) release();
    const r = await inflight;
    check(!!r.err, 'the in-flight call is rejected, never resolved by the restarted debugger', r.err && r.err.message);
    check(r.v !== 'late', 'its late answer from the old process is not delivered to anyone');
    const c3 = await desktop.connect(await desktop.wsUrl(), { evalTimeout: 900 });
    check((await c3.evaluate('fresh')) === 'echo:fresh', 'a call made after the restart works on a fresh connection');
    c3.close();
  }

  console.log('\n--- the serialized UI queue: one hung call holds every phone action behind it ---');
  {
    stub.behave = (expr) => expr === 'HANG' ? { hang: true } : { value: 'echo:' + expr };
    const order = [];
    const conn = await desktop.connect(await desktop.wsUrl(), { evalTimeout: 1500 });
    const t0 = Date.now();
    const first = desktop.serializeUi(async () => { order.push('first:start'); try { return await conn.evaluate('HANG'); } finally { order.push('first:end'); } });
    const second = desktop.serializeUi(async () => { order.push('second:start'); return conn.evaluate('quick'); });
    const [a, b] = await Promise.allSettled([first, second]);
    const waited = Date.now() - t0;
    check(a.status === 'rejected' && b.status === 'fulfilled' && b.value === 'echo:quick', 'the queue recovers: a failed action does not poison the next one', { a: a.status, b: b.status });
    check(order.join(',') === 'first:start,first:end,second:start', 'actions run strictly one at a time, in order', order.join(','));
    check(waited >= 1400, 'the second action waited out the first one\'s whole timeout (head-of-line blocking; see NOTES risk 3)', { waitedMs: waited });
    conn.close();
  }

  console.log('\n--- a background send that delivered but reported failure falls back to the composer ---');
  {
    await stub.stop();
    const fake = await H.fakeDesktop();
    config.set({ cdpPort: fake.port, idleGateSeconds: 0 });
    const SID = 'local_relay-cdp-dup';
    const S = { model: 'claude-opus-5', effort: 'high', transcript: [] };
    let running = false;
    // Delivery lands, then the call throws (as when the reply is lost) — the shape of a send whose answer never came back.
    Object.defineProperty(S, 'isRunning', { get: () => running, set: (v) => { if (v) throw new Error('connection lost after delivery'); running = v; } });
    fake.sessions[SID] = S;
    const t = await timed(() => desktop.sendMessage(SID, 'RELAY-DUP-PROBE please reply once', { protect: false }));
    const out = t.v || { threw: t.err && t.err.message };
    const landed = S.transcript.filter(r => r.type === 'user' && String(r.message.content).includes('RELAY-DUP-PROBE')).length;
    check(landed === 1, 'precondition: the background send DID deliver the message once', landed);
    // The composer path either returns { transport: 'composer', backgroundUnavailable } or throws from one of its
    // own steps (its error names the step: pick-window, find-row, ...). Either one proves it was entered.
    const enteredComposer = (out.transport === 'composer' && /bridge-error/.test(String(out.backgroundUnavailable || ''))) ||
      /at step "(pick-window|find-row|[a-z-]+)"/.test(String(out.threw || ''));
    check(enteredComposer, 'the exported sendMessage then tries the composer (lib/desktop.js:3692-3705): a second delivery attempt of a message that already landed',
      { transport: out.transport, backgroundUnavailable: out.backgroundUnavailable, threw: out.threw && String(out.threw).slice(0, 120) });
    const r2 = await timed(() => desktop.sendMessageBackground(SID, '   '));
    check(r2.v && r2.v.ok === false && r2.v.error === 'EMPTY_MESSAGE', 'refusal: a blank background send is refused before any desktop work (and the export does not fall back for it)');
    console.log(`  (in the stand-in the composer stops at: ${String(out.result || out.error || out.threw || 'n/a').slice(0, 100)}; against a real Desktop it would type the text again: risk 1)`);
    fake.close();
  }

  H.finish(W, 'relay-cdp');
})().catch(e => { console.error('THREW', e); process.exit(1); });
