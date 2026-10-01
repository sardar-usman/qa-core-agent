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
 *   - the repair review judges the first verdict's REQUIRED FIXES: every
 *     listed fix applied keeps the scenario whatever else the second review
 *     observed (the observations are notes on the report), one fix not
 *     applied drops it; the per-fix shape parses with the same leniency as
 *     every verdict (run 51d535 dropped three repaired scenarios on
 *     complaints the first verdict never made); a verdict with no per-fix
 *     judgement after the retry keeps the scenario unjudged with a note, a
 *     partial omission drops it naming the fix
 *
 * Fixture verdicts only. No live calls. No browser.
 */
import { decideRepairPass, splitGate, mergeRepairVerdicts, repairDoneEvent, repairScenarioEvents, verdictMatchesScenario, verdictFor, parseVerdicts, judgeRequiredFixes, critique, REPAIR_REVIEW_PROMPT, UNJUDGED_REPAIR_NOTE, type ScenarioVerdict, type CriticClient } from '../src/agent/critic.js';
import type { Scenario } from '../src/agent/trace.js';
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
  check('H1. with no ceiling given the budget offered is the reserve itself', d?.run === true && Math.abs(d.budgetUsd - 0.3) < 1e-9, JSON.stringify(d));
  check('H2. the line states the remaining and the reserve, the observed per-scenario explorer cost and the repair estimate, and names what is repaired', d?.line === 'repair pass: 2 of 2 rework scenario(s), budget $0.30 (ceiling minus spend $0.30 remaining, reserve $0.30 the floor); explorer cost this run $0.1000 per recorded scenario, a repair estimated at $0.0500 (half, scaled by step count), so the budget funds 2 of 2 cheapest first; repairing: "alpha", "beta"', d?.line);
  const thin = decideRepairPass({ scenarios: [{ name: 'alpha' }, { name: 'beta' }], verdicts: [rw('alpha'), rw('beta')], reserveUsd: 0.3, explorerUsd: 2.0, recorded: 2 });
  check('H3. a budget smaller than one repair still funds one (the minimum) and names the other as not repaired', thin?.rework.length === 1 && thin?.unfunded.length === 1 && /budget funds 1 of 2/.test(thin?.line ?? '') && /not repaired \(budget funds 1 of 2\): "beta"/.test(thin?.line ?? ''), thin?.line);
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
  // The 5e4394 shape with the reserve as the whole budget (no ceiling given):
  // $0.90 at $0.32 per explored scenario, a repair estimated at $0.16, funds 5
  // of 14 cheapest first; with equal step counts the tiebreaker is the rules
  // no kept scenario covers, so the rule-covering ones go first.
  const d = decideRepairPass({ scenarios, verdicts, reserveUsd: 0.9, explorerUsd: 0.32 * 16, recorded: 16, ruleIdsFor: (n) => rules[n] ?? [] });
  check('I1. 14 rework at $0.32 against a $0.90 budget: 5 funded (5 x $0.16 = $0.80), 9 unfunded, the label says so', d?.run === true && d.rework.length === 5 && d.unfunded.length === 9 && d.fundsLabel === 'budget funds 5 of 14', JSON.stringify({ funded: d?.rework.map((s) => s.name), label: d?.fundsLabel }));
  const funded = d?.rework.map((s) => s.name) ?? [];
  check('I2. among equally cheap repairs the rule-covering ones go first: the first covers two (R1, R5), the second the next uncovered rule (R4)', funded[0] === 'viewed hand-tools' && funded[1] === 'sorted hand-tools', JSON.stringify(funded));
  check('I3. R13 (covered by the kept scenario) adds no value; a scenario citing no rule is never funded ahead of one that covers a rule', funded.indexOf('clicked a product other') === -1 || funded.indexOf('clicked a product other') > funded.indexOf('toggled eco hand-tools'));
  check('I4. the decision line names every funded and every unfunded scenario with the cause',
    (d?.line ?? '').startsWith('repair pass: 5 of 14 rework scenario(s), budget $0.90 (ceiling minus spend $0.90 remaining, reserve $0.90 the floor); explorer cost this run $0.3200 per recorded scenario, a repair estimated at $0.1600 (half, scaled by step count), so the budget funds 5 of 14 cheapest first; repairing: "viewed hand-tools", "sorted hand-tools"') && /; not repaired \(budget funds 5 of 14\): /.test(d?.line ?? '') && d!.unfunded.every((s) => d!.line.includes(`"${s.name}"`)), d?.line);
  console.log('   ' + d?.line);
  // The unfunded twelve drop with the cause on the history and in the funnel.
  const merged = mergeRepairVerdicts(verdicts, [{ scenario: 'viewed hand-tools', verdict: 'pass', reasons: [], required_fixes: [] }], { names: d!.unfunded.map((s) => s.name), reason: d!.fundsLabel });
  check('I5. the funded and re-recorded scenario is kept; the funded one the pass never re-recorded drops with no cause; every unfunded one carries notRepaired',
    merged.history.find((h) => h.scenario === 'viewed hand-tools')?.outcome === 'kept' && merged.history.find((h) => h.scenario === 'sorted hand-tools')?.notRepaired === undefined && merged.history.filter((h) => h.notRepaired === 'budget funds 5 of 14').length === 9, JSON.stringify(merged.history));
  const report = {
    scenarios: [{ name: 'rejected an empty message', ruleIds: ['R13'] }, { name: 'viewed hand-tools', ruleIds: ['R1', 'R5'] }],
    plan: names.map((n) => ({ name: n, category: 'happy', rationale: 'r', ruleIds: rules[n] })),
    review: { verdicts: merged.final, summary: '', repair: merged.history },
  } as unknown as RunReport;
  const rec = reconcile(report);
  const unfundedDrop = rec.dropped.find((x) => x.name === d!.unfunded[0]!.name);
  check('I6. reconciliation names the cause on every unfunded drop: "rework, not repaired: budget funds 5 of 14"', rec.dropped.filter((x) => x.reason.startsWith('rework, not repaired: budget funds 5 of 14')).length === 9 && unfundedDrop?.reason.startsWith('rework, not repaired: budget funds 5 of 14: weak') === true, JSON.stringify(unfundedDrop));
  check('I7. the funnel balances: planned 15 = generated 2 + dropped 13', rec.balanced && rec.planned === 15 && rec.generated === 2 && rec.dropped.length === 13, JSON.stringify({ planned: rec.planned, generated: rec.generated, dropped: rec.dropped.length }));
  const coverage = computeRuleCoverage({
    map: { features: [{ name: 'catalogue', description: '', rules: [{ id: 'R1', text: 'lists', type: 'behavior' }, { id: 'R4', text: 'sorts', type: 'behavior' }, { id: 'R3', text: 'filters', type: 'behavior' }] }], roles: [], truncated: false },
    planned: report.plan as never, scenarios: report.scenarios as never,
    dropReasons: new Map(rec.dropped.map((x) => [x.name, x.reason])),
  });
  check('I8. rule coverage names the cause on a planned-but-dropped rule whose citing scenarios were not repaired, and R1 (kept by the repaired scenario) is covered', /not repaired: budget funds 5 of 14|critic rework/.test(coverage.uncovered.find((u) => u.ruleId === 'R3')?.detail ?? '') && /critic rework/.test(coverage.uncovered.find((u) => u.ruleId === 'R4')?.detail ?? '') && coverage.covered.some((c) => c.ruleId === 'R1'), JSON.stringify(coverage));
}

/* ─── J. the repair review judges the first verdict's required fixes ──────── */
{
  const first: ScenarioVerdict[] = [
    { scenario: 'clicked a product and landed on its detail page', verdict: 'rework', reasons: ['no capture before the click', 'URL assert has no timeout'], required_fixes: ['Capture the product name from the listing before clicking, then assert_compare it equals the detail heading', 'Add timeout:10000ms to the URL assertion'] },
    { scenario: 'rejected an email without an @ sign', verdict: 'rework', reasons: ['vacuous visibility assertion'], required_fixes: ['Replace the submit-button visibility assertion with a count=0 of the thank-you message'] },
    { scenario: 'added a product from its detail page', verdict: 'rework', reasons: ['count captured instead of text'], required_fixes: ['Capture the badge TEXT, not the element count', 'assert_compare greater on the badge text'] },
  ];
  // The second review: scenario 1 applied both fixes but the Critic voted
  // rework on a NEW complaint (the run 5 shape); scenario 2 applied its fix
  // and passed with an observation; scenario 3 left one fix unapplied.
  const second: ScenarioVerdict[] = [
    { scenario: '[happy] clicked a product and landed on its detail page', verdict: 'rework', reasons: ['The compare re-reads the listing locator after navigation, which may resolve to nothing'], required_fixes: ['Remove the listing re-read'],
      fixes: [{ fix: 'Capture the product name from the listing before clicking, then assert_compare it equals the detail heading', applied: true, reason: 'step 2 captures, step 6 compares equal at [data-test="product-name"]' }, { fix: 'Add timeout:10000ms to the URL assertion', applied: true, reason: 'step 4 carries [timeout:10000ms]' }],
      observations: ['The compare re-reads the listing locator after navigation, which may resolve to nothing'] },
    { scenario: 'rejected an email without an @ sign', verdict: 'pass', reasons: ['count=0 of the thank-you message is falsifiable'], required_fixes: [],
      fixes: [{ fix: 'Replace the submit-button visibility assertion with a count=0 of the thank-you message', applied: true, reason: 'step 5 asserts count=0 [timeout:5000ms]' }],
      observations: ['Many browsers block an invalid email natively, so the body regex may never match'] },
    { scenario: 'added a product from its detail page', verdict: 'rework', reasons: ['still a count'], required_fixes: ['capture text'],
      fixes: [{ fix: 'Capture the badge TEXT, not the element count', applied: false, reason: 'step 3 still captures count of [data-test="cart-quantity"]' }, { fix: 'assert_compare greater on the badge text', applied: true, reason: 'step 6 compares greater' }],
      observations: [] },
  ];
  const m = mergeRepairVerdicts(first, second);
  const clicked = m.history.find((h) => h.scenario === first[0]!.scenario);
  check('J1. every listed fix applied plus a new complaint = KEPT, final verdict pass, the complaint recorded as a note', clicked?.outcome === 'kept' && clicked.second === 'rework' && m.final.find((v) => v.scenario === first[0]!.scenario || verdictMatchesScenario(v.scenario, first[0]!.scenario))?.verdict === 'pass' && clicked.notes?.length === 1 && /re-reads the listing locator/.test(clicked.notes[0] ?? ''), JSON.stringify(clicked));
  check('J2. the per-fix judgements travel on the history entry', clicked?.fixes?.length === 2 && clicked.fixes.every((f) => f.applied) && /step 4 carries/.test(clicked.fixes[1]?.reason ?? ''));
  const email = m.history.find((h) => h.scenario === first[1]!.scenario);
  check('J3. a pass with an observation is kept and the observation is a note (the run 5 "browsers block invalid email" complaint)', email?.outcome === 'kept' && email.notes?.length === 1 && /block an invalid email natively/.test(email.notes[0] ?? ''));
  const added = m.history.find((h) => h.scenario === first[2]!.scenario);
  const addedFinal = m.final.find((v) => v.scenario === first[2]!.scenario);
  check('J4. one listed fix not applied = DROPPED, with the unapplied fix as the reason', added?.outcome === 'dropped' && added.second === 'rework' && addedFinal?.verdict === 'rework' && /required fix not applied: Capture the badge TEXT/.test(addedFinal?.reasons[0] ?? ''), JSON.stringify({ added, addedFinal }));
  check('J5. the verdict history carries kept 2 / dropped 1 into repair_done', repairDoneEvent(m.history, 0.5).kept === 2 && repairDoneEvent(m.history, 0.5).dropped === 1);

  // judgeRequiredFixes: by position when counts agree, by text when not, unjudged fixes count as not applied.
  const byText = judgeRequiredFixes(['Add timeout:10000ms to the URL assertion', 'Capture the name first'], [{ fix: 'capture the name first', applied: true, reason: 'step 2' }]);
  check('J6. a fix the second review did not judge counts as not applied; a judged one matches by text', byText.allApplied === false && byText.fixes[1]?.applied === true && byText.fixes[0]?.reason === 'not judged by the second review' && byText.missing.length === 1, JSON.stringify(byText));
  const noFixesListed: ScenarioVerdict = { scenario: 'kept login', verdict: 'rework', reasons: ['weak'], required_fixes: [] };
  check('J7. a first verdict that listed no fixes is read as before: pass keeps, rework drops', mergeRepairVerdicts([noFixesListed], [{ scenario: 'kept login', verdict: 'rework', reasons: ['x'], required_fixes: [] }]).history[0]?.outcome === 'dropped' && mergeRepairVerdicts([noFixesListed], [{ scenario: 'kept login', verdict: 'pass', reasons: [], required_fixes: [] }]).history[0]?.outcome === 'kept');

  /* ─── the three outcomes of a repair verdict's `fixes` ─────────────────── */
  // (a) fixes missing: a parse failure, not a judgement. One retry; still
  // missing = kept unjudged with the note and a warning line.
  const noFixesText = JSON.stringify([{ scenario: first[0]!.scenario, verdict: 'rework', reasons: ['re-reads the listing locator'], required_fixes: ['remove it'] }]) + '<summary>s</summary>';
  let calls = 0;
  const noFixesClient: CriticClient = { messages: { create: async () => { calls++; return { id: 'm', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: noFixesText, citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as never; } } };
  const clickedScenario = { name: first[0]!.scenario, category: 'happy', steps: [] } as unknown as Scenario;
  const unjudgedReview = await critique({ scenarios: [clickedScenario], url: 'https://x.example/', apiKey: 'fake', client: noFixesClient, repairFixes: new Map([[first[0]!.scenario, first[0]!.required_fixes]]) });
  check('J13a. fixes missing on the first response earns exactly one retry', calls === 2 && Array.isArray(unjudgedReview.raw) && unjudgedReview.raw.length === 2);
  check('J13b. still missing after the retry: the warning line says so and names the scenario', unjudgedReview.warnings.some((w) => w === `${UNJUDGED_REPAIR_NOTE}: "${first[0]!.scenario}"`) && unjudgedReview.warnings.some((w) => /retry returned none either/.test(w)), JSON.stringify(unjudgedReview.warnings));
  const unjudgedMerge = mergeRepairVerdicts(first.slice(0, 1), unjudgedReview.verdicts);
  check('J13c. the scenario is KEPT unjudged: final verdict pass, the note on review.repair[].notes', unjudgedMerge.history[0]?.outcome === 'kept' && unjudgedMerge.final[0]?.verdict === 'pass' && unjudgedMerge.history[0]?.notes?.[0] === UNJUDGED_REPAIR_NOTE && unjudgedMerge.history[0]?.notes?.[0] === 'repair verdict unparseable: fixes not returned; scenario kept unjudged', JSON.stringify(unjudgedMerge.history));
  check('J13d. an empty fixes array is the same parse failure', mergeRepairVerdicts(first.slice(0, 1), [{ scenario: first[0]!.scenario, verdict: 'rework', reasons: ['x'], required_fixes: [], fixes: [], observations: ['new'] }]).history[0]?.notes?.join('|') === `${UNJUDGED_REPAIR_NOTE}|new`);
  calls = 0;
  const fixedOnRetryText = JSON.stringify([{ scenario: first[0]!.scenario, verdict: 'pass', reasons: [], required_fixes: [], fixes: first[0]!.required_fixes.map((fix) => ({ fix, applied: true, reason: 'step' })), observations: [] }]) + '<summary>s</summary>';
  const retryClient: CriticClient = { messages: { create: async () => { calls++; return { id: 'm', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: calls === 1 ? noFixesText : fixedOnRetryText, citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as never; } } };
  const retried = await critique({ scenarios: [clickedScenario], url: 'https://x.example/', apiKey: 'fake', client: retryClient, repairFixes: new Map([[first[0]!.scenario, first[0]!.required_fixes]]) });
  check('J13e. a retry that returns the judgement is used, no unjudged warning', calls === 2 && retried.verdicts[0]?.fixes?.length === 2 && !retried.warnings.some((w) => w.startsWith(UNJUDGED_REPAIR_NOTE)) && retried.warnings.some((w) => /retry judged all but 0/.test(w)), JSON.stringify(retried.warnings));
  // (b) partial omission: the review judged the scenario and skipped one listed fix = that fix is not applied = dropped naming it.
  const partial = mergeRepairVerdicts(first.slice(0, 1), [{ scenario: first[0]!.scenario, verdict: 'pass', reasons: [], required_fixes: [], fixes: [{ fix: 'Add timeout:10000ms to the URL assertion', applied: true, reason: 'step 4' }], observations: [] }]);
  check('J14. a partial omission is DROPPED naming the fix the review listed nowhere', partial.history[0]?.outcome === 'dropped' && /required fix not applied: Capture the product name from the listing before clicking.*not judged by the second review/.test(partial.final[0]?.reasons[0] ?? '') && partial.history[0]?.fixes?.find((f) => f.fix.startsWith('Capture'))?.applied === false, JSON.stringify(partial));
  // (c) applied:false still drops (J4 above holds the full case).
  check('J15. a fix the review lists with applied:false drops, whatever its vote', mergeRepairVerdicts(first.slice(1, 2), [{ scenario: first[1]!.scenario, verdict: 'pass', reasons: [], required_fixes: [], fixes: [{ fix: first[1]!.required_fixes[0]!, applied: false, reason: 'the visibility assertion is still there' }] }]).history[0]?.outcome === 'dropped');

  // The per-fix shape parses with the same leniency as every verdict: a
  // trailing comma, a bad escape inside a reason, applied as a string.
  const lenient = parseVerdicts(`[
    { "scenario": "clicked a product", "verdict": "rework", "reasons": ["re-reads /a\\.card/"], "required_fixes": [],
      "fixes": [ { "fix": "Add timeout", "applied": "true", "reason": "step 4 [timeout:10000ms]", }, { "fix": "Capture first", "applied": false, "reason": "still missing" } ],
      "observations": ["one new thing", ""], },
  ]
  <summary>fine</summary>`);
  check('J8. the per-fix shape parses leniently: trailing commas, a bad escape, applied as a string, empty observations dropped', lenient.length === 1 && lenient[0]?.fixes?.length === 2 && lenient[0]?.fixes?.[0]?.applied === true && lenient[0]?.fixes?.[1]?.applied === false && JSON.stringify(lenient[0]?.observations) === '["one new thing"]', JSON.stringify(lenient));
  check('J9. a verdict without the fields carries neither key', !('fixes' in parseVerdicts('[{"scenario":"a","verdict":"pass","reasons":[],"required_fixes":[]}]')[0]!) && !('observations' in parseVerdicts('[{"scenario":"a","verdict":"pass","reasons":[],"required_fixes":[]}]')[0]!));

  // The repair review call: the first verdict's fixes are rendered per scenario and the REPAIR REVIEW block is the second system block.
  let captured: { system: unknown; content: string } | null = null;
  const client: CriticClient = { messages: { create: async (params) => {
    captured = { system: params.system, content: String((params.messages[0]?.content as string) ?? '') };
    return { id: 'm', type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: JSON.stringify([{ scenario: first[1]!.scenario, verdict: 'pass', reasons: [], required_fixes: [], fixes: [{ fix: first[1]!.required_fixes[0], applied: true, reason: 'step 5' }], observations: [] }]) + '<summary>s</summary>', citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as never;
  } } };
  const scenario = { name: first[1]!.scenario, category: 'negative', steps: [] } as unknown as Scenario;
  const reviewed = await critique({ scenarios: [scenario], url: 'https://x.example/', apiKey: 'fake', client, repairFixes: new Map([[first[1]!.scenario, first[1]!.required_fixes]]) });
  const sys = (captured as unknown as { system: Array<{ text: string }> } | null)?.system ?? [];
  check('J10. the repair review renders the first verdict\'s REQUIRED FIXES under the scenario and adds the REPAIR REVIEW system block after the cached prompt', /REQUIRED FIXES from the first review:\n        1\. Replace the submit-button visibility assertion/.test((captured as unknown as { content: string } | null)?.content ?? '') && sys.length === 2 && sys[1]?.text === REPAIR_REVIEW_PROMPT && /"fixes"/.test(REPAIR_REVIEW_PROMPT) && /never as the ground for a rework verdict/.test(REPAIR_REVIEW_PROMPT), JSON.stringify(captured).slice(0, 300));
  check('J11. the parsed repair verdict carries the per-fix judgement', reviewed.verdicts[0]?.fixes?.[0]?.applied === true);
  const plain = await critique({ scenarios: [scenario], url: 'https://x.example/', apiKey: 'fake', client });
  check('J12. a first-pass review renders no fixes block and one system block', plain.verdicts.length === 1 && !/REQUIRED FIXES/.test((captured as unknown as { content: string } | null)?.content ?? '') && ((captured as unknown as { system: unknown[] } | null)?.system ?? []).length === 1);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: reject drops, rework earns exactly one repair pass, the repair review judges the first verdict\'s required fixes (all applied keeps with notes, one unapplied drops), and the funnel counts final verdicts.');
