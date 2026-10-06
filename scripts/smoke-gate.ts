/**
 * Locks in the static validation gate (src/agent/gate.ts).
 *
 * Tests four rules — pure function, zero LLM, zero network.
 *
 *   RULE 1: Any { kind: 'wait' } step triggers a BLOCKING violation.
 *           Exception: { kind: 'stability_wait' } is always allowed.
 *   RULE 2: An async assertion after an action that lacks a sufficient
 *           timeout is raised in-place to the 10000 ms floor (not a
 *           rejection); the 15000 ms ceiling always applies.
 *   RULE 3: Only FRAGILE CSS-tier locators on animated elements are rejected.
 *           Stable selectors (#id, [data-*], single semantic class) are
 *           allowed even on animated elements.
 *   RULE 4: Intermediate numeric text assertions on animated elements are
 *           blocked when corroborated by an assert_freeze on the same intent.
 *
 * Also covers isStableCssSelector / isFragileCssSelector directly.
 */
import { runGate, isStableCssSelector, isFragileCssSelector, gateRuleLabel, gateBrokenReason, catalogueLiteralReason, priceInNameReason, PRICE_IN_NAME_STEER, ASYNC_TIMEOUT_CEILING, ASYNC_TIMEOUT_FLOOR_AFTER_ACTION, rule2Timeout, isCounterTarget, counterLiteralReason, counterCountCaptureReason, COUNTER_TARGET_RE, COUNTER_LITERAL_STEER, COUNTER_COUNT_CAPTURE_STEER } from '../src/agent/gate.js';
import { currencyAmountIn } from '../src/agent/parse-number.js';
import { generatedIdFragment } from '../src/agent/volatile-id.js';
import type { Scenario, SelectorRecord, TraceStep } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── helpers ───────────────────────────────────────────────────────────── */

function makeScenario(steps: TraceStep[]): Scenario {
  // Clone so shared constant step objects don't accumulate mutations across tests
  return { name: 'test scenario', category: 'happy', steps: structuredClone(steps) };
}

// assert_freeze is now recorded as the general capture-and-compare sequence.
// The gate's RULE 3a/4 corroboration keys off the assert_compare step's target,
// so the gate tests build that step directly via this helper.
function freezeCompare(target: SelectorRecord, intent: string): TraceStep {
  return {
    kind: 'assert_compare',
    varName: 'cap',
    relation: 'unchanged',
    source: 'attribute',
    target,
    attribute: 'aria-valuenow',
    intent,
    readVar: 'capNow',
  };
}

const NAV: TraceStep = { kind: 'navigate', url: 'https://example.com/' };
const CLICK_ROLE: TraceStep = {
  kind: 'click',
  target: { level: 'role', arg: { role: 'button', name: 'Start' }, intent: 'start button' },
};
const ASSERT_ROLE: TraceStep = {
  kind: 'assert',
  name: 'value visible',
  assertion: { type: 'toHaveText', target: { level: 'role', arg: { role: 'status', name: '' }, intent: 'result text' }, text: '100%' },
};

/* ─── isStableCssSelector ────────────────────────────────────────────────── */

check('A. #id is stable',                   isStableCssSelector('#progressBar'));
check('B. #hyphenated-id is stable',        isStableCssSelector('#my-element'));
check('C. [data-testid=x] is stable',       isStableCssSelector('[data-testid="submit"]'));
check('D. [data-cy] bare attr is stable',   isStableCssSelector('[data-cy]'));
check('E. .semantic-class is stable',       isStableCssSelector('.progress-bar'));
check('F. .singleword is stable',           isStableCssSelector('.container'));
check('G. .short-digit (h2) is stable',     isStableCssSelector('.h2'));
check('H. .css-1a2b3c is NOT stable',       !isStableCssSelector('.css-1a2b3c'));
check('I. .sc-9f2k is NOT stable',          !isStableCssSelector('.sc-9f2k'));
check('J. div.foo is NOT stable',           !isStableCssSelector('div.foo'));

/* ─── isFragileCssSelector ───────────────────────────────────────────────── */

check('K. #id is NOT fragile',                         !isFragileCssSelector('#bar'));
check('L. [data-*] is NOT fragile',                    !isFragileCssSelector('[data-testid="x"]'));
check('M. .single-class is NOT fragile',               !isFragileCssSelector('.container'));
check('N. :nth-child is fragile',                      isFragileCssSelector('li:nth-child(2)'));
check('O. :first-child is fragile',                    isFragileCssSelector('li:first-child'));
check('P. css-1a2b3c is fragile (hashed class)',       isFragileCssSelector('.css-1a2b3c'));
check('Q. sc-9f2k is fragile (hashed class)',          isFragileCssSelector('.sc-9f2k'));
check('R. 3-level chain is fragile',                   isFragileCssSelector('.a .b .c'));
check('S. 3-level > chain is fragile',                 isFragileCssSelector('.a > .b > .c'));
check('T. 2-level chain is NOT fragile',               !isFragileCssSelector('.parent .child'));
check('U. 2-level > chain is NOT fragile',             !isFragileCssSelector('.parent > .child'));

/* ─── RULE 1: hard sleep ─────────────────────────────────────────────────── */

const r1Sc = makeScenario([NAV, { kind: 'wait', ms: 2000 }, ASSERT_ROLE]);
const r1 = runGate(r1Sc);

check('V. RULE 1 — wait step produces a violation', r1.violations.length === 1);
check('W. RULE 1 — violation has rule === 1', r1.violations[0]?.rule === 1);
check('X. RULE 1 — violation detail mentions page.waitForTimeout', r1.violations[0]?.detail.includes('page.waitForTimeout') ?? false);
check('Y. RULE 1 — no injections when there are violations', r1.injections.length === 0);

const r1Clean = makeScenario([NAV, CLICK_ROLE, ASSERT_ROLE]);
check('Z. RULE 1 — clean scenario has no violations', runGate(r1Clean).violations.length === 0);

const r1Multi = makeScenario([NAV, { kind: 'wait', ms: 1000 }, CLICK_ROLE, { kind: 'wait', ms: 500 }, ASSERT_ROLE]);
const r1MultiResult = runGate(r1Multi);
check('AA. RULE 1 — two wait steps produce two violations', r1MultiResult.violations.length === 2);
check('AB. RULE 1 — violations at correct step indices', r1MultiResult.violations[0]?.stepIndex === 1 && r1MultiResult.violations[1]?.stepIndex === 3);

/* ─── RULE 2: minimum timeout injection ──────────────────────────────────── */

const r2Sc = makeScenario([NAV, CLICK_ROLE, ASSERT_ROLE]);
const r2 = runGate(r2Sc);

check('AC. RULE 2 — no violations on clean scenario', r2.violations.length === 0);
check('AD. RULE 2 — one injection for the toHaveText assertion', r2.injections.length === 1);
check('AE. RULE 2 — injection at step index 2', r2.injections[0]?.stepIndex === 2);
check('AF. RULE 2 — injected assertionType is toHaveText', r2.injections[0]?.assertionType === 'toHaveText');
const assertAfterInject = r2Sc.steps[2] as { kind: string; assertion: { timeout?: number } };
check('AG. RULE 2: a missing timeout after an action is raised in-place to the 10000 floor', assertAfterInject.assertion.timeout === 10000);

// A timeout at or above the floor (e.g. the adaptive value measured from the
// page) is left untouched — the gate never overrides a real measured budget.
const r2SufficientSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  // 12000: above the 10000 floor and under the 15000 ceiling, so RULE 2 leaves it alone.
  { kind: 'assert', name: 'ok', assertion: { type: 'toHaveText', target: { level: 'role', arg: { role: 'status', name: '' }, intent: 's' }, text: 'done', timeout: 12000 } },
];
check('AH. RULE 2: adaptive timeout above the floor and under the ceiling is not re-injected', runGate(makeScenario(r2SufficientSteps)).injections.length === 0);

// Below the floor — raised up to the floor only.
const r2LowSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'ok', assertion: { type: 'toBeVisible', target: { level: 'role', arg: { role: 'button', name: 'Done' }, intent: 'done button' }, timeout: 3000 } },
];
const r2LowSc = makeScenario(r2LowSteps);
const r2Low = runGate(r2LowSc);
check('AI. RULE 2 — below-floor timeout 3000 raised to the floor', r2Low.injections.length === 1);
check('AJ. RULE 2: in-place mutation to the 10000 floor confirmed', (r2LowSc.steps[2] as { kind: string; assertion: { timeout?: number } }).assertion.timeout === 10000);
// A timeout exactly at the floor is sufficient, not re-injected; the old
// 5000 floor after an action is now raised (run 44cb3d: three reworks).
const r2AtFloorSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'ok', assertion: { type: 'toBeVisible', target: { level: 'role', arg: { role: 'button', name: 'Done' }, intent: 'done button' }, timeout: 10000 } },
];
check('AJ2. RULE 2: a timeout exactly at the 10000 floor is not re-injected', runGate(makeScenario(r2AtFloorSteps)).injections.length === 0);
const r2OldFloorSc = makeScenario([NAV, CLICK_ROLE, { kind: 'assert', name: 'ok', assertion: { type: 'toContainText', target: { level: 'css', arg: '[data-test="email-error"]', intent: 'email required error text' }, text: '', pattern: '[Rr]equired|email', timeout: 5000 } }]);
const r2OldFloor = runGate(r2OldFloorSc);
check('AJ3. RULE 2: the run 44cb3d shape, 5000 after an action, is raised to 10000 and logged', (r2OldFloorSc.steps[2] as { assertion: { timeout?: number } }).assertion.timeout === 10000 && r2OldFloor.injections.some((i) => /raised timeout to the 10000ms floor on toContainText \(was 5000\)/.test(i.detail)), JSON.stringify(r2OldFloor.injections));

check('AK. RULE 2 — no injection when no action steps', runGate(makeScenario([{ kind: 'assert', name: 'v', assertion: { type: 'toBeVisible', target: { level: 'role', arg: { role: 'heading', name: 'Home' }, intent: 'h' } } }])).injections.length === 0);
// Run 51d535: four reworks read 'assert URL matches regex "/auth/register" [no-timeout]'
// as a one-shot check. A toHaveURL that follows an action is floored like every
// other type; one recorded before any action stays untouched.
const urlAfterAction = makeScenario([NAV, CLICK_ROLE, { kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: '/home' } }]);
const urlAfterActionResult = runGate(urlAfterAction);
check('AL. RULE 2: a toHaveURL with no timeout that follows an action is raised to the 10000 floor and logged', urlAfterActionResult.injections.some((i) => i.assertionType === 'toHaveURL' && /was unset/.test(i.detail)) && (urlAfterAction.steps[2] as { assertion: { timeout?: number } }).assertion.timeout === 10000, JSON.stringify(urlAfterActionResult.injections));
const urlFirst = makeScenario([{ kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: '/home' } }, NAV, CLICK_ROLE, ASSERT_ROLE]);
const urlFirstResult = runGate(urlFirst);
check('AL0. RULE 2: a toHaveURL recorded before any action in the scenario is left without a timeout', !urlFirstResult.injections.some((i) => i.assertionType === 'toHaveURL') && (urlFirst.steps[0] as { assertion: { timeout?: number } }).assertion.timeout === undefined, JSON.stringify(urlFirstResult.injections));
const urlAfterNav = makeScenario([NAV, { kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: '/home' } }]);
runGate(urlAfterNav);
check('AL1. RULE 2: a navigate counts as the action a toHaveURL follows', (urlAfterNav.steps[1] as { assertion: { timeout?: number } }).assertion.timeout === 10000);
// A toHaveURL the model gave a timeout gets the same floor and cap as every
// other timeout-bearing type (run 591732 passed 15000, which was never
// recorded; now it is, and 3000 or 60000 are corrected like any other).
const urlLow = makeScenario([NAV, { kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: '/home', timeout: 3000 } }]);
const urlLowResult = runGate(urlLow);
check('AL2. RULE 2: a toHaveURL timeout below the floor is raised to 10000 and logged', urlLowResult.injections.some((i) => i.assertionType === 'toHaveURL' && /was 3000/.test(i.detail)) && (urlLow.steps[1] as { assertion: { timeout?: number } }).assertion.timeout === 10000, JSON.stringify(urlLowResult.injections));
const urlHigh = makeScenario([NAV, { kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: '/home', timeout: 60000 } }]);
const urlHighResult = runGate(urlHigh);
check('AL3. RULE 2: a toHaveURL timeout above the ceiling is lowered to 15000 and logged', urlHighResult.injections.some((i) => i.assertionType === 'toHaveURL' && /was 60000/.test(i.detail)) && (urlHigh.steps[1] as { assertion: { timeout?: number } }).assertion.timeout === ASYNC_TIMEOUT_CEILING, JSON.stringify(urlHighResult.injections));
check('AL4. RULE 2: a toHaveURL timeout of 15000 is kept as recorded', runGate(makeScenario([NAV, { kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: '/home', timeout: 15000 } }])).injections.length === 0);

/* ─── RULE 3: stable selectors always allowed, even on animated elements ─── */

// #id with assert_freeze — STABLE, must NOT be flagged
const r3StableIdFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '#progressBar', intent: 'progress bar' }, 'progress bar'),
]);
const r3IdFreezeResult = runGate(r3StableIdFreeze);
check('AM. RULE 3 — #id with assert_freeze is ALLOWED (no violation)', r3IdFreezeResult.violations.length === 0);

// #id in toHaveText with long timeout — STABLE, must NOT be flagged
const r3IdLongTimeout: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'bar done', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#progressBar', intent: 'bar' }, text: '100%', timeout: 15000 } },
]);
check('AN. RULE 3 — #id toHaveText with timeout 15000 is ALLOWED', runGate(r3IdLongTimeout).violations.length === 0);

// [data-testid] with assert_freeze — STABLE, must NOT be flagged
const r3DataAttrFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '[data-testid="bar"]', intent: 'bar' }, 'bar'),
]);
check('AO. RULE 3 — [data-testid] with assert_freeze is ALLOWED', runGate(r3DataAttrFreeze).violations.length === 0);

// Single semantic class with assert_freeze — STABLE, must NOT be flagged
const r3SemanticFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '.progress-bar', intent: 'bar' }, 'bar'),
]);
check('AP. RULE 3 — .semantic-class with assert_freeze is ALLOWED', runGate(r3SemanticFreeze).violations.length === 0);

// Role locator with assert_freeze — ALLOWED (role tier, not CSS)
const r3RoleFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'role', arg: { role: 'progressbar', name: '' }, intent: 'bar' }, 'bar'),
]);
check('AQ. RULE 3 — role-tier assert_freeze is always ALLOWED', runGate(r3RoleFreeze).violations.length === 0);

/* ─── RULE 3: fragile selectors ARE rejected on animated elements ─────────── */

// .css-1a2b3c (hashed) with assert_freeze — FRAGILE, must be flagged
const r3HashedFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '.css-1a2b3c', intent: 'bar' }, 'bar'),
]);
const r3HashedFreezeResult = runGate(r3HashedFreeze);
check('AR. RULE 3 — .css-1a2b3c with assert_freeze produces violation', r3HashedFreezeResult.violations.length === 1);
check('AS. RULE 3 — violation has rule === 3', r3HashedFreezeResult.violations[0]?.rule === 3);

// :nth-child with assert_freeze — FRAGILE, must be flagged
const r3PositionalFreeze: Scenario = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: 'li:nth-child(2)', intent: 'item' }, 'item'),
]);
check('AT. RULE 3 — :nth-child with assert_freeze produces violation', runGate(r3PositionalFreeze).violations.length === 1);

// 3-level chain toHaveText with long timeout — FRAGILE, flagged
const r3DeepChainSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'deep', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.a .b .c', intent: 'leaf' }, text: '100%', timeout: 15000 } },
];
check('AU. RULE 3 — 3-level chain with timeout 15000 produces violation', runGate(makeScenario(r3DeepChainSteps)).violations.length === 1);

// 2-level chain toHaveText with long timeout — allowed (not deeper than 2)
const r3TwoLevelSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'two', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.parent .child', intent: 'child' }, text: 'ok', timeout: 15000 } },
];
check('AV. RULE 3 — 2-level chain with timeout 15000 is ALLOWED', runGate(makeScenario(r3TwoLevelSteps)).violations.length === 0);

// Fragile selector WITHOUT evidence of dynamism — NOT flagged (missing corroboration)
const r3FragileStaticSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'static', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.css-abc .child', intent: 'item' }, text: 'ok' } },
];
check('AW. RULE 3 — fragile selector with no dynamic evidence is NOT flagged', runGate(makeScenario(r3FragileStaticSteps)).violations.length === 0);

// Fragile selector with corroboration from another step — flagged
const r3FragileCorrobSteps: TraceStep[] = [
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'txt', assertion: { type: 'toHaveText', target: { level: 'css', arg: 'li:nth-child(2)', intent: 'item' }, text: '50%' } },
  freezeCompare({ level: 'css', arg: 'li:nth-child(2)', intent: 'item' }, 'item'),
];
const r3FragileCorrobResult = runGate(makeScenario(r3FragileCorrobSteps));
// assert_freeze at index 3 is fragile (RULE 3) → violation;
// toHaveText at index 2 is corroborated (RULE 3) → violation;
// toHaveText("50%") on same intent as assert_freeze (RULE 4) → violation = 3 total
// RULE 7 adds a fourth violation here (a literal on a list item); this check counts the RULE 3 and RULE 4 ones.
check('AX. RULE 3+4: fragile selector + intermediate value, three violations', r3FragileCorrobResult.violations.filter((v) => v.rule === 3 || v.rule === 4).length === 3 && r3FragileCorrobResult.violations.some((v) => v.rule === 7));

/* ─── RULE 1 + RULE 3 combined: violations win, no injections ───────────── */

const rCombined = makeScenario([
  NAV,
  { kind: 'wait', ms: 1500 },
  { kind: 'assert', name: 'd', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.css-1a2b3c', intent: 'x' }, text: 'x', timeout: 15000 } },
]);
const rCombinedResult = runGate(rCombined);
check('AY. combined RULE 1 + RULE 3 — both violations present', rCombinedResult.violations.length === 2);
check('AZ. combined — injections empty when violations exist', rCombinedResult.injections.length === 0);

/* ─── edge cases ─────────────────────────────────────────────────────────── */

check('BA. empty scenario — no violations', runGate({ name: 'empty', category: 'happy', steps: [] }).violations.length === 0);
check('BB. navigate-only — no violations or injections', (() => { const r = runGate(makeScenario([NAV])); return r.violations.length === 0 && r.injections.length === 0; })());

// The real progressbar scenario that was blocked: #progressBar with assert_freeze
const progressBarScenario: Scenario = makeScenario([
  NAV,
  CLICK_ROLE,
  { kind: 'assert', name: 'bar reaches 100%', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#progressBar', intent: 'progress bar' }, text: '100%' } },
]);
const progressBarResult = runGate(progressBarScenario);
check('BC. real progressBar scenario (#progressBar toHaveText) — no violations', progressBarResult.violations.length === 0);
check('BD. real progressBar scenario: RULE 2 raises a missing timeout to the floor', progressBarResult.injections.length === 1 && (progressBarScenario.steps[2] as { assertion: { timeout?: number } }).assertion.timeout === 10000);

/* ─── RULE 1 exception: stability_wait ───────────────────────────────────── */

// stability_wait is explicitly tagged and must NOT produce a RULE 1 violation
const r1SwSc = makeScenario([
  NAV, CLICK_ROLE,
  { kind: 'stability_wait', ms: 500 },
  ASSERT_ROLE,
]);
const r1SwResult = runGate(r1SwSc);
check('BE. RULE 1 — stability_wait is NOT a violation', r1SwResult.violations.length === 0);
check('BF. RULE 1 — stability_wait at max 1000ms still allowed', runGate(makeScenario([
  NAV, CLICK_ROLE,
  { kind: 'stability_wait', ms: 1000 },
  ASSERT_ROLE,
])).violations.length === 0);
// A mix of wait (RULE 1) and stability_wait — only wait should be flagged
const r1MixSc = makeScenario([
  NAV,
  { kind: 'wait', ms: 200 },
  { kind: 'stability_wait', ms: 300 },
  ASSERT_ROLE,
]);
const r1MixResult = runGate(r1MixSc);
check('BG. RULE 1 — wait+stability_wait mix: only wait flagged (1 violation)', r1MixResult.violations.length === 1);
check('BH. RULE 1 — flagged step is the wait, not the stability_wait', r1MixResult.violations[0]?.stepIndex === 1);

/* ─── RULE 4: intermediate value on animated element ─────────────────────── */

// assert_freeze on the same intent as toHaveText("50%") → RULE 4 violation
const r4Intent = 'progress bar';
const r4IntermediateSc = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '#bar', intent: r4Intent }, r4Intent),
  { kind: 'assert', name: 'bar at 50%', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#bar', intent: r4Intent }, text: '50%' } },
]);
const r4Result = runGate(r4IntermediateSc);
check('BI. RULE 4 — toHaveText("50%") on animated element is flagged', r4Result.violations.some((v) => v.rule === 4));

// Terminal values (100%, 0%) must NOT be flagged
const r4TerminalSc = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '#bar', intent: r4Intent }, r4Intent),
  { kind: 'assert', name: 'bar at 100%', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#bar', intent: r4Intent }, text: '100%' } },
]);
check('BJ. RULE 4 — toHaveText("100%") is NOT flagged (terminal value)', !runGate(r4TerminalSc).violations.some((v) => v.rule === 4));

// Without assert_freeze corroboration, "50%" text assertion is NOT flagged
const r4NoCorrobSc = makeScenario([
  NAV, CLICK_ROLE,
  { kind: 'assert', name: 'bar at 50%', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#bar', intent: r4Intent }, text: '50%' } },
]);
check('BK. RULE 4 — without assert_freeze corroboration, no RULE 4 violation', !runGate(r4NoCorrobSc).violations.some((v) => v.rule === 4));

/* ─── assert_freeze counts as an assertion ────────────────────────────────── */
// After the fix, a scenario with ONLY assert_freeze steps (no plain assert)
// should have no "no assertions" error — verified by assert_freeze NOT being
// blocked by the end_scenario guard. We confirm the gate accepts it.
const afOnlySc = makeScenario([
  NAV, CLICK_ROLE,
  freezeCompare({ level: 'css', arg: '#bar', intent: 'bar' }, 'bar'),
]);
const afOnlyResult = runGate(afOnlySc);
check('BL. assert_freeze on stable #id — gate accepts (no violations)', afOnlyResult.violations.length === 0);

/* ─── RULE 2 extension: toHaveCount and toBeHidden also get the floor ──────── */

const countAssert: TraceStep = {
  kind: 'assert',
  name: 'row count',
  // count 1: a literal count above 1 is RULE 7 (catalogue count), and this fixture is about the RULE 2 floor.
  assertion: { type: 'toHaveCount', target: { level: 'css', arg: '[data-testid="row"]', intent: 'rows' }, count: 1 },
};
const hiddenAssert: TraceStep = {
  kind: 'assert',
  name: 'spinner gone',
  assertion: { type: 'toBeHidden', target: { level: 'role', arg: { role: 'status', name: '' }, intent: 'spinner' } },
};
const r2ExtSc = makeScenario([NAV, CLICK_ROLE, countAssert, hiddenAssert]);
const r2Ext = runGate(r2ExtSc);
check('BM. RULE 2: toHaveCount after an action gets the floor timeout',
  (r2ExtSc.steps[2] as { assertion: { timeout?: number } }).assertion.timeout === 10000 &&
  r2Ext.injections.some((i) => i.assertionType === 'toHaveCount'), JSON.stringify(r2Ext.injections));
check('BN. RULE 2: toBeHidden after an action gets the floor timeout',
  (r2ExtSc.steps[3] as { assertion: { timeout?: number } }).assertion.timeout === 10000 &&
  r2Ext.injections.some((i) => i.assertionType === 'toBeHidden'));

/* ─── RULE 5: unused captures are stripped ─────────────────────────────────── */

const deadCapture: TraceStep = {
  kind: 'capture',
  varName: 'firstPrice',
  source: 'text',
  target: { level: 'css', arg: '[data-testid="price"]', intent: 'first price' },
  intent: 'first price',
};
const r5Sc = makeScenario([NAV, deadCapture, CLICK_ROLE, ASSERT_ROLE]);
const r5 = runGate(r5Sc);
check('BO. RULE 5 — a capture no assert_compare reads is stripped from the steps',
  !r5Sc.steps.some((s) => s.kind === 'capture'), JSON.stringify(r5Sc.steps.map((s) => s.kind)));
check('BP. RULE 5 — the strip is logged as an injection naming the variable',
  r5.injections.some((i) => i.assertionType === 'capture' && i.detail.includes('firstPrice') && i.detail.includes('unused capture')),
  JSON.stringify(r5.injections));
check('BQ. RULE 5 — stripping is not a violation (the scenario still ships)', r5.violations.length === 0);

const usedCapture: TraceStep = {
  kind: 'capture',
  varName: 'cap',
  source: 'attribute',
  target: { level: 'css', arg: '#bar', intent: 'bar' },
  attribute: 'aria-valuenow',
  intent: 'bar',
};
const r5UsedSc = makeScenario([NAV, usedCapture, CLICK_ROLE, freezeCompare({ level: 'css', arg: '#bar', intent: 'bar' }, 'bar')]);
const r5Used = runGate(r5UsedSc);
check('BR. RULE 5 — a capture read by assert_compare is kept',
  r5UsedSc.steps.some((s) => s.kind === 'capture') && !r5Used.injections.some((i) => i.detail.includes('unused capture')),
  JSON.stringify(r5UsedSc.steps.map((s) => s.kind)));

/* ─── RULE 6: no generated id embedded in a selector ─────────────────────── */
// Run ec8eff's filter scenario selected [data-test="category-01M2K06AWQJ6XZEYHJEKD7E8JV"],
// a catalogue key that changes on the next reseed, and the gate let it through
// because any [data-*] selector counted as stable.
const ulidCheckbox: TraceStep = { kind: 'set_checked', target: { level: 'css', arg: '[data-test="category-01M2K06AWQJ6XZEYHJEKD7E8JV"]', intent: 'first category checkbox' }, checked: true };
const r6a = runGate(makeScenario([NAV, ulidCheckbox, ASSERT_ROLE]));
check('R6A. a css selector embedding a ulid is rejected under RULE 6', r6a.violations.some((v) => v.rule === 6), JSON.stringify(r6a.violations));
check('R6B. the reason names the fragment and steers to role, label, an id-free testid or a table path',
  /embeds the generated id "01M2K06AWQJ6XZEYHJEKD7E8JV"/.test(r6a.violations[0]?.detail ?? '') && /role, label, or a testid that carries no id, or by a table-scoped path/.test(r6a.violations[0]?.detail ?? ''), r6a.violations[0]?.detail);
const testidUlid: TraceStep = { kind: 'click', target: { level: 'testid', arg: 'product-01JX8F2K9ABCDEF12345678', intent: 'product card' } };
check('R6C. a testid carrying a generated id is rejected too (any level, any step)', runGate(makeScenario([NAV, testidUlid, ASSERT_ROLE])).violations.some((v) => v.rule === 6));
const uuidAssert: TraceStep = { kind: 'assert', name: 'row', assertion: { type: 'toBeVisible', target: { level: 'css', arg: '[data-test="row-3f2b8a9c-1d4e-4f6a-9b2c-8d7e6f5a4b3c"]', intent: 'order row' }, timeout: 10000 } };
const r6d = runGate(makeScenario([NAV, CLICK_ROLE, uuidAssert]));
check('R6D. a uuid inside an assertion selector is rejected with the uuid named', r6d.violations.some((v) => v.rule === 6 && v.detail.includes('3f2b8a9c-1d4e-4f6a-9b2c-8d7e6f5a4b3c')), JSON.stringify(r6d.violations));
const hexCapture: TraceStep = { kind: 'capture', varName: 'cap_x', source: 'text', intent: 'price', target: { level: 'css', arg: '#price-507f1f77bcf86cd799439011', intent: 'price' } };
const hexCompare: TraceStep = { kind: 'assert_compare', varName: 'cap_x', readVar: 'cap_x_now', relation: 'changed', source: 'text', intent: 'price', target: { level: 'css', arg: '#price-507f1f77bcf86cd799439011', intent: 'price' } };
check('R6E. a mongo-style hex id on a capture and compare is rejected', runGate(makeScenario([NAV, hexCapture, CLICK_ROLE, hexCompare])).violations.filter((v) => v.rule === 6).length === 2);
const cleanTestid: TraceStep = { kind: 'set_checked', target: { level: 'css', arg: '[data-test="inventory-item-name"]', intent: 'name box' }, checked: true };
const longClass: TraceStep = { kind: 'click', target: { level: 'css', arg: '.inventory_item_description_container', intent: 'card body' } };
const tablePath: TraceStep = { kind: 'capture', varName: 'cap_c', source: 'text', intent: 'cell', target: { level: 'css', arg: '#table2 tbody tr:nth-child(1) td:nth-child(2)', intent: 'first cell' } };
const tableCompare: TraceStep = { kind: 'assert_compare', varName: 'cap_c', readVar: 'cap_c_now', relation: 'changed', source: 'text', intent: 'cell', target: { level: 'css', arg: '#table2 tbody tr:nth-child(1) td:nth-child(2)', intent: 'first cell' } };
const r6f = runGate(makeScenario([NAV, cleanTestid, longClass, tablePath, CLICK_ROLE, tableCompare, ASSERT_ROLE]));
check('R6F. an id-free testid, a long class with no digits, a role, and a table-scoped path pass RULE 6', !r6f.violations.some((v) => v.rule === 6), JSON.stringify(r6f.violations));
check('R6G. the shared label and drop reason exist for rule 6', gateRuleLabel(6) === 'RULE 6 (generated id in selector)' && gateBrokenReason(6) === 'selector embeds a generated id');
check('R6H. generatedIdFragment: ulid, uuid, hex found; ordinary ids and dates not', generatedIdFragment('category-01M2K06AWQJ6XZEYHJEKD7E8JV') === '01M2K06AWQJ6XZEYHJEKD7E8JV' && generatedIdFragment('a 3f2b8a9c-1d4e-4f6a-9b2c-8d7e6f5a4b3c b') === '3f2b8a9c-1d4e-4f6a-9b2c-8d7e6f5a4b3c' && generatedIdFragment('#507f1f77bcf86cd799439011') === '507f1f77bcf86cd799439011' && generatedIdFragment('[data-test="login-submit"]') === null && generatedIdFragment('order-2026-09-17-1234') === null && generatedIdFragment('.inventory_item_description_container') === null);

/* ─── RULE 2 keeps the model's toHaveCount timeout; only a missing or low one is floored ── */
const countKept: TraceStep = { kind: 'assert', name: 'count', assertion: { type: 'toHaveCount', target: { level: 'css', arg: '[data-testid="row"]', intent: 'rows' }, count: 1, timeout: 15000 } };
const rKept = runGate(makeScenario([NAV, CLICK_ROLE, countKept]));
check('R2K. a toHaveCount recorded with the model\'s 15000ms keeps it (no injection)', rKept.violations.length === 0 && !rKept.injections.some((i) => i.assertionType === 'toHaveCount') && (rKept as unknown as { injections: unknown[] }).injections !== undefined);
const countLow: TraceStep = { kind: 'assert', name: 'count', assertion: { type: 'toHaveCount', target: { level: 'css', arg: '[data-testid="row"]', intent: 'rows' }, count: 1, timeout: 3000 } };
const scLow = makeScenario([NAV, CLICK_ROLE, countLow]);
const rLow = runGate(scLow);
check('R2L. a toHaveCount recorded below the floor is raised to 10000 and logged', rLow.injections.some((i) => i.assertionType === 'toHaveCount' && /was 3000/.test(i.detail)) && (scLow.steps[2] as { assertion: { timeout?: number } }).assertion.timeout === 10000, JSON.stringify(rLow.injections));

/* ─── RULE 2 floor after an action is 10000; before any action, the old behavior ── */
check('R2F. the floor after an action is 10000 and the ceiling stays 15000', ASYNC_TIMEOUT_FLOOR_AFTER_ACTION === 10000 && ASYNC_TIMEOUT_CEILING === 15000);
const preTitle: TraceStep = { kind: 'assert', name: 'pre', assertion: { type: 'toHaveText', target: { level: 'testid', arg: 'page-title', intent: 'heading' }, text: 'Hand Tools' } };
const preUrl: TraceStep = { kind: 'assert', name: 'preUrl', assertion: { type: 'toHaveURL', pattern: '/home' } };
const preSc = makeScenario([preUrl, preTitle, NAV, CLICK_ROLE, ASSERT_ROLE]);
runGate(preSc);
const tOf = (st: TraceStep): number | undefined => (st as { assertion: { timeout?: number } }).assertion.timeout;
check('R2G. before any action: a toHaveURL stays untouched and another type keeps the 5000 floor; after the actions the same scenario floors at 10000', tOf(preSc.steps[0]!) === undefined && tOf(preSc.steps[1]!) === 5000 && tOf(preSc.steps[4]!) === 10000, JSON.stringify(preSc.steps.map((st) => st.kind === 'assert' ? tOf(st) ?? null : st.kind)));
const ladder = [[undefined, 10000], [5000, 10000], [9999, 10000], [10000, null], [12000, null], [15000, null], [20000, 15000]] as const;
check('R2H. rule2Timeout after an action: unset, 5000 and 9999 rise to 10000; 10000 to 15000 stand; 20000 is capped at 15000', ladder.every(([cur, want]) => (rule2Timeout('toBeVisible', cur, true, true)?.timeout ?? null) === want), JSON.stringify(ladder.map(([cur]) => rule2Timeout('toBeVisible', cur, true, true))));
check('R2I. every action kind sets the 10000 floor for what follows (navigate, click, fill, press, select_option, set_checked, set_input_files)',
  ([
    { kind: 'navigate', url: 'https://example.com/' },
    { kind: 'click', target: { level: 'css', arg: '#a', intent: 'a' } },
    { kind: 'fill', target: { level: 'css', arg: '#f', intent: 'f' }, value: 'x' },
    { kind: 'press', target: { level: 'css', arg: '#f', intent: 'f' }, key: 'Enter' },
    { kind: 'select_option', target: { level: 'css', arg: '#s', intent: 's' }, by: 'value', option: 'o' },
    { kind: 'set_checked', target: { level: 'css', arg: '#c', intent: 'c' }, checked: true },
    { kind: 'set_input_files', target: { level: 'css', arg: '#u', intent: 'u' }, files: ['a.txt'] },
  ] as TraceStep[]).every((act) => { const sc = makeScenario([act, preUrl]); runGate(sc); return tOf(sc.steps[1]!) === 10000; }));

/* ─── RULE 2 ceiling: a timeout above 15000 is lowered and logged ─────────── */
const bigTimeout: TraceStep = { kind: 'assert', name: 'price', assertion: { type: 'toContainText', target: { level: 'testid', arg: 'no-results', intent: 'no results message' }, text: 'no products found', timeout: 60000 } };
const scBig = makeScenario([NAV, CLICK_ROLE, bigTimeout]);
const rBig = runGate(scBig);
check('R2C. a 60000ms request is capped to the 15000ms ceiling and logged as an injection',
  ASYNC_TIMEOUT_CEILING === 15000 && (scBig.steps[2] as { assertion: { timeout?: number } }).assertion.timeout === 15000 && rBig.injections.some((i) => /lowered timeout to the 15000ms ceiling on toContainText \(was 60000\)/.test(i.detail)) && rBig.violations.length === 0, JSON.stringify(rBig.injections));
const okTimeout: TraceStep = { kind: 'assert', name: 'price', assertion: { type: 'toContainText', target: { level: 'testid', arg: 'no-results', intent: 'no results message' }, text: 'no products found', timeout: 15000 } };
check('R2D. exactly 15000 is untouched', runGate(makeScenario([NAV, CLICK_ROLE, okTimeout])).injections.length === 0);
const bigNoAction: TraceStep = { kind: 'assert', name: 'h', assertion: { type: 'toHaveText', target: { level: 'testid', arg: 'page-title', intent: 'heading' }, text: 'Category: Hand Tools', timeout: 40000 } };
check('R2E. the ceiling applies even with no action in the scenario (the floor does not)', runGate(makeScenario([NAV, bigNoAction])).injections.some((i) => /lowered timeout to the 15000ms ceiling/.test(i.detail)));

/* ─── RULE 7: literal catalogue values, the six f3b41e shapes ──────────────── */
const card = (extra = ''): SelectorRecord => ({ level: 'css', arg: `a[data-test^="product-"]:first-of-type${extra}`, intent: 'first product card' });
const price: TraceStep = { kind: 'assert', name: 'p', assertion: { type: 'toContainText', target: card(' span.text-muted'), text: '$14.15', timeout: 10000 } };
const wrench: TraceStep = { kind: 'assert', name: 'w', assertion: { type: 'toHaveText', target: card(' h5'), text: 'Adjustable Wrench', timeout: 10000 } };
const sander: TraceStep = { kind: 'assert', name: 's', assertion: { type: 'toContainText', target: card(), text: 'Sander', timeout: 10000 } };
const count9: TraceStep = { kind: 'assert', name: 'c9', assertion: { type: 'toHaveCount', target: { level: 'css', arg: 'a[data-test^="product-"]', intent: 'product cards' }, count: 9, timeout: 10000 } };
const count8: TraceStep = { kind: 'assert', name: 'c8', assertion: { type: 'toHaveCount', target: { level: 'css', arg: 'a[data-test^="product-"]', intent: 'product cards' }, count: 8, timeout: 10000 } };
const count0: TraceStep = { kind: 'assert', name: 'c0', assertion: { type: 'toHaveCount', target: { level: 'css', arg: 'a[data-test^="product-"]', intent: 'product cards' }, count: 0, timeout: 10000 } };
const count1: TraceStep = { kind: 'assert', name: 'c1', assertion: { type: 'toHaveCount', target: { level: 'css', arg: 'tbody tr.selected', intent: 'selected row' }, count: 1, timeout: 10000 } };
for (const [label, step, frag] of [['$14.15 on a card price', price, '"$14.15"'], ['Adjustable Wrench on a card name', wrench, '"Adjustable Wrench"'], ['contains Sander on a card', sander, '"Sander"'], ['count=9 on the product cards', count9, 'count=9'], ['count=8 on the product cards', count8, 'count=8']] as Array<[string, TraceStep, string]>) {
  const r = runGate(makeScenario([NAV, CLICK_ROLE, step]));
  check(`R7A. ${label} is rejected under RULE 7 with the capture-then-compare steer`, r.violations.some((v) => v.rule === 7 && v.detail.includes(frag) && /capture the value, act, assert_compare/.test(v.detail)), JSON.stringify(r.violations));
}
check('R7B. count 0 (absence) and count 1 stay allowed', !runGate(makeScenario([NAV, CLICK_ROLE, count0, count1])).violations.some((v) => v.rule === 7));
const countBoxes: TraceStep = { kind: 'assert', name: 'cb', assertion: { type: 'toHaveCount', target: { level: 'css', arg: '#checkboxes input[type=checkbox]', intent: 'checkbox inputs' }, count: 3, timeout: 10000 } };
check('R7B2. a count of form controls (three checkboxes) is structural, not catalogue data, so it stays allowed', !runGate(makeScenario([NAV, CLICK_ROLE, countBoxes])).violations.some((v) => v.rule === 7));
const heading: TraceStep = { kind: 'assert', name: 'h', assertion: { type: 'toHaveText', target: { level: 'testid', arg: 'page-title', intent: 'category heading' }, text: 'Category: Hand Tools', timeout: 10000 } };
const noResults: TraceStep = { kind: 'assert', name: 'n', assertion: { type: 'toContainText', target: { level: 'testid', arg: 'no-results', intent: 'no results message' }, text: 'no products found', timeout: 10000 } };
const loginError: TraceStep = { kind: 'assert', name: 'e', assertion: { type: 'toContainText', target: { level: 'css', arg: '[data-test="login-error"]', intent: 'login error message' }, text: 'Invalid email or password', timeout: 10000 } };
const caption: TraceStep = { kind: 'assert', name: 'cap', assertion: { type: 'toContainText', target: { level: 'css', arg: '[data-test="search-caption"]', intent: 'search caption' }, text: 'Pliers', timeout: 10000 } };
const alertPrice: TraceStep = { kind: 'assert', name: 'ap', assertion: { type: 'toContainText', target: { level: 'role', arg: { role: 'alert' }, intent: 'order confirmation alert' }, text: '$14.15', timeout: 10000 } };
const searchFill: TraceStep = { kind: 'fill', target: { level: 'testid', arg: 'search-query', intent: 'search input' }, value: 'a' };
const searchValue: TraceStep = { kind: 'assert', name: 'v', assertion: { type: 'toHaveValue', target: { level: 'testid', arg: 'search-query', intent: 'search input' }, value: 'a', timeout: 10000 } };
const rAllowed = runGate(makeScenario([NAV, searchFill, CLICK_ROLE, heading, noResults, loginError, caption, alertPrice, searchValue]));
check('R7C. a heading, a message, an alert (even with a price), a caption and a field the scenario filled are never catalogue data', !rAllowed.violations.some((v) => v.rule === 7), JSON.stringify(rAllowed.violations));
const totalPrice: TraceStep = { kind: 'assert', name: 't', assertion: { type: 'toHaveText', target: { level: 'css', arg: '.summary .total', intent: 'order total' }, text: '$73.59', timeout: 10000 } };
check('R7D. a price literal is rejected on any non-message target', runGate(makeScenario([NAV, CLICK_ROLE, totalPrice])).violations.some((v) => v.rule === 7 && /price literal/.test(v.detail)));
check('R7E. the shared label and drop reason exist for rule 7', gateRuleLabel(7) === 'RULE 7 (literal catalogue value)' && gateBrokenReason(7) === 'literal catalogue value asserted');
check('R7F. catalogueLiteralReason is null for a filled field value and for a row cell count of 1', catalogueLiteralReason(searchValue.assertion, [searchFill]) === null && catalogueLiteralReason(count1.assertion, []) === null);

/* ─── RULE 7: a pattern is a format, a minimum of one is structural, an account name is a literal ── */
// Run 5e4394: the repair tried toHaveText "/\\S+/" on a card (rejected as a
// literal), the Critic asked for a name-shaped pattern instead of "Jane Doe",
// and count=9 was the only count form. A recorded pattern passes; atLeast 1
// passes; a literal account name is rejected on any target.
const cardPrice: SelectorRecord = { level: 'css', arg: 'a.card .card-footer', intent: 'first card price' };
const cardName: SelectorRecord = { level: 'css', arg: 'a.card h5', intent: 'first card name' };
check('R7P1. a price PATTERN on a product card is allowed (a format assertion)',
  catalogueLiteralReason({ type: 'toHaveText', target: cardPrice, text: '', pattern: '^\\$\\d+\\.\\d{2}$' }, []) === null);
check('R7P2. a non-empty PATTERN on a card name is allowed',
  catalogueLiteralReason({ type: 'toContainText', target: cardName, text: '', pattern: '\\S' }, []) === null);
check('R7P3. a literal on the same card target is still rejected',
  /catalogue data/.test(catalogueLiteralReason({ type: 'toHaveText', target: cardName, text: 'Sheet Sander' }, []) ?? ''));
check('R7P4. toHaveCount atLeast 1 on product cards is allowed (structural "at least one")',
  catalogueLiteralReason({ type: 'toHaveCount', target: { level: 'css', arg: 'a.card', intent: 'product cards' }, count: 1, atLeast: true }, []) === null);
check('R7P5. toHaveCount atLeast 9 on product cards is still a literal catalogue count',
  /literal catalogue count/.test(catalogueLiteralReason({ type: 'toHaveCount', target: { level: 'css', arg: 'a.card', intent: 'product cards' }, count: 9, atLeast: true }, []) ?? ''));
check('R7P6. the RULE 7 steer names the pattern and minimum forms',
  /assert with regex/.test(catalogueLiteralReason({ type: 'toHaveText', target: cardName, text: 'Sheet Sander' }, []) ?? '') && /atLeast 1/.test(catalogueLiteralReason({ type: 'toHaveText', target: cardName, text: 'Sheet Sander' }, []) ?? ''));
const loginFills: TraceStep[] = [
  { kind: 'fill', target: { level: 'testid', arg: 'email', intent: 'email input' }, value: 'customer@practicesoftwaretesting.com' },
  { kind: 'fill', target: { level: 'testid', arg: 'password', intent: 'password input' }, value: 'welcome01' },
  { kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login' }, intent: 'login button' } },
];
const navMenu: SelectorRecord = { level: 'testid', arg: 'nav-menu', intent: 'user menu' };
const janeDoe = catalogueLiteralReason({ type: 'toHaveText', target: navMenu, text: 'Jane Doe' }, loginFills);
check('R7A1. "Jane Doe" on the user menu after a login is a literal account name', /user\'s name shown after login|account/.test(janeDoe ?? '') && /name-shaped pattern/.test(janeDoe ?? ''), janeDoe ?? 'null');
const typedName = catalogueLiteralReason({ type: 'toContainText', target: { level: 'role', arg: { role: 'alert' }, intent: 'welcome banner' }, text: 'customer@practicesoftwaretesting.com' }, loginFills);
check('R7A2. the identifier typed into the email field is a literal account value on any target', /typed into email input/.test(typedName ?? '') && /name-shaped pattern/.test(typedName ?? ''), typedName ?? 'null');
const known = catalogueLiteralReason({ type: 'toHaveText', target: { level: 'css', arg: '#greeting', intent: 'greeting' }, text: 'admin@practicesoftwaretesting.com' }, [], ['admin@practicesoftwaretesting.com']);
check('R7A3. an account the SRS names is a literal account value', /SRS names/.test(known ?? ''), known ?? 'null');
check('R7A4. a name-shaped literal WITHOUT a login in the scenario is not an account name (a heading stays allowed)',
  catalogueLiteralReason({ type: 'toHaveText', target: { level: 'testid', arg: 'page-title', intent: 'page heading' }, text: 'Hand Tools' }, []) === null);
check('R7A5. a message literal after login that is not a name is still allowed',
  catalogueLiteralReason({ type: 'toContainText', target: { level: 'role', arg: { role: 'alert' }, intent: 'alert' }, text: 'Thanks for your message' }, loginFills) === null);
check('R7A6. a name-shaped pattern on the user menu is allowed',
  catalogueLiteralReason({ type: 'toHaveText', target: navMenu, text: '', pattern: '^\\S+ \\S+$' }, loginFills) === null);
check('R7A7. runGate passes known names through to RULE 7',
  runGate(makeScenario([NAV, ...loginFills, { kind: 'assert', name: 'g', assertion: { type: 'toHaveText', target: { level: 'css', arg: '#greeting', intent: 'greeting' }, text: 'Admin User' } }]), { knownNames: ['Admin User'] }).violations.some((v) => v.rule === 7 && /SRS names/.test(v.detail)));

/* ─── Counters: a literal count on a badge (RULE 7) and a count capture (RULE 9) ── */
// Run 44cb3d: "cart badge shows 1" asserted three times and reworked three
// times; the repair then captured the badge's ELEMENT count, 0 before the add
// and 1 after, which proves the badge appeared, not that it went up.
const badge: SelectorRecord = { level: 'css', arg: "[data-test='cart-quantity']", intent: 'cart badge shows 1' };
const badgeOne: TraceStep = { kind: 'assert', name: 'b1', assertion: { type: 'toHaveText', target: badge, text: '1', timeout: 15000 } };
const rBadge = runGate(makeScenario([NAV, CLICK_ROLE, badgeOne]));
check('C9A. the run 44cb3d badge literal "1" is rejected under RULE 7 with the counter steer', rBadge.violations.some((v) => v.rule === 7 && v.detail.includes('"1"') && v.detail.includes(COUNTER_LITERAL_STEER)), JSON.stringify(rBadge.violations));
check('C9B. the counter words match as whole words or data-test segments, camelCase included',
  [{ level: 'testid', arg: 'cart-quantity', intent: 'header' }, { level: 'css', arg: '.badge', intent: 'x' }, { level: 'css', arg: '#cartCount', intent: 'x' }, { level: 'css', arg: '#n', intent: 'item counter' }, { level: 'css', arg: '[data-test="qty"]', intent: 'x' }, { level: 'css', arg: '#n', intent: 'cart count in the header' }].every((t) => isCounterTarget(t as SelectorRecord)));
check('C9C. account, discount, country and counted are not counter targets',
  ['account', 'discount', 'country', 'counted'].every((w) => !isCounterTarget({ level: 'testid', arg: `${w}-label`, intent: `${w} value` })) && !COUNTER_TARGET_RE.test('account') && COUNTER_TARGET_RE.test('quantity'));
check('C9D. a literal "1" on account and discount targets is not refused (no RULE 7 at all)',
  catalogueLiteralReason({ type: 'toHaveText', target: { level: 'testid', arg: 'account-level', intent: 'account level' }, text: '1' }, []) === null
  && catalogueLiteralReason({ type: 'toHaveText', target: { level: 'css', arg: '[data-test="discount-code"]', intent: 'discount code' }, text: '1' }, []) === null);
check('C9E. a literal "1" on a non-counter target keeps RULE 7\'s existing behavior: allowed on a heading, rejected on a product card without the counter steer',
  catalogueLiteralReason({ type: 'toHaveText', target: { level: 'css', arg: 'h1', intent: 'step heading' }, text: '1' }, []) === null
  && /catalogue data/.test(catalogueLiteralReason({ type: 'toHaveText', target: card(' h5'), text: '1' }, []) ?? '')
  && !(catalogueLiteralReason({ type: 'toHaveText', target: card(' h5'), text: '1' }, []) ?? '').includes(COUNTER_LITERAL_STEER));
check('C9F. a pattern on a counter is a format, and a non-integer text on a badge is not a literal count',
  counterLiteralReason({ type: 'toHaveText', target: badge, text: '', pattern: '^\\d+$' }) === null && counterLiteralReason({ type: 'toContainText', target: badge, text: 'New' }) === null && counterLiteralReason({ type: 'toContainText', target: badge, text: ' 12 ' }) !== null);
check('C9G. toHaveCount 0 and 1 on a counter keep RULE 7\'s existing behavior (allowed)',
  !runGate(makeScenario([NAV, CLICK_ROLE, { kind: 'assert', name: 'h', assertion: { type: 'toHaveCount', target: badge, count: 0, timeout: 10000 } }, { kind: 'assert', name: 'o', assertion: { type: 'toHaveCount', target: badge, count: 1, timeout: 10000 } }])).violations.some((v) => v.rule === 7));
const countCap: TraceStep = { kind: 'capture', varName: 'cap_cartBefore', source: 'count', target: { ...badge, intent: 'cart badge count elements before add' }, intent: 'cart badge count elements before add' };
const countCmp: TraceStep = { kind: 'assert_compare', varName: 'cap_cartBefore', relation: 'greater', source: 'count', target: countCap.target, intent: 'cart badge', readVar: 'cap_cartBefore_now' };
const rCountCap = runGate(makeScenario([NAV, countCap, CLICK_ROLE, countCmp]));
check('C9H. a count capture on the badge is rejected under RULE 9 with the read-its-text steer', rCountCap.violations.some((v) => v.rule === 9 && v.stepIndex === 1 && v.detail.includes(COUNTER_COUNT_CAPTURE_STEER)) && counterCountCaptureReason(countCap.target, 'count') !== null && counterCountCaptureReason(countCap.target, 'text') === null, JSON.stringify(rCountCap.violations));
const textCap: TraceStep = { ...countCap, source: 'text', intent: 'cart badge before add' } as TraceStep;
const textCmp: TraceStep = { ...countCmp, source: 'text' } as TraceStep;
check('C9I. a text capture plus greater on the badge passes the gate', runGate(makeScenario([NAV, textCap, CLICK_ROLE, textCmp])).violations.length === 0);
check('C9J. a count capture of product rows is not a counter and passes', runGate(makeScenario([NAV, { ...countCap, target: { level: 'css', arg: "tr[data-test^='product-']", intent: 'cart product rows before remove' } } as TraceStep, CLICK_ROLE, { ...countCmp, relation: 'less', target: { level: 'css', arg: "tr[data-test^='product-']", intent: 'cart product rows before remove' } } as TraceStep])).violations.length === 0);
check('C9K. the shared label and drop reason exist for rule 9', gateRuleLabel(9) === 'RULE 9 (counter read as an element count)' && gateBrokenReason(9) === 'counter captured as an element count');

/* ─── RULE 8: a currency amount in a locator name ────────────────────────── */
// Run 51d535: the Critic reworked three scenarios whose role or label hint was
// the card's whole accessible name, badge and price included.
check('R8A. currencyAmountIn finds "$48.41" in the concatenated card name', currencyAmountIn('Bolt Cutters ABCDE$48.41') === '$48.41');
check('R8B. currencyAmountIn handles a code before and a symbol after the number, and thousands', currencyAmountIn('Combination Pliers EUR 14,15') === 'EUR 14,15' && currencyAmountIn('Drill 1,299.00 €') === '1,299.00 €' && currencyAmountIn('Total: 12 USD') === '12 USD');
check('R8C. currencyAmountIn is null for a name with a plain number, a symbol alone, or no digit', currencyAmountIn('Bolt Cutters 2') === null && currencyAmountIn('Price in $') === null && currencyAmountIn('Hammer') === null);
const pricedLink: SelectorRecord = { level: 'role', arg: { role: 'link', name: 'Bolt Cutters ABCDE$48.41' }, intent: 'first product card' };
const pricedLabel: SelectorRecord = { level: 'label', arg: 'Pliers $14.15', intent: 'pliers card' };
const pricedText: SelectorRecord = { level: 'text', arg: 'Combination Pliers $14.15', intent: 'pliers card' };
const plainLink: SelectorRecord = { level: 'role', arg: { role: 'link', name: 'Bolt Cutters' }, intent: 'first product card' };
const r8Role = priceInNameReason(pricedLink);
check('R8D. a role name carrying a price is rejected with the prefix steer', /"\$48\.41"/.test(r8Role ?? '') && (r8Role ?? '').endsWith(PRICE_IN_NAME_STEER), r8Role ?? 'null');
check('R8E. a label and a text locator carrying a price are rejected too', /\$14\.15/.test(priceInNameReason(pricedLabel) ?? '') && /\$14\.15/.test(priceInNameReason(pricedText) ?? ''));
check('R8F. the shortest distinguishing prefix passes, and a css or testid locator is never judged', priceInNameReason(plainLink) === null && priceInNameReason({ level: 'css', arg: '[data-test="product-price"]', intent: 'p' }) === null && priceInNameReason({ level: 'testid', arg: 'product-48.41', intent: 'p' }) === null);
const r8Click = runGate(makeScenario([NAV, { kind: 'click', target: pricedLink }, ASSERT_ROLE]));
check('R8G. runGate rejects a click on a priced role name under RULE 8 at the right step', r8Click.violations.some((v) => v.rule === 8 && v.stepIndex === 1 && /step 2:/.test(v.detail) && /\$48\.41/.test(v.detail)), JSON.stringify(r8Click.violations));
const r8Compare = runGate(makeScenario([NAV, CLICK_ROLE, { kind: 'capture', varName: 'c', source: 'text', target: { level: 'testid', arg: 'product-price', intent: 'first price' }, intent: 'first price' }, { kind: 'assert_compare', varName: 'c', relation: 'less', source: 'text', target: { level: 'testid', arg: 'product-price', intent: 'first price' }, intent: 'first price', readVar: 'cn', readTarget: pricedText }]));
check('R8H. a compare re-read target with a price in its text locator is rejected under RULE 8', r8Compare.violations.some((v) => v.rule === 8 && v.stepIndex === 3));
check('R8I. the shared label and drop reason exist for rule 8', gateRuleLabel(8) === 'RULE 8 (price in locator name)' && gateBrokenReason(8) === 'locator name carries a price');
check('R8J. the clean steps of the same scenario carry no RULE 8 violation', !runGate(makeScenario([NAV, { kind: 'click', target: plainLink }, ASSERT_ROLE])).violations.some((v) => v.rule === 8));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: Static validation gate: RULE 1 exception (stability_wait), RULE 2 floor enforcement (10000ms after an action, all timeout-bearing types, the 15000ms cap), RULE 4 (intermediate value), RULE 5 (unused captures stripped), RULE 7 counter literals, RULE 8 (price in a locator name), RULE 9 (counter count capture), assert_freeze counting.');
