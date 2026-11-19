import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewApi } from './api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
if (!existsSync(resolve(root, 'index.html'))) {
  console.error('请先运行 npm run build。');
  process.exit(1);
}

const api = createPreviewApi(process.env);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (/^\/(api|_AMapService)(?:\/|$)/.test(url.pathname)) return void api(req, res);
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405).end();
    return;
  }
  const candidate = resolve(root, '.' + url.pathname);
  const withinDist = candidate.startsWith(root + sep);
  const file = url.pathname === '/' ? resolve(root, 'index.html') : candidate;
  if ((url.pathname !== '/' && !withinDist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Cache-Control': url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT || 4173);
server.listen(port, '127.0.0.1', () => console.log(`校园追光预览 http://127.0.0.1:${port}`));
