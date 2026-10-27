/**
 * Locks two pom.ts fixes for synthesized action methods (invariant 78,
 * found in the PR #55 review).
 *
 * A synthesized fill-and-click method is named after the click's first
 * intent word. "search submit button" beside the "search input" field gave a
 * method "search" and a field "search"; the field is an instance property,
 * so it shadowed the method and the spec threw "cataloguePage.search is not
 * a function". And in a feature whose scenarios start on different URLs,
 * the method call was emitted before the test's own page.goto, so it acted
 * on a blank page.
 *
 * A fixture feature with both shapes: two scenarios that each fill the
 * "search input" field and click the "search submit button", one starting
 * on /tools and one on /garden.
 *   A. the emitted page class: the field keeps "search", the method gets a
 *      distinct name ("searchAction"); distinctMethodName is deterministic
 *      and skips fields, class members and earlier methods.
 *   B. the emitted spec: each test opens its own URL with page.goto before
 *      the method call; a shared-URL feature keeps its beforeEach goto and
 *      the method call as the test's first line, as before.
 *   C. the framework, TS and JS (POM), run with Playwright against the
 *      fixture site: both tests pass.
 * No network beyond 127.0.0.1, no model call.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { distinctMethodName } from '../src/agent/pom.js';
import type { RunReport, Scenario, SelectorRecord, TraceStep } from '../src/agent/trace.js';
import { emitFramework, runPlaywright, cleanup, type Emitted } from './lib/emitted-runner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── the fixture site ─────────────────────────────────────────────────── */
// Two pages with the same search form; the result line names the term.
const pageFor = (title: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>
<h1>${title}</h1>
<form id="f" role="search"><label for="q">Search</label><input id="q" name="q" type="search"><button type="submit" data-test="search-submit">Go</button></form>
<button type="button" data-test="search-clear">Clear</button>
<p id="result" role="status"></p>
<script>
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  document.getElementById('result').textContent = 'Results for ' + document.getElementById('q').value;
});
document.querySelector('[data-test="search-clear"]').addEventListener('click', () => {
  document.getElementById('q').value = '';
  document.getElementById('result').textContent = 'Cleared';
});
</script></main></body></html>`;
const server = http.createServer((req, res) => {
  const route = (req.url ?? '/').split('?')[0]!;
  const title = route === '/tools' ? 'Tools' : route === '/garden' ? 'Garden' : null;
  if (!title) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageFor(title));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/* ─── the fixture report ───────────────────────────────────────────────── */
const searchInput: SelectorRecord = { level: 'label', arg: 'Search', intent: 'search input' };
const searchSubmit: SelectorRecord = { level: 'css', arg: '[data-test="search-submit"]', intent: 'search submit button' };
const result: SelectorRecord = { level: 'css', arg: '#result', intent: 'search result line' };
const searchClear: SelectorRecord = { level: 'css', arg: '[data-test="search-clear"]', intent: 'clear search button' };
// The second scenario clears the search after the lead, so the two action
// signatures differ and the dataset loop (which needs one shared signature)
// leaves both as their own tests; the shared lead still makes the method.
const scenarioOn = (name: string, route: string, term: string, clear: boolean): Scenario => ({
  name,
  category: 'happy',
  feature: 'catalogue',
  steps: [
    { kind: 'navigate', url: `${base}${route}` },
    { kind: 'fill', target: searchInput, value: term },
    { kind: 'click', target: searchSubmit },
    { kind: 'assert', assertion: { type: 'toHaveText', target: result, text: `Results for ${term}`, timeout: 10000 } },
    ...(clear ? [
      { kind: 'click', target: searchClear },
      { kind: 'assert', assertion: { type: 'toHaveText', target: result, text: 'Cleared', timeout: 10000 } },
    ] : []),
  ] as TraceStep[],
});
const report = (language: 'ts' | 'js', routes: [string, string]): RunReport => ({
  url: `${base}${routes[0]}`,
  language,
  scenarios: [
    scenarioOn('searched the tools page for pliers', routes[0], 'pliers', false),
    scenarioOn('searched the garden page for a hose, then cleared it', routes[1], 'hose', true),
  ],
  cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
  cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
  steps: 0,
  startedAt: '',
  finishedAt: '',
});

const dirs: string[] = [];
try {
  /* ─── A. the method name ─────────────────────────────────────────────── */
  check('A1. distinctMethodName keeps a free name', distinctMethodName('search', new Set(['searchSubmitButton'])) === 'search');
  check('A2. a name a field holds gets "Action"', distinctMethodName('search', new Set(['search', 'searchSubmitButton'])) === 'searchAction');
  check('A3. then a number from 2 up', distinctMethodName('search', new Set(['search', 'searchAction', 'searchAction2'])) === 'searchAction3');
  check('A4. a class member is never a method name (goto, url, page, expectVisible)', distinctMethodName('goto', new Set()) === 'gotoAction' && distinctMethodName('page', new Set()) === 'pageAction');

  const emitted: Emitted[] = [];
  for (const language of ['ts', 'js'] as const) {
    const e = emitFramework(report(language, ['/tools', '/garden']), 'POM', 'pom-methods');
    dirs.push(e.dir);
    emitted.push(e);
  }
  for (const e of emitted) {
    const pageFile = [...e.files.entries()].find(([f]) => /pages\/catalogue-page\.(ts|js)$/.test(f))?.[1] ?? '';
    const specFile = [...e.files.entries()].find(([f]) => /tests\/catalogue\/catalogue\.spec\.(ts|js)$/.test(f))?.[1] ?? '';
    check(`A5. ${e.language}: the page class keeps the field "search" and names the method "searchAction"`,
      /\bthis\.search = /.test(pageFile) && /async searchAction\(/.test(pageFile) && !/async search\(/.test(pageFile), pageFile);

    /* ─── B. the order inside each test ──────────────────────────────── */
    const body = (title: string): string[] => {
      const lines = specFile.split('\n');
      const start = lines.findIndex((l) => l.includes(title));
      const end = lines.findIndex((l, i) => i > start && l.startsWith('});'));
      return lines.slice(start + 1, end).map((l) => l.trim());
    };
    const tools = body('searched the tools page for pliers');
    const garden = body('searched the garden page for a hose');
    check(`A6. ${e.language}: no dataset loop took the scenarios (each is its own test)`, !specFile.includes('dataCases') && /test\("\[happy\] searched the tools page/.test(specFile), specFile);
    check(`B1. ${e.language}: no beforeEach goto (the scenarios start on two URLs)`, !/beforeEach[\s\S]*?\.goto\(/.test(specFile.split('test(')[0] + (specFile.match(/test\.beforeEach\([\s\S]*?\n  \}\);/)?.[0] ?? '')), specFile);
    check(`B2. ${e.language}: the tools test opens /tools, then calls searchAction`,
      tools[0] === `await page.goto("${base}/tools");` && tools[1] === 'await cataloguePage.searchAction("pliers");', JSON.stringify(tools));
    check(`B3. ${e.language}: the garden test opens /garden, then calls searchAction`,
      garden[0] === `await page.goto("${base}/garden");` && garden[1] === 'await cataloguePage.searchAction("hose");', JSON.stringify(garden));
  }
  // A shared-URL feature: the beforeEach goto stays and the method call is the first line, as before.
  const shared = emitFramework(report('ts', ['/tools', '/tools']), 'POM', 'pom-methods-shared');
  dirs.push(shared.dir);
  const sharedSpec = [...shared.files.entries()].find(([f]) => /tests\/catalogue\/catalogue\.spec\.ts$/.test(f))?.[1] ?? '';
  const sharedFirst = sharedSpec.split('\n').map((l) => l.trim()).filter((l, i, a) => i > 0 && a[i - 1]!.startsWith('test('));
  check('B4. a shared-URL feature keeps its beforeEach goto and the method call as each test\'s first line',
    /test\.beforeEach\([\s\S]*?await cataloguePage\.goto\(\);/.test(sharedSpec) && sharedFirst.length === 2 && sharedFirst.every((l) => l.startsWith('await cataloguePage.searchAction(')), sharedSpec);

  /* ─── C. run ──────────────────────────────────────────────────────────── */
  for (const e of emitted) {
    const res = await runPlaywright(e.dir, 'searched the');
    const specs = res.specs.filter((sp) => /searched the/.test(sp.title));
    console.log(`   ${e.language} POM: playwright exit ${String(res.status)}; ${specs.map((sp) => `${sp.title}: ${sp.status}`).join('; ')}`);
    check(`C1. ${e.language} POM: both tests run green (goto first, then the distinct method)`,
      res.status === 0 && specs.length === 2 && specs.every((sp) => sp.status === 'expected'), JSON.stringify(specs) + ' | ' + res.out);
  }
} finally {
  server.close();
  cleanup(dirs);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a synthesized method never shares a name with a page-object field (searchAction beside the search field), each test of a multi-URL feature opens its own page before the method call, and the emitted framework runs green in TS and JS.');
