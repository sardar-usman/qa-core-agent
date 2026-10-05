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
import { projectSrsUploadFor, readProjectSrs } from '../src/server/project-srs.js';
import { LOCATOR_EXPECTED_PREFIX as ENGINE_PREFIX, LOCATOR_MESSAGE_PREFIX } from '../src/agent/finding-kind.js';
import { LOCATOR_EXPECTED_PREFIX as UI_PREFIX, elementLookedFor } from '../dashboard/src/lib/finding-kind.js';

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
// A locator finding (invariant 67) on the second run only, in the shape a report before the kind field carried: no kind key, the engine's two prefixes together.
const locatorFinding = { scenario: 'searched for a term that matches no products', expected: `${ENGINE_PREFIX}search input`, url: 'https://shop.example/category/other', messages: [`${LOCATOR_MESSAGE_PREFIX} after 2 attempts (testid=search-query).`] };
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
writeRun('shop-example', r2, mk('https://shop.example/', '2026-09-12T10:00:00.000Z', 4, 6, {
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1.5, plannerUsd: 0.003, criticUsd: 0.01, repairUsd: 0 },
  findings: [finding, locatorFinding],
  plan: [...Array.from({ length: 4 }, (_, i) => ({ name: `scenario ${i + 1}`, category: 'happy', rationale: 'r', feature: 'login' })), { name: finding.scenario, category: 'happy', rationale: 'r', feature: 'footer' }, { name: locatorFinding.scenario, category: 'edge', rationale: 'r', feature: 'search' }],
  reconciliation: { planned: 6, generated: 4, dropped: [], incomplete: [], findings: [{ name: finding.scenario, expected: finding.expected, url: finding.url, messages: [] }, { name: locatorFinding.scenario, expected: locatorFinding.expected, url: locatorFinding.url, messages: locatorFinding.messages }], skipped: [], accountedFor: 6, added: 0, balanced: true, stable: 4, recovered: 0, flaky: 0, broken: 0 },
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
// flaky.example: four completed runs for the trend charts; the third has no stability block, so its index row carries flake_rate null (standing rule 2: never drawn as 0).
const fl = [1, 2, 3, 4].map((n) => newRunId(new Date(`2026-09-0${n}T10:00:00Z`), `f${n}`));
const flakeRates: Array<number | null> = [0, 0.25, null, 0.5];
fl.forEach((id, i) => {
  const rate = flakeRates[i];
  const rep = { ...mk('https://flaky.example/', `2026-09-0${i + 1}T10:00:00.000Z`, 2, 2), findings: [], plan: [{ name: 'scenario 1', category: 'happy', rationale: 'r' }, { name: 'scenario 2', category: 'happy', rationale: 'r' }], reconciliation: { planned: 2, generated: 2, dropped: [], incomplete: [], findings: [], skipped: [], accountedFor: 2, added: 0, balanced: true, stable: 2, recovered: 0, flaky: 0, broken: 0 } } as Record<string, unknown>;
  if (rate === null) delete rep.stability; else rep.stability = { iterations: 3, passed: 2, flaked: 0, flakeRate: rate, durationMs: 1, verdicts: [] };
  writeRun('flaky-example', id, rep);
});
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
check('A. gateway boots on the fixture root', /listening on http/.test(gwLog), gwLog.slice(0, 300));
const base = `http://127.0.0.1:${PORT}`;
const auth = { Authorization: `Bearer ${TOKEN}` };
const get = async <T,>(p: string): Promise<T> => (await fetch(base + p, { headers: auth })).json() as Promise<T>;

/* ─── API ─── */
type Card = { id: string; shipped: number | null; unresolved_findings: number | null; locator_failures: number | null; legacy_runs: number; legacy_explored: number; reported_runs: number; spend_month: number; spend_total: number };
const projects = (await get<{ projects: Card[] }>('/api/projects')).projects;
const shop = projects.find((p) => p.id === 'shop-example')!;
const demoqa = projects.find((p) => p.id === 'demoqa-com')!;
const plain = projects.find((p) => p.id === 'plain-example')!;
check('B. a legacy-only project reports shipped and unresolved findings as null (unknown), with its pre-v2 runs and explored count apart', demoqa.shipped === null && demoqa.unresolved_findings === null && demoqa.reported_runs === 0 && demoqa.legacy_runs === 2 && demoqa.legacy_explored === 5 && Math.abs(demoqa.spend_total - 1.3) < 1e-9, JSON.stringify(demoqa));
check('C. the project with reported runs reports numbers: 7 shipped over 2 reported runs, 1 unresolved finding (the open locator finding is NOT counted), 1 locator failure apart, 3 pre-v2 runs (9 explored)', shop.shipped === 7 && shop.reported_runs === 2 && shop.unresolved_findings === 1 && shop.locator_failures === 1 && shop.legacy_runs === 3 && shop.legacy_explored === 9, JSON.stringify(shop));
check('C2. a legacy-only project reports locator_failures as null (unknown), and the project summary carries the same two counts as the card', demoqa.locator_failures === null && (await get<{ summary: { unresolved_findings: number; locator_failures: number } }>('/api/projects/shop-example')).summary.unresolved_findings === 1 && (await get<{ summary: { unresolved_findings: number; locator_failures: number } }>('/api/projects/shop-example')).summary.locator_failures === 1);
check('D. Unassigned is last in the API order', projects[projects.length - 1]?.id === 'unassigned', JSON.stringify(projects.map((p) => p.id)));

type Finding = { id: string; project_id: string; scenario: string; expected: string; page_url: string; kind: 'product' | 'locator'; status: string; notes: string | null; first_seen_run_id: string; last_seen_run_id: string; run_ids: string[]; times_seen: number };
const all = (await get<{ findings: Finding[] }>('/api/findings')).findings;
const f = all.find((x) => x.project_id === 'shop-example' && x.kind === 'product')!;
const lf = all.find((x) => x.kind === 'locator');
check('E0. GET /api/findings without kind returns both kinds (2 rows): the product finding and the locator finding, each row carrying its kind', all.length === 2 && !!lf && lf.scenario === locatorFinding.scenario && lf.expected === `${ENGINE_PREFIX}search input` && lf.status === 'open' && lf.times_seen === 1 && lf.last_seen_run_id === r2, JSON.stringify(all));
check('E1. ?kind=product and ?kind=locator narrow to one row each; an unknown kind is a 400', (await get<{ findings: Finding[] }>('/api/findings?kind=product')).findings.length === 1 && (await get<{ findings: Finding[] }>('/api/findings?kind=locator')).findings.length === 1 && (await fetch(`${base}/api/findings?kind=bogus`, { headers: auth })).status === 400);
check('E2. the dashboard mirror of the locator prefix equals the engine constant, and elementLookedFor strips it', UI_PREFIX === ENGINE_PREFIX && elementLookedFor(`${ENGINE_PREFIX}search input`) === 'search input' && elementLookedFor('a new tab') === 'a new tab');
check('E. the finding seen in two runs is ONE row with two run references, first and last seen, times seen 2, status open', all.filter((x) => x.kind === 'product').length === 1 && !!f && f.times_seen === 2 && JSON.stringify([...f.run_ids].sort()) === JSON.stringify([r1, r2].sort()) && f.first_seen_run_id === r1 && f.last_seen_run_id === r2 && f.status === 'open' && f.page_url === finding.url, JSON.stringify(all));
const bad = await fetch(`${base}/api/findings/${encodeURIComponent(f.id)}`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'confirmed' }) });
check('F. PATCH rejects a status outside open / triaged / fixed / wont-fix', bad.status === 400 && /open, triaged, fixed, wont-fix/.test(await bad.text()));
check('F2. PATCH without the token is 401', (await fetch(`${base}/api/findings/${encodeURIComponent(f.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'triaged' }) })).status === 401);
const patched = await (await fetch(`${base}/api/findings/${encodeURIComponent(f.id)}`, { method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'triaged', notes: 'seen by hand; twitter opens in the same tab' }) })).json() as { finding: Finding };
check('G. PATCH sets status and notes and returns the row', patched.finding.status === 'triaged' && patched.finding.notes === 'seen by hand; twitter opens in the same tab');
const reindexed = await (await fetch(`${base}/api/reindex`, { method: 'POST', headers: auth })).json() as { ok: boolean };
const after = (await get<{ findings: Finding[] }>('/api/findings?project_id=shop-example')).findings.find((x) => x.kind === 'product')!;
check('H. status and notes survive a reindex; run references stay two', reindexed.ok && after.status === 'triaged' && after.notes === 'seen by hand; twitter opens in the same tab' && after.times_seen === 2, JSON.stringify(after));
check('H2. the status filter accepts one value or a set, and combines with kind (open,fixed holds only the open locator finding; with kind=product, none)', (await get<{ findings: Finding[] }>('/api/findings?status=triaged')).findings.length === 1 && (await get<{ findings: Finding[] }>('/api/findings?status=open,fixed')).findings.every((x) => x.kind === 'locator') && (await get<{ findings: Finding[] }>('/api/findings?status=open,fixed')).findings.length === 1 && (await get<{ findings: Finding[] }>('/api/findings?status=open,fixed&kind=product')).findings.length === 0);
check('I. a triaged finding counts as unresolved on the project (open and triaged count; fixed and wont-fix do not)', (await get<{ projects: Card[] }>('/api/projects')).projects.find((p) => p.id === 'shop-example')?.unresolved_findings === 1);

type Cov = { srs_runs: number; rules: Array<{ rule_id: string; latest_status: string; last_covered_run_id: string | null; text: string | null; runs_reported: number; runs_covered: number }>; not_automated: Array<{ rule_id: string; reason: string; text: string | null }> };
const cov = await get<Cov>('/api/projects/shop-example/coverage');
check('J. coverage: every rule id seen across SRS runs with its latest classification, the run that last covered it, and the not-automated list with reasons', cov.srs_runs === 1 && cov.rules.map((r) => r.rule_id).join(',') === 'R1,R2,R3,R4' && cov.rules.find((r) => r.rule_id === 'R1')?.last_covered_run_id === r2 && cov.rules.find((r) => r.rule_id === 'R3')?.latest_status === 'planned_but_dropped' && cov.rules.find((r) => r.rule_id === 'R3')?.last_covered_run_id === null && cov.rules.find((r) => r.rule_id === 'R1')?.text === 'Valid login lands on inventory' && cov.not_automated.map((u) => `${u.rule_id}:${u.reason}`).join(',') === 'R3:planned_but_dropped,R4:not_planned', JSON.stringify(cov));
check('K. a project without SRS runs has zero srs_runs and no rules', (await get<Cov>('/api/projects/plain-example/coverage')).srs_runs === 0);
// The card's coverage_series carries covered and total beside percent: the same two counts percent is computed from (R1 and R2 covered of R1..R4 in the SRS run), and percent is unchanged.
type CovSeries = { coverage_series: Array<{ run_id: string; covered: number; total: number; percent: number }> };
const shopSeries = (await get<{ projects: Array<Card & CovSeries> }>('/api/projects')).projects.find((p) => p.id === 'shop-example')!.coverage_series;
check('K2. coverage_series carries covered and total equal to the rule_coverage counts of the SRS run (2 of 4) and percent stays 50', shopSeries.length === 1 && shopSeries[0]?.run_id === r2 && shopSeries[0]?.covered === 2 && shopSeries[0]?.total === 4 && shopSeries[0]?.percent === 50 && cov.rules.filter((r) => r.latest_status === 'covered').length === shopSeries[0]?.covered && cov.rules.length === shopSeries[0]?.total, JSON.stringify(shopSeries));
check('K3. a project without SRS runs has an empty coverage_series', ((await get<{ projects: Array<Card & CovSeries> }>('/api/projects')).projects.find((p) => p.id === 'plain-example')!.coverage_series).length === 0);
type Tr = { points: Array<{ run_id: string; shipped: number; cost_total: number; flake_rate: number }>; excluded: { legacy: number; stopped: number; empty: number; failed: number } };
const tr = await get<Tr>('/api/projects/shop-example/trends');
type Row = { id: string; shipped: number; cost_total: number; flake_rate: number; status: string };
const rows = (await get<{ runs: Row[] }>('/api/runs?project_id=shop-example')).runs;
check('L. trends: completed runs in run order, each point equal to its index row; 3 legacy rows excluded', tr.points.length === 2 && tr.points[0]?.run_id === r1 && tr.points[1]?.run_id === r2 && tr.excluded.legacy === 3 && tr.points.every((p) => { const row = rows.find((x) => x.id === p.run_id)!; return row.shipped === p.shipped && row.cost_total === p.cost_total && row.flake_rate === p.flake_rate; }), JSON.stringify(tr));
const legacyRows = rows.filter((r) => r.status === 'legacy');
check('M. a finding is not a scenario, a pass, or a flake: the runs\' stable and flaky counts equal the report\'s reconciliation, the findings column is the whole bucket (1 on the first run, 2 on the second with its locator finding), and legacy rows carry no findings', rows.filter((r) => r.status !== 'legacy').every((r) => (r as unknown as { findings: number; stable: number; flaky: number }).findings === (r.id === r2 ? 2 : 1) && (r as unknown as { stable: number }).stable === r.shipped && (r as unknown as { flaky: number }).flaky === 0) && legacyRows.length === 3 && legacyRows.every((r) => (r as unknown as { findings: number }).findings === 0), JSON.stringify(rows.map((r) => ({ id: r.id, s: r.status }))));

/* ─── projects: create, edit, duplicate host, reindex keeps edits ─── */
const post = async (p: string, body: unknown, method = 'POST') => { const r = await fetch(base + p, { method, headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
const created = await post('/api/projects', { name: 'New Shop', base_url: 'https://newshop.example/some/path', environment: 'staging' });
const createdProject = created.body.project as Record<string, unknown> | undefined;
check('PA. POST /api/projects creates a project whose id follows the host slug rule, base_url is the origin, environment as given', created.status === 201 && createdProject?.id === 'newshop-example' && createdProject?.name === 'New Shop' && createdProject?.base_url === 'https://newshop.example' && createdProject?.environment === 'staging', JSON.stringify(created));
const unset = await post('/api/projects', { name: '', base_url: 'https://www.another.example/' });
check('PB. environment left unset is stored null (never a default); an empty name defaults to the host brand', unset.status === 201 && (unset.body.project as Record<string, unknown>).environment === null && (unset.body.project as Record<string, unknown>).id === 'another-example' && (unset.body.project as Record<string, unknown>).name === 'another', JSON.stringify(unset));
const badUrl = await post('/api/projects', { name: 'x', base_url: 'not a url' });
check('PC. a base_url that does not parse is a 400', badUrl.status === 400 && /base_url/.test(String(badUrl.body.error)));
const dup = await post('/api/projects', { name: 'Shop again', base_url: 'https://shop.example/other' });
check('PD. a host that already has a project is rejected with the existing project linked', dup.status === 409 && (dup.body.existing as Record<string, unknown>)?.id === 'shop-example' && (dup.body.existing as Record<string, unknown>)?.href === '/projects/shop-example' && /already exists/.test(String(dup.body.error)), JSON.stringify(dup));
const badEnv = await post('/api/projects', { name: 'x', base_url: 'https://envtest.example/', environment: 'prod' });
check('PE. an environment outside staging / production / other is a 400', badEnv.status === 400 && /environment must be one of/.test(String(badEnv.body.error)));
const edited = await post('/api/projects/shop-example', { name: 'Shop Renamed', environment: 'production' }, 'PATCH');
check('PF. PATCH edits name and environment', edited.status === 200 && (edited.body.project as Record<string, unknown>).name === 'Shop Renamed' && (edited.body.project as Record<string, unknown>).environment === 'production', JSON.stringify(edited));
const editUrl = await post('/api/projects/shop-example', { base_url: 'https://elsewhere.example/' }, 'PATCH');
check('PG. base_url is identity and cannot be edited', editUrl.status === 400 && /identity/.test(String(editUrl.body.error)));
const envClear = await post('/api/projects/newshop-example', { environment: '' }, 'PATCH');
check('PH. clearing the environment stores null', envClear.status === 200 && (envClear.body.project as Record<string, unknown>).environment === null);
// A run for an unknown host still auto-creates its project as before.
const autoId = newRunId(new Date('2026-09-13T10:00:00Z'), 'auto');
writeRun('autohost-example', autoId, { ...mk('https://autohost.example/', '2026-09-13T10:00:00.000Z', 1, 1), findings: [], plan: [{ name: 'scenario 1', category: 'happy', rationale: 'r' }], reconciliation: { planned: 1, generated: 1, dropped: [], incomplete: [], findings: [], skipped: [], accountedFor: 1, added: 0, balanced: true, stable: 1, recovered: 0, flaky: 0, broken: 0 } });
const reindexAfterCreate = await (await fetch(`${base}/api/reindex`, { method: 'POST', headers: auth })).json() as { result: { runs: number } };
const afterReindex = (await get<{ projects: Array<{ id: string; name: string; environment: string | null }> }>('/api/projects')).projects;
check('PI. a re-index never overwrites a person-set name or environment', afterReindex.find((p) => p.id === 'shop-example')?.name === 'Shop Renamed' && afterReindex.find((p) => p.id === 'shop-example')?.environment === 'production' && afterReindex.find((p) => p.id === 'newshop-example')?.name === 'New Shop', JSON.stringify(afterReindex.map((p) => [p.id, p.name, p.environment])));
check('PJ. the indexer still auto-creates a project for an unknown host, named by brand, environment null', afterReindex.find((p) => p.id === 'autohost-example')?.name === 'autohost' && afterReindex.find((p) => p.id === 'autohost-example')?.environment === null);

/* ─── project-level SRS: storage and versioning ─── */
const srsA = Buffer.from('# SRS v1\nR1 login works').toString('base64');
const srsB = Buffer.from('# SRS v2\nR1 login works\nR2 lockout').toString('base64');
const up1 = await post('/api/projects/shop-example/srs', { name: 'requirements.md', base64: srsA });
type SrsState = { current: { file: string; original_name: string; path: string; uploaded_at: string; size: number } | null; previous: Array<{ file: string; path: string; uploaded_at: string }> };
const s1 = up1.body as unknown as SrsState;
check('SA. uploading a project SRS stores it under output/<slug>/srs/<original name> with its upload time', up1.status === 200 && s1.current?.file === 'requirements.md' && s1.current?.path === 'output/shop-example/srs/requirements.md' && fs.existsSync(path.join(root, s1.current!.path)) && /^\d{4}-\d{2}-\d{2}T/.test(s1.current!.uploaded_at) && s1.previous.length === 0, JSON.stringify(up1));
await new Promise((r) => setTimeout(r, 1100));
const up2 = await post('/api/projects/shop-example/srs', { name: 'requirements.md', base64: srsB });
const s2 = up2.body as unknown as SrsState;
check('SB. replacing it keeps the previous file renamed with its upload time; the new one takes the original name', up2.status === 200 && s2.current?.file === 'requirements.md' && s2.previous.length === 1 && /^requirements\.\d{8}T\d{6}Z\.md$/.test(s2.previous[0]!.file) && fs.readFileSync(path.join(root, s2.previous[0]!.path), 'utf8').startsWith('# SRS v1') && fs.readFileSync(path.join(root, s2.current!.path), 'utf8').startsWith('# SRS v2') && s2.previous[0]!.uploaded_at === s1.current!.uploaded_at, JSON.stringify(s2));
check('SC. GET /api/projects/:id/srs reads the same state from the folder; the card and detail carry the current SRS', JSON.stringify(await get('/api/projects/shop-example/srs')) === JSON.stringify(readProjectSrs(root, 'shop-example')) && (await get<{ projects: Array<{ id: string; srs: { name: string } | null }> }>('/api/projects')).projects.find((p) => p.id === 'shop-example')?.srs?.name === 'requirements.md' && ((await get<{ srs: SrsState }>('/api/projects/shop-example')).srs.previous.length === 1));
const badSrs = await post('/api/projects/shop-example/srs', { name: 'setup.exe', base64: 'TVo=' });
check('SD. the project SRS upload uses the same validator: a .exe is refused naming the four types', badSrs.status === 400 && /Allowed: \.md, \.txt, \.pdf, \.docx\./.test(String(badSrs.body.error)));
const upload = projectSrsUploadFor(root, 'shop-example');
check('SE. the run copy is the current file under its original name (what the gateway saves into a run folder)', upload?.name === 'requirements.md' && upload?.base64 === srsB);
const reindexAfterSrs = await (await fetch(`${base}/api/reindex`, { method: 'POST', headers: auth })).json() as { result: { runs: number } };
check('SF. the srs folder is not a run: re-indexing counts the same runs as before the upload and keeps the SRS state', reindexAfterSrs.result.runs === reindexAfterCreate.result.runs && readProjectSrs(root, 'shop-example').current?.file === 'requirements.md' && (await get<{ projects: Array<{ id: string; srs_path: string | null }> }>('/api/projects')).projects.find((p) => p.id === 'shop-example')?.srs_path === 'output/shop-example/srs/requirements.md', JSON.stringify(reindexAfterSrs));

/* ─── the pages ─── */
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}/#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="project-card"]');
const cards = await page.$$eval('[data-testid="project-card"]', (els) => els.map((el) => ({
  id: (el as HTMLElement).dataset.projectId, unassigned: (el as HTMLElement).dataset.unassigned ?? null, href: el.querySelector('[data-testid="project-card-link"]')?.getAttribute('href') ?? null,
  shipped: el.querySelector('[data-testid="shipped"]')?.textContent ?? null, findings: el.querySelector('[data-testid="unresolved-findings"]')?.textContent ?? null,
  sub: el.querySelector('[data-testid="legacy-note"]')?.getAttribute('data-tip') ?? null, spend: el.querySelector('[data-testid="spend-month"]')?.textContent ?? null,
  spendTip: el.querySelector('[data-testid="spend-month"] [data-tip]')?.getAttribute('data-tip') ?? null,
  note: el.querySelector('[data-testid="unassigned-note"]')?.textContent ?? null, opacity: getComputedStyle(el).opacity, text: el.textContent ?? '',
})));
// PR F part 1 refinement: a legacy-only project is not a card and the page never prints "n/a"; it sits in the earlier-experiments table.
const demoCard = cards.find((c) => c.id === 'demoqa-com') ?? null;
check('N. page: the legacy-only project renders no card and the page has no "n/a" text', demoCard === null && (await page.evaluate(() => (document.body.innerText.match(/\bn\/a\b/g) || []).length)) === 0, JSON.stringify(cards.map((c) => c.id)));
const shopCard = cards.find((c) => c.id === 'shop-example')!;
// PR F part 1, third refinement: the pre-v2 note is the footer info icon's tooltip (no visible sub-line) and the project name is the card's link.
check('O. page: a card with reported runs shows its numbers and carries the pre-v2 note on its footer icon; the name links to the project page', shopCard.shipped === '7' && shopCard.findings === '1' && shopCard.sub === '3 pre-v2 runs, 9 scenarios explored; pre-v2 runs have no verified-test count.' && shopCard.href === '/projects/shop-example', JSON.stringify(shopCard));
// PR F part 1: money on a card is 2 decimals with the exact stored value in the tooltip (dashboard/src/lib/utils.ts exactMoney: float noise beyond 12 significant digits removed).
check('O2. page: the card\'s spend renders to 2 decimals with the exact value in its tooltip, and its tiles read "Verified tests", "To review" and "Spent"', shopCard.spend === `$${shop.spend_month.toFixed(2)}` && /\$\d+\.\d{2}$/.test(shopCard.spend ?? '') && shopCard.spendTip === `exact: $${String(Number(shop.spend_month.toPrecision(12)))}` && /Verified tests/.test(shopCard.text ?? '') && /To review/.test(shopCard.text ?? '') && /Spent/.test(shopCard.text ?? ''), JSON.stringify({ spend: shopCard.spend, tip: shopCard.spendTip, api: shop.spend_month }));
// PR F part 1 refinement: Unassigned, the legacy-only project and the no-run projects are rows of the earlier-experiments table (shown on request), never cards.
check('P. page: Unassigned is not a card; the cards are the projects with a reported run', !cards.some((c) => c.id === 'unassigned') && cards.every((c) => ['shop-example', 'plain-example', 'autohost-example', 'flaky-example'].includes(c.id ?? '')), JSON.stringify(cards.map((c) => c.id)));
const noteLine = await page.evaluate(() => ({ note: document.querySelector('[data-testid="earlier-note"]')?.textContent ?? '', toggle: document.querySelector('[data-testid="earlier-toggle"]')?.textContent ?? '' }));
check('P2. page: one muted line counts the earlier experiments with a Show link', /^4 earlier experiments are hidden\./.test(noteLine.note.trim()) && noteLine.toggle === 'Show', JSON.stringify(noteLine));
await page.click('[data-testid="earlier-toggle"]');
await page.waitForSelector('[data-testid="earlier-table"]');
const earlierRows = await page.$$eval('[data-testid="earlier-row"]', (els) => els.map((el) => ({ id: (el as HTMLElement).dataset.projectId, host: el.querySelector('[data-testid="earlier-host"]')?.textContent, runs: el.querySelector('[data-testid="earlier-runs"]')?.textContent, explored: el.querySelector('[data-testid="earlier-explored"]')?.textContent, label: el.lastElementChild?.textContent })));
const demoRow = earlierRows.find((r) => r.id === 'demoqa-com');
const unassignedRow = earlierRows[earlierRows.length - 1];
check('P3. page: the table lists the legacy-only project (2 runs, 5 explored, "summary only"), the two no-run projects ("no runs", never 0 explored) and Unassigned last with "no URL"', earlierRows.length === 4 && demoRow?.runs === '2' && demoRow?.explored === '5' && demoRow?.label === 'summary only' && earlierRows.filter((r) => r.label === 'no runs').every((r) => r.explored === 'none' && ['newshop-example', 'another-example'].includes(r.id ?? '')) && unassignedRow?.id === 'unassigned' && unassignedRow?.host === 'no URL', JSON.stringify(earlierRows));
await page.click('[data-testid="earlier-toggle"]');
await page.waitForSelector('[data-testid="earlier-table"]', { state: 'detached' });

// A click on the card body (its centre, no icon or link under it) navigates through the name link's stretched overlay; the overlay is the hit target, a descendant of the card.
await page.click('[data-testid="project-card"][data-project-id="shop-example"]');
await page.waitForSelector('[data-testid="project-page"][data-project-id="shop-example"]');
await page.waitForSelector('[data-testid="trend-point"]');
const proj = await page.evaluate(() => ({
  name: document.querySelector('[data-testid="project-name"]')?.textContent, url: document.querySelector('[data-testid="project-url"]')?.getAttribute('href'), target: document.querySelector('[data-testid="project-url"]')?.getAttribute('target'), env: !!document.querySelector('[data-testid="env-badge"]'),
  shipped: document.querySelector('[data-testid="project-shipped"]')?.textContent, sub: document.querySelector('[data-testid="project-legacy-note"]')?.getAttribute('data-tip'), runsTotal: document.querySelector('[data-testid="project-runs-total"]')?.textContent, openFindings: document.querySelector('[data-testid="project-unresolved-findings"]')?.textContent, headerText: document.querySelector('[data-testid="project-page"] > header')?.textContent ?? '', spend: document.querySelector('[data-testid="project-spend-month"]')?.textContent,
  runRows: Array.from(document.querySelectorAll('[data-testid="run-row"]')).map((r) => r.getAttribute('data-run-id')),
  runsText: document.querySelector('[data-testid="project-runs"]')?.textContent ?? '',
  findingRows: Array.from(document.querySelectorAll('[data-testid="finding-row"]')).map((r) => ({ id: r.getAttribute('data-finding-id'), status: r.getAttribute('data-status'), times: r.querySelector('[data-testid="finding-times-seen"]')?.textContent, notes: (r.querySelector('[data-testid="finding-notes"]') as HTMLTextAreaElement | null)?.value, heading: getComputedStyle(document.querySelector('[data-testid="findings-heading"]')!).color })),
  headingText: document.querySelector('[data-testid="findings-heading"]')?.textContent ?? '',
  ruleRows: Array.from(document.querySelectorAll('[data-testid="rule-row"]')).map((r) => ({ id: r.getAttribute('data-rule-id'), status: r.getAttribute('data-status'), label: r.querySelector('[data-testid="rule-status"]')?.textContent, last: r.querySelector('[data-testid="rule-last-covered"]')?.textContent })),
  locator: (() => { const d = document.querySelector('[data-testid="locator-failures"]') as HTMLDetailsElement | null; const h = document.querySelector('[data-testid="locator-failures-heading"]'); return { present: !!d, open: d?.open ?? null, count: document.querySelector('[data-testid="locator-failures-count"]')?.textContent ?? null, color: h ? getComputedStyle(h).color : '', inViolet: !!document.querySelector('[data-testid="findings-table"] [data-testid="locator-failure-row"]'), violetRows: Array.from(document.querySelectorAll('[data-testid="finding-scenario"]')).map((e) => e.textContent) }; })(),
  neutralColor: getComputedStyle(document.documentElement).getPropertyValue('--neutral').trim(),
  notAutomated: Array.from(document.querySelectorAll('[data-testid="not-automated-row"]')).map((r) => ({ text: r.textContent ?? '', href: r.getAttribute('href') })),
  notAutomatedLine: document.querySelector('[data-testid="not-automated"]')?.textContent ?? '',
  ruleFonts: Array.from(document.querySelectorAll('[data-testid="rule-runs-covered"], [data-testid="rule-latest-run"], [data-testid="rule-last-covered"]')).map((el) => getComputedStyle(el).fontFamily),
  trendFonts: Array.from(document.querySelectorAll('[data-testid="trend-point"] text')).map((el) => getComputedStyle(el).fontFamily),
  caption: document.querySelector('[data-testid="trends-caption"]')?.textContent ?? '',
  points: Array.from(document.querySelectorAll('[data-testid="trend-chart"]')).map((c) => ({ metric: c.getAttribute('data-metric'), pts: Array.from(c.querySelectorAll('[data-testid="trend-point"]')).map((p) => ({ run: p.getAttribute('data-run-id'), value: Number(p.getAttribute('data-value')), label: p.getAttribute('data-label') })) })),
  axes: Array.from(document.querySelectorAll('[data-testid="trend-chart"]')).map((c) => ({ metric: c.getAttribute('data-metric'), min: c.getAttribute('data-axis-min'), max: c.getAttribute('data-axis-max') })),
  findingColor: getComputedStyle(document.documentElement).getPropertyValue('--finding').trim(),
}));
// PR F part 1 refinement: the tiles read the same summary fields; the latest run's shipped count headlines, lifetime shipped sits beneath, money is 2 decimals with the exact value in the tooltip.
const latestTile = await page.evaluate(() => ({ latest: document.querySelector('[data-testid="project-latest-shipped"]')?.textContent, spendTip: document.querySelector('[data-testid="project-spend-month"] [data-tip]')?.getAttribute('data-tip'), reported: document.querySelector('[data-testid="project-runs-reported"]')?.textContent, na: (document.body.innerText.match(/\bn\/a\b/g) || []).length }));
check('Q. project page: header with the person-set name, base URL as a new-tab link, the set environment badge; tiles labelled like the card with the latest run\'s shipped count (4), "7 in total across 5 runs" beneath with the pre-v2 note on its icon, "To review", 2-decimal spend with the exact tooltip, runs with a report; no "n/a"', proj.name === 'Shop Renamed' && proj.url === 'https://shop.example/' && proj.target === '_blank' && proj.env === true && latestTile.latest === '4' && proj.shipped === '7' && proj.runsTotal === '5' && proj.sub === '3 pre-v2 runs, 9 scenarios explored; pre-v2 runs have no verified-test count.' && proj.openFindings === '1' && /Verified tests/.test(proj.headerText) && /To review/.test(proj.headerText) && /Spent/.test(proj.headerText) && proj.spend === `$${shop.spend_month.toFixed(2)}` && latestTile.spendTip === `exact: $${String(Number(shop.spend_month.toPrecision(12)))}` && latestTile.reported === '2' && latestTile.na === 0, JSON.stringify({ name: proj.name, url: proj.url, target: proj.target, shipped: proj.shipped, runsTotal: proj.runsTotal, sub: proj.sub, spend: proj.spend, latestTile }));
check('R. project page: the runs table lists the 2 reported and 3 legacy runs, and never the finding scenario', proj.runRows.length === 5 && proj.runRows.includes(r1) && proj.runRows.includes(r2) && !/footer social links open/.test(proj.runsText), JSON.stringify(proj.runRows));
check('S. project page: the finding is one row, violet heading "Product behavior to review", seen 2 times, status triaged with its notes', proj.findingRows.length === 1 && proj.findingRows[0]?.status === 'triaged' && proj.findingRows[0]?.times === '2' && proj.findingRows[0]?.notes === 'seen by hand; twitter opens in the same tab' && /^Product behavior to review/.test(proj.headingText), JSON.stringify(proj.findingRows));
const hsl2rgb = (hsl: string): string => { const [h, s, l] = hsl.split(/\s+/).map((v) => parseFloat(v)) as [number, number, number]; const S = s / 100, L = l / 100; const k = (n: number) => (n + h / 30) % 12; const a = S * Math.min(L, 1 - L); const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))); return `rgb(${[f(0), f(8), f(4)].map((v) => Math.round(v * 255)).join(', ')})`; };
check('S2. project page: the violet section lists the product finding only ("Product behavior to review 1"); the locator finding sits in a separate grey section "Elements the agent could not find 1", collapsed by default, its heading the neutral token', /^Product behavior to review\s*1$/.test(proj.headingText.trim()) && proj.locator.violetRows.length === 1 && proj.locator.violetRows[0] === finding.scenario && !proj.locator.inViolet && proj.locator.present && proj.locator.open === false && proj.locator.count === '1' && proj.locator.color === hsl2rgb(proj.neutralColor) && proj.locator.color !== hsl2rgb(proj.findingColor), JSON.stringify({ heading: proj.headingText, locator: proj.locator, neutral: hsl2rgb(proj.neutralColor), finding: hsl2rgb(proj.findingColor) }));
await page.click('[data-testid="locator-failures-heading"]');
await page.waitForSelector('[data-testid="locator-failure-row"]');
const locatorOpen = await page.evaluate(() => ({
  text: document.querySelector('[data-testid="locator-failures"] p')?.textContent ?? '',
  rows: Array.from(document.querySelectorAll('[data-testid="locator-failure-row"]')).map((r) => ({ scenario: r.querySelector('[data-testid="locator-failure-scenario"]')?.textContent, element: r.querySelector('[data-testid="locator-failure-element"]')?.textContent, url: r.querySelector('[data-testid="locator-failure-url"]')?.textContent, status: !!r.querySelector('select'), notes: !!r.querySelector('textarea') })),
  heads: Array.from(document.querySelectorAll('[data-testid="locator-failures-table"] th')).map((h) => h.textContent?.trim()),
}));
check('S3. project page: opened, the grey section states the limit-of-the-run line and lists scenario, the element looked for (prefix stripped), the page path and seen; read only, no status control and no notes', locatorOpen.text === 'The agent could not locate these elements after retrying. This is a limit of the run, not product behavior, and it is not counted in To review.' && locatorOpen.rows.length === 1 && locatorOpen.rows[0]?.scenario === locatorFinding.scenario && locatorOpen.rows[0]?.element === 'search input' && locatorOpen.rows[0]?.url === '/category/other' && locatorOpen.rows[0]?.status === false && locatorOpen.rows[0]?.notes === false && JSON.stringify(locatorOpen.heads) === JSON.stringify(['Scenario', 'Element looked for', 'Page', 'Seen']), JSON.stringify(locatorOpen));
// PR F part 1, second refinement: the not-automated rules are one line of anchors to their table rows (the reason stays on the row's badge); dates, counts and "x of y" are the UI sans, never mono.
check('T. project page: coverage lists R1..R4 with latest classification, last covered run for covered rules, "never" for the rest, and the "Not automated in the latest run" line anchors R3 and R4 to their rows', proj.ruleRows.map((r) => r.id).join(',') === 'R1,R2,R3,R4' && proj.ruleRows.filter((r) => r.status === 'covered').length === 2 && proj.ruleRows.find((r) => r.id === 'R3')?.last === 'never' && /^Not automated in the latest run: R3, R4$/.test(proj.notAutomatedLine.trim()) && proj.notAutomated.length === 2 && proj.notAutomated[0]?.text === 'R3' && proj.notAutomated[0]?.href === '#rule-R3' && proj.notAutomated[1]?.text === 'R4' && proj.notAutomated[1]?.href === '#rule-R4' && proj.ruleRows.find((r) => r.id === 'R3')?.status === 'planned_but_dropped' && proj.ruleRows.find((r) => r.id === 'R4')?.status === 'not_planned' && proj.ruleRows.find((r) => r.id === 'R4')?.label === 'not planned' && proj.ruleRows.find((r) => r.id === 'R4')?.last === 'never', JSON.stringify({ rules: proj.ruleRows, na: proj.notAutomated, line: proj.notAutomatedLine }));
check('T2. project page: coverage dates, counts and "x of y" and the trend labels use the UI sans (Inter), never Geist and not a mono face', proj.ruleFonts.length > 0 && proj.ruleFonts.every((f) => /Inter/.test(f) && !/Geist/.test(f) && !/Mono/.test(f)) && proj.trendFonts.length > 0 && proj.trendFonts.every((f) => /Inter/.test(f) && !/Geist/.test(f) && !/Mono/.test(f)), JSON.stringify({ rule: proj.ruleFonts.slice(0, 2), trend: proj.trendFonts.slice(0, 2) }));
const byMetric: Record<string, Array<{ run: string | null; value: number; label: string | null }>> = Object.fromEntries(proj.points.map((c) => [c.metric ?? '', c.pts]));
const rowOf = (id: string) => rows.find((x) => x.id === id)!;
check('U0. project page: the shipped and cost axes start at zero and the flake axis spans 0 to 100%; values stay labeled on the points', proj.axes.find((a) => a.metric === 'shipped')?.min === '0' && proj.axes.find((a) => a.metric === 'cost')?.min === '0' && proj.axes.find((a) => a.metric === 'flake')?.min === '0' && proj.axes.find((a) => a.metric === 'flake')?.max === '1' && proj.points.every((c) => c.pts.every((p) => (p.label ?? '').length > 0)), JSON.stringify(proj.axes));
// PR F part 1, second refinement: the cost label is 2 decimals (the exact report value is in the point's tooltip with the run id and date); the points are joined by a line and link to their run.
check('U. project page: three charts with one labeled point per completed run whose values equal the index rows; the caption names the 3 pre-v2 runs not charted', proj.caption === '2 completed runs; 3 pre-v2 runs not charted' && ['shipped', 'cost', 'flake'].every((m) => byMetric[m]?.length === 2) && byMetric.shipped!.every((p) => p.value === rowOf(p.run!).shipped && p.label === String(rowOf(p.run!).shipped)) && byMetric.cost!.every((p) => p.value === rowOf(p.run!).cost_total && p.label === `$${rowOf(p.run!).cost_total.toFixed(2)}`) && byMetric.flake!.every((p) => p.value === rowOf(p.run!).flake_rate && p.label === `${(rowOf(p.run!).flake_rate * 100).toFixed(1)}%`), JSON.stringify({ caption: proj.caption, points: proj.points }));
const trendTips = await page.$$eval('[data-testid="trend-chart"][data-metric="cost"] [data-testid="trend-point"]', (els) => els.map((el) => ({ run: el.getAttribute('data-run-id'), tip: el.getAttribute('data-tip'), href: el.getAttribute('href') })));
check('U2. project page: each cost point links to its run and its tooltip carries the full run id, the date and the exact report value; the points are joined by a line', trendTips.length === 2 && trendTips.every((t) => t.href === `/runs/${t.run}` && (t.tip ?? '').startsWith(`${t.run}, `) && (t.tip ?? '').endsWith(`exact: $${String(Number(rowOf(t.run!).cost_total.toPrecision(12)))}`)) && (await page.$$('[data-testid="trend-chart"][data-metric="cost"] [data-testid="trend-line"]')).length === 1, JSON.stringify(trendTips));

// Inline edit on the page: change the status, then reload after a reindex.
await page.selectOption('[data-testid="finding-status"]', 'fixed');
await page.waitForFunction(() => document.querySelector('[data-testid="finding-row"]')?.getAttribute('data-status') === 'fixed');
await fetch(`${base}/api/reindex`, { method: 'POST', headers: auth });
// Before reloading, check the header re-read its count after the inline edit (no arithmetic on the page).
check('V0. page: after the inline edit the header re-reads unresolved findings from the API', (await page.textContent('[data-testid="project-unresolved-findings"]')) === '0');
// A full reload with the token in the hash: set the hash (a hash-only goto does not reload), then reload.
await page.goto(`${base}/projects/shop-example#token=${TOKEN}`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="finding-row"]');
const afterEdit = await page.evaluate(() => ({ status: document.querySelector('[data-testid="finding-row"]')?.getAttribute('data-status'), open: document.querySelector('[data-testid="project-unresolved-findings"]')?.textContent }));
check('V. page: the inline status change persists across a reindex and a reload; a fixed finding does not count as unresolved, and the still-open locator finding never did', afterEdit.status === 'fixed' && afterEdit.open === '0' && (await get<{ findings: Finding[] }>('/api/findings?kind=locator&status=open')).findings.length === 1, JSON.stringify(afterEdit));

// A finding is never a scenario row or a stability row on the run page.
await page.goto(`${base}/runs/${r2}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="scenario-row"]');
const runPage = await page.evaluate(() => ({
  scenarios: Array.from(document.querySelectorAll('[data-testid="scenario-row"]')).map((r) => r.getAttribute('data-scenario')),
  stability: document.querySelector('[data-testid="stability-list"]')?.textContent ?? '',
  replay: document.querySelector('[data-testid="replay-list"]')?.textContent ?? '',
  findings: Array.from(document.querySelectorAll('[data-testid="finding"]')).map((f) => f.textContent ?? ''),
  locator: Array.from(document.querySelectorAll('[data-testid="locator-failure"]')).map((f) => f.textContent ?? ''), locatorCount: document.querySelector('[data-testid="locator-failures-count"]')?.textContent ?? '', funnelKinds: document.querySelector('[data-testid="funnel-findings-kinds"]')?.textContent ?? '',
}));
check('W2. run page: the locator finding is listed only under "Elements the agent could not find (1)", never as a product finding, and the funnel row reads "2 (1 product behavior, 1 element not found)"', runPage.locator.length === 1 && runPage.locator[0]!.includes(locatorFinding.scenario) && !runPage.findings.some((t) => t.includes(locatorFinding.scenario)) && runPage.locatorCount === '1' && runPage.funnelKinds === '2 (1 product behavior, 1 element not found)', JSON.stringify({ locator: runPage.locator, count: runPage.locatorCount, funnel: runPage.funnelKinds }));
check('W. run page: the finding appears only under "Product behavior to review", never in the scenarios table, the stability list, or the replay list', !runPage.scenarios.includes(finding.scenario) && !runPage.stability.includes(finding.scenario) && !runPage.replay.includes(finding.scenario) && runPage.findings.length === 1 && runPage.findings[0]!.includes(finding.scenario), JSON.stringify(runPage));

// The null flake rate on flaky.example: no point, the line breaks around it, the caption counts it, the placeholder's tooltip says so.
type FlTr = { points: Array<{ run_id: string; shipped: number | null; flake_rate: number | null }> };
const flTr = await get<FlTr>('/api/projects/flaky-example/trends');
check('TN0. trends API: the run without a stability block carries flake_rate null on its index row (never 0)', flTr.points.length === 4 && flTr.points[2]?.run_id === fl[2] && flTr.points[2]?.flake_rate === null && flTr.points[1]?.flake_rate === 0.25 && flTr.points[3]?.flake_rate === 0.5, JSON.stringify(flTr));
await page.goto(`${base}/projects/flaky-example#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="trend-point"]');
// No const arrow inside the evaluate body: tsx's __name helper does not travel into the browser.
const flPage = await page.evaluate(() => ({
  caption: document.querySelector('[data-testid="trends-caption"]')?.textContent ?? '',
  flakePoints: Array.from(document.querySelectorAll('[data-testid="trend-chart"][data-metric="flake"] [data-testid="trend-point"]')).map((p) => ({ run: p.getAttribute('data-run-id'), value: p.getAttribute('data-value'), label: p.getAttribute('data-label') })),
  flakeMissing: Array.from(document.querySelectorAll('[data-testid="trend-chart"][data-metric="flake"] [data-testid="trend-missing"]')).map((p) => ({ run: p.getAttribute('data-run-id'), label: p.getAttribute('data-label'), tip: p.getAttribute('data-tip'), circle: !!p.querySelector('circle') })),
  flakeLines: Array.from(document.querySelectorAll('[data-testid="trend-chart"][data-metric="flake"] [data-testid="trend-line"]')).map((l) => ({ points: l.getAttribute('data-points'), coords: (l.getAttribute('points') ?? '').split(' ').length })),
  shippedLines: Array.from(document.querySelectorAll('[data-testid="trend-chart"][data-metric="shipped"] [data-testid="trend-line"]')).map((l) => ({ points: l.getAttribute('data-points'), coords: (l.getAttribute('points') ?? '').split(' ').length })),
  shippedPoints: document.querySelectorAll('[data-testid="trend-chart"][data-metric="shipped"] [data-testid="trend-point"]').length,
  costPoints: document.querySelectorAll('[data-testid="trend-chart"][data-metric="cost"] [data-testid="trend-point"]').length,
  zeroDrawn: Array.from(document.querySelectorAll('[data-testid="trend-chart"][data-metric="flake"] [data-testid="trend-point"]')).some((p) => p.getAttribute('data-run-id') === document.querySelector('[data-testid="trend-missing"]')?.getAttribute('data-run-id')),
}));
check('TN. page: the flake chart draws 3 points for the 4 runs, no point and no 0% for the run with no flake rate, and the one line joins only the two consecutive recorded runs (it never passes through the gap); shipped and cost keep 4 points and a 4-point line', flPage.flakePoints.length === 3 && flPage.flakePoints.every((p) => p.run !== fl[2]) && !flPage.zeroDrawn && flPage.flakeLines.length === 1 && flPage.flakeLines[0]?.points === '2' && flPage.flakeLines[0]?.coords === 2 && flPage.shippedPoints === 4 && flPage.costPoints === 4 && flPage.shippedLines.length === 1 && flPage.shippedLines[0]?.coords === 4, JSON.stringify(flPage));
check('TN2. page: the caption reads "4 completed runs; 1 run with no flake rate recorded" and the placeholder at the run\'s position is labeled "not recorded" with the tooltip "no flake rate recorded on this report", never a guessed cause', flPage.caption === '4 completed runs; 1 run with no flake rate recorded' && flPage.flakeMissing.length === 1 && flPage.flakeMissing[0]?.run === fl[2] && flPage.flakeMissing[0]?.label === 'not recorded' && !flPage.flakeMissing[0]?.circle && (flPage.flakeMissing[0]?.tip ?? '').endsWith('no flake rate recorded on this report') && !/stability did not run/.test(flPage.flakeMissing[0]?.tip ?? ''), JSON.stringify({ caption: flPage.caption, missing: flPage.flakeMissing }));

// No-SRS message and single-run trend on plain.example.
await page.goto(`${base}/projects/plain-example#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="project-page"]');
const plainPage = await page.evaluate(() => ({ noSrs: document.querySelector('[data-testid="no-srs"]')?.textContent ?? '', caption: document.querySelector('[data-testid="trends-caption"]')?.textContent ?? '', points: document.querySelectorAll('[data-testid="trend-point"]').length, noFindings: !!document.querySelector('[data-testid="no-findings"]') }));
check('X. a project without SRS runs says "No SRS runs. Attach an SRS on the Terminal page to get requirements coverage." instead of an empty table', /^No SRS runs\. Attach an SRS on the Terminal page to get requirements coverage\./.test(plainPage.noSrs) && plain.reported_runs === 1, plainPage.noSrs);
check('Y. a project with one completed run charts the single point and says a trend needs two', plainPage.points === 3 && /1 completed run\. A trend needs two runs; this is the single point\./.test(plainPage.caption) && plainPage.noFindings, JSON.stringify(plainPage));

// Project page: edit form and the requirements document section.
await page.goto(`${base}/projects/shop-example#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="project-srs-current"]');
const srsSection = await page.evaluate(() => ({ current: document.querySelector('[data-testid="project-srs-current"]')?.textContent ?? '', previous: document.querySelectorAll('[data-testid="project-srs-previous-row"]').length, name: document.querySelector('[data-testid="project-name"]')?.textContent, env: document.querySelector('[data-testid="env-badge"]')?.textContent ?? null, url: document.querySelector('[data-testid="project-url"]')?.textContent }));
check('PP. project page: the person-set name and environment render; the requirements document shows the current file and one previous upload', srsSection.name === 'Shop Renamed' && srsSection.env === 'production' && /requirements\.md/.test(srsSection.current) && srsSection.previous === 1, JSON.stringify(srsSection));
await page.click('[data-testid="edit-project"]');
await page.fill('[data-testid="edit-project-name"]', 'Shop Final');
await page.selectOption('[data-testid="edit-project-env"]', '');
await page.click('[data-testid="edit-project-save"]');
await page.waitForFunction(() => document.querySelector('[data-testid="project-name"]')?.textContent === 'Shop Final');
check('PQ. project page: inline edit saves name and clears the environment (no badge); base URL stays read-only', (await page.textContent('[data-testid="project-name"]')) === 'Shop Final' && !(await page.$('[data-testid="env-badge"]')) && !(await page.$('[data-testid="edit-project-form"]')) && (await get<{ project: { environment: string | null; base_url: string } }>('/api/projects/shop-example')).project.environment === null && (await get<{ project: { base_url: string } }>('/api/projects/shop-example')).project.base_url === 'https://shop.example/');
// Terminal: the project SRS is the default for a URL on this host, the per-run attach overrides it.
await page.goto(`${base}/terminal#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="composer"]');
await page.fill('[data-testid="f-url"]', 'https://shop.example/login');
await page.waitForSelector('[data-testid="project-srs-option"]');
const srsOption = await page.evaluate(() => ({ text: document.querySelector('[data-testid="project-srs-option"]')?.textContent ?? '', checked: (document.querySelector('[data-testid="use-project-srs"]') as HTMLInputElement).checked }));
check('PR. Terminal: a URL on a host with a project SRS offers "use project SRS (<name>, uploaded <date>)" checked by default', /use project SRS \(requirements\.md, uploaded /.test(srsOption.text) && srsOption.checked, JSON.stringify(srsOption));
await page.fill('[data-testid="f-url"]', 'https://plain.example/');
await page.waitForFunction(() => !document.querySelector('[data-testid="project-srs-option"]'));
check('PS. Terminal: a host without a project SRS offers nothing', !(await page.$('[data-testid="project-srs-option"]')));
await page.fill('[data-testid="f-url"]', 'https://shop.example/');
await page.waitForSelector('[data-testid="project-srs-option"]');
const attach = path.join(root, 'attach.md'); fs.writeFileSync(attach, '# per-run');
await page.setInputFiles('[data-testid="f-srs"]', attach);
await page.waitForSelector('[data-testid="project-srs-overridden"]');
check('PT. Terminal: a per-run attach overrides the project SRS and says so', /overrides the project SRS \(requirements\.md\)/.test((await page.textContent('[data-testid="project-srs-overridden"]')) ?? ''));

// Findings and Coverage pages.
await page.goto(`${base}/findings#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="finding-row"]');
const findingsPage = await page.evaluate(() => ({ rows: document.querySelectorAll('[data-testid="finding-row"]').length, project: document.querySelector('[data-testid="finding-row"] a')?.textContent, heading: document.querySelector('[data-testid="findings-heading"]')?.textContent }));
check('Z. /findings lists the deduped finding with its project under the violet heading', findingsPage.rows === 1 && findingsPage.project === 'Shop Final' && /^Product behavior to review/.test(findingsPage.heading ?? ''), JSON.stringify(findingsPage));
const toggleBefore = await page.evaluate(() => ({ text: document.querySelector('[data-testid="locator-toggle"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '', expanded: document.querySelector('[data-testid="locator-toggle"]')?.getAttribute('aria-expanded'), rows: document.querySelectorAll('[data-testid="locator-failure-row"]').length }));
await page.click('[data-testid="locator-toggle"]');
await page.waitForSelector('[data-testid="locator-failure-row"]');
const toggleAfter = await page.evaluate(() => ({ text: document.querySelector('[data-testid="locator-toggle"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '', rows: document.querySelectorAll('[data-testid="locator-failure-row"]').length, project: document.querySelector('[data-testid="locator-failure-row"] a')?.textContent ?? null, violetRows: document.querySelectorAll('[data-testid="finding-row"]').length }));
check('Z1. /findings shows product findings by default with "Show elements not found (1)"; the toggle reveals the one locator row with its project and leaves the violet rows unchanged', toggleBefore.text === 'Show elements not found (1)' && toggleBefore.expanded === 'false' && toggleBefore.rows === 0 && toggleAfter.text === 'Hide elements not found (1)' && toggleAfter.rows === 1 && toggleAfter.project === 'Shop Final' && toggleAfter.violetRows === 1, JSON.stringify({ toggleBefore, toggleAfter }));
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
