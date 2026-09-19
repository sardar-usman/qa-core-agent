/**
 * Locks the rework repair pass gate logic (src/agent/critic.ts):
 *   - splitGate: reject drops, rework goes to repair, pass (or no verdict)
 *     continues
 *   - mergeRepairVerdicts: rework -> pass keeps the repaired scenario;
 *     rework -> rework/reject drops for real (the ONE-pass cap: a second
 *     rework gets no third chance, structurally); a rework never re-recorded
 *     drops; non-rework verdicts pass through untouched
 *   - verdict history records every rework journey
 *   - reconciliation sees the FINAL verdicts, so a repaired-to-pass scenario
 *     is not counted as a critic drop
 *
 * Fixture verdicts only. No live calls. No browser.
 */
import { decideRepairPass, splitGate, mergeRepairVerdicts, repairDoneEvent, repairScenarioEvents, verdictMatchesScenario, verdictFor, type ScenarioVerdict } from '../src/agent/critic.js';
import { reconcile } from '../src/agent/reconcile.js';
import { computeRuleCoverage } from '../src/agent/rule-coverage.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const v = (scenario: string, verdict: ScenarioVerdict['verdict'], reasons: string[] = []): ScenarioVerdict =>
  ({ scenario, verdict, reasons, required_fixes: [] });

const scenarios = [
  { name: 's-pass' },
  { name: 's-reject' },
  { name: 's-rework-a' },
  { name: 's-rework-b' },
  { name: 's-unjudged' },
];
const verdicts = [
  v('s-pass', 'pass'),
  v('s-reject', 'reject', ['tests nothing meaningful']),
  v('s-rework-a', 'rework', ['assertion is vacuous']),
  v('s-rework-b', 'rework', ['missing outcome assertion']),
];

/* ─── A. the three-way gate split ──────────────────────────────────────────── */
const split = splitGate(scenarios, verdicts);
check('A1. pass continues', split.kept.some((s) => s.name === 's-pass'));
check('A2. a scenario with no verdict continues (the critic did not flag it)', split.kept.some((s) => s.name === 's-unjudged'));
check('A3. reject drops for good', split.rejected.length === 1 && split.rejected[0]?.name === 's-reject');
check('A4. rework goes to the repair pass, not the floor', JSON.stringify(split.rework.map((s) => s.name)) === '["s-rework-a","s-rework-b"]');

/* ─── B. merge after the repair pass ───────────────────────────────────────── */
// Repair re-recorded both reworks; the critic passed one and reworked the other.
const second = [v('s-rework-a', 'pass'), v('s-rework-b', 'rework', ['still too weak'])];
const merged = mergeRepairVerdicts(verdicts, second);
check('B1. rework -> pass replaces the verdict (kept)',
  merged.final.find((x) => x.scenario === 's-rework-a')?.verdict === 'pass');
check('B2. rework -> rework stays a drop: the ONE-pass cap, no third chance',
  merged.final.find((x) => x.scenario === 's-rework-b')?.verdict === 'rework');
check('B3. non-rework verdicts pass through untouched',
  merged.final.find((x) => x.scenario === 's-reject')?.verdict === 'reject' &&
  merged.final.find((x) => x.scenario === 's-pass')?.verdict === 'pass');
check('B4. history records both journeys',
  JSON.stringify(merged.history) === JSON.stringify([
    { scenario: 's-rework-a', first: 'rework', second: 'pass', outcome: 'kept' },
    { scenario: 's-rework-b', first: 'rework', second: 'rework', outcome: 'dropped' },
  ]), JSON.stringify(merged.history));

/* ─── C. rework -> reject also drops; not-re-recorded drops ────────────────── */
const merged2 = mergeRepairVerdicts(verdicts, [v('s-rework-a', 'reject', ['redundant after all'])]);
check('C1. rework -> reject drops', merged2.history.find((h) => h.scenario === 's-rework-a')?.outcome === 'dropped');
check('C2. a rework the repair never re-recorded drops with no second verdict',
  merged2.history.find((h) => h.scenario === 's-rework-b')?.outcome === 'dropped' &&
  merged2.history.find((h) => h.scenario === 's-rework-b')?.second === undefined);

/* ─── D. no repair pass at all (null): every rework drops, history says so ─── */
const merged3 = mergeRepairVerdicts(verdicts, null);
check('D1. with no repair pass both reworks drop', merged3.history.length === 2 && merged3.history.every((h) => h.outcome === 'dropped'));
check('D2. final verdicts keep rework so reconciliation counts the drop',
  merged3.final.filter((x) => x.verdict === 'rework').length === 2);

/* ─── E. reconciliation sees final verdicts: repaired-to-pass is NOT a drop ── */
const report = {
  scenarios: [{ name: 's-pass' }, { name: 's-unjudged' }, { name: 's-rework-a' }],
  plan: scenarios.map((s) => ({ name: s.name, category: 'happy', rationale: 'r' })),
  review: { verdicts: merged.final, summary: '' },
} as unknown as RunReport;
const rec = reconcile(report);
check('E1. the repaired-to-pass scenario is generated, not a critic drop',
  !rec.dropped.some((d) => d.name === 's-rework-a'), JSON.stringify(rec.dropped));
check('E2. the second-time rework and the reject each count exactly one critic drop',
  rec.dropped.filter((d) => d.stage === 'critic').length === 2);
check('E3. the funnel balances: planned 5 = generated 3 + dropped 2', rec.balanced === true && rec.accountedFor === 5);

/* ─── F. tolerant verdict-name matching (the silent-skip live bug) ─────────── */
check('F1. an echoed "[category]" prefix still matches',
  verdictMatchesScenario('[negative] rejected a wrong password', 'rejected a wrong password'));
check('F2. an echoed "N." numbering still matches',
  verdictMatchesScenario('3. rejected an empty username', 'rejected an empty username'));
check('F3. combined prefix, casing, and article drift still match',
  verdictMatchesScenario('2. [happy] Added product to the cart', 'added a product to the cart'));
check('F4. unrelated names do NOT match',
  !verdictMatchesScenario('[happy] sorted by price', 'rejected a wrong password'));

const prefixed = [
  v('[happy] s-pass', 'pass'),
  v('1. [negative] s-reject', 'reject', ['tests nothing meaningful']),
  v('[edge] s-rework-a', 'rework', ['assertion is vacuous']),
];
const tolerantSplit = splitGate(scenarios, prefixed);
check('F5. splitGate buckets by tolerant match, not exact string',
  tolerantSplit.rejected.length === 1 && tolerantSplit.rejected[0]?.name === 's-reject' &&
  tolerantSplit.rework.length === 1 && tolerantSplit.rework[0]?.name === 's-rework-a',
  JSON.stringify({ rejected: tolerantSplit.rejected, rework: tolerantSplit.rework }));

const tolerantMerge = mergeRepairVerdicts(
  [v('[edge] s-rework-a', 'rework', ['weak'])],
  [v('s-rework-a', 'pass')],
);
check('F6. mergeRepairVerdicts pairs first and second verdicts tolerantly',
  tolerantMerge.history[0]?.outcome === 'kept' && tolerantMerge.final[0]?.verdict === 'pass',
  JSON.stringify(tolerantMerge));
check('F7. verdictFor finds a scenario\'s verdict through the prefix',
  verdictFor(prefixed, 's-rework-a')?.verdict === 'rework');


/* ─── G. the repair pass reports itself as events: started, one per scenario, done ─── */
{
  const rework = ['s-rework-a', 's-rework-b', 's-rework-c'];
  const perScenario = repairScenarioEvents(rework, ['1. [happy] s-rework-a'], { 's-rework-b': 'mid-repair when the cost ceiling hit; the in-progress work is discarded' });
  check('G1. one repair_scenario event per rework scenario, in plan order', perScenario.length === 3 && perScenario.every((e) => e.type === 'repair_scenario') && perScenario.map((e) => e.name).join(',') === rework.join(','));
  check('G2. a re-recorded trace matches tolerantly (echoed prefix) and carries no reason', perScenario[0]?.outcome === 're-recorded' && perScenario[0]?.reason === undefined);
  check('G3. a scenario the pass never re-recorded says so with the recorded reason', perScenario[1]?.outcome === 'not re-recorded' && /cost ceiling/.test(perScenario[1]?.reason ?? ''));
  check('G4. a scenario with no recorded reason still gets an honest one', perScenario[2]?.outcome === 'not re-recorded' && perScenario[2]?.reason === 'no trace came back from the repair pass');
  const history = mergeRepairVerdicts(
    [{ scenario: 's-rework-a', verdict: 'rework', reasons: [], required_fixes: [] }, { scenario: 's-rework-b', verdict: 'rework', reasons: [], required_fixes: [] }, { scenario: 's-rework-c', verdict: 'rework', reasons: [], required_fixes: [] }],
    [{ scenario: 's-rework-a', verdict: 'pass', reasons: [], required_fixes: [] }],
  ).history;
  const done = repairDoneEvent(history, 0.8642775);
  check('G5. repair_done carries the spend and the kept/dropped split of the verdict history (1 kept, 2 dropped)', done.type === 'repair_done' && done.usd === 0.8642775 && done.kept === 1 && done.dropped === 2 && history.length === 3, JSON.stringify(done));
  const started = { type: 'repair_started', count: rework.length, budgetUsd: 1.28 } as const;
  check('G6. the three event types appear once, in order, with the counts the report will carry', [started.type, ...perScenario.map((e) => e.type), done.type].join(',') === 'repair_started,repair_scenario,repair_scenario,repair_scenario,repair_done' && started.count === rework.length && started.count === done.kept + done.dropped);
}

/* ─── H. the repair pass is offered the stated reserve, with the per-scenario cost shown ── */
{
  const rw = (scenario: string) => ({ scenario, verdict: 'rework' as const, reasons: ['weak'], required_fixes: ['fix'] });
  const d = decideRepairPass({ scenarios: [{ name: 'alpha' }, { name: 'beta' }], verdicts: [rw('alpha'), rw('beta')], reserveUsd: 0.3, explorerUsd: 0.4, recorded: 4 });
  check('H1. the budget offered is the reserve itself', d?.run === true && Math.abs(d.budgetUsd - 0.3) < 1e-9, JSON.stringify(d));
  check('H2. the line states the reserve, the observed per-scenario explorer cost, and names what is repaired', d?.line === 'repair pass: 2 of 2 rework scenario(s), budget $0.30 (the stated reserve); explorer cost this run $0.1000 per recorded scenario, so the reserve funds 2 of 2; repairing: "alpha", "beta"', d?.line);
  const thin = decideRepairPass({ scenarios: [{ name: 'alpha' }, { name: 'beta' }], verdicts: [rw('alpha'), rw('beta')], reserveUsd: 0.3, explorerUsd: 2.0, recorded: 2 });
  check('H3. a reserve smaller than one scenario still funds one (the minimum) and names the other as not repaired', thin?.rework.length === 1 && thin?.unfunded.length === 1 && /reserve funds 1 of 2/.test(thin?.line ?? '') && /not repaired \(reserve funds 1 of 2\): "beta"/.test(thin?.line ?? ''), thin?.line);
  const none = decideRepairPass({ scenarios: [{ name: 'alpha' }], verdicts: [rw('alpha')], reserveUsd: 0.3, explorerUsd: 0, recorded: 0 });
  check('H4. with nothing recorded the line says no per-scenario cost was observed and repairs everything', /no per-scenario explorer cost observed, so all 1 are repaired/.test(none?.line ?? '') && none?.rework.length === 1 && none?.unfunded.length === 0, none?.line);
}

/* ─── I. the 5e4394 shape: 14 rework, $0.90 reserve, $0.32 per scenario ── */
// The reserve funds floor(0.90 / 0.32) = 2 of 14. The two are chosen highest
// value first: scenarios whose cited rules no kept scenario covers. The other
// twelve are named on the decision line and recorded as dropped "rework, not
// repaired: reserve funds 2 of 14", so the funnel and coverage say why.
{
  const rw = (scenario: string) => ({ scenario, verdict: 'rework' as const, reasons: ['weak'], required_fixes: ['fix'] });
  const rules: Record<string, string[]> = {
    'viewed hand-tools': ['R1', 'R5'], 'sorted hand-tools': ['R4'], 'toggled eco hand-tools': ['R3'], 'loaded power-tools': ['R1'],
    'sorted power-tools': ['R4'], 'filtered eco power-tools': ['R3'], 'clicked a product power-tools': ['R5'], 'browsed other': ['R1', 'R3'],
    'sorted other': ['R4'], 'clicked a product other': [], 'submitted the contact form': [], 'rejected an email without @': ['R14'],
    'listed rental products': ['R1'], 'logged in with valid credentials': [], 'rejected an empty message': ['R13'],
  };
  const names = Object.keys(rules);
  const scenarios = names.map((name) => ({ name }));
  const verdicts = [...names.filter((n) => n !== 'rejected an empty message').map(rw), { scenario: 'rejected an empty message', verdict: 'pass' as const, reasons: [], required_fixes: [] }];
  const d = decideRepairPass({ scenarios, verdicts, reserveUsd: 0.9, explorerUsd: 0.32 * 16, recorded: 16, ruleIdsFor: (n) => rules[n] ?? [] });
  check('I1. 14 rework at $0.32 against a $0.90 reserve: 2 funded, 12 unfunded, the label says so', d?.run === true && d.rework.length === 2 && d.unfunded.length === 12 && d.fundsLabel === 'reserve funds 2 of 14', JSON.stringify({ funded: d?.rework.map((s) => s.name), label: d?.fundsLabel }));
  const funded = d?.rework.map((s) => s.name) ?? [];
  check('I2. the funded two cover otherwise-uncovered rules: the first covers two (R1, R5), the second the next uncovered rule (R4)', funded[0] === 'viewed hand-tools' && funded[1] === 'sorted hand-tools', JSON.stringify(funded));
  check('I3. R13 (covered by the kept scenario) adds no value; a scenario citing no rule is never funded ahead of one that covers a rule', !funded.includes('clicked a product other') && !funded.includes('logged in with valid credentials'));
  check('I4. the decision line names every funded and every unfunded scenario with the cause',
    (d?.line ?? '').startsWith('repair pass: 2 of 14 rework scenario(s), budget $0.90 (the stated reserve); explorer cost this run $0.3200 per recorded scenario, so the reserve funds 2 of 14; repairing: "viewed hand-tools", "sorted hand-tools"; not repaired (reserve funds 2 of 14): ') && d!.unfunded.every((s) => d!.line.includes(`"${s.name}"`)), d?.line);
  console.log('   ' + d?.line);
  // The unfunded twelve drop with the cause on the history and in the funnel.
  const merged = mergeRepairVerdicts(verdicts, [{ scenario: 'viewed hand-tools', verdict: 'pass', reasons: [], required_fixes: [] }], { names: d!.unfunded.map((s) => s.name), reason: d!.fundsLabel });
  check('I5. the funded and re-recorded scenario is kept; the funded one the pass never re-recorded drops with no cause; every unfunded one carries notRepaired',
    merged.history.find((h) => h.scenario === 'viewed hand-tools')?.outcome === 'kept' && merged.history.find((h) => h.scenario === 'sorted hand-tools')?.notRepaired === undefined && merged.history.filter((h) => h.notRepaired === 'reserve funds 2 of 14').length === 12, JSON.stringify(merged.history));
  const report = {
    scenarios: [{ name: 'rejected an empty message', ruleIds: ['R13'] }, { name: 'viewed hand-tools', ruleIds: ['R1', 'R5'] }],
    plan: names.map((n) => ({ name: n, category: 'happy', rationale: 'r', ruleIds: rules[n] })),
    review: { verdicts: merged.final, summary: '', repair: merged.history },
  } as unknown as RunReport;
  const rec = reconcile(report);
  const unfundedDrop = rec.dropped.find((x) => x.name === 'sorted power-tools');
  check('I6. reconciliation names the cause on every unfunded drop: "rework, not repaired: reserve funds 2 of 14"', rec.dropped.filter((x) => x.reason.startsWith('rework, not repaired: reserve funds 2 of 14')).length === 12 && unfundedDrop?.reason.startsWith('rework, not repaired: reserve funds 2 of 14: weak') === true, JSON.stringify(unfundedDrop));
  check('I7. the funnel balances: planned 15 = generated 2 + dropped 13', rec.balanced && rec.planned === 15 && rec.generated === 2 && rec.dropped.length === 13, JSON.stringify({ planned: rec.planned, generated: rec.generated, dropped: rec.dropped.length }));
  const coverage = computeRuleCoverage({
    map: { features: [{ name: 'catalogue', description: '', rules: [{ id: 'R1', text: 'lists', type: 'behavior' }, { id: 'R4', text: 'sorts', type: 'behavior' }, { id: 'R3', text: 'filters', type: 'behavior' }] }], roles: [], truncated: false },
    planned: report.plan as never, scenarios: report.scenarios as never,
    dropReasons: new Map(rec.dropped.map((x) => [x.name, x.reason])),
  });
  check('I8. rule coverage names the cause on a planned-but-dropped rule whose citing scenarios were not repaired, and R1 (kept by the repaired scenario) is covered', coverage.uncovered.find((u) => u.ruleId === 'R3')?.detail === 'rework, not repaired: reserve funds 2 of 14' && coverage.uncovered.find((u) => u.ruleId === 'R4')?.detail === 'critic rework | rework, not repaired: reserve funds 2 of 14' && coverage.covered.some((c) => c.ruleId === 'R1'), JSON.stringify(coverage));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: reject drops, rework earns exactly one repair pass, second-time rework/reject drops for real, and the funnel counts final verdicts.');
