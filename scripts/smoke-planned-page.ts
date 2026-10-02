/**
 * Locks planned-page integrity (invariant 65; src/agent/planned-page.ts and
 * end_scenario in src/agent/tools.ts):
 *   - a trace whose navigate steps leave the planned page is refused at
 *     end_scenario; the error names both paths and the three ways out
 *   - a trace that never navigates to the planned page is refused
 *   - the second violation of the same planned scenario is recorded in
 *     brokenByGate with both paths and reaches reconciliation.dropped
 *   - pages reached by click are never checked; a trailing slash, a query
 *     and a hash never count as a different page
 *   - a volatile planned page and a plan entry with no pageUrl are exempt
 *   - a lightly rephrased planned name resolves to its plan entry's page
 *   - the pure function agrees with the tool on the same traces
 *
 * Stub page, no browser, no LLM (same pattern as smoke-plan-enforcement).
 * Every runTool result is checked (standing rule 7).
 */
import { createContext, runTool, plannedNameFor } from '../src/agent/tools.js';
import { plannedPageViolation, samePage } from '../src/agent/planned-page.js';
import { reconcile, renderReconciliation } from '../src/agent/reconcile.js';
import type { RunReport, Scenario, TraceStep, SelectorRecord } from '../src/agent/trace.js';
import type { Page } from 'playwright';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
const HOST = 'https://shop.example';
const RENTAL = 'clicked a rental product and the detail page showed the same name and price as the listing';
const HOME = 'added a product from its detail page and the cart count in the header increased';
const CONTACT = 'rejected submission when the message field was empty';
const VOLATILE = 'opened the hammer product page by its generated id';
const SINGLE = 'logged in with valid credentials';

const target: SelectorRecord = { level: 'role', arg: { role: 'heading', name: 'Products' }, intent: 'products heading' };
const nav = (url: string): TraceStep => ({ kind: 'navigate', url });
const click = (): TraceStep => ({ kind: 'click', target } as TraceStep);
const assertVisible = (): TraceStep => ({ kind: 'assert', assertion: { type: 'toBeVisible', target } } as unknown as TraceStep);

/** A context with the four planned scenarios and their pages, as runAgentLoop sets them. */
function contextWithPlan(): ReturnType<typeof createContext> {
  const ctx = createContext(stubPage, 80);
  ctx.plannedNames = [RENTAL, HOME, CONTACT, VOLATILE, SINGLE];
  ctx.plannedPages = new Map([
    [RENTAL, { pageUrl: `${HOST}/rentals` }],
    [HOME, { pageUrl: `${HOST}/` }],
    [CONTACT, { pageUrl: `${HOST}/contact` }],
    [VOLATILE, { pageUrl: `${HOST}/product/01HZX5Y9K3M2N7P8Q1R4S6T0V2`, volatilePage: true }],
    [SINGLE, {}],
  ]);
  return ctx;
}

/** Drive a scenario through the tool: begin, the given steps pushed as recorded, then end_scenario. Every result is checked. */
async function drive(ctx: ReturnType<typeof createContext>, name: string, steps: TraceStep[], label: string) {
  const begun = await runTool(ctx, { name: 'begin_scenario', input: { name, category: 'happy' } });
  check(`${label} begin_scenario accepted`, begun.ok === true, begun.error);
  // The stub page cannot be driven, so the recorded steps are pushed onto the
  // open trace exactly as the tools would record them.
  ctx.current!.steps.push(...steps);
  return runTool(ctx, { name: 'end_scenario', input: {} });
}

/* ─── A. navigated to the planned page, then away: refused with both paths and three ways out ─ */
{
  const ctx = contextWithPlan();
  const res = await drive(ctx, RENTAL, [nav(`${HOST}/rentals`), nav(`${HOST}/category/hand-tools`), click(), assertVisible()], 'A0.');
  check('A1. end_scenario is refused', res.ok === false, JSON.stringify(res));
  check('A2. the error names the planned path and the offending path', (res.error ?? '').includes('/rentals') && (res.error ?? '').includes('/category/hand-tools'), res.error);
  check('A3. the error teaches the three ways out in order: restart on the planned page, assert there (retry cap records a finding), skip with a reason',
    /\(1\) restart with begin_scenario[^()]*\/rentals[\s\S]*\(2\) if \/rentals does not show[\s\S]*retry cap records a real absence as a finding[\s\S]*\(3\) use skip_scenario with a concrete reason/.test(res.error ?? ''), res.error);
  check('A4. nothing shipped: ctx.scenarios unchanged and the trace abandoned', ctx.scenarios.length === 0 && ctx.current === null && ctx.brokenByGate.length === 0, JSON.stringify({ scenarios: ctx.scenarios.length, current: ctx.current, broken: ctx.brokenByGate }));
  const next = await runTool(ctx, { name: 'begin_scenario', input: { name: RENTAL, category: 'happy' } });
  check('A5. begin_scenario is accepted straight after the refusal (restart is the first way out)', next.ok === true, next.error);
}

/* ─── B. navigated only to another page: refused ───────────────────────────── */
{
  const ctx = contextWithPlan();
  const res = await drive(ctx, RENTAL, [nav(`${HOST}/category/hand-tools`), click(), assertVisible()], 'B0.');
  check('B1. a trace that only navigated elsewhere is refused, naming both paths', res.ok === false && (res.error ?? '').includes('/rentals') && (res.error ?? '').includes('/category/hand-tools'), res.error);
  check('B2. nothing shipped', ctx.scenarios.length === 0 && ctx.current === null);
}

/* ─── C. second violation: brokenByGate with both paths; reconcile lists it under dropped ─ */
{
  const ctx = contextWithPlan();
  const first = await drive(ctx, RENTAL, [nav(`${HOST}/rentals`), nav(`${HOST}/category/hand-tools`), assertVisible()], 'C0.');
  check('C1. the first violation is a refusal, not a drop', first.ok === false && ctx.brokenByGate.length === 0 && /attempt 1\/2/.test(first.error ?? ''), first.error);
  const second = await drive(ctx, RENTAL, [nav(`${HOST}/category/hand-tools`), assertVisible()], 'C2.');
  check('C3. the second violation is refused and says the scenario is dropped', second.ok === false && /permanently dropped/.test(second.error ?? ''), second.error);
  check('C4. brokenByGate holds the planned name with a reason naming both paths and 2 attempts',
    ctx.brokenByGate.length === 1 && ctx.brokenByGate[0]!.scenario === RENTAL && ctx.brokenByGate[0]!.attempts === 2 &&
    ctx.brokenByGate[0]!.reason.includes('/rentals') && ctx.brokenByGate[0]!.reason.includes('/category/hand-tools'), JSON.stringify(ctx.brokenByGate));
  check('C5. nothing shipped under the rental name', ctx.scenarios.length === 0 && ctx.current === null);
  const report = {
    scenarios: [] as Scenario[],
    plan: [{ name: RENTAL, category: 'edge', rationale: 'r', pageUrl: `${HOST}/rentals` }],
    gate: { broken: ctx.brokenByGate, injections: [] },
  } as unknown as RunReport;
  const rec = reconcile(report);
  check('C6. reconcile lists it under dropped at the gate with both paths, and the funnel balances: planned 1 = dropped 1',
    rec.balanced === true && rec.accountedFor === 1 && rec.dropped.length === 1 && rec.dropped[0]!.stage === 'gate' &&
    rec.dropped[0]!.reason.includes('/rentals') && rec.dropped[0]!.reason.includes('/category/hand-tools'), JSON.stringify(rec));
  const lines = renderReconciliation(rec).join('\n');
  check('C7. the rendered reconciliation names the drop with both paths', lines.includes(RENTAL) && lines.includes('/category/hand-tools'), lines);
  // A third attempt on the same name after the drop is not what the rule
  // covers; what matters is that the dropped scenario left no trace to ship.
}

/* ─── D. planned "/": navigate "/", click, assert: accepted ─────────────────── */
{
  const ctx = contextWithPlan();
  const res = await drive(ctx, HOME, [nav(`${HOST}/`), click(), click(), assertVisible()], 'D0.');
  check('D1. a scenario that navigates to its planned page and reaches other pages by clicking is accepted', res.ok === true, res.error);
  check('D2. it shipped under its own name', ctx.scenarios.length === 1 && ctx.scenarios[0]!.name === HOME);
}

/* ─── E. normalization: trailing slash, query and hash never make a different page ─ */
{
  const ctx = contextWithPlan();
  const res = await drive(ctx, HOME, [nav(HOST), click(), assertVisible()], 'E0.');
  check('E1. planned https://host/ against navigate https://host is accepted', res.ok === true, res.error);
  const res2 = await drive(ctx, CONTACT, [nav(`${HOST}/contact?x=1`), assertVisible()], 'E2.');
  check('E3. planned /contact against navigate /contact?x=1 is accepted', res2.ok === true, res2.error);
  check('E4. both shipped', ctx.scenarios.length === 2);
  check('E5. samePage: trailing slash, query and hash are ignored; a different path and a different origin are not',
    samePage(`${HOST}/contact/`, `${HOST}/contact#top`) && samePage(`${HOST}/contact`, `${HOST}/contact/?utm=1`) &&
    !samePage(`${HOST}/contact`, `${HOST}/contacts`) && !samePage(`${HOST}/contact`, `https://other.example/contact`));
}

/* ─── F. a volatile planned page navigating to a listing: exempt ───────────── */
{
  const ctx = contextWithPlan();
  const res = await drive(ctx, VOLATILE, [nav(`${HOST}/category/hand-tools`), click(), assertVisible()], 'F0.');
  check('F1. a volatile planned page is exempt: the listing navigate is accepted', res.ok === true, res.error);
  check('F2. it shipped', ctx.scenarios.length === 1 && ctx.scenarios[0]!.name === VOLATILE);
}

/* ─── G. a plan entry with no pageUrl: accepted, behavior unchanged ────────── */
{
  const ctx = contextWithPlan();
  const res = await drive(ctx, SINGLE, [nav(`${HOST}/anywhere`), assertVisible()], 'G0.');
  check('G1. a plan entry with no pageUrl is exempt', res.ok === true, res.error);
  // A context with no plannedPages at all (every pre-65 smoke) is exempt too.
  const bare = createContext(stubPage, 40);
  bare.plannedNames = [SINGLE];
  const res2 = await drive(bare, SINGLE, [nav(`${HOST}/anywhere`), assertVisible()], 'G2.');
  check('G3. a context with no plannedPages entries is exempt (pre-existing behavior unchanged)', res2.ok === true && bare.scenarios.length === 1, res2.error);
  // A recorded name matching no planned scenario is not checked either (the
  // plan-enforcement path reports it as unplanned; the page check has no entry).
  const res3 = await drive(ctx, 'an unplanned extra scenario the model invented', [nav(`${HOST}/anywhere`), assertVisible()], 'G4.');
  check('G5. an unplanned name has no plan entry and is not refused by the page check', res3.ok === true, res3.error);
}

/* ─── H. a rephrased planned name resolves to its plan entry's page ────────── */
{
  const ctx = contextWithPlan();
  const rephrased = 'Clicked a rental product, and the detail page showed the same name and price as the listing!';
  check('H1. plannedNameFor maps the rephrasing to the planned name through the tolerant matcher', plannedNameFor(ctx, rephrased) === RENTAL, String(plannedNameFor(ctx, rephrased)));
  const res = await drive(ctx, rephrased, [nav(`${HOST}/category/hand-tools`), assertVisible()], 'H2.');
  check('H3. the rephrased scenario is still checked against /rentals and refused', res.ok === false && (res.error ?? '').includes('/rentals'), res.error);
  check('H4. the refusal names the PLANNED name, never a renamed one', (res.error ?? '').includes(`"${RENTAL}"`), res.error);
  const shorter = 'clicked a rental product and the detail page showed the same name';
  check('H5. a shorter containment match also resolves', plannedNameFor(ctx, shorter) === RENTAL);
  check('H6. an unrelated name resolves to nothing', plannedNameFor(ctx, 'sorted the table by last name') === null);
}

/* ─── I. plannedPageViolation unit cases for A, B, D and E ─────────────────── */
{
  const rentals = { pageUrl: `${HOST}/rentals` };
  const a = plannedPageViolation([nav(`${HOST}/rentals`), nav(`${HOST}/category/hand-tools`), assertVisible()], rentals);
  check('I1. (A) navigate to the planned page then elsewhere: navigated-elsewhere, both paths named',
    a?.kind === 'navigated-elsewhere' && a.plannedPath === '/rentals' && a.offendingPath === '/category/hand-tools' && a.message.includes('/rentals') && a.message.includes('/category/hand-tools'), JSON.stringify(a));
  const b = plannedPageViolation([nav(`${HOST}/category/hand-tools`), assertVisible()], rentals);
  check('I2. (B) navigate only elsewhere: navigated-elsewhere', b?.kind === 'navigated-elsewhere' && b.offendingPath === '/category/hand-tools', JSON.stringify(b));
  const noNav = plannedPageViolation([click(), assertVisible()], rentals);
  check('I3. no navigate step at all: never-navigated, planned path named', noNav?.kind === 'never-navigated' && noNav.plannedPath === '/rentals' && noNav.offendingPath === undefined, JSON.stringify(noNav));
  const d = plannedPageViolation([nav(`${HOST}/`), click(), assertVisible()], { pageUrl: `${HOST}/` });
  check('I4. (D) navigate to the planned page then click: null', d === null, JSON.stringify(d));
  const e1 = plannedPageViolation([nav(HOST), assertVisible()], { pageUrl: `${HOST}/` });
  const e2 = plannedPageViolation([nav(`${HOST}/contact?x=1`), assertVisible()], { pageUrl: `${HOST}/contact` });
  const e3 = plannedPageViolation([nav(`${HOST}/contact/#form`), assertVisible()], { pageUrl: `${HOST}/contact` });
  check('I5. (E) trailing slash, query and hash normalize to the same page: null', e1 === null && e2 === null && e3 === null, JSON.stringify([e1, e2, e3]));
  const cross = plannedPageViolation([nav('https://other.example/rentals'), assertVisible()], rentals);
  check('I6. a different origin on the same path is a violation and the message carries the origin', cross?.kind === 'navigated-elsewhere' && (cross.offendingPath ?? '').includes('other.example'), JSON.stringify(cross));
  check('I7. exemptions: volatile, no pageUrl, no entry',
    plannedPageViolation([nav(`${HOST}/category/hand-tools`)], { pageUrl: `${HOST}/product/01HZX5Y9K3M2N7P8Q1R4S6T0V2`, volatilePage: true }) === null &&
    plannedPageViolation([nav(`${HOST}/category/hand-tools`)], {}) === null &&
    plannedPageViolation([nav(`${HOST}/category/hand-tools`)], undefined) === null);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: a scenario is recorded on its planned page or refused; the second violation is dropped with both paths; clicks, slashes, queries, volatile pages and single-page runs are never flagged.');
