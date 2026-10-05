// Renders public/favicon-32.png and public/apple-touch-icon.png from
// public/favicon.svg with the repo's own Playwright Chromium, so the PNG
// fallbacks always come from the one SVG. Run from the repo root:
//   node dashboard/scripts/render-favicons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, '..', 'public');
const svg = fs.readFileSync(path.join(pub, 'favicon.svg'), 'utf8');

const browser = await chromium.launch();
const render = async (size, file, { background = 'transparent', inset = 0 } = {}) => {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const mark = size - inset * 2;
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;background:${background};display:grid;place-items:center">${svg.replace(/width="32" height="32"/, `width="${mark}" height="${mark}"`)}</body></html>`);
  await page.screenshot({ path: path.join(pub, file), omitBackground: background === 'transparent', clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  console.log(`wrote public/${file} (${size}x${size})`);
};
await render(32, 'favicon-32.png');
// Apple squares and rounds the icon itself; give it the dark surface behind the mark.
await render(180, 'apple-touch-icon.png', { background: '#0a0c10', inset: 28 });
await browser.close();
