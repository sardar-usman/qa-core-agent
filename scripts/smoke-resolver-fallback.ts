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

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the nameless guessed-role fallback runs last and only for hint-less intents, explicit hints that miss return null, message intents never guess a control, and recovery accepts only named matches.');
