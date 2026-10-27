/**
 * Locks the all-items assertion (invariant 77, run 59540f D5).
 *
 * Run 7 shipped "[happy] search for term filtered list to only matching
 * product names", whose recording checked the FIRST card only. The assert
 * tool now offers allItemsMatch: "every item of <list> matches <the value
 * the scenario typed>, and there is at least 1 item", recorded as ONE check
 * that holds only when a single read of every item's text holds both facts
 * (allTextContents, polled until that one read holds).
 *
 * The PR #55 review reproduced a false pass with the first form, two checks
 * read at different moments (no item fails to match, then at least 1 item):
 * a list that clears while new results load passed the filter check on the
 * empty in-between list and the minimum on the new list, which no check
 * examined. The clear modes below are that repro.
 *
 * A fixture search page shows a full catalogue (Pliers, Long Nose Pliers,
 * Hammer, Saw). After the search, by route:
 *   /mixed         300 ms later: Pliers, Long Nose Pliers, Hammer
 *   /pliers        300 ms later: Pliers, Long Nose Pliers
 *   /empty         300 ms later: nothing
 *   /clear-mixed   (a) the old list for 500 ms (the request in flight), then
 *                  cleared, then 800 ms later Long Nose Pliers and Hammer
 *   /clear-pliers  (b) the same, then only pliers items
 *   /clear-empty   (c) the same, then cleared and it stays empty
 *   A. the tool: mixed and (a) FAIL, pliers and (b) pass and record ONE step
 *      after the last action with the typed value as the pattern, empty and
 *      (c) are refused, a pattern the scenario did not type is refused by
 *      RULE 7 with nothing recorded.
 *   B. replay: pliers and (b) pass; mixed, empty, (a) and (c) FAIL, naming
 *      the item count and the texts that do not match.
 *   C. the emitted spec, TS and JS, POM and single file, run with Playwright
 *      against /search in each of the six modes: the same test passes on
 *      pliers and (b) and FAILS on mixed, empty, (a) and (c), printing the
 *      real list.
 *   D. the end gate refuses an untyped pattern (the backstop) and accepts a
 *      search term the scenario opened the page with.
 *   E. the flags are exactly 'i' (a g flag is refused by replay and both
 *      emitters) and item text is whitespace-normalized.
 * No network beyond 127.0.0.1, no model call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContext, runTool } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { replayScenarioOnce } from '../src/agent/replay.js';
import { runGate } from '../src/agent/gate.js';
import { scaffold } from '../src/agent/scaffold.js';
import { transcribe } from '../src/agent/transcriber.js';
import { typedValues, allItemsSnapshot, allItemsHold, allItemsPollLine } from '../src/agent/all-items.js';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';
import { emitFramework, emptyTextHits, runPlaywright, cleanup, type Emitted } from './lib/emitted-runner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── the fixture site ─────────────────────────────────────────────────── */
interface Mode { results: string[]; clear: boolean; label: string }
const MODES: Record<string, Mode> = {
  '/mixed': { results: ['Pliers', 'Long Nose Pliers', 'Hammer'], clear: false, label: 'Pliers, Long Nose Pliers, Hammer' },
  '/pliers': { results: ['Pliers', 'Long Nose Pliers'], clear: false, label: 'pliers only' },
  '/empty': { results: [], clear: false, label: 'an empty list' },
  '/clear-mixed': { results: ['Long Nose Pliers', 'Hammer'], clear: true, label: '(a) cleared, then Long Nose Pliers and Hammer 800 ms later' },
  '/clear-pliers': { results: ['Pliers', 'Long Nose Pliers'], clear: true, label: '(b) cleared, then pliers only 800 ms later' },
  '/clear-empty': { results: [], clear: true, label: '(c) cleared and stays empty' },
};
// The full catalogue is on the page before the search lands, so a check that
// reads too early sees non-matching items. A clear mode keeps the old list
// for 500 ms (the request in flight), clears it, and renders the results
// 800 ms later: the in-between empty list is what the two-check form passed.
const pageFor = (m: Mode): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tools</title></head><body><main>
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
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  ${m.clear
    ? `setTimeout(() => { render([]); setTimeout(() => render(${JSON.stringify(m.results)}), 800); }, 500);`
    : `setTimeout(() => render(${JSON.stringify(m.results)}), 300);`}
});
</script></main></body></html>`;
// /search serves the current mode, so ONE emitted test runs in every mode.
let mode = '/pliers';
const server = http.createServer((req, res) => {
  const route = (req.url ?? '/').split('?')[0]!;
  const m = route === '/search' ? MODES[mode] : MODES[route];
  if (!m) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageFor(m));
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
    const asserted = await runTool(ctx, { name: 'assert', input: { type: 'allItemsMatch', intent: 'product names', css: '[data-test="product-name"]', timeout: 5000, ...assertInput } });
    return { ctx, bctx, calls, asserted, ms: Date.now() - t0 };
  };
  const setupOk = (calls: Array<{ ok: boolean; error?: string }>): boolean => calls.every((c) => c.ok);
  const asserts = (steps: TraceStep[]): TraceStep[] => steps.filter((st) => st.kind === 'assert');

  /* ─── A. the tool ─────────────────────────────────────────────────────── */
  const mixed = await search('/mixed', { text: 'pliers' });
  check('A0. the mixed search setup calls (begin, navigate, fill, click) all succeeded', setupOk(mixed.calls), JSON.stringify(mixed.calls));
  check('A1. on Pliers, Long Nose Pliers and Hammer the all-items assertion for "pliers" FAILS in the tool, naming the item count and Hammer, and nothing is recorded',
    mixed.asserted.ok === false && (mixed.asserted.error ?? '') === 'allItemsMatch: product names has 3 item(s); not matching /Pliers/i: ["Hammer"]' && asserts(mixed.ctx.current?.steps ?? []).length === 0,
    mixed.asserted.error);
  await mixed.bctx.close();

  const pliers = await search('/pliers', { text: 'pliers' });
  check('A2a. the pliers search setup calls all succeeded', setupOk(pliers.calls), JSON.stringify(pliers.calls));
  const steps = pliers.ctx.current?.steps ?? [];
  const lastAction = steps.map((st) => st.kind).lastIndexOf('click');
  check('A2. on a list of only pliers the assertion passes in the tool, reading 2 items in one read',
    pliers.asserted.ok === true && (pliers.asserted.data as { items?: number; checked?: string }).items === 2 && (pliers.asserted.data as { checked?: string }).checked === 'at least 1 item and every item matches, in one read of the list',
    JSON.stringify(pliers.asserted));
  check('A3. it records ONE step right after the last action: allItemsMatch, no separate "at least 1" step',
    asserts(steps).length === 1 && lastAction === steps.length - 2 && steps.at(-1)?.kind === 'assert' && (steps.at(-1) as { assertion: { type: string } }).assertion.type === 'allItemsMatch',
    JSON.stringify(steps.slice(lastAction)));
  const recordedStep = steps.at(-1);
  const recordedPattern = recordedStep?.kind === 'assert' && recordedStep.assertion.type === 'allItemsMatch' ? recordedStep.assertion : null;
  check('A4. the recorded pattern is the value the scenario typed ("Pliers", escaped), flags exactly i, never the model\'s "pliers"',
    recordedPattern?.pattern === 'Pliers' && recordedPattern.flags === 'i' && recordedPattern.target.level === 'css' && recordedPattern.target.arg === '[data-test="product-name"]', JSON.stringify(recordedPattern));
  const ended = await runTool(pliers.ctx, { name: 'end_scenario', input: {} });
  check('A5. end_scenario accepts it (the gate\'s RULE 7 finds the typed value) and floors its timeout at 10000 after the action',
    ended.ok === true && pliers.ctx.scenarios.length === 1 && (pliers.ctx.scenarios[0]!.steps.at(-1) as { assertion?: { timeout?: number } }).assertion?.timeout === 10000,
    JSON.stringify({ ended, tail: pliers.ctx.scenarios[0]?.steps.at(-1) }));
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
    untypedText.ok === true && hammer.ok === false && (hammer.error ?? '').startsWith('RULE 7 (literal catalogue value) rejected this assertion: "Hammer" on ') && (hammer.error ?? '').includes('an all-items pattern must be a value this scenario typed earlier (a fill or a search term)') && hammerMs < 2000 && asserts(pliers.ctx.current?.steps ?? []).length === 0,
    `${hammer.error} (${hammerMs} ms)`);
  check('A7. a regex the model wrote ("[Pp]liers", run 7\'s shape) is not the typed value and is refused the same way',
    regexForm.ok === false && (regexForm.error ?? '').startsWith('RULE 7 (literal catalogue value) rejected this assertion: "[Pp]liers"'), regexForm.error);
  await pliers.bctx.close();

  const empty = await search('/empty', { text: 'Pliers' });
  check('A8a. the empty search setup calls all succeeded', setupOk(empty.calls), JSON.stringify(empty.calls));
  check('A8. an empty results list fails: the tool refuses the assertion with that reason and records nothing',
    empty.asserted.ok === false && (empty.asserted.error ?? '').startsWith('allItemsMatch refused: product names matches no item, and "every item matches /Pliers/i" proves nothing on an empty list (last read: 0 items).') && asserts(empty.ctx.current?.steps ?? []).length === 0,
    empty.asserted.error);
  // The refusal is not an outcome failure: the retry cap did not count it.
  check('A9. the refusal is not counted by the retry cap', [...empty.ctx._assertFailures.values()].every((n) => n === 0) || empty.ctx._assertFailures.size === 0, JSON.stringify([...empty.ctx._assertFailures]));
  await empty.bctx.close();

  // The review's repro: the list clears while new results load.
  const clearMixed = await search('/clear-mixed', { text: 'Pliers' });
  check('A10. (a) a list that clears and 800 ms later shows Long Nose Pliers and Hammer FAILS in the tool, on the new list it read, nothing recorded',
    setupOk(clearMixed.calls) && clearMixed.asserted.ok === false && (clearMixed.asserted.error ?? '') === 'allItemsMatch: product names has 2 item(s); not matching /Pliers/i: ["Hammer"]' && asserts(clearMixed.ctx.current?.steps ?? []).length === 0,
    clearMixed.asserted.error);
  await clearMixed.bctx.close();
  const clearPliers = await search('/clear-pliers', { text: 'Pliers' });
  check('A11. (b) a list that clears and 800 ms later shows only pliers passes in the tool and records one step',
    setupOk(clearPliers.calls) && clearPliers.asserted.ok === true && asserts(clearPliers.ctx.current?.steps ?? []).length === 1 && clearPliers.ms >= 1000, `${JSON.stringify(clearPliers.asserted)} (${clearPliers.ms} ms)`);
  await clearPliers.bctx.close();
  const clearEmpty = await search('/clear-empty', { text: 'Pliers' });
  check('A12. (c) a list that clears and stays empty fails in the tool: refused, nothing recorded',
    setupOk(clearEmpty.calls) && clearEmpty.asserted.ok === false && (clearEmpty.asserted.error ?? '').startsWith('allItemsMatch refused: product names matches no item') && asserts(clearEmpty.ctx.current?.steps ?? []).length === 0,
    clearEmpty.asserted.error);
  await clearEmpty.bctx.close();

  /* ─── B. replay ───────────────────────────────────────────────────────── */
  const onRoute = (s: Scenario, route: string, name: string): Scenario => ({
    ...JSON.parse(JSON.stringify(s)) as Scenario,
    name,
    steps: (JSON.parse(JSON.stringify(s.steps)) as TraceStep[]).map((st) => (st.kind === 'navigate' ? { ...st, url: `${base}${route}` } : st)),
  });
  const allIdx = recorded.steps.findIndex((st) => st.kind === 'assert' && st.assertion.type === 'allItemsMatch');
  const replayed = Object.fromEntries(await Promise.all(Object.keys(MODES).map(async (route) => [route, await replayScenarioOnce(browser, onRoute(recorded, route, route), undefined, 10_000)] as const)));
  check('B1. replay passes the pliers recording', replayed['/pliers']!.passed === true, replayed['/pliers']!.error);
  check('B2. against Pliers, Long Nose Pliers and Hammer replay FAILS at the allItemsMatch step, naming the item count and Hammer',
    replayed['/mixed']!.passed === false && replayed['/mixed']!.failedStep === allIdx && replayed['/mixed']!.error === 'allItemsMatch: "product names" has 3 item(s); not matching /Pliers/i: ["Hammer"]', JSON.stringify(replayed['/mixed']));
  check('B3. against an empty list replay FAILS at the same step, naming 0 items',
    replayed['/empty']!.passed === false && replayed['/empty']!.failedStep === allIdx && replayed['/empty']!.error === 'allItemsMatch: "product names" has 0 item(s); not matching /Pliers/i: []', JSON.stringify(replayed['/empty']));
  check('B4. (a) a list that clears, then shows Long Nose Pliers and Hammer, FAILS in replay on the new list',
    replayed['/clear-mixed']!.passed === false && replayed['/clear-mixed']!.failedStep === allIdx && replayed['/clear-mixed']!.error === 'allItemsMatch: "product names" has 2 item(s); not matching /Pliers/i: ["Hammer"]', JSON.stringify(replayed['/clear-mixed']));
  check('B5. (b) a list that clears, then shows only pliers, passes in replay', replayed['/clear-pliers']!.passed === true, JSON.stringify(replayed['/clear-pliers']));
  check('B6. (c) a list that clears and stays empty FAILS in replay', replayed['/clear-empty']!.passed === false && replayed['/clear-empty']!.failedStep === allIdx && /has 0 item\(s\)/.test(replayed['/clear-empty']!.error ?? ''), JSON.stringify(replayed['/clear-empty']));

  /* ─── C. the emitted spec, run ────────────────────────────────────────── */
  // One recorded test, emitted four ways, run against /search in each mode.
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
    const line = spec.split('\n').map((l) => l.trim()).find((l) => l.includes('.allTextContents()')) ?? '';
    const items = /\(await (.+?)\.allTextContents\(\)\)/.exec(line)?.[1] ?? '(no items expression)';
    check(`C1. ${e.language} ${e.shape}: the spec writes ONE expect.poll over one read of every item's text (allItemsPollLine), with no separate filter or minimum check`,
      line === allItemsPollLine(items, '/Pliers/i', 'i', 10000) && !spec.includes('hasNotText') && !spec.includes('toBeGreaterThanOrEqual(1)'), line);
    check(`C2. ${e.language} ${e.shape}: no emitted file asserts an empty text`, emptyTextHits(e.files).length === 0, emptyTextHits(e.files).join(' | '));
  }
  const title = /search lists only matching product names/;
  const runMode = async (m: string) => {
    mode = m;
    const runs = await Promise.all(emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, 'search lists only') })));
    return runs.map(({ e, res }) => {
      const spec = res.specs.find((sp) => title.test(sp.title));
      console.log(`   ${e.language} ${e.shape} on ${MODES[m]!.label}: playwright exit ${String(res.status)}; ${spec?.status ?? 'missing'}`);
      return { e, res, spec };
    });
  };
  const passes = (label: string, m: string) => async () => {
    for (const { e, res, spec } of await runMode(m)) check(`${label}. ${e.language} ${e.shape}: on ${MODES[m]!.label} the emitted all-items test passes`, res.status === 0 && spec?.status === 'expected', JSON.stringify(spec) + ' | ' + res.out);
  };
  const fails = (label: string, m: string, received: string) => async () => {
    for (const { e, res, spec } of await runMode(m)) {
      check(`${label}. ${e.language} ${e.shape}: on ${MODES[m]!.label} the same emitted test FAILS and prints the real list`,
        res.status !== 0 && spec?.status === 'unexpected' && spec.error.includes(received), JSON.stringify(spec));
    }
  };
  await passes('C3', '/pliers')();
  await fails('C4', '/mixed', 'Received: "{\\"items\\":3,\\"notMatching\\":[\\"Hammer\\"]}"')();
  await fails('C5', '/empty', 'Received: "{\\"items\\":0,\\"notMatching\\":[]}"')();
  await fails('C6', '/clear-mixed', 'Received: "{\\"items\\":2,\\"notMatching\\":[\\"Hammer\\"]}"')();
  await passes('C7', '/clear-pliers')();
  await fails('C8', '/clear-empty', 'Received: "{\\"items\\":0,\\"notMatching\\":[]}"')();

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

  /* ─── E. flags exactly i, text normalized ─────────────────────────────── */
  // Why never g: RegExp.test with g keeps lastIndex, so the second of two
  // identical texts reads as not matching.
  check('E1. a g flag is stateful: two "Pliers" items read as one not matching under /pliers/gi', JSON.stringify(allItemsSnapshot(['Pliers', 'Pliers'], /pliers/gi).notMatching) === '["Pliers"]');
  const gStep = recorded.steps.map((st) => (st.kind === 'assert' && st.assertion.type === 'allItemsMatch' ? { ...st, assertion: { ...st.assertion, flags: 'gi' } } : st)) as TraceStep[];
  const gScenario: Scenario = { ...onRoute(recorded, '/pliers', 'g flag'), steps: gStep.map((st) => (st.kind === 'navigate' ? { ...st, url: `${base}/pliers` } : st)) };
  const rG = await replayScenarioOnce(browser, gScenario, undefined, 10_000);
  check('E2. replay refuses a recorded g flag: the step fails naming the flags', rG.passed === false && rG.failedStep === allIdx && (rG.error ?? '').startsWith('allItemsMatch flags must be exactly "i", got "gi"'), JSON.stringify(rG));
  for (const language of ['ts', 'js'] as const) {
    for (const shape of ['POM', 'single file'] as const) {
      let thrown = '';
      const gReport: RunReport = { ...report(language), scenarios: [gScenario] };
      const gDir = fs.mkdtempSync(path.join(os.tmpdir(), `qa-all-items-g-${language}-${shape === 'POM' ? 'pom' : 'single'}-`));
      dirs.push(gDir);
      try {
        if (shape === 'POM') scaffold({ report: gReport, outDir: gDir, siteName: 'g-flag' });
        else transcribe({ report: gReport, outDir: gDir, name: 'g-flag' });
      } catch (err) { thrown = (err as Error).message; }
      check(`E3. ${language} ${shape}: emitting a g flag throws, never a stateful RegExp`, thrown === 'allItemsMatch flags must be exactly "i", got "gi"', thrown);
    }
  }
  check('E4. item text is whitespace-normalized before the match, the way Playwright normalizes hasText',
    allItemsHold(allItemsSnapshot(['  Long\n   Nose\u200b Pliers ', 'Pli\u00adERS'], /long nose pliers|pliers/i)) && allItemsSnapshot(['Long\nNose'], /long nose/i).notMatching.length === 0);
} finally {
  await browser.close();
  server.close();
  cleanup(dirs);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: allItemsMatch decides from ONE read of every item\'s text (at least 1 item and every item matches the typed value, flags exactly i): it passes on pliers only and on a list that clears then shows only pliers, and FAILS on Pliers, Long Nose Pliers and Hammer, on an empty list, on a list that clears then shows Hammer, and on a list that clears and stays empty, in the tool, replay and the emitted spec (TS and JS, POM and single file); an untyped pattern is refused by RULE 7.');
