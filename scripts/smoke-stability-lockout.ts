/**
 * Locks "lockout is state, not flake" (src/agent/stability.ts, replay.ts):
 *   - a scenario whose 2nd and 3rd iterations fail carries the OBSERVED text at
 *     the failing target (and the visible alert text) on its first failure, so
 *     a reader can tell "Account locked" from a timing race
 *   - every Stabilizer attempt is recorded on the verdict (number, change,
 *     outcome, re-run pattern) and a broken classification has gaveUp true,
 *     whether the Stabilizer gave up or the scenario never passed at all
 *   - stabilizer cost with no recorded attempt is a warning, never "none recorded"
 *
 * A local HTTP server plays the site: the first request to /login answers
 * "Invalid credentials", every later one "Account locked", the way a real site
 * locks an account after repeated wrong passwords. Real Chromium, a FAKE
 * Stabilizer client. No network. No LLM.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type Anthropic from '@anthropic-ai/sdk';
import { stability, stabilizerWarningFor, type StabilityVerdict } from '../src/agent/stability.js';
import type { Scenario } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── the site: locks after the first wrong attempt ────────────────────────── */
let loginHits = 0;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/login')) {
    loginHits++;
    const locked = loginHits > 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body><h1>Sign in</h1><div id="msg"${locked ? ' role="alert"' : ''}>${locked ? 'Account locked, too many failed attempts' : 'Invalid credentials'}</div></body></html>`);
    return;
  }
  res.writeHead(404); res.end('no');
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const scenario = (name: string, expected: string): Scenario => ({
  name, category: 'negative', feature: 'login',
  steps: [
    { kind: 'navigate', url: `${base}/login` },
    { kind: 'assert', name: `msg contains "${expected}"`, assertion: { type: 'toContainText', target: { level: 'css', arg: '#msg', intent: 'login message' }, text: expected, timeout: 1500 } },
  ],
} as unknown as Scenario);

/* ─── a fake Stabilizer: raise the timeout once, then declare it broken ────── */
let stabilizerCalls = 0;
const fakeStabilizer = {
  messages: {
    create: async () => {
      stabilizerCalls++;
      const text = stabilizerCalls === 1
        ? '<kind>timeout_raise</kind>\n<timeout>5000</timeout>\n<reason>the banner may render late</reason>'
        : '<kind>broken</kind>\n<reason>the expected text never appears; the account is locked</reason>';
      return { content: [{ type: 'text', text }], usage: { input_tokens: 600, output_tokens: 40 } };
    },
  },
} as unknown as Anthropic;

try {
  const result = await stability({
    scenarios: [scenario('rejected a wrong password with the invalid-credentials error', 'Invalid credentials'), scenario('welcomed the user', 'Welcome back')],
    iterations: 3,
    timeoutMs: 2000,
    stabilize: true,
    maxStabilizeAttempts: 3,
    stabilizerClient: fakeStabilizer,
  });
  const v = result.verdicts.find((x) => x.name.startsWith('rejected'))!;
  const w = result.verdicts.find((x) => x.name.startsWith('welcomed'))!;

  /* A. the lockout scenario: passes once, then the site locks */
  check('A1. the first iteration passed and the next two failed (P-F-F)', v.pattern === 'P-F-F' && v.passes === 1, `${v.pattern} passes=${v.passes}`);
  check('A2. the first failure names iteration 2 at the assertion step', v.firstFailure?.iteration === 2 && v.firstFailure.failedStep === 1 && v.firstFailure.stepKind === 'assert', JSON.stringify(v.firstFailure));
  check('A3. the observed text at the target is the lockout message, not the expected text', v.firstFailure?.observed?.target === 'Account locked, too many failed attempts', JSON.stringify(v.firstFailure?.observed));
  check('A4. the observed visible messages carry the alert text and the URL is the page under test', v.firstFailure?.observed?.messages.includes('Account locked, too many failed attempts') === true && v.firstFailure?.observed?.url === `${base}/login`, JSON.stringify(v.firstFailure?.observed));
  check('A5. the error stays the assertion expectation (the observed text is recorded beside it, not instead of it)', /expected text containing "Invalid credentials"/.test(v.firstFailure?.error ?? ''), v.firstFailure?.error);

  /* B. every Stabilizer attempt is on the verdict */
  check('B1. two Stabilizer calls were made (timeout raise, then broken)', stabilizerCalls === 2, String(stabilizerCalls));
  check('B2. both attempts are recorded in order with their change and outcome',
    v.attempts.length === 2 && v.attempts[0]?.attempt === 1 && v.attempts[0].kind === 'timeout_raise' && v.attempts[0].change === 'timeout_raise(5000ms)' && v.attempts[0].outcome === 'still-failing' && v.attempts[1]?.attempt === 2 && v.attempts[1].kind === 'broken' && v.attempts[1].outcome === 'gave-up',
    JSON.stringify(v.attempts));
  check('B3. the still-failing attempt carries its re-run pattern; the give-up carries none', v.attempts[0]?.pattern === 'F-F-F' && v.attempts[1]?.pattern === null, JSON.stringify(v.attempts.map((a) => a.pattern)));
  check('B4. the attempt reason is the Stabilizer\'s own sentence', v.attempts[1]?.reason === 'the expected text never appears; the account is locked', v.attempts[1]?.reason);
  check('B5. the scenario is classified broken with gaveUp true, and stays out of the emitted set', v.classification === 'broken' && v.gaveUp === true && !result.emitted.some((s) => s.name === v.name) && result.broken.some((s) => s.name === v.name));
  check('B6. the verdict keeps the ORIGINAL pattern and first failure after the attempts', v.pattern === 'P-F-F' && v.firstFailure?.iteration === 2);

  /* C. a scenario that never passes: broken, gaveUp true, no attempts */
  check('C1. the never-passing scenario is F-F-F and broken', w.pattern === 'F-F-F' && w.classification === 'broken', w.pattern);
  check('C2. gaveUp is true on every broken classification, even with no Stabilizer attempt', w.gaveUp === true && w.attempts.length === 0, JSON.stringify({ gaveUp: w.gaveUp, attempts: w.attempts }));
  check('C3. its observed text is the site\'s first answer', w.firstFailure?.observed?.target === 'Account locked, too many failed attempts' || w.firstFailure?.observed?.target === 'Invalid credentials', JSON.stringify(w.firstFailure?.observed));

  /* D. cost and attempts agree, or the report warns */
  check('D1. the stage recorded Stabilizer cost and attempts together, so no warning', result.stabilizerCostUsd > 0 && result.warning === undefined, JSON.stringify({ cost: result.stabilizerCostUsd, warning: result.warning }));
  const noAttempts: Array<Pick<StabilityVerdict, 'attempts'>> = [{ attempts: [] }, { attempts: [] }];
  check('D2. cost with no recorded attempt is a loud warning', /spent \$0\.0122 but recorded no attempts/.test(stabilizerWarningFor(0.0122, noAttempts) ?? ''), stabilizerWarningFor(0.0122, noAttempts));
  check('D3. zero cost and no attempts is the only quiet case', stabilizerWarningFor(0, noAttempts) === undefined);
  check('D4. cost with an attempt recorded is not a warning', stabilizerWarningFor(0.01, [{ attempts: v.attempts }]) === undefined);
} finally {
  server.close();
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a lockout is recorded as observed page state with every Stabilizer attempt on the verdict; broken means gave up; spend without attempts warns.');
