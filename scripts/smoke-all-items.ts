/**
 * Locks the all-items assertion (invariant 77, run 59540f D5).
 *
 * Run 7 shipped "[happy] search for term filtered list to only matching
 * product names", whose recording checked the FIRST card only. The assert
 * tool now offers allItemsMatch: "no item in <list> fails to match <the
 * value the scenario typed>", recorded as two checks on the item locator:
 * the items whose text does not match number 0
 * (locator.filter({ hasNotText }) with toHaveCount(0)), then the list has at
 * least 1 item (toHaveCount atLeast 1), so an empty list can never pass.
 *
 * A fixture search page renders a full catalogue, then after the search the
 * route's results: /mixed shows Pliers, Long Nose Pliers and Hammer;
 * /pliers shows only pliers; /empty shows nothing.
 *   A. the tool: mixed FAILS, pliers passes and records the pair after the
 *      last action with the typed value as the pattern, empty is refused by
 *      the minimum check, a pattern the scenario did not type is refused by
 *      RULE 7 with nothing recorded.
 *   B. replay: the pliers recording passes; the same steps against /mixed
 *      fail at the filter check and against /empty at the minimum.
 *   C. the emitted spec, TS and JS, POM and single file, run with Playwright
 *      against /search in three modes: the same test passes on pliers only
 *      and FAILS on the mixed list (the filter check) and on an empty list
 *      (the minimum).
 *   D. the end gate refuses an untyped pattern (the backstop) and accepts a
 *      search term the scenario opened the page with.
 * No network beyond 127.0.0.1, no model call.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { replayScenarioOnce } from '../src/agent/replay.js';
import { runGate } from '../src/agent/gate.js';
import { typedValues } from '../src/agent/all-items.js';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';
import { emitFramework, emptyTextHits, runPlaywright, cleanup, type Emitted } from './lib/emitted-runner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── the fixture site ─────────────────────────────────────────────────── */
const RESULTS: Record<string, string[]> = {
  '/mixed': ['Pliers', 'Long Nose Pliers', 'Hammer'],
  '/pliers': ['Pliers', 'Long Nose Pliers'],
  '/empty': [],
};
// The full catalogue is on the page before the search lands (300 ms after
// the submit), so a check that reads the list too early sees non-matching
// items: the filter check must wait for the search, not pass on a stale list.
const pageFor = (results: string[]): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tools</title></head><body><main>
<h1>Tools</h1>
<form id="f" role="search"><label for="q">Search</label><input id="q" name="q" type="search"><button type="submit" data-test="search-submit">Go</button></form>
<section id="results" aria-label="results"></section>
<script>
function render(list) {
  const r = document.getElementById('results');
  r.innerHTML = '';
  for (const n of list) {
    const a = document.createElement('a'); a.className = 'card'; a.href = '#';
    const h = document.createElement('h5'); h.setAttribute('data-test', 'product-name'); h.textContent = n;
    a.appendChild(h); r.appendChild(a);
  }
}
render(['Pliers', 'Long Nose Pliers', 'Hammer', 'Saw']);
document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); setTimeout(() => render(${JSON.stringify(results)}), 300); });
</script></main></body></html>`;
// /search serves the results of the current mode, so ONE emitted test can be
// run against a pliers-only list, a mixed list and an empty list.
let mode: keyof typeof RESULTS = '/pliers';
const server = http.createServer((req, res) => {
  const route = (req.url ?? '/').split('?')[0]!;
  const results = route === '/search' ? RESULTS[mode] : RESULTS[route];
  if (!results) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageFor(results));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch({ headless: true });
const dirs: string[] = [];
try {
  /** Drive the tool through one search on a route and return the context and the assert result. */
  const search = async (route: string, assertInput: Record<string, unknown>) => {
    const bctx = await browser.newContext();
    await installEvalShim(bctx);
    const page = await bctx.newPage();
    const ctx = createContext(page, 40);
    const calls = [
      await runTool(ctx, { name: 'begin_scenario', input: { name: 'search lists only matching product names', category: 'happy', feature: 'catalogue' } }),
      await runTool(ctx, { name: 'navigate', input: { url: `${base}${route}` } }),
      await runTool(ctx, { name: 'fill', input: { intent: 'search input', css: '#q', value: 'Pliers' } }),
      await runTool(ctx, { name: 'click', input: { intent: 'search submit button', css: '[data-test="search-submit"]' } }),
    ];
    const t0 = Date.now();
    const asserted = await runTool(ctx, { name: 'assert', input: { type: 'allItemsMatch', intent: 'product names', css: '[data-test="product-name"]', ...assertInput } });
    return { ctx, bctx, calls, asserted, ms: Date.now() - t0 };
  };
  const setupOk = (calls: Array<{ ok: boolean; error?: string }>): boolean => calls.every((c) => c.ok);
  const allItemsSteps = (steps: TraceStep[]): TraceStep[] => steps.filter((st) => st.kind === 'assert' && st.assertion.type === 'allItemsMatch');

  /* ─── A. the tool ─────────────────────────────────────────────────────── */
  const mixed = await search('/mixed', { text: 'pliers' });
  check('A0. the mixed search setup calls (begin, navigate, fill, click) all succeeded', setupOk(mixed.calls), JSON.stringify(mixed.calls));
  check('A1. on Pliers, Long Nose Pliers and Hammer the all-items assertion for "pliers" FAILS in the tool (Hammer does not match), and nothing is recorded',
    mixed.asserted.ok === false && /toHaveCount/.test(mixed.asserted.error ?? '') && /hasNotText/.test(mixed.asserted.error ?? '') && allItemsSteps(mixed.ctx.current?.steps ?? []).length === 0,
    `${mixed.asserted.error?.split('\n').slice(0, 4).join(' | ')}`);
  await mixed.bctx.close();

  const pliers = await search('/pliers', { text: 'pliers' });
  check('A2a. the pliers search setup calls all succeeded', setupOk(pliers.calls), JSON.stringify(pliers.calls));
  const steps = pliers.ctx.current?.steps ?? [];
  const last2 = steps.slice(-2);
  const lastAction = steps.map((st) => st.kind).lastIndexOf('click');
  check('A2. on a list of only pliers the assertion passes in the tool', pliers.asserted.ok === true, pliers.asserted.error);
  check('A3. it records two checks right after the last action: no item fails to match, then at least 1 item, on the same item locator',
    last2.length === 2 && lastAction === steps.length - 3 &&
    last2[0]?.kind === 'assert' && last2[0].assertion.type === 'allItemsMatch' &&
    last2[1]?.kind === 'assert' && last2[1].assertion.type === 'toHaveCount' && last2[1].assertion.atLeast === true && last2[1].assertion.count === 1 &&
    JSON.stringify(last2[0].assertion.target) === JSON.stringify((last2[1].assertion as { target: unknown }).target),
    JSON.stringify(last2));
  const recordedPattern = last2[0]?.kind === 'assert' && last2[0].assertion.type === 'allItemsMatch' ? last2[0].assertion : null;
  check('A4. the recorded pattern is the value the scenario typed ("Pliers", escaped), case-insensitive, never the model\'s "pliers"',
    recordedPattern?.pattern === 'Pliers' && recordedPattern.flags === 'i' && recordedPattern.target.level === 'css' && recordedPattern.target.arg === '[data-test="product-name"]', JSON.stringify(recordedPattern));
  const ended = await runTool(pliers.ctx, { name: 'end_scenario', input: {} });
  check('A5. end_scenario accepts it (the gate\'s RULE 7 finds the typed value) and floors both timeouts at 10000 after the action',
    ended.ok === true && pliers.ctx.scenarios.length === 1 && pliers.ctx.scenarios[0]!.steps.slice(-2).every((st) => st.kind === 'assert' && (st.assertion as { timeout?: number }).timeout === 10000),
    JSON.stringify({ ended, tail: pliers.ctx.scenarios[0]?.steps.slice(-2) }));
  const recorded: Scenario = JSON.parse(JSON.stringify(pliers.ctx.scenarios[0]!)) as Scenario;

  // A pattern the scenario did not type is a catalogue literal: RULE 7, before any probe.
  const untypedText = await runTool(pliers.ctx, { name: 'begin_scenario', input: { name: 'untyped pattern', category: 'happy', feature: 'catalogue' } });
  await runTool(pliers.ctx, { name: 'navigate', input: { url: `${base}/pliers` } });
  await runTool(pliers.ctx, { name: 'fill', input: { intent: 'search input', css: '#q', value: 'Pliers' } });
  await runTool(pliers.ctx, { name: 'click', input: { intent: 'search submit button', css: '[data-test="search-submit"]' } });
  const t1 = Date.now();
  const hammer = await runTool(pliers.ctx, { name: 'assert', input: { type: 'allItemsMatch', intent: 'product names', css: '[data-test="product-name"]', text: 'Hammer' } });
  const hammerMs = Date.now() - t1;
  const regexForm = await runTool(pliers.ctx, { name: 'assert', input: { type: 'allItemsMatch', intent: 'product names', css: '[data-test="product-name"]', regex: '[Pp]liers' } });
  check('A6. a pattern the scenario did not type ("Hammer") is refused by RULE 7 with the existing message shape, before any probe, nothing recorded',
    untypedText.ok === true && hammer.ok === false && (hammer.error ?? '').startsWith('RULE 7 (literal catalogue value) rejected this assertion: "Hammer" on ') && (hammer.error ?? '').includes('an all-items pattern must be a value this scenario typed earlier (a fill or a search term)') && hammerMs < 2000 && allItemsSteps(pliers.ctx.current?.steps ?? []).length === 0,
    `${hammer.error} (${hammerMs} ms)`);
  check('A7. a regex the model wrote ("[Pp]liers", run 7\'s shape) is not the typed value and is refused the same way',
    regexForm.ok === false && (regexForm.error ?? '').startsWith('RULE 7 (literal catalogue value) rejected this assertion: "[Pp]liers"'), regexForm.error);
  await pliers.bctx.close();

  const empty = await search('/empty', { text: 'Pliers' });
  check('A8a. the empty search setup calls all succeeded', setupOk(empty.calls), JSON.stringify(empty.calls));
  check('A8. an empty results list fails check 1: the tool refuses the assertion with that reason and records nothing',
    empty.asserted.ok === false && (empty.asserted.error ?? '').startsWith('allItemsMatch refused: product names matches no item, so "no item fails to match /Pliers/i" would pass on an empty list') && (empty.ctx.current?.steps ?? []).every((st) => st.kind !== 'assert'),
    empty.asserted.error);
  // The refusal is not an outcome failure: the retry cap did not count it.
  check('A9. the refusal is not counted by the retry cap', [...empty.ctx._assertFailures.values()].every((n) => n === 0) || empty.ctx._assertFailures.size === 0, JSON.stringify([...empty.ctx._assertFailures]));
  await empty.bctx.close();

  /* ─── B. replay ───────────────────────────────────────────────────────── */
  const onRoute = (s: Scenario, route: string, name: string): Scenario => ({
    ...JSON.parse(JSON.stringify(s)) as Scenario,
    name,
    steps: (JSON.parse(JSON.stringify(s.steps)) as TraceStep[]).map((st) => (st.kind === 'navigate' ? { ...st, url: `${base}${route}` } : st)),
  });
  const rPliers = await replayScenarioOnce(browser, recorded, undefined, 10_000);
  const rMixed = await replayScenarioOnce(browser, onRoute(recorded, '/mixed', 'mixed'), undefined, 10_000);
  const rEmpty = await replayScenarioOnce(browser, onRoute(recorded, '/empty', 'empty'), undefined, 10_000);
  const allIdx = recorded.steps.findIndex((st) => st.kind === 'assert' && st.assertion.type === 'allItemsMatch');
  check('B1. replay passes the pliers recording', rPliers.passed === true, rPliers.error);
  check('B2. the same steps against Pliers, Long Nose Pliers and Hammer FAIL in replay at the filter check, naming the one item that does not match',
    rMixed.passed === false && rMixed.failedStep === allIdx && (rMixed.error ?? '').includes('1 item(s) of "product names" do not match /Pliers/i'), JSON.stringify(rMixed));
  check('B3. against an empty list replay fails at the minimum (at least 1 item), the step after the filter check',
    rEmpty.passed === false && rEmpty.failedStep === allIdx + 1 && /at least 1/.test(rEmpty.error ?? ''), JSON.stringify(rEmpty));

  /* ─── C. the emitted spec, run ────────────────────────────────────────── */
  // One recorded test, emitted four ways, run against /search three times:
  // the results show only pliers (pass), Hammer among them (FAIL), nothing (FAIL).
  const report = (language: 'ts' | 'js'): RunReport => ({
    url: `${base}/search`, language,
    scenarios: [onRoute(recorded, '/search', 'search lists only matching product names')],
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: '', finishedAt: '',
  });
  const emitted: Emitted[] = [];
  for (const language of ['ts', 'js'] as const) {
    for (const shape of ['POM', 'single file'] as const) {
      const e = emitFramework(report(language), shape, 'all-items');
      dirs.push(e.dir);
      emitted.push(e);
    }
  }
  for (const e of emitted) {
    const spec = [...e.files.entries()].filter(([f]) => /\.spec\.(ts|js)$/.test(f) && !f.includes('a11y')).map(([, t]) => t).join('\n');
    const filterAt = spec.indexOf('.filter({ hasNotText: /Pliers/i })).toHaveCount(0, { timeout: 10000 }); // every item matches /Pliers/i: none fails to match');
    const minAt = spec.indexOf('.toBeGreaterThanOrEqual(1); // at least 1', filterAt);
    check(`C1. ${e.language} ${e.shape}: the spec writes the filter check (hasNotText with the typed value, toHaveCount 0) and then the minimum`, filterAt > 0 && minAt > filterAt,
      spec.split('\n').filter((l) => /hasNotText|GreaterThanOrEqual/.test(l)).join(' | '));
    check(`C2. ${e.language} ${e.shape}: no emitted file asserts an empty text`, emptyTextHits(e.files).length === 0, emptyTextHits(e.files).join(' | '));
  }
  const title = /search lists only matching product names/;
  const runMode = async (m: keyof typeof RESULTS) => {
    mode = m;
    return Promise.all(emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, 'search lists only') })));
  };
  for (const { e, res } of await runMode('/pliers')) {
    const only = res.specs.find((sp) => title.test(sp.title));
    console.log(`   ${e.language} ${e.shape} on pliers only: playwright exit ${String(res.status)}; ${only?.status ?? 'missing'}`);
    check(`C3. ${e.language} ${e.shape}: on a results page with only pliers the emitted all-items test passes`, res.status === 0 && only?.status === 'expected', JSON.stringify(only) + ' | ' + res.out);
  }
  for (const { e, res } of await runMode('/mixed')) {
    const mixedRun = res.specs.find((sp) => title.test(sp.title));
    console.log(`   ${e.language} ${e.shape} on Pliers, Long Nose Pliers, Hammer: playwright exit ${String(res.status)}; ${mixedRun?.status ?? 'missing'}`);
    check(`C4. ${e.language} ${e.shape}: with Hammer in the results the same emitted test FAILS at the filter check`,
      res.status !== 0 && mixedRun?.status === 'unexpected' && /hasNotText/.test(mixedRun.error) && /Received: 1/.test(mixedRun.error), JSON.stringify(mixedRun));
  }
  for (const { e, res } of await runMode('/empty')) {
    const emptyRun = res.specs.find((sp) => title.test(sp.title));
    console.log(`   ${e.language} ${e.shape} on an empty list: playwright exit ${String(res.status)}; ${emptyRun?.status ?? 'missing'}`);
    check(`C5. ${e.language} ${e.shape}: with an empty result list the same emitted test FAILS at the minimum (check 1)`,
      res.status !== 0 && emptyRun?.status === 'unexpected' && /toBeGreaterThanOrEqual/.test(emptyRun.error), JSON.stringify(emptyRun));
  }

  /* ─── D. the end gate, the backstop ───────────────────────────────────── */
  const sel = { level: 'css' as const, arg: '[data-test="product-name"]', intent: 'product names' };
  const gateOn = (prior: TraceStep[], pattern: string) => runGate({
    name: 'g', category: 'happy',
    steps: [...prior, { kind: 'assert', name: 'a', assertion: { type: 'allItemsMatch', target: sel, pattern, flags: 'i', timeout: 10000 } }],
  });
  const fillStep = (value: string, extra: Record<string, unknown> = {}): TraceStep => ({ kind: 'fill', target: { level: 'css', arg: '#q', intent: 'search input' }, value, ...extra } as TraceStep);
  const g1 = gateOn([{ kind: 'navigate', url: `${base}/pliers` }, fillStep('pliers')], 'Hammer');
  check('D1. the end gate rejects an all-items pattern the scenario did not type (RULE 7)', g1.violations.some((v) => v.rule === 7 && v.detail.includes('an all-items pattern must be a value this scenario typed earlier')), JSON.stringify(g1.violations));
  const g2 = gateOn([{ kind: 'navigate', url: `${base}/search?q=Long%20Nose` }], 'Long Nose');
  check('D2. a search term the scenario opened the page with (a navigate query value) counts as typed', g2.violations.length === 0, JSON.stringify(g2.violations));
  const g3 = gateOn([fillStep('Pliers (1/2")')], 'pliers \\(1/2"\\)');
  check('D3. the typed value is compared after escaping, case-insensitively', g3.violations.length === 0 && typedValues([fillStep('Pliers (1/2")')])[0] === 'Pliers (1/2")', JSON.stringify(g3.violations));
  const g4 = gateOn([fillStep('Pliers', { generate: 'token' }), fillStep('Pliers', { credential: 'user' })], 'Pliers');
  check('D4. a generated or credential-marked fill is never the typed value (it is not on the page as recorded)', g4.violations.some((v) => v.rule === 7), JSON.stringify(g4.violations));
} finally {
  await browser.close();
  server.close();
  cleanup(dirs);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: allItemsMatch records "no item fails to match" (hasNotText, count 0) then "at least 1 item" on the typed value; it fails on Pliers, Long Nose Pliers and Hammer and passes on pliers only in the tool, replay and the emitted spec (TS and JS, POM and single file); an empty list fails check 1; an untyped pattern is refused by RULE 7.');
