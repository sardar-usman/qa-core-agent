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
import { AUTH_ENV_PASS, AUTH_ENV_USER } from '../src/agent/auth-emit.js';
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

// A login form: the recorded credentials are welcomed, anything else (an
// empty login included) is rejected with a visible message.
const USER = 'qa.login@example.com';
const PASS = 'Fixture-Secret-1';
const loginHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Login</title></head>
<body><main><h1>Sign in</h1>
<form id="login"><label for="email">Email</label> <input id="email" name="email" type="email">
<label for="password">Password</label> <input id="password" name="password" type="password">
<button type="submit">Login</button></form></main>
<script>
document.getElementById('login').addEventListener('submit', function (e) {
  e.preventDefault();
  var ok = document.getElementById('email').value === ${JSON.stringify(USER)} && document.getElementById('password').value === ${JSON.stringify(PASS)};
  var d = document.createElement('div'); d.setAttribute('role', 'alert'); d.textContent = ok ? 'Welcome back' : 'Invalid credentials';
  if (ok) document.cookie = 'session=fixture; path=/';
  document.querySelector('main').appendChild(d);
});
</script></body></html>`;
// A contact form for the data-driven cases: a valid email is thanked, a
// malformed one gets "Bad email" (the recorded error text in one case says
// something else, so that case fails deterministically).
const contactHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Contact</title></head>
<body><main><h1>Contact</h1>
<form id="contact"><label for="name">Name</label> <input id="name" name="name">
<label for="email">Email</label> <input id="email" name="email">
<button type="submit">Send</button></form></main>
<script>
document.getElementById('contact').addEventListener('submit', function (e) {
  e.preventDefault();
  var email = document.getElementById('email').value;
  var d = document.createElement('div');
  if (/@.+\\./.test(email)) { d.className = 'flash'; d.textContent = 'Thanks for reaching out'; }
  else { d.className = 'error'; d.textContent = 'Bad email'; }
  document.querySelector('main').appendChild(d);
});
</script></body></html>`;

let mode: 'good' | 'broken' = 'good';
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/x.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  if (url.pathname === '/login.html') { res.end(loginHtml); return; }
  if (url.pathname === '/contact.html') { res.end(contactHtml); return; }
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

async function stage(report: RunReport, opts: { skip?: boolean; probe?: boolean; credentials?: null; observeChildEnv?: (env: NodeJS.ProcessEnv) => void } = {}): Promise<{ frameworkDir: string; lines: string[]; ms: number; dropped: Array<{ scenario: string; error: string }> }> {
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
    ...(opts.credentials !== undefined ? { credentials: opts.credentials } : {}),
    ...(opts.observeChildEnv ? { observeChildEnv: opts.observeChildEnv } : {}),
  });
  return { frameworkDir, lines, ms: Date.now() - t0, dropped: r.dropped };
}

/** Every file under a directory (the smoke-auth-emit tree walk). */
function tree(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { out.push(p); continue; }
    if (e.isDirectory()) out.push(...tree(p));
    else out.push(p);
  }
  return out;
}

/* ─── the login + data-driven fixture report ────────────────────────────── */
const emailInput: SelectorRecord = { level: 'label', arg: 'Email', intent: 'email input' };
const passwordInput: SelectorRecord = { level: 'label', arg: 'Password', intent: 'password input' };
const loginButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Login' }, intent: 'login button' };
const alertBox: SelectorRecord = { level: 'role', arg: { role: 'alert' }, intent: 'status alert' };
const nameInput: SelectorRecord = { level: 'label', arg: 'Name', intent: 'name input' };
const contactEmail: SelectorRecord = { level: 'label', arg: 'Email', intent: 'contact email input' };
const sendButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Send' }, intent: 'send button' };
const flash: SelectorRecord = { level: 'css', arg: '.flash', intent: 'confirmation banner' };
const errorBox: SelectorRecord = { level: 'css', arg: '.error', intent: 'error message' };
const contactSteps = (email: string, closing: Scenario['steps'][number]): Scenario['steps'] => [
  { kind: 'navigate', url: `${base}/contact.html` },
  { kind: 'fill', target: nameInput, value: 'Ada Lovelace' },
  { kind: 'fill', target: contactEmail, value: email },
  { kind: 'click', target: sendButton },
  closing,
];
function loginFixtureScenarios(withContact: boolean): Scenario[] {
  const login: Scenario = { name: 'logged in with the recorded account', category: 'happy', feature: 'login', steps: [
    { kind: 'navigate', url: `${base}/login.html` },
    { kind: 'fill', target: emailInput, value: USER },
    { kind: 'fill', target: passwordInput, value: PASS },
    { kind: 'click', target: loginButton },
    { kind: 'assert', name: 'w', assertion: { type: 'toContainText', target: alertBox, text: 'Welcome back', timeout: 5000 } },
  ] };
  const listing: Scenario = { name: 'listing shows the hand tools heading', category: 'happy', feature: 'catalogue', steps: [
    { kind: 'navigate', url: `${base}/` },
    { kind: 'assert', name: 't', assertion: { type: 'toHaveText', target: title, text: 'Hand Tools', timeout: 5000 } },
  ] };
  if (!withContact) return [login, listing];
  // Three contact scenarios with one action signature: two happy cases that
  // pass and one negative case whose recorded error text the site never
  // shows, so exactly that data case fails twice.
  return [login, listing,
    { name: 'sent the contact form', category: 'happy', feature: 'contact', steps: contactSteps('ada@shop.example', { kind: 'assert', name: 'ok', assertion: { type: 'toContainText', target: flash, text: 'Thanks for reaching out', timeout: 5000 } }) },
    { name: 'sent the contact form from a second address', category: 'happy', feature: 'contact', steps: contactSteps('grace@shop.example', { kind: 'assert', name: 'ok2', assertion: { type: 'toContainText', target: flash, text: 'Thanks for reaching out', timeout: 5000 } }) },
    { name: 'rejected a malformed email', category: 'negative', feature: 'contact', steps: contactSteps('nope@', { kind: 'assert', name: 'err', assertion: { type: 'toContainText', target: errorBox, text: 'Please enter a valid email', timeout: 2000 } }) },
  ];
}
function buildLoginReport(withContact: boolean): RunReport {
  const r: RunReport = {
    url: `${base}/`, language: 'ts',
    scenarios: loginFixtureScenarios(withContact),
    plan: loginFixtureScenarios(withContact).map((s) => ({ name: s.name, category: s.category, rationale: 'fails if it breaks', feature: s.feature })),
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
  r.reconciliation = reconcile(r);
  return r;
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
  check('B6a. droppedTraces carries the transcribed trace of the dropped scenario under its name, and the identity check holds (invariant 69)',
    report.droppedTraces?.length === 1 && report.droppedTraces[0]!.name === scenarios()[1]!.name && report.droppedTraces[0]!.stage === 'emitted_failed'
    && JSON.stringify(report.droppedTraces[0]!.steps) === JSON.stringify(scenarios()[1]!.steps) && report.droppedTracesWarning === undefined && !lines.some((l) => /droppedTraces does not match/.test(l)), JSON.stringify(report.droppedTraces));
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
  const mcp = exploreRequestFromToolArgs({ url: 'https://s.example/', language: 'ts', discover: false, pom: true, replay: true, stability: true, stabilityIterations: 3, stabilize: true, stabilizeAttempts: 3, emittedCheck: false, rebuildSrsMap: false });
  check('E4. the MCP argument emittedCheck: false maps to the same request field', mcp.emittedCheck === false);
}

/* ─── F. a stopped run does not run the stage ───────────────────────────── */
{
  const report = buildReport();
  report.stopped = { kind: 'cost_ceiling', reason: 'cost ceiling hit' };
  const { dropped, ms } = await stage(report);
  check('F1. a stopped run records inconclusive "not run" and keeps every scenario', report.emittedRun?.inconclusive === true && /not run: the run stopped early/.test(report.emittedRun.reason ?? '') && dropped.length === 0 && report.scenarios.length === 2 && ms < 5_000, JSON.stringify(report.emittedRun));
}

/* ─── G. credentials in the child env only; a data case removed from the JSON ─ */
{
  const report = buildLoginReport(true);
  const envs: NodeJS.ProcessEnv[] = [];
  const { frameworkDir, lines, dropped, ms } = await stage(report, { observeChildEnv: (env) => { envs.push({ [AUTH_ENV_USER]: env[AUTH_ENV_USER], [AUTH_ENV_PASS]: env[AUTH_ENV_PASS] }); } });
  console.log(`emitted check on the login + data-driven fixture took ${(ms / 1000).toFixed(1)}s`);
  const run = report.emittedRun!;
  check('G1. the child environment carried the recorded happy-login credentials on every spawn', envs.length >= 1 && envs.every((e) => e[AUTH_ENV_USER] === USER && e[AUTH_ENV_PASS] === PASS), JSON.stringify(envs.map((e) => Object.keys(e))));
  const offenders = tree(frameworkDir).filter((f) => { try { const b = fs.readFileSync(f, 'utf8'); return b.includes(USER) || b.includes(PASS); } catch { return false; } }).map((f) => path.relative(frameworkDir, f));
  check('G2. NO file under the framework directory contains the credential values (the smoke-auth-emit grep)', offenders.length === 0, JSON.stringify(offenders));
  check('G3. no log line carries a credential value', lines.every((l) => !l.includes(USER) && !l.includes(PASS)), lines.join('\n'));
  const loginTest = run.tests.find((t) => t.name === testTitleFor(report.plan!.find((p) => p.feature === 'login') as { name: string; category: string }));
  check('G4. the login test PASSES the check when the env carries the values', loginTest?.status === 'passed', JSON.stringify(run.tests.map((t) => `${t.status}:${t.name}`)));
  check('G5. the auth setup ran and the catalogue test passed under the saved session', run.tests.some((t) => /authenticate/.test(t.name) && t.status === 'passed') && run.tests.some((t) => /hand tools heading/.test(t.name) && t.status === 'passed'), JSON.stringify(run.tests.map((t) => `${t.status}:${t.name}`)));
  const dataCase = 'contact: rejected a malformed email';
  check('G6. the data-driven case that failed twice is recorded in emitted_failed under "<feature>: <case name>" with its error', dropped.some((d) => d.scenario === dataCase && /Please enter a valid email|toContainText/.test(d.error)) && report.reconciliation!.emitted_failed?.some((e) => e.name === dataCase) === true, JSON.stringify(dropped));
  const dataFile = path.join(frameworkDir, 'data', 'contact.json');
  const cases = fs.existsSync(dataFile) ? (JSON.parse(fs.readFileSync(dataFile, 'utf8')) as Array<{ name: string }>) : [];
  check('G7. the failed case is removed from data/contact.json and the two passing cases stay', fs.existsSync(dataFile) && cases.length === 2 && cases.every((c) => c.name !== 'rejected a malformed email'), JSON.stringify(cases));
  const rec = report.reconciliation!;
  check('G8. the member scenario behind the case leaves the report and the funnel balances: planned 5 = generated 4 + emitted_failed 1', rec.planned === 5 && rec.generated === 4 && (rec.emitted_failed ?? []).length === 1 && rec.balanced && rec.added === 0 && !report.scenarios.some((s) => s.name === 'rejected a malformed email'), JSON.stringify({ planned: rec.planned, generated: rec.generated, accountedFor: rec.accountedFor, added: rec.added }));
  const caseTrace = report.droppedTraces?.find((t) => t.name === dataCase);
  check('G9. the data case keeps its name in droppedTraces with the member scenario\'s trace, and no unmatched-name line was printed', !!caseTrace && caseTrace.stage === 'emitted_failed' && caseTrace.steps.length > 0 && !caseTrace.noTrace && report.droppedTracesWarning === undefined && !lines.some((l) => /drop name: recorded name/.test(l)), JSON.stringify(caseTrace));
  fs.rmSync(path.dirname(frameworkDir), { recursive: true, force: true });
}

/* ─── H. no happy login to supply: the login test fails with a clear error ─ */
{
  const report = buildLoginReport(false);
  const envs: NodeJS.ProcessEnv[] = [];
  const { dropped, lines } = await stage(report, { credentials: null, observeChildEnv: (env) => { envs.push(env); } });
  check('H1. with nothing to supply the child env carries no credential variable', envs.length >= 1 && envs.every((e) => e[AUTH_ENV_USER] === undefined && e[AUTH_ENV_PASS] === undefined));
  const loginDrop = dropped.find((d) => d.scenario === 'logged in with the recorded account');
  check('H2. the login test fails twice and is recorded in emitted_failed with an error that names the unset credentials, distinguishable from a rejected recorded login', !!loginDrop && /test credentials not provided to the check/.test(loginDrop.error) && /QA_CORE_TEST_USER/.test(loginDrop.error) && /Welcome back|toContainText/.test(loginDrop.error), JSON.stringify(loginDrop));
  check('H3. the outcome is on the report: the login scenario is gone from the shipped list and named in the bucket', !report.scenarios.some((s) => s.feature === 'login') && report.reconciliation!.emitted_failed?.[0]?.name === 'logged in with the recorded account' && report.reconciliation!.balanced, JSON.stringify(report.reconciliation!.emitted_failed));
  check('H4. the stage said it ran with no test account', lines.some((l) => /with no test account \(test credentials not provided\)/.test(l)), lines.join('\n'));
  const loginTrace = report.droppedTraces?.find((t) => t.name === 'logged in with the recorded account');
  check('H5. the dropped happy login keeps its trace, its credential values redacted in memory (and so in the working-directory report)', !!loginTrace && loginTrace.steps.filter((st) => st.kind === 'fill' && st.value === '[redacted:credential]').length === 2 && !JSON.stringify(report.droppedTraces).includes(PASS) && !JSON.stringify(report.droppedTraces).includes(USER), JSON.stringify(loginTrace?.steps.filter((st) => st.kind === 'fill')));
}

/* ─── I. the test account from the env (invariant 70): marked steps, the child env, the cap ─ */
{
  // The agent's own env holds the host-scoped pair for 127.0.0.1; the
  // framework reads the generic names, so the child gets them under those.
  const hostUser = 'QA_CORE_TEST_USER_127_0_0_1';
  const hostPass = 'QA_CORE_TEST_PASS_127_0_0_1';
  const saved = { u: process.env[hostUser], p: process.env[hostPass] };
  process.env[hostUser] = USER;
  process.env[hostPass] = PASS;
  const marked: Scenario[] = [
    { name: 'logged in with the test account', category: 'happy', feature: 'account', steps: [
      { kind: 'navigate', url: `${base}/login.html` },
      { kind: 'fill', target: emailInput, value: '', credential: 'user' },
      { kind: 'fill', target: passwordInput, value: '', credential: 'pass' },
      { kind: 'click', target: loginButton },
      { kind: 'assert', name: 'w', assertion: { type: 'toContainText', target: alertBox, text: 'Welcome back', timeout: 5000 } },
    ] },
    { name: 'rejected login with a wrong password', category: 'negative', feature: 'account', steps: [
      { kind: 'navigate', url: `${base}/login.html` },
      { kind: 'fill', target: emailInput, value: '', credential: 'user' },
      { kind: 'fill', target: passwordInput, value: 'not-the-password' },
      { kind: 'click', target: loginButton },
      { kind: 'assert', name: 'e', assertion: { type: 'toContainText', target: alertBox, text: 'Invalid credentials', timeout: 5000 } },
    ] },
  ];
  const report: RunReport = {
    url: `${base}/`, language: 'ts', scenarios: marked,
    plan: marked.map((sc) => ({ name: sc.name, category: sc.category, rationale: 'fails if it breaks', feature: sc.feature })),
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    // One submit already spent of a cap of 1: the wrong-password test cannot run.
    wrongPasswordAttempts: { cap: 1, capSource: 'QA_CORE_WRONG_PASSWORD_CAP=1', count: 1, byStage: { stability: 1 }, refused: [] },
  };
  report.reconciliation = reconcile(report);
  const envs: NodeJS.ProcessEnv[] = [];
  const { frameworkDir, lines } = await stage(report, { observeChildEnv: (env) => { envs.push({ [AUTH_ENV_USER]: env[AUTH_ENV_USER], [AUTH_ENV_PASS]: env[AUTH_ENV_PASS], [hostUser]: env[hostUser] }); } });
  const run = report.emittedRun!;
  check('I1. the child env carries the env account under the generic names the framework reads', envs.length >= 1 && envs.every((e) => e[AUTH_ENV_USER] === USER && e[AUTH_ENV_PASS] === PASS), JSON.stringify(envs.map((e) => Object.keys(e))));
  const loginT = run.tests.find((t) => t.name === testTitleFor(marked[0]!));
  check('I2. the marked happy login (feature account) passes, through the auth setup the marker activated', loginT?.status === 'passed' && run.tests.some((t) => /authenticate/.test(t.name) && t.status === 'passed'), JSON.stringify(run.tests.map((t) => `${t.status}:${t.name}`)));
  const wrongT = run.tests.find((t) => t.name === testTitleFor(marked[1]!));
  check('I3. the wrong-password test past the cap is not run: recorded skipped with the reason, kept in the framework, the count unchanged',
    wrongT?.status === 'skipped' && wrongT.error === 'would exceed the wrong-password cap (1)' && report.scenarios.some((sc) => sc.name === marked[1]!.name)
    && fs.readFileSync(path.join(frameworkDir, 'tests', 'account', 'account.spec.ts'), 'utf8').includes(marked[1]!.name)
    && report.wrongPasswordAttempts!.count === 1 && report.wrongPasswordAttempts!.refused.some((r) => r.stage === 'emitted'), JSON.stringify({ wrongT, w: report.wrongPasswordAttempts }));
  check('I4. the stage names the variables it read the account from and the count, never a value',
    lines.some((l) => l.includes(`${AUTH_ENV_USER} / ${AUTH_ENV_PASS} from ${hostUser} / ${hostPass}`)) && lines.includes('wrong-password attempts against the test account: 1 of cap 1 (after emitted)') && lines.every((l) => !l.includes(USER) && !l.includes(PASS)), lines.join('\n'));
  const offenders = tree(frameworkDir).filter((f) => { try { const b = fs.readFileSync(f, 'utf8'); return b.includes(USER) || b.includes(PASS); } catch { return false; } });
  check('I5. no file under the framework directory holds either value', offenders.length === 0, JSON.stringify(offenders));
  fs.rmSync(path.dirname(frameworkDir), { recursive: true, force: true });
  if (saved.u === undefined) delete process.env[hostUser]; else process.env[hostUser] = saved.u;
  if (saved.p === undefined) delete process.env[hostPass]; else process.env[hostPass] = saved.p;
}

server.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the emitted-spec check runs the written framework, drops a test that fails twice into emitted_failed with its error, keeps the funnel balanced, stays inconclusive when the site is down, passes the test account from the env (or the recorded login of an older report) in memory only, keeps a wrong-password test past the cap unrun, removes a failed data case from the JSON, and is skipped by --no-emitted-check.');
