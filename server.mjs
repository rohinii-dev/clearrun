import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { readFileSync } from 'node:fs';

// Load .env for local runs (Vercel injects env vars itself). Existing values win.
try {
  for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.warn('No .env file found. Copy .env.example to .env and add your Supabase keys, or sign in will fail.');
}

const { errorResponse, handleApi } = await import('./lib/api.mjs');

const root = resolve(process.cwd());
const port = Number(process.env.PORT || 5500);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

createServer(async (req, res) => {
  if ((req.url || '').startsWith('/api/')) {
    try { await handleApi(req, res); }
    catch (error) { errorResponse(res, error); }
    return;
  }
  const pathname = decodeURIComponent(new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname);
  const requested = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (requested !== root && !requested.startsWith(root + sep)) { res.writeHead(403).end('Forbidden'); return; }
  if (!existsSync(requested) || !statSync(requested).isFile()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': types[extname(requested)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  createReadStream(requested).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`ClearRun is available at http://localhost:${port}`));
