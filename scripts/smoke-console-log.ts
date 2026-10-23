/**
 * smoke-console-log: the CLI saves its own console (invariant 75; run
 * 59540f's folder had no console.log, so the preflight result, the map
 * reuse line, Rule coverage and Cost existed in no artifact).
 *
 *   A. The capture itself, with fixture streams: lines printed before the
 *      run folder is known are flushed on attach; a value split across two
 *      writes is masked as one line; a carriage-return status, \r\n and a
 *      Buffer each end a line; the tail is written on flush; detach stops
 *      the file; append keeps an earlier log; a failed write says so on the
 *      real stderr; restore puts write() back.
 *   B. A fixture CLI run to the zip, as a child process, with a local site
 *      and a local stand-in for the Anthropic API (no request leaves the
 *      machine): console.log holds every stdout and stderr line in order; a
 *      fake credential the fixture Explorer narrates is printed on the
 *      console and redacted in the file (and in no file of the run folder);
 *      the zip listing holds no console.log; the robots line and
 *      robotsSkipped reach the console, discovery.json and the report.
 *   C. SIGINT mid-run: console.log ends with the interrupt line.
 *   D. A login preflight stop that echoes the account: redacted in the file.
 *   E. A billing error and a persistent API failure: each stop line is the
 *      last line of the file. (A cost ceiling stop ends through the normal
 *      path B covers: the run is salvaged and the CLI finishes.)
 *
 *   npx tsx scripts/smoke-console-log.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CONSOLE_LOG_FILENAME, startConsoleCapture } from '../src/cli/console-log.js';
import { CREDENTIAL_REDACTION } from '../src/agent/credential-leak.js';
import { RUN_ARTIFACTS } from '../src/agent/zip-framework.js';
import type { RunReport } from '../src/agent/trace.js';
import { startFakeAnthropic, type FakeAnthropicScript } from './lib/fake-anthropic.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const SECRET = 'Zq81-fixture-pass';
const agentCwd = process.cwd();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-console-log-'));
const readLines = (file: string): string[] => fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);

/* ─── A. the capture, with fixture streams ───────────────────────────────── */
{
  const outRaw: string[] = [];
  const errRaw: string[] = [];
  const stdout = { write: (chunk: string | Uint8Array): boolean => { outRaw.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()); return true; } };
  const stderr = { write: (chunk: string | Uint8Array): boolean => { errRaw.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()); return true; } };
  const originalOut = stdout.write;
  const cap = startConsoleCapture({ stdout: stdout as never, stderr: stderr as never, env: { QA_CORE_TEST_PASS_FIXTURE_EXAMPLE: SECRET } });
  stdout.write('before the folder is known\n');
  stderr.write('a warning before the folder\n');
  const dir = path.join(tmpRoot, 'unit');
  const file = cap.attach(dir);
  check('A1. attach returns <run dir>/console.log', file === path.join(dir, CONSOLE_LOG_FILENAME) && cap.file === file, file);
  stdout.write(`split ${SECRET.slice(0, 7)}`);
  stdout.write(`${SECRET.slice(7)} end\n`);
  stdout.write('      · thinking…\r');
  stderr.write('a stderr line after the ticker\n');
  stdout.write('      → begin_scenario({})\n');
  stdout.write('crlf line\r\n');
  stdout.write('split crlf\r');
  stdout.write('\nafter split crlf\n');
  stdout.write(Buffer.from('buffer line\n') as never);
  stderr.write('error line\n');
  stdout.write('no newline yet');
  cap.flush();
  const lines = readLines(file);
  const want = ['before the folder is known', 'a warning before the folder', `split ${CREDENTIAL_REDACTION} end`, '      · thinking…', 'a stderr line after the ticker', '      → begin_scenario({})', 'crlf line', 'split crlf', 'after split crlf', 'buffer line', 'error line', 'no newline yet'];
  check('A2. the file holds every line in order: the buffered ones first, a split value masked as one line, a ticker closed at once (before a later stderr line), \\r\\n in one write or split across two ending one line, a Buffer, the tail on flush', JSON.stringify(lines) === JSON.stringify(want), JSON.stringify(lines));
  check('A3. the console itself is untouched: the streams received the raw text, the value unmasked', outRaw.join('').includes(SECRET) && errRaw.join('') === 'a warning before the folder\na stderr line after the ticker\nerror line\n', JSON.stringify(outRaw));
  cap.detach();
  stdout.write('after detach\n');
  check('A4. after detach nothing more reaches the file', !fs.readFileSync(file, 'utf8').includes('after detach') && cap.file === null);
  const cap2 = startConsoleCapture({ stdout: stdout as never, stderr: stderr as never, env: {} });
  stdout.write('second capture\n');
  cap2.attach(dir, { append: true });
  check('A5. append keeps the earlier log and adds the new lines', readLines(file).length === want.length + 1 && readLines(file).at(-1) === 'second capture', JSON.stringify(readLines(file)));
  // A write failure is loud: the copy stops and says so on the real stderr.
  const gone = path.join(tmpRoot, 'gone');
  cap2.attach(gone);
  fs.rmSync(gone, { recursive: true, force: true });
  fs.mkdirSync(path.join(gone, CONSOLE_LOG_FILENAME), { recursive: true }); // a directory where the file was: appendFileSync throws
  const errBefore = errRaw.length;
  stdout.write('this line cannot be written\n');
  check('A6. a failed write says so once on the real stderr and stops the copy, never a silently shorter log', errRaw.slice(errBefore).some((l) => l.startsWith('console.log copy stopped: could not write') && l.includes('the lines after this one are not in the file')) && cap2.file === null, JSON.stringify(errRaw.slice(errBefore)));
  cap2.restore();
  cap.restore();
  check('A7. restore puts the streams\' own write() back', stdout.write === originalOut);
  check('A8. console.log is a run artifact excluded from every zip by name', RUN_ARTIFACTS.includes(CONSOLE_LOG_FILENAME));
  // A chunk the capture cannot read is never lost quietly: a marker line in the file, a note on the real stderr, the console still written.
  const seen: unknown[] = [];
  const errs: string[] = [];
  const out3 = { write: (chunk: unknown): boolean => { seen.push(chunk); return true; } };
  const err3 = { write: (chunk: unknown): boolean => { errs.push(String(chunk)); return true; } };
  const cap3 = startConsoleCapture({ stdout: out3 as never, stderr: err3 as never, env: {} });
  const dir3 = path.join(tmpRoot, 'unit-bad-chunk');
  const file3 = cap3.attach(dir3);
  const bad = { toString(): string { throw new Error('unreadable chunk'); } };
  out3.write(bad);
  out3.write('the next line\n');
  cap3.restore();
  check('A9. an unreadable chunk leaves a marker line in the file and a note on the real stderr, the console write still happens, and later lines still arrive',
    JSON.stringify(readLines(file3)) === JSON.stringify(['[console.log copy: a printed chunk could not be recorded (unreadable chunk)]', 'the next line']) && errs.some((e) => e.startsWith('console.log copy: a printed chunk could not be recorded')) && seen[0] === bad,
    JSON.stringify({ lines: readLines(file3), errs }));
}

/* ─── the fixture site and the child-process runs ─────────────────────────── */
const page = (title: string, body: string): string => `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const ACCOUNT_USER = 'fixture-user-Kp33@example.test';
const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /auth\n'); return; }
  if (u.pathname === '/sitemap.xml') { res.writeHead(404); res.end(''); return; }
  if (u.pathname === '/contact') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('Contact', '<h1>Contact</h1><a href="/">Home</a>')); return; }
  if (u.pathname === '/login' && req.method === 'POST') {
    // A rejection that echoes the account: the preflight stop line carries it.
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('Login', `<h1>Login</h1><div class="alert alert-danger" role="alert">No account found for ${ACCOUNT_USER}</div>`));
    return;
  }
  if (u.pathname === '/login') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page('Login', '<h1>Login</h1><form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email"><label for="password">Password</label><input id="password" name="password" type="password"><button type="submit">Login</button></form>'));
    return;
  }
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('Shop', '<h1>Shop</h1><a href="/contact">Contact</a> <a href="/auth/login">Sign in</a>')); return; }
  res.writeHead(404); res.end('not found');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const site = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const HOME = 'the home page shows its heading';
const CONTACT = 'the contact page shows its heading';
const DASH = '\u2014';
const plannerScript = [
  `<plan>\n1. [shop][happy] ${HOME} ${DASH} the landing heading renders\n</plan>`,
  `<plan>\n1. [contact][happy] ${CONTACT} ${DASH} the contact heading renders\n</plan>`,
];
const explorerScript: FakeAnthropicScript['explorer'] = [
  [{ type: 'text', text: `Noting the account password ${SECRET} before the first scenario.` }, { type: 'tool_use', name: 'begin_scenario', input: { name: HOME, category: 'happy', feature: 'shop' } }],
  [{ type: 'tool_use', name: 'navigate', input: { url: `${site}/` } }],
  [{ type: 'tool_use', name: 'assert', input: { type: 'toBeVisible', role: 'heading', name: 'Shop', intent: 'shop heading', timeout: 10000 } }],
  [{ type: 'tool_use', name: 'end_scenario', input: {} }],
  [{ type: 'tool_use', name: 'begin_scenario', input: { name: CONTACT, category: 'happy', feature: 'contact' } }],
  [{ type: 'tool_use', name: 'navigate', input: { url: `${site}/contact` } }],
  [{ type: 'tool_use', name: 'assert', input: { type: 'toBeVisible', role: 'heading', name: 'Contact', intent: 'contact heading', timeout: 10000 } }],
  [{ type: 'tool_use', name: 'end_scenario', input: {} }],
  [{ type: 'tool_use', name: 'finish', input: { summary: 'both headings checked' } }],
];
const criticScript = [`[\n  { "scenario": "${HOME}", "verdict": "pass", "reasons": ["the heading is asserted"], "required_fixes": [] },\n  { "scenario": "${CONTACT}", "verdict": "pass", "reasons": ["the heading is asserted"], "required_fixes": [] }\n]\n<summary>Both scenarios assert a visible heading.</summary>`];

interface ChildRun { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; cwd: string; runDir: string | null }

/** The child's environment: no test-account value, no model override, no ceiling override from the parent. */
function childEnv(extra: Record<string, string>, baseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('QA_CORE_') && !k.startsWith('ANTHROPIC_')) env[k] = v;
  return { ...env, ANTHROPIC_API_KEY: 'fixture-key-never-sent', ANTHROPIC_BASE_URL: baseUrl, ...extra };
}

/** Spawn the CLI (node with the tsx loader, one process, so a signal reaches the runtime's handler). */
function runCli(label: string, args: string[], env: NodeJS.ProcessEnv, onStart?: (child: ReturnType<typeof spawn>) => void): Promise<ChildRun> {
  const cwd = path.join(tmpRoot, label);
  fs.mkdirSync(cwd, { recursive: true });
  return new Promise((resolve) => {
    // The loader resolved from the agent repo: the child's cwd is a temp dir with no node_modules.
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(agentCwd, 'src/cli/explore.ts'), ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    onStart?.(child);
    child.on('close', (code, signal) => {
      const project = path.join(cwd, 'output', '127-0-0-1');
      const runs = fs.existsSync(project) ? fs.readdirSync(project).filter((d) => d !== 'latest' && d !== 'latest.json' && fs.statSync(path.join(project, d)).isDirectory()) : [];
      resolve({ code, signal, stdout, stderr, cwd, runDir: runs.length === 1 ? path.join(project, runs[0]!) : null });
    });
  });
}

/** Split printed text the way the capture does: \n, \r\n and a lone \r each end a line. */
const printedLines = (text: string): string[] => {
  const parts = text.split(/\r\n|\n|\r/);
  if (parts.at(-1) === '') parts.pop();
  return parts;
};
const masked = (l: string): string => l.split(SECRET).join(CREDENTIAL_REDACTION).split(ACCOUNT_USER).join(CREDENTIAL_REDACTION);
/** Is `sub` an in-order subsequence of `all`? */
const inOrder = (sub: string[], all: string[]): boolean => {
  let i = 0;
  for (const l of all) if (i < sub.length && l === sub[i]) i++;
  return i === sub.length;
};
const filesUnder = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));

try {
  /* ─── B. a fixture CLI run to the zip ─────────────────────────────────── */
  {
    const api = await startFakeAnthropic({ planner: plannerScript, explorer: explorerScript, critic: criticScript });
    try {
      const run = await runCli('normal', [`${site}/`, '--discover', '--features', 'login', '--no-replay', '--no-stability', '--no-emitted-check'],
        childEnv({ QA_CORE_TEST_USER_FIXTURE_EXAMPLE: 'nobody@fixture.example', QA_CORE_TEST_PASS_FIXTURE_EXAMPLE: SECRET }, api.baseUrl));
      console.log(`  B run: exit ${String(run.code)}; model calls ${JSON.stringify(api.calls)}; run dir ${run.runDir ? path.relative(run.cwd, run.runDir) : '(none)'}`);
      if (run.code !== 0) console.log(run.stdout.slice(-3000), run.stderr.slice(-3000));
      const logFile = run.runDir ? path.join(run.runDir, CONSOLE_LOG_FILENAME) : '';
      const exists = !!run.runDir && fs.existsSync(logFile);
      check('B1. the run completes (exit 0) and writes console.log in its run folder', run.code === 0 && exists, `exit ${String(run.code)}`);
      check('B2. every tool call the fixture Explorer drove returned ok (standing rule 7), and every scripted call was made', api.toolErrors.length === 0 && api.calls.explorer === explorerScript!.length && api.calls.planner === 2 && api.calls.critic === 1 && api.calls.other === 0, JSON.stringify({ errors: api.toolErrors, calls: api.calls }));
      if (exists) {
        const file = readLines(logFile);
        const out = printedLines(run.stdout).map(masked);
        const err = printedLines(run.stderr).map(masked);
        check('B3. console.log holds every stdout and every stderr line the CLI printed, each stream in order, nothing else', file.length === out.length + err.length && inOrder(out, file) && inOrder(err, file), JSON.stringify({ file: file.length, out: out.length, err: err.length }));
        check('B4. lines printed before the run folder existed are there, first (the banner)', file[0]?.startsWith('▸ Exploring ') === true && file.some((l) => l.startsWith('  output:   output/127-0-0-1/')), JSON.stringify(file.slice(0, 4)));
        check('B5. the fake credential was printed on the console (the model narrated it) and is redacted in console.log',
          run.stdout.includes(SECRET) && !fs.readFileSync(logFile, 'utf8').includes(SECRET) && file.some((l) => l.includes(`Noting the account password ${CREDENTIAL_REDACTION}`)), file.filter((l) => l.includes('Noting')).join(' | '));
        const leaking = filesUnder(path.join(run.cwd, 'output')).filter((f) => !f.endsWith('.zip') && fs.readFileSync(f, 'utf8').includes(SECRET));
        check('B6. no file under output/ holds the value (console.log, events.jsonl, the report)', leaking.length === 0, JSON.stringify(leaking));
        check('B7. the end of the run is in the file: the zip line, the cost line and the run steps', file.some((l) => l.startsWith('Wrote complete framework zip')) && file.some((l) => l.startsWith('Cost: ')) && file.some((l) => l.includes('npx playwright test')), JSON.stringify(file.slice(-12)));
        const zip = fs.readdirSync(run.runDir!).find((f) => f.endsWith('.zip'));
        const listing = zip ? spawnSync('unzip', ['-Z1', path.join(run.runDir!, zip)], { encoding: 'utf8' }) : null;
        const entries = (listing?.stdout ?? '').split('\n').filter(Boolean);
        console.log(`  B zip: ${zip ?? '(none)'}, ${entries.length} entries`);
        check('B8. the zip listing holds no console.log', !!zip && listing?.status === 0 && entries.length > 0 && !entries.some((e) => path.basename(e) === CONSOLE_LOG_FILENAME), JSON.stringify(entries));
        // The discovery wiring through the runtime (tasks 2a and 2b): /auth is disallowed, /auth/login is linked from the entry.
        const robotsLine = 'Feature "login": robots.txt disallows its matching path(s) /auth/login (rule Disallow: /auth); not loaded.';
        const report = JSON.parse(fs.readFileSync(path.join(run.runDir!, 'run-report.json'), 'utf8')) as RunReport;
        const discJson = JSON.parse(fs.readFileSync(path.join(run.runDir!, 'discovery.json'), 'utf8')) as { method: string; robotsSkipped?: Array<{ path: string; rule: string }>; warnings: string[] };
        check('B9. the runtime prints the robots line once (console.log has it) and keeps it in the warnings', file.filter((l) => l.trim() === robotsLine).length === 1 && report.discovery?.warnings.includes(robotsLine) === true && discJson.warnings.includes(robotsLine), JSON.stringify(file.filter((l) => l.includes('robots'))));
        check('B10. robotsSkipped holds /auth/login with its rule in run-report.json and discovery.json; the crawl rung found the two pages',
          JSON.stringify(report.discovery?.robotsSkipped) === JSON.stringify([{ path: '/auth/login', rule: '/auth' }]) && JSON.stringify(discJson.robotsSkipped) === JSON.stringify([{ path: '/auth/login', rule: '/auth' }]) && report.discovery?.method === 'crawl' && discJson.method === 'crawl',
          JSON.stringify({ report: report.discovery?.robotsSkipped, json: discJson.robotsSkipped, method: report.discovery?.method }));
        check('B11. both scenarios shipped', report.scenarios.length === 2, JSON.stringify(report.scenarios.map((s) => s.name)));
        check('B12. a discovery run whose per-page cap cut nothing records planTrimmed [] (never absent, which means per-page planning did not run)', Array.isArray(report.planTrimmed) && report.planTrimmed.length === 0, JSON.stringify(report.planTrimmed));
      }
    } finally {
      await api.close();
    }
  }

  /* ─── C. SIGINT mid-run ─────────────────────────────────────────────── */
  {
    const api = await startFakeAnthropic({ planner: plannerScript, explorer: explorerScript, critic: criticScript, hangExplorerCall: 3 });
    try {
      const run = await runCli('sigint', [`${site}/`, '--discover', '--features', 'login', '--no-replay', '--no-stability', '--no-emitted-check'],
        childEnv({ QA_CORE_TEST_PASS_FIXTURE_EXAMPLE: SECRET }, api.baseUrl),
        (child) => { void api.explorerCall(3).then(() => setTimeout(() => child.kill('SIGINT'), 300)); });
      const logFile = run.runDir ? path.join(run.runDir, CONSOLE_LOG_FILENAME) : '';
      const file = run.runDir && fs.existsSync(logFile) ? readLines(logFile) : [];
      console.log(`  C run: exit ${String(run.code)} signal ${String(run.signal)}; last line: ${file.at(-1) ?? '(none)'}`);
      check('C1. SIGINT ends the run (exit 130) and console.log ends with the interrupt line, the resume hint whole',
        run.code === 130 && /^Run stopped: interrupted \(SIGINT\)\. State saved\. Resume with: npm run explore -- --resume /.test(file.at(-1) ?? ''), JSON.stringify({ code: run.code, last: file.at(-1) }));
      check('C2. the lines before the interrupt are there too, the narrated value redacted', file.some((l) => l.includes('→ begin_scenario(')) && file.some((l) => l.includes(`Noting the account password ${CREDENTIAL_REDACTION}`)) && !file.join('\n').includes(SECRET), JSON.stringify(file.slice(-8)));
      check('C3. the checkpoint the interrupt saved sits beside console.log', !!run.runDir && fs.existsSync(path.join(run.runDir, 'checkpoint.json')));
    } finally {
      await api.close();
    }
  }

  /* ─── D. a login preflight stop that echoes the account ───────────────── */
  {
    const api = await startFakeAnthropic({});
    try {
      const run = await runCli('preflight', [`${site}/`, '--login-url', '/login'],
        childEnv({ QA_CORE_TEST_USER_127_0_0_1: ACCOUNT_USER, QA_CORE_TEST_PASS_127_0_0_1: 'Wrong-Kp33-pass' }, api.baseUrl));
      const logFile = run.runDir ? path.join(run.runDir, CONSOLE_LOG_FILENAME) : '';
      const file = run.runDir && fs.existsSync(logFile) ? readLines(logFile) : [];
      const stop = file.find((l) => l.startsWith('Run stopped: the test account did not sign in'));
      console.log(`  D run: exit ${String(run.code)}; stop line in console.log: ${stop ?? '(none)'}`);
      check('D1. the preflight stop (exit 1, no model call) writes console.log beside the minimal report', run.code === 1 && !!run.runDir && fs.existsSync(path.join(run.runDir, 'run-report.json')) && file.length > 0 && api.calls.planner + api.calls.explorer + api.calls.critic + api.calls.other === 0, JSON.stringify({ code: run.code, calls: api.calls }));
      // The preflight masks the page text it echoes at the source (invariant 70); the file holds the line as printed.
      check('D2. the stop line, whose page text named the account, is in the file exactly as printed, and the account value is in no line', !!stop && run.stderr.split('\n').includes(stop) && stop.includes(CREDENTIAL_REDACTION) && !fs.readFileSync(logFile, 'utf8').includes(ACCOUNT_USER), JSON.stringify({ stop }));
    } finally {
      await api.close();
    }
  }

  /* ─── E. a billing error from the API ─────────────────────────────────── */
  {
    const api = await startFakeAnthropic({ plannerError: { status: 400, type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } });
    try {
      const run = await runCli('billing', [`${site}/`, '--discover', '--features', 'login'], childEnv({}, api.baseUrl));
      const logFile = run.runDir ? path.join(run.runDir, CONSOLE_LOG_FILENAME) : '';
      const file = run.runDir && fs.existsSync(logFile) ? readLines(logFile) : [];
      const failed = file.find((l) => l.includes('Exploration failed:'));
      console.log(`  E run: exit ${String(run.code)}; ${failed ?? '(no failure line)'}`);
      check('E1. a billing stop (exit 1) leaves console.log ending with the failure line naming the billing stop and the resume path',
        run.code === 1 && !!failed && /billing\/credit exhaustion/.test(failed) && /Resume with: npm run explore -- --resume /.test(failed) && file.at(-1) === failed, JSON.stringify(file.slice(-3)));
    } finally {
      await api.close();
    }
  }
  {
    // A persistent API failure: the SDK retries the 529 itself, then the run stops the same way.
    const api = await startFakeAnthropic({ plannerError: { status: 529, type: 'overloaded_error', message: 'Overloaded' } });
    try {
      const run = await runCli('api-error', [`${site}/`, '--discover', '--features', 'login'], childEnv({}, api.baseUrl));
      const logFile = run.runDir ? path.join(run.runDir, CONSOLE_LOG_FILENAME) : '';
      const file = run.runDir && fs.existsSync(logFile) ? readLines(logFile) : [];
      const failed = file.find((l) => l.includes('Exploration failed:'));
      console.log(`  E2 run: exit ${String(run.code)}; ${failed ?? '(no failure line)'}`);
      check('E2. a persistent API failure (exit 1) leaves console.log ending with the failure line naming it and the resume path',
        run.code === 1 && !!failed && /persistent API failure/.test(failed) && /Resume with: npm run explore -- --resume /.test(failed) && file.at(-1) === failed, JSON.stringify(file.slice(-3)));
    } finally {
      await api.close();
    }
  }
} finally {
  server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the CLI writes every console line to console.log in the run folder on every end, masked, and never into the zip.');
