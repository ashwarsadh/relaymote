/* KKFE "Install app" helper — one self-contained file (JS + its own CSS). Master copy:
   D:\Documents of KKFE\Ashwar\development\pwa-install-helper\install-helper.js  (copy it into an app's static root;
   do not hot-link it, so the app's service worker can cache it and it works offline).

   Ashwar, 17-Oct-2026: "add PWA helper to all such apps, so that it shows the install button and guides how to
   install ... As currently I don't get any install button prompt."

   What it does:
   - Chrome / Edge / Samsung with `beforeinstallprompt`: shows an "Install app" pill; a tap opens the real install dialog.
   - No such event (iPhone/iPad, Firefox, an in-app browser such as WhatsApp's, or a prompt Chrome is holding back):
     the same pill opens a one-screen guide with the steps for THIS browser.
   - Hidden when the page already runs installed (display-mode standalone / iOS navigator.standalone), after
     `appinstalled`, and for 14 days after the user taps the pill's ×.

   Use (no closing script tag may appear in this file: it is also pasted inline):
         <script src="/install-helper.js" defer data-app="KKFE Desk" data-bottom="84"> (closed by the end-script tag)
   - data-app     name shown in the guide (default: the page title up to its first separator)
   - data-bottom  px between the pill and the bottom of the screen (raise it above a bottom tab bar; default 18)
   - data-desktop "1" also offers the guide on a desktop when no prompt arrives (default: desktop shows the pill only
                  when the browser itself says the page is installable)
   API:  window.KKInstall.open()  opens the guide (or the real prompt) from the app's own menu item.
         window.KKInstall.state() -> {installed, promptReady, browser}
   The app still needs its own manifest (name, short_name, 192+512 icons, start_url, scope, display standalone),
   a service worker with a fetch handler, and HTTPS. Behind Cloudflare Access link the manifest with
   crossorigin="use-credentials", or the manifest fetch is redirected to the login page and nothing installs. */
(function () {
  "use strict";
  if (window.KKInstall) return;
  var me = document.currentScript || {};
  var cfg = (me && me.dataset) || {};
  var KEY = "kkinstall.dismissed";
  var SNOOZE_MS = 14 * 24 * 3600 * 1000;
  var ua = navigator.userAgent || "";
  var deferred = null, installedNow = false, pill = null, sheet = null;

  function standalone() {
    try {
      if (window.matchMedia("(display-mode: standalone)").matches) return true;
      if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
      if (window.matchMedia("(display-mode: minimal-ui)").matches) return true;
      if (window.matchMedia("(display-mode: window-controls-overlay)").matches) return true;
    } catch (e) { /* old browser */ }
    return window.navigator.standalone === true || document.referrer.indexOf("android-app://") === 0;
  }

  function browser() {
    var ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    var android = /Android/.test(ua);
    var inapp = /FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|; wv\)|GSA\//.test(ua);
    var kind = "other";
    if (inapp) kind = "inapp";
    else if (ios && /CriOS/.test(ua)) kind = "ios-chrome";
    else if (ios && /FxiOS|EdgiOS|OPiOS/.test(ua)) kind = "ios-other";
    else if (ios) kind = "ios-safari";
    else if (/SamsungBrowser/.test(ua)) kind = "samsung";
    else if (android && /Firefox/.test(ua)) kind = "android-firefox";
    else if (android && /EdgA/.test(ua)) kind = "android-edge";
    else if (android && /Chrome/.test(ua)) kind = "android-chrome";
    else if (/Edg\//.test(ua)) kind = "desktop-edge";
    else if (/Chrome/.test(ua)) kind = "desktop-chrome";
    else if (/Firefox/.test(ua)) kind = "desktop-firefox";
    else if (/Safari/.test(ua)) kind = "desktop-safari";
    return { kind: kind, ios: ios, mobile: ios || android || /Mobi/.test(ua) };
  }

  function snoozed() {
    try { var t = +localStorage.getItem(KEY); return t && Date.now() - t < SNOOZE_MS; } catch (e) { return false; }
  }
  function snooze() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) { /* private mode */ } }

  var SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 11v9h14v-9"/></svg>';
  var DOTS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>';
  var MENU = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  var PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg>';
  var DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></svg>';

  function steps(kind) {
    var host = location.host;
    switch (kind) {
      case "ios-safari": return ["Tap the <b>Share</b> button " + SHARE + " at the bottom of Safari.",
        "Scroll down and tap <b>Add to Home Screen</b> " + PLUS + ".", "Tap <b>Add</b>. The app opens from your Home Screen, full screen."];
      case "ios-chrome": return ["Tap the <b>Share</b> button " + SHARE + " at the top right, next to the address.",
        "Tap <b>Add to Home Screen</b> " + PLUS + ". (Needs iOS 16.4 or newer; on older iPhones open this page in <b>Safari</b>.)", "Tap <b>Add</b>."];
      case "ios-other": return ["This browser cannot install apps on iPhone.", "Copy the address <b>" + host + "</b> and open it in <b>Safari</b>.",
        "Then tap <b>Share</b> " + SHARE + " \u2192 <b>Add to Home Screen</b> " + PLUS + "."];
      case "samsung": return ["Tap the menu " + MENU + " at the bottom right.", "Tap <b>Add page to</b> \u2192 <b>Home screen</b> (or the install icon " + DOWN + " in the address bar if it shows).",
        "Tap <b>Add</b>."];
      case "android-firefox": return ["Tap the menu " + DOTS + ".", "Tap <b>Install</b> (or <b>Add to Home screen</b>).", "Tap <b>Add</b>."];
      case "android-edge": return ["Tap the menu " + DOTS + " (or " + MENU + ") at the bottom.", "Tap <b>Add to phone</b> / <b>Install app</b>.", "Tap <b>Install</b>."];
      case "android-chrome": return ["Tap the menu " + DOTS + " at the top right of Chrome.",
        "Tap <b>Install app</b> " + DOWN + " (on some phones: <b>Add to Home screen</b> \u2192 <b>Install</b>).", "Tap <b>Install</b>. It appears in your app drawer and Home screen."];
      case "inapp": return ["You are inside another app's browser (WhatsApp, Instagram\u2026), which cannot install apps.",
        "Tap " + DOTS + " and choose <b>Open in Chrome</b> (iPhone: <b>Open in Safari</b>).", "Then tap <b>Install app</b> here again."];
      case "desktop-chrome": return ["Click the install icon " + DOWN + " at the right end of the address bar.",
        "Or menu " + DOTS + " \u2192 <b>Cast, save and share</b> \u2192 <b>Install page as app</b>.", "Click <b>Install</b>."];
      case "desktop-edge": return ["Click the <b>App available</b> icon " + PLUS + " in the address bar.", "Or menu \u2026 \u2192 <b>Apps</b> \u2192 <b>Install this site as an app</b>.", "Click <b>Install</b>."];
      case "desktop-safari": return ["Menu <b>File</b> \u2192 <b>Add to Dock</b> (macOS Sonoma or newer).", "Click <b>Add</b>."];
      default: return ["Open this page in <b>Chrome</b> (Android, computer) or <b>Safari</b> (iPhone).",
        "Then use the browser menu: <b>Install app</b> / <b>Add to Home Screen</b>."];
    }
  }

  function appName() {
    if (cfg.app) return cfg.app;
    return (document.title || "this app").split(/[\u2014|\u00b7-]/)[0].trim() || "this app";
  }

  var CSS = [
    ".kki-pill{position:fixed;z-index:2147483000;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:2px;",
    "font:600 15px/1.2 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.22);",
    "background:var(--kki-bg);color:var(--kki-fg);border:1px solid var(--kki-line);max-width:calc(100vw - 32px)}",
    ".kki-pill button{all:unset;cursor:pointer;display:flex;align-items:center;gap:8px;padding:11px 8px 11px 16px;min-height:24px}",
    ".kki-pill button.kki-x{padding:11px 14px 11px 8px;opacity:.6;font-weight:500}",
    ".kki-pill button:focus-visible{outline:2px solid var(--kki-acc);outline-offset:2px;border-radius:999px}",
    ".kki-pill svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    ".kki-wrap{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.45)}",
    ".kki-sheet{box-sizing:border-box;width:100%;max-width:460px;max-height:92vh;overflow:auto;background:var(--kki-bg);color:var(--kki-fg);",
    "border-radius:18px 18px 0 0;padding:20px 20px calc(20px + env(safe-area-inset-bottom));font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    "@media (min-width:600px){.kki-wrap{align-items:center}.kki-sheet{border-radius:18px}}",
    ".kki-sheet h2{margin:0 0 4px;font-size:19px;line-height:1.3}",
    ".kki-sheet p.kki-sub{margin:0 0 14px;opacity:.75;font-size:14px}",
    ".kki-sheet ol{margin:0 0 16px;padding:0;list-style:none;counter-reset:k}",
    ".kki-sheet li{counter-increment:k;position:relative;padding:10px 0 10px 40px;border-top:1px solid var(--kki-line)}",
    ".kki-sheet li:before{content:counter(k);position:absolute;left:0;top:9px;width:26px;height:26px;border-radius:50%;",
    "background:var(--kki-acc);color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center}",
    ".kki-sheet li svg{width:18px;height:18px;vertical-align:-3px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    ".kki-sheet li svg circle{fill:currentColor;stroke:none}",
    ".kki-sheet .kki-ok{all:unset;box-sizing:border-box;display:block;width:100%;text-align:center;cursor:pointer;padding:12px;",
    "border-radius:12px;background:var(--kki-acc);color:#fff;font-weight:700}",
    ".kki-pill,.kki-sheet{--kki-bg:#fff;--kki-fg:#16181d;--kki-line:rgba(0,0,0,.12);--kki-acc:#3344a5}",
    "@media (prefers-color-scheme:dark){.kki-pill,.kki-sheet{--kki-bg:#1d2127;--kki-fg:#eef0f3;--kki-line:rgba(255,255,255,.14);--kki-acc:#6f80ff}}"
  ].join("");

  function addCss() {
    if (document.getElementById("kki-css")) return;
    var s = document.createElement("style"); s.id = "kki-css"; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function hidePill() { if (pill) { pill.remove(); pill = null; } }

  function showPill() {
    if (pill || standalone() || installedNow || snoozed()) return;
    var b = browser();
    // A desktop shows the pill only when the browser itself says the page can be installed.
    if (!deferred && !b.mobile && cfg.desktop !== "1") return;
    addCss();
    pill = document.createElement("div");
    pill.className = "kki-pill"; pill.setAttribute("role", "region"); pill.setAttribute("aria-label", "Install app");
    pill.style.bottom = "calc(env(safe-area-inset-bottom) + " + (parseInt(cfg.bottom, 10) || 18) + "px)";
    pill.innerHTML = '<button type="button" class="kki-go">' + DOWN + '<span>Install app</span></button>' +
      '<button type="button" class="kki-x" aria-label="Not now">\u2715</button>';
    pill.querySelector(".kki-go").addEventListener("click", open);
    pill.querySelector(".kki-x").addEventListener("click", function () { snooze(); hidePill(); });
    document.body.appendChild(pill);
  }

  function closeSheet() { if (sheet) { sheet.remove(); sheet = null; } }

  function guide() {
    closeSheet(); addCss();
    var b = browser(), list = steps(b.kind);
    sheet = document.createElement("div");
    sheet.className = "kki-wrap";
    sheet.innerHTML = '<div class="kki-sheet" role="dialog" aria-modal="true" aria-labelledby="kki-h">' +
      '<h2 id="kki-h">Install ' + appName().replace(/</g, "&lt;") + '</h2>' +
      '<p class="kki-sub">It then opens like an app, full screen, from your home screen \u2014 and stays signed in.</p>' +
      "<ol>" + list.map(function (t) { return "<li>" + t + "</li>"; }).join("") + "</ol>" +
      '<button type="button" class="kki-ok">Got it</button></div>';
    sheet.addEventListener("click", function (e) { if (e.target === sheet) closeSheet(); });
    sheet.querySelector(".kki-ok").addEventListener("click", closeSheet);
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { closeSheet(); document.removeEventListener("keydown", esc); } });
    document.body.appendChild(sheet);
    sheet.querySelector(".kki-ok").focus();
  }

  function open() {
    if (standalone()) return;
    if (deferred) {
      var p = deferred; deferred = null;
      p.prompt();
      (p.userChoice || Promise.resolve({})).then(function (r) {
        if (r && r.outcome === "accepted") { installedNow = true; hidePill(); }
      });
      return;
    }
    guide();
  }

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferred = e;
    if (document.body) showPill(); else document.addEventListener("DOMContentLoaded", showPill);
  });
  window.addEventListener("appinstalled", function () { installedNow = true; deferred = null; hidePill(); closeSheet(); });
  try {
    window.matchMedia("(display-mode: standalone)").addEventListener("change", function (m) { if (m.matches) { hidePill(); closeSheet(); } });
  } catch (e) { /* Safari < 14 */ }

  function later() {
    // Give Chrome a moment to fire beforeinstallprompt; without it, show the guide pill.
    setTimeout(showPill, deferred ? 0 : (parseInt(cfg.delay, 10) || 3500));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", later); else later();

  window.KKInstall = {
    open: open,
    state: function () { return { installed: standalone() || installedNow, promptReady: !!deferred, browser: browser().kind }; }
  };
})();
