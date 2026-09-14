/**
 * Locks the Run Detail endpoint and page (dashboard v2 plan, PR B):
 *   - a seeded v2 run (3 scenarios: pass shipped, rework repaired and shipped,
 *     reject dropped; 1 finding; events.jsonl) returns exactly those verdicts,
 *     shipped 2 as stored, findings length 1, artifacts present on disk only
 *   - the finding is never a scenario row
 *   - a run id that does not exist is a 404 whose message names the path
 *   - an indexed run whose run-report vanished is a 404 naming that path
 *   - a legacy record returns legacy: true, summary fields, no scenarios key
 *   - artifacts are served only from the run's own directory
 *   - the rendered page shows the finding under "Product behavior to review"
 *     and not in the scenarios table, the verdict badges, "No findings
 *     recorded" for a run without findings, the legacy notice, the back link
 * The API section runs on an ephemeral http server; the page section boots a
 * real gateway on a spare port with the built dashboard. No model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { openDatabase } from '../src/server/db/migrate.js';
import { indexOutput } from '../src/server/db/indexer.js';
import { createApiHandler } from '../src/server/api.js';
import { buildRunDetail } from '../src/server/run-detail.js';
import { newRunId } from '../src/agent/output-layout.js';
import { appendRunEvent } from '../src/server/events.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* ─── fixture: one v2 run, one run without findings, one legacy record ─── */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-detail-'));
const output = path.join(root, 'output');
const runId = newRunId(new Date('2026-09-14T10:00:00Z'), 'detail');
const runDir = path.join(output, 'saucedemo-com', runId);
fs.mkdirSync(runDir, { recursive: true });
const step = (url: string) => ({ kind: 'navigate', url });
const report = {
  url: 'https://www.saucedemo.com/', language: 'ts', startedAt: '2026-09-14T10:00:00.000Z', finishedAt: '2026-09-14T10:04:14.000Z', steps: 31,
  // Emitted (shipped): the pass and the repaired rework. The reject and the finding are not here.
  scenarios: [
    { name: 'login succeeds with valid credentials', feature: 'login', category: 'happy', steps: [step('https://www.saucedemo.com/')] },
    { name: 'add to cart updates the badge', feature: 'cart', category: 'happy', steps: [step('https://www.saucedemo.com/')] },
  ],
  cascadeStats: {}, cost: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1.4, plannerUsd: 0.0021, criticUsd: 0.0093, repairUsd: 0.31 },
  plan: [
    { name: 'login succeeds with valid credentials', category: 'happy', rationale: 'r', feature: 'login' },
    { name: 'add to cart updates the badge', category: 'happy', rationale: 'r', feature: 'cart' },
    { name: 'sort by price low to high', category: 'happy', rationale: 'r', feature: 'cart' },
    { name: 'footer social links open', category: 'happy', rationale: 'r', feature: 'footer' },
  ],
  // Verdict names carry the "N. [category] " prefix the live Critic echoes back,
  // and two are small rephrasings of the plan names. The fourth matches no
  // scenario at all: it must surface as an unmatched verdict, never as a row.
  review: {
    verdicts: [
      { scenario: '1. [happy] login succeeds with valid credentials', verdict: 'pass', reasons: ['asserts the inventory page'], required_fixes: [] },
      { scenario: '2. [happy] add to cart updates the badge count', verdict: 'pass', reasons: ['captures the badge count before and after'], required_fixes: [] },
      { scenario: '3. [happy] sort by price low to high ascending', verdict: 'reject', reasons: ['compares the first cell to itself'], required_fixes: ['capture before sorting'] },
      { scenario: '5. [negative] checkout with an empty cart shows an error', verdict: 'rework', reasons: ['no such scenario was planned'], required_fixes: [] },
    ],
    summary: 'Two scenarios ship; one was repaired.',
    repair: [
      { scenario: '[happy] add to cart updates the badge', first: 'rework', second: 'pass', outcome: 'kept' },
      { scenario: 'sort by price low to high', first: 'rework', second: 'reject', outcome: 'dropped' },
    ],
  },
  replay: { passed: 2, failed: 0, durationMs: 5000, verdicts: [
    { name: 'login succeeds with valid credentials', passed: true, durationMs: 2000 },
    { name: 'add to cart updates the badge', passed: true, durationMs: 2500 },
  ] },
  stability: { iterations: 3, passed: 2, flaked: 0, flakeRate: 0, durationMs: 9000, recovered: 1, stabilizerCostUsd: 0.004, verdicts: [
    { name: 'login succeeds with valid credentials', iterations: 3, passes: 3, stable: true, classification: 'stable', pattern: 'PPP', durationMs: 4000 },
    { name: 'add to cart updates the badge', iterations: 3, passes: 2, stable: true, classification: 'stable', pattern: 'PFP', relaxed: true, durationMs: 5000 },
  ] },
  findings: [{ scenario: 'footer social links open', category: 'happy', expected: 'a new tab with twitter.com', url: 'https://www.saucedemo.com/inventory.html', messages: [] }],
  reconciliation: {
    planned: 4, generated: 2, dropped: [{ name: 'sort by price low to high', stage: 'critic', reason: 'rework -> reject' }], incomplete: [],
    findings: [{ name: 'footer social links open', expected: 'a new tab with twitter.com', url: 'https://www.saucedemo.com/inventory.html', messages: [] }], skipped: [],
    accountedFor: 4, added: 0, balanced: true, stable: 1, recovered: 1, flaky: 0, broken: 0,
  },
  ruleCoverage: { covered: [{ ruleId: 'R1', scenarios: ['login succeeds with valid credentials'] }], uncovered: [] },
};
fs.writeFileSync(path.join(runDir, 'run-report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(runDir, 'saucedemo-automation-framework.zip'), 'PKzip');
fs.writeFileSync(path.join(runDir, 'rule-coverage.json'), JSON.stringify(report.ruleCoverage));
fs.writeFileSync(path.join(runDir, 'landing.png'), 'not really a png');
fs.writeFileSync(path.join(runDir, 'run-meta.json'), JSON.stringify({ source: 'dashboard', flags: {}, writtenAt: 'x' }));
appendRunEvent(runDir, { type: 'plan_started' }, new Date('2026-09-14T10:00:05Z'));
appendRunEvent(runDir, { type: 'plan_done', scenarios: report.plan as never, usd: 0.0021 }, new Date('2026-09-14T10:00:09Z'));
appendRunEvent(runDir, { type: 'thinking_started' }, new Date('2026-09-14T10:00:10Z'));
appendRunEvent(runDir, { type: 'tool_call', name: 'begin_scenario', input: { name: 'login succeeds with valid credentials' } }, new Date('2026-09-14T10:00:11Z'));
appendRunEvent(runDir, { type: 'critic_done', verdicts: report.review.verdicts as never, usd: 0.0093 }, new Date('2026-09-14T10:03:00Z'));
appendRunEvent(runDir, { type: 'done', scenarios: 2 }, new Date('2026-09-14T10:04:14Z'));
// A second run with no findings.
const quietId = newRunId(new Date('2026-09-13T10:00:00Z'), 'quiet');
const quietDir = path.join(output, 'saucedemo-com', quietId);
fs.mkdirSync(quietDir, { recursive: true });
fs.writeFileSync(path.join(quietDir, 'run-report.json'), JSON.stringify({ ...report, startedAt: '2026-09-13T10:00:00.000Z', finishedAt: '2026-09-13T10:02:00.000Z', findings: [], plan: report.plan.slice(0, 3), reconciliation: { ...report.reconciliation, planned: 3, findings: [] } }));
// A run with an events.jsonl that exists but holds nothing.
const emptyId = newRunId(new Date('2026-09-11T10:00:00Z'), 'empty0');
const emptyDir = path.join(output, 'saucedemo-com', emptyId);
fs.mkdirSync(emptyDir, { recursive: true });
fs.writeFileSync(path.join(emptyDir, 'run-report.json'), JSON.stringify({ ...report, startedAt: '2026-09-11T10:00:00.000Z', finishedAt: '2026-09-11T10:02:00.000Z' }));
fs.writeFileSync(path.join(emptyDir, 'events.jsonl'), '');
// A run whose report vanishes after indexing.
const goneId = newRunId(new Date('2026-09-12T10:00:00Z'), 'gone');
fs.mkdirSync(path.join(output, 'saucedemo-com', goneId), { recursive: true });
fs.writeFileSync(path.join(output, 'saucedemo-com', goneId, 'run-report.json'), JSON.stringify({ ...report, findings: [] }));
// A legacy record.
fs.mkdirSync(path.join(root, '.qa-core', 'sites'), { recursive: true });
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'demoqa.com.json'), JSON.stringify({ host: 'demoqa.com', recentRuns: [{ at: '2026-06-30T15:53:33.479Z', url: 'https://demoqa.com/frames', scenarios: 1, cost: 0.627841, model: 'claude-opus-4-7', durationSec: 255 }] }));
fs.writeFileSync(path.join(root, 'secret.txt'), 'nope');

/* ─── endpoint ─── */
const db = openDatabase(path.join(root, 'data', 'qa-core.sqlite'));
indexOutput(db, root);
fs.rmSync(path.join(output, 'saucedemo-com', goneId, 'run-report.json'));

const d = buildRunDetail(db, root, runId);
check('A. the seeded run resolves with status 200 and legacy: false', d.status === 200 && d.body.legacy === false);
if (d.status === 200 && d.body.legacy === false) {
  const b = d.body;
  const byName = new Map(b.scenarios.map((s) => [s.name, s]));
  check('B. exactly the three planned scenarios are rows; the finding is not one', b.scenarios.length === 3 && !byName.has('footer social links open'), JSON.stringify(b.scenarios.map((s) => s.name)));
  check('C. verdicts attach through the tolerant matcher (prefix stripped, rephrasing tolerated): pass / pass / reject, none null', byName.get('login succeeds with valid credentials')?.verdict === 'pass' && byName.get('add to cart updates the badge')?.verdict === 'pass' && byName.get('sort by price low to high')?.verdict === 'reject' && b.scenarios.every((s) => s.verdict !== null), JSON.stringify(b.scenarios.map((s) => [s.name, s.verdict])));
  check('C2. the verdict that matches no scenario lands in unmatched_verdicts and is never a scenario row', b.unmatched_verdicts.length === 1 && b.unmatched_verdicts[0]?.scenario === '5. [negative] checkout with an empty cart shows an error' && b.unmatched_verdicts[0]?.verdict === 'rework' && !b.scenarios.some((s) => /checkout/.test(s.name)) && !b.scenarios.some((s) => s.replay === null && s.shipped === false && s.verdict === null), JSON.stringify(b.unmatched_verdicts));
  check('D. repair status: none / repaired (rework -> pass, kept) / failed (rework -> reject, dropped)', byName.get('login succeeds with valid credentials')?.repair === 'none' && byName.get('add to cart updates the badge')?.repair === 'repaired' && byName.get('sort by price low to high')?.repair === 'failed' && byName.get('sort by price low to high')?.repair_second === 'reject');
  check('E. shipped yes/no is the emitted list: 2 shipped, the reject not', byName.get('login succeeds with valid credentials')?.shipped === true && byName.get('add to cart updates the badge')?.shipped === true && byName.get('sort by price low to high')?.shipped === false && b.counts.shipped === 2);
  check('F. replay and stability are the recorded outcomes, per-attempt pattern included', byName.get('add to cart updates the badge')?.replay === 'pass' && byName.get('add to cart updates the badge')?.stability?.passes === 2 && byName.get('add to cart updates the badge')?.stability?.iterations === 3 && byName.get('add to cart updates the badge')?.stability?.pattern === 'PFP' && byName.get('add to cart updates the badge')?.stability?.recovered === true && byName.get('sort by price low to high')?.replay === null && byName.get('sort by price low to high')?.stability === null);
  check('G. the reject carries where it was dropped, from the reconciliation', byName.get('sort by price low to high')?.dropped_at === 'critic' && byName.get('sort by price low to high')?.dropped_reason === 'rework -> reject');
  check('H. findings length 1 with expected, url and messages as stored', b.findings.length === 1 && b.findings[0]?.scenario === 'footer social links open' && b.findings[0]?.expected === 'a new tab with twitter.com' && b.counts.findings === 1);
  check('I. header: host, run id, timing, status, cost split from the index row, stabilizer cost from the report', b.header.host === 'saucedemo.com' && b.header.run_id === runId && b.header.started_at === report.startedAt && b.header.ended_at === report.finishedAt && b.header.status === 'completed' && Math.abs(b.header.cost.total - 1.4154) < 1e-9 && Math.abs(b.header.cost.repair - 0.31) < 1e-9 && b.header.cost.stabilizer === 0.004 && b.header.environment === null, JSON.stringify(b.header));
  check('I2. the cost total is the sum of every line shown: explorer (usd) + planner + critic + stabilizer', Math.abs(b.header.cost.total - (report.cost.usd + report.cost.plannerUsd + report.cost.criticUsd + report.stability.stabilizerCostUsd)) < 1e-9 && Math.abs(b.header.cost.total - (b.header.cost.explorer + b.header.cost.repair + b.header.cost.planner + b.header.cost.critic + (b.header.cost.stabilizer ?? 0))) < 1e-9, JSON.stringify(b.header.cost));
  const kinds = b.artifacts.map((a) => `${a.kind}:${a.name}`).sort();
  check('J. artifacts list exactly the files on disk, with kinds and API hrefs', JSON.stringify(kinds) === JSON.stringify(['events:events.jsonl', 'meta:run-meta.json', 'report:run-report.json', 'rule-coverage:rule-coverage.json', 'screenshot:landing.png', 'zip:saucedemo-automation-framework.zip'].sort()) && b.artifacts.every((a) => a.href === `/api/runs/${runId}/artifacts/${encodeURIComponent(a.name)}` && a.size > 0), JSON.stringify(kinds));
  check('K. events come from events.jsonl (status present), oldest first, thinking_started not stored', b.events_status === 'present' && b.events?.length === 5 && b.events[0]?.type === 'plan_started' && b.events[4]?.type === 'done' && !b.events.some((e) => e.type === 'thinking_started') && b.events[0]?.t === '2026-09-14T10:00:05.000Z');
  check('L. the stored counts are copied from the index row, not recomputed', b.counts.planned === 4 && b.counts.generated === 2 && b.counts.dropped === 1 && b.counts.stable === 1);
}
const quiet = buildRunDetail(db, root, quietId);
check('M. a run without findings returns an empty findings array (the page still renders the section)', quiet.status === 200 && quiet.body.legacy === false && quiet.body.findings.length === 0);
check('M2. no events.jsonl: events null, events_status absent', quiet.status === 200 && quiet.body.events === null && quiet.body.events_status === 'absent');
const emptyRun = buildRunDetail(db, root, emptyId);
check('M3. an empty events.jsonl: events [], events_status empty', emptyRun.status === 200 && Array.isArray(emptyRun.body.events) && emptyRun.body.events.length === 0 && emptyRun.body.events_status === 'empty', JSON.stringify(emptyRun.status === 200 ? { e: emptyRun.body.events, s: emptyRun.body.events_status } : emptyRun.body));
const missing = buildRunDetail(db, root, 'does-not-exist');
check('N. an unknown run id is a 404 whose message names the path looked for', missing.status === 404 && /does-not-exist/.test(missing.body.error) && /output\/\*\/does-not-exist\/run-report\.json/.test(missing.body.error), JSON.stringify(missing.body));
const gone = buildRunDetail(db, root, goneId);
check('O. an indexed run whose run-report vanished is a 404 naming that exact path, never an empty object', gone.status === 404 && gone.body.error.includes(`output/saucedemo-com/${goneId}/run-report.json`), JSON.stringify(gone.body));
const legacyId = (db.prepare("SELECT id FROM runs WHERE status = 'legacy'").get() as { id: string }).id;
const legacy = buildRunDetail(db, root, legacyId);
check('P. a legacy record returns legacy: true, summary fields, and no scenarios key', legacy.status === 200 && legacy.body.legacy === true && !('scenarios' in legacy.body) && legacy.body.summary.explored === 1 && legacy.body.summary.model === 'claude-opus-4-7' && legacy.body.summary.duration_sec === 255 && legacy.body.header.host === 'demoqa.com', JSON.stringify(legacy.body));

/* ─── over http: token, artifacts served only from the run directory ─── */
const TOKEN = 'detail-token';
const api = createApiHandler({ db, root, token: TOKEN });
const server = http.createServer(async (req, res) => { if (await api(req, res)) return; res.writeHead(404); res.end(); });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const get = async (p: string, headers: Record<string, string> = {}) => { const r = await fetch(base + p, { headers }); return { status: r.status, text: await r.text(), type: r.headers.get('content-type') ?? '' }; };
const auth = { Authorization: `Bearer ${TOKEN}` };
check('Q. /api/runs/:id/detail rejects a request without the token', (await get(`/api/runs/${runId}/detail`)).status === 401);
const viaHttp = await get(`/api/runs/${runId}/detail`, auth);
check('R. /api/runs/:id/detail returns the same body over http', viaHttp.status === 200 && JSON.stringify(JSON.parse(viaHttp.text)) === JSON.stringify(d.body));
check('S. /api/runs/:id/detail for an unknown id is a 404 naming the path', (await get('/api/runs/nope/detail', auth)).status === 404 && /looked for output\/\*\/nope\/run-report\.json/.test((await get('/api/runs/nope/detail', auth)).text));
check('T. artifacts are served from the run directory with their type', (await get(`/api/runs/${runId}/artifacts/rule-coverage.json`, auth)).text === JSON.stringify(report.ruleCoverage) && /image\/png/.test((await get(`/api/runs/${runId}/artifacts/landing.png`, auth)).type) && /application\/zip/.test((await get(`/api/runs/${runId}/artifacts/saucedemo-automation-framework.zip`, auth)).type));
check('U. an artifact name cannot reach outside the run directory', (await get(`/api/runs/${runId}/artifacts/..%2F..%2F..%2Fsecret.txt`, auth)).status === 404 && (await get(`/api/runs/${runId}/artifacts/nope.json`, auth)).status === 404 && (await get(`/api/runs/${legacyId}/artifacts/run-report.json`, auth)).status === 404);
server.close();
db.close();

/* ─── the page ─── */
const repo = process.cwd();
const dist = path.join(repo, 'dashboard', 'dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('dashboard/dist is missing. Run `npm run dashboard:build` first.'); process.exit(1); }
const PORT = 18799;
const gw = spawn('npx', ['tsx', path.join(repo, 'src', 'server', 'gateway.ts')], {
  cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, QA_CORE_GATEWAY_PORT: String(PORT), QA_CORE_GATEWAY_TOKEN: TOKEN, QA_CORE_DASHBOARD_DIST: dist, QA_CORE_LEGACY_UI: path.join(repo, 'qa-core-ui.html'), QA_CORE_DB_PATH: path.join(root, 'data', 'qa-core-gw.sqlite'), ANTHROPIC_API_KEY: 'unused' },
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
check('V. gateway boots for the page test', /listening on http/.test(gwLog), gwLog.slice(0, 300));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/runs#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="run-row"]');
await page.click(`[data-run-id="${runId}"] a`);
await page.waitForSelector('[data-testid="run-detail"][data-legacy="false"]');
await page.waitForSelector('[data-testid="scenario-row"]');
const rendered = await page.evaluate(() => {
  const rows = Array.from(document.querySelectorAll('[data-testid="scenario-row"]')).map((r) => ({
    name: (r as HTMLElement).dataset.scenario,
    verdict: r.querySelector('[data-testid="verdict"]')?.getAttribute('data-verdict') ?? null,
    repair: r.querySelector('[data-testid="repair"]')?.getAttribute('data-repair'),
    replay: r.querySelector('[data-testid="replay"]')?.getAttribute('data-replay') ?? null,
    stability: r.querySelector('[data-testid="stability"]')?.textContent ?? null,
    shipped: r.querySelector('[data-testid="shipped"]')?.getAttribute('data-shipped'),
  }));
  const verdictColors = Array.from(document.querySelectorAll('[data-testid="verdict"]')).map((v) => ({ v: v.getAttribute('data-verdict'), color: getComputedStyle(v).color }));
  const findingsSection = document.querySelector('[data-testid="findings-section"]');
  return {
    rows, verdictColors,
    tableText: document.querySelector('[data-testid="scenarios-table"]')?.textContent ?? '',
    heading: document.querySelector('[data-testid="findings-heading"]')?.textContent ?? '',
    findings: Array.from(findingsSection?.querySelectorAll('[data-testid="finding"]') ?? []).map((f) => f.textContent ?? ''),
    findingsColor: findingsSection ? getComputedStyle(findingsSection.querySelector('h2')!).color : '',
    header: { host: document.querySelector('[data-testid="detail-host"]')?.textContent, runId: document.querySelector('[data-testid="detail-run-id"]')?.textContent, cost: document.querySelector('[data-testid="detail-cost"]')?.textContent, status: document.querySelector('[data-testid="run-detail"] [data-status]')?.getAttribute('data-status'), envBadge: !!document.querySelector('[data-testid="env-badge"]') },
    artifacts: Array.from(document.querySelectorAll('[data-testid="artifact-link"]')).map((a) => ({ kind: a.getAttribute('data-kind'), href: a.getAttribute('href') })),
    events: document.querySelectorAll('[data-testid="event-row"]').length,
    unmatched: { text: document.querySelector('[data-testid="unmatched-verdicts"] h2')?.textContent ?? '', items: Array.from(document.querySelectorAll('[data-testid="unmatched-verdict"]')).map((li) => li.textContent ?? '') },
    eventsOpen: (document.querySelector('[data-testid="events-section"]') as HTMLDetailsElement | null)?.open ?? null,
    back: document.querySelector('[data-testid="back-link"]')?.getAttribute('href'),
    rootColors: { pass: getComputedStyle(document.documentElement).getPropertyValue('--pass').trim(), rework: getComputedStyle(document.documentElement).getPropertyValue('--rework').trim(), reject: getComputedStyle(document.documentElement).getPropertyValue('--reject').trim() },
  };
});
check('W. page: three scenario rows with the recorded verdict, repair, replay, stability and shipped values', rendered.rows.length === 3 && JSON.stringify(rendered.rows.map((r) => [r.verdict, r.repair, r.replay, r.shipped])) === JSON.stringify([['pass', 'none', 'pass', 'yes'], ['pass', 'repaired', 'pass', 'yes'], ['reject', 'failed', null, 'no']]) && /2\/3/.test(rendered.rows[1]?.stability ?? '') && /PFP/.test(rendered.rows[1]?.stability ?? ''), JSON.stringify(rendered.rows));
check('X. page: the finding sits under "Product behavior to review" and is NOT a scenario row', /^Product behavior to review/.test(rendered.heading) && rendered.findings.length === 1 && /footer social links open/.test(rendered.findings[0] ?? '') && !/footer social links open/.test(rendered.tableText), JSON.stringify({ heading: rendered.heading, table: rendered.tableText.slice(0, 200) }));
check('Y. page: the findings heading is the violet finding color, verdict badges are pass green / reject red (distinct)', rendered.findingsColor !== '' && rendered.verdictColors.find((c) => c.v === 'pass')?.color !== rendered.verdictColors.find((c) => c.v === 'reject')?.color && rendered.verdictColors.find((c) => c.v === 'reject')?.color !== rendered.findingsColor, JSON.stringify(rendered.verdictColors));
check('Z. page: header shows host, run id, status, the four-term cost; no environment badge (environment stored NULL)', rendered.header.host === 'saucedemo.com' && rendered.header.runId === runId && rendered.header.status === 'completed' && rendered.header.cost === '$1.4154' && !rendered.header.envBadge, JSON.stringify(rendered.header));
check('Z2. page: the unmatched verdict is shown under "Critic verdicts that matched no scenario", not in the table', /^Critic verdicts that matched no scenario/.test(rendered.unmatched.text) && rendered.unmatched.items.length === 1 && /checkout with an empty cart/.test(rendered.unmatched.items[0] ?? '') && !/checkout with an empty cart/.test(rendered.tableText), JSON.stringify(rendered.unmatched));
check('AA. page: artifact links only for files present, token carried on the href', rendered.artifacts.length === 6 && rendered.artifacts.every((a) => a.href?.includes(`token=${TOKEN}`)) && rendered.artifacts.some((a) => a.kind === 'zip') && rendered.artifacts.some((a) => a.kind === 'screenshot'), JSON.stringify(rendered.artifacts));
check('AB. page: events timeline is collapsible (closed) with the 5 stored events', rendered.eventsOpen === false && rendered.events === 5);
check('AC. page: back link goes to the run\'s project', rendered.back === '/runs?project_id=saucedemo-com', String(rendered.back));
if (process.env.QA_CORE_SMOKE_SHOTS) {
  fs.mkdirSync(process.env.QA_CORE_SMOKE_SHOTS, { recursive: true });
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => { document.documentElement.classList.toggle('light', t === 'light'); localStorage.setItem('qa-core.theme', t); }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(process.env.QA_CORE_SMOKE_SHOTS, `run-detail-${theme}.png`), fullPage: true });
  }
}
// A run with no findings keeps the section with "No findings recorded".
await page.goto(`http://127.0.0.1:${PORT}/runs/${quietId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="findings-section"]');
check('AD. page: a run with zero findings still shows the section with "No findings recorded"', /No findings recorded/.test((await page.textContent('[data-testid="findings-section"]')) ?? ''));
check('AD2. page: a run with no events.jsonl says so ("No events log; this run predates event capture"), no empty timeline', /No events log; this run predates event capture/.test((await page.textContent('[data-testid="events-section"]')) ?? '') && (await page.$$('[data-testid="event-row"]')).length === 0, (await page.textContent('[data-testid="events-section"]')) ?? '');
await page.goto(`http://127.0.0.1:${PORT}/runs/${emptyId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="events-section"]');
check('AD3. page: an empty events.jsonl says "No events recorded"', /No events recorded/.test((await page.textContent('[data-testid="events-section"]')) ?? '') && (await page.$$('[data-testid="event-row"]')).length === 0, (await page.textContent('[data-testid="events-section"]')) ?? '');
// Legacy notice.
await page.goto(`http://127.0.0.1:${PORT}/runs/${legacyId}#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="run-detail"][data-legacy="true"]');
const legacyText = (await page.textContent('main')) ?? '';
check('AE. page: a legacy run shows the plain notice and no scenarios table', /pre-v2 record, per-scenario detail not captured/.test(legacyText) && !(await page.$('[data-testid="scenarios-table"]')) && !(await page.$('[data-testid="findings-section"]')));
// Missing run: loud 404 on the page.
await page.goto(`http://127.0.0.1:${PORT}/runs/does-not-exist#token=${TOKEN}`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="detail-error"]');
check('AF. page: an unknown run shows the 404 message with the path looked for', /looked for output\/\*\/does-not-exist\/run-report\.json/.test((await page.textContent('[data-testid="detail-error"]')) ?? ''));
check('AG. page: zero console errors', errors.filter((e) => !/404/.test(e)).length === 0, errors.join(' | '));
await browser.close();
killGw();
fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Run Detail renders only stored values from the run folder; a missing run-report is a loud 404; findings are never scenario rows.');
