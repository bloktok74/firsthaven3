import http from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnamHandler, createAnamEngineHandler } from '../server/anam-api.ts';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json' };

// Video seeking requires byte ranges. Reject malformed or multi-range requests.
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start || (!match[1] && Number(match[2]) === 0)) return null;
  return { start, end: Math.min(end, size - 1) };
}

export function createPreviewServer() {
  return http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (['/api/anam-session','/api/anam/v1/engine/session','/api/anam-engine'].includes(pathname)) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024) { res.writeHead(413).end(); return; }
          chunks.push(chunk);
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        const body = Buffer.concat(chunks).toString('utf8');
        const request = new Request(`http://${req.headers.host}${pathname}`, { method: req.method, headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body } : {}) });
        const env={ ...process.env, INTAKE_LOCAL_TEST: 'true' };
        const handler=pathname==='/api/anam-session'?createAnamHandler(env):createAnamEngineHandler(env);
        const response = await handler(request);
        res.writeHead(response.status, Object.fromEntries(response.headers)).end(await response.text());
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
      const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
      const file = await stat(target);
      if (!file.isFile()) { res.writeHead(404).end('Not found'); return; }
      const headers = { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Content-Length': file.size };
      let range;
      if (req.headers.range && req.method === 'GET') {
        range = parseRange(req.headers.range, file.size);
        if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${file.size}` }).end(); return; }
        headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
        headers['Content-Length'] = range.end - range.start + 1;
      }
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(target, range || undefined);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch { if (!res.headersSent) res.writeHead(404).end('Not found'); else res.destroy(); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  createPreviewServer().listen(port, '127.0.0.1', () => console.log(`First Haven preview: http://127.0.0.1:${port}`));
}
