/**
 * Locks the dashboard scaffold (PR A): the gateway serves the built app at /,
 * the legacy UI at /legacy, the WebSocket at /ws, and the Projects and Runs
 * pages render exactly the numbers the API returns (which the index copied
 * from the run-reports). Boots a real gateway on a spare port against a
 * fixture output tree, with the token set, and drives it with Playwright.
 *
 * Set QA_CORE_SMOKE_SHOTS=<dir> to also write projects-dark.png and
 * projects-light.png (the docs/ui screenshots).
 *
 * Needs dashboard/dist (npm run dashboard:build). No model, no network
 * beyond localhost.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { newRunId, setLatest } from '../src/agent/output-layout.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.');
  process.exit(1);
}

/* ─── fixture root ─── */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-dash-'));
const output = path.join(root, 'output');
const mk = (url: string, startedAt: string, shipped: number, planned: number, extra: Record<string, unknown> = {}) => ({
  url, language: 'ts', startedAt, finishedAt: new Date(Date.parse(startedAt) + 254_000).toISOString(), steps: 20,
  scenarios: Array.from({ length: shipped }, (_, i) => ({ name: `scenario ${i + 1}`, feature: 'login', category: 'happy', steps: [] })),
  cascadeStats: {}, cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1.4, plannerUsd: 0.0021, criticUsd: 0.0093, repairUsd: 0.31 },
  plan: Array.from({ length: planned }, (_, i) => ({ name: `planned ${i}`, category: 'happy', rationale: 'r' })),
  stability: { iterations: 3, passed: shipped, flaked: 0, flakeRate: 0, durationMs: 1, verdicts: [] },
  reconciliation: { planned, generated: shipped, dropped: [], incomplete: [], findings: [], skipped: [], accountedFor: shipped, added: 0, balanced: true, stable: shipped, recovered: 0, flaky: 0, broken: 0 },
  ...extra,
});
const now = new Date();
const thisMonth = (d: number, h: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), Math.min(d, now.getUTCDate() || 1), h)).toISOString();
const finding = { scenario: 'footer social links open', expected: 'a new tab with twitter.com', url: 'https://www.saucedemo.com/inventory.html', messages: [] as string[] };
const s1 = newRunId(new Date(thisMonth(1, 9)), 's1'); const s2 = newRunId(new Date(thisMonth(1, 14)), 's2'); const s3 = newRunId(new Date(thisMonth(1, 18)), 's3');
const h1 = newRunId(new Date(thisMonth(1, 11)), 'h1'); const e1 = newRunId(new Date(thisMonth(1, 12)), 'e1');
const runs: Array<[string, string, Record<string, unknown>, Record<string, string>]> = [
  ['saucedemo-com', s1, mk('https://www.saucedemo.com/', thisMonth(1, 9), 3, 5, { findings: [finding], reconciliation: { planned: 5, generated: 3, dropped: [{ name: 'x', stage: 'critic', reason: 'r' }], incomplete: [], findings: [{ name: finding.scenario, expected: finding.expected, url: finding.url, messages: [] }], skipped: [], accountedFor: 5, added: 0, balanced: true, stable: 3, recovered: 0, flaky: 0, broken: 0 } }), { 'saucedemo-automation-framework.zip': 'PK' }],
  ['saucedemo-com', s2, mk('https://www.saucedemo.com/', thisMonth(1, 14), 4, 6, { ruleCoverage: { covered: [{ ruleId: 'R1', scenarios: ['scenario 1'] }, { ruleId: 'R2', scenarios: ['scenario 2'] }], uncovered: [{ ruleId: 'R3', text: 'Lockout after 5 tries', reason: 'planned-but-dropped' }] } }), { 'requirements-map.json': '{"features":[],"roles":[]}', 'run-meta.json': JSON.stringify({ source: 'dashboard', flags: {}, writtenAt: 'x' }) }],
  ['saucedemo-com', s3, mk('https://www.saucedemo.com/', thisMonth(1, 18), 2, 8, { stopped: { kind: 'cost_ceiling', reason: 'cost ceiling hit' }, stability: { iterations: 3, passed: 2, flaked: 1, flakeRate: 0.3333, durationMs: 1, verdicts: [] }, ruleCoverage: { covered: [{ ruleId: 'R1', scenarios: ['scenario 1'] }, { ruleId: 'R2', scenarios: ['scenario 2'] }, { ruleId: 'R3', scenarios: ['scenario 3'] }], uncovered: [] } }), { 'checkpoint.json': '{"version":1}' }],
  ['the-internet-herokuapp-com', h1, mk('https://the-internet.herokuapp.com/login', thisMonth(1, 11), 4, 4), { 'the-internet-herokuapp-automation-framework.zip': 'PK', 'run-meta.json': JSON.stringify({ source: 'mcp', flags: {}, writtenAt: 'x' }) }],
  ['empty-example', e1, mk('https://empty.example/', thisMonth(1, 12), 0, 2), {}],
];
for (const [slug, id, rep, files] of runs) {
  const dir = path.join(output, slug, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(rep));
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), v);
}
setLatest(path.join(output, 'saucedemo-com'), s2);
// A pre-v2 gateway record with no report: shows as "summary only (pre-v2)".
fs.mkdirSync(path.join(root, '.qa-core', 'sites'), { recursive: true });
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'demoqa.com.json'), JSON.stringify({ host: 'demoqa.com', recentRuns: [{ at: thisMonth(1, 8), url: 'https://demoqa.com/frames', scenarios: 1, cost: 0.627841, model: 'claude-opus-4-7', durationSec: 255 }] }));

/* ─── gateway ─── */
const PORT = 18797;
const TOKEN = 'dash-smoke-token';
const gw = spawn('npx', ['tsx', path.join(repo, 'src', 'server', 'gateway.ts')], {
  cwd: root,
  env: { ...process.env, QA_CORE_GATEWAY_PORT: String(PORT), QA_CORE_GATEWAY_TOKEN: TOKEN, QA_CORE_DASHBOARD_DIST: dist, QA_CORE_LEGACY_UI: path.join(repo, 'qa-core-ui.html'), QA_CORE_DB_PATH: path.join(root, 'data', 'qa-core.sqlite'), ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'unused' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
// Never leave a gateway behind, whatever happens below. npx and tsx each
// spawn a child, so the whole process group is killed, not just the wrapper.
const children: Array<{ pid?: number }> = [gw];
const cleanup = (): void => { for (const c of children) { if (c.pid) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } } } };
process.on('exit', cleanup);
process.on('uncaughtException', (err) => { console.error(err); cleanup(); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error(err); cleanup(); process.exit(1); });
let gwLog = '';
gw.stdout.on('data', (d) => { gwLog += String(d); });
gw.stderr.on('data', (d) => { gwLog += String(d); });
const deadline = Date.now() + 60_000;
while (!/listening on/.test(gwLog) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
check('gateway boots, indexes on start, serves http', /listening on http/.test(gwLog) && /Index: 6 run\(s\) across 4 project\(s\)/.test(gwLog) && /1 pre-v2 record\(s\) imported/.test(gwLog), gwLog.slice(0, 400));

const base = `http://127.0.0.1:${PORT}`;
const authGet = async (p: string) => (await fetch(base + p, { headers: { Authorization: `Bearer ${TOKEN}` } })).json() as Promise<Record<string, unknown>>;
check('/api/projects rejects a missing token on the real gateway', (await fetch(base + '/api/projects')).status === 401);
const legacy = await (await fetch(base + '/legacy')).text();
check('/legacy serves the single-file UI', /QA-Core/.test(legacy) && /handleGatewayPayload/.test(legacy));
const projects = (await authGet('/api/projects')).projects as Array<Record<string, unknown>>;
const apiRuns = (await authGet('/api/runs')).runs as Array<Record<string, unknown>>;

/* ─── browser ─── */
const browser = await chromium.launch({ headless: true });
const shotDir = process.env.QA_CORE_SMOKE_SHOTS ?? '';
for (const theme of ['dark', 'light'] as const) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme });
  await context.addInitScript((t) => { localStorage.setItem('qa-core.theme', t); }, theme);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/#token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="project-card"]', { timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="gateway-status"]')?.textContent?.includes('connected'), null, { timeout: 15_000 }).catch(() => null);

  check(`${theme}: theme class applied`, await page.evaluate((t) => document.documentElement.classList.contains('light') === (t === 'light'), theme));
  const cards = await page.$$eval('[data-testid="project-card"]', (els) => els.map((el) => ({
    id: (el as HTMLElement).dataset.projectId,
    shipped: el.querySelector('[data-testid="shipped"]')?.textContent,
    findings: el.querySelector('[data-testid="open-findings"]')?.textContent,
    spend: el.querySelector('[data-testid="spend-month"]')?.textContent,
    legacySub: el.querySelector('[data-testid="shipped-sub"]')?.textContent ?? null,
    envBadge: el.querySelector('[data-testid="env-badge"]')?.textContent ?? null,
    status: el.querySelector('[data-status]')?.getAttribute('data-status'),
    text: el.textContent ?? '',
  })));
  check(`${theme}: one card per project (${projects.length})`, cards.length === projects.length, JSON.stringify(cards.map((c) => c.id)));
  for (const p of projects) {
    const c = cards.find((x) => x.id === p.id);
    const ok = !!c && c.shipped === String(p.shipped) && c.findings === String(p.open_findings) && c.spend === `$${Number(p.spend_month).toFixed(2)}` && c.status === (p.last_run as Record<string, unknown> | null)?.status;
    check(`${theme}: card ${p.id} shows the API's shipped, open findings, spend this month, last run status`, ok, JSON.stringify({ c, p: { shipped: p.shipped, f: p.open_findings, s: p.spend_month, st: (p.last_run as Record<string, unknown> | null)?.status } }));
  }
  const sauce = cards.find((c) => c.id === 'saucedemo-com')!;
  check(`${theme}: coverage sparkline shows the latest coverage percent for the SRS project`, /coverage/.test(sauce.text) && /100%/.test(sauce.text), sauce.text.slice(-80));
  check(`${theme}: a project without SRS runs says so`, /no SRS runs/.test(cards.find((c) => c.id === 'the-internet-herokuapp-com')?.text ?? ''));
  const header = await page.evaluate(() => ({
    gateway: document.querySelector('[data-testid="gateway-status"]')?.textContent ?? '',
    session: document.querySelector('[data-testid="session-spend"]')?.textContent ?? '',
    models: Array.from(document.querySelectorAll('[data-testid="model-chip"]')).map((m) => m.textContent),
  }));
  check(`${theme}: header shows gateway connected (from the socket), session spend, and three model chips from settings`, /connected/.test(header.gateway) && /\$0\.00/.test(header.session) && header.models.length === 3 && header.models.some((m) => /haiku/.test(m ?? '')), JSON.stringify(header));

  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, `projects-${theme}.png`) });
  }

  // Runs table.
  await page.click('a[href="/runs"]');
  await page.waitForSelector('[data-testid="run-row"]');
  const rows = await page.$$eval('[data-testid="run-row"]', (els) => els.map((el) => ({ id: (el as HTMLElement).dataset.runId, sp: el.querySelector('[data-testid="shipped-planned"]')?.textContent, cost: el.querySelector('[data-testid="cost"]')?.textContent, status: el.querySelector('[data-status]')?.getAttribute('data-status'), text: el.textContent ?? '' })));
  check(`${theme}: runs table lists every run newest first`, rows.length === apiRuns.length && rows[0]?.id === apiRuns[0]?.id, JSON.stringify(rows.map((r) => r.id)));
  for (const r of apiRuns) {
    const row = rows.find((x) => x.id === r.id)!;
    const expectSp = r.status === 'legacy' ? `${r.generated} explored` : `${r.shipped}/${r.planned}`;
    check(`${theme}: row ${String(r.id).slice(0, 16)} shows shipped/planned, cost, status from the index`, !!row && row.sp === expectSp && row.cost === `$${Number(r.cost_total).toFixed(4)}` && row.status === r.status, JSON.stringify(row));
  }
  check(`${theme}: source and duration columns render (mcp source, 4m 14s duration)`, rows.some((r) => /mcp/.test(r.text)) && rows.filter((r) => r.status !== 'legacy').every((r) => /4m 14s/.test(r.text)), JSON.stringify(rows.map((r) => r.text.slice(0, 80))));
  const legacyRow = rows.find((r) => r.status === 'legacy')!;
  check(`${theme}: a pre-v2 record renders the "summary only (pre-v2)" badge, "N explored" instead of shipped/planned, and its duration`, !!legacyRow && /summary only \(pre-v2\)/.test(legacyRow.text) && legacyRow.sp === '1 explored' && /4m 15s/.test(legacyRow.text), JSON.stringify(legacyRow));
  const demoqa = cards.find((c) => c.id === 'demoqa-com');
  check(`${theme}: the demoqa card counts 0 tests shipped (legacy scenarios were explored, not shipped) with a muted "+1 legacy run" line`, demoqa?.status === 'legacy' && demoqa?.shipped === '0' && demoqa?.legacySub === '+1 legacy run', JSON.stringify(demoqa));
  check(`${theme}: cards with real runs carry no legacy line`, cards.filter((c) => c.id !== 'demoqa-com').every((c) => c.legacySub === null), JSON.stringify(cards.map((c) => [c.id, c.legacySub])));
  check(`${theme}: the environment badge is hidden when the environment is unset or "other"`, cards.every((c) => !c.envBadge), JSON.stringify(cards.map((c) => c.envBadge)));
  await page.selectOption('[data-testid="filter-project"]', 'saucedemo-com');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="run-row"]').length === 3);
  check(`${theme}: project filter narrows to that project's runs and updates the URL`, (await page.$$('[data-testid="run-row"]')).length === 3 && /project_id=saucedemo-com/.test(page.url()));
  await page.selectOption('[data-testid="filter-status"]', 'stopped');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="run-row"]').length === 1);
  check(`${theme}: status filter narrows further`, (await page.$$('[data-testid="run-row"]')).length === 1);
  await page.selectOption('[data-testid="filter-status"]', 'failed');
  await page.waitForSelector('[data-testid="empty-state"]');
  check(`${theme}: an empty filter result shows an empty state`, /No runs match/.test(await page.textContent('[data-testid="empty-state"]') ?? ''));
  await page.selectOption('[data-testid="filter-status"]', '');
  await page.selectOption('[data-testid="filter-project"]', '');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="run-row"]').length === n, apiRuns.length);
  await page.click(`[data-run-id="${legacyRow.id}"] a`);
  await page.waitForURL(`**/runs/${legacyRow.id}`);
  await page.waitForFunction(() => /Summary only/.test(document.querySelector('main')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => null);
  const legacyDetail = (await page.textContent('main')) ?? '';
  check(`${theme}: the legacy run page explains "summary only", labels the count as explored, and offers no report or zip link`, /Summary only \(pre-v2\)/.test(legacyDetail) && /scenarios explored/.test(legacyDetail) && !/Download framework zip/.test(legacyDetail) && !/api\/runs/.test(legacyDetail), legacyDetail.slice(0, 160));
  await page.goBack();
  await page.waitForSelector('[data-testid="run-row"]');
  await page.click(`[data-run-id="${s1}"] a`);
  await page.waitForURL(`**/runs/${s1}`);
  await page.waitForFunction(() => /PR B/.test(document.querySelector('main')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => null);
  const detailText = (await page.textContent('main')) ?? '';
  check(`${theme}: a row links to /runs/:id (placeholder page shows the run)`, /PR B/.test(detailText) && /3\/5/.test(detailText), detailText.slice(0, 200));
  check(`${theme}: zero console errors`, errors.length === 0, errors.join(' | '));
  await context.close();
}
await browser.close();

/* ─── empty state for an empty output tree ─── */
if (gw.pid) { try { process.kill(-gw.pid, 'SIGKILL'); } catch { /* gone */ } }
await new Promise((r) => setTimeout(r, 800));
fs.rmSync(output, { recursive: true, force: true });
fs.rmSync(path.join(root, '.qa-core'), { recursive: true, force: true });
fs.mkdirSync(output);
const gw2 = spawn('npx', ['tsx', path.join(repo, 'src', 'server', 'gateway.ts')], {
  cwd: root,
  env: { ...process.env, QA_CORE_GATEWAY_PORT: String(PORT + 1), QA_CORE_GATEWAY_TOKEN: '', QA_CORE_DASHBOARD_DIST: dist, QA_CORE_DB_PATH: path.join(root, 'data', 'qa-core-2.sqlite'), ANTHROPIC_API_KEY: 'unused' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
children.push(gw2);
let log2 = '';
gw2.stdout.on('data', (d) => { log2 += String(d); });
const deadline2 = Date.now() + 60_000;
while (!/listening on/.test(log2) && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 200));
const b2 = await chromium.launch({ headless: true });
const p2 = await b2.newPage();
await p2.goto(`http://127.0.0.1:${PORT + 1}/`, { waitUntil: 'networkidle' });
await p2.waitForSelector('[data-testid="empty-state"]');
check('empty output: Projects page explains how the first project appears', /No projects yet/.test((await p2.textContent('[data-testid="empty-state"]')) ?? ''));
await p2.goto(`http://127.0.0.1:${PORT + 1}/runs`, { waitUntil: 'networkidle' });
await p2.waitForSelector('[data-testid="empty-state"]');
check('empty output: Runs page has its empty state', /No runs yet/.test((await p2.textContent('[data-testid="empty-state"]')) ?? ''));
await b2.close();
if (gw2.pid) { try { process.kill(-gw2.pid, 'SIGKILL'); } catch { /* gone */ } }
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the gateway serves the dashboard at / and the legacy UI at /legacy; Projects and Runs render the index numbers, which equal the run-reports.');
