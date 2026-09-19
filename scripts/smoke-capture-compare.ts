/**
 * Locks the capture-and-compare primitive (tools.ts + replay.ts +
 * transcriber.ts + gate.ts).
 *
 * The contract the user asked for:
 *   1. Capture a REAL runtime value (attribute, text, or count) into a named
 *      variable. The value is read off the page, never a literal the model
 *      invents.
 *   2. After an action, assert a relationship to the captured value: changed,
 *      unchanged, equal, greater, less, or the old value is now absent.
 *   3. The emitted spec reads the value, stores it, acts, re-reads, and asserts
 *      the relationship — no placeholder strings.
 *
 * Each part drives a real (headless) page through the actual tools, inspects
 * the recorded trace + the live verdict, then checks the emitted spec.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { transcribe } from '../src/agent/transcriber.js';
import { awaitCaptureReady, replayScenarioOnce } from '../src/agent/replay.js';
import type { RunReport, Scenario, SelectorRecord, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const browser = await chromium.launch();
const context = await browser.newContext();
await installEvalShim(context);
const page = await context.newPage();

const ctx = createContext(page, 80);

/* ─── A. capture an attribute, act, assert it CHANGED ─────────────────────── */
// A button whose id regenerates on click. The stable handle is its text "Go".
const dynamicIdHtml = `
<!doctype html><html><body>
<button id="btn-original" onclick="this.id='btn-'+Math.floor(Math.random()*1e9)">Go</button>
</body></html>`;
await page.setContent(dynamicIdHtml, { waitUntil: 'load' });

await runTool(ctx, { name: 'begin_scenario', input: { name: 'button id regenerates on click', category: 'happy', feature: 'dynamic-id' } });
const capA = await runTool(ctx, { name: 'capture', input: { name: 'oldId', source: 'attribute', attribute: 'id', role: 'button', label: 'Go', intent: 'Go button' } });
check('A1. capture(attribute id) read the REAL id off the page', capA.ok === true && (capA.data as { value?: string }).value === 'btn-original', JSON.stringify(capA));
await runTool(ctx, { name: 'click', input: { intent: 'Go button', role: 'button', label: 'Go' } });
const cmpA = await runTool(ctx, { name: 'assert_compare', input: { name: 'oldId', relation: 'changed' } });
check('A2. assert_compare(changed) passes after the id regenerated', cmpA.ok === true, JSON.stringify(cmpA));
const stepsA = ctx.current!.steps;
check('A3. recorded a capture step (attribute, id)', stepsA.some((s) => s.kind === 'capture' && s.source === 'attribute' && s.attribute === 'id'));
check('A4. recorded an assert_compare(changed) step', stepsA.some((s) => s.kind === 'assert_compare' && s.relation === 'changed'));
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── B. capture a count, act, assert it INCREASED ────────────────────────── */
const listHtml = `
<!doctype html><html><body>
<ul id="list"><li class="item">a</li><li class="item">b</li></ul>
<button onclick="const li=document.createElement('li');li.className='item';li.textContent='x';document.getElementById('list').appendChild(li);">Add</button>
</body></html>`;
await page.setContent(listHtml, { waitUntil: 'load' });

await runTool(ctx, { name: 'begin_scenario', input: { name: 'adding an item increases the list count', category: 'happy', feature: 'list' } });
const capB = await runTool(ctx, { name: 'capture', input: { name: 'startCount', source: 'count', css: '.item', intent: 'list items' } });
check('B1. capture(count) read the starting count "2"', capB.ok === true && (capB.data as { value?: string }).value === '2', JSON.stringify(capB));
await runTool(ctx, { name: 'click', input: { intent: 'Add button', role: 'button', label: 'Add' } });
const cmpB = await runTool(ctx, { name: 'assert_compare', input: { name: 'startCount', relation: 'greater', css: '.item' } });
check('B2. assert_compare(greater) passes after the count went up', cmpB.ok === true, JSON.stringify(cmpB));
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── C. capture a value, act, assert the OLD value is ABSENT ─────────────── */
await page.setContent(dynamicIdHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'old id no longer matches after regeneration', category: 'edge', feature: 'dynamic-id' } });
const capC = await runTool(ctx, { name: 'capture', input: { name: 'goneId', source: 'attribute', attribute: 'id', role: 'button', label: 'Go', intent: 'Go button' } });
check('C1. capture read the id before the action', capC.ok === true && (capC.data as { value?: string }).value === 'btn-original');
await runTool(ctx, { name: 'click', input: { intent: 'Go button', role: 'button', label: 'Go' } });
const cmpC = await runTool(ctx, { name: 'assert_compare', input: { name: 'goneId', relation: 'absent' } });
check('C2. assert_compare(absent) passes — the old id matches nothing now', cmpC.ok === true, JSON.stringify(cmpC));
await runTool(ctx, { name: 'end_scenario', input: {} });

/* ─── D. falsifiability: changed must FAIL when the value did not change ───── */
const staticIdHtml = `
<!doctype html><html><body>
<button id="btn-static">Stay</button>
</body></html>`;
await page.setContent(staticIdHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'static id does not change', category: 'negative', feature: 'dynamic-id' } });
await runTool(ctx, { name: 'capture', input: { name: 'sameId', source: 'attribute', attribute: 'id', role: 'button', label: 'Stay', intent: 'Stay button' } });
await runTool(ctx, { name: 'click', input: { intent: 'Stay button', role: 'button', label: 'Stay' } });
const cmpD = await runTool(ctx, { name: 'assert_compare', input: { name: 'sameId', relation: 'changed' } });
check('D1. assert_compare(changed) FAILS when the id stayed the same', cmpD.ok === false && /relation does not hold/.test(cmpD.error ?? ''), JSON.stringify(cmpD));
// Abandon this scenario — it was only here to prove the assertion can fail.
ctx.current = null;

/* ─── E. capture without a prior capture name is rejected ─────────────────── */
await runTool(ctx, { name: 'begin_scenario', input: { name: 'compare with no capture', category: 'happy', feature: 'list' } });
const cmpE = await runTool(ctx, { name: 'assert_compare', input: { name: 'neverCaptured', relation: 'changed' } });
check('E1. assert_compare with an unknown name is rejected', cmpE.ok === false && /No capture named/.test(cmpE.error ?? ''));
ctx.current = null;

/* ─── G. capture readiness: replay waits for a delayed render ─────────────── */
// A live replay read a list count of 0 before the SPA rendered, then failed a
// correct assert_compare(less), because nothing can be less than 0. The
// capture read must wait for the target to have at least one match before
// reading, except for 'absent' relations where zero is a legitimate baseline.
{
  const delayedHtml = `
    <html><body>
      <button id="remove" onclick="document.querySelector('li.product') && document.querySelector('li.product').remove()">remove</button>
      <ul id="list"></ul>
      <script>
        setTimeout(function () {
          var ul = document.getElementById('list');
          ul.innerHTML = '<li class="product">A</li><li class="product">B</li><li class="product">C</li>';
        }, 700);
      </script>
    </body></html>`;
  const dataUrl = 'data:text/html,' + encodeURIComponent(delayedHtml);
  const listTarget: SelectorRecord = { level: 'css', arg: 'li.product', intent: 'product rows' };
  const delayedScenario: Scenario = {
    name: 'removing a product lowers the count',
    category: 'happy',
    steps: [
      { kind: 'navigate', url: dataUrl },
      { kind: 'capture', varName: 'cap_items', source: 'count', target: listTarget, intent: 'product rows' },
      { kind: 'click', target: { level: 'css', arg: '#remove', intent: 'remove button' } },
      { kind: 'assert_compare', varName: 'cap_items', relation: 'less', source: 'count', target: listTarget, intent: 'product rows', readVar: 'cap_items_after' },
    ],
  };
  const verdict = await replayScenarioOnce(browser, delayedScenario, undefined, 8000);
  check('G1. the capture waits for the delayed render and the less-relation replay passes',
    verdict.passed === true, JSON.stringify(verdict));

  // Direct readiness checks on the helper.
  await page.setContent('<div id="static">here</div>');
  const missing: SelectorRecord = { level: 'css', arg: '.never-rendered', intent: 'ghost' };
  const capOf = (target: SelectorRecord): Extract<TraceStep, { kind: 'capture' }> =>
    ({ kind: 'capture', varName: 'v', source: 'count', target, intent: target.intent });

  let t0 = Date.now();
  await awaitCaptureReady(page, capOf(missing), 'absent', 3000);
  check('G2. an absent-relation capture does not wait (zero is a legitimate baseline)', Date.now() - t0 < 400, `${Date.now() - t0}ms`);

  t0 = Date.now();
  await awaitCaptureReady(page, capOf(missing), undefined, 3000);
  check('G3. a capture no compare reads does not wait', Date.now() - t0 < 400, `${Date.now() - t0}ms`);

  await page.setContent('<ul id="l"></ul><script>setTimeout(function(){document.getElementById("l").innerHTML="<li class=late>x</li>";},500);</script>');
  t0 = Date.now();
  await awaitCaptureReady(page, capOf({ level: 'css', arg: 'li.late', intent: 'late rows' }), 'less', 5000);
  const waited = Date.now() - t0;
  check('G4. a less-relation capture waits for the target to render', waited >= 350 && waited < 4000, `${waited}ms`);

  t0 = Date.now();
  await awaitCaptureReady(page, capOf(missing), 'greater', 1200);
  check('G5. the wait is a grace: on timeout it falls through instead of throwing', Date.now() - t0 >= 1000, `${Date.now() - t0}ms`);
}

/* ─── H. text order: before / after for a name sort ────────────────────────── */
const sortHtml = `
<!doctype html><html><body>
<ul id="names"><li class="name">Combination Pliers</li><li class="name">Adjustable Wrench</li><li class="name">Bolt Cutters</li></ul>
<button id="sort" onclick="const ul=document.getElementById('names');[...ul.children].sort((a,b)=>a.textContent.localeCompare(b.textContent)).forEach(li=>ul.appendChild(li));">Sort A-Z</button>
</body></html>`;
await page.setContent(sortHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'sorted the names A to Z and the first name moved earlier', category: 'happy', feature: 'list' } });
// A role hint (listitem, first of several) keeps the capture off RULE 3's positional-css rejection.
const capH = await runTool(ctx, { name: 'capture', input: { name: 'firstName', source: 'text', role: 'listitem', intent: 'first name' } });
check('H1. captured the first name before the sort', capH.ok === true && (capH.data as { value?: string }).value === 'Combination Pliers', JSON.stringify(capH));
await runTool(ctx, { name: 'click', input: { intent: 'Sort button', role: 'button', label: 'Sort A-Z' } });
const cmpAfter = await runTool(ctx, { name: 'assert_compare', input: { name: 'firstName', relation: 'after', role: 'listitem' } });
check('H2. assert_compare(after) FAILS when the new first name sorts before the captured one', cmpAfter.ok === false && /relation does not hold/.test(cmpAfter.error ?? ''), JSON.stringify(cmpAfter));
const cmpBefore = await runTool(ctx, { name: 'assert_compare', input: { name: 'firstName', relation: 'before', role: 'listitem' } });
check('H3. assert_compare(before) passes: "Adjustable Wrench" sorts before "Combination Pliers"', cmpBefore.ok === true, JSON.stringify(cmpBefore));
await runTool(ctx, { name: 'end_scenario', input: {} });
const hRecorded = ctx.scenarios[ctx.scenarios.length - 1];
check('H4. the recorded scenario carries the before relation', hRecorded?.steps.some((st: TraceStep) => st.kind === 'assert_compare' && st.relation === 'before') === true, JSON.stringify(hRecorded?.steps));

/* ─── I. cross-element compare: the compare re-reads the element it names ── */
// Run 5e4394: the model captured the listing name, clicked through, and passed
// css "h1" to assert_compare eight times; the handler ignored the hints and
// re-read the listing selector on the detail page (the first related-product
// card). With hints the compare now resolves THAT element and records it as
// readTarget, so replay and the emitted spec read the heading, not the card.
const listingHtml = `
<!doctype html><html><body>
<a class="card" href="#" id="open"><h5>Sheet Sander</h5><span class="card-footer">$58.48</span></a>
<script>
  document.getElementById('open').addEventListener('click', function (e) {
    e.preventDefault();
    document.body.innerHTML = '<h1 data-test="product-name">Sheet Sander</h1><span data-test="unit-price">$58.48</span>'
      + '<h2>Related products</h2><a class="card" href="#"><h5>Random Orbit Sander</h5><span class="card-footer">$12.00</span></a>';
  });
</script>
</body></html>`;
const listingUrl = 'data:text/html,' + encodeURIComponent(listingHtml);
// The navigate tool takes http(s) only; the live part loads the page directly
// and the replay copy gets a navigate step to the same markup as a data URL.
await page.setContent(listingHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'clicked a product and the detail page showed the listing name and price', category: 'happy', feature: 'catalogue' } });
const capI = await runTool(ctx, { name: 'capture', input: { name: 'listingName', source: 'text', css: 'a.card h5', intent: 'first card name' } });
check('I1. captured the listing name', capI.ok === true && (capI.data as { value?: string }).value === 'Sheet Sander', JSON.stringify(capI));
const capIp = await runTool(ctx, { name: 'capture', input: { name: 'listingPrice', source: 'text', css: 'a.card .card-footer', intent: 'first card price' } });
check('I2. captured the listing price', capIp.ok === true && (capIp.data as { value?: string }).value === '$58.48', JSON.stringify(capIp));
await runTool(ctx, { name: 'click', input: { intent: 'first product card', css: 'a.card' } });
const cmpISame = await runTool(ctx, { name: 'assert_compare', input: { name: 'listingName', relation: 'equal' } });
check('I3. with NO hints the compare re-reads the capture element (the related card) and fails honestly', cmpISame.ok === false && /Random Orbit Sander/.test(cmpISame.error ?? ''), JSON.stringify(cmpISame));
const cmpI = await runTool(ctx, { name: 'assert_compare', input: { name: 'listingName', relation: 'equal', css: 'h1', intent: 'detail heading' } });
check('I4. with css "h1" the compare re-reads the detail heading and passes', cmpI.ok === true, JSON.stringify(cmpI));
const cmpIp = await runTool(ctx, { name: 'assert_compare', input: { name: 'listingPrice', relation: 'equal', css: '[data-test="unit-price"]', intent: 'detail price' } });
check('I5. the price compare re-reads the detail price element', cmpIp.ok === true, JSON.stringify(cmpIp));
const iSteps = ctx.current!.steps;
const iCompare = iSteps.find((st) => st.kind === 'assert_compare' && st.varName === 'cap_listingName');
check('I6. the recorded compare carries readTarget = the heading, target = the card',
  !!iCompare && iCompare.kind === 'assert_compare' && iCompare.readTarget?.level === 'css' && String(iCompare.readTarget?.arg) === 'h1' && String(iCompare.target.arg) === 'a.card h5', JSON.stringify(iCompare));
await runTool(ctx, { name: 'end_scenario', input: {} });
const iRecorded = ctx.scenarios[ctx.scenarios.length - 1]!;
const iReplay = await replayScenarioOnce(browser, { ...iRecorded, steps: [{ kind: 'navigate', url: listingUrl }, ...iRecorded.steps] }, undefined, 8000);
check('I7. replay reads the heading (readTarget), so the cross-element compare passes on a fresh context', iReplay.passed === true, JSON.stringify(iReplay));

/* ─── J. numeric relations parse formatted text ─────────────────────────── */
// Run 5e4394: Number("$48.41") is NaN, so greater and less were false for every
// price in the tool, in replay and in the emitted spec. The first number in
// the text is what compares now, and a side with no number fails loudly.
const priceHtml = `
<!doctype html><html><body>
<span id="price">$4.92</span><span id="total">999</span><span id="label">Loading</span><span id="num">5</span>
<button id="sort" onclick="document.getElementById('price').textContent='$48.41';document.getElementById('total').textContent='1,299.00';document.getElementById('label').textContent='Ready';document.getElementById('num').textContent='n/a';">Sort</button>
</body></html>`;
await page.setContent(priceHtml, { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'sorted by price high to low and the first price rose', category: 'happy', feature: 'catalogue' } });
await runTool(ctx, { name: 'capture', input: { name: 'firstPrice', source: 'text', css: '#price', intent: 'first price' } });
await runTool(ctx, { name: 'capture', input: { name: 'total', source: 'text', css: '#total', intent: 'total' } });
await runTool(ctx, { name: 'capture', input: { name: 'label', source: 'text', css: '#label', intent: 'label' } });
await runTool(ctx, { name: 'capture', input: { name: 'num', source: 'text', css: '#num', intent: 'number' } });
await runTool(ctx, { name: 'click', input: { intent: 'Sort button', role: 'button', label: 'Sort' } });
const cmpJ1 = await runTool(ctx, { name: 'assert_compare', input: { name: 'firstPrice', relation: 'greater' } });
check('J1. "$48.41" greater than the captured "$4.92" passes (currency parsed)', cmpJ1.ok === true, JSON.stringify(cmpJ1));
const cmpJ1b = await runTool(ctx, { name: 'assert_compare', input: { name: 'firstPrice', relation: 'less' } });
check('J2. "$48.41" less than "$4.92" fails on the numbers, not on the format', cmpJ1b.ok === false && /relation does not hold/.test(cmpJ1b.error ?? ''), JSON.stringify(cmpJ1b));
const cmpJ2 = await runTool(ctx, { name: 'assert_compare', input: { name: 'total', relation: 'greater' } });
check('J3. "1,299.00" greater than "999" passes (thousands separator dropped)', cmpJ2.ok === true, JSON.stringify(cmpJ2));
const cmpJ3 = await runTool(ctx, { name: 'assert_compare', input: { name: 'label', relation: 'greater' } });
check('J4. a captured side with no number is a loud rejection, never a silent false', cmpJ3.ok === false && /no number found in "Loading"/.test(cmpJ3.error ?? ''), JSON.stringify(cmpJ3));
const cmpJ4 = await runTool(ctx, { name: 'assert_compare', input: { name: 'num', relation: 'less' } });
check('J5. a re-read side with no number is a loud rejection naming the text', cmpJ4.ok === false && /no number found in "n\/a"/.test(cmpJ4.error ?? ''), JSON.stringify(cmpJ4));
await runTool(ctx, { name: 'end_scenario', input: {} });
const jRecorded = ctx.scenarios[ctx.scenarios.length - 1]!;
const jReplay = await replayScenarioOnce(browser, { ...jRecorded, steps: [{ kind: 'navigate', url: 'data:text/html,' + encodeURIComponent(priceHtml) }, ...jRecorded.steps] }, undefined, 8000);
check('J6. replay parses the same numbers and the greater compares pass', jReplay.passed === true, JSON.stringify(jReplay));

/* ─── K. a compare with no action since the capture is circular ──────────── */
// Run 5e4394 recorded five equal / unchanged compares straight after their
// capture; the Critic reworked the only re-recorded repair for them. The tool
// now refuses that shape (invariant 17 at the tool) with the same wording.
await page.setContent('<span id="price">$4.92</span><span id="a">same</span><span id="b">same</span><button id="noop" onclick="void 0">Reload view</button>', { waitUntil: 'load' });
await runTool(ctx, { name: 'begin_scenario', input: { name: 'price held after the view reloaded', category: 'happy', feature: 'catalogue' } });
await runTool(ctx, { name: 'capture', input: { name: 'held', source: 'text', css: '#price', intent: 'price' } });
const cmpK1 = await runTool(ctx, { name: 'assert_compare', input: { name: 'held', relation: 'equal' } });
check('K1. equal with no action since the capture is rejected as circular', cmpK1.ok === false && /compares a value to itself; act first, or use changed/.test(cmpK1.error ?? ''), JSON.stringify(cmpK1));
const cmpK2 = await runTool(ctx, { name: 'assert_compare', input: { name: 'held', relation: 'unchanged' } });
check('K2. unchanged with no action is rejected the same way', cmpK2.ok === false && /compares a value to itself/.test(cmpK2.error ?? ''), JSON.stringify(cmpK2));
await runTool(ctx, { name: 'capture', input: { name: 'left', source: 'text', css: '#a', intent: 'left value' } });
const cmpK3 = await runTool(ctx, { name: 'assert_compare', input: { name: 'left', relation: 'equal', css: '#b', intent: 'right value' } });
check('K3. equal against a DIFFERENT element with no action is a real comparison and passes', cmpK3.ok === true, JSON.stringify(cmpK3));
await runTool(ctx, { name: 'click', input: { intent: 'Reload view button', role: 'button', label: 'Reload view' } });
const cmpK4 = await runTool(ctx, { name: 'assert_compare', input: { name: 'held', relation: 'equal' } });
check('K4. equal after an action is falsifiable and passes', cmpK4.ok === true, JSON.stringify(cmpK4));
await runTool(ctx, { name: 'end_scenario', input: {} });

await browser.close();

/* ─── F. the emitted spec reads real values and asserts relationships ─────── */
const report: RunReport = {
  url: 'http://example.com/dynamicid', language: 'ts',
  scenarios: ctx.scenarios as Scenario[],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0, startedAt: '', finishedAt: '',
};
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-capcmp-'));
const { specPath } = transcribe({ report, outDir, name: 'dynamicid' });
const spec = fs.readFileSync(specPath, 'utf8');
fs.rmSync(outDir, { recursive: true, force: true });

check('F1. spec declares a captured const read via getAttribute("id")', /const cap_\w+ = \(await .*getAttribute\("id"\)\)\?\.trim\(\) \?\? '';/.test(spec));
check('F2. spec polls the re-read value .not.toBe the captured one (changed)', /await expect\.poll\(async \(\) => .+, \{ timeout: \d+ \}\)\.not\.toBe\(cap_\w+\)/.test(spec));
check('F3. spec reads a count and polls until it is greater (through parseNumber)', /\.count\(\)/.test(spec) && /await expect\.poll\(async \(\) => parseNumber\(.+\), \{ timeout: \d+ \}\)\.toBeGreaterThan\(parseNumber\(cap_\w+\)\)/.test(spec));
check('F5. spec polls the text order with localeCompare for the before relation', /await expect\.poll\(async \(\) => String\(.+\)\.localeCompare\(cap_\w+\), \{ timeout: \d+ \}\)\.toBeLessThan\(0\)/.test(spec), spec.split('\n').filter((l) => /localeCompare/.test(l)).join(' | '));
check('F4. spec asserts the old value is absent via a value selector + count 0', /page\.locator\(`\[id="\$\{cap_\w+\}"\]`\)\)\.toHaveCount\(0\)/.test(spec));
check('F5. spec contains NO invented placeholder id strings', !/button-fixed-id|previously-captured-id|placeholder/i.test(spec));
check('F6. the cross-element compare in the spec reads the heading locator, not the card',
  /await expect\.poll\(async \(\) => \(await page\.locator\("h1"\)\.first\(\)\.textContent\(\)\)\?\.trim\(\) \?\? '', \{ timeout: \d+ \}\)\.toBe\(cap_listingName\)/.test(spec),
  spec.split('\n').filter((l) => /cap_listingName/.test(l)).join(' | '));
check('F7. the spec never re-reads "a.card h5" for the cross-element compare', !/expect\.poll\(async \(\) => \(await page\.locator\("a\.card h5"\)/.test(spec));
check('F8. numeric compares in the spec go through parseNumber, and the parser is inlined',
  /await expect\.poll\(async \(\) => parseNumber\(.+\), \{ timeout: \d+ \}\)\.toBeGreaterThan\(parseNumber\(cap_firstPrice\)\)/.test(spec) && /^function parseNumber\(text\)/m.test(spec) && !/\bNumber\(cap_firstPrice\)/.test(spec),
  spec.split('\n').filter((l) => /parseNumber/.test(l)).slice(0, 3).join(' | '));
check('F9. the inlined parser throws on text with no number (loud in the shipped spec too)', /throw new Error\('no number found in '/.test(spec));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: capture-and-compare — real values captured, changed/greater/absent asserted, cross-element compares read the named element, numbers parse out of formatted text, circular compares are refused, no placeholder strings.');
