/**
 * Locks the nameless-role fallback rule (src/agent/selectors.ts,
 * src/agent/selector-recovery.ts), the defect PR #25 named as Known red:
 *
 *   On a page with one button, an assert with intent "login error message"
 *   and testid 'error' resolved to the Login button, and an assertion on an
 *   element that never appears passed (smoke-data-test-attribute check M).
 *   The nameless fallback of the role GUESSED from the intent ran before any
 *   explicit hint, and "login" guessed a button.
 *
 * The rule now:
 *   - named role matches stay first (never ID-first);
 *   - every explicit hint is tried before any nameless guessed-role fallback;
 *   - with an explicit locating hint (testid, css, xpath, text) that all
 *     missed, the fallback is not used and the resolve returns null, so the
 *     retry cap and the finding path apply (invariant 24);
 *   - the fallback exists only for hint-less intents ("submit button" on a
 *     page whose one button is named "Login");
 *   - a message-shaped intent (error, message, alert, validation, toast,
 *     status, notice) never guesses button or link;
 *   - recovery (by intent alone) accepts only NAMED matches: it can never
 *     land on the nameless fallback.
 *
 * Real headless page, no LLM, no network.
 */
import { chromium } from 'playwright';
import { resolve } from '../src/agent/selectors.js';
import { recoverResolve } from '../src/agent/selector-recovery.js';
import { installEvalShim } from '../src/agent/eval-shim.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

// One control on the page: a button named Login (type="button", so the
// smart-css tier's button[type=submit] cannot find it either; only the
// nameless fallback can), plus an unnamed text field carrying data-test.
const oneButton = `<!doctype html><html><body>
<form><input type="text" data-test="username" placeholder="Username"><input type="text" data-test="promo"><button type="button" data-test="login-button">Login</button></form>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();
await page.setContent(oneButton, { waitUntil: 'load' });

/* ─── A. explicit hints that miss return null, never the one button ─────── */
const a1 = await resolve(page, { intent: 'login error message', testid: 'error' });
check('A1. intent "login error message" with testid "error" on a single-button page returns null, no button', a1 === null, JSON.stringify(a1));
const a2 = await resolve(page, { intent: 'login error message', testid: 'error', text: 'Username and password do not match' });
check('A2. the same with a text hint too (the assert tool\'s shape) returns null', a2 === null, JSON.stringify(a2));
const a3 = await resolve(page, { intent: 'submit button', css: '#no-such-control' });
check('A3. "submit button" with a css hint that misses returns null even though the guessed role would find the one button', a3 === null, JSON.stringify(a3));
const a4 = await resolve(page, { intent: 'next step link', xpath: '//a[@id="missing"]' });
check('A4. an xpath hint that misses returns null (no guessed-link fallback)', a4 === null, JSON.stringify(a4));

/* ─── B. a message-shaped intent never guesses a control ────────────────── */
const b1 = await resolve(page, { intent: 'login error message' });
check('B1. "login error message" with no hints and no matching element returns null (message intents never guess button)', b1 === null, JSON.stringify(b1));
const b2 = await resolve(page, { intent: 'validation alert for the sign in form' });
check('B2. "validation alert for the sign in form" returns null too', b2 === null, JSON.stringify(b2));
const b3 = await resolve(page, { intent: 'status notice link' });
check('B3. a message-shaped intent never guesses link either', b3 === null, JSON.stringify(b3));

/* ─── C. the fallback still serves hint-less control intents ────────────── */
const c1 = await resolve(page, { intent: 'submit button' });
check('C1. hint-less "submit button" still resolves the one button by the nameless fallback', c1 !== null && c1.level === 'role' && JSON.stringify(c1.arg) === JSON.stringify({ role: 'button' }), JSON.stringify(c1));
const c2 = await resolve(page, { intent: 'login button' });
check('C2. a NAMED role match still wins first (the Login button by name, not the nameless fallback)', c2 !== null && c2.level === 'role' && typeof c2.arg === 'object' && (c2.arg as { name?: string }).name !== undefined, JSON.stringify(c2));
const c3 = await resolve(page, { intent: 'login button', testid: 'login-button' });
check('C3. a named role match still wins over an explicit testid hint (never ID-first)', c3 !== null && c3.level === 'role' && (c3.arg as { name?: string }).name !== undefined, JSON.stringify(c3));
const c4 = await resolve(page, { intent: 'promo code', testid: 'promo' });
check('C4. an explicit testid hint on an unnamed field resolves at the data-test tier (recorded as the css form)', c4 !== null && c4.level === 'css' && c4.arg === '[data-test="promo"]', JSON.stringify(c4));
const c4b = await resolve(page, { intent: 'username input', testid: 'username' });
check('C4b. a field whose placeholder gives it an accessible name still resolves by NAMED role first (never ID-first)', c4b !== null && c4b.level === 'role' && (c4b.arg as { name?: string }).name !== undefined, JSON.stringify(c4b));
const c5 = await resolve(page, { intent: 'the progress meter', role: 'progressbar' });
check('C5. a STATED role with no match returns null (no element of that role)', c5 === null, JSON.stringify(c5));
await page.setContent(oneButton.replace('</form>', '</form><div role="progressbar" aria-valuenow="40"></div>'), { waitUntil: 'load' });
const c6 = await resolve(page, { intent: 'the progress meter', role: 'progressbar' });
check('C6. a STATED role keeps its nameless try: role="progressbar" without a name still resolves', c6 !== null && c6.level === 'role' && JSON.stringify(c6.arg) === JSON.stringify({ role: 'progressbar' }), JSON.stringify(c6));
await page.setContent(oneButton, { waitUntil: 'load' });

/* ─── D. recovery accepts only named matches ────────────────────────────── */
const d1 = await recoverResolve(page, { intent: 'submit button', css: '#stale-submit' });
check('D1. recovery of a stale "submit button" hint does NOT land on the nameless fallback (the one button is named Login)', d1 === null, JSON.stringify(d1));
const d2 = await recoverResolve(page, { intent: 'login button', css: '#stale-login' });
check('D2. recovery by intent still finds a NAMED match (the Login button by name)', d2 !== null && d2.level === 'role' && (d2.arg as { name?: string }).name !== undefined && (await d2.locator.textContent()) === 'Login', JSON.stringify(d2));
const d3 = await recoverResolve(page, { intent: 'login error message', testid: 'error' });
check('D3. recovery of a missing error message returns null (finding path), never the button', d3 === null, JSON.stringify(d3));

/* ─── E. a page whose ONLY button is type="submit" and named Login ─────── */
// The smart-css tier (button[type=submit] from a "submit" intent) is an
// intent-derived tier: it runs only for a hint-less call and never for a
// message-shaped intent, so a missed testid on this page returns null too.
const submitPage = `<!doctype html><html><body>
<form><input type="text" data-test="username" placeholder="Username"><button type="submit" data-test="login-button">Login</button></form>
<script>
  window.showError = function () { var h = document.createElement('h3'); h.setAttribute('data-test', 'error'); h.textContent = 'Epic sadface: Username and password do not match'; document.body.appendChild(h); };
</script>
</body></html>`;
await page.setContent(submitPage, { waitUntil: 'load' });
const e1 = await resolve(page, { intent: 'login error message', testid: 'error' });
check('E1. submit page: "login error message" with testid "error", element absent, returns null (no smart-css button either)', e1 === null, JSON.stringify(e1));
await page.evaluate(() => setTimeout(() => (window as unknown as { showError: () => void }).showError(), 500));
const e2First = await resolve(page, { intent: 'login error message', testid: 'error' });
let e2 = e2First;
for (let i = 0; i < 8 && !e2; i++) { await page.waitForTimeout(200); e2 = await resolve(page, { intent: 'login error message', testid: 'error' }); }
check('E2. the same call with the element rendered late resolves the error element, never the button', e2First === null && e2 !== null && (await e2.locator.getAttribute('data-test')) === 'error', JSON.stringify({ first: e2First, then: e2 && { level: e2.level, arg: e2.arg } }));
await page.setContent(submitPage, { waitUntil: 'load' });
const e3 = await resolve(page, { intent: 'submit button' });
check('E3. hint-less "submit button" resolves the one submit button (the smart-css tier, button[type=submit], reaches it before the nameless fallback; either tier is fine)', e3 !== null && (await e3.locator.getAttribute('data-test')) === 'login-button' && e3.level === 'css' && String(e3.arg).startsWith('button[type="submit"]'), JSON.stringify(e3 && { level: e3.level, arg: e3.arg }));
const e4 = await resolve(page, { intent: 'submit error message' });
check('E4. a message-shaped intent never derives the submit button css', e4 === null, JSON.stringify(e4));
const e5 = await resolve(page, { intent: 'submit button', css: '#stale-submit' });
check('E5. "submit button" with a css hint that misses returns null even though the smart css would find the submit button', e5 === null, JSON.stringify(e5));

/* ─── F. a STATED role with a name that misses is weaker than a strong hint ── */
await page.setContent(oneButton, { waitUntil: 'load' });
const f1 = await resolve(page, { intent: 'login error message', role: 'button', label: 'Error', testid: 'error' });
check('F1. role button, name Error, testid error, element absent: null (no nameless stated-role try with a stronger hint present)', f1 === null, JSON.stringify(f1));
await page.setContent(oneButton.replace('</form>', '</form><div data-test="error">Error: invalid credentials</div>'), { waitUntil: 'load' });
const f2 = await resolve(page, { intent: 'login error message', role: 'button', label: 'Error', testid: 'error' });
check('F2. the same call with the element present resolves the error element, not the button', f2 !== null && (await f2.locator.getAttribute('data-test')) === 'error', JSON.stringify(f2 && { level: f2.level, arg: f2.arg }));
await page.setContent(oneButton, { waitUntil: 'load' });
const f3 = await resolve(page, { intent: 'the only control', role: 'button' });
check('F3. role button with no name and no other hints: the button (the nameless stated try still serves hint-less calls)', f3 !== null && f3.level === 'role' && JSON.stringify(f3.arg) === JSON.stringify({ role: 'button' }), JSON.stringify(f3 && { level: f3.level, arg: f3.arg }));

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: intent-derived tiers (smart css, intent as text, the nameless role tries) run only for hint-less calls, explicit hints that miss return null, message intents never guess or derive a control, a stated role\'s nameless try yields to stronger hints, and recovery accepts only named matches.');
