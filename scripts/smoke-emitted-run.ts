/**
 * Locks standing rule 4: compiled is not executed. The emitted framework is
 * RUN, in both languages, against a page that satisfies every assertion.
 *
 * What happens here:
 *   1. A fixture run-report uses every emitted shape: navigate, fill (literal
 *      and generated unique data), click, select_option, set_checked,
 *      toHaveURL, toHaveText literal and pattern, toContainText, toHaveValue,
 *      toHaveAttribute pattern, toBeChecked, toHaveCount 0 and atLeast,
 *      capture plus assert_compare with changed, greater on a currency string
 *      and equal against a different target, and a frame chain.
 *   2. A small static site is served from a local port by this process
 *      (node:http, in memory, no files on disk) so the shipped tests have
 *      something real to drive. The assertions are true on that site.
 *   3. scaffold() writes the TS framework and the JS framework into temporary
 *      directories, `npm install` runs in each (npm cache first, the registry
 *      only when the cache cannot satisfy the pins), then `npx playwright test`
 *      with the list and JSON reporters.
 *   4. OK: prints only when Playwright's own exit code is 0 for both languages,
 *      the JSON report shows zero unexpected and zero flaky results, every
 *      scenario passed, and the a11y spec ran and passed.
 *
 * The child runs are spawned asynchronously so this process keeps serving
 * the fixture pages while Playwright drives them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { scaffold } from '../src/agent/scaffold.js';
import type { RunReport, Scenario, SelectorRecord } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── 1. the fixture site, served from memory ───────────────────────────── */

const indexHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Toolshop fixture</title></head>
<body>
<main>
  <h1 data-testid="page-title">Hand Tools</h1>
  <form id="contact" aria-label="Contact form">
    <label for="name">Name</label> <input id="name" name="name">
    <label for="subject">Subject</label>
    <select id="subject" name="subject"><option value="">Choose</option><option value="warranty">Warranty</option><option value="return">Return</option></select>
    <label><input type="checkbox" id="eco" name="eco"> Eco-friendly</label>
    <button type="submit" id="send">Send</button>
  </form>
  <div id="products">
    <a class="card" href="/detail.html" data-test="product-1"><img class="card-img-top" src="/assets/products/sander.svg" alt="Sheet Sander"><h5>Sheet Sander</h5><span class="card-footer">$4.92</span></a>
    <a class="card" href="/detail.html" data-test="product-2"><img class="card-img-top" src="/assets/products/sander.svg" alt="Combination Pliers"><h5>Combination Pliers</h5><span class="card-footer">$14.15</span></a>
  </div>
  <button type="button" id="sort">Sort by price high to low</button>
  <button type="button" id="tok-1">Regenerate</button>
  <iframe id="frame1" title="Sample frame" src="/frame.html"></iframe>
</main>
<script>
  document.getElementById('contact').addEventListener('submit', function (e) {
    e.preventDefault();
    var d = document.createElement('div'); d.setAttribute('role', 'alert'); d.textContent = 'Thanks for your message, ' + document.getElementById('name').value + '.';
    document.querySelector('main').appendChild(d);
  });
  document.getElementById('sort').addEventListener('click', function () {
    document.querySelector('.card .card-footer').textContent = '$48.41';
  });
  document.getElementById('tok-1').addEventListener('click', function () {
    this.id = 'tok-' + Date.now();
  });
</script>
</body></html>`;

const detailHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sheet Sander</title></head>
<body><main>
  <h1 data-test="product-name">Sheet Sander</h1>
  <span data-test="unit-price">$4.92</span>
  <h2>Related products</h2>
  <a class="card" href="/detail.html"><h5>Random Orbit Sander</h5><span class="card-footer">$12.00</span></a>
</main></body></html>`;

const frameHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Frame</title></head>
<body><h1 id="sampleHeading">Sample Heading</h1></body></html>`;

const registerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Register</title></head>
<body><main>
  <h1>Create account</h1>
  <form id="register" aria-label="Registration form">
    <label for="email">Email</label> <input id="email" name="email" type="email">
    <label for="password">Password</label> <input id="password" name="password" type="password">
    <button type="submit">Register</button>
  </form>
</main>
<script>
  document.getElementById('register').addEventListener('submit', function (e) {
    e.preventDefault();
    var d = document.createElement('div'); d.setAttribute('role', 'alert'); d.textContent = 'Welcome, ' + document.getElementById('email').value;
    document.querySelector('main').appendChild(d);
  });
</script>
</body></html>`;

const sanderSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#888"/></svg>`;

const routes: Record<string, { body: string; type: string }> = {
  '/': { body: indexHtml, type: 'text/html; charset=utf-8' },
  '/index.html': { body: indexHtml, type: 'text/html; charset=utf-8' },
  '/detail.html': { body: detailHtml, type: 'text/html; charset=utf-8' },
  '/frame.html': { body: frameHtml, type: 'text/html; charset=utf-8' },
  '/register.html': { body: registerHtml, type: 'text/html; charset=utf-8' },
  '/assets/products/sander.svg': { body: sanderSvg, type: 'image/svg+xml' },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = routes[url.pathname];
  if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-store' });
  res.end(route.body);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
console.log(`fixture site served in-process from ${base}/ (node:http, in memory)`);

/* ─── 2. the fixture run-report: every emitted shape ────────────────────── */

const pageTitle: SelectorRecord = { level: 'testid', arg: 'page-title', intent: 'page title' };
const cards: SelectorRecord = { level: 'css', arg: '.card', intent: 'product cards' };
const cardPrice: SelectorRecord = { level: 'css', arg: '.card .card-footer', intent: 'first card price', ambiguous: true };
const cardName: SelectorRecord = { level: 'css', arg: '.card h5', intent: 'first card name', ambiguous: true };
const cardImage: SelectorRecord = { level: 'css', arg: '.card img', intent: 'first card image', ambiguous: true };
const firstCard: SelectorRecord = { level: 'css', arg: 'a.card', intent: 'first product card', ambiguous: true };
const noSuch: SelectorRecord = { level: 'css', arg: '[data-test="no-such"]', intent: 'sold-out banner' };
const sortButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Sort by price high to low' }, intent: 'sort button' };
const regenButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Regenerate' }, intent: 'regenerate button' };
const detailHeading: SelectorRecord = { level: 'css', arg: 'h1', intent: 'detail heading' };
const nameInput: SelectorRecord = { level: 'label', arg: 'Name', intent: 'name input' };
const subjectSelect: SelectorRecord = { level: 'label', arg: 'Subject', intent: 'subject select' };
const ecoBox: SelectorRecord = { level: 'css', arg: '#eco', intent: 'eco-friendly checkbox' };
const sendButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Send' }, intent: 'send button' };
const alertBox: SelectorRecord = { level: 'role', arg: { role: 'alert' }, intent: 'confirmation alert' };
const frameHeading: SelectorRecord = { level: 'css', arg: '#sampleHeading', intent: 'frame heading', frameChain: ['iframe#frame1'] };
const emailInput: SelectorRecord = { level: 'label', arg: 'Email', intent: 'email input' };
const passwordInput: SelectorRecord = { level: 'label', arg: 'Password', intent: 'password input' };
const registerButton: SelectorRecord = { level: 'role', arg: { role: 'button', name: 'Register' }, intent: 'register button' };

function scenarios(): Scenario[] {
  return [
    { name: 'listing shows a heading, at least one card, a price format and an image', category: 'happy', feature: 'catalogue', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'assert', name: 't', assertion: { type: 'toHaveText', target: pageTitle, text: 'Hand Tools', timeout: 5000 } },
      { kind: 'assert', name: 'c', assertion: { type: 'toHaveCount', target: cards, count: 1, atLeast: true, timeout: 5000 } },
      { kind: 'assert', name: 'p', assertion: { type: 'toHaveText', target: cardPrice, text: '', pattern: '^\\$\\d+\\.\\d{2}$', timeout: 5000 } },
      { kind: 'assert', name: 'i', assertion: { type: 'toHaveAttribute', target: cardImage, attribute: 'src', value: '', pattern: 'products/', timeout: 5000 } },
      { kind: 'assert', name: 'z', assertion: { type: 'toHaveCount', target: noSuch, count: 0, timeout: 5000 } },
    ] },
    { name: 'sorting by price high to low raises the first price', category: 'happy', feature: 'catalogue', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'capture', varName: 'cap_firstPrice', source: 'text', target: cardPrice, intent: 'first card price' },
      { kind: 'click', target: sortButton },
      { kind: 'assert_compare', varName: 'cap_firstPrice', relation: 'greater', source: 'text', target: cardPrice, intent: 'first card price', readVar: 'cap_firstPrice_now' },
    ] },
    { name: 'clicking a card opens its detail page with the same name', category: 'happy', feature: 'catalogue', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'capture', varName: 'cap_listingName', source: 'text', target: cardName, intent: 'first card name' },
      { kind: 'click', target: firstCard },
      { kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: 'detail' } },
      { kind: 'assert_compare', varName: 'cap_listingName', relation: 'equal', source: 'text', target: cardName, intent: 'first card name', readVar: 'cap_listingName_now', readTarget: detailHeading },
    ] },
    { name: 'the token id regenerates on click', category: 'happy', feature: 'token', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'capture', varName: 'cap_oldId', source: 'attribute', attribute: 'id', target: regenButton, intent: 'regenerate button' },
      { kind: 'click', target: regenButton },
      { kind: 'assert_compare', varName: 'cap_oldId', relation: 'changed', source: 'attribute', attribute: 'id', target: regenButton, intent: 'regenerate button', readVar: 'cap_oldId_now' },
    ] },
    { name: 'contact form thanks the sender by name', category: 'happy', feature: 'contact', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'fill', target: nameInput, value: 'Jane' },
      { kind: 'select_option', target: subjectSelect, by: 'value', option: 'warranty' },
      { kind: 'set_checked', target: ecoBox, checked: true },
      { kind: 'assert', name: 'k', assertion: { type: 'toBeChecked', target: ecoBox, checked: true, timeout: 5000 } },
      { kind: 'assert', name: 'v', assertion: { type: 'toHaveValue', target: nameInput, value: 'Jane', timeout: 5000 } },
      { kind: 'click', target: sendButton },
      { kind: 'assert', name: 'a', assertion: { type: 'toContainText', target: alertBox, text: 'Thanks for your message', timeout: 5000 } },
    ] },
    { name: 'the sample frame shows its heading', category: 'happy', feature: 'frames', steps: [
      { kind: 'navigate', url: `${base}/` },
      { kind: 'assert', name: 'f', assertion: { type: 'toHaveText', target: frameHeading, text: 'Sample Heading', timeout: 5000 } },
    ] },
    { name: 'registering with a fresh email is welcomed', category: 'happy', feature: 'registration', steps: [
      { kind: 'navigate', url: `${base}/register.html` },
      { kind: 'fill', target: emailInput, value: 'qa.user.fixture@example.com', generate: 'email' },
      { kind: 'fill', target: passwordInput, value: 'Fixture-Pass-1', generate: 'password' },
      { kind: 'click', target: registerButton },
      { kind: 'assert', name: 'w', assertion: { type: 'toContainText', target: alertBox, text: 'Welcome', timeout: 5000 } },
    ] },
  ];
}

const SCENARIO_COUNT = scenarios().length;

function buildReport(language: 'ts' | 'js'): RunReport {
  return {
    url: `${base}/`, language,
    scenarios: scenarios(),
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  };
}

/* ─── 3. install and run ────────────────────────────────────────────────── */

interface RunResult { status: number | null; stdout: string; stderr: string }

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); stderr += `\n(killed after ${timeoutMs}ms)`; }, timeoutMs);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/** npm install: the local npm cache first (no network), the registry only when the cache cannot satisfy the pins. */
async function npmInstall(cwd: string): Promise<{ ok: boolean; mode: string; detail: string }> {
  const common = ['install', '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts'];
  const offline = await run('npm', [...common, '--offline'], cwd, 300_000);
  if (offline.status === 0) return { ok: true, mode: 'npm cache (offline, no network)', detail: '' };
  const online = await run('npm', [...common, '--prefer-offline'], cwd, 600_000);
  if (online.status === 0) return { ok: true, mode: 'registry (network; the npm cache could not satisfy the pins)', detail: offline.stderr.trim().split('\n').slice(-2).join(' ') };
  return { ok: false, mode: 'failed', detail: (online.stderr || online.stdout).trim().split('\n').slice(-6).join('\n') };
}

interface PwJson { stats: { expected: number; unexpected: number; flaky: number; skipped: number }; suites: PwSuite[] }
interface PwSuite { file?: string; title: string; specs: Array<{ title: string; ok: boolean; tests: Array<{ status: string }> }>; suites?: PwSuite[] }

function flattenSpecs(suites: PwSuite[], file = ''): Array<{ file: string; title: string; ok: boolean; status: string }> {
  const out: Array<{ file: string; title: string; ok: boolean; status: string }> = [];
  for (const s of suites) {
    const f = s.file ?? file;
    for (const sp of s.specs ?? []) out.push({ file: f, title: sp.title, ok: sp.ok, status: sp.tests[0]?.status ?? 'missing' });
    if (s.suites) out.push(...flattenSpecs(s.suites, f));
  }
  return out;
}

const summaries: Record<string, string> = {};
const installModes: Record<string, string> = {};

for (const language of ['ts', 'js'] as const) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-emitted-run-${language}-`));
  try {
    const report = buildReport(language);
    scaffold({ report, outDir, siteName: 'toolshop-fixture' });
    check(`${language}: scaffold wrote the config, a spec per feature and the a11y spec`,
      fs.existsSync(path.join(outDir, `playwright.config.${language}`))
      && fs.existsSync(path.join(outDir, `tests/catalogue/catalogue.spec.${language}`))
      && fs.existsSync(path.join(outDir, `tests/registration/registration.spec.${language}`))
      && fs.existsSync(path.join(outDir, `tests/a11y/landing.a11y.spec.${language}`))
      && fs.existsSync(path.join(outDir, `helpers/parse-number.${language}`)));

    const install = await npmInstall(outDir);
    installModes[language] = install.mode;
    check(`${language}: npm install succeeded via ${install.mode}`, install.ok, install.detail);
    if (!install.ok) continue;
    check(`${language}: the framework's own @playwright/test resolved`, fs.existsSync(path.join(outDir, 'node_modules/@playwright/test/package.json')));

    // Playwright's own exit code is the first gate; the JSON report the second.
    const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: 'results.json' } as NodeJS.ProcessEnv;
    delete env.CI;
    const pw = await run('npx', ['playwright', 'test', '--reporter=list,json'], outDir, 600_000, env);
    const summary = pw.stdout.split('\n').map((l) => l.trim()).filter((l) => /^\d+ (passed|failed|flaky|skipped)/.test(l)).join(' · ');
    summaries[language] = summary || '(no summary line)';
    console.log(`${language}: playwright exit ${String(pw.status)}: ${summaries[language]}`);
    check(`${language}: npx playwright test exited 0`, pw.status === 0, (pw.stdout + '\n' + pw.stderr).trim().split('\n').slice(-25).join('\n'));

    const jsonPath = path.join(outDir, 'results.json');
    check(`${language}: the JSON report was written`, fs.existsSync(jsonPath));
    if (!fs.existsSync(jsonPath)) continue;
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as PwJson;
    const specs = flattenSpecs(json.suites);
    const a11y = specs.filter((s) => /a11y[\\/]landing\.a11y\.spec/.test(s.file));
    check(`${language}: zero unexpected and zero flaky results in the JSON report`, json.stats.unexpected === 0 && json.stats.flaky === 0, JSON.stringify(json.stats));
    check(`${language}: every scenario plus the a11y check passed (${SCENARIO_COUNT + 1} expected)`, json.stats.expected === SCENARIO_COUNT + 1 && json.stats.skipped === 0, JSON.stringify({ stats: json.stats, specs: specs.map((s) => `${s.status}:${s.title}`) }));
    check(`${language}: the a11y spec ran and passed`, a11y.length === 1 && a11y[0]!.ok && a11y[0]!.status === 'expected', JSON.stringify(a11y));
    check(`${language}: no spec is reported as failed`, specs.every((s) => s.ok && s.status === 'expected'), specs.filter((s) => !s.ok).map((s) => `${s.file}: ${s.title}`).join(' | '));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

server.close();

console.log(`\ninstall: ts via ${installModes.ts ?? 'n/a'}; js via ${installModes.js ?? 'n/a'}`);
console.log(`playwright: ts ${summaries.ts ?? 'n/a'}; js ${summaries.js ?? 'n/a'}`);
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the emitted framework runs green in TypeScript and JavaScript against a served fixture site, every shape included, and the a11y spec runs.');
