/**
 * Locks a count-0 (and toBeHidden) absence check on a testid hint against
 * the page's REAL test-id attribute (invariant 77, run 59540f D7c).
 *
 * Run 7's happy contact test asserted "contact submit button after send"
 * count 0 with testid "contact-submit". The absence path built the record
 * from the hints without resolving, as level testid: getByTestId, which
 * reads data-testid. The site uses data-test, so the locator matched nothing
 * before or after the submit; the check passed in 4 ms and could never fail.
 * Now a testid hint on an unresolved record goes through the host's dominant
 * test-id attribute (dominantTestIdAttribute): data-testid keeps level
 * testid, any other attribute records css [<attr>="<value>"], and with no
 * attribute known yet (no get_dom on this host) the call is refused.
 *
 * A data-test fixture page has a "contact-submit" button that disappears
 * after it is clicked.
 *   A. the tool: refused before get_dom; after get_dom, count 0 before the
 *      submit FAILS (the button is there) and after it passes, recorded as
 *      css [data-test="contact-submit"]; toBeHidden the same; a data-testid
 *      page keeps level testid.
 *   B. replay: the recording passes; without the click it fails.
 *   C. the emitted spec, TS and JS, POM and single file: getByTestId only
 *      with testIdAttribute set, and run with Playwright the same check
 *      fails while the button is present and passes once it is gone.
 * No network beyond 127.0.0.1, no model call.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { createContext, runTool, TESTID_ATTRIBUTE_UNKNOWN } from '../src/agent/tools.js';
import { installEvalShim } from '../src/agent/eval-shim.js';
import { replayScenarioOnce } from '../src/agent/replay.js';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';
import { emitFramework, runPlaywright, cleanup, type Emitted } from './lib/emitted-runner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── the fixture site ─────────────────────────────────────────────────── */
const pageWith = (attr: 'data-test' | 'data-testid'): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Contact</title></head><body><main>
<h1>Contact</h1>
<form id="f"><label for="m">Message</label><textarea id="m" ${attr}="message"></textarea>
<button type="button" ${attr}="contact-submit" onclick="this.remove(); document.getElementById('ok').hidden = false;">Send</button></form>
<div id="ok" role="alert" hidden>Thanks for your message!</div>
</main></body></html>`;
const server = http.createServer((req, res) => {
  const attr = (req.url ?? '').startsWith('/testid') ? 'data-testid' : 'data-test';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageWith(attr));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const browser = await chromium.launch({ headless: true });
const dirs: string[] = [];
try {
  /* ─── A. the tool ─────────────────────────────────────────────────────── */
  const bctx = await browser.newContext();
  await installEvalShim(bctx);
  const page = await bctx.newPage();
  const ctx = createContext(page, 40);
  const begun = await runTool(ctx, { name: 'begin_scenario', input: { name: 'send removes the submit button', category: 'happy', feature: 'contact' } });
  const nav = await runTool(ctx, { name: 'navigate', input: { url: `${base}/contact` } });
  const t0 = Date.now();
  const unknown = await runTool(ctx, { name: 'assert', input: { type: 'toHaveCount', count: 0, intent: 'contact submit button after send', testid: 'contact-submit' } });
  const unknownHidden = await runTool(ctx, { name: 'assert', input: { type: 'toBeHidden', intent: 'contact submit button after send', testid: 'contact-submit' } });
  const unknownMs = Date.now() - t0;
  check('A1. before any get_dom the test-id attribute is unknown: count 0 and toBeHidden on a testid hint are refused at once, nothing recorded',
    begun.ok && nav.ok && unknown.ok === false && (unknown.error ?? '').includes(TESTID_ATTRIBUTE_UNKNOWN) && unknownHidden.ok === false && (unknownHidden.error ?? '').includes(TESTID_ATTRIBUTE_UNKNOWN) &&
    TESTID_ATTRIBUTE_UNKNOWN.includes('call get_dom first or pass css with the page\'s test-id attribute') && unknownMs < 2000 && (ctx.current?.steps ?? []).every((st) => st.kind !== 'assert'),
    JSON.stringify({ unknown, unknownHidden, unknownMs }));
  const dom = await runTool(ctx, { name: 'get_dom', input: {} });
  check('A2. get_dom reports the page\'s test-id attribute', dom.ok === true && (dom.data as { note?: string }).note === 'test-id attribute on this page: data-test', JSON.stringify((dom.data as { note?: string }).note));
  const t1 = Date.now();
  const before = await runTool(ctx, { name: 'assert', input: { type: 'toHaveCount', count: 0, intent: 'contact submit button after send', testid: 'contact-submit', timeout: 3000 } });
  const beforeMs = Date.now() - t1;
  check(`A3. count 0 recorded BEFORE the submit FAILS: the button is there (took ${beforeMs} ms), nothing recorded`,
    before.ok === false && /toHaveCount/.test(before.error ?? '') && /Received: 1/.test(before.error ?? '') && (ctx.current?.steps ?? []).every((st) => st.kind !== 'assert'), before.error);
  const clicked = await runTool(ctx, { name: 'click', input: { intent: 'send button', role: 'button', label: 'Send' } });
  const after = await runTool(ctx, { name: 'assert', input: { type: 'toHaveCount', count: 0, intent: 'contact submit button after send', testid: 'contact-submit', timeout: 3000 } });
  const hidden = await runTool(ctx, { name: 'assert', input: { type: 'toBeHidden', intent: 'contact submit button after send', testid: 'contact-submit', timeout: 3000 } });
  const asserts = (ctx.current?.steps ?? []).filter((st): st is Extract<TraceStep, { kind: 'assert' }> => st.kind === 'assert');
  const target = (i: number) => (asserts[i]?.assertion as { target?: { level: string; arg: unknown } } | undefined)?.target;
  check('A4. after the submit count 0 passes and is recorded as css [data-test="contact-submit"], the attribute the page uses',
    clicked.ok === true && after.ok === true && asserts[0]?.assertion.type === 'toHaveCount' && target(0)?.level === 'css' && target(0)?.arg === '[data-test="contact-submit"]', JSON.stringify({ clicked, after, t: target(0) }));
  check('A5. toBeHidden on the same hint is recorded the same way', hidden.ok === true && asserts[1]?.assertion.type === 'toBeHidden' && target(1)?.level === 'css' && target(1)?.arg === '[data-test="contact-submit"]', JSON.stringify({ hidden, t: target(1) }));
  const ended = await runTool(ctx, { name: 'end_scenario', input: {} });
  check('A6. end_scenario accepts the scenario', ended.ok === true && ctx.scenarios.length === 1, JSON.stringify(ended));
  const recorded = JSON.parse(JSON.stringify(ctx.scenarios[0]!)) as Scenario;
  await bctx.close();

  // A data-testid host keeps level testid: getByTestId reads that attribute.
  const tctx = await browser.newContext();
  await installEvalShim(tctx);
  const tpage = await tctx.newPage();
  const ctx2 = createContext(tpage, 40);
  const setup2 = [
    await runTool(ctx2, { name: 'begin_scenario', input: { name: 'testid host', category: 'happy', feature: 'contact' } }),
    await runTool(ctx2, { name: 'navigate', input: { url: `${base}/testid` } }),
    await runTool(ctx2, { name: 'get_dom', input: {} }),
    await runTool(ctx2, { name: 'click', input: { intent: 'send button', role: 'button', label: 'Send' } }),
  ];
  const after2 = await runTool(ctx2, { name: 'assert', input: { type: 'toHaveCount', count: 0, intent: 'contact submit button after send', testid: 'contact-submit', timeout: 3000 } });
  const t2 = (ctx2.current?.steps.filter((st) => st.kind === 'assert').at(-1) as { assertion?: { target?: { level: string; arg: unknown } } } | undefined)?.assertion?.target;
  check('A7. on a data-testid page the absence keeps level testid (getByTestId reads data-testid)',
    setup2.every((r) => r.ok) && (setup2[2]!.data as { note?: string }).note === 'test-id attribute on this page: data-testid' && after2.ok === true && t2?.level === 'testid' && t2.arg === 'contact-submit', JSON.stringify({ setup2: setup2.map((r) => r.ok), after2, t2 }));
  await tctx.close();

  /* ─── B. replay ───────────────────────────────────────────────────────── */
  const withoutClick = (s: Scenario, name: string): Scenario => ({ ...s, name, category: 'edge', steps: s.steps.filter((st) => st.kind !== 'click') });
  const rOk = await replayScenarioOnce(browser, recorded, undefined, 5000);
  const rNoClick = await replayScenarioOnce(browser, withoutClick(recorded, 'no click'), undefined, 5000);
  check('B1. replay passes the recording (the button is gone after the click)', rOk.passed === true, rOk.error);
  check('B2. without the click replay fails at the count-0 step: the recorded locator finds the button', rNoClick.passed === false && rNoClick.stepKind === 'assert' && /toHaveCount: expected 0/.test(rNoClick.error ?? ''), JSON.stringify(rNoClick));

  /* ─── C. the emitted spec ─────────────────────────────────────────────── */
  const report = (language: 'ts' | 'js'): RunReport => ({
    url: `${base}/contact`, language,
    scenarios: [recorded, withoutClick(recorded, 'submit button is gone before send')],
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    steps: 0, startedAt: '', finishedAt: '',
  });
  const emitted: Emitted[] = [];
  for (const language of ['ts', 'js'] as const) {
    for (const shape of ['POM', 'single file'] as const) {
      const e = emitFramework(report(language), shape, 'absence-testid');
      dirs.push(e.dir);
      emitted.push(e);
    }
  }
  for (const e of emitted) {
    const all = [...e.files.values()].join('\n');
    const usesTestId = all.includes('getByTestId("contact-submit")');
    const config = e.shape === 'POM' ? e.files.get(`playwright.config.${e.language}`) ?? '' : [...e.files.entries()].find(([f]) => f.endsWith(`.spec.${e.language}`))?.[1] ?? '';
    const setsAttr = e.shape === 'POM' ? config.includes(`testIdAttribute: 'data-test'`) : config.includes(`test.use({ testIdAttribute: "data-test" });`);
    check(`C1. ${e.language} ${e.shape}: the emitted locator reads the attribute the tool checked (getByTestId only with testIdAttribute data-test, else the css)`,
      (usesTestId && setsAttr) || (!usesTestId && all.includes('[data-test=\\"contact-submit\\"]')),
      all.split('\n').filter((l) => /contact-submit|testIdAttribute/.test(l)).map((l) => l.trim()).join(' | '));
    check(`C2. ${e.language} ${e.shape}: no getByTestId is emitted without a testIdAttribute in the config`, !usesTestId || setsAttr);
  }
  const runs = await Promise.all(emitted.map(async (e) => ({ e, res: await runPlaywright(e.dir, 'send') })));
  for (const { e, res } of runs) {
    const gone = res.specs.find((s) => s.title.includes('send removes the submit button'));
    const present = res.specs.find((s) => s.title.includes('submit button is gone before send'));
    console.log(`   ${e.language} ${e.shape}: playwright exit ${String(res.status)}; after send ${gone?.status ?? 'missing'}; before send ${present?.status ?? 'missing'}`);
    check(`C3. ${e.language} ${e.shape}: the emitted count-0 check passes once the button is gone`, gone?.status === 'expected', JSON.stringify(gone) + ' | ' + res.out);
    check(`C4. ${e.language} ${e.shape}: the same check FAILS while the button is present`,
      present?.status === 'unexpected' && /toHaveCount/.test(present.error) && /Received: 1/.test(present.error), JSON.stringify(present));
  }
} finally {
  await browser.close();
  server.close();
  cleanup(dirs);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a count-0 or toBeHidden absence on a testid hint uses the page\'s real test-id attribute (css [data-test=...] on a data-test host, getByTestId on a data-testid host, refused before get_dom); it fails while the element is present and passes once it is gone in the tool, replay and the emitted spec (TS and JS, POM and single file).');
