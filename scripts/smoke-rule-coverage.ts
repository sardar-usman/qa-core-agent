/**
 * Locks the rule-coverage classifier (src/agent/rule-coverage.ts):
 *   - covered            → a surviving scenario cites the rule
 *   - planned-but-dropped → a planned scenario cited the rule, none survived
 *   - not-planned        → no planned scenario cited the rule
 * plus the rendered "X of Y rules covered" summary and the named uncovered
 * list (the "considered, not automated" report), not-reachable, and
 * not-revealed (invariant 71: a feature whose state probe revealed no page;
 * only an uncited rule reads it, never a cited one).
 *
 * Pure in-code fixtures. No network. No LLM. No browser.
 */
import { attachRuleIds, computeRuleCoverage, renderRuleCoverage, notRevealedFeatures } from '../src/agent/rule-coverage.js';
import type { RequirementsMap } from '../src/agent/requirements.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const map: RequirementsMap = {
  features: [
    {
      name: 'login',
      description: 'Users sign in with email and password.',
      rules: [
        { id: 'R1', text: 'The password must be at least 8 characters.', type: 'validation' },
        { id: 'R2', text: 'After a successful login the user lands on the dashboard.', type: 'navigation' },
        { id: 'R3', text: 'Only admins may open the settings page.', type: 'permission' },
      ],
    },
    {
      name: 'cart',
      description: 'A shopper collects items before checkout.',
      rules: [
        { id: 'R4', text: 'Adding an item increments the cart badge.', type: 'behavior' },
      ],
    },
  ],
  roles: ['admin'],
  truncated: false,
};

// The plan cited R1 (two scenarios), R2 (one scenario), and R4. R3 was never
// planned. The R2 scenario and one R1 scenario did not survive the pipeline.
const planned = [
  { name: 'rejected a 5-character password', ruleIds: ['R1'] },
  { name: 'rejected a 7-character password on the edge', ruleIds: ['R1'] },
  { name: 'landed on the dashboard after login', ruleIds: ['R2'] },
  { name: 'added an item and the badge went up', ruleIds: ['R4'] },
  { name: 'password field masks input', ruleIds: [] },
];

// Final report: one R1 scenario survived, the R4 scenario survived, the R2
// scenario was dropped at replay, the [-] scenario survived citing nothing.
const scenarios = [
  { name: 'rejected a 5-character password', ruleIds: ['R1'] },
  { name: 'added an item and the badge went up', ruleIds: ['R4'] },
  { name: 'password field masks input' },
];

const coverage = computeRuleCoverage({ map, planned, scenarios });

/* ─── A. covered ───────────────────────────────────────────────────────────── */
const coveredIds = coverage.covered.map((c) => c.ruleId).sort();
check('A1. R1 and R4 are covered', JSON.stringify(coveredIds) === '["R1","R4"]', JSON.stringify(coverage.covered));
const r1 = coverage.covered.find((c) => c.ruleId === 'R1');
check('A2. a covered rule names its surviving scenario(s)', r1 !== undefined && JSON.stringify(r1.scenarios) === '["rejected a 5-character password"]', JSON.stringify(r1));

/* ─── B. planned-but-dropped ───────────────────────────────────────────────── */
const r2 = coverage.uncovered.find((u) => u.ruleId === 'R2');
check('B1. R2 is uncovered', r2 !== undefined);
check('B2. R2 is classified planned-but-dropped', r2?.reason === 'planned-but-dropped', JSON.stringify(r2));
check('B3. the uncovered entry carries the rule text', r2?.text.includes('dashboard') === true);

/* ─── C. not-planned ───────────────────────────────────────────────────────── */
const r3 = coverage.uncovered.find((u) => u.ruleId === 'R3');
check('C1. R3 is uncovered', r3 !== undefined);
check('C2. R3 is classified not-planned', r3?.reason === 'not-planned', JSON.stringify(r3));

/* ─── D. totals + rendered summary ─────────────────────────────────────────── */
check('D1. covered + uncovered account for every rule', coverage.covered.length + coverage.uncovered.length === 4);
const lines = renderRuleCoverage(coverage);
check('D2. summary line reads "2 of 4 rules covered"', lines[0] === 'Rule coverage: 2 of 4 rules covered', lines[0]);
check('D3. the uncovered list names both rules with reasons',
  lines.some((l) => l.includes('R2') && l.includes('planned-but-dropped')) && lines.some((l) => l.includes('R3') && l.includes('not-planned')),
  JSON.stringify(lines));

/* ─── E. full coverage renders with no uncovered section ───────────────────── */
const full = computeRuleCoverage({
  map,
  planned,
  scenarios: [
    { name: 's1', ruleIds: ['R1'] },
    { name: 's2', ruleIds: ['R2'] },
    { name: 's3', ruleIds: ['R3'] },
    { name: 's4', ruleIds: ['R4'] },
  ],
});
check('E1. all four covered', full.covered.length === 4 && full.uncovered.length === 0);
check('E2. rendered summary is a single line when nothing is uncovered', renderRuleCoverage(full).length === 1);

/* ─── F. attachRuleIds tolerates a renamed scenario ────────────────────────── */
// The Explorer rephrased the planned names: casing, punctuation, and the
// articles the/a/an differ, and one name grew a trailing clause. The rule
// citations must still land.
const renamed: { name: string; ruleIds?: string[] } = { name: 'Rejected 5-character password.' };
const grown: { name: string; ruleIds?: string[] } = { name: 'landed on the dashboard after login and saw the greeting' };
const unplanned: { name: string; ruleIds?: string[] } = { name: 'checkout applies the discount code' };
const ruleless: { name: string; ruleIds?: string[] } = { name: 'password field masks input' };
attachRuleIds([renamed, grown, unplanned, ruleless], planned);
check('F1. renamed scenario (article and punctuation drift) still gets its rule ids',
  JSON.stringify(renamed.ruleIds) === '["R1"]', JSON.stringify(renamed));
check('F2. a name that grew a trailing clause matches by containment',
  JSON.stringify(grown.ruleIds) === '["R2"]', JSON.stringify(grown));
check('F3. a scenario with no plan entry stays untouched', unplanned.ruleIds === undefined, JSON.stringify(unplanned));
check('F4. a plan entry that cited no rules attaches nothing', ruleless.ruleIds === undefined, JSON.stringify(ruleless));

/* ─── G. not-reachable: a feature no discovered page carries ───────────────── */
// Run 591732: cart had 4 rules and no page the crawl could reach, and the
// coverage report said only "not-planned". With the unreachable feature
// named, its uncited rules say why.
const unreachable = computeRuleCoverage({
  map,
  planned: [{ name: 'rejected a 5-character password', ruleIds: ['R1'] }],
  scenarios: [],
  unreachableFeatures: ['cart'],
});
const g4 = unreachable.uncovered.find((u) => u.ruleId === 'R4');
const g3 = unreachable.uncovered.find((u) => u.ruleId === 'R3');
check('G1. a rule of an unreachable feature that nothing cited is not-reachable', g4?.reason === 'not-reachable', JSON.stringify(g4));
check('G2. it carries the detail saying why', g4?.detail === 'no discovered page carries this feature', JSON.stringify(g4));
check('G3. an uncited rule of a reachable feature stays not-planned', g3?.reason === 'not-planned', JSON.stringify(g3));
check('G4. a cited rule of an unreachable feature is never not-reachable (it was planned)',
  unreachable.uncovered.find((u) => u.ruleId === 'R1')?.reason === 'planned-but-dropped');
const gLines = renderRuleCoverage(unreachable);
check('G5. the rendered line reads not-reachable with the detail',
  gLines.some((l) => l.includes('R4 (not-reachable: no discovered page carries this feature)')), JSON.stringify(gLines));
check('G6. without the unreachable list the same rule is plain not-planned',
  computeRuleCoverage({ map, planned: [], scenarios: [] }).uncovered.find((u) => u.ruleId === 'R4')?.reason === 'not-planned');

/* ─── H. not-revealed: the feature's state probe revealed no page ──────────── */
// Invariant 71: the probe only adds. A cited rule of a probed feature is
// classified exactly as without the probe; only an uncited one reads
// not-revealed, with the probe's detail naming every page tried.
const probeDetail = 'no page revealed: tried /, /category/hand-tools, /product/01M3XXXXXXXXXXXXXXXXXXXXXX';
const probes = [
  { feature: 'cart', outcome: 'no-new-link', detail: probeDetail },
  { feature: 'login', outcome: 'revealed', detail: 'revealed /account from /' },
];
check('H0. notRevealedFeatures keeps only the probes that revealed nothing', JSON.stringify(notRevealedFeatures(probes)) === JSON.stringify({ cart: probeDetail }) && JSON.stringify(notRevealedFeatures(undefined)) === '{}');
const cartMap: RequirementsMap = {
  ...map,
  features: [...map.features.filter((f) => f.name !== 'cart'), { name: 'cart', description: 'cart', rules: [
    { id: 'R4', text: 'Adding an item increments the cart badge.', type: 'behavior' },
    { id: 'R5', text: 'Changing a quantity on the cart page updates the line total.', type: 'behavior' },
  ] }],
};
const nr = computeRuleCoverage({
  map: cartMap,
  planned: [{ name: 'added an item and the badge went up', ruleIds: ['R4'] }],
  scenarios: [],
  notRevealed: notRevealedFeatures(probes),
  unreachableFeatures: ['cart'],
});
const h5 = nr.uncovered.find((u) => u.ruleId === 'R5');
check('H1. an uncited rule of a feature the probe did not reveal reads not-revealed (over not-reachable)', h5?.reason === 'not-revealed', JSON.stringify(h5));
check('H2. it carries the probe detail, every page tried', h5?.detail === probeDetail, JSON.stringify(h5));
check('H3. a cited rule of the same feature is never not-revealed (planned, so planned-but-dropped here)', nr.uncovered.find((u) => u.ruleId === 'R4')?.reason === 'planned-but-dropped', JSON.stringify(nr.uncovered));
check('H4. a covered rule of the same feature stays covered',
  computeRuleCoverage({ map: cartMap, planned: [{ name: 'a', ruleIds: ['R4'] }], scenarios: [{ name: 'a', ruleIds: ['R4'] }], notRevealed: notRevealedFeatures(probes) }).covered.some((c) => c.ruleId === 'R4'));
check('H5. an uncited rule of another feature is untouched (R3 not-planned)', nr.uncovered.find((u) => u.ruleId === 'R3')?.reason === 'not-planned');
check('H6. the rendered line reads not-revealed with the detail',
  renderRuleCoverage(nr).some((l) => l.includes(`R5 (not-revealed: ${probeDetail})`)), JSON.stringify(renderRuleCoverage(nr)));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: rule coverage classifies covered, planned-but-dropped, not-planned, not-reachable and not-revealed correctly and renders the considered-not-automated report.');
