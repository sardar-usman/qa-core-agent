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
 *   5. Counters (run 44cb3d: "cart badge shows 1" three times, and a repair
 *      that counted badge elements): a bare integer asserted as a counter's
 *      text is refused under RULE 7 with the capture-then-compare steer, a
 *      count capture on a counter is refused under RULE 9, both before any
 *      probe and with nothing recorded; a text capture plus assert_compare
 *      greater on the badge records, replays on a fresh context and emits
 *      through parseNumber in TypeScript and JavaScript, POM and single
 *      file; a literal "1" on targets named account, discount or a step
 *      number is not a counter and is not refused.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createContext, runTool, LIVE_PROBE_TIMEOUT_MS, type ToolContext } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { PRICE_IN_NAME_STEER, COUNTER_LITERAL_STEER, COUNTER_COUNT_CAPTURE_STEER } from '../src/agent/gate.js';
import { replayScenarioOnce } from '../src/agent/replay.js';
import { transcribePOM } from '../src/agent/pom.js';
import { transcribe } from '../src/agent/transcriber.js';
import type { RunReport, Scenario } from '../src/agent/trace.js';

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

/* ─── 5. counters: read the text, compare, never a literal count ─────────── */
// The badge increments 300 ms after the click, so the compare has to poll.
const badgeHtml = `<!doctype html><html><head><title>Cart</title></head><body>
<header><a href="#cart" data-test="nav-cart">Cart <span data-test="cart-quantity">2</span></a></header>
<button type="button" data-test="add-to-cart" onclick="setTimeout(function () { var b = document.querySelector('[data-test=cart-quantity]'); b.textContent = String(Number(b.textContent) + 1); }, 300)">Add to cart</button>
<p>Account level <span data-test="account-level">1</span></p>
<p>Discount <span data-test="discount-code">1</span></p>
<p>Step <span data-test="step-number">1</span> of 3</p>
</body></html>`;
await page.setContent(badgeHtml, { waitUntil: 'load' });
await runTool(toolCtx, { name: 'begin_scenario', input: { name: 'added a product and the cart count in the header increased', category: 'happy', feature: 'cart' } });
const badgeBefore = stepsRecorded();
toolCtx._assertFailures.clear();
const literalBadge = await runTool(toolCtx, { name: 'assert', input: { type: 'toHaveText', css: "[data-test='cart-quantity']", text: '2', intent: 'cart badge shows 2', timeout: 15000 } });
check('5a. a bare integer asserted as the badge text is refused under RULE 7 with the counter steer, before any probe', !literalBadge.ok && /^RULE 7 \(literal catalogue value\) rejected this assertion: "2" on .*cart-quantity.* is a literal count on a counter; /.test(literalBadge.error ?? '') && (literalBadge.error ?? '').includes(COUNTER_LITERAL_STEER) && toolCtx._assertFailures.size === 0 && stepsRecorded() === badgeBefore, literalBadge.error);
const literalQty = await runTool(toolCtx, { name: 'assert', input: { type: 'toContainText', testid: 'cart-quantity', text: ' 2 ', intent: 'header quantity' } });
check('5b. the same literal through a testid and toContainText is refused too', !literalQty.ok && (literalQty.error ?? '').includes(COUNTER_LITERAL_STEER) && stepsRecorded() === badgeBefore, literalQty.error);
const waitBadge = await runTool(toolCtx, { name: 'wait_for_text', input: { css: "[data-test='cart-quantity']", text: '2', intent: 'cart badge' } });
check('5c. a wait_for_text for a bare integer on the badge is refused the same way (it records the same literal)', !waitBadge.ok && (waitBadge.error ?? '').includes(COUNTER_LITERAL_STEER) && stepsRecorded() === badgeBefore, waitBadge.error);
const countBadge = await runTool(toolCtx, { name: 'capture', input: { name: 'cartBefore', source: 'count', css: "[data-test='cart-quantity']", intent: 'cart badge count elements before add' } });
check('5d. a count capture on the badge is refused under RULE 9 with the read-its-text steer, nothing recorded or registered', !countBadge.ok && /^RULE 9 \(counter read as an element count\) rejected this capture: /.test(countBadge.error ?? '') && (countBadge.error ?? '').includes(COUNTER_COUNT_CAPTURE_STEER) && stepsRecorded() === badgeBefore && toolCtx.captures.size === 0, countBadge.error);
const textBadge = await runTool(toolCtx, { name: 'capture', input: { name: 'cartBefore', source: 'text', css: "[data-test='cart-quantity']", intent: 'cart badge before add' } });
check('5e. a text capture on the badge records the number shown', textBadge.ok && (textBadge.data as { value: string }).value === '2' && stepsRecorded() === badgeBefore + 1, textBadge.error);
await runTool(toolCtx, { name: 'click', input: { testid: 'add-to-cart', intent: 'add to cart button' } });
const greaterBadge = await runTool(toolCtx, { name: 'assert_compare', input: { name: 'cartBefore', relation: 'greater', intent: 'cart badge after add' } });
check('5f. assert_compare greater on the re-read badge text passes once the badge settles', greaterBadge.ok && toolCtx.current?.steps.at(-1)?.kind === 'assert_compare', greaterBadge.error);
const endBadge = await runTool(toolCtx, { name: 'end_scenario', input: {} });
check('5g. end_scenario accepts the counter scenario: the end gate finds nothing to reject', endBadge.ok && toolCtx.brokenByGate.length === 0, endBadge.error);
const badgeScenario = toolCtx.scenarios.at(-1) as Scenario;
const badgeReplay = await replayScenarioOnce(browser, { ...badgeScenario, steps: [{ kind: 'navigate', url: 'data:text/html,' + encodeURIComponent(badgeHtml) }, ...badgeScenario.steps] }, undefined, 8000);
check('5h. the recorded counter scenario replays green on a fresh context', badgeReplay.passed === true, JSON.stringify(badgeReplay));

await page.setContent(badgeHtml, { waitUntil: 'load' });
await runTool(toolCtx, { name: 'begin_scenario', input: { name: 'account and discount details are shown', category: 'happy', feature: 'account' } });
const notCounters = [
  { testid: 'account-level', intent: 'account level' },
  { testid: 'discount-code', intent: 'discount code' },
  { css: "[data-test='step-number']", intent: 'step indicator' },
];
const notCounterResults = [];
for (const hints of notCounters) notCounterResults.push(await runTool(toolCtx, { name: 'assert', input: { type: 'toHaveText', text: '1', timeout: 10000, ...hints } }));
check('5i. a literal "1" on targets named account, discount and a step number is not a counter: each assertion passes and records', notCounterResults.every((r) => r.ok) && (toolCtx.current?.steps.filter((st) => st.kind === 'assert').length ?? 0) === 3, JSON.stringify(notCounterResults));
const endNotCounters = await runTool(toolCtx, { name: 'end_scenario', input: {} });
check('5j. the end gate accepts them too', endNotCounters.ok && toolCtx.brokenByGate.length === 0, endNotCounters.error);

// RULE 9 reads the selector, never the intent: a list count whose intent says
// "count" is the working filter shape (capture count, act, compare less).
const listHtml = `<!doctype html><html><head><title>Tools</title></head><body>
<p>Cart <span id="n">3</span></p>
<button type="button" data-test="eco-filter" onclick="document.querySelectorAll('[data-test=product-name]')[0].remove()">Eco only</button>
<ul><li data-test="product-name">Hammer</li><li data-test="product-name">Saw</li><li data-test="product-name">Pliers</li></ul>
</body></html>`;
await page.setContent(listHtml, { waitUntil: 'load' });
const listBegin = await runTool(toolCtx, { name: 'begin_scenario', input: { name: 'the eco filter narrowed the product list', category: 'happy', feature: 'catalogue' } });
const listBefore = stepsRecorded();
const productCount = await runTool(toolCtx, { name: 'capture', input: { name: 'productsBefore', source: 'count', css: "[data-test='product-name']", intent: 'product count before filter' } });
check('5m. a count capture with intent "product count before filter" on css [data-test=\'product-name\'] is accepted and records the list count', listBegin.ok && productCount.ok && (productCount.data as { value: string }).value === '3' && stepsRecorded() === listBefore + 1, productCount.error ?? listBegin.error);
const cartCountN = await runTool(toolCtx, { name: 'capture', input: { name: 'nBefore', source: 'count', css: '#n', intent: 'cart count' } });
check('5n. a count capture with intent "cart count" on css "#n" is accepted: the selector names no counter', cartCountN.ok && (cartCountN.data as { value: string }).value === '1' && stepsRecorded() === listBefore + 2, cartCountN.error);
const stillRefused = await runTool(toolCtx, { name: 'capture', input: { name: 'badgeBefore', source: 'count', css: "[data-test='cart-quantity']", intent: 'products in the list' } });
check('5o. a count capture on [data-test=\'cart-quantity\'] is still refused under RULE 9, whatever its intent says', !stillRefused.ok && /^RULE 9 \(counter read as an element count\) rejected this capture: count capture on \[data-test='cart-quantity'\] reads/.test(stillRefused.error ?? '') && stepsRecorded() === listBefore + 2, stillRefused.error);
const filterClick = await runTool(toolCtx, { name: 'click', input: { testid: 'eco-filter', intent: 'eco filter button' } });
const listLess = await runTool(toolCtx, { name: 'assert_compare', input: { name: 'productsBefore', relation: 'less', intent: 'product count after filter' } });
check('5p. the filter click and the compare less on the list count pass', filterClick.ok && listLess.ok, filterClick.error ?? listLess.error);
const listEnd = await runTool(toolCtx, { name: 'end_scenario', input: {} });
check('5q. end_scenario accepts the list-count scenario: no RULE 9 at the end gate', listEnd.ok && toolCtx.brokenByGate.length === 0, listEnd.error);

await browser.close();

// The emitted spec reads the badge text, acts, and polls the relation through
// parseNumber, in both languages and both emitters.
const counterReport = (language: 'ts' | 'js'): RunReport => ({
  url: 'https://shop.example.com/', language,
  scenarios: [{ ...badgeScenario, steps: [{ kind: 'navigate', url: 'https://shop.example.com/' }, ...badgeScenario.steps] }],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
});
const emitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-counter-'));
const POLL_GREATER_RE = /await expect\.poll\(async \(\) => parseNumber\(.*textContent\(\).*\), \{ timeout: \d+ \}\)\.toBeGreaterThan\(parseNumber\(cap_cartBefore\)\)/;
for (const language of ['ts', 'js'] as const) {
  const pomDir = path.join(emitRoot, `pom-${language}`);
  const pom = transcribePOM({ report: counterReport(language), outDir: pomDir, name: 'cart' });
  const pomSpec = fs.readFileSync(pom.specFile, 'utf8');
  const pomFiles = [pomSpec, ...pom.pageFiles.map((f) => fs.readFileSync(f, 'utf8'))].join('\n');
  check(`5k. ${language} POM: the badge capture is a text read and the compare polls through parseNumber (greater)`,
    /const cap_cartBefore = .*textContent\(\)/.test(pomSpec) && POLL_GREATER_RE.test(pomSpec) && /parse-number/.test(pomSpec) && !/cap_cartBefore = .*\.count\(\)/.test(pomSpec) && /cart-quantity/.test(pomFiles),
    pomSpec.split('\n').filter((l) => /cap_cartBefore|parse-number/.test(l)).join(' | '));
  const inline = transcribe({ report: counterReport(language), outDir: path.join(emitRoot, `inline-${language}`), name: 'cart' });
  const inlineSpec = fs.readFileSync(inline.specPath, 'utf8');
  check(`5l. ${language} single file: the same text read and parseNumber poll, with the parser inlined`,
    /const cap_cartBefore = .*textContent\(\)/.test(inlineSpec) && POLL_GREATER_RE.test(inlineSpec) && /^function parseNumber\(text\)/m.test(inlineSpec),
    inlineSpec.split('\n').filter((l) => /cap_cartBefore/.test(l)).join(' | '));
}
fs.rmSync(emitRoot, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: get_dom surfaces form state and names the test-id attribute first, count and absence probes fail fast with the recorded timeout unchanged, RULE 3, 6 and 8 are refused at record time with nothing recorded, and a counter is read by its text (a literal count and a count capture refused, a text capture plus greater recorded, replayed and emitted through parseNumber in TS and JS; RULE 9 judges the selector, so a list count whose intent says count is recorded).');
