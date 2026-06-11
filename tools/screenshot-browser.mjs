// Headless-browser screenshot of index.html (the preferred e2e path).
//
//   node tools/screenshot-browser.mjs
//
// Serves the repo root over HTTP, loads index.html in headless Chromium, drives
// the real UI, and screenshots the live canvas. Writes docs/preview-live.png.
// If Chromium is unavailable/flaky this exits non-zero and the deterministic
// tools/screenshot.mjs output is used instead.

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, sep, relative, isAbsolute } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = join(root, p);
  // Reject anything that resolves outside root (path.relative is empty/"."
  // inside root, and starts with ".." or is absolute when it escapes).
  const rel = relative(root, fp);
  const inside = fp === root || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
  if (!inside || !existsSync(fp)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(fp)] || 'application/octet-stream' });
  res.end(readFileSync(fp));
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/index.html`;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright not installed');
  server.close();
  process.exit(2);
}

let browser;
try {
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle' });
  // Wait until the canvas has been sized by render().
  await page.waitForFunction(() => {
    const c = document.getElementById('canvas');
    return c && c.width > 0 && c.height > 0;
  }, { timeout: 15000 });
  const box = page.locator('#boxFrame');
  await box.screenshot({ path: join(root, 'docs', 'preview-live.png') });
  console.log('wrote docs/preview-live.png');
} catch (err) {
  console.error('browser screenshot failed:', err.message);
  if (browser) await browser.close();
  server.close();
  process.exit(1);
} finally {
  if (browser) await browser.close();
  server.close();
}
