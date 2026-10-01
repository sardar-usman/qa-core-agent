/**
 * Smoke test for the tool surface in tools.ts against a tiny inline page.
 * Runs in real Chromium, no network, no LLM.
 *
 *   1. get_dom under tsx: the page.evaluate paths that errored with
 *      "__name is not defined" in an early live run; required, disabled and
 *      validation form state surface.
 *   2. get_dom's FIRST line names the test-id attribute the page uses
 *      ("test-id attribute on this page: data-test"); run 51d535 guessed
 *      data-testid on a data-test site twice.
 *   3. Live probes fail fast: a zero-match count probe returns in about
 *      LIVE_PROBE_TIMEOUT_MS (10 s), never the 60 s adaptive ceiling, while
 *      the RECORDED timeout is still the model's value or the adaptive one.
 *   4. Gate rules at record time: RULE 3 (positional css outside a table),
 *      RULE 6 (generated id) and RULE 8 (price in a locator name) are
 *      refused when a capture, assert, assert_compare or action is called,
 *      with the end_scenario gate's message, and nothing is recorded; a
 *      positional selector inside a table and a price-free name pass.
 */
import { chromium } from 'playwright';
import { createContext, runTool, LIVE_PROBE_TIMEOUT_MS, type ToolContext } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { PRICE_IN_NAME_STEER } from '../src/agent/gate.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

const html = `
<!doctype html><html><head><title>Toolshop</title></head><body>
<h1>Login</h1>
<form>
  <label>Email <input id="email" name="email" data-test="email" required></label>
  <label>Password <input id="pass" name="pass" type="password" data-test="password" required></label>
  <button type="submit" data-test="login-submit">Sign in</button>
  <button type="button" disabled>Disabled action</button>
</form>
<ul class="cards">
  <li class="card"><a href="/product/1" data-test="product-01">Bolt Cutters <span class="price" data-test="product-price">$48.41</span></a></li>
  <li class="card"><a href="/product/2" data-test="product-02">Pliers <span class="price" data-test="product-price">$14.15</span></a></li>
</ul>
<table id="table2"><thead><tr><th>Name</th><th>Price</th></tr></thead>
<tbody><tr><td>Bolt Cutters</td><td>48.41</td></tr><tr><td>Pliers</td><td>14.15</td></tr></tbody></table>
<div data-testid="only-one">one data-testid</div>
</body></html>`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await installEvalShim(ctx);   // matches runtime.ts setup
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'load' });

const toolCtx: ToolContext = createContext(page, 200);
const stepsRecorded = (): number => toolCtx.current?.steps.length ?? -1;

/* ─── 1. get_dom under tsx, form state ───────────────────────────────────── */
const got = await runTool(toolCtx, { name: 'get_dom', input: {} });
check('1a. get_dom returns ok under tsx (no __name crash)', got.ok, got.error);
const data = got.data as { note: string; testIdAttribute: string | null; inputs: Array<Record<string, unknown>>; buttons: Array<Record<string, unknown>> };
check('1b. an input reports required', data.inputs.some((i) => i.required === true));
check('1c. a button reports disabled', data.buttons.some((b) => b.disabled === true));
check('1d. a validation message is captured', data.inputs.some((i) => typeof i.validation === 'string' && (i.validation as string).length > 0));

/* ─── 2. the first line names the test-id attribute ──────────────────────── */
const firstKey = Object.keys(data as object)[0];
const firstLine = JSON.stringify(data).split(',')[0];
check('2a. the first key of the get_dom result is the test-id note', firstKey === 'note', firstKey);
check('2b. the line reads verbatim with the dominant attribute and the other one counted', data.note === 'test-id attribute on this page: data-test (data-testid also appears on 1 element(s))', data.note);
check('2c. the first line of the serialized result carries it', firstLine === '{"note":"test-id attribute on this page: data-test (data-testid also appears on 1 element(s))"', firstLine);
check('2d. the dominant attribute is on the result and accumulated on the context for the fingerprint', data.testIdAttribute === 'data-test' && toolCtx._testIdCounts['data-test'] === 7 && toolCtx._testIdCounts['data-testid'] === 1, JSON.stringify(toolCtx._testIdCounts));

/* ─── 3. live probes fail fast; recorded timeouts unchanged ──────────────── */
await runTool(toolCtx, { name: 'begin_scenario', input: { name: 'probe timing', category: 'happy', feature: 'catalogue' } });
await runTool(toolCtx, { name: 'navigate', input: { url: page.url().startsWith('http') ? page.url() : 'about:blank' } }).catch(() => undefined);
await page.setContent(html, { waitUntil: 'load' });
const t0 = Date.now();
const zeroMatch = await runTool(toolCtx, { name: 'assert', input: { type: 'toHaveCount', css: 'a[data-testid^="product-"]', atLeast: 1, intent: 'product cards' } });
const elapsed = Date.now() - t0;
check(`3a. a zero-match atLeast probe fails in about ${LIVE_PROBE_TIMEOUT_MS} ms, not the 60 s ceiling (took ${elapsed} ms)`, !zeroMatch.ok && elapsed >= LIVE_PROBE_TIMEOUT_MS - 500 && elapsed < LIVE_PROBE_TIMEOUT_MS + 6000, zeroMatch.error);
check('3b. the failed probe recorded nothing', toolCtx.current?.steps.filter((s) => s.kind === 'assert').length === 0);
toolCtx._assertFailures.clear();
const t1 = Date.now();
const zeroMatchCount = await runTool(toolCtx, { name: 'assert', input: { type: 'toHaveCount', css: 'a[data-testid^="product-"]', count: 2, intent: 'product cards', timeout: 30000 } });
const elapsedCount = Date.now() - t1;
check(`3c. a zero-match exact-count probe with a 30 s model timeout still fails in about 10 s (took ${elapsedCount} ms)`, !zeroMatchCount.ok && elapsedCount < LIVE_PROBE_TIMEOUT_MS + 6000, zeroMatchCount.error);
toolCtx._assertFailures.clear();
const withTimeout = await runTool(toolCtx, { name: 'assert', input: { type: 'toHaveCount', css: 'a[data-test^="product-"]', atLeast: 1, intent: 'product cards', timeout: 12000 } });
const recordedWith = toolCtx.current?.steps.find((s) => s.kind === 'assert' && s.assertion.type === 'toHaveCount' && (s.assertion as { timeout?: number }).timeout === 12000);
check('3d. a passing atLeast probe records the model\'s timeout (12000), not the live cap', withTimeout.ok && recordedWith !== undefined, JSON.stringify(withTimeout));
const adaptive = await runTool(toolCtx, { name: 'assert', input: { type: 'toHaveCount', css: 'a[data-test^="nothing-"]', count: 0, intent: 'removed cards' } });
const recordedAdaptive = toolCtx.current?.steps.find((s) => s.kind === 'assert' && s.assertion.type === 'toHaveCount' && (s.assertion as { count: number }).count === 0) as { assertion: { timeout?: number } } | undefined;
check('3e. a passing absence probe without a model timeout records the adaptive timeout (at least the 5000 floor, under the live cap on a settled page)', adaptive.ok && (recordedAdaptive?.assertion.timeout ?? 0) >= 5000 && (recordedAdaptive?.assertion.timeout ?? 0) <= 15000, JSON.stringify(recordedAdaptive));
const t2 = Date.now();
const hidden = await runTool(toolCtx, { name: 'assert', input: { type: 'toBeHidden', css: '#no-such-thing', intent: 'missing banner' } });
check('3f. toBeHidden on a missing element passes at once', hidden.ok && Date.now() - t2 < 3000);

/* ─── 4. gate rules at record time ───────────────────────────────────────── */
const endProbe = await runTool(toolCtx, { name: 'end_scenario', input: {} });
check('3g. end_scenario accepts the probe-timing scenario', endProbe.ok === true, endProbe.error);
await runTool(toolCtx, { name: 'begin_scenario', input: { name: 'sorted by price', category: 'happy', feature: 'catalogue' } });
await page.setContent(html, { waitUntil: 'load' });
const before = stepsRecorded();
const r3Capture = await runTool(toolCtx, { name: 'capture', input: { name: 'firstPrice', source: 'text', css: 'li.card:nth-child(1) .price', intent: 'first card price' } });
check('4a. a capture on a positional css outside a table is refused under RULE 3 with the gate\'s message', !r3Capture.ok && /^RULE 3 \(no CSS on animated elements\) rejected this capture: fragile CSS-tier selector "li\.card:nth-child\(1\) \.price" used with capture/.test(r3Capture.error ?? ''), r3Capture.error);
check('4b. nothing was recorded and no capture was registered', stepsRecorded() === before && toolCtx.captures.size === 0);
const tableCapture = await runTool(toolCtx, { name: 'capture', input: { name: 'firstCell', source: 'text', css: '#table2 tbody tr:nth-child(1) td:nth-child(2)', intent: 'first row price cell' } });
check('4c. a positional css INSIDE a table is allowed and records', tableCapture.ok && stepsRecorded() === before + 1 && (tableCapture.data as { value: string }).value === '48.41', tableCapture.error);
const r3Compare = await runTool(toolCtx, { name: 'assert_compare', input: { name: 'firstCell', relation: 'less', css: 'li.card:nth-child(2) .price', intent: 'second card price' } });
check('4d. an assert_compare re-read on a positional css outside a table is refused under RULE 3', !r3Compare.ok && /^RULE 3 .*rejected this assert_compare: fragile CSS-tier selector/.test(r3Compare.error ?? '') && stepsRecorded() === before + 1, r3Compare.error);
const r3Assert = await runTool(toolCtx, { name: 'assert', input: { type: 'toContainText', css: 'li.card:nth-child(1) .price', regex: '\\$\\d+', intent: 'first card price' } });
check('4e. an assertion on a positional css outside a table is refused under RULE 3 before any probe, and the retry cap counts nothing', !r3Assert.ok && /^RULE 3 .*rejected this assert: fragile CSS-tier selector "li\.card:nth-child\(1\) \.price" on a dynamic element/.test(r3Assert.error ?? '') && toolCtx._assertFailures.size === 0 && stepsRecorded() === before + 1, r3Assert.error);
const r6Click = await runTool(toolCtx, { name: 'click', input: { css: 'a[href="/product/3fa85f64-5717-4562-b3fc-2c963f66afa6"]', intent: 'product link' } });
check('4f. a click whose css embeds a generated id is refused under RULE 6 and records nothing', !r6Click.ok && /^RULE 6 \(generated id in selector\) rejected this action: selector .* embeds the generated id "3fa85f64-5717-4562-b3fc-2c963f66afa6"/.test(r6Click.error ?? '') && stepsRecorded() === before + 1, r6Click.error);
const r8Click = await runTool(toolCtx, { name: 'click', input: { role: 'link', label: 'Bolt Cutters $48.41', intent: 'first product card' } });
check('4g. a click by a role name carrying a price is refused under RULE 8 with the prefix steer', !r8Click.ok && /^RULE 8 \(price in locator name\) rejected this action: locator name "Bolt Cutters \$48\.41" contains the price "\$48\.41"/.test(r8Click.error ?? '') && (r8Click.error ?? '').includes(PRICE_IN_NAME_STEER) && stepsRecorded() === before + 1, r8Click.error);
const r8Intent = await runTool(toolCtx, { name: 'press', input: { role: 'link', intent: 'Pliers $14.15', key: 'Enter' } });
check('4h. a stated role whose name would come from a priced intent is refused too', !r8Intent.ok && /RULE 8/.test(r8Intent.error ?? ''), r8Intent.error);
const r8Fill = await runTool(toolCtx, { name: 'fill', input: { label: 'Email $9.99', value: 'a@b.c', intent: 'email input' } });
check('4i. a fill by a label carrying a price is refused under RULE 8', !r8Fill.ok && /RULE 8/.test(r8Fill.error ?? ''), r8Fill.error);
const okClick = await runTool(toolCtx, { name: 'click', input: { role: 'link', label: 'Bolt Cutters', intent: 'first product card' } });
check('4j. the shortest distinguishing prefix passes and records the click', okClick.ok && stepsRecorded() === before + 2 && toolCtx.current?.steps.at(-1)?.kind === 'click', okClick.error);
await page.setContent(html, { waitUntil: 'load' });
const okAssert = await runTool(toolCtx, { name: 'assert', input: { type: 'toContainText', css: '#table2 tbody tr:nth-child(1) td:nth-child(2)', regex: '\\d', intent: 'first row price cell' } });
check('4k. an assertion on a positional css inside a table passes the record-time gate and records', okAssert.ok && stepsRecorded() === before + 3, okAssert.error);
const ended = await runTool(toolCtx, { name: 'end_scenario', input: {} });
check('4l. the scenario closes clean: the end_scenario gate (the backstop) finds nothing to reject', ended.ok && toolCtx.scenarios.length === 2 && toolCtx.brokenByGate.length === 0, ended.error);

await browser.close();

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: get_dom surfaces form state and names the test-id attribute first, count and absence probes fail fast with the recorded timeout unchanged, and RULE 3, 6 and 8 are refused at record time with nothing recorded.');
