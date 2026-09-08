/**
 * Locks parameterized spec emission (src/agent/pom.ts + datasets.ts):
 *   - 2+ scenarios sharing one action signature collapse into a single
 *     data-driven loop over data/<feature>.json
 *   - the emitted TS spec COMPILES (tsc against the emitted tsconfig)
 *   - non-shared scenarios stay individual tests exactly as today
 *   - the JS variant uses require() and passes a syntax check
 *   - the data file lands inside the framework zip
 *
 * Emits into output/ (gitignored) so the emitted tsconfig resolves
 * @playwright/test from the repo's node_modules. No network. No LLM.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scaffold } from '../src/agent/scaffold.js';
import { zipFrameworkToBuffer } from '../src/agent/zip-framework.js';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const fill = (intent: string, value: string): TraceStep =>
  ({ kind: 'fill', target: { level: 'label', arg: intent, intent }, value } as TraceStep);
const click = (intent: string): TraceStep =>
  ({ kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Send', exact: true }, intent } } as TraceStep);
const sc = (name: string, category: Scenario['category'], steps: TraceStep[]): Scenario =>
  ({ name, category, feature: 'contact', steps } as Scenario);

const NAV: TraceStep = { kind: 'navigate', url: 'https://shop.example/contact' } as TraceStep;
const SUCCESS_ASSERT: TraceStep = {
  kind: 'assert', name: 'confirmation shown',
  assertion: { type: 'toContainText', target: { level: 'css', arg: '.flash', intent: 'confirmation banner' }, text: 'Thanks for reaching out', timeout: 5000 },
} as TraceStep;
const ERROR_ASSERT: TraceStep = {
  kind: 'assert', name: 'error shown',
  assertion: { type: 'toContainText', target: { level: 'css', arg: '.error', intent: 'error message' }, text: 'Please enter a valid email', timeout: 5000 },
} as TraceStep;

const makeReport = (lang: 'ts' | 'js'): RunReport => ({
  url: 'https://shop.example/',
  language: lang,
  scenarios: [
    // Two scenarios, SAME action signature, differing values -> one loop.
    sc('sent the contact form', 'happy', [
      NAV,
      fill('name input', 'Ada Lovelace'),
      fill('email input', 'ada@shop.example'),
      click('send button'),
      SUCCESS_ASSERT,
    ]),
    sc('rejected a malformed email', 'negative', [
      NAV,
      fill('name input', 'Ada Lovelace'),
      fill('email input', 'nope@'),
      click('send button'),
      ERROR_ASSERT,
    ]),
    // Different signature (extra field) -> stays an individual test.
    sc('sent the form with a company name', 'edge', [
      NAV,
      fill('name input', 'Ada Lovelace'),
      fill('company input', 'Analytical Engines Ltd'),
      fill('email input', 'ada@engines.example'),
      click('send button'),
      SUCCESS_ASSERT,
    ]),
  ],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '2026-09-08T00:00:00Z', finishedAt: '2026-09-08T00:01:00Z',
} as unknown as RunReport);

const tsDir = path.join(process.cwd(), 'output', 'param-emit-smoke-ts');
const jsDir = path.join(process.cwd(), 'output', 'param-emit-smoke-js');
for (const d of [tsDir, jsDir]) fs.rmSync(d, { recursive: true, force: true });

/* ─── A. TS emission ───────────────────────────────────────────────────────── */
scaffold({ report: makeReport('ts'), outDir: tsDir, siteName: 'shop.example' });
const dataFile = path.join(tsDir, 'data', 'contact.json');
check('A1. data/contact.json is written', fs.existsSync(dataFile));
const cases = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as Array<{ name: string; expect: string; errorText?: string }>;
check('A2. it carries both shared-signature cases', cases.length === 2 && cases.some((c) => c.expect === 'error' && c.errorText === 'Please enter a valid email'), JSON.stringify(cases));

const spec = fs.readFileSync(path.join(tsDir, 'tests', 'contact', 'contact.spec.ts'), 'utf8');
check('A3. the spec imports the dataset and loops the Playwright way',
  spec.includes(`import rawCases from '../../data/contact.json';`) && spec.includes('for (const c of dataCases)') && spec.includes('test(`[data] contact —'), spec.slice(0, 400));
check('A4. the loop branches on c.expect with the recorded error locator',
  spec.includes(`if (c.expect === 'error')`) && spec.includes(`.toContainText(c.errorText ?? ''`));
check('A5. the collapsed scenarios are gone as individual tests',
  !spec.includes(`test("[happy] sent the contact form"`) && !spec.includes(`test("[negative] rejected a malformed email"`));
check('A6. the non-shared scenario stays an individual test, untouched',
  /test\((["'])\[edge\] sent the form with a company name\1/.test(spec), spec.match(/test\([^\n]*/g)?.join('\n'));

/* ─── B. the emitted TS framework compiles ─────────────────────────────────── */
try {
  execFileSync('npx', ['tsc', '--noEmit', '-p', tsDir], { stdio: 'pipe' });
  check('B1. tsc compiles the emitted framework (loop, JSON import, types)', true);
} catch (err) {
  const e = err as { stdout?: Buffer; stderr?: Buffer };
  check('B1. tsc compiles the emitted framework (loop, JSON import, types)', false,
    `${e.stdout?.toString().slice(0, 400) ?? ''}${e.stderr?.toString().slice(0, 200) ?? ''}`);
}

/* ─── C. JS emission ───────────────────────────────────────────────────────── */
scaffold({ report: makeReport('js'), outDir: jsDir, siteName: 'shop.example' });
const jsSpecPath = path.join(jsDir, 'tests', 'contact', 'contact.spec.js');
const jsSpec = fs.readFileSync(jsSpecPath, 'utf8');
check('C1. the JS spec requires the dataset and loops',
  jsSpec.includes(`const rawCases = require('../../data/contact.json');`) && jsSpec.includes('for (const c of dataCases)'));
try {
  execFileSync(process.execPath, ['--check', jsSpecPath], { stdio: 'pipe' });
  check('C2. the JS spec passes a node syntax check', true);
} catch (err) {
  check('C2. the JS spec passes a node syntax check', false, String(err).slice(0, 200));
}

/* ─── D. the data file lands in the framework zip ──────────────────────────── */
const zip = zipFrameworkToBuffer(tsDir);
check('D1. data/contact.json is inside the zip', zip.includes('data/contact.json'));

for (const d of [tsDir, jsDir]) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: shared-signature scenarios collapse into one compiling data-driven loop, non-shared tests stay untouched, and the dataset ships in the zip.');
