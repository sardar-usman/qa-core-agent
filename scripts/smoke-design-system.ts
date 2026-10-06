/**
 * Locks the dashboard design system (docs/ui/design-system.md, CLAUDE.md
 * invariant 68):
 *   (a) static: dashboard/src carries no arbitrary text, tracking or leading
 *       value, no bold / extrabold / black / light weight, no Tailwind default
 *       size name and none of the old names, no numeric fontSize in TSX, no
 *       rounded-xl or larger, no toLocale call outside lib/format.ts, and no
 *       `?? 0` inside lib/format.ts
 *   (b) live: every route and the New project dialog, in both themes at
 *       1440: every visible element with its own text has a font-size in
 *       {12, 13, 14, 16, 18, 24, 32}, a weight in {400, 500, 600} and the
 *       family Plus Jakarta Sans or Geist Mono; a size-by-route table is
 *       printed
 *   (c) formatter: formatMoney, formatCount and formatDate under a browser
 *       locale of en-US and of de-DE render the same strings
 * Fixture output tree, its own gateway on 18797. No model, no live run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { newRunId } from '../src/agent/output-layout.js';
import { formatCount, formatDate, formatMoney, exactMoney } from '../dashboard/src/lib/format.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};
const repo = process.cwd();

/* ─── (a) static scan ─── */
const srcDir = path.join(repo, 'dashboard', 'src');
const walk = (dir: string): string[] => fs.readdirSync(dir).flatMap((n) => { const f = path.join(dir, n); return fs.statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(n) ? [f] : []; });
const RULES: Array<{ name: string; re: RegExp; only?: (rel: string) => boolean }> = [
  { name: 'arbitrary text size (text-[...])', re: /\btext-\[/ },
  { name: 'arbitrary tracking (tracking-[...])', re: /\btracking-\[/ },
  { name: 'arbitrary leading (leading-[...])', re: /\bleading-\[/ },
  { name: 'a weight outside 400 / 500 / 600', re: /\bfont-(bold|extrabold|black|light|thin)\b/ },
  { name: 'a Tailwind default size name', re: /\btext-(xs|sm|base|lg|xl|[2-9]xl)\b/ },
  { name: 'an old scale name (text-s, text-m, text-section, text-l)', re: /\btext-(s|m|section|l)\b/ },
  { name: 'a numeric fontSize in TSX', re: /\bfontSize=(?:["']\d|\{\s*\d)/, only: (rel) => rel.endsWith('.tsx') },
  { name: 'rounded-xl or larger', re: /\brounded-(xl|[2-9]xl)\b/ },
  { name: 'toLocale outside lib/format.ts', re: /toLocale/, only: (rel) => !rel.endsWith(path.join('lib', 'format.ts')) },
  { name: '"?? 0" inside lib/format.ts', re: /\?\?\s*0\b/, only: (rel) => rel.endsWith(path.join('lib', 'format.ts')) },
];
const violations: string[] = [];
for (const f of walk(srcDir)) {
  const rel = path.relative(repo, f);
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  for (const rule of RULES) {
    if (rule.only && !rule.only(rel)) continue;
    lines.forEach((line, i) => { if (rule.re.test(line)) violations.push(`${rel}:${i + 1} ${rule.name}`); });
  }
}
check(`A. static scan of dashboard/src: no arbitrary text / tracking / leading, no bold weight, no default or old size name, no numeric fontSize, no rounded-xl, no toLocale outside format.ts, no "?? 0" in format.ts (${walk(srcDir).length} files)`, violations.length === 0, violations.slice(0, 10).join('; '));
const tw = fs.readFileSync(path.join(repo, 'dashboard', 'tailwind.config.ts'), 'utf8');
check('A2. the tailwind config defines exactly the seven sizes as the whole theme.fontSize (not extend), and no xl radius', /theme:\s*\{\s*fontSize:\s*\{/.test(tw) && ['display', 'title', 'heading', 'subheading', 'body', 'small', 'caption'].every((k) => new RegExp(`\\b${k}: \\['`).test(tw)) && (tw.match(/: \['\d+px', \{ lineHeight/g) ?? []).length === 7 && !/xl:/.test(tw));
const utils = fs.readFileSync(path.join(repo, 'dashboard', 'src', 'lib', 'utils.ts'), 'utf8');
check('A3. the seven names are registered with tailwind-merge in lib/utils.ts', /'font-size': \[\{ text: \['display', 'title', 'heading', 'subheading', 'body', 'small', 'caption'\] \}\]/.test(utils));

/* ─── (c) formatter units ─── */
check('C1. formatMoney: null is "n/a", 0 is "$0.00", 0.004 is "<$0.01", 6.687293 is "$6.69", NaN is "n/a"', formatMoney(null) === 'n/a' && formatMoney(undefined) === 'n/a' && formatMoney(0) === '$0.00' && formatMoney(0.004) === '<$0.01' && formatMoney(6.687293) === '$6.69' && formatMoney(Number.NaN) === 'n/a', JSON.stringify([formatMoney(null), formatMoney(0), formatMoney(0.004), formatMoney(6.687293)]));
check('C2. exactMoney: the stored value with float noise removed, "not recorded" when missing', exactMoney(6.091172000000001) === '$6.091172' && exactMoney(null) === 'not recorded');
check('C3. formatCount: "1 test", "12 tests", null is "n/a"', formatCount(1, 'test', 'tests') === '1 test' && formatCount(12, 'test', 'tests') === '12 tests' && formatCount(null, 'test', 'tests') === 'n/a');
const sameYear = new Date().getFullYear();
check('C4. formatDate: "5 Oct" this year, "5 Oct 2025" another year, "Today, HH:MM" today, "n/a" when missing or invalid', formatDate(`${sameYear}-10-05T09:00:00.000Z`).replace(/^Today, \d\d:\d\d$/, '5 Oct') === '5 Oct' && formatDate('2025-10-05T09:00:00.000Z') === '5 Oct 2025' && /^Today, \d\d:\d\d$/.test(formatDate(new Date().toISOString())) && formatDate(null) === 'n/a' && formatDate('nope') === 'n/a', JSON.stringify([formatDate(`${sameYear}-10-05T09:00:00.000Z`), formatDate('2025-10-05T09:00:00.000Z'), formatDate(new Date().toISOString())]));

/* ─── fixture ─── */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-design-'));
const output = path.join(root, 'output');
const step = (url: string) => ({ kind: 'navigate', url });
const slug = 'practicesoftwaretesting-com';
const site = 'https://practicesoftwaretesting.com/';
const runStopped = newRunId(new Date('2026-09-24T15:23:55Z'), '51d535');
const run6 = newRunId(new Date('2026-10-01T12:25:57Z'), '44cb3d');
const scenarios = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `scenario ${i + 1}`, feature: i % 2 ? 'cart' : 'login', category: 'happy', steps: [step(site)] }));
const report = (id: string, startedAt: string, shipped: number, extra: Record<string, unknown>) => ({
  url: site, language: 'ts', startedAt, finishedAt: new Date(Date.parse(startedAt) + 1_170_000).toISOString(), steps: 362,
  scenarios: scenarios(shipped), cascadeStats: {},
  cost: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1, usd: 5.9386, plannerUsd: 0.0297, criticUsd: 0.1181, repairUsd: 1.547, requirementsUsd: 0.0048 },
  plan: [...scenarios(shipped).map((s) => ({ name: s.name, category: 'happy', rationale: 'r', feature: s.feature, ruleIds: ['R1'], pageUrl: site })), { name: 'rentals page lists products', category: 'happy', rationale: 'r', feature: 'catalogue', pageUrl: site + 'rentals' }],
  review: { verdicts: scenarios(shipped).map((s, i) => ({ scenario: s.name, verdict: i === 0 ? 'rework' : 'pass', reasons: i === 0 ? ['no timeout on the URL assertion'] : [], required_fixes: i === 0 ? ['add a 5000 ms timeout'] : [] })), summary: 'Most scenarios assert a user-visible signal.', repair: [{ scenario: 'scenario 1', first: 'rework', second: 'pass', outcome: 'kept', fixes: [{ fix: 'add a 5000 ms timeout', applied: true, reason: 'step 4 carries 5000' }] }] },
  replay: { passed: shipped, failed: 0, durationMs: 4066, verdicts: scenarios(shipped).map((s) => ({ name: s.name, passed: true, durationMs: 3957 })) },
  stability: { iterations: 3, passed: shipped, flaked: 0, flakeRate: 0, durationMs: 14117, recovered: 0, stabilizerCostUsd: 0, verdicts: scenarios(shipped).map((s) => ({ name: s.name, iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 14026, attempts: [] })) },
  findings: [{ scenario: 'rentals page lists products', category: 'happy', expected: 'rentals product prices rendered to match at least 1 element(s)', url: site + 'rentals', messages: [], kind: 'product' }],
  discovery: { method: 'sitemap', pages: [{ url: site, source: 'sitemap' }, { url: site + 'rentals', source: 'sitemap', feature: 'catalogue' }], warnings: [], candidates: [] },
  ruleCoverage: { covered: [{ ruleId: 'R1', scenarios: ['scenario 1'] }], uncovered: [{ ruleId: 'R2', text: 'Typing a term in the search box shows only matching products.', reason: 'not-planned' }] },
  reconciliation: { planned: shipped + 1, generated: shipped, dropped: [], incomplete: [], findings: [{ name: 'rentals page lists products', expected: 'rentals product prices rendered to match at least 1 element(s)', url: site + 'rentals', messages: [] }], skipped: [], accountedFor: shipped + 1, added: 0, balanced: true, stable: shipped, recovered: 0, flaky: 0, broken: 0 },
  ...extra,
});
const write = (id: string, rep: Record<string, unknown>, files: Record<string, string> = {}) => {
  const dir = path.join(output, slug, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(rep, null, 2));
  fs.writeFileSync(path.join(dir, 'run-meta.json'), JSON.stringify({ source: 'cli', flags: {}, writtenAt: 'x' }));
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), v);
};
write(runStopped, report(runStopped, '2026-09-24T15:23:55.000Z', 5, { stopped: { kind: 'cost_ceiling', reason: 'cost ceiling hit' } }), { 'checkpoint.json': '{}' });
write(run6, report(run6, '2026-10-01T12:25:57.000Z', 12, {}), { 'practicesoftwaretesting-automation-framework.zip': 'PK', 'events.jsonl': JSON.stringify({ t: '2026-10-01T12:26:02.000Z', type: 'message', text: 'Planner [1/2] planned 8 scenario(s)' }) + '\n' + JSON.stringify({ t: '2026-10-01T12:26:05.000Z', type: 'usage', usd: 0.0123 }) + '\n', 'rule-coverage.json': '{}', 'requirements-map.json': JSON.stringify({ features: [{ name: 'catalogue', rules: [{ id: 'R1', text: 'The home page lists products.', type: 'behavior' }, { id: 'R2', text: 'Typing a term in the search box shows only matching products.', type: 'behavior' }] }], roles: [] }) });
fs.mkdirSync(path.join(root, '.qa-core', 'sites'), { recursive: true });
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'demoqa.com.json'), JSON.stringify({ host: 'demoqa.com', recentRuns: [{ at: '2026-06-30T15:00:00.000Z', url: 'https://demoqa.com/frames', scenarios: 1, cost: 0.6, model: 'claude-opus-4-7', durationSec: 255 }] }));

/* ─── gateway ─── */
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }
const PORT = 18797;
const TOKEN = 'design-token';
const gw = spawn('npx', ['tsx', path.join(repo, 'src', 'server', 'gateway.ts')], {
  cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, QA_CORE_GATEWAY_PORT: String(PORT), QA_CORE_GATEWAY_TOKEN: TOKEN, QA_CORE_DASHBOARD_DIST: dist, QA_CORE_DB_PATH: path.join(root, 'data', 'qa-core.sqlite'), ANTHROPIC_API_KEY: 'unused' },
});
const killGw = (): void => { if (gw.pid) { try { process.kill(-gw.pid, 'SIGKILL'); } catch { /* gone */ } } };
process.on('exit', killGw);
process.on('uncaughtException', (err) => { console.error(err); killGw(); process.exit(1); });
process.on('unhandledRejection', (err) => { console.error(err); killGw(); process.exit(1); });
let gwLog = '';
gw.stdout.on('data', (c) => { gwLog += String(c); });
gw.stderr.on('data', (c) => { gwLog += String(c); });
const deadline = Date.now() + 60_000;
while (!/listening on/.test(gwLog) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
check('B0. gateway boots on the fixture root', /listening on http/.test(gwLog), gwLog.slice(0, 300));
const base = `http://127.0.0.1:${PORT}`;

/* ─── (b) live ─── */
const ROUTES: Array<{ name: string; path: string; dialog?: boolean }> = [
  { name: 'projects', path: '/' }, { name: 'project', path: `/projects/${slug}` }, { name: 'runs', path: '/runs' }, { name: 'run-44cb3d', path: `/runs/${run6}` },
  { name: 'findings', path: '/findings' }, { name: 'coverage', path: '/coverage' }, { name: 'terminal', path: '/terminal' }, { name: 'settings', path: '/settings' }, { name: 'new-project-dialog', path: '/', dialog: true },
];
const SIZES = new Set([12, 13, 14, 16, 18, 24, 32]);
const WEIGHTS = new Set([400, 500, 600]);
const FAMILIES = ['Plus Jakarta Sans Variable', 'Geist Mono Variable'];
const browser = await chromium.launch({ headless: true });
const tableLines: string[] = [];
for (const theme of ['light', 'dark'] as const) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript((t: string) => { localStorage.setItem('qa-core.theme', t); }, theme);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  for (const r of ROUTES) {
    await page.goto(`${base}${r.path}#token=${TOKEN}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    if (r.dialog) { await page.click('[data-testid="new-project-open"]'); await page.waitForSelector('[data-testid="new-project-dialog"]'); await page.waitForTimeout(200); }
    const scan = await page.evaluate(() => {
      const sizes: Record<string, number> = {}; const weights: Record<string, number> = {}; const bad: string[] = [];
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0)) continue;
        const rect = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (rect.width === 0 || rect.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
        const size = Math.round(parseFloat(cs.fontSize)); const weight = Number(cs.fontWeight); const family = cs.fontFamily.split(',')[0]!.replace(/"/g, '');
        sizes[size] = (sizes[size] ?? 0) + 1; weights[weight] = (weights[weight] ?? 0) + 1;
        const okSize = [12, 13, 14, 16, 18, 24, 32].includes(size); const okWeight = [400, 500, 600].includes(weight); const okFamily = ['Plus Jakarta Sans Variable', 'Geist Mono Variable'].includes(family);
        if (!okSize || !okWeight || !okFamily) bad.push(`${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : ''} ${size}px/${weight}/${family} "${(el.textContent ?? '').trim().slice(0, 30)}"`);
      }
      return { sizes, weights, bad, hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
    });
    const sizeLine = Object.entries(scan.sizes).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}px:${v}`).join(' ');
    tableLines.push(`${theme.padEnd(5)} ${r.name.padEnd(19)} ${sizeLine}  weights ${Object.entries(scan.weights).map(([k, v]) => `${k}:${v}`).join(' ')}`);
    check(`B. ${theme} ${r.name}: every visible text element is one of the 7 sizes, one of the 3 weights, in Plus Jakarta Sans or Geist Mono; no horizontal scroll`, scan.bad.length === 0 && !scan.hscroll && Object.keys(scan.sizes).every((k) => SIZES.has(Number(k))) && Object.keys(scan.weights).every((k) => WEIGHTS.has(Number(k))), scan.bad.slice(0, 6).join(' | ') + (scan.hscroll ? ' hscroll' : ''));
  }
  check(`B2. ${theme}: zero console errors and warnings across the routes`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}
console.log('\nSize counts by route (visible text elements):');
console.log(tableLines.join('\n'));
void FAMILIES;

/* ─── (c) locale independence, in the browser ─── */
const rendered: Record<string, { sentence: string | null; dates: string[] }> = {};
for (const locale of ['en-US', 'de-DE']) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale });
  const page = await context.newPage();
  await page.goto(`${base}/#token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="card-sentence"]');
  const sentence = await page.textContent(`[data-project-id="${slug}"] [data-testid="card-sentence"]`);
  await page.goto(`${base}/runs#token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="run-row"]');
  const dates = await page.$$eval('[data-testid="run-row"] td:last-child', (els) => els.map((e) => e.textContent?.trim() ?? ''));
  rendered[locale] = { sentence, dates };
  await context.close();
}
const expectedDate = formatDate('2026-10-01T12:25:57.000Z');
check(`C5. formatDate renders the same string under a browser locale of en-US and of de-DE, equal to the fixed en-GB string ("${expectedDate}")`, rendered['en-US']!.sentence === rendered['de-DE']!.sentence && JSON.stringify(rendered['en-US']!.dates) === JSON.stringify(rendered['de-DE']!.dates) && (rendered['en-US']!.sentence ?? '').includes(`Verified in the run on ${expectedDate}.`) && rendered['en-US']!.dates.includes(expectedDate), JSON.stringify(rendered));

await browser.close();
killGw();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the dashboard uses one seven-size scale, three weights and two families on every route in both themes, and the formatter renders the same strings under any browser locale.');
