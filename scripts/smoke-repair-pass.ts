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
  check('H2. the line states the reserve and the observed per-scenario explorer cost against it', d?.line === 'repair pass: 2 scenario(s), budget $0.30 (the stated reserve); explorer cost this run $0.1000 per recorded scenario, so the reserve funds about 2 of 2', d?.line);
  const thin = decideRepairPass({ scenarios: [{ name: 'alpha' }, { name: 'beta' }], verdicts: [rw('alpha'), rw('beta')], reserveUsd: 0.3, explorerUsd: 2.0, recorded: 2 });
  check('H3. a reserve smaller than one scenario says it funds 0 of N, so the reader sees the shortfall', /funds about 0 of 2/.test(thin?.line ?? ''), thin?.line);
  const none = decideRepairPass({ scenarios: [{ name: 'alpha' }], verdicts: [rw('alpha')], reserveUsd: 0.3, explorerUsd: 0, recorded: 0 });
  check('H4. with nothing recorded the line says no per-scenario cost was observed', /no per-scenario explorer cost observed/.test(none?.line ?? ''), none?.line);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: reject drops, rework earns exactly one repair pass, second-time rework/reject drops for real, and the funnel counts final verdicts.');
