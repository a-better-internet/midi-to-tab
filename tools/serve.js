#!/usr/bin/env node
/**
 * Minimal static file server for local development.
 *
 * The app is plain ES modules with no build step, but browsers refuse to load
 * modules over file://, so it needs to be served over http. Nothing here is
 * part of the app itself.
 *
 *   npm run serve        then open http://localhost:8080
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.argv[3] ?? '.');
const port = Number(process.env.PORT ?? process.argv[2] ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    // Keep the server inside the root directory.
    const target = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }).end(body);
  } catch (error) {
    const code = error.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end(code === 404 ? 'Not found' : `Server error: ${error.message}`);
  }
});

server.listen(port, () => {
  process.stdout.write(`midi-to-tab dev server: http://localhost:${port}\n`);
});
