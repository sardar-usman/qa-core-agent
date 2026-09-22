/**
 * Locks finish() plan enforcement and skip_scenario (src/agent/tools.ts):
 *   - finish is REJECTED while planned scenarios remain unexplored and the
 *     step budget is not exhausted; the rejection lists the unexplored names
 *     and teaches the way out (continue or skip_scenario)
 *   - skip_scenario records a planned scenario as skipped-with-reason; junk
 *     names and empty reasons are rejected
 *   - finish is ACCEPTED once every planned scenario is explored or skipped,
 *     and when the step budget is exhausted
 *   - the reconciliation identity includes skipped:
 *     planned = generated + dropped + incomplete + findings + skipped
 *
 * Stub page, no browser, no LLM (same pattern as smoke-cost-ceiling).
 */
import { createContext, runTool } from '../src/agent/tools.js';
import { uniqueScenarioNames } from '../src/agent/planner.js';
import { reconcile, renderReconciliation } from '../src/agent/reconcile.js';
import type { RunReport, Scenario } from '../src/agent/trace.js';
import type { Page } from 'playwright';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
const done = (name: string): Scenario => ({ name, category: 'happy', steps: [] } as unknown as Scenario);

const PLANNED = [
  'logged in with valid credentials',
  'rejected a wrong password',
  'rejected an empty username',
  'locked out after repeated failures',
];

/* ─── A. finish with 2 of 4 unexplored is rejected ─────────────────────────── */
const ctx = createContext(stubPage, 40);
ctx.plannedNames = [...PLANNED];
ctx.scenarios.push(done(PLANNED[0]!), done(PLANNED[1]!));

const rejected = await runTool(ctx, { name: 'finish', input: { summary: 'done early' } });
check('A1. finish is rejected while planned scenarios remain', rejected.ok === false);
check('A2. the rejection names BOTH unexplored scenarios',
  rejected.error?.includes(PLANNED[2]!) === true && rejected.error?.includes(PLANNED[3]!) === true, rejected.error);
check('A3. the rejection teaches the way out (continue or skip_scenario)',
  /begin_scenario/.test(rejected.error ?? '') && /skip_scenario/.test(rejected.error ?? ''));

/* ─── B. skip_scenario validation ──────────────────────────────────────────── */
const badName = await runTool(ctx, { name: 'skip_scenario', input: { name: 'no such scenario at all zz', reason: 'x' } });
check('B1. a name matching no planned scenario is rejected, listing the plan',
  badName.ok === false && badName.error?.includes(PLANNED[2]!) === true, badName.error);
const noReason = await runTool(ctx, { name: 'skip_scenario', input: { name: PLANNED[2], reason: '  ' } });
check('B2. an empty reason is rejected', noReason.ok === false);

/* ─── C. 2 explored + 2 skipped with reasons -> finish accepted ────────────── */
const skip1 = await runTool(ctx, { name: 'skip_scenario', input: { name: PLANNED[2], reason: 'username field is not present on this build' } });
const skip2 = await runTool(ctx, { name: 'skip_scenario', input: { name: PLANNED[3], reason: 'lockout needs 3 real accounts we do not have' } });
check('C1. both skips are accepted', skip1.ok === true && skip2.ok === true, JSON.stringify([skip1, skip2]));
check('C2. skips are recorded with their reasons',
  ctx.skipped.length === 2 && ctx.skipped[0]?.reason.includes('not present') === true);
const dup = await runTool(ctx, { name: 'skip_scenario', input: { name: PLANNED[2], reason: 'again' } });
// A scenario is a finding OR a skip, never both: with a finding already
// recorded for a planned name, skip_scenario is a logged no-op and the
// finding stands (run 5e4394 counted one scenario as both).
ctx.findings.push({ scenario: PLANNED[1]!, expected: 'locate element: search input', url: 'https://example.com/', messages: [] });
const skipAfterFinding = await runTool(ctx, { name: 'skip_scenario', input: { name: PLANNED[1], reason: 'overlay covers the input' } });
check('B5. skip_scenario on a scenario already recorded as a finding is a no-op that says so, and records no skip',
  skipAfterFinding.ok === true && /already recorded as a finding/.test(String((skipAfterFinding.data as { noop?: string } | undefined)?.noop ?? '')) && !ctx.skipped.some((s) => s.scenario === PLANNED[1]), JSON.stringify(skipAfterFinding));
ctx.findings.pop(); // leave the rest of this smoke's state as it was
check('C3. skipping the same scenario twice is rejected', dup.ok === false);
const accepted = await runTool(ctx, { name: 'finish', input: { summary: 'all covered or skipped' } });
check('C4. finish is accepted after 2 explored + 2 skipped', accepted.ok === true, accepted.error);

/* ─── D. budget exhaustion also unlocks finish ─────────────────────────────── */
const ctx2 = createContext(stubPage, 5);
ctx2.plannedNames = [...PLANNED];
ctx2.scenarios.push(done(PLANNED[0]!));
ctx2.steps = 5; // at the budget line; runTool increments past it
const atBudget = await runTool(ctx2, { name: 'finish', input: { summary: 'budget gone' } });
check('D1. finish is accepted when the step budget is exhausted, unexplored or not', atBudget.ok === true, atBudget.error);

/* ─── E. a renamed explored scenario still counts as explored ──────────────── */
const ctx3 = createContext(stubPage, 40);
ctx3.plannedNames = ['rejected a wrong password'];
ctx3.scenarios.push(done('Rejected wrong password!'));
const renamed = await runTool(ctx3, { name: 'finish', input: { summary: 'done' } });
check('E1. small rephrasings do not trigger a false rejection', renamed.ok === true, renamed.error);

/* ─── F. reconciliation identity includes skipped ──────────────────────────── */
const report = {
  scenarios: [done(PLANNED[0]!), done(PLANNED[1]!)],
  plan: PLANNED.map((name) => ({ name, category: 'happy', rationale: 'r' })),
  skipped: [
    { scenario: PLANNED[2]!, reason: 'username field is not present on this build' },
    { scenario: PLANNED[3]!, reason: 'lockout needs 3 real accounts we do not have' },
  ],
} as unknown as RunReport;
const rec = reconcile(report);
check('F1. planned 4 = generated 2 + skipped 2 balances', rec.balanced === true && rec.accountedFor === 4, JSON.stringify(rec));
check('F2. the skipped term carries names and reasons', rec.skipped.length === 2 && rec.skipped[1]?.reason.includes('3 real accounts') === true);
const lines = renderReconciliation(rec).join('\n');
check('F3. the rendered identity shows the skipped term', lines.includes('+ skipped 2'), lines);
check('F4. skipped scenarios are listed with reasons', lines.includes('skipped (declined by the Explorer, with reason):'));

/* ─── G. scenario names are unique across pages ────────────────────────────── */
// Run f3b41e planned "rejected wrong password and stayed on login page" on two
// pages; skip_scenario hit the first, refused the second as already skipped,
// and the funnel lost a scenario.
{
  const first = uniqueScenarioNames([], [{ name: 'rejected wrong password and stayed on login page', category: 'negative', rationale: 'r', feature: 'login', pageUrl: 'https://s.example/auth/register' }], { url: 'https://s.example/auth/register', feature: 'login' });
  const second = uniqueScenarioNames(first.scenarios, [{ name: 'rejected wrong password and stayed on login page', category: 'negative', rationale: 'r', feature: 'login', pageUrl: 'https://s.example/auth/forgot-password' }], { url: 'https://s.example/auth/forgot-password', feature: 'login' });
  check('G1. the first page keeps its name; the duplicate on the second page gets the page path appended (same feature on both)', first.renames.length === 0 && second.renames.length === 1 && second.scenarios[0]?.name === 'rejected wrong password and stayed on login page (auth/forgot-password)', JSON.stringify(second));
  const byFeature = uniqueScenarioNames(first.scenarios, [{ name: 'rejected wrong password and stayed on login page', category: 'negative', rationale: 'r', feature: 'registration', pageUrl: 'https://s.example/auth/register' }], { url: 'https://s.example/auth/register', feature: 'registration' });
  check('G2. when the pages differ by feature the feature is the suffix', byFeature.scenarios[0]?.name === 'rejected wrong password and stayed on login page (registration)');
  const third = uniqueScenarioNames([...first.scenarios, ...second.scenarios], [{ name: 'rejected wrong password and stayed on login page', category: 'negative', rationale: 'r', feature: 'login', pageUrl: 'https://s.example/auth/forgot-password' }], { url: 'https://s.example/auth/forgot-password', feature: 'login' });
  check('G3. a third clash on the same page counts up', third.scenarios[0]?.name === 'rejected wrong password and stayed on login page (auth/forgot-password 2)');
  // With unique names, skip_scenario hits the right one and the funnel balances.
  const names = [first.scenarios[0]!.name, second.scenarios[0]!.name];
  const gctx = createContext(stubPage, 40);
  gctx.plannedNames = [...names];
  const s1 = await runTool(gctx, { name: 'skip_scenario', input: { name: names[0], reason: 'the register page has no login form' } });
  const early = await runTool(gctx, { name: 'finish', input: { summary: 'one skipped' } });
  check('G4a. after the base name is skipped, finish still names the suffixed duplicate as unexplored', early.ok === false && (early.error ?? '').includes(names[1]!), early.error);
  const s2 = await runTool(gctx, { name: 'skip_scenario', input: { name: names[1], reason: 'the forgot-password page has no password field' } });
  check('G4. skip_scenario hits each planned scenario once', s1.ok === true && s2.ok === true && gctx.skipped.length === 2 && gctx.skipped[0]?.scenario === names[0] && gctx.skipped[1]?.scenario === names[1], JSON.stringify([s1, s2, gctx.skipped]));
  const fin = await runTool(gctx, { name: 'finish', input: { summary: 'both skipped' } });
  check('G5. finish is accepted with both skipped', fin.ok === true, fin.error);
  const gRec = reconcile({
    url: 'https://s.example/', language: 'ts', scenarios: [], cascadeStats: {}, cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 }, steps: 4, startedAt: '', finishedAt: '',
    plan: [...first.scenarios, ...second.scenarios], skipped: gctx.skipped,
  } as unknown as RunReport);
  check('G6. the funnel balances: planned 2 = skipped 2, nothing vanishes', gRec.balanced === true && gRec.accountedFor === 2 && gRec.skipped.length === 2, JSON.stringify(gRec));
}

/* ─── H. skip_scenario while a scenario is in progress ─────────────────────── */
// Run 4 (591732): the model skipped the scenario it had open, the trace stayed
// open, begin_scenario was refused, and it closed the scenario with a vacuous
// assertion the Critic rejected, so one name sat in two funnel buckets.
{
  const hctx = createContext(stubPage, 40);
  hctx.plannedNames = [...PLANNED];
  await runTool(hctx, { name: 'begin_scenario', input: { name: PLANNED[1], category: 'negative' } });
  check('H1. a scenario is in progress', hctx.current?.name === PLANNED[1]);
  const other = await runTool(hctx, { name: 'skip_scenario', input: { name: PLANNED[3], reason: 'lockout needs accounts we do not have' } });
  check('H2. skipping a DIFFERENT planned scenario records that skip and leaves the current one open', other.ok === true && hctx.current?.name === PLANNED[1] && hctx.skipped.length === 1 && hctx.skipped[0]?.scenario === PLANNED[3], JSON.stringify(other));
  const self = await runTool(hctx, { name: 'skip_scenario', input: { name: PLANNED[1], reason: 'the guard replaces the duplicate email, so the case cannot be exercised' } });
  check('H3. skipping the scenario IN PROGRESS discards its open trace: nothing to ship, no finding, the skip recorded once', self.ok === true && hctx.current === null && hctx.scenarios.length === 0 && hctx.findings.length === 0 && hctx.skipped.filter((x) => x.scenario === PLANNED[1]).length === 1 && /discarded/.test(String((self.data as { discarded?: string }).discarded ?? '')), JSON.stringify(self));
  const next = await runTool(hctx, { name: 'begin_scenario', input: { name: PLANNED[2], category: 'negative' } });
  check('H4. begin_scenario is accepted straight after (nothing left open, no block)', next.ok === true && hctx.current?.name === PLANNED[2], JSON.stringify(next));
  hctx.current = null;
  // The reconciliation builder rejects a name in two buckets loudly: it throws
  // without a handler (a smoke fixture with a double record fails), and with the
  // runtime's handler it warns and counts the name once, in the earliest bucket.
  const doubled = {
    scenarios: [done(PLANNED[0]!)],
    plan: PLANNED.map((name) => ({ name, category: 'happy', rationale: 'r' })),
    review: { verdicts: [{ scenario: PLANNED[1], verdict: 'reject', reasons: ['vacuous'], required_fixes: [] }], summary: '' },
    skipped: [{ scenario: PLANNED[1], reason: 'the guard replaces the email' }, { scenario: PLANNED[2], reason: 'x' }, { scenario: PLANNED[3], reason: 'y' }],
  } as unknown as RunReport;
  let threw = '';
  try { reconcile(doubled); } catch (e) { threw = (e as Error).message; }
  check('H5. the reconciliation builder THROWS on a name recorded in two buckets, naming the name and both buckets', /is recorded as both dropped at critic and skipped/.test(threw) && threw.includes(PLANNED[1]!), threw || 'did not throw');
  const warnings: string[] = [];
  const guarded = reconcile(doubled, { onDuplicate: (m) => warnings.push(m) });
  check('H6. with a handler it warns once and counts the name once, in the earliest bucket: planned 4 = generated 1 + dropped 1 + skipped 2, no "+1 added"', warnings.length === 1 && guarded.accountedFor === 4 && guarded.added === 0 && guarded.balanced && guarded.dropped.length === 1 && guarded.skipped.length === 2 && /recorded in two buckets, counted once in the earliest: "/.test(guarded.note ?? '') && (guarded.note ?? '').includes(PLANNED[1]!), JSON.stringify({ warnings, accountedFor: guarded.accountedFor, added: guarded.added, note: guarded.note }));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: finish cannot abandon the plan silently, skip_scenario records reasons, and the reconciliation identity includes skipped.');
