import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunReport } from './trace.js';
import type { RequirementsMap } from './requirements.js';
import { reconcile, unmatchedDropLine } from './reconcile.js';
import { attachDroppedTraces, recordOf, storeFromDroppedTraces, storeTrace, type TraceRecord } from './dropped-traces.js';
import { computeRuleCoverage } from './rule-coverage.js';
import { unreachableFeatures } from './planner.js';
import { AUTH_ENV_PASS, AUTH_ENV_USER, findHappyLoginScenario, recordedCredentials, reportUsesTestAccount, type AuthCredentials } from './auth-emit.js';
import {
  readTestCredentials, recordWrongPassword, refuseWrongPassword, wrongPasswordCapReason,
  wrongPasswordCountLine, wrongPasswordSubmits,
} from './test-credentials.js';
import { maskForDisk } from './credential-leak.js';

/**
 * The emitted-spec check: the last stage before the zip.
 *
 * The written framework is RUN once with Playwright (chromium, one worker,
 * the JSON reporter) against the live site. Every test's result lands on the
 * report as `emittedRun`. A test that fails is retried once; a test that
 * fails twice is dropped from the framework and recorded in the
 * reconciliation bucket `emitted_failed` with the Playwright error text, so
 * the identity becomes
 *
 *   planned === generated + dropped + incomplete + findings + skipped + emitted_failed
 *
 * Run 51d535 shipped a framework that failed 3 of 6 on a clean install after
 * every scenario had passed replay and three stability runs: nothing in the
 * pipeline had executed the emitted spec. This stage does.
 *
 * No fresh npm install: the framework's node_modules is a SYMLINK to the
 * agent repo's own node_modules for the duration of the run (the same
 * @playwright/test, @axe-core/playwright and dotenv the scaffold pins), and
 * Playwright is started through that package's cli.js. The symlink and the
 * run's own files (the JSON report, test-results/) are removed before the
 * caller zips, so the zip is exactly the framework.
 *
 * Site-down guard: when the entry URL cannot be fetched, when every test
 * fails including the a11y spec, or when every failure is a network error,
 * the stage records `inconclusive` with the reason, keeps the framework whole
 * and prints a loud warning. A network blip never drops everything.
 *
 * Credentials: the login spec, the auth setup and every credential-marked
 * fill read QA_CORE_TEST_USER and QA_CORE_TEST_PASS. The stage passes the
 * test account from the agent's own env (the host-scoped pair when set, else
 * the generic one, invariant 70) into the Playwright child's environment
 * under the generic names, in memory only: never a .env in the run
 * directory, never the zip, never a log line. A report written before the
 * marker existed, run with no env account, falls back to its recorded happy
 * login. With neither it passes nothing; a login test that then fails twice
 * is recorded with an error that says the values were not provided.
 *
 * Wrong-password submits count against the run's cap here too: a test the
 * remaining cap cannot cover is not run (`--grep-invert`), kept in the
 * framework and recorded as skipped with the cap reason, and a failed one is
 * retried only when the cap covers the retry.
 *
 * Dataset cases: a data-driven case ("[data] <feature> — <case>") that fails
 * twice is removed from data/<feature>.json (re-applied after the
 * re-scaffold, which would regenerate it) and recorded in emitted_failed
 * under "<feature>: <case name>", never shipped red. The a11y spec keeps
 * the warn-and-keep behavior.
 */

export const EMITTED_CHECK_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 10_000;
const JSON_NAME = 'emitted-check.json';
const NETWORK_ERROR_RE = /net::ERR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|Navigation timeout|page\.goto: Timeout/i;

export type EmittedRun = NonNullable<RunReport['emittedRun']>;
export type EmittedTest = EmittedRun['tests'][number];

export interface EmittedCheckOptions {
  report: RunReport;
  /** The scaffolded framework root (package.json, playwright.config, tests/). */
  frameworkDir: string;
  /** Re-scaffold the framework into frameworkDir from the (reduced) report after drops. */
  rescaffold: (report: RunReport) => void;
  requirements?: RequirementsMap;
  /** --no-emitted-check: record the skip on the report and change nothing. */
  skip?: boolean;
  /** Whole-stage cap, both attempts included. */
  timeoutMs?: number;
  /** The agent repo root whose node_modules is reused; found from this module when absent. */
  agentRoot?: string;
  /** Skip the pre-run reachability probe (a local fixture answers it anyway). */
  probe?: boolean;
  /**
   * Credentials for the child env. Absent: the test account from the env
   * (readTestCredentials for the run's host), else, for a report with no
   * credential marker, its recorded happy login. null: pass none (the
   * smoke's seam for the unset outcome).
   */
  credentials?: AuthCredentials | null;
  /** The env the test account is read from; process.env when absent. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: sees the child's environment right before each spawn. Never used for logging. */
  observeChildEnv?: (env: NodeJS.ProcessEnv) => void;
  log: (line: string) => void;
}

/** The env the child gets for the recorded credentials, in memory only. */
export function credentialEnv(creds: AuthCredentials | null | undefined): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (creds?.user) out[AUTH_ENV_USER] = creds.user;
  if (creds?.pass) out[AUTH_ENV_PASS] = creds.pass;
  return out;
}

/** The data-driven test title the POM emitter gives a dataset case, split back into its parts. */
export function parseDataTestTitle(title: string): { feature: string; caseName: string } | null {
  const m = title.match(/^\[data\] (.+?) — (.+)$/);
  return m ? { feature: m[1]!, caseName: m[2]! } : null;
}

/** Remove the named cases from data/<feature>.json when the file exists (idempotent). */
export function pruneDatasetCases(frameworkDir: string, removed: Map<string, Set<string>>): void {
  for (const [feature, names] of removed) {
    const file = path.join(frameworkDir, 'data', `${feature}.json`);
    if (!fs.existsSync(file)) continue;
    let cases: Array<{ name: string }>;
    try { cases = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<{ name: string }>; } catch { continue; }
    const kept = cases.filter((c) => !names.has(c.name));
    if (kept.length !== cases.length) fs.writeFileSync(file, JSON.stringify(kept, null, 2) + '\n');
  }
}

export interface EmittedCheckResult {
  /** The report with emittedRun, emittedFailed, scenarios, reconciliation and ruleCoverage updated. */
  report: RunReport;
  /** Scenarios dropped from the framework (test failed twice), with the Playwright error. */
  dropped: Array<{ scenario: string; error: string }>;
}

/**
 * Rewrite the run directory's own report files after the stage: the raw
 * run-report.json (never redacted here) and rule-coverage.json when the run
 * has one. The redacted copy inside the framework is the scaffold's job.
 */
export function writeReportFiles(outDir: string, report: RunReport): void {
  fs.mkdirSync(outDir, { recursive: true });
  // No test-account value reaches disk (invariant 70): every string masked.
  fs.writeFileSync(path.join(outDir, 'run-report.json'), JSON.stringify(maskForDisk(report), null, 2));
  if (report.ruleCoverage) fs.writeFileSync(path.join(outDir, 'rule-coverage.json'), JSON.stringify(maskForDisk(report.ruleCoverage), null, 2));
}

/** The agent repo root: the nearest ancestor of this module that holds Playwright's test package. */
export function findAgentRoot(from: string = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'node_modules', '@playwright', 'test', 'cli.js'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

interface PwResult { status: string; error?: { message?: string }; errors?: Array<{ message?: string }> }
interface PwTest { status: string; results?: PwResult[] }
interface PwSpec { title: string; ok: boolean; file?: string; tests?: PwTest[] }
interface PwSuite { file?: string; title: string; specs?: PwSpec[]; suites?: PwSuite[] }
interface PwJson { stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number }; suites?: PwSuite[] }

/** Flatten Playwright's JSON report into one row per spec. */
export function flattenPlaywrightJson(json: PwJson): EmittedTest[] {
  const out: EmittedTest[] = [];
  const walk = (suites: PwSuite[], file: string): void => {
    for (const s of suites) {
      const f = s.file ?? file;
      for (const sp of s.specs ?? []) {
        const t = sp.tests?.[0];
        const r = t?.results?.[t.results.length - 1];
        const status: EmittedTest['status'] = r?.status === 'passed' ? 'passed' : r?.status === 'skipped' || t?.status === 'skipped' ? 'skipped' : 'failed';
        const raw = r?.error?.message ?? r?.errors?.map((e) => e.message ?? '').filter(Boolean).join('\n') ?? '';
        const error = status === 'failed' ? stripAnsi(raw || `status ${r?.status ?? t?.status ?? 'missing'}`).trim().split('\n').slice(0, 6).join('\n') : undefined;
        out.push({ name: sp.title, status, ...(error ? { error } : {}), ...(sp.file ?? f ? { file: sp.file ?? f } : {}) });
      }
      if (s.suites) walk(s.suites, f);
    }
  };
  walk(json.suites ?? [], '');
  return out;
}

/** The test title the POM emitter gives a scenario. */
export function testTitleFor(scenario: { name: string; category: string }): string {
  const tag = scenario.category === 'happy' ? '[happy]' : scenario.category === 'negative' ? '[negative]' : scenario.category === 'edge' ? '[edge]' : '[a11y]';
  return `${tag} ${scenario.name}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface PwRun { status: number | null; killed: boolean; tests: EmittedTest[]; stderr: string; durationMs: number }

async function runPlaywright(frameworkDir: string, agentRoot: string, grep: string[] | null, timeoutMs: number, extraEnv: NodeJS.ProcessEnv = {}, observe?: (env: NodeJS.ProcessEnv) => void, grepInvert: string[] = []): Promise<PwRun> {
  const cli = path.join(agentRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  const args = [cli, 'test', '--reporter=json', '--workers=1', '--retries=0'];
  if (grep && grep.length > 0) args.push('--grep', grep.map(escapeRegex).join('|'));
  if (grepInvert.length > 0) args.push('--grep-invert', grepInvert.map(escapeRegex).join('|'));
  // The recorded credentials travel in the child's environment only; the
  // parent's own QA_CORE_TEST_* (a developer's shell) never leak into the
  // check, so what the framework sees is exactly what the run recorded.
  const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: JSON_NAME, PW_TEST_HTML_REPORT_OPEN: 'never' };
  delete env.CI;
  delete env[AUTH_ENV_USER];
  delete env[AUTH_ENV_PASS];
  Object.assign(env, extraEnv);
  observe?.(env);
  const jsonPath = path.join(frameworkDir, JSON_NAME);
  try { fs.rmSync(jsonPath, { force: true }); } catch { /* none */ }
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: frameworkDir, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let killed = false;
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, Math.max(1000, timeoutMs));
    child.on('close', (status) => {
      clearTimeout(timer);
      let tests: EmittedTest[] = [];
      try { tests = flattenPlaywrightJson(JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as PwJson); } catch { /* no report: killed, or Playwright could not start */ }
      resolve({ status, killed, tests, stderr: stripAnsi(stderr).trim().split('\n').slice(-8).join('\n'), durationMs: Date.now() - t0 });
    });
  });
}

async function probeUrl(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'qa-core-agent-emitted-check' } });
    } finally {
      clearTimeout(timer);
    }
    return null;
  } catch (err) {
    return (err as Error).message || String(err);
  }
}

/** Remove what the run left inside the framework so the zip is exactly the framework. */
function cleanRunFiles(frameworkDir: string): void {
  for (const f of [JSON_NAME, 'test-results', 'playwright-report', 'blob-report']) {
    try { fs.rmSync(path.join(frameworkDir, f), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Link the agent repo's node_modules into the framework. Returns the unlink
 * function. A real directory already there (a caller installed) is left as
 * it is and nothing is unlinked.
 */
function linkNodeModules(frameworkDir: string, agentRoot: string): () => void {
  const target = path.join(frameworkDir, 'node_modules');
  if (fs.existsSync(target)) return () => {};
  fs.symlinkSync(path.join(agentRoot, 'node_modules'), target, 'dir');
  return () => { try { fs.unlinkSync(target); } catch { /* already gone */ } };
}

function withEmittedRun(report: RunReport, run: EmittedRun): RunReport {
  report.emittedRun = run;
  return report;
}

/**
 * A login test that failed while the check passed no credentials, on a spec
 * that reads them from env, ran with empty values: say so in the error, so
 * the report distinguishes "the site rejected the recorded login" from "the
 * run had no happy login to supply".
 */
function annotateLoginError(t: EmittedTest, frameworkDir: string, credsPassed: boolean): string {
  const error = t.error ?? 'failed';
  if (credsPassed || !t.file) return error;
  // The JSON reporter names a spec relative to the tests directory (the
  // config's testDir); an older shape names it from the framework root.
  let spec = '';
  for (const candidate of [path.join(frameworkDir, 'tests', t.file), path.join(frameworkDir, t.file)]) {
    try { spec = fs.readFileSync(candidate, 'utf8'); break; } catch { /* try the next */ }
  }
  if (!spec.includes(AUTH_ENV_USER) && !spec.includes(AUTH_ENV_PASS)) return error;
  return `test credentials not provided to the check (${AUTH_ENV_USER} / ${AUTH_ENV_PASS} were unset, so the test ran with empty values); ${error}`;
}

/** Rebuild reconciliation and rule coverage after the emitted drops, the same builders the runtime used. */
function rebuildAccounting(
  report: RunReport,
  requirements: RequirementsMap | undefined,
  log: (l: string) => void,
  removedScenarios: Set<string> = new Set(),
  dropped: Array<{ scenario: string; error: string }> = [],
  emittedTraces: Map<string, TraceRecord> = new Map(),
): void {
  // A name the runtime already reported as unmatched is not printed twice.
  const reported = new Set(report.reconciliation?.unmatchedDropNames ?? []);
  report.reconciliation = reconcile(report, {
    onDuplicate: (m) => log(`WARNING: ${m}`),
    onUnmatchedName: (m) => { if (![...reported].some((n) => unmatchedDropLine(n) === m)) log(`WARNING: ${m}`); },
  });
  // Dropped traces: the earlier stages' traces carried over, plus the
  // transcribed trace of every scenario this stage dropped (invariant 69).
  const store = storeFromDroppedTraces(report.droppedTraces);
  for (const [name, record] of emittedTraces) storeTrace(store, 'emitted_failed', name, record);
  attachDroppedTraces(report, store, log);
  if (requirements && report.ruleCoverage) {
    const dropReasons = new Map<string, string>(report.reconciliation.dropped.map((d) => [d.name, d.reason]));
    for (const e of report.emittedFailed ?? []) dropReasons.set(e.scenario, `emitted-spec check: ${e.error.split('\n')[0] ?? ''}`);
    // A member scenario removed behind a data case is keyed by its own name too.
    for (const name of removedScenarios) if (!dropReasons.has(name)) dropReasons.set(name, `emitted-spec check: ${dropped[0]?.error.split('\n')[0] ?? 'failed twice'}`);
    const derivation = report.ruleCoverage.derivation;
    report.ruleCoverage = {
      ...computeRuleCoverage({
        map: requirements,
        planned: report.plan ?? [],
        scenarios: report.scenarios,
        dropReasons,
        ...(report.discovery ? { unreachableFeatures: unreachableFeatures(requirements, report.discovery.pages).map((f) => f.name) } : {}),
      }),
      ...(derivation ? { derivation } : {}),
    };
  }
}

/**
 * Run the stage. Mutates and returns the report: `emittedRun` always set
 * (inconclusive with a reason when the stage did not judge the framework),
 * and on drops `emittedFailed`, `scenarios`, `reconciliation` and
 * `ruleCoverage` rebuilt and the framework re-scaffolded without the dropped
 * tests. The caller writes the report to the run directory and zips.
 */
export async function emittedCheckStage(opts: EmittedCheckOptions): Promise<EmittedCheckResult> {
  const { report, frameworkDir, log } = opts;
  const timeoutMs = opts.timeoutMs ?? EMITTED_CHECK_TIMEOUT_MS;
  const none: EmittedCheckResult = { report, dropped: [] };

  if (opts.skip) {
    log('Emitted-spec check: skipped (--no-emitted-check); the framework is written as generated.');
    return { ...none, report: withEmittedRun(report, { tests: [], durationMs: 0, inconclusive: true, reason: 'skipped (--no-emitted-check)' }) };
  }
  if (report.stopped) {
    log(`Emitted-spec check: not run (the run stopped early: ${report.stopped.reason}).`);
    return { ...none, report: withEmittedRun(report, { tests: [], durationMs: 0, inconclusive: true, reason: `not run: the run stopped early (${report.stopped.kind})` }) };
  }
  if (report.scenarios.length === 0) {
    return { ...none, report: withEmittedRun(report, { tests: [], durationMs: 0, inconclusive: true, reason: 'not run: no scenarios' }) };
  }

  const agentRoot = opts.agentRoot ?? findAgentRoot();
  const t0 = Date.now();
  // The test account for the child env only (invariant 70): the env pair the
  // agent ran with, passed under the generic names the framework reads. A
  // report from before the marker, with no env account, uses its recorded login.
  const envCreds = readTestCredentials(opts.env ?? process.env, report.url);
  const login = findHappyLoginScenario(report);
  const legacy = !envCreds && login && !reportUsesTestAccount(report) ? recordedCredentials(login) : null;
  const creds: AuthCredentials | null = opts.credentials === undefined
    ? (envCreds ? { user: envCreds.user, pass: envCreds.pass } : legacy)
    : opts.credentials;
  const childEnv = credentialEnv(creds);
  const credsPassed = Object.keys(childEnv).length > 0;
  const credsSource = opts.credentials !== undefined ? 'the supplied credentials' : envCreds ? `${envCreds.userVar} / ${envCreds.passVar}` : 'the recorded login';
  log(`Emitted-spec check: running the written framework once with Playwright (chromium, one worker) against ${report.url}${credsPassed ? ` with the test account in the child environment (${AUTH_ENV_USER} / ${AUTH_ENV_PASS} from ${credsSource}, in memory only)` : ' with no test account (test credentials not provided)'}`);

  // The wrong-password cap (invariant 70): tests the remaining cap cannot
  // cover are not run; they stay in the framework, recorded as skipped.
  const ledger = report.wrongPasswordAttempts;
  const submitsByTitle = new Map<string, number>();
  for (const sc of report.scenarios) {
    const n = wrongPasswordSubmits(sc);
    if (n > 0) submitsByTitle.set(testTitleFor(sc), n);
  }
  const capExcluded: string[] = [];
  if (ledger && submitsByTitle.size > 0) {
    let room = Math.max(0, ledger.cap - ledger.count);
    for (const sc of report.scenarios) {
      const n = submitsByTitle.get(testTitleFor(sc));
      if (!n) continue;
      if (n <= room) { room -= n; continue; }
      capExcluded.push(testTitleFor(sc));
      refuseWrongPassword(ledger, sc.name, 'emitted');
    }
    if (capExcluded.length > 0) log(`WARNING: Emitted-spec check: ${capExcluded.length} test(s) not run: ${wrongPasswordCapReason(ledger)}: ${capExcluded.map((t) => `"${t}"`).join(', ')}; they stay in the framework as generated`);
  }
  const capSkipped = (): EmittedTest[] => capExcluded.map((name) => ({ name, status: 'skipped' as const, error: ledger ? wrongPasswordCapReason(ledger) : 'not run', attempts: 0 }));
  const countRun = (ran: EmittedTest[]): void => {
    if (!ledger) return;
    for (const t of ran) {
      const n = submitsByTitle.get(t.name);
      if (n && (t.status === 'passed' || t.status === 'failed')) recordWrongPassword(ledger, n, 'emitted');
    }
  };

  if (opts.probe !== false) {
    const probeErr = await probeUrl(report.url);
    if (probeErr) {
      const reason = `site unreachable before the run (${probeErr}); the framework is kept as generated`;
      log(`WARNING: Emitted-spec check inconclusive: ${reason}`);
      return { ...none, report: withEmittedRun(report, { tests: [], durationMs: Date.now() - t0, inconclusive: true, reason }) };
    }
  }

  const unlink = linkNodeModules(frameworkDir, agentRoot);
  try {
    const first = await runPlaywright(frameworkDir, agentRoot, null, timeoutMs, childEnv, opts.observeChildEnv, capExcluded);
    countRun(first.tests);
    if (first.killed) {
      const reason = `timed out after ${Math.round(timeoutMs / 1000)}s; the framework is kept as generated`;
      log(`WARNING: Emitted-spec check inconclusive: ${reason}`);
      return { ...none, report: withEmittedRun(report, { tests: first.tests, durationMs: Date.now() - t0, inconclusive: true, reason }) };
    }
    if (first.tests.length === 0) {
      const reason = `Playwright produced no results (exit ${String(first.status)}): ${first.stderr || 'no output'}; the framework is kept as generated`;
      log(`WARNING: Emitted-spec check inconclusive: ${reason}`);
      return { ...none, report: withEmittedRun(report, { tests: [], durationMs: Date.now() - t0, inconclusive: true, reason }) };
    }

    const failedFirst = first.tests.filter((t) => t.status === 'failed');
    const a11yFailed = failedFirst.some((t) => /a11y/.test(t.file ?? '') || /^a11y:/.test(t.name));
    const allFailed = failedFirst.length === first.tests.length;
    const allNetwork = failedFirst.length > 0 && failedFirst.every((t) => NETWORK_ERROR_RE.test(t.error ?? ''));
    if ((allFailed && a11yFailed) || allNetwork) {
      const reason = allNetwork
        ? `every failure is a network error (${failedFirst[0]!.error?.split('\n')[0] ?? ''}); the site was unreachable during the run, the framework is kept as generated`
        : 'every test failed including the a11y check; the site is down or blocking automation, the framework is kept as generated';
      log(`WARNING: Emitted-spec check inconclusive: ${reason}`);
      return { ...none, report: withEmittedRun(report, { tests: first.tests, durationMs: Date.now() - t0, inconclusive: true, reason }) };
    }

    let tests = [...first.tests.map((t) => ({ ...t, attempts: 1 })), ...capSkipped()];
    // A failed wrong-password test is retried only when the cap covers it;
    // otherwise it fails with the cap named, never retried past the cap.
    const noRetry = new Set<string>();
    if (ledger) {
      let room = Math.max(0, ledger.cap - ledger.count);
      for (const t of failedFirst) {
        const n = submitsByTitle.get(t.name) ?? 0;
        if (n === 0) continue;
        if (n <= room) { room -= n; continue; }
        noRetry.add(t.name);
        refuseWrongPassword(ledger, t.name, 'emitted');
      }
    }
    const toRetry = failedFirst.filter((t) => !noRetry.has(t.name));
    if (noRetry.size > 0) {
      tests = tests.map((t) => (noRetry.has(t.name) ? { ...t, error: `failed once; not retried: ${wrongPasswordCapReason(ledger!)}; ${t.error ?? 'failed'}` } : t));
    }
    if (toRetry.length > 0) {
      const left = timeoutMs - (Date.now() - t0);
      log(`Emitted-spec check: ${toRetry.length} test(s) failed on the first run; retrying once: ${toRetry.map((t) => `"${t.name}"`).join(', ')}`);
      const second = await runPlaywright(frameworkDir, agentRoot, toRetry.map((t) => t.name), Math.max(15_000, left), childEnv, opts.observeChildEnv);
      countRun(second.tests);
      if (second.killed) {
        const reason = `the retry timed out after ${Math.round(timeoutMs / 1000)}s in total; the framework is kept as generated`;
        log(`WARNING: Emitted-spec check inconclusive: ${reason}`);
        return { ...none, report: withEmittedRun(report, { tests, durationMs: Date.now() - t0, inconclusive: true, reason }) };
      }
      const retried = new Map(second.tests.map((t) => [t.name, t]));
      tests = tests.map((t) => {
        if (t.status !== 'failed' || noRetry.has(t.name)) return t;
        const r = retried.get(t.name);
        if (!r) return { ...t, attempts: 2 };
        return { ...r, attempts: 2 };
      });
    }

    const durationMs = Date.now() - t0;
    const failedTwice = tests.filter((t) => t.status === 'failed');
    const byTitle = new Map(report.scenarios.map((s) => [testTitleFor(s), s]));
    const byName = new Map(report.scenarios.map((s) => [s.name, s]));
    const dropped: Array<{ scenario: string; error: string; dataCase?: boolean }> = [];
    // The transcribed trace of each drop, by its emitted_failed name (droppedTraces).
    const emittedTraces = new Map<string, TraceRecord>();
    // Scenarios to remove from the report: a failed scenario test, or the
    // member scenario behind a failed data case (its test IS that case).
    const removeScenarios = new Set<string>();
    // Dataset cases to remove from data/<feature>.json after the re-scaffold.
    const removedCases = new Map<string, Set<string>>();
    const unmapped: EmittedTest[] = [];
    for (const t of failedTwice) {
      const error = annotateLoginError(t, frameworkDir, credsPassed);
      const s = byTitle.get(t.name);
      if (s) { dropped.push({ scenario: s.name, error }); removeScenarios.add(s.name); emittedTraces.set(s.name, recordOf(s)); continue; }
      const data = parseDataTestTitle(t.name);
      if (data) {
        // Recorded under "<feature>: <case name>". A member case's scenario
        // leaves the report too (its only test was this case); a rule-derived
        // case has no scenario and leaves only the data file.
        const caseName = `${data.feature}: ${data.caseName}`;
        dropped.push({ scenario: caseName, error, dataCase: true });
        removedCases.set(data.feature, (removedCases.get(data.feature) ?? new Set()).add(data.caseName));
        const member = byName.get(data.caseName) ?? byName.get(data.caseName.replace(/^boundary: /, ''));
        if (member) removeScenarios.add(member.name);
        // The member's trace is the case's trace; a rule-derived case has none.
        emittedTraces.set(caseName, member ? recordOf(member) : { steps: [], noTrace: 'a rule-derived data case: no recorded scenario behind it' });
        continue;
      }
      unmapped.push(t);
    }
    const passed = tests.filter((t) => t.status === 'passed').length;
    log(`Emitted-spec check: ${passed} of ${tests.length} test(s) passed in ${(durationMs / 1000).toFixed(1)}s${failedTwice.length ? `; ${failedTwice.length} failed twice` : ''}`);
    if (ledger) log(wrongPasswordCountLine(ledger, 'emitted'));
    for (const t of unmapped) {
      log(`WARNING: Emitted-spec check: "${t.name}" failed twice but is not a scenario test (${/a11y/.test(t.file ?? '') ? 'the a11y check' : 'a setup test'}); it stays in the framework: ${t.error?.split('\n')[0] ?? ''}`);
    }
    withEmittedRun(report, { tests, durationMs });
    if (dropped.length === 0) return { report, dropped: [] };

    // Drop the scenarios whose tests failed twice, rebuild the accounting the
    // same way the runtime did, and re-scaffold so the zip has no failing test.
    report.emittedFailed = [...(report.emittedFailed ?? []), ...dropped];
    report.scenarios = report.scenarios.filter((s) => !removeScenarios.has(s.name));
    for (const d of dropped) log(`Dropped from the framework (emitted-spec check failed twice): "${d.scenario}": ${d.error.split('\n')[0] ?? ''}`);
    rebuildAccounting(report, opts.requirements, log, removeScenarios, dropped, emittedTraces);
    unlink();
    cleanRunFiles(frameworkDir);
    fs.rmSync(frameworkDir, { recursive: true, force: true });
    opts.rescaffold(report);
    // The re-scaffold regenerates the data files from the report; the failed
    // cases (rule-derived ones included) come out again.
    pruneDatasetCases(frameworkDir, removedCases);
    return { report, dropped };
  } finally {
    unlink();
    cleanRunFiles(frameworkDir);
  }
}
