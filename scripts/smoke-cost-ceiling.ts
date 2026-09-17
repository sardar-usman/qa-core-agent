/**
 * Locks the cost-ceiling salvage path (src/agent/runtime.ts):
 *   - the Explorer loop STOPS CLEANLY at the ceiling (endedReason
 *     'cost_ceiling'), it does not throw, and completed scenarios survive
 *   - salvageOnCostCeiling keeps every completed scenario, discards only the
 *     in-progress one, and records each planned-but-never-started scenario
 *     as incomplete so the reconciliation funnel stays balanced
 *   - the summary line states: ceiling hit, N completed, M never explored
 *   - rule coverage classifies a rule cited only by never-explored scenarios
 *     as planned-not-explored, not planned-but-dropped
 *   - closeout grace (COST_CLOSEOUT_GRACE_USD): a scenario in progress that
 *     already holds a passed assertion may close under the grace with closing
 *     calls only; one with no assertion is discarded at once; begin_scenario
 *     and action tools are refused under the grace; the grace has a ceiling
 *
 * The loop is driven with a FAKE Anthropic client (a cost tracker that burns
 * the ceiling after the first turn) and a stub page. No network. No LLM.
 * No browser.
 */
import { runAgentLoop, salvageOnCostCeiling, splitCeiling, DEFAULT_REPAIR_RESERVE, COST_CLOSEOUT_GRACE_USD } from '../src/agent/runtime.js';
import { decideRepairPass, type ScenarioVerdict } from '../src/agent/critic.js';
import { createContext } from '../src/agent/tools.js';
import { computeRuleCoverage } from '../src/agent/rule-coverage.js';
import type { Scenario } from '../src/agent/trace.js';
import type { RequirementsMap } from '../src/agent/requirements.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Page } from 'playwright';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. the loop breaks at the ceiling instead of throwing ────────────────── */
// Fake client: every response costs ~$1.60 (real Opus prices), carries one
// harmless unknown-tool call so the loop keeps going until the ceiling check
// at the top of the next turn trips. Ceiling $1 -> trips before turn 2.
let apiCalls = 0;
const fakeClient = {
  messages: {
    create: async () => {
      apiCalls++;
      return {
        usage: { input_tokens: 20_000, output_tokens: 60_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id: `t${apiCalls}`, name: 'bogus_tool_never_touches_the_page', input: {} }],
        stop_reason: 'tool_use',
      };
    },
  },
} as unknown as Anthropic;

// Stub page: createContext only attaches listeners; the unknown tool never
// touches the page.
const stubPage = { on: () => {}, off: () => {} } as unknown as Page;
const ctx = createContext(stubPage, 40);
// Two scenarios already completed when the ceiling trips (2 of 4 planned).
const done = (name: string): Scenario => ({ name, category: 'happy', steps: [] } as unknown as Scenario);
ctx.scenarios.push(done('logged in with valid credentials'), done('rejected a wrong password'));

const messages: string[] = [];
let threw = false;
let loopResult: Awaited<ReturnType<typeof runAgentLoop>> | undefined;
try {
  loopResult = await runAgentLoop({
    client: fakeClient,
    model: 'claude-opus-4-7',
    maxUsd: 1,
    price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
    maxSteps: 40,
    ctx,
    url: 'https://shop.example/',
    plan: [],
    onEvent: (e) => { if (e.type === 'message') messages.push(e.text); },
  });
} catch {
  threw = true;
}
check('A1. the loop does NOT throw at the ceiling', !threw);
check('A2. endedReason is cost_ceiling', loopResult?.endedReason === 'cost_ceiling', loopResult?.endedReason);
check('A3. the ceiling stopped further API calls (fake cost tracker trips after turn 1)', apiCalls === 1, String(apiCalls));
check('A4. the 2 completed scenarios survive on the context', ctx.scenarios.length === 2);
check('A5. the stop is announced', messages.some((m) => m.includes('Cost ceiling reached')), JSON.stringify(messages));

/* ─── B. salvage bookkeeping: 2 of 4 completed, 2 never explored ───────────── */
const planned = [
  { name: 'logged in with valid credentials', category: 'happy' as const, rationale: 'r', feature: 'login', ruleIds: ['R1'] },
  { name: 'rejected a wrong password', category: 'negative' as const, rationale: 'r', feature: 'login', ruleIds: ['R2'] },
  { name: 'rejected an empty username', category: 'negative' as const, rationale: 'r', feature: 'login', ruleIds: ['R3'] },
  { name: 'locked out after repeated failures', category: 'edge' as const, rationale: 'r', feature: 'login', ruleIds: ['R4'] },
];
const salvage = salvageOnCostCeiling({
  planned,
  begun: ctx.scenarios.map((s) => s.name),
  completed: ctx.scenarios.length,
  costUsd: 1.6,
  ceilingUsd: 1,
});
check('B1. the 2 never-started scenarios are identified', JSON.stringify(salvage.unexplored) === JSON.stringify(['rejected an empty username', 'locked out after repeated failures']), JSON.stringify(salvage.unexplored));
check('B2. each unexplored scenario becomes an incomplete entry (funnel stays balanced)',
  salvage.incomplete.length === 2 && salvage.incomplete.every((i) => i.reason.includes('never explored: cost ceiling')), JSON.stringify(salvage.incomplete));
check('B3. the summary states ceiling, completed count, and unexplored count',
  salvage.summary.includes('Cost ceiling hit') && salvage.summary.includes('2 scenario(s) completed') && salvage.summary.includes('2 planned scenario(s) never explored'), salvage.summary);
check('B4. nothing was discarded when no scenario was in progress', salvage.discardedInProgress === undefined);

/* ─── C. an in-progress scenario is discarded, never salvaged ──────────────── */
const withCurrent = salvageOnCostCeiling({
  planned,
  begun: [...ctx.scenarios.map((s) => s.name), 'rejected an empty username'],
  completed: 2,
  current: 'rejected an empty username',
  costUsd: 1.6,
  ceilingUsd: 1,
});
check('C1. the in-progress scenario is named as discarded', withCurrent.discardedInProgress === 'rejected an empty username');
check('C2. it is recorded incomplete as mid-scenario, not as never-explored',
  withCurrent.incomplete.some((i) => i.scenario === 'rejected an empty username' && i.reason.includes('mid-scenario')), JSON.stringify(withCurrent.incomplete));
check('C3. only the truly never-started scenario counts as unexplored', JSON.stringify(withCurrent.unexplored) === JSON.stringify(['locked out after repeated failures']));

/* ─── D. a small rename still counts as begun ──────────────────────────────── */
const renamed = salvageOnCostCeiling({
  planned,
  begun: ['Logged in with the valid credentials!', 'rejected wrong password'],
  completed: 2,
  costUsd: 1.6,
  ceilingUsd: 1,
});
check('D1. renamed begun scenarios are not misreported as unexplored', JSON.stringify(renamed.unexplored) === JSON.stringify(['rejected an empty username', 'locked out after repeated failures']), JSON.stringify(renamed.unexplored));

/* ─── E. rule coverage classifies unexplored rules honestly ────────────────── */
const map: RequirementsMap = {
  features: [{
    name: 'login',
    description: 'sign in',
    rules: [
      { id: 'R1', text: 'valid login works', type: 'behavior' },
      { id: 'R2', text: 'wrong password rejected', type: 'validation' },
      { id: 'R3', text: 'username required', type: 'validation' },
      { id: 'R4', text: 'lockout after repeated failures', type: 'behavior' },
    ],
  }],
  roles: [],
  truncated: false,
};
// R1 survived; R2's scenario was explored but dropped at replay; R3/R4 never explored.
const coverage = computeRuleCoverage({
  map,
  planned,
  scenarios: [{ name: 'logged in with valid credentials', ruleIds: ['R1'] }],
  unexplored: salvage.unexplored,
});
check('E1. the surviving rule is covered', coverage.covered.length === 1 && coverage.covered[0]?.ruleId === 'R1');
check('E2. an explored-but-dropped rule stays planned-but-dropped',
  coverage.uncovered.find((u) => u.ruleId === 'R2')?.reason === 'planned-but-dropped', JSON.stringify(coverage.uncovered));
check('E3. rules cited only by never-started scenarios classify planned-not-explored',
  coverage.uncovered.find((u) => u.ruleId === 'R3')?.reason === 'planned-not-explored' &&
  coverage.uncovered.find((u) => u.ruleId === 'R4')?.reason === 'planned-not-explored', JSON.stringify(coverage.uncovered));

/* ─── F. repair reserve: splitCeiling math and env handling ────────────────── */
const savedReserve = process.env.QA_CORE_REPAIR_RESERVE;
delete process.env.QA_CORE_REPAIR_RESERVE;
try {
  const def = splitCeiling(2);
  check('F1. default reserve is 15%: $2 -> explorer $1.70, reserve $0.30',
    Math.abs(def.explorerUsd - 1.7) < 1e-9 && Math.abs(def.reserveUsd - 0.3) < 1e-9 && DEFAULT_REPAIR_RESERVE === 0.15,
    JSON.stringify(def));
  process.env.QA_CORE_REPAIR_RESERVE = '0.25';
  const custom = splitCeiling(2);
  check('F2. QA_CORE_REPAIR_RESERVE=0.25 -> explorer $1.50, reserve $0.50',
    Math.abs(custom.explorerUsd - 1.5) < 1e-9 && Math.abs(custom.reserveUsd - 0.5) < 1e-9);
  process.env.QA_CORE_REPAIR_RESERVE = 'garbage';
  check('F3. a junk value falls back to the default', Math.abs(splitCeiling(2).reserveUsd - 0.3) < 1e-9);
  process.env.QA_CORE_REPAIR_RESERVE = '-1';
  check('F4. a negative value clamps to 0 (explorer keeps the full ceiling)', splitCeiling(2).reserveUsd === 0);
  process.env.QA_CORE_REPAIR_RESERVE = '0.9';
  check('F5. more than half clamps to 0.5', Math.abs(splitCeiling(2).reserveUsd - 1.0) < 1e-9);
} finally {
  if (savedReserve !== undefined) process.env.QA_CORE_REPAIR_RESERVE = savedReserve;
  else delete process.env.QA_CORE_REPAIR_RESERVE;
}

/* ─── G. the explorer stops at the reduced ceiling; the repair gets the rest ── */
// Fake cost tracker: ~$0.30 per call (4k in, 11.2k out at Opus prices), so
// the explorer accumulates in small steps like a real run.
function smallCostClient(): { client: Anthropic; calls: () => number } {
  let n = 0;
  const client = {
    messages: {
      create: async () => {
        n++;
        return {
          usage: { input_tokens: 4_000, output_tokens: 11_200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: [{ type: 'tool_use', id: `g${n}`, name: 'bogus_tool_never_touches_the_page', input: {} }],
          stop_reason: 'tool_use',
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls: () => n };
}

const CEILING = 2;
const gSplit = splitCeiling(CEILING, 0.15);

// WITH the reserve: the explorer runs under $1.70 and stops there.
const reserved = smallCostClient();
const gCtx = createContext(stubPage, 200);
const gLoop = await runAgentLoop({
  client: reserved.client,
  model: 'claude-opus-4-7',
  maxUsd: gSplit.explorerUsd,
  price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  maxSteps: 200,
  ctx: gCtx,
  url: 'https://shop.example/',
  plan: [],
});
const repairBudget = CEILING - gLoop.cost.usd;
check('G1. the explorer stops at the REDUCED ceiling, not the full one',
  gLoop.endedReason === 'cost_ceiling' && gLoop.cost.usd > gSplit.explorerUsd && gLoop.cost.usd < CEILING,
  `usd=${gLoop.cost.usd.toFixed(2)} after ${reserved.calls()} calls`);
check('G2. the repair pass receives the reserve (minus one call of overshoot)',
  repairBudget > 0.05 && repairBudget <= gSplit.reserveUsd,
  `repair budget $${repairBudget.toFixed(2)} of $${gSplit.reserveUsd.toFixed(2)} reserved`);

// WITHOUT the reserve (the old behavior): exploration eats the full ceiling
// and the repair pass is left with nothing.
const unreserved = smallCostClient();
const g2Ctx = createContext(stubPage, 200);
const g2Loop = await runAgentLoop({
  client: unreserved.client,
  model: 'claude-opus-4-7',
  maxUsd: CEILING,
  price: { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  maxSteps: 200,
  ctx: g2Ctx,
  url: 'https://shop.example/',
  plan: [],
});
check('G3. without the reserve the repair budget rounds to nothing (the live-run failure)',
  CEILING - g2Loop.cost.usd <= 0.05, `leftover $${(CEILING - g2Loop.cost.usd).toFixed(2)}`);

/* ─── H. the repair pass runs on TOTAL remaining budget, never silently ────── */
// The exact live shape that produced silent non-execution: ceiling $6,
// reserve 15%, explorer overshot its $5.10 sub-ceiling to $5.1840, critic
// $0.0314, 5 rework verdicts whose names the critic echoed with the
// "[category]" prefix from its input rendering, ~$0.75 remaining. The old
// exact-name gate matched nothing, so the whole repair block (including both
// print branches) was skipped.
const liveNames = [
  'sorted products by price ascending',
  'searched for a product by name',
  'added a product to the cart',
  'rejected an empty search with a message',
  'filtered products by category',
];
const liveScenarios = liveNames.map((name) => ({ name }));
const rw = (scenario: string): ScenarioVerdict => ({ scenario, verdict: 'rework', reasons: ['assertion too weak'], required_fixes: ['assert the outcome'] });
const echoedVerdicts = [
  rw('[happy] sorted products by price ascending'),
  rw('2. searched for a product by name'),
  rw('[happy] Added a product to the cart'),
  rw('[negative] rejected an empty search with a message'),
  rw('5. [happy] filtered products by category'),
];
const liveSpent = 5.1840 + 0.0314 + 0.0350; // explorer + critic + planner
const h = decideRepairPass({ scenarios: liveScenarios, verdicts: echoedVerdicts, spentUsd: liveSpent, ceilingUsd: 6 });
check('H1. the live shape now RUNS the repair pass', h?.run === true, JSON.stringify(h));
check('H2. all 5 prefix-echoed rework verdicts match their scenarios', h?.rework.length === 5, String(h?.rework.length));
check('H3. the budget is the TOTAL ceiling minus actual spend (~$0.75), not the overshot sub-ceiling',
  h !== null && Math.abs(h.budgetUsd - (6 - liveSpent)) < 1e-9 && h.budgetUsd > 0.7, String(h?.budgetUsd));
check('H4. the run line states count and budget', h?.line === `repair pass: 5 scenario(s), budget $${(6 - liveSpent).toFixed(2)}`, h?.line);

// Exhausted budget: still a line, never silence.
const hBroke = decideRepairPass({ scenarios: liveScenarios, verdicts: echoedVerdicts, spentUsd: 6.01, ceilingUsd: 6 });
check('H5. zero budget skips WITH a printed reason', hBroke?.run === false && hBroke.line.startsWith('repair pass skipped: no budget remaining'), hBroke?.line);

// Verdict names that match nothing: still a line naming the orphans.
const hAlien = decideRepairPass({ scenarios: liveScenarios, verdicts: [rw('a verdict about something else entirely')], spentUsd: 1, ceilingUsd: 6 });
check('H6. unmatched rework verdicts skip WITH a printed reason naming them',
  hAlien?.run === false && hAlien.line.includes('matched no recorded scenario') && hAlien.line.includes('something else'), hAlien?.line);

// No rework verdicts at all: nothing to decide, nothing to print.
const hNone = decideRepairPass({ scenarios: liveScenarios, verdicts: [{ scenario: liveNames[0]!, verdict: 'pass', reasons: [], required_fixes: [] }], spentUsd: 1, ceilingUsd: 6 });
check('H7. no rework verdicts -> null (no decision line needed)', hNone === null);

/* ─── I. closeout grace at the cost ceiling ────────────────────────────────── */
// Each fake call costs $0.30 (4k in, 11.2k out at Opus prices). Ceiling $0.25:
// the first call trips it. The script says what tool each call returns.
function scriptedClient(script: Array<Array<{ name: string; input?: object }>>): { client: Anthropic; calls: () => number } {
  let n = 0;
  const client = {
    messages: {
      create: async () => {
        const tools = script[n] ?? [{ name: 'bogus_tool_never_touches_the_page' }];
        n++;
        return {
          usage: { input_tokens: 4_000, output_tokens: 11_200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          content: tools.map((t, i) => ({ type: 'tool_use', id: `i${n}-${i}`, name: t.name, input: t.input ?? {} })),
          stop_reason: 'tool_use',
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls: () => n };
}
const withAssert = (name: string): Scenario => ({
  name, category: 'happy', feature: 'login',
  steps: [{ kind: 'navigate', url: 'https://shop.example/' }, { kind: 'assert', name: 'URL contains "/x"', assertion: { type: 'toHaveURL', pattern: '/x' } }],
} as unknown as Scenario);
const PRICE = { in: 5.0, out: 25.0, cacheRead: 0.5, cacheWrite: 6.25 } as const;
type LoopEvent = Parameters<NonNullable<Parameters<typeof runAgentLoop>[0]['onEvent']>>[0];
async function closeoutRun(opts: { current: Scenario; script: Array<Array<{ name: string; input?: object }>>; graceUsd?: number }) {
  const c = scriptedClient(opts.script);
  const cctx = createContext(stubPage, 40);
  cctx.current = opts.current;
  const events: LoopEvent[] = [];
  const loop = await runAgentLoop({
    client: c.client, model: 'claude-opus-4-7', maxUsd: 0.25, price: PRICE, maxSteps: 40,
    ctx: cctx, url: 'https://shop.example/', plan: [],
    ...(opts.graceUsd !== undefined ? { closeoutGraceUsd: opts.graceUsd } : {}),
    onEvent: (e) => { events.push(e); },
  });
  const texts = events.filter((e): e is Extract<LoopEvent, { type: 'message' }> => e.type === 'message').map((e) => e.text);
  const results = events.filter((e): e is Extract<LoopEvent, { type: 'tool_result' }> => e.type === 'tool_result');
  return { loop, ctx: cctx, calls: c.calls(), texts, results };
}

check('I0. the default grace is $0.10', COST_CLOSEOUT_GRACE_USD === 0.1);

// I1: a scenario with a passed assertion closes under the grace.
{
  const r = await closeoutRun({ current: withAssert('closing scenario'), script: [[{ name: 'bogus_tool_never_touches_the_page' }], [{ name: 'end_scenario' }]] });
  check('I1a. the loop allowed one closing call past the ceiling and stopped once the scenario closed', r.calls === 2 && r.loop.endedReason === 'cost_ceiling', `calls=${r.calls} ended=${r.loop.endedReason}`);
  check('I1b. the scenario is kept as completed, nothing is left in progress', r.ctx.scenarios.some((s) => s.name === 'closing scenario') && r.ctx.current === null);
  check('I1c. the closeout record names the scenario, closed, and costs exactly the closing call', r.loop.closeout?.scenario === 'closing scenario' && r.loop.closeout.closed === true && Math.abs(r.loop.closeout.usd - 0.3) < 1e-9, JSON.stringify(r.loop.closeout));
  check('I1d. the grace spend is recorded on cost.closeoutGraceUsd and every call is in cost.calls', Math.abs((r.loop.cost.closeoutGraceUsd ?? 0) - 0.3) < 1e-9 && r.loop.cost.calls?.length === 2);
  check('I1e. the console says closing calls only were allowed, then that the scenario closed', r.texts.some((t) => t.includes('closing calls only')) && r.texts.some((t) => t.includes('closed for $')), JSON.stringify(r.texts));
  check('I1f. the closeout flag is cleared on the context after the loop', r.ctx._costCloseout === false);
}

// I2: a scenario with NO assertion is discarded at the ceiling, no grace.
{
  const noAssert = { name: 'mid-fill scenario', category: 'happy', steps: [{ kind: 'navigate', url: 'https://shop.example/' }] } as unknown as Scenario;
  const r = await closeoutRun({ current: noAssert, script: [[{ name: 'bogus_tool_never_touches_the_page' }], [{ name: 'end_scenario' }]] });
  check('I2a. no grace without an assertion: the loop stopped at the first over-ceiling check', r.calls === 1 && r.loop.endedReason === 'cost_ceiling' && r.loop.closeout === undefined, `calls=${r.calls}`);
  check('I2b. the scenario stays in progress for the salvage path to discard', r.ctx.current?.name === 'mid-fill scenario' && r.ctx.scenarios.length === 0);
}

// I3: under the grace, begin_scenario and action tools are refused; closing still works.
{
  const r = await closeoutRun({
    current: withAssert('closing scenario'),
    script: [[{ name: 'bogus_tool_never_touches_the_page' }], [{ name: 'begin_scenario', input: { name: 'a new one', category: 'happy' } }, { name: 'click', input: { intent: 'login button', role: 'button' } }], [{ name: 'end_scenario' }]],
    graceUsd: 0.5,
  });
  const refused = r.results.filter((x) => (x.name === 'begin_scenario' || x.name === 'click') && x.ok === false && /Only closing calls/.test(x.error ?? ''));
  check('I3a. begin_scenario and click are refused under the grace with the closing-only message', refused.length === 2, JSON.stringify(r.results.map((x) => [x.name, x.ok, x.error?.slice(0, 40)])));
  check('I3b. no new scenario started; the original closed on the next call', !r.ctx.scenarios.some((s) => s.name === 'a new one') && r.ctx.scenarios.some((s) => s.name === 'closing scenario') && r.calls === 3 && r.loop.closeout?.closed === true);
  check('I3c. the grace spend covers both closing turns', Math.abs((r.loop.closeout?.usd ?? 0) - 0.6) < 1e-9, String(r.loop.closeout?.usd));
}

// I4: the grace has a ceiling of its own; past it the scenario is discarded.
{
  const r = await closeoutRun({ current: withAssert('slow to close'), script: [[{ name: 'bogus_tool_never_touches_the_page' }], [{ name: 'bogus_tool_never_touches_the_page' }], [{ name: 'end_scenario' }]] });
  check('I4a. one grace call at $0.30 exhausts a $0.10 grace: the loop stopped before the third call', r.calls === 2 && r.loop.endedReason === 'cost_ceiling', `calls=${r.calls}`);
  check('I4b. the closeout is recorded as not closed and the scenario stays in progress for discard', r.loop.closeout?.closed === false && r.ctx.current?.name === 'slow to close' && r.ctx.scenarios.length === 0, JSON.stringify(r.loop.closeout));
  check('I4c. the console names the exhausted grace', r.texts.some((t) => t.includes('closeout grace exhausted')), JSON.stringify(r.texts));
}

// I5: a zero grace disables the closeout entirely.
{
  const r = await closeoutRun({ current: withAssert('closing scenario'), script: [[{ name: 'bogus_tool_never_touches_the_page' }], [{ name: 'end_scenario' }]], graceUsd: 0 });
  check('I5. grace 0: the old behaviour, stop at once and discard', r.calls === 1 && r.loop.closeout === undefined && r.ctx.current?.name === 'closing scenario');
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the cost ceiling stops the Explorer cleanly, keeps completed scenarios, accounts for never-explored ones, and rule coverage reports them honestly.');
