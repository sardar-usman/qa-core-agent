/**
 * Locks the dedicated test account (CLAUDE.md invariant 70,
 * src/agent/test-credentials.ts, login-preflight.ts, credential-leak.ts).
 *
 * Login scenarios sign in with an account the client supplies through the
 * host .env. The model passes a marker, never a value, and no value is
 * written to any file under output/.
 *
 *   A. variable names: the host-scoped pair wins over the generic one; a
 *      half-set host pair never mixes with the generic pair; the printed line
 *      names variables and holds no value; the QA_CORE_AUTH_* line prints once.
 *   B. missing credentials: the scenarios that need the account are skipped
 *      before the Explorer with one plan line, and the funnel balances
 *      (explore() on a plan of such scenarios makes no model call).
 *   C. preflight stop: a local fixture login page with wrong values stops the
 *      run before the requirements map; a minimal stopped run-report and
 *      run-meta are written and nothing else; no model client is called.
 *   D. the marker at the fill tool: the env value is typed and only the
 *      marker recorded; a typed account value is marked; a typed password in
 *      a happy login is refused; a reset flow and a run without credentials
 *      skip the scenario; toHaveValue on a marked field records the marker;
 *      the D7 and R11 shapes keep the account's identifier.
 *   E. replay fills a marked step from the env, and fails loudly without it.
 *   F. the wrong-password cap: 11 submits, the 11th refused and skipped with
 *      the reason; a stated lockout after 3 caps at 2; replay refuses past
 *      the cap; the post-run preflight line and lockoutWarning on a fixture
 *      that locks.
 *   G. no value under output/: a credential in a skip reason, a Critic reason
 *      and a finding message is masked in every file of the run folder and
 *      the zip, read back from disk; a planted value refuses the zip and the
 *      refusal names the file, never the value.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { createContext, runTool } from '../src/agent/tools.js';
import { replayScenarioOnce } from '../src/agent/replay.js';
import { explore } from '../src/agent/runtime.js';
import { runExploreRequest } from '../src/server/run-explore.js';
import { defaultExploreRequest } from '../src/agent/explore-request.js';
import { LOGIN_PATHS, preflightLogin, preflightStopLine, postRunLockoutCheck } from '../src/agent/login-preflight.js';
import {
  RETIRED_AUTH_LINE, hostEnvSuffix, lockoutThreshold, needsTestAccount, newWrongPasswordLedger, resetRetiredAuthWarning,
  resolveTestCredentials, retiredAuthEnvLine, wrongPasswordCap, wrongPasswordSubmits, wrongPasswordCountLine,
} from '../src/agent/test-credentials.js';
import { CREDENTIAL_REDACTION, CredentialLeakError, assertNoCredentialLeak, envCredentialValues } from '../src/agent/credential-leak.js';
import { writeReportFiles } from '../src/agent/emitted-check.js';
import { writeCheckpoint, CHECKPOINT_VERSION } from '../src/agent/checkpoint.js';
import { appendRunEvent } from '../src/server/events.js';
import { scaffold } from '../src/agent/scaffold.js';
import { zipFrameworkToBuffer } from '../src/agent/zip-framework.js';
import { reconcile } from '../src/agent/reconcile.js';
import { totalCost } from '../src/agent/cost-total.js';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';
import type { PlannedScenario } from '../src/agent/planner.js';
import type { RequirementsMap } from '../src/agent/requirements.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

// The values the fixture account uses. Long and distinctive, so a leak is
// never a coincidence.
const USER = 'qa.client+dedicated@fixture.test';
const PASS = 'Fx7!dedicated-Pass-91';
const HOST_VARS = { user: 'QA_CORE_TEST_USER_PRACTICESOFTWARETESTING_COM', pass: 'QA_CORE_TEST_PASS_PRACTICESOFTWARETESTING_COM' };

// Never let the developer's own shell leak into a check.
for (const k of Object.keys(process.env)) if (/^QA_CORE_(TEST_|AUTH_|WRONG_PASSWORD)/.test(k)) delete process.env[k];

/* ─── A. which variables hold the account ────────────────────────────────── */
{
  const url = 'https://practicesoftwaretesting.com/';
  check('A1. HOST is the host uppercased with every non-alphanumeric character as _', hostEnvSuffix('practicesoftwaretesting.com') === 'PRACTICESOFTWARETESTING_COM');
  const both = resolveTestCredentials({ [HOST_VARS.user]: 'host-user', [HOST_VARS.pass]: 'host-pass', QA_CORE_TEST_USER: 'generic-user', QA_CORE_TEST_PASS: 'generic-pass' }, url);
  check('A2. the host-scoped pair wins over the generic pair', both.creds?.user === 'host-user' && both.creds.pass === 'host-pass' && both.creds.scope === 'host' && both.creds.userVar === HOST_VARS.user, JSON.stringify(both.creds));
  check('A3. the printed line names the host variables and holds no value', both.line === `test credentials: ${HOST_VARS.user} / ${HOST_VARS.pass} (host-scoped)` && !/host-user|host-pass|generic/.test(both.line), both.line);
  const half = resolveTestCredentials({ [HOST_VARS.user]: 'host-user', QA_CORE_TEST_USER: 'generic-user', QA_CORE_TEST_PASS: 'generic-pass' }, url);
  check('A4. a half-set host pair does not mix with the generic pair: no credentials, the line names both variables', half.creds === null && half.line.includes(HOST_VARS.user) && half.line.includes(HOST_VARS.pass) && !/host-user|generic-pass|generic-user/.test(half.line), JSON.stringify(half));
  const generic = resolveTestCredentials({ QA_CORE_TEST_USER: 'generic-user', QA_CORE_TEST_PASS: 'generic-pass' }, url);
  check('A5. with no host pair the generic pair is used, named, never printed', generic.creds?.user === 'generic-user' && generic.creds.pass === 'generic-pass' && generic.line === 'test credentials: QA_CORE_TEST_USER / QA_CORE_TEST_PASS', generic.line);
  const www = resolveTestCredentials({ QA_CORE_TEST_USER_SAUCEDEMO_COM: 'sd-user', QA_CORE_TEST_PASS_SAUCEDEMO_COM: 'sd-pass' }, 'https://www.saucedemo.com/');
  check('A6. a www host also reads the pair named without www', www.creds?.userVar === 'QA_CORE_TEST_USER_SAUCEDEMO_COM' && www.creds.user === 'sd-user', JSON.stringify(www.creds));
  const none = resolveTestCredentials({}, url);
  check('A7. with nothing set the line says test credentials not provided and names what was looked for', none.creds === null && none.line.startsWith('test credentials not provided') && none.line.includes('QA_CORE_TEST_USER / QA_CORE_TEST_PASS'), none.line);
  resetRetiredAuthWarning();
  const first = retiredAuthEnvLine({ QA_CORE_AUTH_USER: 'x' });
  const second = retiredAuthEnvLine({ QA_CORE_AUTH_USER: 'x' });
  check('A8. QA_CORE_AUTH_* prints the retired line once, then nothing', first === RETIRED_AUTH_LINE && second === null && RETIRED_AUTH_LINE === 'QA_CORE_AUTH_* is retired; use QA_CORE_TEST_USER / QA_CORE_TEST_PASS');
  resetRetiredAuthWarning();
  check('A9. no QA_CORE_AUTH_* variable, no line', retiredAuthEnvLine({ QA_CORE_TEST_USER: 'x' }) === null);
}

/* ─── fixture site: a login page that knows one account and can lock it ── */
interface Site { url: string; close: () => Promise<void>; failures: () => number; lockAfter: (n: number | null) => void }
async function startSite(): Promise<Site> {
  let failures = 0;
  let lockAt: number | null = null;
  const page = (body: string): string => `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`;
  const loginForm = (msg: string): string => page(`<h1>Login</h1>${msg ? `<div class="alert alert-danger" role="alert">${msg}</div>` : ''}
<form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email" data-test="email">
<label for="password">Password</label><input id="password" name="password" type="password" data-test="password">
<button type="submit" data-test="login-submit">Login</button></form>`);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && u.pathname === '/login') {
      let body = '';
      req.on('data', (d) => { body += String(d); });
      req.on('end', () => {
        const p = new URLSearchParams(body);
        const locked = lockAt !== null && failures >= lockAt;
        if (!locked && p.get('email') === USER && p.get('password') === PASS) { res.writeHead(302, { location: '/account' }); res.end(); return; }
        if (p.get('email') === USER) failures++;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(loginForm(locked || (lockAt !== null && failures >= lockAt) ? 'Account locked, too many failed attempts' : 'Invalid email or password'));
      });
      return;
    }
    if (u.pathname === '/account') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('<h1>My account</h1><a href="/logout">Log out</a>')); return; }
    if (u.pathname === '/forgot-password') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('<h1>Forgot password</h1><form><input id="email" type="email" data-test="email"><button type="button">Send</button></form>')); return; }
    if (u.pathname === '/auth/register') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('<h1>Register</h1><form><input id="email" type="email" data-test="email"><input id="password" type="password" data-test="password"><button type="button" data-test="register-submit">Register</button></form>')); return; }
    if (u.pathname === '/login' || u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(loginForm('')); return; }
    res.writeHead(404); res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    failures: () => failures,
    lockAfter: (n) => { lockAt = n; failures = 0; },
  };
}

const site = await startSite();
// The real preflight, with a short wait for a positive signal (the fixture answers at once).
const fastPreflight: typeof preflightLogin = (o) => preflightLogin({ ...o, signalTimeoutMs: 3000 });
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-test-creds-'));
const browser = await chromium.launch({ headless: true });
const origCwd = process.cwd();

try {
  /* ─── B. missing credentials: skipped before the Explorer, funnel balanced ── */
  {
    check('B1. needsTestAccount flags a happy login, a wrong-password negative and a duplicate-email negative',
      needsTestAccount({ name: 'logged in with valid credentials', category: 'happy', feature: 'account' }) === 'a happy login'
      && needsTestAccount({ name: 'rejected login with a wrong password', category: 'negative', feature: 'account' }) === 'a wrong-password negative'
      && needsTestAccount({ name: 'rejected registration with an already-used email address', category: 'negative', feature: 'account' }) === 'a duplicate-email negative');
    check('B2. it leaves an unknown-account negative, a registration happy path and a reset flow alone',
      needsTestAccount({ name: 'rejected login for an account that does not exist', category: 'negative' }) === null
      && needsTestAccount({ name: 'registered a new account', category: 'happy' }) === null
      && needsTestAccount({ name: 'submitted forgot password with a valid email', category: 'happy' }) === null);
    const plan: PlannedScenario[] = [
      { name: 'logged in with valid credentials', category: 'happy', rationale: 'fails if login breaks', feature: 'account' },
      { name: 'rejected login with a wrong password', category: 'negative', rationale: 'fails if a wrong password is accepted', feature: 'account' },
    ];
    const work = path.join(tmpRoot, 'b-run');
    fs.mkdirSync(work, { recursive: true });
    process.chdir(work); // explore() saves per-host memory under the cwd
    const prevKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'fake-key-no-call-made';
    const lines: string[] = [];
    let report: RunReport;
    try {
      report = await explore({ url: `${site.url}/login`, language: 'ts', outDir: path.join(work, 'out'), fromPlan: plan, onEvent: (e) => { if (e.type === 'message') lines.push(e.text); } }) as RunReport;
    } finally {
      process.chdir(origCwd);
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    }
    check('B3. the plan line says how many planned scenarios need the account', lines.includes('2 planned scenarios need the test account; credentials not provided'), JSON.stringify(lines));
    check('B4. each is skipped with the reason, nothing explored, no model spend', (report.skipped ?? []).length === 2 && report.skipped!.every((s) => s.reason === 'test credentials not provided') && report.scenarios.length === 0 && totalCost(report) === 0, JSON.stringify(report.skipped));
    const rec = report.reconciliation!;
    check('B5. the funnel balances: planned 2 = skipped 2', rec.planned === 2 && rec.skipped.length === 2 && rec.balanced === true, JSON.stringify(rec));
    check('B6. a run with no credentials has no wrong-password counter', report.wrongPasswordAttempts === undefined);
  }

  /* ─── C. preflight stop: wrong values, a minimal report, no model call ── */
  {
    const root = path.join(tmpRoot, 'c-project');
    fs.mkdirSync(root, { recursive: true });
    const srs = path.join(root, 'srs.md');
    fs.writeFileSync(srs, '# SRS\nR1. Users sign in with an email and a password.\n');
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // a requirements map build would refuse without it; the preflight stops first
    let exploreCalled = false as boolean;
    const req = { ...defaultExploreRequest(), url: `${site.url}/login`, srs, env: {} };
    process.env.QA_CORE_TEST_USER = USER;
    process.env.QA_CORE_TEST_PASS = 'not-the-password';
    const notes: string[] = [];
    let outcome: Awaited<ReturnType<typeof runExploreRequest>> | null = null;
    let threw: Error | null = null;
    try {
      outcome = await runExploreRequest({
        request: req, projectRoot: root, source: 'cli',
        exploreImpl: async () => { exploreCalled = true; throw new Error('explore must not be called after a failed preflight'); },
        preflight: fastPreflight,
        onNote: (t) => notes.push(t),
      });
    } catch (err) { threw = err as Error; }
    finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
    check('C1. the run stops cleanly, explore (every model client) is never called, no requirements map is built', threw === null && outcome !== null && exploreCalled === false, threw?.message);
    const outDir = outcome!.outDir;
    const files = fs.readdirSync(outDir).sort();
    check('C2. only run-report.json and run-meta.json are written', JSON.stringify(files) === JSON.stringify(['run-meta.json', 'run-report.json']), JSON.stringify(files));
    const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'run-report.json'), 'utf8')) as RunReport;
    const line = 'Run stopped: the test account did not sign in (Invalid email or password). Nothing was spent.';
    check('C3. the report is stopped with the line verbatim (the page text verbatim)', onDisk.stopped?.kind === 'login_preflight' && onDisk.stopped.reason === line, JSON.stringify(onDisk.stopped));
    check('C4. cost 0, no scenarios, an empty balanced funnel', totalCost(onDisk) === 0 && onDisk.scenarios.length === 0 && onDisk.reconciliation?.planned === 0 && onDisk.reconciliation.balanced === true);
    check('C5. the console names the variables and prints the stop line, never a value', notes.some((n) => n.includes('test credentials: QA_CORE_TEST_USER / QA_CORE_TEST_PASS')) && notes.includes(line) && !notes.join('\n').includes('not-the-password') && !notes.join('\n').includes(USER), JSON.stringify(notes));
    const raw = files.map((f) => fs.readFileSync(path.join(outDir, f), 'utf8')).join('\n');
    check('C6. neither credential value is in either file', !raw.includes(USER) && !raw.includes('not-the-password'));
    check('C7. the outcome carries the line for the gateway and MCP', outcome!.kind === 'empty' && outcome!.diagnosis?.[0] === line);

    // C8: the right values pass the preflight and the run goes on to explore().
    process.env.QA_CORE_TEST_PASS = PASS;
    let seenDone = false as boolean;
    const root2 = path.join(tmpRoot, 'c2-project');
    fs.mkdirSync(root2, { recursive: true });
    try {
      await runExploreRequest({
        request: { ...defaultExploreRequest(), url: `${site.url}/login`, env: {} }, projectRoot: root2, source: 'cli',
        exploreImpl: async (o) => { seenDone = o.loginPreflightDone === true; throw new Error('stop here'); },
        preflight: fastPreflight,
      });
    } catch { /* the fake explore throws by design */ }
    check('C8. with the right values the preflight passes and explore() runs, told the preflight is done', seenDone === true);
    // C9: --login-url is tried first and every URL tried is named on failure.
    const tried = await fastPreflight({ url: `${site.url}/nowhere`, loginUrl: `${site.url}/also-nowhere`, user: USER, pass: PASS });
    check('C9. --login-url is tried first, then the run URL, then the common login paths until the form is found',
      tried.outcome === 'ok' && JSON.stringify(tried.tried) === JSON.stringify([`${site.url}/also-nowhere`, `${site.url}/nowhere`, `${site.url}/auth/login`, `${site.url}/login`]), JSON.stringify(tried.tried));
    const dead = 'http://127.0.0.1:1';
    const unreached = await fastPreflight({ url: `${dead}/`, loginUrl: `${dead}/my-login`, user: USER, pass: PASS });
    const deadLine = preflightStopLine(unreached);
    check('C10. an unreached login page stops the run with a line naming every URL tried',
      unreached.outcome === 'unreached' && [`${dead}/my-login`, `${dead}/`, ...LOGIN_PATHS.map((p) => `${dead}${p}`)].every((u) => deadLine.includes(u)) && deadLine.startsWith('Run stopped: the test account did not sign in (no login page was found; tried '), deadLine);
    delete process.env.QA_CORE_TEST_USER;
    delete process.env.QA_CORE_TEST_PASS;
  }

  /* ─── D. the marker at the fill tool ──────────────────────────────────── */
  const newPage = async (): Promise<import('playwright').Page> => {
    const c = await browser.newContext(); await installEvalShim(c); return c.newPage();
  };
  {
    const page = await newPage();
    await page.goto(`${site.url}/login`);
    const ctx = createContext(page, 200);
    ctx.testCredentials = { user: USER, pass: PASS };
    ctx.knownAccounts = new Set([USER.toLowerCase()]);
    ctx.plannedNames = [
      'logged in with valid credentials', 'signed in and saw the account page', 'rejected login with a wrong password',
      'rejected registration with an already-used email address', 'submitted forgot password for the test account',
      'submitted forgot password with a valid email',
    ];
    await runTool(ctx, { name: 'begin_scenario', input: { name: 'logged in with valid credentials', category: 'happy', feature: 'account' } });
    await runTool(ctx, { name: 'navigate', input: { url: `${site.url}/login` } });
    const u = await runTool(ctx, { name: 'fill', input: { intent: 'email input', testid: 'email', credential: 'user' } });
    const typed = await page.inputValue('#email');
    const step = ctx.current?.steps.find((s) => s.kind === 'fill') as Extract<TraceStep, { kind: 'fill' }> | undefined;
    check('D1. credential "user" types the env value on the page and records only the marker', u.ok === true && typed === USER && step?.credential === 'user' && step.value === '', JSON.stringify({ u, step }));
    const typedPw = await runTool(ctx, { name: 'fill', input: { intent: 'password input', testid: 'password', value: 'demo-guess' } });
    check('D2. a typed password in a happy login is refused, nothing recorded', typedPw.ok === false && /credential: "pass"/.test(typedPw.error ?? '') && ctx.current!.steps.filter((s) => s.kind === 'fill').length === 1, typedPw.error);
    const p = await runTool(ctx, { name: 'fill', input: { intent: 'password input', testid: 'password', value: PASS } });
    const pStep = ctx.current?.steps.filter((s) => s.kind === 'fill')[1] as Extract<TraceStep, { kind: 'fill' }> | undefined;
    check('D3. a typed value equal to the account password is marked "pass", never recorded as text', p.ok === true && pStep?.credential === 'pass' && pStep.value === '' && (p.data as { note?: string }).note !== undefined, JSON.stringify(p));
    const tv = await runTool(ctx, { name: 'assert', input: { type: 'toHaveValue', testid: 'email', value: 'whatever' } });
    const tvStep = ctx.current?.steps.find((s) => s.kind === 'assert') as Extract<TraceStep, { kind: 'assert' }> | undefined;
    check('D4. toHaveValue on the marked field asserts the env value and records the marker with no value', tv.ok === true && tvStep?.assertion.type === 'toHaveValue' && tvStep.assertion.credential === 'user' && tvStep.assertion.value === '', JSON.stringify({ tv, a: tvStep?.assertion }));
    await runTool(ctx, { name: 'click', input: { intent: 'login button', testid: 'login-submit' } });
    await runTool(ctx, { name: 'assert', input: { type: 'toHaveURL', pattern: '/account', timeout: 10000 } });
    const end = await runTool(ctx, { name: 'end_scenario', input: {} });
    check('D5. the happy login records and closes', end.ok === true, end.error);
    const recorded = JSON.stringify(ctx.scenarios);
    check('D6. no value of the account in the recorded trace', !recorded.includes(USER) && !recorded.includes(PASS));

    // D7: a typed identifier before a marked password in a happy login is refused.
    await runTool(ctx, { name: 'begin_scenario', input: { name: 'signed in and saw the account page', category: 'happy', feature: 'account' } });
    await runTool(ctx, { name: 'navigate', input: { url: `${site.url}/login` } });
    await runTool(ctx, { name: 'fill', input: { intent: 'email input', testid: 'email', value: 'someone@else.test' } });
    const mixed = await runTool(ctx, { name: 'fill', input: { intent: 'password input', testid: 'password', credential: 'pass' } });
    check('D7. a happy login whose identifier was typed is refused at the marked password', mixed.ok === false && /re-fill the identifier with credential: "user"/.test(mixed.error ?? ''), mixed.error);
    await runTool(ctx, { name: 'skip_scenario', input: { name: 'signed in and saw the account page', reason: 'smoke' } });

    // D8 (D7 shape): the wrong-password negative keeps the account's identifier and the literal wrong password.
    await runTool(ctx, { name: 'begin_scenario', input: { name: 'rejected login with a wrong password', category: 'negative', feature: 'account' } });
    await runTool(ctx, { name: 'navigate', input: { url: `${site.url}/login` } });
    await runTool(ctx, { name: 'fill', input: { intent: 'email input', testid: 'email', credential: 'user' } });
    const wrong = await runTool(ctx, { name: 'fill', input: { intent: 'password input', testid: 'password', value: 'wrong-password-1' } });
    const fills = ctx.current!.steps.filter((s): s is Extract<TraceStep, { kind: 'fill' }> => s.kind === 'fill');
    check('D8. a wrong-password negative keeps credential "user" (never rewritten) and the literal wrong password', wrong.ok === true && fills[0]!.credential === 'user' && !fills[0]!.override && fills[1]!.value === 'wrong-password-1' && !(wrong.data as { identifierOverridden?: unknown }).identifierOverridden, JSON.stringify(fills));
    await runTool(ctx, { name: 'skip_scenario', input: { name: 'rejected login with a wrong password', reason: 'smoke' } });

    // D9 (R11 shape): the duplicate-email negative seeds the account's email on /auth/register, not rewritten, not generated.
    await runTool(ctx, { name: 'begin_scenario', input: { name: 'rejected registration with an already-used email address', category: 'negative', feature: 'account' } });
    await runTool(ctx, { name: 'navigate', input: { url: `${site.url}/auth/register` } });
    await runTool(ctx, { name: 'fill', input: { intent: 'email input', testid: 'email', credential: 'user' } });
    const regPw = await runTool(ctx, { name: 'fill', input: { intent: 'password input', testid: 'password', value: 'Str0ng!Pass-77' } });
    const regFills = ctx.current!.steps.filter((s): s is Extract<TraceStep, { kind: 'fill' }> => s.kind === 'fill');
    check('D9. the duplicate-email seed is the account email (marker), never rewritten or generated, and counts no wrong-password submit',
      regPw.ok === true && regFills[0]!.credential === 'user' && !regFills[0]!.generate && !regFills[0]!.override && wrongPasswordSubmits(ctx.current!) === 0 && await page.inputValue('#email') === USER, JSON.stringify(regFills));
    await runTool(ctx, { name: 'skip_scenario', input: { name: 'rejected registration with an already-used email address', reason: 'smoke' } });

    // D10 (decision F): a reset flow with the account's email is skipped with the reason.
    await runTool(ctx, { name: 'begin_scenario', input: { name: 'submitted forgot password for the test account', category: 'happy', feature: 'password-recovery' } });
    await runTool(ctx, { name: 'navigate', input: { url: `${site.url}/forgot-password` } });
    const reset = await runTool(ctx, { name: 'fill', input: { intent: 'email input', testid: 'email', credential: 'user' } });
    const resetSkip = ctx.skipped.find((s) => s.scenario === 'submitted forgot password for the test account');
    check('D10. a reset flow never types the account: the scenario is skipped "would send mail to the test account"', reset.ok === false && resetSkip?.reason === 'would send mail to the test account' && ctx.current === null && await page.inputValue('#email') === '', JSON.stringify({ reset, resetSkip }));
    // D11: a reset flow's own email is generated.
    await runTool(ctx, { name: 'begin_scenario', input: { name: 'submitted forgot password with a valid email', category: 'happy', feature: 'password-recovery' } });
    await runTool(ctx, { name: 'navigate', input: { url: `${site.url}/forgot-password` } });
    const gen = await runTool(ctx, { name: 'fill', input: { intent: 'email input', testid: 'email', value: 'someone@example.com' } });
    const genStep = ctx.current?.steps.find((s) => s.kind === 'fill') as Extract<TraceStep, { kind: 'fill' }> | undefined;
    check('D11. a reset flow types a generated email (generate email), not the value the model gave', gen.ok === true && genStep?.generate === 'email' && genStep.value !== 'someone@example.com', JSON.stringify(genStep));
    await runTool(ctx, { name: 'skip_scenario', input: { name: 'submitted forgot password with a valid email', reason: 'smoke' } });

    // D12: no credentials: a marked fill skips the scenario with the reason.
    const nctx = createContext(page, 60);
    await runTool(nctx, { name: 'begin_scenario', input: { name: 'logged in with valid credentials', category: 'happy', feature: 'account' } });
    await runTool(nctx, { name: 'navigate', input: { url: `${site.url}/login` } });
    const noCreds = await runTool(nctx, { name: 'fill', input: { intent: 'email input', testid: 'email', credential: 'user' } });
    check('D12. without credentials a marked fill skips the scenario "test credentials not provided"', noCreds.ok === false && nctx.skipped[0]?.reason === 'test credentials not provided' && nctx.current === null, JSON.stringify({ noCreds, s: nctx.skipped }));

    /* ─── E. replay fills a marked step from the env ─────────────────────── */
    const login = ctx.scenarios[0]!;
    const withCreds = await replayScenarioOnce(browser, login, { credentials: { user: USER, pass: PASS } }, 10_000);
    check('E1. replay fills the marked steps from the credentials and the login passes', withCreds.passed === true, withCreds.error);
    const without = await replayScenarioOnce(browser, login, { credentials: null }, 10_000);
    check('E2. without credentials a marked step fails loudly, "test credentials not provided"', without.passed === false && /test credentials not provided/.test(without.error ?? ''), without.error);
    await page.context().close();
  }

  /* ─── F. the wrong-password cap ───────────────────────────────────────── */
  {
    site.lockAfter(null); // the fixture's failure count starts at 0 here
    const page = await newPage();
    const ctx = createContext(page, 400);
    ctx.testCredentials = { user: USER, pass: PASS };
    ctx.wrongPassword = newWrongPasswordLedger({});
    check('F1. the default cap is 10', ctx.wrongPassword.cap === 10 && ctx.wrongPassword.capSource === 'default 10');
    for (let i = 1; i <= 11; i++) {
      const name = `rejected login with a wrong password ${i}`;
      await runTool(ctx, { name: 'begin_scenario', input: { name, category: 'negative', feature: 'account' } });
      await runTool(ctx, { name: 'navigate', input: { url: `${site.url}/login` } });
      await runTool(ctx, { name: 'fill', input: { intent: 'email input', testid: 'email', credential: 'user' } });
      const r = await runTool(ctx, { name: 'fill', input: { intent: 'password input', testid: 'password', value: `wrong-${i}` } });
      if (i <= 10) {
        await runTool(ctx, { name: 'click', input: { intent: 'login button', testid: 'login-submit' } });
        await runTool(ctx, { name: 'assert', input: { type: 'toContainText', css: '.alert', text: 'Invalid email or password', timeout: 10000 } });
        const e = await runTool(ctx, { name: 'end_scenario', input: {} });
        if (!r.ok || !e.ok) check(`F2.${i} submit ${i} records`, false, JSON.stringify({ r, e }));
      } else {
        check('F2. the 11th wrong-password submit is refused before the field is touched and the scenario skipped with the reason',
          r.ok === false && ctx.skipped.some((s) => s.scenario === name && s.reason === 'would exceed the wrong-password cap (10)') && await page.inputValue('#password') === '', JSON.stringify({ r, skipped: ctx.skipped }));
      }
    }
    check('F3. the counter reads 10 of 10 at the explorer stage, the refusal recorded', ctx.wrongPassword.count === 10 && ctx.wrongPassword.byStage.explorer === 10 && ctx.wrongPassword.refused.length === 1 && site.failures() === 10, JSON.stringify(ctx.wrongPassword));
    check('F4. the count line', wrongPasswordCountLine(ctx.wrongPassword, 'explorer') === 'wrong-password attempts against the test account: 10 of cap 10 (after explorer)');
    const recorded = ctx.scenarios[0]!;
    check('F5. one execution of a wrong-password scenario is one submit; a generated identifier counts 0', wrongPasswordSubmits(recorded) === 1
      && wrongPasswordSubmits({ name: 'rejected login for an account that does not exist', steps: recorded.steps.map((s) => (s.kind === 'fill' && s.credential ? { ...s, credential: undefined, value: 'nobody@example.invalid', generate: 'email' as const } : s)) }) === 0);
    const atCap = await replayScenarioOnce(browser, recorded, { credentials: { user: USER, pass: PASS }, wrongPassword: ctx.wrongPassword, stage: 'replay' }, 10_000);
    check('F6. replay refuses a run past the cap without opening the page', atCap.passed === false && atCap.error === 'would exceed the wrong-password cap (10)' && atCap.durationMs === 0 && site.failures() === 10, JSON.stringify(atCap));
    const map: RequirementsMap = { features: [{ name: 'account', description: 'sign in', rules: [{ id: 'R9', text: 'The account is locked after 3 failed login attempts.', type: 'behavior' }] }], roles: [], truncated: false };
    check('F7. a stated lockout after 3 attempts caps at 2', lockoutThreshold(map) === 3 && wrongPasswordCap({}, map).cap === 2 && /lowered to 2 by the stated lockout after 3 attempts/.test(wrongPasswordCap({}, map).capSource));
    check('F8. QA_CORE_WRONG_PASSWORD_CAP overrides the default, and a stated lockout still lowers it', wrongPasswordCap({ QA_CORE_WRONG_PASSWORD_CAP: '4' }).cap === 4 && wrongPasswordCap({ QA_CORE_WRONG_PASSWORD_CAP: '4' }, map).cap === 2 && wrongPasswordCap({ QA_CORE_WRONG_PASSWORD_CAP: 'lots' }).cap === 10);
    await page.context().close();

    // F9: the post-run preflight on a fixture that locks after 3 failures.
    process.env.QA_CORE_TEST_USER = USER;
    process.env.QA_CORE_TEST_PASS = PASS;
    site.lockAfter(3);
    const ledger = newWrongPasswordLedger({});
    const report = { url: `${site.url}/login`, wrongPasswordAttempts: ledger } as unknown as RunReport;
    // Three real wrong-password submits lock the account.
    for (let i = 0; i < 3; i++) await fetch(`${site.url}/login`, { method: 'POST', body: new URLSearchParams({ email: USER, password: `wrong-${i}` }), redirect: 'manual' });
    ledger.count = 3;
    const logs: string[] = [];
    await postRunLockoutCheck({ report, log: (l) => logs.push(l), preflight: fastPreflight });
    check('F9. on a fixture that locks, the post-run preflight prints the line and sets report.lockoutWarning',
      report.lockoutWarning === 'the test account no longer signs in after 3 wrong-password attempts' && logs.includes('WARNING: the test account no longer signs in after 3 wrong-password attempts'), JSON.stringify(logs));
    site.lockAfter(null);
    const ok = { url: `${site.url}/login`, wrongPasswordAttempts: { ...newWrongPasswordLedger({}), count: 2 } } as unknown as RunReport;
    const okLogs: string[] = [];
    await postRunLockoutCheck({ report: ok, log: (l) => okLogs.push(l), preflight: fastPreflight });
    check('F10. an account that still signs in gets the plain line and no warning', ok.lockoutWarning === undefined && okLogs[0] === 'post-run login check: the test account still signs in after 2 wrong-password attempts', JSON.stringify(okLogs));
    delete process.env.QA_CORE_TEST_USER;
    delete process.env.QA_CORE_TEST_PASS;
  }

  /* ─── G. no value under output/ ───────────────────────────────────────── */
  {
    const env = { QA_CORE_TEST_USER: USER, QA_CORE_TEST_PASS: PASS } as NodeJS.ProcessEnv;
    Object.assign(process.env, env);
    check('G0. the secrets are every test-account variable in the env', JSON.stringify(envCredentialValues(process.env).sort()) === JSON.stringify([PASS, USER].sort()));
    const runDir = path.join(tmpRoot, 'g-run');
    const loginSteps: TraceStep[] = [
      { kind: 'navigate', url: `${site.url}/login` },
      { kind: 'fill', target: { level: 'testid', arg: 'email', intent: 'email input' }, value: '', credential: 'user' },
      { kind: 'fill', target: { level: 'testid', arg: 'password', intent: 'password input' }, value: '', credential: 'pass' },
      { kind: 'click', target: { level: 'testid', arg: 'login-submit', intent: 'login button' } },
      { kind: 'assert', name: 'on account', assertion: { type: 'toHaveURL', pattern: '/account', timeout: 10000 } },
    ];
    const login: Scenario = { name: 'logged in with valid credentials', category: 'happy', feature: 'account', steps: loginSteps };
    const report: RunReport = {
      url: `${site.url}/login`, language: 'ts', scenarios: [login],
      cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 4, css: 0, xpath: 0 },
      cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
      steps: 5, startedAt: '2026-10-09T10:00:00.000Z', finishedAt: '2026-10-09T10:05:00.000Z',
      plan: [
        { name: 'logged in with valid credentials', category: 'happy', rationale: 'fails if login breaks', feature: 'account' },
        { name: 'saw the order history', category: 'happy', rationale: 'fails if orders vanish', feature: 'account' },
        { name: 'rejected login with a wrong password', category: 'negative', rationale: 'fails if accepted', feature: 'account' },
      ],
      skipped: [{ scenario: 'saw the order history', reason: `the account ${USER} with password ${PASS} has no orders` }],
      review: { verdicts: [{ scenario: 'logged in with valid credentials', verdict: 'pass', reasons: [`signs in as ${USER}`], required_fixes: [] }], summary: `all good for ${USER}` },
      findings: [{ scenario: 'rejected login with a wrong password', expected: 'an error', url: `${site.url}/login`, messages: [`Welcome back ${USER}, your password ${PASS} expired`], kind: 'product' }],
    };
    report.reconciliation = reconcile(report);
    writeReportFiles(runDir, report);
    writeCheckpoint(runDir, {
      version: CHECKPOINT_VERSION, url: report.url, flags: { lang: 'ts', pom: true, features: [], discover: false, urls: [] },
      plan: report.plan!.map((p) => ({ ...p, category: p.category as 'happy' })), fillableFields: 0, completedScenarios: [login],
      spentUsd: { planner: 0, explorer: 0, critic: 0, repair: 0 }, phase: 'explored', nextScenarioIndex: 1,
      startedAt: report.startedAt, updatedAt: report.finishedAt,
      verdicts: [{ scenario: login.name, verdict: 'pass', reasons: [`typed ${PASS}`], required_fixes: [] }],
    });
    appendRunEvent(runDir, { type: 'message', text: `Skipped "saw the order history": the account ${USER} has no orders` });
    appendRunEvent(runDir, { type: 'tool_result', name: 'get_dom', ok: true, data: { note: `logged in as ${USER}`, padding: 'x'.repeat(10) } } as never);
    const tmpFw = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-g-fw-'));
    const frameworkDir = path.join(tmpFw, 'fixture-automation-framework');
    scaffold({ report, outDir: frameworkDir, siteName: '127.0.0.1' });
    let guardThrew: unknown = null;
    try { assertNoCredentialLeak({ frameworkDir, runDir }); } catch (err) { guardThrew = err; }
    check('G1. the guard finds nothing in the framework tree and the run directory', guardThrew === null, (guardThrew as Error | null)?.message);
    const zipPath = path.join(runDir, 'fixture-automation-framework.zip');
    fs.writeFileSync(zipPath, zipFrameworkToBuffer(frameworkDir, 'fixture-automation-framework'));
    // Read every file back from disk: the run folder and every zip entry.
    const leaks: string[] = [];
    for (const f of fs.readdirSync(runDir)) {
      const full = path.join(runDir, f);
      if (f.endsWith('.zip')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes(USER) || text.includes(PASS)) leaks.push(f);
    }
    const entries = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).stdout.split('\n').filter((e) => e && !e.endsWith('/'));
    for (const e of entries) {
      const text = spawnSync('unzip', ['-p', zipPath, e], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).stdout;
      if (text.includes(USER) || text.includes(PASS)) leaks.push(`zip:${e}`);
    }
    check('G2. no file in the run folder and no entry in the zip holds either value', leaks.length === 0 && entries.length > 5, JSON.stringify(leaks));
    const runReport = fs.readFileSync(path.join(runDir, 'run-report.json'), 'utf8');
    const parsed = JSON.parse(runReport) as RunReport;
    check('G3. the skip reason, the Critic reason and the finding message are masked, not dropped',
      parsed.skipped![0]!.reason.includes(CREDENTIAL_REDACTION) && parsed.review!.verdicts[0]!.reasons[0]!.includes(CREDENTIAL_REDACTION) && parsed.findings![0]!.messages[0]!.includes(CREDENTIAL_REDACTION), JSON.stringify({ s: parsed.skipped, r: parsed.review, f: parsed.findings }));
    check('G4. the checkpoint and events.jsonl are masked too', fs.readFileSync(path.join(runDir, 'checkpoint.json'), 'utf8').includes(CREDENTIAL_REDACTION) && fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8').includes(CREDENTIAL_REDACTION));
    const spec = fs.readFileSync(path.join(frameworkDir, 'tests', 'account', 'account.spec.ts'), 'utf8');
    check('G5. the emitted spec fills the account from env', spec.includes("process.env.QA_CORE_TEST_USER ?? ''") && spec.includes("process.env.QA_CORE_TEST_PASS ?? ''"));
    // G6: a value planted in a field nothing masks refuses the zip, naming the file and field, never the value.
    fs.writeFileSync(path.join(frameworkDir, 'tests', 'notes.json'), JSON.stringify({ hint: `use ${PASS}` }));
    let refused: unknown = null;
    try { assertNoCredentialLeak({ frameworkDir, runDir }); } catch (err) { refused = err; }
    const msg = (refused as Error | null)?.message ?? '';
    check('G6. a planted value refuses the zip; the refusal names the file and the field and holds no value',
      refused instanceof CredentialLeakError && msg.includes('framework/tests/notes.json ($.hint)') && !msg.includes(PASS) && !msg.includes(USER), msg);
    fs.rmSync(path.join(frameworkDir, 'tests', 'notes.json'));
    fs.appendFileSync(path.join(runDir, 'discovery.json'), JSON.stringify({ pages: [{ url: `https://x.test/?u=${encodeURIComponent(USER)}`, note: USER }] }));
    let refused2: unknown = null;
    try { assertNoCredentialLeak({ frameworkDir, runDir }); } catch (err) { refused2 = err; }
    check('G7. a value planted in the run directory refuses the zip too', refused2 instanceof CredentialLeakError && (refused2 as Error).message.includes('discovery.json ($.pages[0].note)'), (refused2 as Error | null)?.message);
    fs.rmSync(tmpFw, { recursive: true, force: true });
    delete process.env.QA_CORE_TEST_USER;
    delete process.env.QA_CORE_TEST_PASS;
  }
} finally {
  process.chdir(origCwd);
  await browser.close();
  await site.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('OK: the test account comes from the host .env by marker, is preflighted before any spend, is capped on wrong passwords, and never reaches a file under output/.');
