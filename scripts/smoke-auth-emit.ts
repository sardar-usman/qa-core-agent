/**
 * Locks storageState auth emission (src/agent/auth-emit.ts + pom + scaffold):
 *   - a happy-login run emits tests/auth.setup, the setup/login/chromium
 *     projects, dependencies: ['setup'], and storageState on the main project
 *   - login specs keep their own project WITHOUT storageState and keep their
 *     cookie-clearing beforeEach and full login steps (env-referenced creds)
 *   - authenticated-feature specs lose their leading login sequence and do
 *     not clear the session in beforeEach
 *   - credential literals appear NOWHERE in the emitted tree (grep)
 *   - a no-login report emits none of the auth artifacts, and emission is
 *     deterministic (two runs byte-compare identical) — the emitter-only
 *     guarantee
 *
 * Offline, constructed RunReports. No network. No LLM. No browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { scaffold } from '../src/agent/scaffold.js';
import { findHappyLoginScenario, stripLeadingLogin, AUTH_ENV_USER, AUTH_ENV_PASS } from '../src/agent/auth-emit.js';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const USER = 'agent-observed-user';
const PASS = 'agent-observed-p4ss!';

const fill = (intent: string, value: string): TraceStep =>
  ({ kind: 'fill', target: { level: 'label', arg: intent, intent }, value } as TraceStep);
const click = (intent: string): TraceStep =>
  ({ kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Go', exact: true }, intent } } as TraceStep);
const nav = (url: string): TraceStep => ({ kind: 'navigate', url } as TraceStep);
const sc = (name: string, category: Scenario['category'], feature: string, steps: TraceStep[]): Scenario =>
  ({ name, category, feature, steps } as Scenario);

const LOGIN_STEPS: TraceStep[] = [
  nav('https://shop.example/'),
  fill('username input', USER),
  fill('password input', PASS),
  click('login button'),
  { kind: 'assert', name: 'landed', assertion: { type: 'toHaveURL', pattern: '/inventory' } } as TraceStep,
];

const withLogin: RunReport = {
  url: 'https://shop.example/',
  language: 'ts',
  scenarios: [
    sc('logged in with valid credentials', 'happy', 'login', [...LOGIN_STEPS]),
    sc('rejected a wrong password', 'negative', 'login', [
      nav('https://shop.example/'),
      fill('username input', USER),
      fill('password input', 'wrong-password'),
      click('login button'),
      { kind: 'assert', name: 'error', assertion: { type: 'toContainText', target: { level: 'css', arg: '.error', intent: 'error message' }, text: 'Wrong credentials' } } as TraceStep,
    ]),
    // Authenticated feature whose recording starts with the login sequence.
    sc('added an item to the cart', 'happy', 'cart', [
      ...LOGIN_STEPS,
      nav('https://shop.example/inventory'),
      click('add to cart button'),
      { kind: 'assert', name: 'badge', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.cart-badge', intent: 'cart badge' }, text: '1', timeout: 5000 } } as TraceStep,
    ]),
  ],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '2026-09-08T00:00:00Z', finishedAt: '2026-09-08T00:01:00Z',
} as unknown as RunReport;

const authDir = path.join(process.cwd(), 'output', 'auth-emit-smoke');
fs.rmSync(authDir, { recursive: true, force: true });
scaffold({ report: withLogin, outDir: authDir, siteName: 'shop.example' });

const read = (rel: string): string => fs.readFileSync(path.join(authDir, rel), 'utf8');
const tree = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tree(full));
    else out.push(full);
  }
  return out;
};

/* ─── A. setup file + config projects ──────────────────────────────────────── */
check('A1. tests/auth.setup.ts is emitted', fs.existsSync(path.join(authDir, 'tests', 'auth.setup.ts')));
const setupSrc = read('tests/auth.setup.ts');
check('A2. the setup logs in with env credentials and saves storage state',
  setupSrc.includes(`process.env.${AUTH_ENV_USER} ?? ''`) &&
  setupSrc.includes(`process.env.${AUTH_ENV_PASS} ?? ''`) &&
  setupSrc.includes(`storageState({ path: STORAGE_STATE })`));
check('A3. the setup keeps the recorded login-success signal', setupSrc.includes('/inventory'));
const config = read('playwright.config.ts');
check('A4. config has the setup project matching auth.setup', /name: 'setup'.*auth\\\.setup/.test(config), config.match(/name: 'setup'[^\n]*/)?.[0]);
check('A5. the main project depends on setup and uses the saved storage state',
  config.includes(`dependencies: ['setup']`) && config.includes(`storageState: "playwright/.auth/user.json"`));
check('A6. the login project runs WITHOUT storageState and only login specs',
  /\{ name: 'login', use: \{ \.\.\.devices\['Desktop Chrome'\] \}, testMatch: 'login\/\*\*\/\*\.spec\.ts' \}/.test(config), config.match(/name: 'login'[^\n]*/)?.[0]);
check('A7. the main project ignores login specs and the setup file',
  config.includes(`testIgnore: ['**/login/**', '**/auth.setup.*']`));

/* ─── B. spec-side treatment ───────────────────────────────────────────────── */
const cartSpec = read('tests/cart/cart.spec.ts');
check('B1. the authenticated spec lost its leading login steps',
  !cartSpec.includes('password') && !cartSpec.includes('login button'), cartSpec.slice(0, 500));
check('B2. the authenticated spec does not clear the session in beforeEach',
  !cartSpec.includes('clearCookies') && cartSpec.includes('do not clear it'));
const loginSpec = read('tests/login/login.spec.ts');
check('B3. the login spec keeps its full steps with env-referenced credentials',
  loginSpec.includes(`process.env.${AUTH_ENV_USER} ?? ''`) && loginSpec.includes(`process.env.${AUTH_ENV_PASS} ?? ''`));
check('B4. the login spec still clears state per test (no storage session to protect)',
  loginSpec.includes('clearCookies'));

/* ─── C. credentials never emitted as literals — ANYWHERE in the zip tree ──── */
// No exemptions: the framework's run-report.json ships inside the zip, so its
// credential fill values are redacted too. Only the working-directory copy
// (restored by the CLI after zipping) keeps raw values.
const offenders = tree(authDir).filter((f) => {
  const body = fs.readFileSync(f, 'utf8');
  return body.includes(USER) || body.includes(PASS);
}).map((f) => path.relative(authDir, f));
check('C1. NO file in the framework tree contains a REAL credential (run-report included)',
  offenders.length === 0, JSON.stringify(offenders));
// Value-based substitution: wrong credentials are test data, not secrets.
check('C1e. the negative login keeps its literal wrong password in the spec',
  read('tests/login/login.spec.ts').includes(`"wrong-password"`) || read('tests/login/login.spec.ts').includes(`'wrong-password'`),
  read('tests/login/login.spec.ts').match(/wrong[^\n]*/)?.[0]);
check('C1f. the zipped run-report keeps the wrong password and masks only the real credentials',
  read('run-report.json').includes('wrong-password') && !read('run-report.json').includes(PASS) && !read('run-report.json').includes(USER));
const zippedReport = read('run-report.json');
check('C1b. the framework run-report masks credential fills with the redaction marker',
  zippedReport.includes('[redacted:credential]') &&
  (JSON.parse(zippedReport) as RunReport).scenarios[2]!.steps.filter((s) => s.kind === 'fill').slice(0, 2).every((s) => (s as { value: string }).value === '[redacted:credential]'),
  zippedReport.match(/"value": "[^"]*"/g)?.join(', '));
check('C1c. the in-memory report is NOT mutated (the working-dir copy keeps raw values)',
  withLogin.scenarios[0]!.steps.some((s) => s.kind === 'fill' && (s as { value: string }).value === PASS) &&
  withLogin.scenarios[2]!.steps.some((s) => s.kind === 'fill' && (s as { value: string }).value === USER));
check('C1d. the CLI scaffolds the framework in a temporary directory, so the run directory\'s raw run-report is never rewritten (the redacted copy exists only inside the zip)',
  (() => { const cli = fs.readFileSync('src/cli/explore.ts', 'utf8'); return /qa-core-emit-/.test(cli) && /outDir: frameworkDir/.test(cli) && !/writeFileSync\(path\.join\(outDir, 'run-report\.json'\)/.test(cli); })());
check('C2. .env.example has empty placeholders for a non-demo host',
  read('.env.example').includes(`${AUTH_ENV_USER}=\n`) && read('.env.example').includes(`${AUTH_ENV_PASS}=\n`));
check('C3. .gitignore covers playwright/.auth/', read('.gitignore').includes('playwright/.auth/'));

/* ─── C7. the framework loads .env ─────────────────────────────────────────── */
check('C7a. the config imports dotenv/config first', read('playwright.config.ts').startsWith(`import 'dotenv/config';`));
check('C7b. package.json ships dotenv as a dependency', (JSON.parse(read('package.json')) as { dependencies: Record<string, string> }).dependencies['dotenv'] !== undefined);
check('C7c. the README says to copy .env.example to .env', read('README.md').includes('cp .env.example .env'));
check('C7d. one credential convention: no legacy TEST_USERNAME anywhere',
  tree(authDir).every((f) => !fs.readFileSync(f, 'utf8').includes('TEST_USERNAME')));

/* ─── D. stripLeadingLogin unit behavior ───────────────────────────────────── */
const stripped = stripLeadingLogin(withLogin.scenarios[2]!.steps);
check('D1. the strip removes nav+creds+submit+success-assert, keeps the feature flow',
  stripped.length === 3 && stripped[0]?.kind === 'navigate' && (stripped[0] as { url: string }).url.endsWith('/inventory'),
  JSON.stringify(stripped.map((s) => s.kind)));
check('D2. a scenario with no leading login is returned unchanged',
  stripLeadingLogin(withLogin.scenarios[1]!.steps.slice(0, 1)).length === 1);
check('D3. findHappyLoginScenario picks the happy login, not the negative',
  findHappyLoginScenario(withLogin)?.name === 'logged in with valid credentials');

/* ─── E. the emitter-only guarantee: no login, no changes ──────────────────── */
const noLogin: RunReport = {
  ...withLogin,
  scenarios: [
    sc('searched for a rake', 'happy', 'search', [
      nav('https://shop.example/'),
      fill('search input', 'rake'),
      click('search button'),
      { kind: 'assert', name: 'results', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.count', intent: 'result count' }, text: '3', timeout: 5000 } } as TraceStep,
    ]),
  ],
} as unknown as RunReport;
const plainA = path.join(process.cwd(), 'output', 'auth-emit-smoke-plain-a');
const plainB = path.join(process.cwd(), 'output', 'auth-emit-smoke-plain-b');
for (const d of [plainA, plainB]) fs.rmSync(d, { recursive: true, force: true });
scaffold({ report: noLogin, outDir: plainA, siteName: 'shop.example' });
scaffold({ report: noLogin, outDir: plainB, siteName: 'shop.example' });

check('E1. no auth.setup, no data/ dir, no setup project without a login',
  !fs.existsSync(path.join(plainA, 'tests', 'auth.setup.ts')) &&
  !fs.existsSync(path.join(plainA, 'data')) &&
  !fs.readFileSync(path.join(plainA, 'playwright.config.ts'), 'utf8').includes('setup'));
check('E2. the config keeps the exact pre-phase single-project shape',
  fs.readFileSync(path.join(plainA, 'playwright.config.ts'), 'utf8').includes(`{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },`));
check('E2b. the no-login config also loads dotenv (every framework reads .env)',
  fs.readFileSync(path.join(plainA, 'playwright.config.ts'), 'utf8').startsWith(`import 'dotenv/config';`));
check('E3. .env.example has no ACTIVE auth assignment without a login (commented hint only)',
  !/^QA_CORE_TEST_USER=/m.test(fs.readFileSync(path.join(plainA, '.env.example'), 'utf8')) &&
  fs.readFileSync(path.join(plainA, '.env.example'), 'utf8').includes(`# ${AUTH_ENV_USER}=`));
const filesA = tree(plainA).map((f) => path.relative(plainA, f)).sort();
const filesB = tree(plainB).map((f) => path.relative(plainB, f)).sort();
const identical = JSON.stringify(filesA) === JSON.stringify(filesB) &&
  filesA.every((rel) => fs.readFileSync(path.join(plainA, rel), 'utf8') === fs.readFileSync(path.join(plainB, rel), 'utf8'));
check('E4. no-login emission byte-compares identical across runs (same tree, same bytes)', identical);
check('E5. no phase-4 strings leak into the no-login tree',
  filesA.every((rel) => {
    const body = fs.readFileSync(path.join(plainA, rel), 'utf8');
    if (rel === '.env.example' || rel === 'fixtures/credentials.ts' || rel === 'README.md') {
      // These name the vars as a commented hint / env fallback; no storage
      // state or dataset machinery may appear anywhere.
      return !body.includes('storageState:') && !body.includes('dataCases');
    }
    return !body.includes('storageState:') && !body.includes(AUTH_ENV_USER) && !body.includes('dataCases');
  }));

/* ─── F. the credential marker activates auth whatever the feature is called (invariant 70) ─ */
// Toolshop's map names the login feature `account` (runs 5 and 6), so the
// feature === 'login' rule never activated there. The marker does.
const ENV_USER = 'client.dedicated@shop.test';
const ENV_PASS = 'Dedicated!Pass-2026';
const prevUser = process.env[AUTH_ENV_USER];
const prevPass = process.env[AUTH_ENV_PASS];
process.env[AUTH_ENV_USER] = ENV_USER;
process.env[AUTH_ENV_PASS] = ENV_PASS;
const mfill = (intent: string, credential: 'user' | 'pass'): TraceStep =>
  ({ kind: 'fill', target: { level: 'label', arg: intent, intent }, value: '', credential } as TraceStep);
const MARKED_LOGIN: TraceStep[] = [
  nav('https://practicesoftwaretesting.com/auth/login'),
  mfill('email input', 'user'),
  mfill('password input', 'pass'),
  click('login button'),
  { kind: 'assert', name: 'landed', assertion: { type: 'toHaveURL', pattern: '/account', timeout: 10000 } } as TraceStep,
];
const marked: RunReport = {
  ...withLogin,
  url: 'https://practicesoftwaretesting.com/',
  scenarios: [
    sc('logged in with valid credentials', 'happy', 'account', [...MARKED_LOGIN]),
    sc('rejected login with a wrong password', 'negative', 'account', [
      nav('https://practicesoftwaretesting.com/auth/login'),
      mfill('email input', 'user'),
      fill('password input', 'wrong-password'),
      click('login button'),
      { kind: 'assert', name: 'error', assertion: { type: 'toContainText', target: { level: 'css', arg: '.alert', intent: 'error message' }, text: 'Invalid email or password', timeout: 10000 } } as TraceStep,
    ]),
    sc('saw the order history', 'happy', 'orders', [
      ...MARKED_LOGIN,
      nav('https://practicesoftwaretesting.com/account/orders'),
      { kind: 'assert', name: 'h', assertion: { type: 'toBeVisible', target: { level: 'css', arg: 'h1', intent: 'orders heading' }, timeout: 10000 } } as TraceStep,
    ]),
  ],
} as unknown as RunReport;
const markedDir = path.join(process.cwd(), 'output', 'auth-emit-smoke-marked');
fs.rmSync(markedDir, { recursive: true, force: true });
scaffold({ report: marked, outDir: markedDir, siteName: 'practicesoftwaretesting.com' });
const mread = (rel: string): string => fs.readFileSync(path.join(markedDir, rel), 'utf8');
check('F1. findHappyLoginScenario keys on the marker: the happy login of feature "account" is found', findHappyLoginScenario(marked)?.name === 'logged in with valid credentials');
check('F2. feature "account" activates the auth setup: tests/auth.setup.ts reads the env pair', fs.existsSync(path.join(markedDir, 'tests', 'auth.setup.ts')) && mread('tests/auth.setup.ts').includes(`process.env.${AUTH_ENV_USER} ?? ''`) && mread('tests/auth.setup.ts').includes(`process.env.${AUTH_ENV_PASS} ?? ''`));
const mconfig = mread('playwright.config.ts');
check('F3. the login project runs the account specs WITHOUT storageState, the main project ignores them',
  mconfig.includes(`testMatch: 'account/**/*.spec.ts'`) && mconfig.includes(`testIgnore: ['**/account/**', '**/auth.setup.*']`), mconfig.match(/name: 'login'[^\n]*/)?.[0]);
const accountSpec = mread('tests/account/account.spec.ts');
check('F4. the account spec keeps its full login with env references and clears state per test',
  accountSpec.includes(`process.env.${AUTH_ENV_USER} ?? ''`) && accountSpec.includes(`process.env.${AUTH_ENV_PASS} ?? ''`) && accountSpec.includes('clearCookies'));
check('F5. the wrong-password negative reads the account identifier from env and keeps its literal wrong password', /wrong-password/.test(accountSpec));
const ordersSpec = mread('tests/orders/orders.spec.ts');
check('F6. an authenticated feature loses its leading login and keeps the session', !ordersSpec.includes('password') && !ordersSpec.includes('clearCookies'), ordersSpec.slice(0, 400));
const markedOffenders = tree(markedDir).filter((f) => { const b = fs.readFileSync(f, 'utf8'); return b.includes(ENV_USER) || b.includes(ENV_PASS); }).map((f) => path.relative(markedDir, f));
check('F7. NO file in the tree holds an env credential value (the tree grep)', markedOffenders.length === 0, JSON.stringify(markedOffenders));
const envEx = mread('.env.example');
check('F8. .env.example keeps the generic names, says the framework reads only them, and seeds nothing even for a demo host',
  envEx.includes(`${AUTH_ENV_USER}=\n`) && envEx.includes(`${AUTH_ENV_PASS}=\n`) && envEx.includes('This framework reads only the generic') && envEx.includes(`${AUTH_ENV_USER}_<HOST>`), envEx);
const legacyAccount = { ...withLogin, scenarios: withLogin.scenarios.map((x) => ({ ...x, feature: x.feature === 'login' ? 'account' : x.feature })) } as RunReport;
check('F9. an older report with feature "account" and no marker keeps the legacy rule: no auth', findHappyLoginScenario(legacyAccount) === null);
if (prevUser === undefined) delete process.env[AUTH_ENV_USER]; else process.env[AUTH_ENV_USER] = prevUser;
if (prevPass === undefined) delete process.env[AUTH_ENV_PASS]; else process.env[AUTH_ENV_PASS] = prevPass;

for (const d of [authDir, plainA, plainB, markedDir]) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: happy-login runs emit the storageState setup + projects with env-only credentials, keyed on the credential marker whatever the feature is called; no-login runs emit exactly the pre-phase framework.');
