/**
 * smoke-page-cap: the per-page cap names what it cuts (invariant 75; run
 * 59540f D7e: "/ planned 5 scenarios, trimmed to the per-page cap of 4" cut
 * R3's only citer, said nothing, and R3 read not-planned).
 *
 *   A. trimToPageCap: a rule's only citer on the page is kept first, ties
 *      keep the Planner's order, a scenario citing no rule is never kept
 *      ahead of a rule's only citer, the kept ones stay in plan order.
 *   B. planAcrossPages with a fixture plan function, two pages:
 *      case 1, a 5-scenario page whose 5th scenario is R3's only citer: R3
 *      is kept, the cut is named "(cited no rule)", planTrimmed records it;
 *      case 2, a page where a rule's only citer must be cut: the line names
 *      it with its rules and planTrimmed records it.
 *   C. Rule coverage: a rule whose only planned scenarios were cut reads
 *      cut-by-page-cap with the names; a rule a kept scenario also cites is
 *      untouched; the console print says so.
 *   D. explore() end to end, in process, with a local stand-in for the
 *      Anthropic API and a local site (no request leaves the machine): the
 *      line reaches the events, planTrimmed reaches run-report.json and the
 *      checkpoint, reconciliation.planned is the post-trim count and the
 *      funnel balances, and rule-coverage.json reads cut-by-page-cap.
 *   E. The emitted-spec check's coverage rebuild (after a drop) classifies
 *      the same rules the same way: cut-by-page-cap and robots-disallowed
 *      read from the report's own planTrimmed and discovery block.
 *   F. The global cap (invariant 78): a plan over GLOBAL_PLAN_CAP names
 *      every scenario it cuts with its rules and every page it leaves
 *      unplanned, records them (planTrimmed cause global-cap,
 *      planSkippedPages), and coverage reads cut-by-global-cap and
 *      page-not-planned-global-cap, never not-planned, in the runtime's
 *      classification and the emitted check's rebuild.
 *   G. The global cap end to end: explore() in process on a local site of
 *      eight pages with a local stand-in for the Anthropic API: the cut
 *      line and the unplanned-pages line reach the run's messages,
 *      planTrimmed and planSkippedPages reach run-report.json and the
 *      checkpoint, the funnel balances at 20, rule-coverage.json reads the
 *      two new reasons, and no "no discovered page" line is printed for a
 *      feature whose page the cap left unplanned.
 *
 *   npx tsx scripts/smoke-page-cap.ts
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { globalCapLine, pageCapLine, planAcrossPages, trimToPageCap, GLOBAL_PLAN_CAP, PER_PAGE_SCENARIO_CAP, type PlanTarget } from '../src/agent/plan-pages.js';
import { computeRuleCoverage, cutByGlobalCapDetail, cutByPageCapDetail, pageNotPlannedFeatures, renderRuleCoverage } from '../src/agent/rule-coverage.js';
import { loadCheckpoint } from '../src/agent/checkpoint.js';
import { rebuildAccounting } from '../src/agent/emitted-check.js';
import { nameOverlap, type PlannedScenario, type PlanResult } from '../src/agent/planner.js';
import type { RequirementsMap } from '../src/agent/requirements.js';
import type { RunReport } from '../src/agent/trace.js';
import { startFakeAnthropic, type FakeContent } from './lib/fake-anthropic.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

const sc = (name: string, ruleIds: string[] = []): PlannedScenario => ({ name, category: 'edge', rationale: 'r', feature: 'contact', ruleIds });

// Case 1: the 5th scenario is R3's only citer; s1 and s2 share R1; s4 cites no rule.
const case1 = [sc('first page check one', ['R1']), sc('first page check two', ['R1']), sc('first page check three', ['R2']), sc('first page check four'), sc('first page check five', ['R3'])];
// Case 2: every scenario is some rule's only citer; the 5th must be cut.
const case2 = [sc('second page check one', ['R4']), sc('second page check two', ['R5']), sc('second page check three', ['R6']), sc('second page check four', ['R7']), sc('second page check five', ['R8', 'R9'])];

/* ─── A. the trim itself ─────────────────────────────────────────────────── */
{
  const t1 = trimToPageCap(case1, 4);
  check('A1. case 1: R3\'s only citer (the 5th) is kept, the scenario citing no rule is cut', t1.kept.some((s) => s.name === 'first page check five') && JSON.stringify(t1.cut.map((s) => s.name)) === '["first page check four"]', JSON.stringify(t1));
  check('A2. the kept scenarios stay in the Planner\'s order', JSON.stringify(t1.kept.map((s) => s.name)) === JSON.stringify(['first page check one', 'first page check two', 'first page check three', 'first page check five']));
  const t2 = trimToPageCap(case2, 4);
  check('A3. case 2: all five are sole citers, ties keep the Planner\'s order, the 5th is cut', JSON.stringify(t2.cut.map((s) => s.name)) === '["second page check five"]' && t2.kept.length === 4);
  const noRules = [sc('a'), sc('b'), sc('c'), sc('d'), sc('e', ['R1'])];
  check('A4. a scenario citing no rule is never kept ahead of a rule\'s only citer', trimToPageCap(noRules, 4).kept.some((s) => s.name === 'e') && trimToPageCap(noRules, 4).cut.map((s) => s.name).join() === 'd');
  check('A5. under the cap nothing is cut', trimToPageCap(case1.slice(0, 4), 4).cut.length === 0 && trimToPageCap(case1.slice(0, 4), 4).kept.length === 4);
  check('A6. the line names every cut with its rules, or "cited no rule"',
    pageCapLine('https://x.example/', 6, 4, [{ name: 'a', ruleIds: ['R3'] }, { name: 'b' }, { name: 'c', ruleIds: ['R4', 'R5'] }]) === 'Planner: https://x.example/ planned 6 scenarios, trimmed to the per-page cap of 4; cut: "a" (cited R3), "b" (cited no rule), "c" (cited R4, R5).');
}

/* ─── B. the planning loop, two pages ───────────────────────────────────── */
const P1 = 'https://shop.example/';
const P2 = 'https://shop.example/contact';
{
  const targets: PlanTarget[] = [{ page: { url: P1, source: 'crawl' } }, { page: { url: P2, source: 'crawl' } }];
  const messages: string[] = [];
  const planFn = async (a: { url: string }): Promise<PlanResult> => ({
    scenarios: a.url === P1 ? case1 : case2, fillableFields: 0, costUsd: 0, dropped: [], rejected: [], citationDrops: [], pageFitRejected: [], contradictionRejected: [], ruleRetries: [],
  } as unknown as PlanResult);
  const r = await planAcrossPages({ targets, planFn, onMessage: (t) => messages.push(t) });
  check('B1. case 1: the line names the cut scenario "(cited no rule)"', messages.includes(`Planner: ${P1} planned 5 scenarios, trimmed to the per-page cap of ${PER_PAGE_SCENARIO_CAP}; cut: "first page check four" (cited no rule).`), JSON.stringify(messages));
  check('B2. case 1: R3 stays in the plan (its only citer was kept)', r.combined.some((s) => s.name === 'first page check five' && s.ruleIds?.includes('R3') && s.pageUrl === P1), JSON.stringify(r.combined.map((s) => s.name)));
  check('B3. case 2: the line names the cut scenario with its rules', messages.includes(`Planner: ${P2} planned 5 scenarios, trimmed to the per-page cap of ${PER_PAGE_SCENARIO_CAP}; cut: "second page check five" (cited R8, R9).`), JSON.stringify(messages));
  check('B4. planTrimmed records both cuts with their page and rule ids, and neither is in the plan',
    JSON.stringify(r.planTrimmed) === JSON.stringify([{ pageUrl: P1, name: 'first page check four', ruleIds: [], cause: 'page-cap' }, { pageUrl: P2, name: 'second page check five', ruleIds: ['R8', 'R9'], cause: 'page-cap' }]) &&
    !r.combined.some((s) => s.name === 'first page check four' || s.name === 'second page check five') && r.combined.length === 8 && r.planCapHit === true, JSON.stringify(r.planTrimmed));

  /* ─── C. coverage ─────────────────────────────────────────────────────── */
  const map: RequirementsMap = {
    features: [{ name: 'contact', description: 'contact', rules: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'].map((id) => ({ id, text: `rule ${id}`, type: 'behavior' as const })) }],
    roles: [], truncated: false,
  };
  const cov = computeRuleCoverage({ map, planned: r.combined, scenarios: [], planTrimmed: r.planTrimmed });
  const reasonOf = (id: string): string | undefined => cov.uncovered.find((u) => u.ruleId === id)?.reason;
  check('C1. a rule whose only planned scenario was cut reads cut-by-page-cap with the cut name, never not-planned',
    reasonOf('R8') === 'cut-by-page-cap' && reasonOf('R9') === 'cut-by-page-cap' && cov.uncovered.find((u) => u.ruleId === 'R8')?.detail === cutByPageCapDetail(['second page check five']) && cutByPageCapDetail(['x']) === 'cut by the per-page cap: "x"', JSON.stringify(cov.uncovered));
  check('C2. R3, whose only citer was kept, is never cut-by-page-cap; nothing else changes', reasonOf('R3') === 'planned-but-dropped' && cov.uncovered.filter((u) => u.reason === 'cut-by-page-cap').length === 2);
  const both = computeRuleCoverage({ map, planned: [sc('kept', ['R1'])], scenarios: [], planTrimmed: [{ name: 'cut', ruleIds: ['R1', 'R2'] }] });
  check('C3. a rule a kept scenario also cites keeps its own reason; one only the cut cited reads cut-by-page-cap', both.uncovered.find((u) => u.ruleId === 'R1')?.reason === 'planned-but-dropped' && both.uncovered.find((u) => u.ruleId === 'R2')?.reason === 'cut-by-page-cap');
  check('C4. the console print names the reason and the cut scenario', renderRuleCoverage(cov).some((l) => l.includes('R8 (cut-by-page-cap: cut by the per-page cap: "second page check five")')), renderRuleCoverage(cov).join(' | '));
}

/* ─── D. explore() end to end, in process ───────────────────────────────── */
{
  for (const k of Object.keys(process.env)) if (k.startsWith('QA_CORE_TEST_') || /^QA_CORE_.*MODEL/.test(k)) delete process.env[k];
  const site = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/robots.txt' || u.pathname === '/sitemap.xml') { res.writeHead(404); res.end(''); return; }
    const title = u.pathname === '/contact' ? 'Contact' : 'Shop';
    if (u.pathname !== '/' && u.pathname !== '/contact') { res.writeHead(404); res.end(''); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1><a href="/contact">Contact</a></main></body></html>`);
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const DASH = '\u2014';
  const line = (s: PlannedScenario, i: number): string => `${i + 1}. [contact][edge][${(s.ruleIds ?? []).length ? s.ruleIds!.join(',') : '-'}] ${s.name} ${DASH} ${s.rationale}`;
  const planText = (list: PlannedScenario[]): string => `<plan>\n${list.map(line).join('\n')}\n</plan>`;
  const kept = [...trimToPageCap(case1, 4).kept, ...trimToPageCap(case2, 4).kept];
  const explorer: FakeContent[][] = [
    ...kept.map((s): FakeContent[] => [{ type: 'tool_use', name: 'skip_scenario', input: { name: s.name, reason: 'fixture run: the smoke checks planning only, nothing is recorded' } }]),
    [{ type: 'tool_use', name: 'finish', input: { summary: 'every planned scenario skipped' } }],
  ];
  const api = await startFakeAnthropic({ planner: [planText(case1), planText(case2)], explorer, critic: [] });
  const map: RequirementsMap = {
    features: [{ name: 'contact', description: 'the contact page', rules: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'].map((id) => ({ id, text: `The contact page keeps behavior ${id}.`, type: 'behavior' as const })) }],
    roles: [], truncated: false,
  };
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = api.baseUrl;
  process.env.ANTHROPIC_API_KEY = 'fixture-key-never-sent';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-page-cap-'));
  const agentCwd = process.cwd();
  process.chdir(outDir);
  const messages: string[] = [];
  try {
    const { explore } = await import('../src/agent/runtime.js');
    const report = await explore({
      url: `${base}/`, language: 'ts', outDir, requirements: map, requirementsUsd: 0,
      skipReplay: true, skipStability: true, stabilize: false, loginPreflightDone: true,
      onEvent: (e) => { if (e.type === 'message') messages.push(e.text); },
    }) as RunReport;
    const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'run-report.json'), 'utf8')) as RunReport;
    const coverage = JSON.parse(fs.readFileSync(path.join(outDir, 'rule-coverage.json'), 'utf8')) as NonNullable<RunReport['ruleCoverage']>;
    console.log(`  D run: model calls ${JSON.stringify(api.calls)}; planTrimmed ${JSON.stringify(onDisk.planTrimmed)}`);
    check('D1. every tool call the fixture Explorer drove returned ok (standing rule 7), every scripted call made', api.toolErrors.length === 0 && api.calls.planner === 2 && api.calls.explorer === explorer.length && api.calls.other === 0, JSON.stringify({ errors: api.toolErrors, calls: api.calls }));
    check('D2. both cut lines reach the run\'s messages', messages.some((m) => m.startsWith(`Planner: ${base}/ planned 5 scenarios, trimmed to the per-page cap of 4; cut: "first page check four" (cited no rule).`)) && messages.some((m) => m.startsWith(`Planner: ${base}/contact planned 5 scenarios, trimmed to the per-page cap of 4; cut: "second page check five" (cited R8, R9).`)), JSON.stringify(messages.filter((m) => m.startsWith('Planner'))));
    check('D3. planTrimmed is on run-report.json with the page and rule ids', JSON.stringify(onDisk.planTrimmed) === JSON.stringify([{ pageUrl: `${base}/`, name: 'first page check four', ruleIds: [], cause: 'page-cap' }, { pageUrl: `${base}/contact`, name: 'second page check five', ruleIds: ['R8', 'R9'], cause: 'page-cap' }]) && JSON.stringify(report.planTrimmed) === JSON.stringify(onDisk.planTrimmed), JSON.stringify(onDisk.planTrimmed));
    check('D7. planSkippedPages is [] on run-report.json and the checkpoint (the global cap left no page unplanned)',
      JSON.stringify(onDisk.planSkippedPages) === '[]' && JSON.stringify(report.planSkippedPages) === '[]', JSON.stringify(onDisk.planSkippedPages));
    check('D4. reconciliation.planned is the post-trim count (8), the cut scenarios are in no bucket, and the funnel balances',
      onDisk.reconciliation?.planned === 8 && onDisk.reconciliation.skipped.length === 8 && onDisk.reconciliation.balanced === true && !JSON.stringify(onDisk.reconciliation).includes('first page check four'), JSON.stringify(onDisk.reconciliation));
    const u8 = coverage.uncovered.find((u) => u.ruleId === 'R8');
    check('D5. rule-coverage.json reads cut-by-page-cap for R8 and R9 with the cut name; R3 (kept, then skipped) is not cut',
      u8?.reason === 'cut-by-page-cap' && u8.detail === cutByPageCapDetail(['second page check five']) && coverage.uncovered.find((u) => u.ruleId === 'R9')?.reason === 'cut-by-page-cap' && coverage.uncovered.find((u) => u.ruleId === 'R3')?.reason !== 'cut-by-page-cap', JSON.stringify(coverage.uncovered));
    const cpFile = path.join(outDir, 'checkpoint.json');
    check('D6. the checkpoint carries planTrimmed and planSkippedPages, so a resumed report still names the cuts', fs.existsSync(cpFile) && JSON.stringify(loadCheckpoint(cpFile).planTrimmed) === JSON.stringify(onDisk.planTrimmed) && JSON.stringify(loadCheckpoint(cpFile).planSkippedPages) === '[]', fs.existsSync(cpFile) ? JSON.stringify(loadCheckpoint(cpFile).planTrimmed) : 'no checkpoint');
  } finally {
    process.chdir(agentCwd);
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    await api.close();
    site.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

/* ─── E. the emitted-spec check's rebuild keeps both reasons ─────────────── */
{
  const map: RequirementsMap = {
    features: [
      { name: 'catalogue', description: 'products', rules: [{ id: 'R1', text: 'Products sort by name.', type: 'behavior' }, { id: 'R2', text: 'Products filter by category.', type: 'behavior' }] },
      { name: 'account', description: 'sign in', rules: [{ id: 'R10', text: 'A registered user can log in with an email and a password.', type: 'behavior' }] },
    ],
    roles: [], truncated: false,
  };
  const report = {
    url: 'https://shop.example/', language: 'ts', startedAt: '', finishedAt: '', steps: 0, cascadeStats: {},
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    scenarios: [], findings: [],
    plan: [sc('sorted by name', ['R1'])],
    planTrimmed: [{ pageUrl: 'https://shop.example/category/hand-tools', name: 'filtered by category', ruleIds: ['R2'] }],
    discovery: { method: 'sitemap+crawl', pages: [{ url: 'https://shop.example/', source: 'sitemap' }], candidates: [{ url: 'https://shop.example/', source: 'sitemap' }, { url: 'https://shop.example/category/hand-tools', source: 'crawl' }], warnings: [], robotsSkipped: [{ path: '/auth/login', rule: '/auth' }] },
    skipped: [{ scenario: 'sorted by name', reason: 'fixture' }],
    ruleCoverage: { covered: [], uncovered: [] },
  } as unknown as RunReport;
  rebuildAccounting(report, map, () => {});
  const reasons = Object.fromEntries((report.ruleCoverage?.uncovered ?? []).map((u) => [u.ruleId, `${u.reason}|${u.detail ?? ''}`]));
  check('E1. after the emitted check rebuilds coverage, R2 (only the cut scenario cited it) reads cut-by-page-cap and R10 (account, /auth/login skipped for robots) reads robots-disallowed, each with its detail',
    reasons.R2 === `cut-by-page-cap|${cutByPageCapDetail(['filtered by category'])}` && reasons.R10 === 'robots-disallowed|robots.txt disallows its matching path(s) /auth/login (rule Disallow: /auth); not loaded' && reasons.R1?.startsWith('planned-but-dropped') === true, JSON.stringify(reasons));
}

/* ─── F. the global cap names what it cuts (invariant 78) ──────────────── */
{
  // Seven pages: the first five plan 4, 4, 4, 2 and 4 (18 in all); the sixth
  // plans 4 with room for 2, so the global cap cuts its last two (one is
  // R20's only citer); the seventh, the contact page, is left unplanned.
  const G = (n: number): string => `https://shop.example/p${n}`;
  const CONTACT = 'https://shop.example/contact';
  const counts = [4, 4, 4, 2, 4];
  const gsc = (page: number, i: number, ruleIds: string[] = []): PlannedScenario => ({ name: `page ${page} check ${i}`, category: 'edge', rationale: 'r', feature: 'catalogue', ruleIds });
  const plans = new Map<string, PlannedScenario[]>();
  // The filler scenarios cite no rule, so the cross-page overlap rule (which
  // needs a shared non-empty rule set) never pairs them.
  counts.forEach((n, k) => plans.set(G(k + 1), Array.from({ length: n }, (_, i) => gsc(k + 1, i + 1))));
  plans.set(G(6), [gsc(6, 1, ['R12']), gsc(6, 2, ['R13']), gsc(6, 3, ['R20']), gsc(6, 4)]);
  plans.set(CONTACT, [{ name: 'contact form sends a message', category: 'happy', rationale: 'r', feature: 'contact', ruleIds: ['R30'] }]);
  const targets: PlanTarget[] = [...[1, 2, 3, 4, 5, 6].map((n): PlanTarget => ({ page: { url: G(n), source: 'crawl', feature: 'catalogue' } })), { page: { url: CONTACT, source: 'crawl', feature: 'contact' } }];
  const messages: string[] = [];
  const planFn = async (a: { url: string }): Promise<PlanResult> => ({
    scenarios: plans.get(a.url) ?? [], fillableFields: 0, costUsd: 0, dropped: [], rejected: [], citationDrops: [], pageFitRejected: [], contradictionRejected: [], ruleRetries: [],
  } as unknown as PlanResult);
  const r = await planAcrossPages({ targets, planFn, onMessage: (t) => messages.push(t) });
  console.log('\n--- the global cap lines ---');
  for (const m of messages.filter((x) => x.includes('global cap'))) console.log(m);
  console.log('---');
  check(`F1. the plan stops at the global cap of ${GLOBAL_PLAN_CAP}`, r.combined.length === GLOBAL_PLAN_CAP && r.planCapHit === true, String(r.combined.length));
  check('F2. the cut on the sixth page is named with its rules, or "cited no rule"',
    messages.includes(`Planner: ${G(6)} planned 4 scenarios, kept 2 under the global cap of ${GLOBAL_PLAN_CAP}; cut: "page 6 check 3" (cited R20), "page 6 check 4" (cited no rule).`) && globalCapLine(G(6), 4, 2, [{ name: 'a', ruleIds: ['R1'] }]) === `Planner: ${G(6)} planned 4 scenarios, kept 2 under the global cap of ${GLOBAL_PLAN_CAP}; cut: "a" (cited R1).`,
    JSON.stringify(messages));
  check('F3. the page the cap left unplanned is named by URL', messages.includes(`Planner: global cap of ${GLOBAL_PLAN_CAP} scenarios reached; 1 page(s) not planned: ${CONTACT}.`), JSON.stringify(messages));
  check('F4. planTrimmed records the global cuts with cause global-cap, beside no per-page cut',
    JSON.stringify(r.planTrimmed) === JSON.stringify([{ pageUrl: G(6), name: 'page 6 check 3', ruleIds: ['R20'], cause: 'global-cap' }, { pageUrl: G(6), name: 'page 6 check 4', ruleIds: [], cause: 'global-cap' }]), JSON.stringify(r.planTrimmed));
  check('F5. planSkippedPages lists the unplanned page with its feature', JSON.stringify(r.planSkippedPages) === JSON.stringify([{ url: CONTACT, feature: 'contact' }]), JSON.stringify(r.planSkippedPages));
  const map: RequirementsMap = {
    features: [
      { name: 'catalogue', description: 'products', rules: ['R2', 'R12', 'R13', 'R20', 'R21'].map((id) => ({ id, text: `Catalogue rule ${id}.`, type: 'behavior' as const })) },
      { name: 'contact', description: 'contact', rules: [{ id: 'R30', text: 'A contact message is sent.', type: 'behavior' as const }] },
    ],
    roles: [], truncated: false,
  };
  const pages = targets.map((t) => t.page);
  const cov = computeRuleCoverage({ map, planned: r.combined, scenarios: [], planTrimmed: r.planTrimmed, pageNotPlanned: pageNotPlannedFeatures(['catalogue', 'contact'], pages, r.planSkippedPages) });
  const u = (id: string) => cov.uncovered.find((x) => x.ruleId === id);
  check('F6. a rule whose only planned scenario the global cap cut reads cut-by-global-cap with the cut name, never not-planned',
    u('R20')?.reason === 'cut-by-global-cap' && u('R20')?.detail === cutByGlobalCapDetail(['page 6 check 3']) && cutByGlobalCapDetail(['x']) === 'cut by the global plan cap: "x"', JSON.stringify(u('R20')));
  check('F7. a rule whose feature\'s only page the cap left unplanned reads page-not-planned-global-cap naming the page, never not-planned',
    u('R30')?.reason === 'page-not-planned-global-cap' && u('R30')?.detail === `the global plan cap left its page(s) unplanned: ${CONTACT}`, JSON.stringify(u('R30')));
  check('F8. R12 (a kept scenario cites it) keeps its own reason; R21 (no scenario, its feature planned) is plain not-planned', u('R12')?.reason === 'planned-but-dropped' && u('R21')?.reason === 'not-planned', JSON.stringify([u('R12'), u('R21')]));
  check('F9. the console print names both reasons with their detail',
    renderRuleCoverage(cov).some((l) => l.includes('R20 (cut-by-global-cap: cut by the global plan cap: "page 6 check 3")')) && renderRuleCoverage(cov).some((l) => l.includes(`R30 (page-not-planned-global-cap: the global plan cap left its page(s) unplanned: ${CONTACT})`)), renderRuleCoverage(cov).join(' | '));
  // A rule a per-page cut and a global cut both cited reads cut-by-page-cap and names both.
  const mixed = computeRuleCoverage({ map, planned: [], scenarios: [], planTrimmed: [{ name: 'per page', ruleIds: ['R21'], cause: 'page-cap' }, { name: 'global', ruleIds: ['R21'], cause: 'global-cap' }, { name: 'old report', ruleIds: ['R2'] }] });
  check('F10. a rule cut by both caps reads cut-by-page-cap and names both cuts; a cut with no cause (an older report) is the per-page cap\'s',
    mixed.uncovered.find((x) => x.ruleId === 'R21')?.reason === 'cut-by-page-cap' && mixed.uncovered.find((x) => x.ruleId === 'R21')?.detail === `${cutByPageCapDetail(['per page'])}; ${cutByGlobalCapDetail(['global'])}` && mixed.uncovered.find((x) => x.ruleId === 'R2')?.reason === 'cut-by-page-cap',
    JSON.stringify(mixed.uncovered.slice(0, 2)));
  // A feature with one page planned and one left unplanned was planned for: not this reason.
  check('F11. a feature with another page that was planned does not read page-not-planned-global-cap',
    JSON.stringify(pageNotPlannedFeatures(['contact'], [{ url: G(1), feature: 'contact' }, { url: CONTACT, feature: 'contact' }], [{ url: CONTACT, feature: 'contact' }])) === '{}');
  check('F11b. an untagged page carries its feature by page evidence (a filter passthrough leaves pages untagged): /contact left unplanned is a page of the contact feature; a feature with no page at all is not this reason',
    JSON.stringify(pageNotPlannedFeatures(['contact', 'cart'], [{ url: G(1) }, { url: CONTACT }], [{ url: CONTACT }])) === JSON.stringify({ contact: `the global plan cap left its page(s) unplanned: ${CONTACT}` }));

  /* the emitted-spec check's rebuild classifies the same way */
  const report = {
    url: 'https://shop.example/', language: 'ts', startedAt: '', finishedAt: '', steps: 0, cascadeStats: {},
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 },
    scenarios: [], findings: [], plan: r.combined,
    planTrimmed: r.planTrimmed, planSkippedPages: r.planSkippedPages,
    discovery: { method: 'crawl', pages, candidates: pages, warnings: [] },
    skipped: r.combined.map((x) => ({ scenario: x.name, reason: 'fixture' })),
    ruleCoverage: { covered: [], uncovered: [] },
  } as unknown as RunReport;
  rebuildAccounting(report, map, () => {});
  const rb = (id: string) => report.ruleCoverage?.uncovered.find((x) => x.ruleId === id);
  check('F12. after the emitted check rebuilds coverage, R20 reads cut-by-global-cap and R30 page-not-planned-global-cap, each with its detail',
    rb('R20')?.reason === 'cut-by-global-cap' && rb('R20')?.detail === cutByGlobalCapDetail(['page 6 check 3']) && rb('R30')?.reason === 'page-not-planned-global-cap' && rb('R30')?.detail === `the global plan cap left its page(s) unplanned: ${CONTACT}`,
    JSON.stringify(report.ruleCoverage?.uncovered));
}

/* ─── G. the global cap end to end: explore() in process (invariant 78) ─── */
{
  for (const k of Object.keys(process.env)) if (k.startsWith('QA_CORE_TEST_') || /^QA_CORE_.*MODEL/.test(k)) delete process.env[k];
  // "/" links seven pages; the crawl finds eight, the filter passes them
  // through untagged (as run 59540f's pages were). "/" and /p1 to /p4 plan
  // 4, 4, 4, 2 and 4; /login plans 4 with room for 2, so the global cap cuts
  // two (one is R20's only citer); /p6 and /contact are left unplanned, and
  // /contact carries the contact feature by its path. "/" and /login each
  // plan an account negative citing R40: /login carries account only
  // through the rule text's tokens (featureTokenMap), so both copies stay.
  const PAGES = ['/p1', '/p2', '/p3', '/p4', '/login', '/p6', '/contact'];
  const site = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname !== '/' && !PAGES.includes(u.pathname)) { res.writeHead(404); res.end(''); return; }
    const title = u.pathname === '/' ? 'Shop' : `Page ${u.pathname.slice(1)}`;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1>${PAGES.map((p) => `<a href="${p}">${p.slice(1)}</a>`).join(' ')}</main></body></html>`);
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
  const DASH = '\u2014';
  const gs = (page: string, i: number, ruleIds: string[] = []): PlannedScenario => ({ name: `${page} visit ${i}`, category: 'edge', rationale: 'fails if the page breaks', feature: 'catalogue', ruleIds });
  const counts: Array<[string, number]> = [['home', 4], ['p1', 4], ['p2', 4], ['p3', 2], ['p4', 4]];
  const homeAccount: PlannedScenario = { name: 'sign in from the home page is refused and an error shows', category: 'negative', rationale: 'fails if no error shows', feature: 'account', ruleIds: ['R40'] };
  const loginAccount: PlannedScenario = { name: 'refused sign in on its own page shows a warning', category: 'negative', rationale: 'fails if no warning shows', feature: 'account', ruleIds: ['R40'] };
  const plans: PlannedScenario[][] = [
    ...counts.map(([pg, n], k) => Array.from({ length: n }, (_, i) => (k === 0 && i === 3 ? homeAccount : gs(pg, i + 1)))),
    [loginAccount, gs('login', 2), gs('login', 3, ['R20']), gs('login', 4)],
  ];
  const line = (s: PlannedScenario, i: number): string => `${i + 1}. [${s.feature}][${s.category}][${(s.ruleIds ?? []).length ? s.ruleIds!.join(',') : '-'}] ${s.name} ${DASH} ${s.rationale}`;
  const planText = (list: PlannedScenario[]): string => `<plan>\n${list.map(line).join('\n')}\n</plan>`;
  const kept = [...plans.slice(0, 5).flat(), ...plans[5]!.slice(0, 2)];
  check('G0. the fixture: the two account negatives overlap under 0.75, so only page evidence could pair them', nameOverlap(homeAccount.name, loginAccount.name) < 0.75, String(nameOverlap(homeAccount.name, loginAccount.name)));
  const explorer: FakeContent[][] = [
    ...kept.map((s): FakeContent[] => [{ type: 'tool_use', name: 'skip_scenario', input: { name: s.name, reason: 'fixture run: the smoke checks planning only, nothing is recorded' } }]),
    [{ type: 'tool_use', name: 'finish', input: { summary: 'every planned scenario skipped' } }],
  ];
  const api = await startFakeAnthropic({ planner: plans.map(planText), explorer, critic: [] });
  const map: RequirementsMap = {
    features: [
      { name: 'catalogue', description: 'the product pages', rules: [{ id: 'R20', text: 'A product page shows its name.', type: 'behavior' }, { id: 'R21', text: 'A product page shows its price.', type: 'behavior' }] },
      { name: 'contact', description: 'the contact page', rules: [{ id: 'R30', text: 'A contact message is sent.', type: 'behavior' }] },
      { name: 'account', description: 'signing in', rules: [{ id: 'R40', text: 'A wrong password on the login page shows an error.', type: 'validation' }] },
    ],
    roles: [], truncated: false,
  };
  const prevBase = process.env.ANTHROPIC_BASE_URL;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_BASE_URL = api.baseUrl;
  process.env.ANTHROPIC_API_KEY = 'fixture-key-never-sent';
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-global-cap-'));
  const agentCwd = process.cwd();
  process.chdir(outDir);
  const messages: string[] = [];
  try {
    const { explore } = await import('../src/agent/runtime.js');
    const report = await explore({
      url: `${base}/`, language: 'ts', outDir, requirements: map, requirementsUsd: 0,
      skipReplay: true, skipStability: true, stabilize: false, loginPreflightDone: true,
      onEvent: (e) => { if (e.type === 'message') messages.push(e.text); },
    }) as RunReport;
    const onDisk = JSON.parse(fs.readFileSync(path.join(outDir, 'run-report.json'), 'utf8')) as RunReport;
    const coverage = JSON.parse(fs.readFileSync(path.join(outDir, 'rule-coverage.json'), 'utf8')) as NonNullable<RunReport['ruleCoverage']>;
    console.log('\n--- G run: the global cap lines ---');
    for (const m of messages.filter((x) => x.includes('global cap'))) console.log(m.replaceAll(base, '<site>'));
    console.log('---');
    check('G1. every scripted call made and every tool call ok (standing rule 7); the page filter made no call (8 pages pass through)', api.toolErrors.length === 0 && api.calls.planner === 6 && api.calls.explorer === explorer.length && api.calls.other === 0, JSON.stringify({ errors: api.toolErrors, calls: api.calls }));
    check('G2. the cut on /p5 and the two unplanned pages reach the run\'s messages, each named',
      messages.includes(`Planner: ${base}/login planned 4 scenarios, kept 2 under the global cap of ${GLOBAL_PLAN_CAP}; cut: "login visit 3" (cited R20), "login visit 4" (cited no rule).`)
      && messages.includes(`Planner: global cap of ${GLOBAL_PLAN_CAP} scenarios reached; 2 page(s) not planned: ${base}/p6, ${base}/contact.`), JSON.stringify(messages.filter((m) => m.startsWith('Planner'))));
    check('G3. planTrimmed (cause global-cap) and planSkippedPages are on run-report.json',
      JSON.stringify(onDisk.planTrimmed) === JSON.stringify([{ pageUrl: `${base}/login`, name: 'login visit 3', ruleIds: ['R20'], cause: 'global-cap' }, { pageUrl: `${base}/login`, name: 'login visit 4', ruleIds: [], cause: 'global-cap' }])
      && JSON.stringify(onDisk.planSkippedPages) === JSON.stringify([{ url: `${base}/p6` }, { url: `${base}/contact` }]) && JSON.stringify(report.planSkippedPages) === JSON.stringify(onDisk.planSkippedPages), JSON.stringify({ t: onDisk.planTrimmed, s: onDisk.planSkippedPages }));
    const cpFile = path.join(outDir, 'checkpoint.json');
    check('G4. the checkpoint carries both', fs.existsSync(cpFile) && JSON.stringify(loadCheckpoint(cpFile).planSkippedPages) === JSON.stringify(onDisk.planSkippedPages) && JSON.stringify(loadCheckpoint(cpFile).planTrimmed) === JSON.stringify(onDisk.planTrimmed));
    check('G5. reconciliation.planned is 20 (the cut scenarios are in no bucket) and the funnel balances', onDisk.reconciliation?.planned === GLOBAL_PLAN_CAP && onDisk.reconciliation.balanced === true && !JSON.stringify(onDisk.reconciliation).includes('login visit 3'), JSON.stringify(onDisk.reconciliation));
    const reasonOf = (id: string) => coverage.uncovered.find((u) => u.ruleId === id);
    check('G6. rule-coverage.json: R20 reads cut-by-global-cap, R30 (its page /contact left unplanned) page-not-planned-global-cap, each with its detail; R21 plain not-planned',
      reasonOf('R20')?.reason === 'cut-by-global-cap' && reasonOf('R20')?.detail === cutByGlobalCapDetail(['login visit 3'])
      && reasonOf('R30')?.reason === 'page-not-planned-global-cap' && reasonOf('R30')?.detail === `the global plan cap left its page(s) unplanned: ${base}/contact`
      && reasonOf('R21')?.reason === 'not-planned', JSON.stringify(coverage.uncovered));
    check('G7. no "no discovered page" line for contact: its page was discovered and the cap line names it', !messages.some((m) => m.startsWith('Feature "contact"')), JSON.stringify(messages.filter((m) => m.startsWith('Feature'))));
    check('G8. the runtime passes the rule-text tokens to the cross-page check: /login carries account (its rule names the login page), so both account negatives stay and none is dropped as a duplicate',
      (onDisk.plan ?? []).some((x) => x.name === homeAccount.name) && (onDisk.plan ?? []).some((x) => x.name === loginAccount.name) && !messages.some((m) => m.startsWith('Rejected cross-page duplicate')), JSON.stringify(messages.filter((m) => m.startsWith('Rejected'))));
  } finally {
    process.chdir(agentCwd);
    if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prevBase;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    await api.close();
    site.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the per-page cap keeps a rule\'s only citer first, names every cut with its rules, records it on the report and reports cut-by-page-cap coverage; the global cap names every scenario it cuts and every page it leaves unplanned, records both, and reports cut-by-global-cap and page-not-planned-global-cap, never not-planned.');
