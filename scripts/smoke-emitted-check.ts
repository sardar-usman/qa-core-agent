/**
 * Locks the emitted-spec check (src/agent/emitted-check.ts), the last stage
 * before the zip: the written framework is run once with Playwright against
 * the site, a test that fails twice is dropped into the reconciliation bucket
 * emitted_failed with its Playwright error, and the funnel identity holds:
 *
 *   planned === generated + dropped + incomplete + findings + skipped + emitted_failed
 *
 * Against a local fixture site served in-process (node:http, in memory):
 *   - one passing scenario ships; one scenario whose emitted assertion fails
 *     deterministically is dropped with its error text, the funnel balances,
 *     and the re-scaffolded framework no longer holds the failing test
 *   - a fixture where every test fails, the a11y check included, records
 *     inconclusive and keeps the framework
 *   - a site that refuses connections records inconclusive (network guard)
 *   - --no-emitted-check skips the stage and the report says so
 *   - the stage reuses the agent repo's node_modules (no npm install) and
 *     leaves no symlink or run files behind in the framework
 *
 * Run 51d535: 3 of 6 failed on a clean install after 20 green executions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { scaffold } from '../src/agent/scaffold.js';
import { emittedCheckStage, findAgentRoot, testTitleFor } from '../src/agent/emitted-check.js';
import { reconcile, renderReconciliation } from '../src/agent/reconcile.js';
import { parseExploreTokens } from '../src/agent/explore-request.js';
import { exploreRequestFromToolArgs } from '../src/mcp/tools.js';
import type { RunReport, Scenario, SelectorRecord } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── the fixture site ──────────────────────────────────────────────────── */
const goodHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head>
<body><main><h1 data-testid="page-title">Hand Tools</h1><p>Nine products.</p></main></body></html>`;
// Every test fails here: the heading text differs (both scenarios) and the
// page has a critical and a serious axe violation (the a11y check).
const brokenHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Broken</title></head>
<body><img src="/x.svg"><h1 data-testid="page-title">Something else</h1></body></html>`;

let mode: 'good' | 'broken' = 'good';
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/x.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(mode === 'good' ? goodHtml : brokenHtml);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
console.log(`fixture site served in-process from ${base}/`);

/* ─── the report: one passing scenario, one that fails deterministically ── */
const title: SelectorRecord = { level: 'testid', arg: 'page-title', intent: 'page title' };
function scenarios(): Scenario[] {
  return [
    { name: 'listing shows the hand tools heading', category: 'happy', feature: 'catalogue', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'assert', name: 't', assertion: { type: 'toHaveText', target: title, text: 'Hand Tools', timeout: 5000 } },
    ] },
    { name: 'listing shows a heading that does not exist', category: 'happy', feature: 'catalogue', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'assert', name: 'n', assertion: { type: 'toHaveText', target: title, text: 'Nope', timeout: 2000 } },
    ] },
  ];
}
function buildReport(): RunReport {
  const r: RunReport = {
    url: `${base}/`, language: 'ts',
    scenarios: scenarios(),
    plan: scenarios().map((s) => ({ name: s.name, category: s.category, rationale: 'fails if the heading breaks', feature: 'catalogue' })),
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
  r.reconciliation = reconcile(r);
  return r;
}

const agentRoot = findAgentRoot();
check('A0. the agent repo root holds Playwright (the node_modules the stage reuses)', fs.existsSync(path.join(agentRoot, 'node_modules', '@playwright', 'test', 'cli.js')), agentRoot);

async function stage(report: RunReport, opts: { skip?: boolean; probe?: boolean } = {}): Promise<{ frameworkDir: string; lines: string[]; ms: number; dropped: Array<{ scenario: string; error: string }> }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-emitted-check-'));
  const frameworkDir = path.join(tmp, 'fixture-automation-framework');
  const scaffoldOpts = { outDir: frameworkDir, siteName: 'fixture' };
  scaffold({ report, ...scaffoldOpts });
  const lines: string[] = [];
  const t0 = Date.now();
  const r = await emittedCheckStage({
    report, frameworkDir,
    rescaffold: (rep) => { scaffold({ report: rep, ...scaffoldOpts }); },
    log: (l) => { lines.push(l); },
    ...(opts.skip !== undefined ? { skip: opts.skip } : {}),
    ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
  });
  return { frameworkDir, lines, ms: Date.now() - t0, dropped: r.dropped };
}

/* ─── B. one ships, one is dropped, the funnel balances ─────────────────── */
{
  const report = buildReport();
  const { frameworkDir, lines, ms, dropped } = await stage(report);
  console.log(`emitted check on the two-scenario fixture took ${(ms / 1000).toFixed(1)}s`);
  const run = report.emittedRun!;
  check('B1. the result of every test lands on the report (two scenarios plus the a11y check)', run.tests.length === 3 && !run.inconclusive, JSON.stringify(run));
  const good = run.tests.find((t) => t.name === testTitleFor(scenarios()[0]!));
  const bad = run.tests.find((t) => t.name === testTitleFor(scenarios()[1]!));
  check('B2. the passing scenario passed', good?.status === 'passed', JSON.stringify(good));
  check('B3. the failing scenario was retried once and failed twice, with the Playwright error text', bad?.status === 'failed' && bad.attempts === 2 && /Nope|toHaveText/.test(bad.error ?? ''), JSON.stringify(bad));
  check('B4. the failing scenario is dropped from the framework and returned', dropped.length === 1 && dropped[0]?.scenario === scenarios()[1]!.name && report.scenarios.length === 1 && report.scenarios[0]?.name === scenarios()[0]!.name, JSON.stringify(dropped));
  const rec = report.reconciliation!;
  check('B5. the drop lands in the emitted_failed bucket with the error', rec.emitted_failed?.length === 1 && rec.emitted_failed[0]?.name === scenarios()[1]!.name && /Nope|toHaveText/.test(rec.emitted_failed[0]?.reason ?? ''), JSON.stringify(rec.emitted_failed));
  check('B6. the identity holds: planned 2 = generated 1 + emitted_failed 1, balanced', rec.planned === 2 && rec.generated === 1 && rec.accountedFor === 2 && rec.balanced && rec.dropped.length === 0, JSON.stringify({ planned: rec.planned, generated: rec.generated, accountedFor: rec.accountedFor, balanced: rec.balanced }));
  const rendered = renderReconciliation(rec).join('\n');
  check('B7. the console line states the new term and names the drop', /planned 2 = generated 1 \+ dropped 0 \+ emitted_failed 1 \[OK\]/.test(rendered) && rendered.includes(`"${scenarios()[1]!.name}"`), rendered);
  check('B8. the console named the drop during the stage', lines.some((l) => l.startsWith('Dropped from the framework (emitted-spec check failed twice):') && l.includes(scenarios()[1]!.name)), lines.join('\n'));
  const spec = fs.readFileSync(path.join(frameworkDir, 'tests', 'catalogue', 'catalogue.spec.ts'), 'utf8');
  check('B9. the re-scaffolded spec holds the passing test and not the failing one', spec.includes(testTitleFor(scenarios()[0]!)) && !spec.includes(testTitleFor(scenarios()[1]!)));
  check('B10. no node_modules symlink and no run files are left in the framework', !fs.existsSync(path.join(frameworkDir, 'node_modules')) && !fs.existsSync(path.join(frameworkDir, 'emitted-check.json')) && !fs.existsSync(path.join(frameworkDir, 'test-results')), fs.readdirSync(frameworkDir).join(','));
  check('B11. the stage finished well inside its 3-minute cap', ms < 180_000 && run.durationMs < 180_000, `${ms}ms`);
  fs.rmSync(path.dirname(frameworkDir), { recursive: true, force: true });
}

/* ─── C. every test fails, the a11y check included: inconclusive, framework kept ─ */
{
  mode = 'broken';
  const report = buildReport();
  const { frameworkDir, lines, dropped } = await stage(report);
  const run = report.emittedRun!;
  check('C1. every test failed including the a11y check, so the stage is inconclusive with the reason', run.inconclusive === true && /every test failed including the a11y check/.test(run.reason ?? ''), JSON.stringify({ reason: run.reason, tests: run.tests.map((t) => `${t.status}:${t.name}`) }));
  check('C2. nothing is dropped: both scenarios stay, the funnel is untouched', dropped.length === 0 && report.scenarios.length === 2 && report.reconciliation!.planned === 2 && report.reconciliation!.generated === 2 && (report.reconciliation!.emitted_failed ?? []).length === 0);
  check('C3. the framework is kept whole and a loud warning was printed', fs.existsSync(path.join(frameworkDir, 'tests', 'catalogue', 'catalogue.spec.ts')) && lines.some((l) => l.startsWith('WARNING: Emitted-spec check inconclusive')), lines.join('\n'));
  fs.rmSync(path.dirname(frameworkDir), { recursive: true, force: true });
  mode = 'good';
}

/* ─── D. the site refuses connections: inconclusive, never a drop ───────── */
{
  const report = buildReport();
  // Point the report at a port nothing listens on; skip the pre-run probe so
  // the in-run network guard is the one exercised.
  const dead = new URL(base); dead.port = String(port + 1);
  const deadBase = dead.toString().replace(/\/$/, '');
  report.url = `${deadBase}/`;
  for (const s of report.scenarios) for (const st of s.steps) if (st.kind === 'navigate') st.url = `${deadBase}/`;
  const { lines, dropped } = await stage(report, { probe: false });
  const run = report.emittedRun!;
  check('D1. every failure a network error: inconclusive with the reason, nothing dropped', run.inconclusive === true && /network error|unreachable/.test(run.reason ?? '') && dropped.length === 0 && report.scenarios.length === 2, JSON.stringify({ reason: run.reason, tests: run.tests.map((t) => `${t.status}:${(t.error ?? '').split('\n')[0]}`) }));
  const probed = buildReport();
  probed.url = `${deadBase}/`;
  const p = await stage(probed);
  check('D2. with the probe on, an unreachable site is caught before Playwright starts', probed.emittedRun?.inconclusive === true && /site unreachable before the run/.test(probed.emittedRun.reason ?? '') && probed.emittedRun.tests.length === 0 && p.dropped.length === 0, JSON.stringify(probed.emittedRun));
  check('D3. both paths printed the loud warning', lines.some((l) => l.startsWith('WARNING:')) && p.lines.some((l) => l.startsWith('WARNING:')));
}

/* ─── E. --no-emitted-check skips the stage and the report says so ──────── */
{
  const report = buildReport();
  const { lines, dropped, ms } = await stage(report, { skip: true });
  check('E1. the stage is skipped: inconclusive with the flag named, no tests, nothing dropped', report.emittedRun?.inconclusive === true && /--no-emitted-check/.test(report.emittedRun.reason ?? '') && report.emittedRun.tests.length === 0 && dropped.length === 0 && report.scenarios.length === 2, JSON.stringify(report.emittedRun));
  check('E2. the skip took no Playwright run and said so', ms < 5_000 && lines.some((l) => /skipped \(--no-emitted-check\)/.test(l)), lines.join('\n'));
  const parsed = parseExploreTokens(['--no-emitted-check']);
  check('E3. --no-emitted-check parses on every surface (CLI and gateway share the parser)', parsed.ok && parsed.request.emittedCheck === false && parseExploreTokens([]).ok && (parseExploreTokens([]) as { ok: true; request: { emittedCheck: boolean } }).request.emittedCheck === true);
  const mcp = exploreRequestFromToolArgs({ url: 'https://s.example/', language: 'ts', discover: false, pom: true, replay: true, stability: true, stabilityIterations: 3, stabilize: true, stabilizeAttempts: 3, emittedCheck: false });
  check('E4. the MCP argument emittedCheck: false maps to the same request field', mcp.emittedCheck === false);
}

/* ─── F. a stopped run does not run the stage ───────────────────────────── */
{
  const report = buildReport();
  report.stopped = { kind: 'cost_ceiling', reason: 'cost ceiling hit' };
  const { dropped, ms } = await stage(report);
  check('F1. a stopped run records inconclusive "not run" and keeps every scenario', report.emittedRun?.inconclusive === true && /not run: the run stopped early/.test(report.emittedRun.reason ?? '') && dropped.length === 0 && report.scenarios.length === 2 && ms < 5_000, JSON.stringify(report.emittedRun));
}

server.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the emitted-spec check runs the written framework, drops a test that fails twice into emitted_failed with its error, keeps the funnel balanced, stays inconclusive when the site is down, and is skipped by --no-emitted-check.');
