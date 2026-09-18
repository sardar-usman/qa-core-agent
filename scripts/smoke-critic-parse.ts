/**
 * Locks the Critic verdict parse (src/agent/critic.ts):
 *   - the verdict array is extracted with a bracket-depth scan, so the nested
 *     reasons/required_fixes arrays inside each verdict object no longer
 *     truncate the match at the first "]" (the bug that made every run report
 *     0 verdicts while the summary paragraph parsed fine)
 *   - fenced ```json responses parse
 *   - brackets inside quoted strings and inside the <summary> prose do not
 *     confuse the scan
 *   - a malformed or truncated response returns [] without throwing
 *   - gateByVerdicts drops rework/reject scenarios and keeps pass scenarios
 *
 * Pure in-code fixtures. No network. No LLM. No browser.
 */
import { parseVerdicts, gateByVerdicts, describeStep, renderValueForCritic, repairJson, CRITIC_SYSTEM_PROMPT, completeVerdicts, criticMaxTokens, CRITIC_TOKENS_PER_VERDICT, CRITIC_SUMMARY_TOKENS, critique, type CriticClient } from '../src/agent/critic.js';
import { EXPLORER_SYSTEM_PROMPT } from '../src/agent/runtime.js';
import { ASSERTION_DOCTRINE } from '../src/agent/doctrine.js';
import type { TraceStep } from '../src/agent/trace.js';
import { attachRuleIds, computeRuleCoverage } from '../src/agent/rule-coverage.js';
import type { RequirementsMap } from '../src/agent/requirements.js';
import type { Scenario } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

/* ─── A. canonical response: nested arrays + summary ───────────────────────── */
// This is the exact shape the SYSTEM prompt mandates. The old lazy regex
// matched from the array opener to the first "]", the close of the first
// object's reasons array, so JSON.parse always threw and 0 verdicts came back.
const canonical = `[
  { "scenario": "rejected empty username with error message", "verdict": "pass", "reasons": ["asserts the visible error text"], "required_fixes": [] },
  { "scenario": "logged in with valid credentials", "verdict": "rework", "reasons": ["outcome assertion missing"], "required_fixes": ["assert the inventory list is visible after login"] }
]

<summary>
The overall spec quality is good.
</summary>`;

const a = parseVerdicts(canonical);
check('A1. canonical response yields every verdict, not zero', a.length === 2, `got ${a.length}`);
check('A2. first verdict carries scenario, verdict, and reasons intact',
  a[0]?.scenario === 'rejected empty username with error message' && a[0]?.verdict === 'pass' && a[0]?.reasons[0] === 'asserts the visible error text');
check('A3. required_fixes array survives on the rework verdict',
  a[1]?.verdict === 'rework' && a[1]?.required_fixes[0] === 'assert the inventory list is visible after login');

/* ─── B. fenced variant ────────────────────────────────────────────────────── */
const fenced = 'Here is my review.\n```json\n' + canonical.split('<summary>')[0] + '\n```\n<summary>Fine.</summary>';
const b = parseVerdicts(fenced);
check('B1. fenced ```json response parses the same', b.length === 2 && b[0]?.verdict === 'pass' && b[1]?.verdict === 'rework');

/* ─── C. malformed responses return [] without throwing ───────────────────── */
check('C1. plain prose with no array returns []', parseVerdicts('No JSON here at all.').length === 0);
check('C2. truncated JSON (max_tokens cut mid-array) returns []',
  parseVerdicts('[\n  { "scenario": "s1", "verdict": "pass", "reasons": ["r').length === 0);
check('C3. broken JSON inside a balanced array returns []',
  parseVerdicts('[ { scenario: unquoted } ]').length === 0);
check('C4. empty response returns []', parseVerdicts('').length === 0);

/* ─── D. real saved-run shape (saucedemo run-report fixture) ───────────────── */
// Names from output/saucedemo-automation-framework/run-report.json. The rework
// reason quotes "[no-timeout]" and the summary cites rule ids in brackets;
// neither bracket may end the scan early.
const real = `Here are my verdicts for the five scenarios:

[
  { "scenario": "logged in with valid credentials and landed on inventory page", "verdict": "pass", "reasons": ["asserts the post-login inventory container"], "required_fixes": [] },
  { "scenario": "rejected empty username with error message", "verdict": "pass", "reasons": ["specific error text assertion"], "required_fixes": [] },
  { "scenario": "rejected password-only submission with error message", "verdict": "pass", "reasons": ["specific error text assertion"], "required_fixes": [] },
  { "scenario": "rejected mismatched credentials with error message", "verdict": "rework", "reasons": ["error assertion has [no-timeout] on an async banner"], "required_fixes": ["use a timeout of at least 10000ms"] },
  { "scenario": "locked out user sees account locked error", "verdict": "pass", "reasons": ["asserts the lockout message"], "required_fixes": [] }
]

<summary>
The overall spec quality is high. All five scenarios [R2, R4, R5, R6, R7] cover distinct paths through the login flow.
</summary>`;

const d = parseVerdicts(real);
check('D1. all 5 verdicts parse from the real response shape', d.length === 5, `got ${d.length}`);
check('D2. a bracket inside a quoted reason does not end the array',
  d[3]?.verdict === 'rework' && d[3]?.reasons[0]?.includes('[no-timeout]') === true, JSON.stringify(d[3]));
check('D3. brackets in the summary prose do not confuse the scan',
  d[4]?.scenario === 'locked out user sees account locked error');
check('D4. input order is preserved',
  d.map((v) => v.scenario.split(' ')[0]).join(',') === 'logged,rejected,rejected,rejected,locked');

/* ─── E. hostile preamble and odd shapes ───────────────────────────────────── */
check('E1. a bracketed fragment in the preamble is skipped',
  parseVerdicts('Scenario [login] looks solid. Ratings [1] out of scope.\n' + canonical).length === 2);
check('E2. an unknown verdict value coerces to rework',
  parseVerdicts('[{ "scenario": "s", "verdict": "ship", "reasons": ["r"], "required_fixes": [] }]')[0]?.verdict === 'rework');
check('E3. non-object array elements are filtered out',
  parseVerdicts('[{ "scenario": "s", "verdict": "pass", "reasons": ["r"], "required_fixes": [] }, 42, null]').length === 1);
check('E4. a string reasons field coerces to a one-element array',
  JSON.stringify(parseVerdicts('[{ "scenario": "s", "verdict": "pass", "reasons": "solid", "required_fixes": [] }]')[0]?.reasons) === '["solid"]');

/* ─── F. gateByVerdicts drops rework/reject, keeps pass ────────────────────── */
const scenarios = [
  { name: 'logged in with valid credentials and landed on inventory page' },
  { name: 'rejected empty username with error message' },
  { name: 'rejected password-only submission with error message' },
  { name: 'rejected mismatched credentials with error message' },
  { name: 'locked out user sees account locked error' },
];
const gated = gateByVerdicts(scenarios, d);
check('F1. the rework scenario is dropped before Reality-Check',
  gated.dropped.length === 1 && gated.dropped[0] === 'rejected mismatched credentials with error message');
check('F2. the 4 pass scenarios are kept in order',
  gated.kept.length === 4 && gated.kept.every((s) => s.name !== gated.dropped[0]));
check('F3. a verdict naming an unknown scenario drops nothing',
  gateByVerdicts(scenarios, [{ scenario: 'no such scenario', verdict: 'reject', reasons: [], required_fixes: [] }]).kept.length === 5);
check('F4. zero verdicts keeps every scenario (the gate is inert, never destructive)',
  gateByVerdicts(scenarios, []).kept.length === 5);

/* ─── G. end to end: a critic-gated scenario's rule is planned-but-dropped ── */
// parse -> gate -> attachRuleIds -> computeRuleCoverage, the same chain the
// runtime walks. The gated rework scenario cited R5; its rule must come out
// planned-but-dropped, while the surviving scenario's R6 stays covered.
const map: RequirementsMap = {
  features: [{
    name: 'login',
    description: 'Users sign in with username and password.',
    rules: [
      { id: 'R5', text: 'Mismatched credentials show an error.', type: 'validation' },
      { id: 'R6', text: 'Valid credentials land on the inventory page.', type: 'navigation' },
    ],
  }],
  roles: [],
  truncated: false,
};
const planned = [
  { name: 'rejected mismatched credentials with error message', ruleIds: ['R5'] },
  { name: 'logged in with valid credentials and landed on inventory page', ruleIds: ['R6'] },
];
const survivors: Array<{ name: string; ruleIds?: string[] }> = gated.kept.map((s) => ({ name: s.name }));
attachRuleIds(survivors, planned);
const coverage = computeRuleCoverage({ map, planned, scenarios: survivors });
check('G1. the surviving scenario keeps its rule covered',
  coverage.covered.length === 1 && coverage.covered[0]?.ruleId === 'R6');
check('G2. the critic-gated scenario\'s rule classifies planned-but-dropped',
  coverage.uncovered.length === 1 && coverage.uncovered[0]?.ruleId === 'R5' && coverage.uncovered[0]?.reason === 'planned-but-dropped',
  JSON.stringify(coverage.uncovered));

/* ─── H. critic input fidelity: values reach the critic intact ─────────────── */
// A live run's critic flagged a login email as "truncated with a stray quote"
// while the console showed the full value filled and the login passing. Root
// cause: describeStep sliced the QUOTED value at 30 chars, cutting the closing
// quote. Long values must reach the critic whole; only extreme lengths are
// capped, BEFORE quoting, with an explicit marker.
const longEmail = 'quality.assurance.fidelity.check+2026-09-07@subdomain.example-company-name.com'; // 79 chars
const fillStep: TraceStep = {
  kind: 'fill',
  target: { level: 'label', arg: 'Email', intent: 'email input' },
  value: longEmail,
};
const rendered = describeStep(fillStep);
check('H1. a 60+ char fill value reaches the critic rendering intact',
  rendered.includes(JSON.stringify(longEmail)), rendered);
check('H2. the rendered quotes are balanced (no stray-quote artifact)',
  (rendered.match(/"/g) ?? []).length % 2 === 0, rendered);

const huge = 'x'.repeat(250);
const hugeRendered = renderValueForCritic(huge);
check('H3. an extreme value is cut BEFORE quoting, quotes balanced, cap explicit',
  hugeRendered.startsWith(JSON.stringify(huge.slice(0, 200))) && hugeRendered.includes('250 chars total'),
  hugeRendered.slice(0, 60) + '…');
check('H4. values at the cap are untouched', renderValueForCritic('y'.repeat(200)) === JSON.stringify('y'.repeat(200)));

const selectStep: TraceStep = {
  kind: 'select_option',
  target: { level: 'label', arg: 'Country', intent: 'country dropdown' },
  by: 'label',
  option: 'Saint Vincent and the Grenadines (Kingstown metropolitan region)',
};
check('H5. a long select_option label renders intact too',
  describeStep(selectStep).includes(JSON.stringify('Saint Vincent and the Grenadines (Kingstown metropolitan region)')),
  describeStep(selectStep));

/* ─── K. Lenient JSON: escapes and trailing commas that models write ─────── */
// The saucedemo dashboard run: the critic quoted the URL regex it was shown.
// "\." is not a JSON escape, so strict JSON.parse threw on a whole, well-formed
// array and the run reported zero verdicts while the summary parsed fine.
const regexQuoted = `[
  { "scenario": "logged in", "verdict": "pass", "reasons": ["asserts /inventory\\.html"], "required_fixes": [] },
  { "scenario": "blank username", "verdict": "rework", "reasons": ["regex /saucedemo\\.com// doubled slash"], "required_fixes": ["drop it"], }
]
<summary>ok</summary>`;
const k1 = parseVerdicts(regexQuoted);
check('K1. a reason quoting a regex with a non-JSON escape still parses (2 verdicts)', k1.length === 2, JSON.stringify(k1));
check('K2. the invalid escape is kept literally in the reason text', k1[0]?.reasons[0] === 'asserts /inventory\\.html', k1[0]?.reasons[0]);
check('K3. a trailing comma before } does not break the parse', k1[1]?.verdict === 'rework' && k1[1]?.required_fixes[0] === 'drop it');
const legalEscapes = `[{ "scenario": "s", "verdict": "pass", "reasons": ["line\\nbreak \\"quoted\\" tab\\t slash\\/ uni\\u00e9"], "required_fixes": [] }]`;
const k4 = parseVerdicts(legalEscapes);
check('K4. legal JSON escapes are untouched by the repair', k4[0]?.reasons[0] === 'line\nbreak "quoted" tab\t slash/ uni\u00e9', k4[0]?.reasons[0]);
check('K5. repairJson leaves already-valid JSON byte-identical', repairJson(legalEscapes) === legalEscapes);
const truncated = `[
  { "scenario": "first", "verdict": "pass", "reasons": ["ok"], "required_fixes": [] },
  { "scenario": "second", "verdict": "reject", "reasons": ["bad"], "required_fixes": [] },
  { "scenario": "third", "verdict": "pass", "reasons": ["cut off by the tok`;
const k6 = parseVerdicts(truncated);
check('K6. a response cut off mid-array salvages the complete verdicts and drops the partial one', k6.length === 2 && k6[1]?.scenario === 'second', JSON.stringify(k6));
check('K7. toHaveURL renders as a quoted regex string (no /pattern// artefact)',
  describeStep({ kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: 'saucedemo\\.com/' } }) === 'assert URL matches regex "saucedemo\\\\.com/"',
  describeStep({ kind: 'assert', name: 'u', assertion: { type: 'toHaveURL', pattern: 'saucedemo\\.com/' } }));

/* ─── L. the Critic sees selectors ─────────────────────────────────────────── */
// Live evidence: saucedemo run 20260917T124620Z-34307c, the locked_out_user
// scenario drew rework for "the locator for this marker is not specified"
// while the trace held css ".inventory_list". describeStep rendered the intent
// alone (which defaulted to "element" when the model gave none). Every target
// now renders as "intent = locator", the locator exactly as the emitter writes it.
const l1 = describeStep({ kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login' }, intent: 'login button' } });
check('L1. a role selector renders as the emitter writes it, next to the intent',
  l1 === 'click(login button = page.getByRole("button", {"name":"Login"}))', l1);
const l2 = describeStep({ kind: 'capture', varName: 'cap_first', source: 'text', intent: 'first product name', target: { level: 'css', arg: 'a[data-test^="product-"] h5', intent: 'first product name', ambiguous: true } });
check('L2. an ambiguous css selector renders .first(), as the spec will',
  l2 === 'capture text of first product name = page.locator("a[data-test^=\\"product-\\"] h5").first() -> cap_first', l2);
const l3 = describeStep({ kind: 'assert', name: 'count', assertion: { type: 'toHaveCount', target: { level: 'css', arg: '.inventory_list', intent: 'inventory page marker (should be absent)' }, count: 0, timeout: 5000 } });
check('L3. the live shape: the count assertion names its css locator',
  l3 === 'assert inventory page marker (should be absent) = page.locator(".inventory_list") count=0', l3);
const l4 = describeStep({ kind: 'assert', name: 'h', assertion: { type: 'toHaveText', target: { level: 'role', arg: { role: 'heading', name: 'Sample Heading' }, intent: 'frame heading', frameChain: ['iframe#frame1'] }, text: 'Sample Heading', timeout: 5000 } });
check('L4. a frame chain renders page.frameLocator(...) before the level call',
  l4.includes('frame heading = page.frameLocator("iframe#frame1").getByRole("heading", {"name":"Sample Heading"})'), l4);
const l5 = describeStep({ kind: 'assert', name: 'v', assertion: { type: 'toBeVisible', target: { level: 'css', arg: '[data-test="no-results"]', intent: 'element' }, timeout: 5393 } });
check('L5. the default "element" intent never renders bare: the locator follows it',
  l5.startsWith('assert element = page.locator("[data-test=\\"no-results\\"]") visible') && !/assert element visible/.test(l5), l5);
const l6 = describeStep({ kind: 'assert_compare', varName: 'cap_x', readVar: 'cap_x_now', relation: 'less', source: 'count', intent: 'product cards', target: { level: 'css', arg: '.card', intent: 'product cards' } });
check('L6. assert_compare names the locator it re-reads', l6.includes('at product cards = page.locator(".card")'), l6);
// Run 5e4394: the Critic asked for a timeout on five compares because the line
// did not say the re-read polls. It now ends in the replay poll, and a compare
// that re-reads a second element names that element too.
check('L6a. assert_compare shows the poll timeout replay and the emitted spec use', l6.endsWith('[polls 10000ms]'), l6);
const l6b = describeStep({ kind: 'assert_compare', varName: 'cap_name', readVar: 'cap_name_now', relation: 'equal', source: 'text', intent: 'first card name', target: { level: 'css', arg: 'a.card h5', intent: 'first card name' }, readTarget: { level: 'css', arg: 'h1', intent: 'detail heading' } });
check('L6b. a cross-element compare names the element it re-reads', l6b.includes('re-read at detail heading = page.locator("h1")') && l6b.includes('at first card name = page.locator("a.card h5")'), l6b);
const l6c = describeStep({ kind: 'assert', name: 'p', assertion: { type: 'toHaveText', target: { level: 'css', arg: 'a.card .card-footer', intent: 'first card price' }, text: '', pattern: '^\\$\\d+\\.\\d{2}$', timeout: 5000 } });
check('L6c. a pattern assertion renders as "matching /.../", never as an empty literal', l6c.includes('has text matching /^\\$\\d+\\.\\d{2}$/') && !l6c.includes('has text ""'), l6c);
const l6d = describeStep({ kind: 'assert', name: 'c', assertion: { type: 'toHaveCount', target: { level: 'css', arg: 'a.card', intent: 'product cards' }, count: 1, atLeast: true, timeout: 5000 } });
check('L6d. a minimum count renders as count>=N', l6d.includes('count>=1'), l6d);
const l6e = describeStep({ kind: 'assert', name: 'k', assertion: { type: 'toBeChecked', target: { level: 'css', arg: '#eco', intent: 'eco filter' }, checked: true, timeout: 5000 } });
check('L6e. a checked assertion renders its state', l6e.includes('eco filter = page.locator("#eco") checked'), l6e);
check('L6f. the Critic prompt says a compare line polls and never needs a timeout, and names the tool forms', CRITIC_SYSTEM_PROMPT.includes('[polls Nms]') && CRITIC_SYSTEM_PROMPT.includes('toHaveCount with atLeast') && CRITIC_SYSTEM_PROMPT.includes('toBeChecked'));
// The Critic prompt fixture (the gateway smoke's login trace shape) rendered
// through describeStep: no line may carry a bare "element".
const fixtureLines = [
  describeStep({ kind: 'fill', target: { level: 'placeholder', arg: 'Username', intent: 'username input' }, value: 'standard_user' }),
  describeStep({ kind: 'click', target: { level: 'role', arg: { role: 'button', name: 'Login' }, intent: 'login button' } }),
  describeStep({ kind: 'assert', name: 'e', assertion: { type: 'toContainText', target: { level: 'text', arg: 'Username is required', intent: 'element' }, text: 'Username is required', timeout: 10000 } }),
];
check('L7. no rendered fixture line carries a bare "element" (each locator is spelled out)',
  fixtureLines.every((l) => !/\belement (visible|contains|has text|count=|hidden)/.test(l)) && fixtureLines.every((l) => l.includes('page.')), JSON.stringify(fixtureLines));
check('L8. the Critic prompt states that the locator shown is the locator under test', CRITIC_SYSTEM_PROMPT.includes('intent = locator') && CRITIC_SYSTEM_PROMPT.includes('never report a locator as unspecified'));

/* ─── M. doctrine and Critic agree, word for word ──────────────────────────── */
check('M1. the Explorer prompt contains the shared doctrine block verbatim', EXPLORER_SYSTEM_PROMPT.includes(ASSERTION_DOCTRINE));
check('M2. the Critic prompt contains the SAME doctrine block verbatim', CRITIC_SYSTEM_PROMPT.includes(ASSERTION_DOCTRINE));
check('M3. doctrine rule 2 requires capture-then-compare and forbids a literal expected first item',
  /2\. Proving a sort[^\n]*capture the first value[^\n]*assert_compare[^\n]*Never assert a literal expected first item/.test(ASSERTION_DOCTRINE) && !ASSERTION_DOCTRINE.includes('assert the known expected first item'));
check('M4. doctrine rule 6 forbids literal catalogue values, not only test ids',
  /6\. Never assert or capture a literal catalogue value or a generated id/.test(ASSERTION_DOCTRINE) && !/Prefer text content, counts/.test(ASSERTION_DOCTRINE));
check('M5. neither prompt keeps the old contradictory copy of the doctrine', !EXPLORER_SYSTEM_PROMPT.includes('the five weaknesses the Critic rejects every run') && !CRITIC_SYSTEM_PROMPT.includes('Volatile identifiers: an assertion or capture pinned to a specific catalog-item test id'));
check('M6. the Critic flagging rule on volatile values points at doctrine rules 2 and 6', /5\. Volatile values:[^\n]*Doctrine rules 2 and 6/.test(CRITIC_SYSTEM_PROMPT));

/* ─── N. every scenario gets a verdict; the call is sized to the count ─────── */
// Run f3b41e: 15 scenarios, a 3000-token cap, 14 verdicts and no summary.
// The 15th scenario went to replay unreviewed and failed there.
const fifteen = Array.from({ length: 15 }, (_, i) => ({ name: `scenario ${i + 1} does something` }));
const fourteen = fifteen.slice(0, 14).map((s) => ({ scenario: s.name, verdict: 'pass' as const, reasons: ['fine'], required_fixes: [] }));
const completed = completeVerdicts(fifteen, fourteen);
check('N1. 14 verdicts for 15 scenarios yields 15 verdicts: the missing one is held as rework', completed.verdicts.length === 15 && completed.verdicts[14]?.scenario === 'scenario 15 does something' && completed.verdicts[14]?.verdict === 'rework', JSON.stringify(completed.verdicts[14]));
check('N2. the held verdict says no verdict was returned', /no verdict returned/.test(completed.verdicts[14]?.reasons[0] ?? ''));
check('N3. the unreviewed list names the scenario for the runtime warning', JSON.stringify(completed.unreviewed) === JSON.stringify(['scenario 15 does something']));
check('N4. the held rework is dropped by the gate, never replayed', gateByVerdicts(fifteen, completed.verdicts).kept.length === 14);
check('N5. a complete response holds nothing', completeVerdicts(fifteen.slice(0, 14), fourteen).unreviewed.length === 0);
check('N6. max_tokens is a stated per-verdict budget times the count plus the summary, never below 3000', criticMaxTokens(15) === 15 * CRITIC_TOKENS_PER_VERDICT + CRITIC_SUMMARY_TOKENS && criticMaxTokens(15) === 5750 && criticMaxTokens(2) === 3000 && CRITIC_TOKENS_PER_VERDICT === 350 && CRITIC_SUMMARY_TOKENS === 500);

/* ─── O. one rule numbering: falsifiability is doctrine rule 8 on both sides ── */
check('O1. the shared doctrine carries the falsifiability ban as rule 8', /\n8\. Falsifiability\. The main assertion of every scenario must be able to FAIL/.test(ASSERTION_DOCTRINE));
check('O2. the Explorer prompt\'s ASSERTION RULES 7 points at doctrine rule 8 instead of its own copy', /7\. Falsifiability: ASSERTION DOCTRINE rule 8 below/.test(EXPLORER_SYSTEM_PROMPT) && !/Banned as the primary assertion: visibility of an element that was already visible before the action, a bare "URL did not change" check, and "the element is still present"\. Each of those passes/.test(EXPLORER_SYSTEM_PROMPT.replace(ASSERTION_DOCTRINE, '')));
check('O3. the Critic\'s vacuous rule cites doctrine rule 8', /doctrine rule 8 below; cite it as rule 8/.test(CRITIC_SYSTEM_PROMPT));
check('O4. doctrine rule 2 names the text relations before and after', /before or after for text/.test(ASSERTION_DOCTRINE));

/* ─── P. one retry on a zero-verdict response ─────────────────────────────── */
{
  const scripted = (responses: string[]): { client: CriticClient; calls: () => number } => {
    let n = 0;
    const client: CriticClient = {
      messages: {
        create: async () => {
          const text = responses[Math.min(n, responses.length - 1)] ?? '';
          n++;
          return {
            id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake',
            content: [{ type: 'text', text, citations: null }],
            stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          } as never;
        },
      },
    };
    return { client, calls: () => n };
  };
  const two: Scenario[] = [
    { name: 'rejected empty username with error message', category: 'negative', steps: [] } as unknown as Scenario,
    { name: 'logged in with valid credentials', category: 'happy', steps: [] } as unknown as Scenario,
  ];
  const junkText = 'I cannot review this right now.';
  const recovered = scripted([junkText, canonical]);
  const r = await critique({ scenarios: two, url: 'https://x.example/', apiKey: 'fake', client: recovered.client });
  check('P1. an empty first response is retried once and the good retry yields its verdicts', recovered.calls() === 2 && r.verdicts.length === 2 && r.verdicts[0]?.verdict === 'pass' && r.verdicts[1]?.verdict === 'rework' && r.unreviewed.length === 0, JSON.stringify(r.verdicts));
  check('P2. exactly one warning line names the retry and its outcome', r.warnings.length === 1 && /retried once with the same input and the retry returned 2 verdict/.test(r.warnings[0] ?? ''), JSON.stringify(r.warnings));
  check('P3. both raw responses are kept, in order', Array.isArray(r.raw) && r.raw.length === 2 && r.raw[0] === junkText && r.raw[1] === canonical);
  check('P4. the cost is the sum of both calls', Math.abs(r.costUsd - 2 * ((1000 * 3.0 + 100 * 15.0) / 1_000_000)) < 1e-12, String(r.costUsd));
  const twice = scripted([junkText, 'Still nothing.']);
  const held = await critique({ scenarios: two, url: 'https://x.example/', apiKey: 'fake', client: twice.client });
  check('P5. empty twice holds every scenario as rework, no third call', twice.calls() === 2 && held.verdicts.length === 2 && held.verdicts.every((v) => v.verdict === 'rework' && /no verdict returned/.test(v.reasons[0] ?? '')) && held.unreviewed.length === 2, JSON.stringify(held.verdicts));
  check('P6. both responses are recorded and the warning says the retry returned none', Array.isArray(held.raw) && held.raw[0] === junkText && held.raw[1] === 'Still nothing.' && held.warnings.length === 1 && /retry returned none/.test(held.warnings[0] ?? ''), JSON.stringify({ raw: held.raw, warnings: held.warnings }));
  const clean = scripted([canonical]);
  const direct = await critique({ scenarios: two, url: 'https://x.example/', apiKey: 'fake', client: clean.client });
  check('P7. a good first response makes one call, keeps a single raw string and no warning', clean.calls() === 1 && typeof direct.raw === 'string' && direct.warnings.length === 0);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the Critic verdict array parses fully via the bracket-depth scan, malformed responses fail soft, and the gate drops rework/reject scenarios.');
