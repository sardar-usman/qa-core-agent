/**
 * Locks the plan parser on the rule-citation bracket (src/agent/planner.ts).
 *
 * The rule-driven format adds an OPTIONAL third bracket after the category:
 *   "1. [login][negative][R3,R7] name — rationale"   → ruleIds ['R3','R7']
 *   "2. [login][edge][-] name — rationale"           → ruleIds [] (no matching rule)
 * Without a requirements map the Planner never emits the bracket, and the old
 * two-bracket and legacy formats must parse EXACTLY as before — same fields,
 * no ruleIds key at all. That is the no-SRS zero-behavior-change invariant.
 *
 * This drives the REAL exported parsePlan, not a mirror.
 */
import { parsePlan, PLANNER_SYSTEM, CREDENTIAL_STEERING, credentialSteeringFor, applyCitationChecks, lockoutScenarioNames, knownAccountIdentifiers } from '../src/agent/planner.js';
import { citationMismatchReason } from '../src/agent/rule-coverage.js';
import type { RequirementsMap } from '../src/agent/requirements.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. three-bracket format with rule ids ────────────────────────────────── */
const withRules = parsePlan('<plan>\n1. [login][negative][R3,R7] rejected a 5-character password — fails if the length rule stops being enforced\n</plan>');
check('A1. line parses', withRules.length === 1);
const a = withRules[0]!;
check('A2. feature parsed', a.feature === 'login');
check('A3. category parsed', a.category === 'negative');
check('A4. ruleIds parsed in order', JSON.stringify(a.ruleIds) === '["R3","R7"]', JSON.stringify(a.ruleIds));
check('A5. name is clean (no bracket residue)', a.name === 'rejected a 5-character password', a.name);
check('A6. rationale parsed', a.rationale.startsWith('fails if the length rule'));

/* ─── A2. three or more rule ids in one citation ───────────────────────────── */
// Phase 3 refinement: a scenario cites EVERY rule it verifies, so citations
// with 3+ ids are the normal case (an empty-username scenario verifies the
// required rule AND the error rule AND the general validation rule).
const multi = parsePlan('<plan>\n1. [login][negative][R1,R2,R5] rejected an empty username with the inline error — fails if the required rule or the error message stops being enforced\n</plan>');
check('A7. a three-id citation parses in order', JSON.stringify(multi[0]?.ruleIds) === '["R1","R2","R5"]', JSON.stringify(multi[0]?.ruleIds));
check('A8. name stays clean after a multi-id bracket', multi[0]?.name === 'rejected an empty username with the inline error', multi[0]?.name);
const five = parsePlan('1. [checkout][negative][R1,R2,R5,R9,R12] rejected the order — fails if any of the five checks stops firing');
check('A9. five ids parse and normalize', JSON.stringify(five[0]?.ruleIds) === '["R1","R2","R5","R9","R12"]', JSON.stringify(five[0]?.ruleIds));

/* ─── B. lowercase / spaced ids normalize ──────────────────────────────────── */
const spaced = parsePlan('1. [cart][happy][r2, r10] added an item and the badge went up — fails if add-to-cart stops writing state');
check('B1. lowercase + spaced ids normalize to R2,R10', JSON.stringify(spaced[0]?.ruleIds) === '["R2","R10"]', JSON.stringify(spaced[0]?.ruleIds));

/* ─── C. [-] means planned with a map but no matching rule ─────────────────── */
const dash = parsePlan('2. [login][edge][-] password field masks input — fails if the field renders the password as plain text');
check('C1. [-] parses', dash.length === 1);
check('C2. [-] yields an EMPTY ruleIds array (present, not absent)', Array.isArray(dash[0]?.ruleIds) && dash[0]!.ruleIds!.length === 0, JSON.stringify(dash[0]));
check('C3. name is clean after [-]', dash[0]!.name === 'password field masks input', dash[0]!.name);

/* ─── D. the old two-bracket format parses unchanged: no ruleIds key at all ── */
const OLD_LINE = '1. [login][happy] logged in with valid credentials — fails if the success path stops landing on the inventory page';
const old = parsePlan(OLD_LINE);
check('D1. two-bracket line parses', old.length === 1);
const d = old[0]!;
check('D2. fields identical to the pre-SRS parse', d.feature === 'login' && d.category === 'happy' && d.name === 'logged in with valid credentials' && d.rationale.startsWith('fails if the success path'));
check('D3. ruleIds key is ABSENT (not empty, not undefined-assigned)', !('ruleIds' in d), JSON.stringify(d));

/* ─── E. legacy no-feature variants still parse, also without ruleIds ──────── */
const legacyVariants = [
  '1. [happy] logged in — fails if login breaks',
  '2. happy logged in — fails if login breaks',
  '3. happy — logged in — fails if login breaks',
  '4. happy: logged in — fails if login breaks',
];
for (const [i, line] of legacyVariants.entries()) {
  const p = parsePlan(line);
  check(`E${i + 1}. legacy variant ${i + 1} parses without ruleIds`, p.length === 1 && p[0]!.category === 'happy' && !('ruleIds' in p[0]!), line);
}

/* ─── F. a mixed plan block parses every format side by side ───────────────── */
const mixed = parsePlan(`<plan>
1. [login][negative][R3] rejected a wrong password — fails if a wrong password is accepted
2. [login][edge][-] password field masks input — fails if the password renders as plain text
3. [cart][happy] added item to cart — fails if the badge stops updating
</plan>`);
check('F1. all three lines parse', mixed.length === 3);
check('F2. rule-cited line has its ids', JSON.stringify(mixed[0]?.ruleIds) === '["R3"]');
check('F3. [-] line has empty ids', Array.isArray(mixed[1]?.ruleIds) && mixed[1]!.ruleIds!.length === 0);
check('F4. two-bracket line has no ruleIds key', !('ruleIds' in mixed[2]!));

/* ─── G. malformed rule brackets do not break the line ─────────────────────── */
const junk = parsePlan('1. [login][negative][R3;R7] rejected a wrong password — fails if a wrong password is accepted');
check('G1. an unparseable rule bracket falls through without crashing', junk.length === 1, JSON.stringify(junk));

/* ─── H. lockout is state: wrong-credential negatives use a non-existent account ── */
check('H1. the Planner SYSTEM prompt carries the credential steering verbatim', PLANNER_SYSTEM.includes(CREDENTIAL_STEERING));
check('H2. the steering says non-existent credentials, never a real account with a wrong password, and why (lockout, re-runs)',
  /credentials that do not exist/.test(CREDENTIAL_STEERING) && /never a real account with a wrong password/.test(CREDENTIAL_STEERING) && /lock an account after a few failed attempts/.test(CREDENTIAL_STEERING) && /re-run at least four more times/.test(CREDENTIAL_STEERING));
check('H3. the steering names the exception: a rule that names a locked account keeps the real account', /whose point IS the lockout/.test(CREDENTIAL_STEERING) && /keeps the real account/.test(CREDENTIAL_STEERING));
const lockMap: RequirementsMap = { features: [{ name: 'login', description: 'sign in', rules: [
  { id: 'R2', text: 'A wrong password shows the error and the user stays on the login page.', type: 'behavior' },
  { id: 'R4', text: 'The locked_out_user account is refused with an error stating the user has been locked out.', type: 'behavior' },
  { id: 'R5', text: 'A blocked IP sees a captcha.', type: 'behavior' },
] }], roles: [], truncated: false };
const withLock = credentialSteeringFor(lockMap);
check('H4. a lockout rule is named as keeping the real account; the wrong-password rule and a "blocked" rule are not',
  /Lockout rules on this page: R4\./.test(withLock) && !/R2/.test(withLock) && !/R5/.test(withLock) && /keeps the real account/.test(withLock), withLock);
const noLock = credentialSteeringFor({ features: [{ name: 'login', description: 'sign in', rules: [{ id: 'R2', text: 'A wrong password shows the error.', type: 'behavior' }] }], roles: [], truncated: false });
check('H5. with no lockout rule the block says so and every negative uses a non-existent account', /No stated rule names a locked account/.test(noLock) && noLock.includes(CREDENTIAL_STEERING));
check('H6. without a map the block still carries the steering', credentialSteeringFor(undefined).includes(CREDENTIAL_STEERING));

/* ─── I. rule citations must fit the scenario category (the ec8eff shape) ──── */
const ec8effMap: RequirementsMap = { features: [
  { name: 'catalogue', description: 'browse', rules: [{ id: 'R1', text: 'The home page lists products with a name, an image and a price.', type: 'behavior' }] },
  { name: 'login', description: 'sign in', rules: [{ id: 'R10', text: 'Login with a wrong password shows an error and the user stays on the login page.', type: 'behavior' }] },
], roles: [], truncated: false };
const ec8effPlan = parsePlan([
  '<plan>',
  '1. [login][happy][R10] logged in with valid email and password — fails if successful login stops navigating away',
  '2. [login][negative][R10] rejected login with wrong password and error message appeared — fails if an incorrect password is accepted',
  '3. [login][edge][R10] attempted login with empty password field — fails if the required-field validation stops',
  '4. [catalogue][negative][R1] typed a non-matching search term and the list became empty — fails if the search stops narrowing',
  '</plan>',
].join('\n'));
const cited = applyCitationChecks(ec8effPlan, ec8effMap);
const byName = new Map(cited.scenarios.map((s) => [s.name, s]));
check('I1. the happy login loses its R10 citation (R10 states a rejection)', JSON.stringify(byName.get('logged in with valid email and password')?.ruleIds) === '[]', JSON.stringify(byName.get('logged in with valid email and password')));
check('I2. the negative wrong-password scenario keeps R10', JSON.stringify(byName.get('rejected login with wrong password and error message appeared')?.ruleIds) === '["R10"]');
check('I3. the edge scenario is not judged and keeps its citation', JSON.stringify(byName.get('attempted login with empty password field')?.ruleIds) === '["R10"]');
check('I4. a negative citing a rule that states no rejection (R1 lists products) loses it', JSON.stringify(byName.get('typed a non-matching search term and the list became empty')?.ruleIds) === '[]');
check('I5. every drop is reported with the scenario, the id and the reason', cited.citationDrops.length === 2 && cited.citationDrops.some((d) => d.ruleId === 'R10' && d.scenario === 'logged in with valid email and password' && /happy scenario cannot verify a rule that states a rejection/.test(d.reason)) && cited.citationDrops.some((d) => d.ruleId === 'R1' && /negative scenario cannot verify a rule that states no rejection/.test(d.reason)), JSON.stringify(cited.citationDrops));
check('I6. the scenarios themselves survive (only the citation goes)', cited.scenarios.length === 4);
check('I7. without a map nothing is checked or changed', applyCitationChecks(ec8effPlan, undefined).scenarios === ec8effPlan && applyCitationChecks(ec8effPlan, undefined).citationDrops.length === 0);
check('I8. citationMismatchReason covers the rejection words and leaves plausible citations alone', citationMismatchReason('happy', 'Registration with an already used email address is rejected with an error.') !== null && citationMismatchReason('happy', 'Sorting by price low to high orders the visible products by ascending price.') === null && citationMismatchReason('negative', 'Submitting the form with an empty required field shows a required-field message.') === null && citationMismatchReason('negative', 'The cart page lists each added product with quantity and line total.') !== null && citationMismatchReason('happy', 'The locked_out_user account is refused with a locked-out error.') !== null);

/* ─── J. the tool-level credential rule knows the real accounts and the lockout exception ── */
{
  const map: RequirementsMap = { features: [{ name: 'login', description: 'sign in as standard_user / secret_sauce', rules: [
    { id: 'R1', text: 'A user with valid credentials (standard_user / secret_sauce) is taken to the inventory page.', type: 'behavior' },
    { id: 'R2', text: 'A wrong password shows the error and the user stays on the login page.', type: 'behavior' },
    { id: 'R4', text: 'The locked_out_user account is refused with an error stating the user has been locked out.', type: 'behavior' },
    { id: 'R5', text: 'Support is reached at help@shop.example.', type: 'behavior' },
  ] }], roles: ['standard user'], truncated: false };
  const plan = parsePlan('<plan>\n1. [login][happy][R1] logged in with valid credentials — fails if login stops\n2. [login][negative][R2] rejected a wrong password — fails if a wrong password is accepted\n3. [login][negative][R4] rejected the locked_out_user account — fails if the lockout stops\n</plan>');
  check('J1. the scenario citing the lockout rule is the one exempt from the credential rewrite', JSON.stringify(lockoutScenarioNames(plan, map)) === JSON.stringify(['rejected the locked_out_user account']), JSON.stringify(lockoutScenarioNames(plan, map)));
  check('J2. without a map nothing is exempt', lockoutScenarioNames(plan, undefined).length === 0);
  const ids = knownAccountIdentifiers(map);
  check('J3. the SRS-named accounts are known: snake_case account names and e-mail addresses, lowercased and deduped', ids.includes('standard_user') && ids.includes('locked_out_user') && ids.includes('help@shop.example') && ids.filter((x) => x === 'standard_user').length === 1, JSON.stringify(ids));
  check('J4. plain words are not identifiers', !ids.includes('user') && !ids.includes('login'));
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the rule-citation bracket parses ids and [-], and the pre-SRS formats parse byte-identically with no ruleIds key.');
