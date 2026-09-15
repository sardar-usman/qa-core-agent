/**
 * Locks the brand-vs-host display rule on the dashboard (ported from the
 * retired single-file UI): a project auto-created for a host is named by its
 * brand slug (www.saucedemo.com -> saucedemo), the run page shows the full
 * host and the site URL, and the download filename is
 * <brand>-automation-framework.zip. The full host stays in the index row as
 * the identifier. Real API and static handlers over a fixture tree; no model,
 * no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { brandSlug, frameworkDirName } from '../src/agent/scaffold.js';
import { newRunId, projectSlug } from '../src/agent/output-layout.js';
import { openDatabase } from '../src/server/db/migrate.js';
import { indexOutput } from '../src/server/db/indexer.js';
import { createApiHandler, listProjects } from '../src/server/api.js';
import { createStaticHandler } from '../src/server/static.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* ─── the helper itself, on representative host shapes ─── */
const cases: Array<[string, string]> = [
  ['https://www.saucedemo.com/', 'saucedemo'],
  ['https://the-internet.herokuapp.com/login', 'the-internet-herokuapp'],
  ['https://demo.playwright.dev/todomvc/', 'demo-playwright'],
  ['https://shop.example/', 'shop'],
];
for (const [url, expected] of cases) check(`A. brandSlug(${new URL(url).host}) is ${expected} (www dropped, TLD dropped)`, brandSlug(url) === expected, brandSlug(url));
check('B. the brand is not the project id: the id keeps the host with dots as hyphens', projectSlug('https://www.saucedemo.com/') === 'saucedemo-com' && brandSlug('https://www.saucedemo.com/') === 'saucedemo');

/* ─── fixture: three hosts, one run each ─── */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-brand-'));
const mk = (url: string, startedAt: string) => ({
  url, language: 'ts', startedAt, finishedAt: new Date(Date.parse(startedAt) + 60_000).toISOString(), steps: 1,
  scenarios: [{ name: 's1', feature: 'login', category: 'happy', steps: [{ kind: 'navigate', url }] }], cascadeStats: {}, cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0.1 },
  plan: [{ name: 's1', category: 'happy', rationale: 'r', feature: 'login' }],
  reconciliation: { planned: 1, generated: 1, dropped: [], incomplete: [], findings: [], skipped: [], accountedFor: 1, added: 0, balanced: true, stable: 1, recovered: 0, flaky: 0, broken: 0 },
});
const runs = cases.slice(0, 3).map(([url], i) => {
  const id = newRunId(new Date(`2026-09-0${i + 1}T10:00:00Z`), `b${i}`);
  const dir = path.join(root, 'output', projectSlug(url), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(mk(url, `2026-09-0${i + 1}T10:00:00.000Z`)));
  fs.writeFileSync(path.join(dir, `${frameworkDirName(url)}.zip`), 'PK');
  return { url, id, host: new URL(url).host };
});
const db = openDatabase(path.join(root, 'data', 'qa-core.sqlite'));
indexOutput(db, root);
const projects = listProjects(db, root);
check('C. every auto-created project is named by its brand slug, never the full host', runs.every((r) => projects.find((p) => p.id === projectSlug(r.url))?.name === brandSlug(r.url)), JSON.stringify(projects.map((p) => [p.id, p.name])));

/* ─── the pages ─── */
const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }
const TOKEN = 'brand-token';
const apiHandler = createApiHandler({ db, root, token: TOKEN });
const statik = createStaticHandler({ distDir: dist });
const server = http.createServer(async (req, res) => { if (await apiHandler(req, res)) return; if (statik(req, res)) return; res.writeHead(404); res.end(); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(`${base}/#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="project-card"]');
const cards = await page.$$eval('[data-testid="project-card"]', (els) => els.map((el) => ({ id: (el as HTMLElement).dataset.projectId, title: el.querySelector('h3')?.textContent ?? '', url: el.querySelector('p')?.textContent ?? '' })));
check('D. Projects: card titles are brand slugs and the card keeps the base URL beneath for identity', runs.every((r) => { const c = cards.find((x) => x.id === projectSlug(r.url)); return c?.title === brandSlug(r.url) && c.url.includes(r.host); }), JSON.stringify(cards));
const sauce = runs[0]!;
await page.goto(`${base}/runs/${sauce.id}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="run-detail"]');
const detail = await page.evaluate(() => ({ host: document.querySelector('[data-testid="detail-host"]')?.textContent, site: document.querySelector('[data-testid="detail-site-link"]')?.getAttribute('href'), target: document.querySelector('[data-testid="detail-site-link"]')?.getAttribute('target'), back: document.querySelector('[data-testid="back-link"]')?.textContent ?? '', zip: Array.from(document.querySelectorAll('[data-testid="artifact-link"][data-kind="zip"]')).map((a) => a.textContent ?? '') }));
check('E. Run Detail: the header shows the host (www dropped, TLD kept, distinct from the brand), the full site URL opens in a new tab, the back link names the brand', detail.host === 'saucedemo.com' && detail.site === sauce.url && detail.target === '_blank' && /Back to saucedemo/.test(detail.back), JSON.stringify(detail));
check('F. the zip artifact is named <brand>-automation-framework.zip', detail.zip.length === 1 && /saucedemo-automation-framework\.zip/.test(detail.zip[0]!) && !/www\.saucedemo/.test(detail.zip[0]!), JSON.stringify(detail.zip));

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the dashboard shows the brand slug where a name is wanted and keeps the full host as the identifier.');
