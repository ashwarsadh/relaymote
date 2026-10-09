'use strict';
// pairing-page.js — g1588: what a phone sees when it is not paired (a new phone, a reset token, a
// cleared browser). It used to be one grey sentence; now the user pairs by themselves: open
// Settings › Pair a phone on the PC, then scan its QR here (or with the camera app) or paste the link.

function pairingPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair Relaymote</title>
<style>
:root{--bg:#12110f;--fg:#e8e6e1;--mut:#9b958c;--card:#1d1b18;--acc:#d97757;--line:#2e2b27}
@media (prefers-color-scheme: light){:root{--bg:#faf9f5;--fg:#1f1e1c;--mut:#6b665e;--card:#fff;--line:#e3dfd6}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:460px;margin:0 auto;padding:28px 16px 40px}
h1{font-size:22px;margin:0 0 4px}p{margin:.4rem 0}.mut{color:var(--mut)}
ol{padding-left:1.2rem;margin:.6rem 0}li{margin:.35rem 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:14px 0}
button{font:inherit;border:0;border-radius:10px;padding:11px 16px;background:var(--acc);color:#fff;width:100%;margin-top:8px}
button.sec{background:transparent;color:var(--fg);border:1px solid var(--line)}
input{font:inherit;width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
video{width:100%;border-radius:10px;margin-top:10px;display:none;background:#000}
#err{color:#e5534b;min-height:1.2em}
</style></head><body><main>
<h1>Pair this phone</h1>
<p class="mut">This phone is not paired with your PC yet (or its pairing was reset). Pair it once; it stays paired.</p>
<div class="card"><b>1. On your PC</b>
<ol><li>Open <b>Relaymote</b> (its icon in the taskbar tray, or run <code>relaymote pair</code>).</li>
<li>Go to <b>Settings › Pair a phone</b>. A QR code appears.</li></ol></div>
<div class="card"><b>2. On this phone</b>
<p>Point your phone's <b>camera app</b> at the QR code and open the link — that pairs it.</p>
<button id="scan">Scan the QR code here</button>
<video id="cam" playsinline muted></video>
<p style="margin-top:14px">Or paste the pairing link (copy it from the PC):</p>
<input id="link" placeholder="https://…/?k=…" autocomplete="off" autocapitalize="off" spellcheck="false">
<button class="sec" id="go">Pair with this link</button>
<p id="err"></p></div>
<p class="mut">Using Cloudflare Access? Open your Relaymote address instead; it asks you to sign in.</p>
</main><script>
const err = (t) => { document.getElementById('err').textContent = t; };
function use(text) {
  let u; try { u = new URL(String(text).trim(), location.href); } catch { return err('That is not a link. Copy the whole pairing link from the PC.'); }
  if (!u.searchParams.get('k')) return err('That link has no pairing key in it. Copy the link shown under the QR code on the PC.');
  location.href = u.href;
}
document.getElementById('go').onclick = () => use(document.getElementById('link').value);
document.getElementById('link').addEventListener('keydown', e => { if (e.key === 'Enter') use(e.target.value); });
document.getElementById('scan').onclick = async () => {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices || !window.isSecureContext)
    return err('This browser cannot scan here. Use the phone\\'s camera app on the QR code, or paste the link.');
  try {
    const v = document.getElementById('cam');
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    v.srcObject = st; v.style.display = 'block'; await v.play();
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    const loop = async () => {
      const codes = await det.detect(v).catch(() => []);
      if (codes.length) { st.getTracks().forEach(t => t.stop()); return use(codes[0].rawValue); }
      requestAnimationFrame(loop);
    };
    loop();
  } catch (e) { err('The camera did not open (' + (e && e.name || 'blocked') + '). Use the phone\\'s camera app, or paste the link.'); }
};
</script></body></html>`;
}

module.exports = { pairingPage };
