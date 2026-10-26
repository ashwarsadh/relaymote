/* KKFE "Install app" helper v2 -- one self-contained file (JS + its own CSS). Master copy:
   D:\Documents of KKFE\Ashwar\development\pwa-install-helper\install-helper.js  (copy it into an app's static root;
   do not hot-link it, so the app's service worker can cache it and it works offline).

   Ashwar, 17-Oct-2026: "add PWA helper to all such apps, so that it shows the install button and guides how to
   install ... As currently I don't get any install button prompt."
   Ashwar, 27-Oct-2026 (iPhone, Nirvaan Gyaan): the guide pointed at the bottom-right button, which on the newest
   iPhone is the tab switcher; the menu sits beside the address bar. "it should be made smarter so that it can
   support all the versions of iPhone ... show a small animation ... with maybe some handy notes".

   What it does:
   - Chrome / Edge / Samsung with `beforeinstallprompt`: an "Install app" pill; a tap opens the real install dialog.
   - No such event: the pill opens a guide for THIS browser AND layout, with a looping animated mock of that
     browser's bar that taps the right button for each step:
       iPhone Safari 26+ (Compact bar: ... beside the address bar), iPhone Safari 15-18 (Share mid bottom bar),
       iPad (Share top right), Chrome / Firefox / Edge on iOS, Android Chrome, Samsung Internet, Firefox,
       in-app browsers (WhatsApp, Instagram ...), desktop.
   - "Still stuck?" loads the maintained library @khmyznikov/pwa-install (pinned, LIB below, SRI-checked) and opens
     its own guide, which its author updates for each new iOS / Android release.
   - Hidden when installed (display-mode standalone / navigator.standalone), after `appinstalled`, and 14 days
     after the pill's x.

   Use (no closing script tag may appear in this file: it is also pasted inline; keep it ASCII -- non-ASCII text is
   written as \u escapes, see README "Editing"):
         <script src="/install-helper.js" defer data-app="KKFE Desk" data-bottom="84"> (closed by the end-script tag)
   - data-app     name shown in the guide (default: the page title up to its first separator)
   - data-bottom  px between the pill and the bottom of the screen (raise it above a bottom tab bar; default 18)
   - data-desktop "1" also offers the guide on a desktop when no prompt arrives
   - data-lang    "hi" for Hindi (default: <html lang>, else English)
   - data-pill    "0" never shows the pill; the app calls KKInstall.open() from its own button
   - data-lib     "0" never loads the library (no "Still stuck?" link)
   API:  window.KKInstall.open()   opens the real prompt, or the guide
         window.KKInstall.state()  -> {installed, promptReady, browser, layout, lang}
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
  // Pinned maintained library. Update: README "Library".
  var LIB = "https://cdn.jsdelivr.net/npm/@khmyznikov/pwa-install@0.7.0/dist/pwa-install.bundle.js";
  var LIB_SRI = "sha384-tvuS5qQPVL6Nyw9WED3Dsy33F1Ie4lk8PxPhrW8XA+rlwFn45/PlAPgbCP7a0eVC";
  var ua = navigator.userAgent || "";
  var deferred = null, installedNow = false, pill = null, sheet = null, timer = null;
  var lang = (cfg.lang || document.documentElement.lang || "en").slice(0, 2) === "hi" ? "hi" : "en";

  function standalone() {
    try {
      if (window.matchMedia("(display-mode: standalone)").matches) return true;
      if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
      if (window.matchMedia("(display-mode: minimal-ui)").matches) return true;
      if (window.matchMedia("(display-mode: window-controls-overlay)").matches) return true;
    } catch (e) { /* old browser */ }
    return window.navigator.standalone === true || document.referrer.indexOf("android-app://") === 0;
  }

  // iOS 26 Safari freezes the OS in its UA at 18_x but says Version/26; take the larger of the two.
  // With no Version token (a web view), a WebKit-only feature check stands in for 26+.
  function iosMajor() {
    var v = /Version\/(\d+)/.exec(ua), o = /OS (\d+)_/.exec(ua);
    var n = Math.max(v ? +v[1] : 0, o ? +o[1] : 0);
    if (!v && !window.chrome) { try { if (CSS.supports("text-wrap", "pretty")) n = Math.max(n, 26); } catch (e) { /* old */ } }
    return n;
  }

  function browser() {
    var ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    var ios = ipad || /iPhone|iPod/.test(ua);
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
    var layout = kind;
    if (kind === "ios-safari") layout = ipad ? "ipad-safari" : (iosMajor() >= 26 ? "iphone-safari-26" : "iphone-safari-classic");
    return { kind: kind, layout: layout, ios: ios, ipad: ipad, mobile: ios || android || /Mobi/.test(ua) };
  }

  function snoozed() {
    try { var t = +localStorage.getItem(KEY); return t && Date.now() - t < SNOOZE_MS; } catch (e) { return false; }
  }
  function snooze() { try { localStorage.setItem(KEY, String(Date.now())); } catch (e) { /* private mode */ } }

  var I = {
    share: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 11v9h14v-9"/></svg>',
    dots: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    vdots: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
    menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg>',
    down: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    fwd: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
    book: '<svg viewBox="0 0 24 24"><path d="M4 5c3-1 6-1 8 1 2-2 5-2 8-1v14c-3-1-6-1-8 1-2-2-5-2-8-1z"/></svg>',
    tabs: '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="13" height="13" rx="2"/><path d="M4 8v11a1 1 0 0 0 1 1h11"/></svg>',
    home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v9H4z"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    more: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/></svg>'
  };

  /* Words in one place: T(en, hi). */
  function T(en, hi) { return lang === "hi" ? hi : en; }
  function b(s) { return "<b>" + s + "</b>"; }
  var W = {
    share: function () { return b(T("Share", "\u0936\u0947\u092f\u0930 (Share)")) + " " + I.share; },
    add: function () { return b(T("Add to Home Screen", "Add to Home Screen")) + " " + I.plus; },
    dots: function () { return b("\u2022\u2022\u2022"); }
  };

  /* A flow = steps; each step = [text, frame]. A frame draws a mini browser:
     {bar:"bottom"|"top", items:[icon names | "addr"], hit:index}  or  {sheet:[[icon,label],...], hit:row, from:"bottom"|"top"} */
  function flow(layout) {
    var host = location.host;
    var addTitle = T("Add to Home Screen", "Add to Home Screen");
    var shareSheet = function (hit) {
      return { from: "bottom", sheet: [["copy", T("Copy", "Copy")], ["book", T("Add Bookmark", "Add Bookmark")],
        ["more", T("View More", "View More")], ["plus", addTitle]], hit: hit };
    };
    var addDialog = { from: "top", sheet: [["home", T("Open as Web App  \u25cf", "Open as Web App  \u25cf")], ["plus", b("Add")]], hit: 1 };
    switch (layout) {
      case "iphone-safari-26": return {
        note: T("Newest iPhones (iOS 26): Share is hidden behind " + W.dots() + ". The button at the far right is the tab switcher -- not that one. " +
                "If your Safari shows the Share icon in the bar itself (Bottom or Top layout), tap it and go to step 3.",
                "\u0928\u090f iPhone (iOS 26): Share, " + W.dots() + " \u0915\u0947 \u0905\u0902\u0926\u0930 \u091b\u093f\u092a\u093e \u0939\u0948\u0964 \u0938\u092c\u0938\u0947 \u0926\u093e\u0939\u093f\u0928\u093e \u092c\u091f\u0928 \u091f\u0948\u092c \u092c\u0926\u0932\u0928\u0947 \u0915\u093e \u0939\u0948 -- \u0935\u0939 \u0928\u0939\u0940\u0902\u0964 " +
                "\u0905\u0917\u0930 Share \u0915\u093e \u0928\u093f\u0936\u093e\u0928 \u0938\u0940\u0927\u0947 \u092c\u093e\u0930 \u092e\u0947\u0902 \u0926\u093f\u0916\u0947, \u0924\u094b \u0909\u0938\u0947 \u0926\u092c\u093e\u0915\u0930 \u0938\u094d\u091f\u0947\u092a 3 \u092a\u0930 \u091c\u093e\u090f\u0901\u0964"),
        steps: [
          [T("Tap " + W.dots() + " right next to the address bar.", W.dots() + " \u0926\u092c\u093e\u090f\u0901 -- \u092a\u0924\u0947 \u0935\u093e\u0932\u0940 \u092a\u091f\u094d\u091f\u0940 \u0915\u0947 \u0920\u0940\u0915 \u092c\u0917\u0932 \u092e\u0947\u0902\u0964"),
            { bar: "bottom", items: ["back", "dots", "addr", "tabs"], hit: 1 }],
          [T("Tap " + W.share() + ".", W.share() + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { from: "bottom", sheet: [["share", T("Share", "Share")], ["book", T("Add Bookmark", "Add Bookmark")], ["tabs", T("New Tab", "New Tab")]], hit: 0 }],
          [T("Tap " + W.add() + ". Not in the list? Tap " + b("View More") + " first.",
             W.add() + " \u0926\u092c\u093e\u090f\u0901\u0964 \u0938\u0942\u091a\u0940 \u092e\u0947\u0902 \u0928\u0939\u0940\u0902? \u092a\u0939\u0932\u0947 " + b("View More") + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            shareSheet(3)],
          [T("Keep " + b("Open as Web App") + " on, then tap " + b("Add") + ".",
             b("Open as Web App") + " \u091a\u093e\u0932\u0942 \u0930\u0916\u0947\u0902, \u092b\u093f\u0930 " + b("Add") + " \u0926\u092c\u093e\u090f\u0901\u0964"), addDialog]
        ] };
      case "iphone-safari-classic": return {
        note: T("Bar hidden after scrolling? Tap the bottom edge of the screen to bring it back.",
                "\u0928\u0940\u091a\u0947 \u0915\u093e \u092c\u093e\u0930 \u0928\u0939\u0940\u0902 \u0926\u093f\u0916 \u0930\u0939\u093e? \u0938\u094d\u0915\u094d\u0930\u0940\u0928 \u0915\u0947 \u0928\u093f\u091a\u0932\u0947 \u0915\u093f\u0928\u093e\u0930\u0947 \u092a\u0930 \u091f\u0948\u092a \u0915\u0930\u0947\u0902\u0964"),
        steps: [
          [T("Tap " + W.share() + " in the middle of the bottom bar.", "\u0928\u0940\u091a\u0947 \u0935\u093e\u0932\u0947 \u092c\u093e\u0930 \u0915\u0947 \u092c\u0940\u091a \u092e\u0947\u0902 " + W.share() + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { bar: "bottom", items: ["back", "fwd", "share", "book", "tabs"], hit: 2 }],
          [T("Scroll the list down and tap " + W.add() + ".", "\u0938\u0942\u091a\u0940 \u0915\u094b \u090a\u092a\u0930 \u0938\u0930\u0915\u093e\u0915\u0930 " + W.add() + " \u0926\u092c\u093e\u090f\u0901\u0964"), shareSheet(3)],
          [T("Tap " + b("Add") + " at the top right.", "\u090a\u092a\u0930 \u0926\u093e\u0939\u093f\u0928\u0947 " + b("Add") + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { from: "top", sheet: [["home", addTitle], ["plus", b("Add")]], hit: 1 }]
        ] };
      case "ipad-safari": return {
        note: T("iPadOS 26: if Share is not in the bar, tap " + W.dots() + " beside the address first.",
                "iPadOS 26: \u092c\u093e\u0930 \u092e\u0947\u0902 Share \u0928 \u0939\u094b \u0924\u094b \u092a\u0939\u0932\u0947 \u092a\u0924\u0947 \u0915\u0947 \u092c\u0917\u0932 \u0935\u093e\u0932\u093e " + W.dots() + " \u0926\u092c\u093e\u090f\u0901\u0964"),
        steps: [
          [T("Tap " + W.share() + " at the top right, beside the address.", "\u090a\u092a\u0930 \u0926\u093e\u0939\u093f\u0928\u0947, \u092a\u0924\u0947 \u0915\u0947 \u092c\u0917\u0932 \u092e\u0947\u0902 " + W.share() + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { bar: "top", items: ["back", "addr", "share", "plus", "tabs"], hit: 2 }],
          [T("Tap " + W.add() + " (under " + b("View More") + " if hidden).", W.add() + " \u0926\u092c\u093e\u090f\u0901 (\u0928 \u0926\u093f\u0916\u0947 \u0924\u094b " + b("View More") + " \u092e\u0947\u0902)\u0964"), shareSheet(3)],
          [T("Tap " + b("Add") + ".", b("Add") + " \u0926\u092c\u093e\u090f\u0901\u0964"), addDialog]
        ] };
      case "ios-chrome": return {
        note: T("Needs iOS 16.4 or newer. On an older iPhone open " + b(host) + " in Safari.",
                "iOS 16.4 \u092f\u093e \u0928\u092f\u093e \u091a\u093e\u0939\u093f\u090f\u0964 \u092a\u0941\u0930\u093e\u0928\u0947 iPhone \u092a\u0930 " + b(host) + " \u0915\u094b Safari \u092e\u0947\u0902 \u0916\u094b\u0932\u0947\u0902\u0964"),
        steps: [
          [T("Tap " + W.share() + " at the right end of the address bar.", "\u092a\u0924\u0947 \u0915\u0940 \u092a\u091f\u094d\u091f\u0940 \u0915\u0947 \u0926\u093e\u0939\u093f\u0928\u0947 \u0938\u093f\u0930\u0947 \u092a\u0930 " + W.share() + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { bar: "top", items: ["addr", "share"], hit: 1 }],
          [T("Tap " + W.add() + " (under " + b("More") + " if hidden).", W.add() + " \u0926\u092c\u093e\u090f\u0901 (\u0928 \u0926\u093f\u0916\u0947 \u0924\u094b " + b("More") + " \u092e\u0947\u0902)\u0964"), shareSheet(3)],
          [T("Tap " + b("Add") + ".", b("Add") + " \u0926\u092c\u093e\u090f\u0901\u0964"), { from: "top", sheet: [["home", addTitle], ["plus", b("Add")]], hit: 1 }]
        ] };
      case "ios-other": return {
        note: T("Not there? Copy " + b(host) + " and open it in Safari.", "\u0928\u0939\u0940\u0902 \u092e\u093f\u0932\u093e? " + b(host) + " \u0915\u0949\u092a\u0940 \u0915\u0930\u0915\u0947 Safari \u092e\u0947\u0902 \u0916\u094b\u0932\u0947\u0902\u0964"),
        steps: [
          [T("Tap the menu " + I.menu + " at the bottom right.", "\u0928\u0940\u091a\u0947 \u0926\u093e\u0939\u093f\u0928\u0947 \u092e\u0947\u0928\u0942 " + I.menu + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { bar: "bottom", items: ["back", "fwd", "plus", "tabs", "menu"], hit: 4 }],
          [T("Tap " + W.share() + ".", W.share() + " \u0926\u092c\u093e\u090f\u0901\u0964"), { from: "bottom", sheet: [["book", "Bookmarks"], ["share", "Share"]], hit: 1 }],
          [T("Tap " + W.add() + ", then " + b("Add") + ".", W.add() + ", \u092b\u093f\u0930 " + b("Add") + " \u0926\u092c\u093e\u090f\u0901\u0964"), shareSheet(3)]
        ] };
      case "android-chrome": return {
        note: T("Installed apps appear in your app drawer and home screen.", "\u0910\u092a \u092b\u093c\u094b\u0928 \u0915\u0940 \u0939\u094b\u092e \u0938\u094d\u0915\u094d\u0930\u0940\u0928 \u0914\u0930 \u0910\u092a \u0938\u0942\u091a\u0940 \u092e\u0947\u0902 \u0906 \u091c\u093e\u090f\u0917\u093e\u0964"),
        steps: [
          [T("Tap the menu " + I.vdots + " at the top right of Chrome.", "Chrome \u092e\u0947\u0902 \u090a\u092a\u0930 \u0926\u093e\u0939\u093f\u0928\u0947 \u092e\u0947\u0928\u0942 " + I.vdots + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { bar: "top", items: ["home", "addr", "tabs", "vdots"], hit: 3 }],
          [T("Tap " + b("Add to home screen") + " or " + b("Install app") + ".", b("Add to home screen") + " \u092f\u093e " + b("Install app") + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { from: "top", sheet: [["tabs", "New tab"], ["down", "Downloads"], ["share", "Share\u2026"], ["plus", "Add to home screen"]], hit: 3 }],
          [T("Tap " + b("Install") + ".", b("Install") + " \u0926\u092c\u093e\u090f\u0901\u0964"), { from: "bottom", sheet: [["home", "Install app?"], ["down", b("Install")]], hit: 1 }]
        ] };
      case "samsung": return {
        note: T("Or tap the install icon " + I.down + " in the address bar if it shows.", "\u092a\u0924\u0947 \u0915\u0940 \u092a\u091f\u094d\u091f\u0940 \u092e\u0947\u0902 " + I.down + " \u0926\u093f\u0916\u0947 \u0924\u094b \u0909\u0938\u0947 \u092d\u0940 \u0926\u092c\u093e \u0938\u0915\u0924\u0947 \u0939\u0948\u0902\u0964"),
        steps: [
          [T("Tap the menu " + I.menu + " at the bottom right.", "\u0928\u0940\u091a\u0947 \u0926\u093e\u0939\u093f\u0928\u0947 \u092e\u0947\u0928\u0942 " + I.menu + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { bar: "bottom", items: ["back", "fwd", "home", "tabs", "menu"], hit: 4 }],
          [T("Tap " + b("Add page to") + " \u2192 " + b("Home screen") + ".", b("Add page to") + " \u2192 " + b("Home screen") + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { from: "bottom", sheet: [["book", "Bookmarks"], ["plus", "Add page to"], ["home", "Home screen"]], hit: 2 }],
          [T("Tap " + b("Add") + ".", b("Add") + " \u0926\u092c\u093e\u090f\u0901\u0964"), { from: "bottom", sheet: [["home", addTitle], ["plus", b("Add")]], hit: 1 }]
        ] };
      case "android-firefox": case "android-edge": return {
        steps: [
          [T("Tap the menu " + I.vdots + ".", "\u092e\u0947\u0928\u0942 " + I.vdots + " \u0926\u092c\u093e\u090f\u0901\u0964"), { bar: "bottom", items: ["home", "addr", "tabs", "vdots"], hit: 3 }],
          [T("Tap " + b("Install") + " / " + b("Add to Home screen") + ".", b("Install") + " / " + b("Add to Home screen") + " \u0926\u092c\u093e\u090f\u0901\u0964"),
            { from: "bottom", sheet: [["share", "Share"], ["plus", "Add to Home screen"]], hit: 1 }],
          [T("Tap " + b("Add") + ".", b("Add") + " \u0926\u092c\u093e\u090f\u0901\u0964"), { from: "bottom", sheet: [["home", addTitle], ["plus", b("Add")]], hit: 1 }]
        ] };
      case "inapp": return {
        note: T("WhatsApp, Instagram and other in-app browsers cannot install apps.", "WhatsApp, Instagram \u091c\u0948\u0938\u0947 \u0910\u092a \u0915\u0947 \u0905\u0902\u0926\u0930 \u0915\u093e \u092c\u094d\u0930\u093e\u0909\u091c\u093c\u0930 \u0910\u092a \u0928\u0939\u0940\u0902 \u0932\u0917\u093e \u0938\u0915\u0924\u093e\u0964"),
        steps: [
          [T("Tap " + I.vdots + " (or " + I.dots + ") at the top.", "\u090a\u092a\u0930 " + I.vdots + " (\u092f\u093e " + I.dots + ") \u0926\u092c\u093e\u090f\u0901\u0964"), { bar: "top", items: ["x", "addr", "vdots"], hit: 2 }],
          [T("Choose " + b("Open in Chrome") + " (iPhone: " + b("Open in Safari") + ").", b("Open in Chrome") + " (iPhone: " + b("Open in Safari") + ") \u091a\u0941\u0928\u0947\u0902\u0964"),
            { from: "top", sheet: [["copy", "Copy link"], ["share", "Open in browser"]], hit: 1 }],
          [T("There, tap " + b("Install app") + " again.", "\u0935\u0939\u093e\u0901 \u092b\u093f\u0930 \u0938\u0947 " + b("Install app") + " \u0926\u092c\u093e\u090f\u0901\u0964"), { bar: "bottom", items: ["addr"], hit: -1, pill: 1 }]
        ] };
      case "desktop-chrome": return { steps: [[T("Click the install icon " + I.down + " at the right end of the address bar.", "\u092a\u0924\u0947 \u0915\u0940 \u092a\u091f\u094d\u091f\u0940 \u0915\u0947 \u0926\u093e\u0939\u093f\u0928\u0947 " + I.down + " \u0926\u092c\u093e\u090f\u0901\u0964"), null],
        [T("Or menu " + I.vdots + " \u2192 " + b("Cast, save and share") + " \u2192 " + b("Install page as app") + ".", "\u092f\u093e \u092e\u0947\u0928\u0942 " + I.vdots + " \u2192 " + b("Cast, save and share") + " \u2192 " + b("Install page as app") + "\u0964"), null],
        [T("Click " + b("Install") + ".", b("Install") + " \u0926\u092c\u093e\u090f\u0901\u0964"), null]] };
      case "desktop-edge": return { steps: [[T("Click the " + b("App available") + " icon " + I.plus + " in the address bar.", "\u092a\u0924\u0947 \u0915\u0940 \u092a\u091f\u094d\u091f\u0940 \u092e\u0947\u0902 " + I.plus + " \u0926\u092c\u093e\u090f\u0901\u0964"), null],
        [T("Or menu \u2026 \u2192 " + b("Apps") + " \u2192 " + b("Install this site as an app") + ".", "\u092f\u093e \u092e\u0947\u0928\u0942 \u2026 \u2192 " + b("Apps") + " \u2192 " + b("Install this site as an app") + "\u0964"), null],
        [T("Click " + b("Install") + ".", b("Install") + " \u0926\u092c\u093e\u090f\u0901\u0964"), null]] };
      case "desktop-safari": return { steps: [[T("Menu " + b("File") + " \u2192 " + b("Add to Dock") + " (macOS Sonoma or newer).", "\u092e\u0947\u0928\u0942 " + b("File") + " \u2192 " + b("Add to Dock") + "\u0964"), null],
        [T("Click " + b("Add") + ".", b("Add") + " \u0926\u092c\u093e\u090f\u0901\u0964"), null]] };
      default: return { steps: [[T("Open this page in " + b("Chrome") + " (Android, computer) or " + b("Safari") + " (iPhone).", "\u092f\u0939 \u092a\u0947\u091c " + b("Chrome") + " (Android) \u092f\u093e " + b("Safari") + " (iPhone) \u092e\u0947\u0902 \u0916\u094b\u0932\u0947\u0902\u0964"), null],
        [T("Then use the browser menu: " + b("Install app") + " / " + b("Add to Home Screen") + ".", "\u092b\u093f\u0930 \u092e\u0947\u0928\u0942 \u092e\u0947\u0902 " + b("Install app") + " / " + b("Add to Home Screen") + "\u0964"), null]] };
    }
  }

  /* The animated mock: a mini phone whose bar or pop-up sheet "taps" the right control. */
  function frameHtml(f) {
    if (!f) return "";
    var h = '<div class="kki-page"><i></i><i></i><i class="kki-s"></i><i></i></div>';
    if (f.bar) {
      h += '<div class="kki-bar kki-' + f.bar + '">' + f.items.map(function (n, i) {
        return n === "addr" ? '<span class="kki-addr' + (i === f.hit ? " kki-hit" : "") + '">' + location.host.replace(/^www\./, "") + "</span>"
          : '<span class="kki-btn' + (i === f.hit ? " kki-hit" : "") + '">' + (I[n] || "") + "</span>";
      }).join("") + "</div>";
      if (f.pill) h += '<div class="kki-mpill kki-hit">' + I.down + " " + T("Install app", "\u0910\u092a \u0907\u0902\u0938\u094d\u091f\u0949\u0932") + "</div>";
    } else if (f.sheet) {
      h += '<div class="kki-pop kki-' + f.from + '">' + f.sheet.map(function (r, i) {
        return '<div class="kki-row' + (i === f.hit ? " kki-hit" : "") + '">' + (I[r[0]] || "") + "<span>" + r[1] + "</span></div>";
      }).join("") + "</div>";
    }
    return h;
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
    /* host pages may reset svg/h2/b (Tailwind preflight makes svg display:block): pin what the guide needs */
    ".kki-pill svg,.kki-sheet svg{display:inline-block;width:18px;height:18px;vertical-align:-3px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    ".kki-sheet svg circle{fill:currentColor;stroke:none}",
    ".kki-wrap{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.45)}",
    ".kki-sheet{box-sizing:border-box;width:100%;max-width:460px;max-height:94vh;overflow:auto;background:var(--kki-bg);color:var(--kki-fg);",
    "border-radius:18px 18px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom));font:15px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}",
    "@media (min-width:600px){.kki-wrap{align-items:center}.kki-sheet{border-radius:18px}}",
    ".kki-sheet h2{margin:0 0 2px;font-size:19px;font-weight:700;line-height:1.3}.kki-sheet b{font-weight:700}",
    ".kki-sheet p.kki-sub{margin:0 0 10px;opacity:.75;font-size:14px}",
    /* demo phone */
    ".kki-demo{position:relative;width:230px;height:150px;margin:0 auto 10px;border-radius:22px;border:6px solid #2b2f36;background:#f2f3f5;overflow:hidden;color:#16181d}",
    ".kki-page{position:absolute;inset:14px 12px}.kki-page i{display:block;height:8px;margin:0 0 9px;border-radius:4px;background:#d9dce1}.kki-page i.kki-s{width:60%}",
    ".kki-bar{position:absolute;left:6px;right:6px;display:flex;align-items:center;gap:4px;padding:5px 6px;border-radius:16px;background:rgba(255,255,255,.96);box-shadow:0 2px 10px rgba(0,0,0,.15);animation:kki-in .35s ease-out}",
    ".kki-bar.kki-bottom{bottom:6px}.kki-bar.kki-top{top:6px}",
    ".kki-btn{position:relative;flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:26px;height:24px;border-radius:12px}",
    ".kki-addr{position:relative;flex:1;min-width:0;height:24px;line-height:24px;padding:0 8px;border-radius:12px;background:#e8eaee;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center}",
    ".kki-demo svg{display:inline-block;flex:0 0 auto;width:16px;height:16px;vertical-align:middle;fill:none;stroke:#16181d;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    ".kki-demo svg circle{fill:#16181d;stroke:none}",
    ".kki-pop{position:absolute;left:10px;right:10px;padding:4px;border-radius:14px;background:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);animation:kki-up .35s ease-out}",
    ".kki-pop.kki-bottom{bottom:8px}.kki-pop.kki-top{top:8px;animation-name:kki-dn}",
    ".kki-row{position:relative;display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:9px;font-size:11px;white-space:nowrap;overflow:hidden}",
    ".kki-mpill{position:absolute;left:50%;bottom:44px;transform:translateX(-50%);padding:4px 10px;border-radius:999px;background:#fff;font-size:11px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.2);white-space:nowrap}",
    ".kki-demo .kki-hit{background:rgba(51,68,165,.16);box-shadow:0 0 0 2px #3344a5;animation:kki-pulse 1.1s ease-in-out .35s infinite}",
    /* the finger */
    ".kki-demo .kki-hit:after{content:'';position:absolute;right:-2px;bottom:-6px;width:16px;height:16px;border-radius:50%;background:rgba(255,120,40,.85);",
    "border:2px solid #fff;animation:kki-tap 1.1s ease-in-out .35s infinite;pointer-events:none}",
    "@keyframes kki-pulse{0%,100%{box-shadow:0 0 0 2px #3344a5}50%{box-shadow:0 0 0 5px rgba(51,68,165,.35)}}",
    "@keyframes kki-tap{0%,100%{transform:translate(8px,8px) scale(1);opacity:.4}50%{transform:translate(0,0) scale(.8);opacity:1}}",
    "@keyframes kki-in{from{opacity:0}to{opacity:1}}@keyframes kki-up{from{transform:translateY(30px);opacity:0}to{transform:none;opacity:1}}",
    "@keyframes kki-dn{from{transform:translateY(-30px);opacity:0}to{transform:none;opacity:1}}",
    "@media (prefers-reduced-motion:reduce){.kki-demo *{animation:none!important}}",
    /* steps */
    ".kki-sheet ol{margin:0 0 10px;padding:0;list-style:none;counter-reset:k}",
    ".kki-sheet li{counter-increment:k;position:relative;padding:8px 6px 8px 40px;border-top:1px solid var(--kki-line);border-radius:8px;cursor:pointer;transition:background .3s}",
    ".kki-sheet li.kki-now{background:var(--kki-now)}",
    ".kki-sheet li:before{content:counter(k);position:absolute;left:4px;top:7px;width:26px;height:26px;border-radius:50%;",
    "background:var(--kki-acc);color:#fff;font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center}",
    ".kki-sheet .kki-note{margin:0 0 12px;padding:8px 10px;border-radius:10px;background:var(--kki-now);font-size:13px;line-height:1.45}",
    ".kki-sheet .kki-ok{all:unset;box-sizing:border-box;display:block;width:100%;text-align:center;cursor:pointer;padding:12px;",
    "border-radius:12px;background:var(--kki-acc);color:#fff;font-weight:700}",
    ".kki-sheet .kki-more{all:unset;display:block;margin:10px auto 0;font-size:13px;text-decoration:underline;opacity:.75;cursor:pointer}",
    ".kki-pill,.kki-sheet{--kki-bg:#fff;--kki-fg:#16181d;--kki-line:rgba(0,0,0,.12);--kki-acc:#3344a5;--kki-now:rgba(51,68,165,.09)}",
    "@media (prefers-color-scheme:dark){.kki-pill,.kki-sheet{--kki-bg:#1d2127;--kki-fg:#eef0f3;--kki-line:rgba(255,255,255,.14);--kki-acc:#6f80ff;--kki-now:rgba(111,128,255,.16)}}"
  ].join("");

  function addCss() {
    if (document.getElementById("kki-css")) return;
    var s = document.createElement("style"); s.id = "kki-css"; s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function hidePill() { if (pill) { pill.remove(); pill = null; } }

  function showPill() {
    if (pill || cfg.pill === "0" || standalone() || installedNow || snoozed()) return;
    var br = browser();
    // A desktop shows the pill only when the browser itself says the page can be installed.
    if (!deferred && !br.mobile && cfg.desktop !== "1") return;
    addCss();
    pill = document.createElement("div");
    pill.className = "kki-pill"; pill.setAttribute("role", "region"); pill.setAttribute("aria-label", "Install app");
    pill.style.bottom = "calc(env(safe-area-inset-bottom) + " + (parseInt(cfg.bottom, 10) || 18) + "px)";
    pill.innerHTML = '<button type="button" class="kki-go">' + I.down + "<span>" + T("Install app", "\u0910\u092a \u0907\u0902\u0938\u094d\u091f\u0949\u0932 \u0915\u0930\u0947\u0902") + "</span></button>" +
      '<button type="button" class="kki-x" aria-label="Not now">\u2715</button>';
    pill.querySelector(".kki-go").addEventListener("click", open);
    pill.querySelector(".kki-x").addEventListener("click", function () { snooze(); hidePill(); });
    document.body.appendChild(pill);
  }

  function closeSheet() { clearInterval(timer); timer = null; if (sheet) { sheet.remove(); sheet = null; } }

  function guide() {
    closeSheet(); addCss();
    var br = browser(), fl = flow(br.layout), st = fl.steps, animated = !!st[0][1];
    var useLib = cfg.lib !== "0" && br.mobile;
    sheet = document.createElement("div");
    sheet.className = "kki-wrap";
    sheet.setAttribute("data-layout", br.layout);
    sheet.innerHTML = '<div class="kki-sheet" role="dialog" aria-modal="true" aria-labelledby="kki-h">' +
      '<h2 id="kki-h">' + T("Install ", "") + appName().replace(/</g, "&lt;") + T("", " \u0910\u092a \u0932\u0917\u093e\u090f\u0901") + "</h2>" +
      '<p class="kki-sub">' + T("It then opens like an app, full screen, from your home screen.", "\u092b\u093f\u0930 \u092f\u0939 \u0939\u094b\u092e \u0938\u094d\u0915\u094d\u0930\u0940\u0928 \u0938\u0947 \u0910\u092a \u0915\u0940 \u0924\u0930\u0939 \u092a\u0942\u0930\u0940 \u0938\u094d\u0915\u094d\u0930\u0940\u0928 \u092a\u0930 \u0916\u0941\u0932\u0947\u0917\u093e\u0964") + "</p>" +
      (animated ? '<div class="kki-demo" aria-hidden="true"></div>' : "") +
      "<ol>" + st.map(function (s) { return "<li>" + s[0] + "</li>"; }).join("") + "</ol>" +
      (fl.note ? '<p class="kki-note">' + fl.note + "</p>" : "") +
      '<button type="button" class="kki-ok">' + T("Got it", "\u0920\u0940\u0915 \u0939\u0948") + "</button>" +
      (useLib ? '<button type="button" class="kki-more">' + T("Still stuck? Show another guide", "\u092b\u093f\u0930 \u092d\u0940 \u0928\u0939\u0940\u0902 \u0939\u0941\u0906? \u0926\u0942\u0938\u0930\u093e \u0924\u0930\u0940\u0915\u093e \u0926\u0947\u0916\u0947\u0902") + "</button>" : "") + "</div>";
    var demo = sheet.querySelector(".kki-demo"), lis = sheet.querySelectorAll("li"), cur = -1;
    function go(i) {
      cur = i % st.length;
      for (var k = 0; k < lis.length; k++) lis[k].className = k === cur ? "kki-now" : "";
      if (demo) demo.innerHTML = frameHtml(st[cur][1]);
    }
    if (animated) {
      go(0);
      timer = setInterval(function () { go(cur + 1); }, 2600);
      Array.prototype.forEach.call(lis, function (li, i) {
        li.addEventListener("click", function () { clearInterval(timer); go(i); timer = setInterval(function () { go(cur + 1); }, 2600); });
      });
    }
    sheet.addEventListener("click", function (e) { if (e.target === sheet) closeSheet(); });
    sheet.querySelector(".kki-ok").addEventListener("click", closeSheet);
    var more = sheet.querySelector(".kki-more");
    if (more) more.addEventListener("click", function () { closeSheet(); libGuide(); });
    document.addEventListener("keydown", function esc(e) { if (e.key === "Escape") { closeSheet(); document.removeEventListener("keydown", esc); } });
    document.body.appendChild(sheet);
    sheet.querySelector(".kki-ok").focus();
  }

  /* The maintained library's own guide (loaded only on demand; never blocks the page). */
  function libGuide() {
    function show() {
      var el = document.querySelector("pwa-install.kki-lib");
      if (!el) {
        el = document.createElement("pwa-install"); el.className = "kki-lib";
        var m = document.querySelector('link[rel~="manifest"]'), ic = document.querySelector('link[rel~="apple-touch-icon"]');
        el.setAttribute("manual-apple", ""); el.setAttribute("manual-chrome", ""); el.setAttribute("disable-screenshots", "");
        if (m) el.setAttribute("manifest-url", m.getAttribute("href"));
        el.setAttribute("name", appName());
        if (ic) el.setAttribute("icon", ic.getAttribute("href"));
        document.body.appendChild(el);
      }
      setTimeout(function () { try { el.showDialog(true); } catch (e) { guide(); } }, 300);
    }
    if (window.customElements && customElements.get("pwa-install")) return show();
    var s = document.createElement("script");
    s.src = LIB; s.integrity = LIB_SRI; s.crossOrigin = "anonymous";
    s.onload = show; s.onerror = guide;
    document.head.appendChild(s);
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
    state: function () { var br = browser(); return { installed: standalone() || installedNow, promptReady: !!deferred, browser: br.kind, layout: br.layout, lang: lang }; }
  };
})();
