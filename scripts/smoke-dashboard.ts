/**
 * Locks the dashboard scaffold (PR A): the gateway serves the built app at /,
 * the WebSocket at /ws, and the Projects and Runs
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
import { GLOSSARY } from '../dashboard/src/lib/glossary.js';

/** The exact figure the card's money tooltip carries (dashboard/src/lib/utils.ts exactMoney): the API number with float noise beyond 12 significant digits removed. */
const exactMoney = (v: unknown): string => `$${String(Number(Number(v).toPrecision(12)))}`;
/** What a glossary tooltip renders: "<Term>. <text>" (dashboard/src/components/Term.tsx TermBody). */
const tipText = (key: keyof typeof GLOSSARY): string => `${GLOSSARY[key].term}. ${GLOSSARY[key].text}`;
/** Contrast helper, injected as plain script (tsx would inject __name into a named inner function). Same method as smoke-run-detail. */
const CONTRAST_SCRIPT = `
window.__contrast = function (selectors) {
  function lum(rgb) { var m = (rgb.match(/[\\d.]+/g) || ['0','0','0']).slice(0, 3).map(function (v) { var c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; }
  function parse(c) { var m = (c.match(/[\\d.]+/g) || ['0','0','0','1']).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; }
  function bgOf(el) {
    var layers = [];
    for (var e = el; e; e = e.parentElement) { var p = parse(getComputedStyle(e).backgroundColor); if (p.a > 0) layers.push(p); if (p.a >= 1) break; }
    var r = 0, g = 0, b = 0;
    for (var i = layers.length - 1; i >= 0; i--) { var l = layers[i]; r = l.r * l.a + r * (1 - l.a); g = l.g * l.a + g * (1 - l.a); b = l.b * l.a + b * (1 - l.a); }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  var out = {};
  selectors.forEach(function (s) { var el = document.querySelector(s); if (!el) { out[s] = -1; return; } var a = lum(getComputedStyle(el).color), bb = lum(bgOf(el)); out[s] = Math.round(((Math.max(a, bb) + 0.05) / (Math.min(a, bb) + 0.05)) * 10) / 10; });
  return out;
};`;
const PROJECTS_CONTRAST = ['[data-testid="latest-shipped"]', '[data-testid="shipped"]', '[data-testid="unresolved-findings"]', '[data-testid="spend-month"]', '[data-testid="card-tiles"] dt', '[data-testid="card-tiles"] dd:last-child', '[data-testid="card-url"]', '[data-testid="runs-count"]', '[data-testid="card-footer"]', '[data-testid="coverage-latest"]', '[data-testid="coverage-none"]', '[data-testid="card-status-line"]', '[data-testid="gateway-status"]', '[data-testid="session-spend"]', '[data-testid="model-chip"]', '[data-testid="page-header"] h1', '[data-testid="page-header"] p', '[data-status="completed"]', '[data-testid="earlier-note"]', '[data-testid="new-project-open"]', '[data-testid="earlier-row"] [data-glossary="legacy"]', '[data-testid="earlier-host"]'];
const RUNS_CONTRAST = ['[data-testid="cost"]', '[data-testid="flake-rate"]', '[data-testid="duration"]', '[data-testid="run-source"]', '[data-testid="shipped-planned"]', '[data-status="completed"]', '[data-status="stopped"]', '[data-status="empty"]', '[data-status="legacy"]', '[data-testid="toggle-legacy"]', '[data-testid="runs-count"]', 'th [data-glossary="cost"]'];

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
  env: { ...process.env, QA_CORE_GATEWAY_PORT: String(PORT), QA_CORE_GATEWAY_TOKEN: TOKEN, QA_CORE_DASHBOARD_DIST: dist, QA_CORE_DB_PATH: path.join(root, 'data', 'qa-core.sqlite'), ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? 'unused' },
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
const spaFallback = await (await fetch(base + '/some/client/route')).text();
check('an unknown route falls through to the SPA shell (the retired single-file UI is gone)', /<div id="root">/.test(spaFallback) && !/handleGatewayPayload/.test(spaFallback));
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
    findings: el.querySelector('[data-testid="unresolved-findings"]')?.textContent,
    spend: el.querySelector('[data-testid="spend-month"]')?.textContent,
    spendTip: el.querySelector('[data-testid="spend-month"] [data-tip]')?.getAttribute('data-tip') ?? null,
    latest: el.querySelector('[data-testid="latest-shipped"]')?.textContent ?? null,
    naTerms: Array.from(el.querySelectorAll('[data-glossary="notAvailable"]')).length,
    legacySub: el.querySelector('[data-testid="legacy-note"]')?.getAttribute('data-tip') ?? null,
    envBadge: el.querySelector('[data-testid="env-badge"]')?.textContent ?? null,
    status: el.querySelector('[data-status]')?.getAttribute('data-status'),
    text: el.textContent ?? '',
  })));
  // Cards: only projects with at least one run that has a report (PR F part 1 refinement). A legacy-only project is never a card.
  const reported = projects.filter((p) => p.id !== 'unassigned' && Number(p.reported_runs) > 0);
  check(`${theme}: one card per project with a reported run (${reported.length}); a legacy-only project renders no card`, cards.length === reported.length && reported.every((p) => cards.some((c) => c.id === p.id)) && !cards.some((c) => c.id === 'demoqa-com'), JSON.stringify(cards.map((c) => c.id)));
  for (const p of reported) {
    const c = cards.find((x) => x.id === p.id);
    const last = p.last_run as Record<string, unknown> | null;
    // Money on a card is 2 decimals; the exact stored value travels in the tooltip (PR F part 1).
    const ok = !!c && c.shipped === String(p.shipped) && c.findings === String(p.unresolved_findings) && c.spend === `$${Number(p.spend_month).toFixed(2)}` && c.spendTip === `exact: ${exactMoney(p.spend_month)}` && c.status === last?.status;
    check(`${theme}: card ${p.id} shows the API's shipped, unresolved findings, spend this month (2 decimals, exact value in the tooltip), last run status`, ok, JSON.stringify({ c, p: { shipped: p.shipped, f: p.unresolved_findings, s: p.spend_month, st: last?.status } }));
    // The headline is the latest run's shipped count, straight from last_run.shipped (no arithmetic).
    const expectLatest = last && last.shipped !== null && last.shipped !== undefined ? String(last.shipped) : null;
    check(`${theme}: card ${p.id} headlines "tests in the latest run" with last_run.shipped (${expectLatest})`, c?.latest === expectLatest, JSON.stringify({ latest: c?.latest, last }));
  }
  // The text "n/a" appears nowhere: a value the index does not have is not rendered as a metric.
  check(`${theme}: the Projects page renders no "n/a" text`, (await page.evaluate(() => (document.body.innerText.match(/\bn\/a\b/g) || []).length)) === 0);
  // Earlier experiments: a muted line with the count and a Show link; the table lists the legacy-only project with its explored count and "summary only".
  const noteBefore = await page.evaluate(() => ({ note: document.querySelector('[data-testid="earlier-note"]')?.textContent ?? '', toggle: document.querySelector('[data-testid="earlier-toggle"]')?.textContent ?? '', table: !!document.querySelector('[data-testid="earlier-table"]') }));
  check(`${theme}: under the grid one muted line says "1 earlier experiment is hidden." with a Show link and no table yet`, /^1 earlier experiment is hidden\./.test(noteBefore.note.trim()) && noteBefore.toggle === 'Show' && !noteBefore.table, JSON.stringify(noteBefore));
  await page.click('[data-testid="earlier-toggle"]');
  await page.waitForSelector('[data-testid="earlier-table"]');
  const earlierRows = await page.$$eval('[data-testid="earlier-row"]', (els) => els.map((el) => ({ id: (el as HTMLElement).dataset.projectId, name: el.querySelector('[data-testid="earlier-name"]')?.textContent, host: el.querySelector('[data-testid="earlier-host"]')?.textContent, runs: el.querySelector('[data-testid="earlier-runs"]')?.textContent, explored: el.querySelector('[data-testid="earlier-explored"]')?.textContent, label: el.lastElementChild?.textContent })));
  check(`${theme}: Show reveals the compact table: the demoqa record with 1 run, 1 scenario explored and the "summary only" label in words, never a shipped count`, earlierRows.length === 1 && earlierRows[0]?.id === 'demoqa-com' && earlierRows[0]?.host === 'demoqa.com' && earlierRows[0]?.runs === '1' && earlierRows[0]?.explored === '1' && earlierRows[0]?.label === 'summary only', JSON.stringify(earlierRows));
  // Tooltips render the glossary entry, word for word (hover the tile's info icon, then read role=tooltip).
  await page.hover('[data-project-id="saucedemo-com"] [data-glossary="latestShipped"]');
  await page.waitForSelector('[role="tooltip"]', { timeout: 5000 });
  check(`${theme}: hovering the "Verified tests" icon on a card shows its glossary entry`, (await page.textContent('[role="tooltip"]')) === tipText('latestShipped'), (await page.textContent('[role="tooltip"]')) ?? '');
  // A Term trigger has no underline at rest and a dotted underline on hover (PR F part 1, third refinement).
  const termRest = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="earlier-note"] [data-glossary]')!).textDecorationLine);
  await page.hover('[data-testid="earlier-note"] [data-glossary]');
  const termHover = await page.evaluate(() => { const el = document.querySelector('[data-testid="earlier-note"] [data-glossary]')!; const cs = getComputedStyle(el); return `${cs.textDecorationLine} ${cs.textDecorationStyle}`; });
  check(`${theme}: a glossary term has no underline at rest and a dotted underline on hover`, termRest === 'none' && termHover === 'underline dotted', JSON.stringify({ termRest, termHover }));
  // No interactive element nests in another on the page: the card is clickable through the name link's stretched overlay, not an <a> around the card.
  check(`${theme}: no nested interactive elements on the Projects page`, (await page.evaluate(() => document.querySelectorAll('a a, a button, button button, button a').length)) === 0);
  await page.mouse.move(0, 0);
  await page.waitForSelector('[role="tooltip"]', { state: 'detached', timeout: 5000 }).catch(() => null);
  // The keyboard path: a focused trigger opens its tooltip and is described by it (aria-describedby).
  await page.focus('[data-testid="gateway-status"]');
  await page.waitForFunction((t) => document.querySelector('[role="tooltip"]')?.textContent === t, tipText('gateway'), { timeout: 5000 }).catch(() => null);
  const gatewayTip = await page.evaluate(() => { const tip = document.querySelector('[role="tooltip"]'); const trigger = document.querySelector('[data-testid="gateway-status"]'); return { text: tip?.textContent ?? null, described: !!tip && trigger?.getAttribute('aria-describedby') === tip.id }; });
  check(`${theme}: focusing the gateway chip (keyboard) opens its glossary entry and the chip is described by it`, gatewayTip.text === tipText('gateway') && gatewayTip.described, JSON.stringify(gatewayTip));
  await page.keyboard.press('Escape');
  await page.mouse.move(0, 0);
  await page.addScriptTag({ content: CONTRAST_SCRIPT });
  const pc = await page.evaluate((sel) => (window as unknown as { __contrast: (s: string[]) => Record<string, number> }).__contrast(sel), PROJECTS_CONTRAST) as Record<string, number>;
  check(`${theme}: every sampled Projects text keeps at least 4.5:1 contrast against its background`, Object.values(pc).every((v) => v >= 4.5), JSON.stringify(pc));
  await page.click('[data-testid="earlier-toggle"]');
  await page.waitForSelector('[data-testid="earlier-table"]', { state: 'detached' });
  check(`${theme}: Hide removes the table again`, !(await page.$('[data-testid="earlier-table"]')));
  // The New project dialog: Escape and focus return, a blocked empty submit, and the API's own 409 for a host that already has a project (nothing is created).
  const projectsBefore = ((await authGet('/api/projects')).projects as unknown[]).length;
  await page.click('[data-testid="new-project-open"]');
  await page.waitForSelector('[data-testid="new-project-dialog"]');
  check(`${theme}: the New project button opens a dialog and focus moves to the Base URL field`, (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'new-project-url');
  await page.click('[data-testid="new-project-submit"]');
  check(`${theme}: an empty submit is blocked with a message`, (await page.textContent('[data-testid="new-project-error"]')) === 'Base URL is required.');
  await page.fill('[data-testid="new-project-url"]', 'not a url');
  await page.click('[data-testid="new-project-submit"]');
  check(`${theme}: a value that is not an http or https address is blocked client side`, /full http or https address/.test((await page.textContent('[data-testid="new-project-error"]')) ?? ''));
  await page.fill('[data-testid="new-project-url"]', 'https://www.saucedemo.com/');
  await page.click('[data-testid="new-project-submit"]');
  await page.waitForSelector('[data-testid="new-project-conflict"]', { timeout: 10_000 });
  // The 409 renders a neutral box built from the API body's `existing` (id and name), never from the message text, with an Open project link; no reject box.
  const dialog409 = await page.evaluate(() => ({ conflict: document.querySelector('[data-testid="new-project-conflict"]')?.textContent ?? '', existing: document.querySelector('[data-testid="new-project-existing"]')?.getAttribute('href') ?? null, linkText: document.querySelector('[data-testid="new-project-existing"]')?.textContent ?? null, errorBox: !!document.querySelector('[data-testid="new-project-error"]'), nested: document.querySelectorAll('button button').length }));
  check(`${theme}: a host that already has a project shows "This site already has a project: saucedemo." with an Open project link, in a neutral box, and no button nests inside a button`, dialog409.conflict.trim() === 'This site already has a project: saucedemo. Open project' && dialog409.existing === '/projects/saucedemo-com' && dialog409.linkText === 'Open project' && !dialog409.errorBox && dialog409.nested === 0, JSON.stringify(dialog409));
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid="new-project-dialog"]', { state: 'detached' });
  // Radix restores focus to the trigger as its focus scope unmounts, a beat after the content detaches.
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'new-project-open', null, { timeout: 3000 }).catch(() => null);
  check(`${theme}: Escape closes the dialog, focus returns to the button, and no project was created`, (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'new-project-open' && ((await authGet('/api/projects')).projects as unknown[]).length === projectsBefore);
  const sauce = cards.find((c) => c.id === 'saucedemo-com')!;
  // The requirements row: "<covered> of <total>" from the latest coverage_series entry and a bar whose width is its percent (3 of 3 after the s3 run; the earlier s2 run covered 2 of 3).
  const sauceCov = await page.evaluate(() => ({ text: document.querySelector('[data-project-id="saucedemo-com"] [data-testid="coverage-latest"]')?.textContent ?? null, percent: document.querySelector('[data-project-id="saucedemo-com"] [data-testid="coverage-bar"]')?.getAttribute('data-percent') ?? null, width: (document.querySelector('[data-project-id="saucedemo-com"] [data-testid="coverage-bar-fill"]') as HTMLElement | null)?.style.width ?? null }));
  const sauceApi = projects.find((p) => p.id === 'saucedemo-com')!.coverage_series as Array<{ covered: number; total: number; percent: number }>;
  const sauceLatest = sauceApi[sauceApi.length - 1]!;
  check(`${theme}: the requirements row reads "${sauceLatest.covered} of ${sauceLatest.total}" from the latest coverage_series entry and the bar width is its percent (${sauceLatest.percent}%)`, /Requirements covered/.test(sauce.text) && sauceCov.text === `${sauceLatest.covered} of ${sauceLatest.total}` && sauceCov.percent === String(sauceLatest.percent) && sauceCov.width === `${sauceLatest.percent}%` && sauceLatest.covered === 3 && sauceLatest.total === 3, JSON.stringify({ sauceCov, sauceLatest }));
  check(`${theme}: a project without SRS runs says "No requirements document used yet" under the same label`, /Requirements covered/.test(cards.find((c) => c.id === 'the-internet-herokuapp-com')?.text ?? '') && /No requirements document used yet/.test(cards.find((c) => c.id === 'the-internet-herokuapp-com')?.text ?? '') && !/\d+ of \d+/.test(cards.find((c) => c.id === 'the-internet-herokuapp-com')?.text ?? ''));
  const cardGeometry = await page.$$eval('[data-testid="project-card"]', (els) => els.map((el) => ({ h: el.getBoundingClientRect().height, footer: el.querySelector('[data-testid="card-footer"]')!.getBoundingClientRect().top })));
  check(`${theme}: every card has the same height and the footers share one top (within 1px)`, cardGeometry.length > 1 && cardGeometry.every((g) => Math.abs(g.h - cardGeometry[0]!.h) <= 1 && Math.abs(g.footer - cardGeometry[0]!.footer) <= 1), JSON.stringify(cardGeometry));
  const fonts = await page.evaluate(() => ({ number: getComputedStyle(document.querySelector('[data-testid="latest-shipped"]')!).fontFamily, label: getComputedStyle(document.querySelector('[data-testid="card-tiles"] dt')!).fontFamily }));
  check(`${theme}: card numbers and tile labels render in Inter, never Geist`, /Inter/.test(fonts.number) && /Inter/.test(fonts.label) && !/Geist/.test(fonts.number + fonts.label), JSON.stringify(fonts));
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
  // Pre-v2 summaries are hidden behind a visible toggle, off by default; the total count stays on screen.
  const legacyTotal = apiRuns.filter((r) => r.status === 'legacy').length;
  const hidden = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid="run-row"]').length, toggle: document.querySelector('[data-testid="toggle-legacy"]')?.textContent ?? '', checked: document.querySelector('[data-testid="toggle-legacy"]')?.getAttribute('aria-checked'), count: document.querySelector('[data-testid="runs-count"]')?.textContent ?? '' }));
  check(`${theme}: runs table hides the ${legacyTotal} pre-v2 row(s) by default behind "Show pre-v2 summaries (N)" and still states the total`, hidden.rows === apiRuns.length - legacyTotal && hidden.checked === 'false' && new RegExp(`Show pre-v2 summaries\\s*\\(${legacyTotal}\\)`).test(hidden.toggle) && hidden.count.startsWith(`${apiRuns.length} runs`) && new RegExp(`${legacyTotal} pre-v2 hidden`).test(hidden.count), JSON.stringify(hidden));
  await page.click('[data-testid="toggle-legacy"]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="run-row"]').length === n, apiRuns.length);
  check(`${theme}: the toggle shows the pre-v2 rows and reads on`, (await page.getAttribute('[data-testid="toggle-legacy"]', 'aria-checked')) === 'true');
  const rows = await page.$$eval('[data-testid="run-row"]', (els) => els.map((el) => ({ id: (el as HTMLElement).dataset.runId, sp: el.querySelector('[data-testid="shipped-planned"]')?.textContent, cost: el.querySelector('[data-testid="cost"]')?.textContent, costTip: el.querySelector('[data-testid="cost"]')?.closest('[data-tip]')?.getAttribute('data-tip') ?? null, status: el.querySelector('[data-status]')?.getAttribute('data-status'), text: el.textContent ?? '' })));
  check(`${theme}: runs table lists every run newest first`, rows.length === apiRuns.length && rows[0]?.id === apiRuns[0]?.id, JSON.stringify(rows.map((r) => r.id)));
  for (const r of apiRuns) {
    const row = rows.find((x) => x.id === r.id)!;
    const expectSp = r.status === 'legacy' ? `${r.generated} explored` : `${r.shipped}/${r.planned}`;
    // Cost is 2 decimals in the table with the exact report value in the tooltip, like the cards (PR F part 1, second refinement).
    check(`${theme}: row ${String(r.id).slice(0, 16)} shows shipped/planned, cost (2 decimals, exact value in the tooltip), status from the index`, !!row && row.sp === expectSp && row.cost === `$${Number(r.cost_total).toFixed(2)}` && row.costTip === `exact: ${exactMoney(r.cost_total)}` && row.status === r.status, JSON.stringify(row));
  }
  check(`${theme}: source and duration columns render (mcp source, 4m 14s duration)`, rows.some((r) => /mcp/.test(r.text)) && rows.filter((r) => r.status !== 'legacy').every((r) => /4m 14s/.test(r.text)), JSON.stringify(rows.map((r) => r.text.slice(0, 80))));
  const legacyRow = rows.find((r) => r.status === 'legacy')!;
  check(`${theme}: a pre-v2 record renders the "summary only (pre-v2)" badge, "N explored" instead of shipped/planned, and its duration`, !!legacyRow && /summary only \(pre-v2\)/.test(legacyRow.text) && legacyRow.sp === '1 explored' && /4m 15s/.test(legacyRow.text), JSON.stringify(legacyRow));
  check(`${theme}: cards with real runs and no pre-v2 record carry no pre-v2 footer icon`, cards.every((c) => c.legacySub === null), JSON.stringify(cards.map((c) => [c.id, c.legacySub])));
  check(`${theme}: the environment badge is hidden when the environment is unset or "other"`, cards.every((c) => !c.envBadge), JSON.stringify(cards.map((c) => c.envBadge)));
  check(`${theme}: a status badge carries its glossary entry (hover "stopped")`, await (async () => { await page.hover('[data-status="stopped"]'); await page.waitForFunction((t) => document.querySelector('[role="tooltip"]')?.textContent === t, tipText('statusStopped'), { timeout: 5000 }).catch(() => null); return (await page.textContent('[role="tooltip"]')) === tipText('statusStopped'); })(), (await page.textContent('[role="tooltip"]').catch(() => null)) ?? '');
  await page.mouse.move(0, 0);
  await page.addScriptTag({ content: CONTRAST_SCRIPT });
  const rc = await page.evaluate((sel) => (window as unknown as { __contrast: (s: string[]) => Record<string, number> }).__contrast(sel), RUNS_CONTRAST) as Record<string, number>;
  check(`${theme}: every sampled Runs text keeps at least 4.5:1 contrast against its background`, Object.values(rc).every((v) => v >= 4.5), JSON.stringify(rc));
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
  await page.waitForFunction(() => /pre-v2 record, per-scenario detail not captured/.test(document.querySelector('main')?.textContent ?? ''), null, { timeout: 10_000 }).catch(() => null);
  const legacyDetail = (await page.textContent('main')) ?? '';
  check(`${theme}: the legacy run page shows the pre-v2 notice, labels the count as explored, and offers no report or zip link`, /pre-v2 record, per-scenario detail not captured/.test(legacyDetail) && /scenarios explored/.test(legacyDetail) && !/Download/.test(legacyDetail) && !(await page.$('[data-testid="artifact-link"]')), legacyDetail.slice(0, 160));
  await page.goBack();
  await page.waitForSelector('[data-testid="run-row"]');
  await page.click(`[data-run-id="${s1}"] a`);
  await page.waitForURL(`**/runs/${s1}`);
  await page.waitForSelector('[data-testid="run-detail"][data-legacy="false"]', { timeout: 10_000 }).catch(() => null);
  const detailText = (await page.textContent('main')) ?? '';
  check(`${theme}: a row links to /runs/:id (the run detail page shows the run)`, /Scenarios/.test(detailText) && /Product behavior to review/.test(detailText) && (await page.textContent('[data-testid="detail-run-id"]')) === s1, detailText.slice(0, 200));
  // The browser logs the expected 409 of the duplicate-host attempt above as a failed resource; it is the API's answer, not a page error.
  const pageErrors = errors.filter((e) => !/status of 409/.test(e));
  check(`${theme}: zero console errors (the 409 answer to the duplicate-host attempt is the only resource log)`, pageErrors.length === 0 && errors.every((e) => /status of 409/.test(e)), errors.join(' | '));
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
console.log('OK: the gateway serves the dashboard at /; Projects and Runs render the index numbers, which equal the run-reports, with glossary tooltips, the pre-v2 toggle and 4.5:1 contrast in both themes.');
