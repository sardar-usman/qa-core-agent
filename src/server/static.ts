import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';

/**
 * Static serving for the gateway: the built dashboard (dashboard/dist) at /,
 * the legacy single-file UI at /legacy. A single-page app gets index.html
 * for any path that is not a file, so client-side routes deep-link. Paths
 * are resolved inside their directory only.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

export interface StaticContext {
  /** dashboard/dist */
  distDir: string;
  /** qa-core-ui.html */
  legacyFile: string;
}

export function createStaticHandler(ctx: StaticContext): (req: http.IncomingMessage, res: http.ServerResponse) => boolean {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if ((req.method ?? 'GET') !== 'GET' && req.method !== 'HEAD') return false;
    if (url.pathname === '/legacy' || url.pathname === '/legacy/') {
      return sendFile(res, ctx.legacyFile);
    }
    if (!fs.existsSync(path.join(ctx.distDir, 'index.html'))) {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const body = `<!doctype html><meta charset="utf-8"><title>QA-Core</title><body style="font-family:system-ui;padding:40px;max-width:640px"><h1>Dashboard not built</h1><p>Run <code>npm run dashboard:build</code> (or <code>npm run dashboard:dev</code> while developing), then reload. The legacy UI is at <a href="/legacy">/legacy</a>.</p></body>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(body);
        return true;
      }
      return false;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const candidate = path.resolve(ctx.distDir, rel || 'index.html');
    if (!candidate.startsWith(path.resolve(ctx.distDir) + path.sep) && candidate !== path.resolve(ctx.distDir, 'index.html')) return false;
    if (rel && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return sendFile(res, candidate, rel.startsWith('assets/'));
    // SPA fallback.
    return sendFile(res, path.join(ctx.distDir, 'index.html'));
  };
}

function sendFile(res: http.ServerResponse, file: string, immutable = false): boolean {
  if (!fs.existsSync(file)) return false;
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(body);
  return true;
}
