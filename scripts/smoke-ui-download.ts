/**
 * Dashboard download integration (ported from the retired single-file UI's
 * download card): the Summary panel's one download button on Run Detail
 * downloads the framework zip from the run folder, byte for byte, through
 * /api/runs/:id/artifacts, and the file is a real zip whose entries sit under
 * <brand>-automation-framework/.
 *
 * Real scaffold + real zipper build the fixture run; the real API and static
 * handlers serve it; Playwright drives the click and captures the download.
 * No gateway process, no model, no network.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { scaffold, frameworkDirName } from '../src/agent/scaffold.js';
import { zipFrameworkToBuffer } from '../src/agent/zip-framework.js';
import { newRunId } from '../src/agent/output-layout.js';
import { openDatabase } from '../src/server/db/migrate.js';
import { indexOutput } from '../src/server/db/indexer.js';
import { createApiHandler } from '../src/server/api.js';
import { createStaticHandler } from '../src/server/static.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }

/* ─── fixture run: a real scaffold, zipped with the framework root, in a run folder ─── */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-download-'));
const url = 'https://www.saucedemo.com/';
const report: RunReport = {
  url, language: 'ts', startedAt: '2026-09-01T09:00:00.000Z', finishedAt: '2026-09-01T09:01:00.000Z', steps: 4,
  scenarios: [{ name: 'login succeeds', feature: 'login', category: 'happy', steps: [
    { kind: 'navigate', url },
    { kind: 'fill', target: { level: 'role', arg: { role: 'textbox', name: 'Username', exact: true }, intent: 'username input' }, value: 'standard_user' },
    { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login', exact: true }, intent: 'login button' } },
    { kind: 'assert', name: 'inventory URL', assertion: { type: 'toHaveURL', pattern: '/inventory' } },
  ] }] as RunReport['scenarios'],
  cascadeStats: { role: 2, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 }, cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0.5 },
  plan: [{ name: 'login succeeds', category: 'happy', rationale: 'r', feature: 'login' }],
  reconciliation: { planned: 1, generated: 1, dropped: [], incomplete: [], findings: [], skipped: [], accountedFor: 1, added: 0, balanced: true, stable: 1, recovered: 0, flaky: 0, broken: 0 },
} as RunReport;
const runId = newRunId(new Date('2026-09-01T09:00:00Z'), 'dl');
const runDir = path.join(root, 'output', 'saucedemo-com', runId);
const build = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-download-build-'));
const frameworkDir = path.join(build, frameworkDirName(url));
scaffold({ report, outDir: frameworkDir, siteName: 'www.saucedemo.com', features: ['login'] });
const zipBuf = zipFrameworkToBuffer(frameworkDir, frameworkDirName(url));
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'run-report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(runDir, `${frameworkDirName(url)}.zip`), zipBuf);
fs.rmSync(build, { recursive: true, force: true });
const fixtureEntries = spawnSync('unzip', ['-Z1', path.join(runDir, `${frameworkDirName(url)}.zip`)], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
check('A. the fixture zip is a real archive rooted at the framework name', zipBuf.length > 1000 && fixtureEntries.length > 5 && fixtureEntries.every((e) => e.startsWith(`${frameworkDirName(url)}/`)), JSON.stringify(fixtureEntries.slice(0, 5)));

/* ─── serve it ─── */
const db = openDatabase(path.join(root, 'data', 'qa-core.sqlite'));
indexOutput(db, root);
const TOKEN = 'download-token';
const apiHandler = createApiHandler({ db, root, token: TOKEN });
const statik = createStaticHandler({ distDir: dist });
const server = http.createServer(async (req, res) => { if (await apiHandler(req, res)) return; if (statik(req, res)) return; res.writeHead(404); res.end(); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

/* ─── click the one download button, capture the file ─── */
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}/runs/${runId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="download-zip"]');
const buttons = await page.$$('[data-testid="download-zip"]');
check('B. Run Detail offers exactly one download button, in the Summary panel', buttons.length === 1 && !!(await page.$('[data-stage="summary"] [data-testid="download-zip"]')));
const href = await page.getAttribute('[data-testid="download-zip"]', 'href');
check('C. the button links to the run\'s artifact route with the token carried on the href', !!href && href.includes(`/api/runs/${runId}/artifacts/${frameworkDirName(url)}.zip`) && href.includes(`token=${TOKEN}`), href ?? '');
const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="download-zip"]')]);
const saved = path.join(root, 'downloaded.zip');
await download.saveAs(saved);
const downloaded = fs.readFileSync(saved);
check('D. the browser download names the framework zip', download.suggestedFilename() === `${frameworkDirName(url)}.zip`, download.suggestedFilename());
check('E. the downloaded bytes equal the zip in the run folder', downloaded.equals(zipBuf), `${downloaded.length} vs ${zipBuf.length} bytes`);
const listing = spawnSync('unzip', ['-l', saved], { encoding: 'utf8' });
check('F. the downloaded file is a real zip with the framework under its root', listing.status === 0 && new RegExp(`${frameworkDirName(url)}/package\\.json`).test(listing.stdout) && new RegExp(`${frameworkDirName(url)}/tests/`).test(listing.stdout), listing.stdout.slice(0, 300));
check('G. zero console errors', errors.filter((e) => !/404|WebSocket|Failed to load resource/.test(e)).length === 0, errors.join(' | '));

await browser.close();
await new Promise<void>((r) => server.close(() => r()));
db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the dashboard\'s one download button delivers the framework zip from the run folder byte for byte.');
