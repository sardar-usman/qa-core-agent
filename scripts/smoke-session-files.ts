/**
 * Locks session files and honest zip messages (CLAUDE.md invariant 70,
 * src/agent/zip-framework.ts RUN_OUTPUT_DIRS, src/agent/credential-leak.ts,
 * src/agent/framework-zip.ts, src/agent/emitted-check.ts,
 * scripts/recheck-run.ts, scripts/credential-leak-scan.ts).
 *
 * Run 4b0e43: the emitted-spec check ran the auth setup inside the framework
 * tree, playwright/.auth/user.json was left there, and the zip was refused
 * only because saucedemo's session cookie equals the username. On a site
 * whose cookie is a random token the value grep would miss it and a live
 * session would ship. The fixture here sets a random-token cookie, so only
 * the by-path rules can catch it.
 *
 *   A. every zip leaves out playwright/.auth/, test-results/,
 *      playwright-report/ and blob-report/, file or buffer, whatever the
 *      caller's exclude list says.
 *   B. a fixture run with an auth setup: the emitted check passes, says in
 *      one line what it removed, the tree no longer has the folders, the zip
 *      is written and unzip -l lists none of them.
 *   C. a planted playwright/.auth/user.json whose content matches no env
 *      value refuses the zip by path and names the file, with or without an
 *      env account; the report records zipRefused, never a value.
 *   D. the zip messages: no "Wrote complete framework zip" and no "Run the
 *      framework" lines on a refusal, exit code 1; the CLI prints only these.
 *   E. scripts/recheck-run.ts as a child process: emitted check, zip, exit 0,
 *      nothing written into the source run directory; bad --out exits 2.
 *   F. scripts/credential-leak-scan.ts reports a session file by path in a
 *      folder and inside a zip, and names a run whose zip was refused.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { frameworkDirName, scaffold } from '../src/agent/scaffold.js';
import { emittedCheckStage, findAgentRoot } from '../src/agent/emitted-check.js';
import { RUN_ARTIFACTS, RUN_OUTPUT_DIRS, zipFrameworkToBuffer, zipFrameworkToFile } from '../src/agent/zip-framework.js';
import { CredentialLeakError, SESSION_FILE_FIELD, assertNoCredentialLeak } from '../src/agent/credential-leak.js';
import { runFrameworkLines, writeFrameworkZip, zipExitCode, zipResultLines } from '../src/agent/framework-zip.js';
import { reconcile } from '../src/agent/reconcile.js';
import type { RunReport, Scenario, SelectorRecord } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

const agentRoot = findAgentRoot();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-session-files-'));
// Never let the developer's own shell leak into a check.
for (const k of Object.keys(process.env)) if (/^QA_CORE_(TEST_|AUTH_|WRONG_PASSWORD)/.test(k)) delete process.env[k];

const unzipList = (zip: string): string[] => {
  const r = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`unzip -Z1 failed: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
};
const unzipListBuffer = (buf: Buffer): string[] => { const f = path.join(tmpRoot, `b-${crypto.randomUUID()}.zip`); fs.writeFileSync(f, buf); return unzipList(f); };
/**
 * A child process run asynchronously: the fixture site is served from this
 * process, so a spawnSync would block the server the child must reach.
 */
function runChild(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 240_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
const RUN_OUTPUT_RE = /(^|\/)(playwright\/\.auth|test-results|playwright-report|blob-report)(\/|$)/;
const shaTree = (dir: string): string => {
  const out: string[] = [];
  const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${path.relative(dir, p)} ${crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')}`); } };
  walk(dir);
  return out.sort().join('\n');
};

/* ─── the fixture site: a login whose session cookie is a random token ─── */
const USER = 'qa.session@fixture.test';
const PASS = 'Session-Fixture-Secret-7';
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
  if (ok) document.cookie = 'session=' + Math.random().toString(36).slice(2) + Date.now().toString(36) + '; path=/';
  document.querySelector('main').appendChild(d);
});
</script></body></html>`;
const homeHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body><main><h1 data-testid="page-title">Hand Tools</h1></main></body></html>';
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(u.pathname === '/login.html' ? loginHtml : homeHtml);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const HOST_USER = 'QA_CORE_TEST_USER_127_0_0_1';
const HOST_PASS = 'QA_CORE_TEST_PASS_127_0_0_1';

const emailInput: SelectorRecord = { level: 'label', arg: 'Email', intent: 'email input' };
const passwordInput: SelectorRecord = { level: 'label', arg: 'Password', intent: 'password input' };
const loginButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Login' }, intent: 'login button' };
const alertBox: SelectorRecord = { level: 'role', arg: { role: 'alert' }, intent: 'status alert' };
const title: SelectorRecord = { level: 'testid', arg: 'page-title', intent: 'page title' };
function buildReport(): RunReport {
  const scenarios: Scenario[] = [
    { name: 'logged in with the test account', category: 'happy', feature: 'account', steps: [
      { kind: 'navigate', url: `${base}/login.html` },
      { kind: 'fill', target: emailInput, value: '', credential: 'user' },
      { kind: 'fill', target: passwordInput, value: '', credential: 'pass' },
      { kind: 'click', target: loginButton },
      { kind: 'assert', name: 'w', assertion: { type: 'toContainText', target: alertBox, text: 'Welcome back', timeout: 5000 } },
    ] },
    { name: 'listing shows the hand tools heading', category: 'happy', feature: 'catalogue', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'assert', name: 't', assertion: { type: 'toHaveText', target: title, text: 'Hand Tools', timeout: 5000 } },
    ] },
  ];
  const r: RunReport = {
    url: `${base}/`, language: 'ts', scenarios,
    plan: scenarios.map((s) => ({ name: s.name, category: s.category, rationale: 'fails if it breaks', feature: s.feature })),
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), findings: [],
  };
  r.reconciliation = reconcile(r);
  return r;
}

try {
  /* ─── A. every zip leaves out the run output folders ──────────────────── */
  {
    check('A1. RUN_OUTPUT_DIRS is the four folders, exported beside RUN_ARTIFACTS',
      JSON.stringify(RUN_OUTPUT_DIRS) === JSON.stringify(['playwright/.auth', 'test-results', 'playwright-report', 'blob-report']) && RUN_ARTIFACTS.length > 0);
    const dir = path.join(tmpRoot, 'a', 'fixture-automation-framework');
    const put = (rel: string, body = 'x'): void => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
    put('tests/a.spec.ts', 'test');
    put('playwright.config.ts', 'config');
    put('playwright/.auth/user.json', '{"cookies":[{"name":"session","value":"r4nd0m-t0ken"}]}');
    put('test-results/run/trace.zip');
    put('playwright-report/index.html', '<html></html>');
    put('blob-report/report.zip');
    put('sub/test-results/nested.txt');
    const fromBuf = unzipListBuffer(zipFrameworkToBuffer(dir));
    const fromBufNoExclude = unzipListBuffer(zipFrameworkToBuffer(dir, undefined, []));
    const zipFile = path.join(tmpRoot, 'a', 'out.zip');
    zipFrameworkToFile(dir, zipFile);
    const fromFile = unzipList(zipFile);
    zipFrameworkToFile(dir, zipFile, undefined, []);
    const fromFileNoExclude = unzipList(zipFile);
    const ok = (entries: string[]): boolean => entries.length > 0 && !entries.some((e) => RUN_OUTPUT_RE.test(e)) && entries.includes('fixture-automation-framework/tests/a.spec.ts') && entries.includes('fixture-automation-framework/playwright.config.ts');
    check('A2. the buffer zip lists none of the four folders and keeps the framework files', ok(fromBuf), JSON.stringify(fromBuf));
    check('A3. the buffer zip leaves them out even with an empty exclude list', ok(fromBufNoExclude), JSON.stringify(fromBufNoExclude));
    check('A4. the file zip lists none of them (it used to take no exclude list at all)', ok(fromFile), JSON.stringify(fromFile));
    check('A5. the file zip leaves them out even with an empty exclude list', ok(fromFileNoExclude), JSON.stringify(fromFileNoExclude));
  }

  /* ─── B. a fixture run with an auth setup: check, cleanup, zip ────────── */
  const runDir = path.join(tmpRoot, 'b-run');
  fs.mkdirSync(runDir, { recursive: true });
  {
    process.env[HOST_USER] = USER;
    process.env[HOST_PASS] = PASS;
    const report = buildReport();
    const frameworkDir = path.join(tmpRoot, 'b-emit', 'fixture-automation-framework');
    const opts = { outDir: frameworkDir, siteName: 'fixture' };
    scaffold({ report, ...opts });
    check('B0. the scaffold activates the auth setup for the marked login', fs.existsSync(path.join(frameworkDir, 'tests', 'auth.setup.ts')));
    const lines: string[] = [];
    await emittedCheckStage({ report, frameworkDir, agentRoot, rescaffold: (r) => { scaffold({ report: r, ...opts }); }, log: (l) => lines.push(l) });
    const tests = report.emittedRun?.tests ?? [];
    check('B1. the emitted check passes, the auth setup included',
      report.emittedRun?.inconclusive !== true && tests.length >= 3 && tests.every((t) => t.status === 'passed') && tests.some((t) => /authenticate/.test(t.name)), JSON.stringify(tests.map((t) => `${t.status}:${t.name}`)));
    const cleanup = lines.filter((l) => l.startsWith('Emitted-spec check: removed') || l.startsWith('Emitted-spec check: no session'));
    check('B2. one console line says the check removed playwright/.auth/ and test-results/', cleanup.length === 1 && cleanup[0]!.includes('playwright/.auth/') && cleanup[0]!.includes('test-results/'), JSON.stringify(cleanup));
    const left = RUN_OUTPUT_DIRS.filter((d) => fs.existsSync(path.join(frameworkDir, d)));
    check('B3. the framework tree no longer has playwright/.auth/, test-results/, playwright-report/ or blob-report/', left.length === 0 && !fs.existsSync(path.join(frameworkDir, 'playwright')), JSON.stringify(left));
    const outcome = writeFrameworkZip({ frameworkDir, destDir: runDir, zipRootName: 'fixture-automation-framework', runDir, report });
    check('B4. the zip is written', outcome.written !== undefined && outcome.refused === undefined && fs.existsSync(path.join(runDir, 'fixture-automation-framework.zip')) && report.zipRefused === undefined, JSON.stringify({ refused: outcome.refused, failed: outcome.failed }));
    const entries = outcome.written ? unzipList(outcome.written.zipPath) : [];
    check('B5. unzip -l lists no playwright/.auth, test-results or report folders, and lists the specs and the auth setup',
      entries.length > 5 && !entries.some((e) => RUN_OUTPUT_RE.test(e)) && entries.includes('fixture-automation-framework/tests/auth.setup.ts') && entries.some((e) => e.endsWith('account.spec.ts')), JSON.stringify(entries));
    fs.writeFileSync(path.join(runDir, 'run-report.json'), JSON.stringify(report, null, 2));
  }

  /* ─── C. a planted session file refuses the zip by path ───────────────── */
  {
    const frameworkDir = path.join(tmpRoot, 'c-emit', 'fixture-automation-framework');
    scaffold({ report: buildReport(), outDir: frameworkDir, siteName: 'fixture' });
    fs.mkdirSync(path.join(frameworkDir, 'playwright', '.auth'), { recursive: true });
    const planted = JSON.stringify({ cookies: [{ name: 'session', value: crypto.randomUUID(), domain: '127.0.0.1', path: '/' }], origins: [] });
    fs.writeFileSync(path.join(frameworkDir, 'playwright', '.auth', 'user.json'), planted);
    check('C0. the planted content matches no env value', !planted.includes(USER) && !planted.includes(PASS));
    const destDir = path.join(tmpRoot, 'c-run');
    fs.mkdirSync(destDir, { recursive: true });
    const report = buildReport();
    const outcome = writeFrameworkZip({ frameworkDir, destDir, zipRootName: 'fixture-automation-framework', runDir: destDir, report });
    const file = 'framework/playwright/.auth/user.json';
    check('C1. the zip is refused and the refusal names the file',
      outcome.refused !== undefined && outcome.written === undefined && outcome.refused.reason.startsWith('zip refused: a session file was found at framework/playwright/.auth/user.json') && outcome.refused.reason.endsWith('; nothing was zipped'), outcome.refused?.reason);
    check('C2. no zip is on disk', fs.readdirSync(destDir).filter((f) => f.endsWith('.zip') || f.endsWith('.tmp')).length === 0, JSON.stringify(fs.readdirSync(destDir)));
    check('C3. report.zipRefused records the file and the field, never a value',
      report.zipRefused?.files.length === 1 && report.zipRefused.files[0]!.file === file && report.zipRefused.files[0]!.field === SESSION_FILE_FIELD && report.zipRefused.reason === outcome.refused?.reason
      && !JSON.stringify(report.zipRefused).includes(USER) && !JSON.stringify(report.zipRefused).includes(PASS), JSON.stringify(report.zipRefused));
    let noEnv: unknown = null;
    try { assertNoCredentialLeak({ frameworkDir, env: {} }); } catch (err) { noEnv = err; }
    check('C4. with no env account at all the guard still refuses the session file', noEnv instanceof CredentialLeakError && (noEnv as CredentialLeakError).hits.some((h) => h.file === file && h.field === SESSION_FILE_FIELD), (noEnv as Error | null)?.message);
    const valueOnly = new CredentialLeakError([{ file: 'framework/x.json', field: '$.a', count: 1 }]);
    check('C5. a value-only refusal reads exactly as before', valueOnly.message === 'zip refused: a test-account value was found in framework/x.json ($.a); nothing was zipped', valueOnly.message);

    /* ─── D. the zip messages tell the truth ──────────────────────────── */
    const refusedLines = [...zipResultLines(outcome, { outDirRel: 'out/run' }), ...runFrameworkLines(outcome, { outDirRel: 'out/run' })].join('\n');
    check('D1. a refusal prints the refusal line, no "Wrote complete framework zip" and no "Run the framework" lines',
      refusedLines.includes(`✗ ${outcome.refused?.reason}`) && !refusedLines.includes('Wrote complete framework zip') && !refusedLines.includes('Run the framework') && !refusedLines.includes('npx playwright test'), refusedLines);
    check('D2. a refusal exits non-zero', zipExitCode(outcome) === 1);
    const failedLines = [...zipResultLines({ failed: 'zip exited with code 12' }, { outDirRel: 'out/run' }), ...runFrameworkLines({ failed: 'x' }, { outDirRel: 'out/run' })].join('\n');
    check('D3. a zip that failed for another reason is not claimed either, and exits non-zero', failedLines.includes('✗ zip not written: zip exited with code 12') && !failedLines.includes('Wrote complete') && !failedLines.includes('Run the framework') && zipExitCode({ failed: 'x' }) === 1, failedLines);
    const ok = { written: { zipPath: '/x/f.zip', sizeBytes: 2048, buffer: Buffer.alloc(0) } };
    const okLines = [...zipResultLines(ok, { outDirRel: 'out/run', zipRel: 'out/run/f.zip' }), ...runFrameworkLines(ok, { outDirRel: 'out/run', zipRel: 'out/run/f.zip' })].join('\n');
    check('D4. a written zip prints both, after the fact, and exits 0', okLines.includes('Wrote complete framework zip to out/run/') && okLines.includes('Run the framework:') && okLines.includes('Or share the zip: out/run/f.zip') && zipExitCode(ok) === 0, okLines);
    const cli = fs.readFileSync(path.join(agentRoot, 'src', 'cli', 'explore.ts'), 'utf8');
    check('D5. the CLI prints these lines only: it holds no "Wrote complete framework zip" or "Run the framework" literal, and its exit code is the zip outcome',
      !cli.includes('Wrote complete framework zip') && !cli.includes("'\\nRun the framework:'") && !cli.includes('Run the framework:') && cli.includes('process.exitCode = zipExitCode(zipOutcome);') && cli.includes('runFrameworkLines(zipOutcome') && cli.includes('writeFrameworkZip({ frameworkDir, destDir: outDir, zipRootName, runDir: outDir, report: result })'));
    const gw = fs.readFileSync(path.join(agentRoot, 'src', 'server', 'run-explore.ts'), 'utf8');
    check('D6. the gateway zips through the same writer and fails loudly without a zip', gw.includes('writeFrameworkZip({ frameworkDir, destDir: outDir, zipRootName, runDir: outDir, report })') && gw.includes('if (!zipOutcome.written) {') && gw.includes('throw new Error(line);'));
  }

  /* ─── E. scripts/recheck-run.ts as a child process ────────────────────── */
  {
    const before = shaTree(runDir);
    const out = path.join(tmpRoot, 'e-out');
    const tsx = path.join(agentRoot, 'node_modules', '.bin', 'tsx');
    const script = path.join(agentRoot, 'scripts', 'recheck-run.ts');
    const env = { ...process.env, [HOST_USER]: USER, [HOST_PASS]: PASS };
    const r = await runChild(tsx, [script, runDir, '--out', out], { cwd: agentRoot, env });
    const lines = r.stdout.split('\n');
    check('E1. recheck-run exits 0, its first line names the source and the new directory', r.status === 0 && lines[0]!.startsWith('recheck: ') && lines[0]!.includes('no model call'), `${r.status}\n${r.stdout}\n${r.stderr}`);
    check('E2. it runs the emitted check with the host-scoped account (names only), removes the session, and writes the zip',
      r.stdout.includes(`${HOST_USER} / ${HOST_PASS} (host-scoped)`) && /Emitted-spec check: (\d+) of \1 test\(s\) passed/.test(r.stdout) && r.stdout.includes('removed playwright/.auth/') && r.stdout.includes('Wrote complete framework zip') && !r.stdout.includes(USER) && !r.stdout.includes(PASS), r.stdout);
    const zip = path.join(out, `${frameworkDirName(base)}.zip`);
    const entries = fs.existsSync(zip) ? unzipList(zip) : [];
    check('E3. the new directory holds the zip and the report; the zip lists no session or report folder',
      fs.existsSync(path.join(out, 'run-report.json')) && entries.length > 5 && !entries.some((e) => RUN_OUTPUT_RE.test(e)), JSON.stringify({ files: fs.existsSync(out) ? fs.readdirSync(out) : null, entries }));
    check('E4. nothing in the source run directory changed', shaTree(runDir) === before);
    const inside = await runChild(tsx, [script, runDir, '--out', path.join(runDir, 'again')], { cwd: agentRoot, env });
    const notEmpty = await runChild(tsx, [script, runDir, '--out', out], { cwd: agentRoot, env });
    const noOut = await runChild(tsx, [script, runDir], { cwd: agentRoot, env });
    check('E5. an --out inside the run directory, a non-empty --out, or no --out exits 2 and writes nothing',
      inside.status === 2 && notEmpty.status === 2 && noOut.status === 2 && !fs.existsSync(path.join(runDir, 'again')) && shaTree(runDir) === before, JSON.stringify([inside.status, notEmpty.status, noOut.status, inside.stderr, notEmpty.stderr, noOut.stderr]));
  }

  /* ─── F. the scan reports session files by path, and refused zips ────── */
  {
    const scanRoot = path.join(tmpRoot, 'f-output');
    const run = path.join(scanRoot, 'fixture-com', '20261013T000000Z-abcdef');
    const fw = path.join(run, 'tree', 'fixture-automation-framework');
    fs.mkdirSync(path.join(fw, 'playwright', '.auth'), { recursive: true });
    fs.writeFileSync(path.join(fw, 'playwright', '.auth', 'user.json'), JSON.stringify({ cookies: [{ name: 'session', value: crypto.randomUUID() }] }));
    fs.writeFileSync(path.join(fw, 'README.md'), '# fixture');
    const z = spawnSync('zip', ['-rqX', path.join(run, 'fixture-automation-framework.zip'), 'fixture-automation-framework'], { cwd: path.join(run, 'tree') });
    const refusedReport = { url: base, zipRefused: { reason: 'zip refused: a session file was found at framework/playwright/.auth/user.json (playwright/.auth/ is never zipped, whatever it holds); nothing was zipped', files: [{ file: 'framework/playwright/.auth/user.json', field: SESSION_FILE_FIELD }] } };
    fs.writeFileSync(path.join(run, 'run-report.json'), JSON.stringify(refusedReport));
    const scan = spawnSync(path.join(agentRoot, 'node_modules', '.bin', 'tsx'), [path.join(agentRoot, 'scripts', 'credential-leak-scan.ts'), scanRoot], { cwd: agentRoot, encoding: 'utf8', env: { ...process.env, [HOST_USER]: USER, [HOST_PASS]: PASS } });
    const outText = scan.stdout;
    check('F1. a session file in a run folder is a hit by path, whatever it holds',
      z.status === 0 && scan.status === 0 && outText.includes('fixture-com/20261013T000000Z-abcdef/tree/fixture-automation-framework/playwright/.auth/user.json  session file, refused by path whatever it holds'), outText);
    check('F2. a session file inside a zip is a hit by path', outText.includes('fixture-automation-framework.zip!fixture-automation-framework/playwright/.auth/user.json  session file, refused by path whatever it holds'), outText);
    check('F3. a run whose report records a refused zip is named, so "no hits" never reads as a scanned zip',
      outText.includes('1 run(s) record a refused zip') && outText.includes('fixture-com/20261013T000000Z-abcdef/run-report.json: refused over framework/playwright/.auth/user.json') && !outText.includes('no hits'), outText);
  }
} finally {
  server.close();
  delete process.env[HOST_USER];
  delete process.env[HOST_PASS];
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: playwright/.auth, test-results and the report folders never reach a zip: excluded by path from every zip, removed by the emitted-spec check, refused by the guard whatever they hold, and reported by the scan; zip messages say only what happened, and recheck-run re-checks an existing run for $0 without touching it.');
