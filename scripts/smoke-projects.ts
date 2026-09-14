/**
 * Locks PR D (projects, findings, coverage, trends) against a real gateway
 * over a fixture output tree:
 *   - a legacy-only project card shows n/a for tests shipped and open
 *     findings with the "N pre-v2 runs, M scenarios explored" sub-line
 *   - the Unassigned card sorts last, is muted, reads "N pre-v2 records with
 *     no URL"
 *   - the project page renders runs, findings, coverage and trends for a
 *     project with 2 reported runs (one SRS) and 3 legacy rows
 *   - a finding seen in two runs is one row with two run references; its
 *     status and notes PATCH persists across a reindex
 *   - a finding never appears in a scenarios table, a stability list, or a
 *     flake number
 *   - a project without SRS runs shows the no-SRS message
 *   - a project with one completed run shows the single point and the
 *     "trend needs two" note; chart point values equal the index rows
 * No model, no live run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { newRunId } from '../src/agent/output-layout.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* ─── fixture ─── */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-projects-'));
const output = path.join(root, 'output');
const step = (url: string) => ({ kind: 'navigate', url });
const finding = { scenario: 'footer social links open', expected: 'a new tab with twitter.com', url: 'https://shop.example/inventory', messages: [] as string[] };
const mk = (url: string, startedAt: string, shipped: number, planned: number, extra: Record<string, unknown> = {}) => ({
  url, language: 'ts', startedAt, finishedAt: new Date(Date.parse(startedAt) + 200_000).toISOString(), steps: 20,
  scenarios: Array.from({ length: shipped }, (_, i) => ({ name: `scenario ${i + 1}`, feature: 'login', category: 'happy', steps: [step(url)] })),
  cascadeStats: {}, cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1.0, plannerUsd: 0.002, criticUsd: 0.009, repairUsd: 0 },
  plan: [...Array.from({ length: shipped }, (_, i) => ({ name: `scenario ${i + 1}`, category: 'happy', rationale: 'r', feature: 'login' })), { name: finding.scenario, category: 'happy', rationale: 'r', feature: 'footer' }],
  replay: { passed: shipped, failed: 0, durationMs: 1, verdicts: Array.from({ length: shipped }, (_, i) => ({ name: `scenario ${i + 1}`, passed: true, durationMs: 1 })) },
  stability: { iterations: 3, passed: shipped, flaked: 0, flakeRate: 0, durationMs: 1, verdicts: Array.from({ length: shipped }, (_, i) => ({ name: `scenario ${i + 1}`, iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 1 })) },
  findings: [finding],
  reconciliation: { planned, generated: shipped, dropped: [], incomplete: [], findings: [{ name: finding.scenario, expected: finding.expected, url: finding.url, messages: [] }], skipped: [], accountedFor: planned, added: 0, balanced: true, stable: shipped, recovered: 0, flaky: 0, broken: 0 },
  ...extra,
});
const r1 = newRunId(new Date('2026-09-10T10:00:00Z'), 'p1');
const r2 = newRunId(new Date('2026-09-12T10:00:00Z'), 'p2');
const q1 = newRunId(new Date('2026-09-11T10:00:00Z'), 'q1');
const writeRun = (slug: string, id: string, rep: Record<string, unknown>, files: Record<string, string> = {}) => {
  const dir = path.join(output, slug, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(rep, null, 2));
  for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), v);
};
// shop.example: two reported runs (the second with SRS coverage), the same finding in both, plus three pre-v2 records.
writeRun('shop-example', r1, mk('https://shop.example/', '2026-09-10T10:00:00.000Z', 3, 4, { cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1.0, plannerUsd: 0.002, criticUsd: 0.009, repairUsd: 0 } }), { 'shop-automation-framework.zip': 'PK' });
writeRun('shop-example', r2, mk('https://shop.example/', '2026-09-12T10:00:00.000Z', 4, 5, {
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1.5, plannerUsd: 0.003, criticUsd: 0.01, repairUsd: 0 },
  stability: { iterations: 3, passed: 4, flaked: 0, flakeRate: 0.25, durationMs: 1, verdicts: Array.from({ length: 4 }, (_, i) => ({ name: `scenario ${i + 1}`, iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'P-P-P', durationMs: 1 })) },
  ruleCoverage: { covered: [{ ruleId: 'R1', scenarios: ['scenario 1'] }, { ruleId: 'R2', scenarios: ['scenario 2'] }], uncovered: [{ ruleId: 'R3', text: 'Lockout after 5 failed logins', reason: 'planned-but-dropped' }, { ruleId: 'R4', text: 'Reset link expires', reason: 'not-planned' }] },
}), { 'requirements-map.json': JSON.stringify({ features: [{ name: 'login', rules: [{ id: 'R1', text: 'Valid login lands on inventory', type: 'behavior' }, { id: 'R2', text: 'Wrong password shows an error', type: 'validation' }, { id: 'R3', text: 'Lockout after 5 failed logins', type: 'validation' }, { id: 'R4', text: 'Reset link expires', type: 'behavior' }] }], roles: [] }), 'shop-automation-framework.zip': 'PK' });
fs.mkdirSync(path.join(root, '.qa-core', 'sites'), { recursive: true });
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'shop.example.json'), JSON.stringify({ host: 'shop.example', recentRuns: [
  { at: '2026-07-01T09:00:00.000Z', url: 'https://shop.example/', scenarios: 2, cost: 0.3, model: 'claude-opus-4-7', durationSec: 100 },
  { at: '2026-07-02T09:00:00.000Z', url: 'https://shop.example/', scenarios: 3, cost: 0.4, model: 'claude-opus-4-7', durationSec: 100 },
  { at: '2026-07-03T09:00:00.000Z', url: 'https://shop.example/', scenarios: 4, cost: 0.5, model: 'claude-opus-4-7', durationSec: 100 },
] }));
// plain.example: one completed run, no SRS, no findings.
writeRun('plain-example', q1, { ...mk('https://plain.example/', '2026-09-11T10:00:00.000Z', 2, 2), findings: [], plan: [{ name: 'scenario 1', category: 'happy', rationale: 'r' }, { name: 'scenario 2', category: 'happy', rationale: 'r' }], reconciliation: { planned: 2, generated: 2, dropped: [], incomplete: [], findings: [], skipped: [], accountedFor: 2, added: 0, balanced: true, stable: 2, recovered: 0, flaky: 0, broken: 0 } });
// demoqa.com: pre-v2 records only.
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'demoqa.com.json'), JSON.stringify({ host: 'demoqa.com', recentRuns: [
  { at: '2026-06-30T15:00:00.000Z', url: 'https://demoqa.com/frames', scenarios: 1, cost: 0.6, model: 'claude-opus-4-7', durationSec: 255 },
  { at: '2026-07-01T15:00:00.000Z', url: 'https://demoqa.com/forms', scenarios: 4, cost: 0.7, model: 'claude-opus-4-7', durationSec: 255 },
] }));
// Unassigned: a record with no URL.
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'unknown.json'), JSON.stringify({ host: 'unknown', recentRuns: [{ at: '2026-06-25T11:00:00.000Z', url: '--', scenarios: 0, cost: 0.02, model: 'claude-opus-4-7', durationSec: 3 }] }));

/* ─── gateway ─── */
const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }
const PORT = 18796;
const TOKEN = 'projects-token';
const gw = spawn('npx', ['tsx', path.join(repo, 'src', 'server', 'gateway.ts')], {
  cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, QA_CORE_GATEWAY_PORT: String(PORT), QA_CORE_GATEWAY_TOKEN: TOKEN, QA_CORE_DASHBOARD_DIST: dist, QA_CORE_LEGACY_UI: path.join(repo, 'qa-core-ui.html'), QA_CORE_DB_PATH: path.join(root, 'data', 'qa-core.sqlite'), ANTHROPIC_API_KEY: 'unused' },
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
check('A. gateway boots on the fixture root', /listening on http/.test(gwLog), gwLog.slice(0, 300));
const base = `http://127.0.0.1:${PORT}`;
const auth = { Authorization: `Bearer ${TOKEN}` };
const get = async <T,>(p: string): Promise<T> => (await fetch(base + p, { headers: auth })).json() as Promise<T>;

/* ─── API ─── */
type Card = { id: string; shipped: number | null; open_findings: number | null; legacy_runs: number; legacy_explored: number; reported_runs: number; spend_month: number; spend_total: number };
const projects = (await get<{ projects: Card[] }>('/api/projects')).projects;
const shop = projects.find((p) => p.id === 'shop-example')!;
const demoqa = projects.find((p) => p.id === 'demoqa-com')!;
const plain = projects.find((p) => p.id === 'plain-example')!;
check('B. a legacy-only project reports shipped and open findings as null (unknown), with its pre-v2 runs and explored count apart', demoqa.shipped === null && demoqa.open_findings === null && demoqa.reported_runs === 0 && demoqa.legacy_runs === 2 && demoqa.legacy_explored === 5 && Math.abs(demoqa.spend_total - 1.3) < 1e-9, JSON.stringify(demoqa));
check('C. the project with reported runs reports numbers: 7 shipped over 2 reported runs, 1 open finding, 3 pre-v2 runs (9 explored)', shop.shipped === 7 && shop.reported_runs === 2 && shop.open_findings === 1 && shop.legacy_runs === 3 && shop.legacy_explored === 9, JSON.stringify(shop));
check('D. Unassigned is last in the API order', projects[projects.length - 1]?.id === 'unassigned', JSON.stringify(projects.map((p) => p.id)));

type Finding = { id: string; project_id: string; scenario: string; expected: string; page_url: string; status: string; notes: string | null; first_seen_run_id: string; last_seen_run_id: string; run_ids: string[]; times_seen: number };
const all = (await get<{ findings: Finding[] }>('/api/findings')).findings;
const f = all.find((x) => x.project_id === 'shop-example')!;
check('E. the finding seen in two runs is ONE row with two run references, first and last seen, times seen 2, status open', all.length === 1 && !!f && f.times_seen === 2 && JSON.stringify([...f.run_ids].sort()) === JSON.stringify([r1, r2].sort()) && f.first_seen_run_id === r1 && f.last_seen_run_id === r2 && f.status === 'open' && f.page_url === finding.url, JSON.stringify(all));
const bad = await fetch(`${base}/api/findings/${encodeURIComponent(f.id)}`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'confirmed' }) });
check('F. PATCH rejects a status outside open / triaged / fixed / wont-fix', bad.status === 400 && /open, triaged, fixed, wont-fix/.test(await bad.text()));
check('F2. PATCH without the token is 401', (await fetch(`${base}/api/findings/${encodeURIComponent(f.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'triaged' }) })).status === 401);
const patched = await (await fetch(`${base}/api/findings/${encodeURIComponent(f.id)}`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'triaged', notes: 'seen by hand; twitter opens in the same tab' }) })).json() as { finding: Finding };
check('G. PATCH sets status and notes and returns the row', patched.finding.status === 'triaged' && patched.finding.notes === 'seen by hand; twitter opens in the same tab');
const reindexed = await (await fetch(`${base}/api/reindex`, { method: 'POST', headers: auth })).json() as { ok: boolean };
const after = (await get<{ findings: Finding[] }>('/api/findings?project_id=shop-example')).findings[0]!;
check('H. status and notes survive a reindex; run references stay two', reindexed.ok && after.status === 'triaged' && after.notes === 'seen by hand; twitter opens in the same tab' && after.times_seen === 2, JSON.stringify(after));
check('H2. the status filter accepts one value or a set', (await get<{ findings: Finding[] }>('/api/findings?status=triaged')).findings.length === 1 && (await get<{ findings: Finding[] }>('/api/findings?status=open,fixed')).findings.length === 0);
check('I. an open or triaged finding counts as open on the project; fixed does not', (await get<{ projects: Card[] }>('/api/projects')).projects.find((p) => p.id === 'shop-example')?.open_findings === 1);

type Cov = { srs_runs: number; rules: Array<{ rule_id: string; latest_status: string; last_covered_run_id: string | null; text: string | null; runs_reported: number; runs_covered: number }>; not_automated: Array<{ rule_id: string; reason: string; text: string | null }> };
const cov = await get<Cov>('/api/projects/shop-example/coverage');
check('J. coverage: every rule id seen across SRS runs with its latest classification, the run that last covered it, and the not-automated list with reasons', cov.srs_runs === 1 && cov.rules.map((r) => r.rule_id).join(',') === 'R1,R2,R3,R4' && cov.rules.find((r) => r.rule_id === 'R1')?.last_covered_run_id === r2 && cov.rules.find((r) => r.rule_id === 'R3')?.latest_status === 'planned_but_dropped' && cov.rules.find((r) => r.rule_id === 'R3')?.last_covered_run_id === null && cov.rules.find((r) => r.rule_id === 'R1')?.text === 'Valid login lands on inventory' && cov.not_automated.map((u) => `${u.rule_id}:${u.reason}`).join(',') === 'R3:planned_but_dropped,R4:not_planned', JSON.stringify(cov));
check('K. a project without SRS runs has zero srs_runs and no rules', (await get<Cov>('/api/projects/plain-example/coverage')).srs_runs === 0);
type Tr = { points: Array<{ run_id: string; shipped: number; cost_total: number; flake_rate: number }>; excluded: { legacy: number; stopped: number; empty: number; failed: number } };
const tr = await get<Tr>('/api/projects/shop-example/trends');
type Row = { id: string; shipped: number; cost_total: number; flake_rate: number; status: string };
const rows = (await get<{ runs: Row[] }>('/api/runs?project_id=shop-example')).runs;
check('L. trends: completed runs in run order, each point equal to its index row; 3 legacy rows excluded', tr.points.length === 2 && tr.points[0]?.run_id === r1 && tr.points[1]?.run_id === r2 && tr.excluded.legacy === 3 && tr.points.every((p) => { const row = rows.find((x) => x.id === p.run_id)!; return row.shipped === p.shipped && row.cost_total === p.cost_total && row.flake_rate === p.flake_rate; }), JSON.stringify(tr));
const legacyRows = rows.filter((r) => r.status === 'legacy');
check('M. a finding is not a scenario, a pass, or a flake: the runs\' stable and flaky counts equal the report\'s reconciliation, and legacy rows carry no findings', rows.filter((r) => r.status !== 'legacy').every((r) => (r as unknown as { findings: number; stable: number; flaky: number }).findings === 1 && (r as unknown as { stable: number }).stable === r.shipped && (r as unknown as { flaky: number }).flaky === 0) && legacyRows.length === 3 && legacyRows.every((r) => (r as unknown as { findings: number }).findings === 0), JSON.stringify(rows.map((r) => ({ id: r.id, s: r.status }))));

/* ─── the pages ─── */
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}/#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="project-card"]');
const cards = await page.$$eval('[data-testid="project-card"]', (els) => els.map((el) => ({
  id: (el as HTMLElement).dataset.projectId, unassigned: (el as HTMLElement).dataset.unassigned ?? null, href: el.getAttribute('href'),
  shipped: el.querySelector('[data-testid="shipped"]')?.textContent ?? null, findings: el.querySelector('[data-testid="open-findings"]')?.textContent ?? null,
  sub: el.querySelector('[data-testid="shipped-sub"]')?.textContent ?? null, spend: el.querySelector('[data-testid="spend-month"]')?.textContent ?? null,
  note: el.querySelector('[data-testid="unassigned-note"]')?.textContent ?? null, opacity: getComputedStyle(el).opacity,
})));
const demoCard = cards.find((c) => c.id === 'demoqa-com')!;
check('N. page: the legacy-only card shows n/a for tests shipped and open findings with the pre-v2 sub-line; spend still shows', demoCard.shipped === 'n/a' && demoCard.findings === 'n/a' && demoCard.sub === '2 pre-v2 runs, 5 scenarios explored' && demoCard.spend !== null, JSON.stringify(demoCard));
const shopCard = cards.find((c) => c.id === 'shop-example')!;
check('O. page: a card with reported runs shows its numbers and its pre-v2 sub-line; cards open the project page', shopCard.shipped === '7' && shopCard.findings === '1' && shopCard.sub === '3 pre-v2 runs, 9 scenarios explored' && shopCard.href === '/projects/shop-example', JSON.stringify(shopCard));
const last = cards[cards.length - 1]!;
check('P. page: Unassigned sorts last, is muted, and reads "N pre-v2 records with no URL"', last.id === 'unassigned' && last.unassigned === 'true' && last.note === '1 pre-v2 record with no URL' && Number(last.opacity) < 1 && last.shipped === null, JSON.stringify(last));

await page.click('[data-testid="project-card"][data-project-id="shop-example"]');
await page.waitForSelector('[data-testid="project-page"][data-project-id="shop-example"]');
await page.waitForSelector('[data-testid="trend-point"]');
const proj = await page.evaluate(() => ({
  name: document.querySelector('[data-testid="project-name"]')?.textContent, url: document.querySelector('[data-testid="project-url"]')?.getAttribute('href'), target: document.querySelector('[data-testid="project-url"]')?.getAttribute('target'), env: !!document.querySelector('[data-testid="env-badge"]'),
  shipped: document.querySelector('[data-testid="project-shipped"]')?.textContent, sub: document.querySelector('[data-testid="project-shipped-sub"]')?.textContent, openFindings: document.querySelector('[data-testid="project-open-findings"]')?.textContent,
  runRows: Array.from(document.querySelectorAll('[data-testid="run-row"]')).map((r) => r.getAttribute('data-run-id')),
  runsText: document.querySelector('[data-testid="project-runs"]')?.textContent ?? '',
  findingRows: Array.from(document.querySelectorAll('[data-testid="finding-row"]')).map((r) => ({ id: r.getAttribute('data-finding-id'), status: r.getAttribute('data-status'), times: r.querySelector('[data-testid="finding-times-seen"]')?.textContent, notes: (r.querySelector('[data-testid="finding-notes"]') as HTMLTextAreaElement | null)?.value, heading: getComputedStyle(document.querySelector('[data-testid="findings-heading"]')!).color })),
  headingText: document.querySelector('[data-testid="findings-heading"]')?.textContent ?? '',
  ruleRows: Array.from(document.querySelectorAll('[data-testid="rule-row"]')).map((r) => ({ id: r.getAttribute('data-rule-id'), status: r.getAttribute('data-status'), last: r.querySelector('[data-testid="rule-last-covered"]')?.textContent })),
  notAutomated: Array.from(document.querySelectorAll('[data-testid="not-automated-row"]')).map((r) => r.textContent ?? ''),
  caption: document.querySelector('[data-testid="trends-caption"]')?.textContent ?? '',
  points: Array.from(document.querySelectorAll('[data-testid="trend-chart"]')).map((c) => ({ metric: c.getAttribute('data-metric'), pts: Array.from(c.querySelectorAll('[data-testid="trend-point"]')).map((p) => ({ run: p.getAttribute('data-run-id'), value: Number(p.getAttribute('data-value')), label: p.getAttribute('data-label') })) })),
  findingColor: getComputedStyle(document.documentElement).getPropertyValue('--finding').trim(),
}));
check('Q. project page: header with name, base URL as a new-tab link, no environment badge when unset; n/a-free numbers with the pre-v2 sub-line', proj.name === 'shop' && proj.url === 'https://shop.example/' && proj.target === '_blank' && !proj.env && proj.shipped === '7' && proj.sub === '3 pre-v2 runs, 9 scenarios explored' && proj.openFindings === '1', JSON.stringify({ name: proj.name, url: proj.url, target: proj.target, shipped: proj.shipped, sub: proj.sub }));
check('R. project page: the runs table lists the 2 reported and 3 legacy runs, and never the finding scenario', proj.runRows.length === 5 && proj.runRows.includes(r1) && proj.runRows.includes(r2) && !/footer social links open/.test(proj.runsText), JSON.stringify(proj.runRows));
check('S. project page: the finding is one row, violet heading "Product behavior to review", seen 2 times, status triaged with its notes', proj.findingRows.length === 1 && proj.findingRows[0]?.status === 'triaged' && proj.findingRows[0]?.times === '2' && proj.findingRows[0]?.notes === 'seen by hand; twitter opens in the same tab' && /^Product behavior to review/.test(proj.headingText), JSON.stringify(proj.findingRows));
check('T. project page: coverage lists R1..R4 with latest classification, last covered run for covered rules, "never" for the rest, and the not-automated list with reasons', proj.ruleRows.map((r) => r.id).join(',') === 'R1,R2,R3,R4' && proj.ruleRows.filter((r) => r.status === 'covered').length === 2 && proj.ruleRows.find((r) => r.id === 'R3')?.last === 'never' && proj.notAutomated.length === 2 && /R3/.test(proj.notAutomated[0] ?? '') && /planned, dropped/.test(proj.notAutomated[0] ?? '') && /R4/.test(proj.notAutomated[1] ?? '') && /not planned/.test(proj.notAutomated[1] ?? ''), JSON.stringify({ rules: proj.ruleRows, na: proj.notAutomated }));
const byMetric: Record<string, Array<{ run: string | null; value: number; label: string | null }>> = Object.fromEntries(proj.points.map((c) => [c.metric ?? '', c.pts]));
const rowOf = (id: string) => rows.find((x) => x.id === id)!;
check('U. project page: three charts with one labeled point per completed run whose values equal the index rows; the caption names the 3 pre-v2 runs not charted', proj.caption === '2 completed runs; 3 pre-v2 runs not charted' && ['shipped', 'cost', 'flake'].every((m) => byMetric[m]?.length === 2) && byMetric.shipped!.every((p) => p.value === rowOf(p.run!).shipped && p.label === String(rowOf(p.run!).shipped)) && byMetric.cost!.every((p) => p.value === rowOf(p.run!).cost_total && p.label === `$${rowOf(p.run!).cost_total.toFixed(4)}`) && byMetric.flake!.every((p) => p.value === rowOf(p.run!).flake_rate && p.label === `${(rowOf(p.run!).flake_rate * 100).toFixed(1)}%`), JSON.stringify({ caption: proj.caption, points: proj.points }));

// Inline edit on the page: change the status, then reload after a reindex.
await page.selectOption('[data-testid="finding-status"]', 'fixed');
await page.waitForFunction(() => document.querySelector('[data-testid="finding-row"]')?.getAttribute('data-status') === 'fixed');
await fetch(`${base}/api/reindex`, { method: 'POST', headers: auth });
// Before reloading, check the header re-read its count after the inline edit (no arithmetic on the page).
check('V0. page: after the inline edit the header re-reads open findings from the API', (await page.textContent('[data-testid="project-open-findings"]')) === '0');
// A full reload with the token in the hash: set the hash (a hash-only goto does not reload), then reload.
await page.goto(`${base}/projects/shop-example#token=${TOKEN}`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="finding-row"]');
const afterEdit = await page.evaluate(() => ({ status: document.querySelector('[data-testid="finding-row"]')?.getAttribute('data-status'), open: document.querySelector('[data-testid="project-open-findings"]')?.textContent }));
check('V. page: the inline status change persists across a reindex and a reload; a fixed finding no longer counts as open', afterEdit.status === 'fixed' && afterEdit.open === '0', JSON.stringify(afterEdit));

// A finding is never a scenario row or a stability row on the run page.
await page.goto(`${base}/runs/${r2}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="scenario-row"]');
const runPage = await page.evaluate(() => ({
  scenarios: Array.from(document.querySelectorAll('[data-testid="scenario-row"]')).map((r) => r.getAttribute('data-scenario')),
  stability: document.querySelector('[data-testid="stability-list"]')?.textContent ?? '',
  replay: document.querySelector('[data-testid="replay-list"]')?.textContent ?? '',
  findings: Array.from(document.querySelectorAll('[data-testid="finding"]')).map((f) => f.textContent ?? ''),
}));
check('W. run page: the finding appears only under "Product behavior to review", never in the scenarios table, the stability list, or the replay list', !runPage.scenarios.includes(finding.scenario) && !runPage.stability.includes(finding.scenario) && !runPage.replay.includes(finding.scenario) && runPage.findings.length === 1 && runPage.findings[0]!.includes(finding.scenario), JSON.stringify(runPage));

// No-SRS message and single-run trend on plain.example.
await page.goto(`${base}/projects/plain-example#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="project-page"]');
const plainPage = await page.evaluate(() => ({ noSrs: document.querySelector('[data-testid="no-srs"]')?.textContent ?? '', caption: document.querySelector('[data-testid="trends-caption"]')?.textContent ?? '', points: document.querySelectorAll('[data-testid="trend-point"]').length, noFindings: !!document.querySelector('[data-testid="no-findings"]') }));
check('X. a project without SRS runs says "No SRS runs. Attach an SRS on the Terminal page to get requirements coverage." instead of an empty table', /^No SRS runs\. Attach an SRS on the Terminal page to get requirements coverage\./.test(plainPage.noSrs) && plain.reported_runs === 1, plainPage.noSrs);
check('Y. a project with one completed run charts the single point and says a trend needs two', plainPage.points === 3 && /1 completed run\. A trend needs two runs; this is the single point\./.test(plainPage.caption) && plainPage.noFindings, JSON.stringify(plainPage));

// Findings and Coverage pages.
await page.goto(`${base}/findings#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="finding-row"]');
const findingsPage = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid="finding-row"]').length, project: document.querySelector('[data-testid="finding-row"] a')?.textContent, heading: document.querySelector('[data-testid="findings-heading"]')?.textContent }));
check('Z. /findings lists the deduped finding with its project under the violet heading', findingsPage.rows === 1 && findingsPage.project === 'shop' && /^Product behavior to review/.test(findingsPage.heading ?? ''), JSON.stringify(findingsPage));
await page.selectOption('[data-testid="filter-status"]', 'open');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="finding-row"]').length === 0);
check('Z2. /findings status filter narrows (the finding is fixed, so "open" shows none)', (await page.$$('[data-testid="finding-row"]')).length === 0 && /status=open/.test(page.url()));
await page.goto(`${base}/coverage#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="coverage-project"]');
const covPage = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="coverage-project"]')).map((s) => ({ id: s.getAttribute('data-project-id'), rules: s.querySelectorAll('[data-testid="rule-row"]').length, noSrs: !!s.querySelector('[data-testid="no-srs"]') })));
check('Z3. /coverage shows the SRS project\'s rules and the no-SRS message for the others; Unassigned is not listed', covPage.find((c) => c.id === 'shop-example')?.rules === 4 && covPage.find((c) => c.id === 'plain-example')?.noSrs === true && covPage.find((c) => c.id === 'demoqa-com')?.noSrs === true && !covPage.some((c) => c.id === 'unassigned'), JSON.stringify(covPage));
check('Z4. zero console errors', errors.filter((e) => !/404|WebSocket/.test(e)).length === 0, errors.join(' | '));

await browser.close();
killGw();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: projects, project page, findings triage, coverage and trends render index rows only; a finding is one deduped row with its run references, never a scenario or a failure.');
