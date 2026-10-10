'use strict';
// sentfiles.js: play and preview the files a session SENT to the user (SendUserFile).
//
// Such a file usually sits in the session's scratchpad, OUTSIDE every cwd, so /api/file (confined to
// cwds) rightly refuses it. This serves exactly the files a session sent: the allowlist is the
// session's own transcript, and a path is served only if a SendUserFile tool_use in that transcript
// named it. Nothing else on disk is reachable through here, whatever the path parameter says.
//
// Streaming: audio/video elements fetch with Range, and a phone will not seek (or, for some WAVs,
// even start) without a 206. So this answers Range requests from a read stream, never readFile.
const fs = require('fs');
const path = require('path');

const TYPES = {
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'video/webm', '.mp4': 'video/mp4',
  '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.markdown': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.csv': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';

// Windows paths arrive as C:/x/y or C:\x\y and in any case; compare one canonical form.
const norm = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };

// transcript file -> { size, files:Set } -- rescans only the bytes appended since the last look.
const cache = new Map();

async function sentFiles(transcript) {
  const st = await fs.promises.stat(transcript);
  let c = cache.get(transcript);
  if (!c || st.size < c.size) c = { size: 0, files: new Set() };
  if (st.size > c.size) {
    const fh = await fs.promises.open(transcript, 'r');
    try {
      const buf = Buffer.alloc(st.size - c.size);
      await fh.read(buf, 0, buf.length, c.size);
      const text = buf.toString('utf8');
      // Only whole lines count; a half-written last line is picked up next time.
      const end = text.lastIndexOf('\n');
      if (end >= 0) {
        for (const line of text.slice(0, end).split('\n')) {
          if (line.indexOf('SendUserFile') < 0) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          const content = j && j.message && Array.isArray(j.message.content) ? j.message.content : [];
          for (const b of content) {
            if (!b || b.type !== 'tool_use' || !/SendUserFile$/.test(b.name || '')) continue;
            const files = b.input && Array.isArray(b.input.files) ? b.input.files : [];
            for (const f of files) if (typeof f === 'string' && f) c.files.add(norm(path.isAbsolute(f) ? f : path.join(j.cwd || '', f)));
          }
        }
        c.size += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
      }
    } finally { await fh.close(); }
  }
  cache.set(transcript, c);
  return c.files;
}

// Answer GET for one file, honouring a single Range. Returns nothing; writes the response.
function stream(req, res, file, size, mtimeMs) {
  const type = typeOf(file);
  // g1695: a file can be rewritten under the same name; the browser must ask each time and get the new bytes.
  const etag = mtimeMs ? '"' + size.toString(36) + '-' + Math.floor(mtimeMs).toString(36) + '"' : null;
  if (etag && req.headers['if-none-match'] === etag && !req.headers.range) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache' }); return res.end(); }
  const headers = {
    'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-cache',
    ...(etag ? { ETag: etag } : {}),
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline; filename="' + path.basename(file).replace(/[^\w.\- ]/g, '_') + '"',
  };
  // A sent HTML page runs sandboxed: its scripts get an opaque origin, so they cannot read the
  // auth cookie or call the API as the user. SVG gets no scripts at all.
  if (/^text\/html/.test(type)) headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-popups allow-forms';
  else if (type === 'image/svg+xml') headers['Content-Security-Policy'] = "sandbox; script-src 'none'";
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  let start = 0, end = size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    else { start = Math.max(0, size - Number(m[2])); }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
      return res.end();
    }
    code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(code, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const rs = fs.createReadStream(file, { start, end });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

module.exports = { sentFiles, stream, typeOf, norm };
