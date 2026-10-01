'use strict';
// cookies.js — read one cookie from a request. Shared by the app's own sign-in cookie (baton_m) and the
// Cloudflare Access cookie (CF_Authorization), which each carried a copy of this loop.
//
// A value that is not valid percent-encoding ("%E0%A4%A") made decodeURIComponent throw, and because
// the cookie is read before the Authorization header, one stale cookie turned every request, even one
// with a valid Bearer key, into a 500. Such a value now counts as no cookie at all.
function cookieValue(req, name) {
  const raw = (req && req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      try { return decodeURIComponent(v.join('=')); } catch { return null; }
    }
  }
  return null;
}

module.exports = { cookieValue };
