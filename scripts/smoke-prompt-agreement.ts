/**
 * Locks invariant 54's agreement rule for the two places run 59540f found
 * drifting (invariant 76):
 *
 *   A. One rule for a check of something already true before the action
 *      (D7d). The Critic's flagging rule 2 reworked "anything that was already
 *      true before the action" while doctrine rule 8 bans such a check only as
 *      the primary assertion; three of the four first-pass reworks hit such a
 *      secondary check beside a real outcome assertion. Now SECONDARY_CHECK_RULE
 *      is word for word in the Critic prompt and the repair review prompt, and
 *      its scope is doctrine rule 8's.
 *   B. One direction for a compare (D3, D7g). The tool description, the
 *      compare line the Critic reads, the Critic prompt and the two decisions
 *      (relationHolds in tools.ts, compareHolds in replay.ts) all read
 *      re-read RELATION captured; run 7's Explorer tried both directions and
 *      its Critic read greater backwards.
 *   C. One rule for a name that claims every item of a list (invariant 77,
 *      D5): doctrine rule 11 is UNIVERSAL_CLAIM_RULE, the Critic's flagging
 *      rule 6 quotes it word for word and reworks a scenario without the
 *      all-items or count-0 assertion, and the Explorer's tool description
 *      names the all-items form.
 *   D. The repair review judges a fix the recording shows the page cannot
 *      satisfy as applied, "not satisfiable: the page renders ..." (D3 b).
 *
 * The repair review is driven through critique() with a fixture client, so
 * the lock reads the system blocks and the user message the API would get.
 * No network, no model call, no browser.
 */
import { CRITIC_SYSTEM_PROMPT, REPAIR_REVIEW_PROMPT, SECONDARY_CHECK_RULE, COMPARE_READING_RULES, UNSATISFIABLE_FIX_RULE, critique, describeStep, repairOutcome, type CriticClient, type ScenarioVerdict } from '../src/agent/critic.js';
import { EXPLORER_SYSTEM_PROMPT } from '../src/agent/runtime.js';
import { ASSERTION_DOCTRINE, UNIVERSAL_CLAIM_RULE } from '../src/agent/doctrine.js';
import { TOOL_DEFS, relationHolds } from '../src/agent/tools.js';
import { compareHolds } from '../src/agent/replay.js';
import { sameValue } from '../src/agent/parse-number.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Scenario } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ': ' + hint : ''}`); }
};

/* ─── A. one rule for pre-existing-state checks, in both Critic prompts ───── */

check('A1. the Critic prompt carries the shared rule verbatim inside flagging rule 2',
  CRITIC_SYSTEM_PROMPT.includes(`\n2. Vacuous or substring (doctrine rule 8 below; cite it as rule 8): ${SECONDARY_CHECK_RULE} A substring match`));
check('A2. the repair review prompt carries the same rule verbatim', REPAIR_REVIEW_PROMPT.includes(SECONDARY_CHECK_RULE));
check('A3. the rule reworks such a check only as the primary outcome assertion, defined by the other recorded assertions',
  SECONDARY_CHECK_RULE.includes("is a rework reason only when it is the scenario's primary outcome assertion, meaning no other recorded assertion checks the outcome of the key action."));
check('A4. beside a real outcome assertion it is an allowed secondary check: never a rework reason, never a required fix, may be mentioned',
  SECONDARY_CHECK_RULE.includes('When a real outcome assertion is also recorded, such a check is an allowed secondary sanity check under doctrine rule 8: never a rework reason and never a required fix. You may mention it in reasons.'));
// Doctrine rule 8 is the scope the shared rule mirrors: banned only as the
// primary assertion, kept as a secondary sanity check, with the same example.
const rule8 = /\n8\. Falsifiability\.[^\n]*/.exec(ASSERTION_DOCTRINE)?.[0] ?? '';
check('A5. doctrine rule 8 bans these only as the primary assertion and keeps them as a secondary sanity check, the scope the rule mirrors',
  rule8.includes('Banned as the primary assertion') && rule8.includes('use it only as a secondary sanity check') && rule8.includes('"the element is still present"') && SECONDARY_CHECK_RULE.includes('"the element is still present"') && SECONDARY_CHECK_RULE.includes('doctrine rule 8'), rule8);
check('A6. the Explorer and the Critic both carry doctrine rule 8 word for word (invariant 54)', EXPLORER_SYSTEM_PROMPT.includes(ASSERTION_DOCTRINE) && CRITIC_SYSTEM_PROMPT.includes(ASSERTION_DOCTRINE));
check('A7. neither Critic prompt keeps the old unconditional wording that reworked any pre-existing check',
  ![CRITIC_SYSTEM_PROMPT, REPAIR_REVIEW_PROMPT].some((p) => p.includes('or on anything that was already true before the action, proves nothing about the outcome')));
check('A8. the substring part of flagging rule 2 is unchanged',
  CRITIC_SYSTEM_PROMPT.includes('A substring match (toContainText with a single character or a unit-only string like "%") is never acceptable. Flag as "rework".'));
check('A9. the repair review never requires removing a secondary check and judges such a fix applied, "allowed by doctrine rule 8"',
  REPAIR_REVIEW_PROMPT.includes('So removing a secondary check is never a required fix: a first-review fix that only asked to remove such a check, while a real outcome assertion is recorded, is judged "applied": true with the reason "allowed by doctrine rule 8".'));

// The wire: a repair review call sends the Critic prompt then the repair
// prompt, both holding the rule, and the user message holds the new compare line.
const sent: Anthropic.MessageCreateParamsNonStreaming[] = [];
const client: CriticClient = {
  messages: {
    create: async (params) => {
      sent.push(params);
      const text = JSON.stringify([{ scenario: 'sorted by price ascending', verdict: 'pass', reasons: ['the sort dropdown attribute is an allowed secondary check'], required_fixes: [], fixes: [{ fix: 'remove the sort dropdown attribute check', applied: true, reason: 'allowed by doctrine rule 8' }], observations: [] }]) + '\n<summary>fine</summary>';
      return { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
    },
  },
};
const sortScenario: Scenario = {
  name: 'sorted by price ascending', category: 'happy', feature: 'catalogue',
  steps: [
    { kind: 'navigate', url: 'https://shop.example/' },
    { kind: 'capture', varName: 'cap_first', source: 'text', intent: 'first price', target: { level: 'css', arg: '.price', intent: 'first price', ambiguous: true } },
    { kind: 'select_option', target: { level: 'label', arg: 'Sort', intent: 'sort dropdown' }, by: 'value', option: 'price,asc' },
    { kind: 'assert_compare', varName: 'cap_first', readVar: 'cap_first_now', relation: 'less', source: 'text', intent: 'first price', target: { level: 'css', arg: '.price', intent: 'first price', ambiguous: true } },
    { kind: 'assert', name: 'a', assertion: { type: 'toHaveAttribute', target: { level: 'label', arg: 'Sort', intent: 'sort dropdown' }, attribute: 'data-test', value: 'sort', timeout: 10000 } },
  ],
};
const result = await critique({ scenarios: [sortScenario], url: 'https://shop.example/', apiKey: 'fake', client, repairFixes: new Map([[sortScenario.name, ['remove the sort dropdown attribute check']]]) });
check('A10. the fixture repair review call returned its one verdict with the fix judged applied', result.verdicts.length === 1 && result.verdicts[0]?.fixes?.[0]?.applied === true && sent.length === 1, JSON.stringify(result.verdicts));
const system = (sent[0]?.system ?? []) as Anthropic.TextBlockParam[];
check('A11. the call sends the Critic prompt first and the repair review prompt second, each with the shared rule',
  system.length === 2 && system[0]?.text === CRITIC_SYSTEM_PROMPT && system[1]?.text === REPAIR_REVIEW_PROMPT && system.every((b) => b.text.includes(SECONDARY_CHECK_RULE)), String(system.length));
const userText = String((sent[0]?.messages[0] as { content?: unknown } | undefined)?.content ?? '');
check('A12. the user message carries the compare line in words, after the select_option action line',
  userText.includes('assert_compare: re-read first price = page.locator(".price").first() must be LESS THAN captured cap_first [polls 10000ms]') && userText.indexOf('select_option(') < userText.indexOf('assert_compare:'), userText);

/* ─── B. one direction for a compare, on every surface ──────────────────── */

const compareTool = TOOL_DEFS.find((t) => t.name === 'assert_compare');
const desc = compareTool?.description ?? '';
check('B1. the tool description states the direction in words: re-read RELATION captured, greater is re-read > captured, less is re-read < captured',
  desc.includes('Every relation reads re-read RELATION captured') && desc.includes('greater: the re-read value is greater than the captured value (re-read > captured)') && desc.includes('less: the re-read value is less than the captured value (re-read < captured)'), desc);
check('B2. the Critic prompt reads the compare line the same way', COMPARE_READING_RULES.includes('Read it as re-read RELATION captured, never reversed: GREATER THAN means the re-read value is greater than the captured value'));
const bLine = describeStep({ kind: 'assert_compare', varName: 'cap_c', readVar: 'cap_c_now', relation: 'greater', source: 'text', intent: 'last price', target: { level: 'css', arg: '.first', intent: 'first price' }, readTarget: { level: 'css', arg: '.last', intent: 'last price' } });
check('B3. the compare line puts the re-read on the left of the words and the captured var on the right', bLine === 'assert_compare: re-read last price = page.locator(".last") must be GREATER THAN captured cap_c [polls 10000ms]', bLine);
// Run 7's recorded values: step 5 captured "$14.15" and re-read "$3.55" after
// the ascending sort (less held); step 7 re-read the last card "$9.17"
// against the captured first "$3.55" (greater held).
check('B4. the tool decides as the words say: less holds for re-read $3.55 against captured $14.15, greater for re-read $9.17 against captured $3.55, and not the reverse',
  relationHolds('less', '$14.15', '$3.55') && relationHolds('greater', '$3.55', '$9.17') && !relationHolds('greater', '$14.15', '$3.55') && !relationHolds('less', '$3.55', '$9.17'));
check('B5. replay decides the same way', compareHolds('less', '$14.15', '$3.55') && compareHolds('greater', '$3.55', '$9.17') && !compareHolds('greater', '$14.15', '$3.55') && !compareHolds('less', '$3.55', '$9.17'));
check('B6. the tool description, the Critic prompt and sameValue agree that "$14.15" equals "14.15"',
  desc.includes('"equal", "unchanged" and "changed" compare two plain numbers by value ("$14.15" equals "14.15"') && COMPARE_READING_RULES.includes('"$14.15" and "14.15" are the same value') && sameValue('$14.15', '14.15'));

/* ─── C. one rule for a name that claims every item of a list ───────────── */

const rule11 = /\n11\. [^\n]*/.exec(ASSERTION_DOCTRINE)?.[0] ?? '';
check('C1. doctrine rule 11 is the universal-claim rule, word for word', rule11 === `\n11. ${UNIVERSAL_CLAIM_RULE}`, rule11);
check('C2. the rule names every universal word and both assertion forms, and says a first-item check proves one item',
  UNIVERSAL_CLAIM_RULE.includes('(only, all, every, each, none, no)') && UNIVERSAL_CLAIM_RULE.includes('assert allItemsMatch') && UNIVERSAL_CLAIM_RULE.includes('count-0 absence assertion') && UNIVERSAL_CLAIM_RULE.includes('An assertion on the first item proves one item, not the claim.'));
const flag6 = /\n6\. Universal claim in the name[^\n]*/.exec(CRITIC_SYSTEM_PROMPT)?.[0] ?? '';
check('C3. the Critic\'s flagging rule 6 quotes the rule word for word and cites doctrine rule 11', flag6.includes(UNIVERSAL_CLAIM_RULE) && flag6.includes('doctrine rule 11'), flag6);
check('C4. flagging rule 6 reworks a claim with neither assertion, with a required fix that names the all-items form',
  flag6.includes('is "rework", with a required fix that names the form: "assert allItemsMatch on the item locator (every item, not the first) with text set to the value the scenario typed"'), flag6);
check('C5. the Explorer and the Critic both carry doctrine rule 11 (invariant 54)', EXPLORER_SYSTEM_PROMPT.includes(rule11) && CRITIC_SYSTEM_PROMPT.includes(rule11));
const assertTool = TOOL_DEFS.find((t) => t.name === 'assert');
const assertDesc = assertTool?.description ?? '';
const assertEnum = ((assertTool?.input_schema as { properties: { type: { enum: string[] } } } | undefined)?.properties.type.enum) ?? [];
check('C6. the assert tool offers allItemsMatch and its description names it for an "only matching" or "all items" outcome',
  assertEnum.includes('allItemsMatch') && /for an "only matching" or "all items" outcome[^.]*use allItemsMatch/.test(assertDesc), assertDesc);
// The line flagging rule 6 names is the line the Critic is shown.
const allItemsLine = describeStep({ kind: 'assert', name: 'a', assertion: { type: 'allItemsMatch', target: { level: 'css', arg: '[data-test="product-name"]', intent: 'product names' }, pattern: 'Pliers', flags: 'i', timeout: 10000 } });
const minLine = describeStep({ kind: 'assert', name: 'b', assertion: { type: 'toHaveCount', target: { level: 'css', arg: '[data-test="product-name"]', intent: 'product names' }, count: 1, atLeast: true, timeout: 10000 } });
check('C7. the recorded pair renders as rule 6 names it: "assert every item of ... matches" followed by "count>=1"',
  allItemsLine.startsWith('assert every item of product names = ') && allItemsLine.includes(' matches /Pliers/i ') && minLine.includes('count>=1') && flag6.includes('An "assert every item of ... matches" line followed by "count>=1" is that assertion.'), `${allItemsLine} | ${minLine}`);
// The wire: a first review call carries rule 6 and the user message the line.
const firstSent: Anthropic.MessageCreateParamsNonStreaming[] = [];
const firstClient: CriticClient = {
  messages: {
    create: async (params) => {
      firstSent.push(params);
      const text = JSON.stringify([{ scenario: 'search for term filtered list to only matching product names', verdict: 'rework', reasons: ['the name claims every item; only the first card is checked'], required_fixes: ['assert allItemsMatch on the item locator (every item, not the first) with text set to the value the scenario typed'] }]) + '\n<summary>one rework</summary>';
      return { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
    },
  },
};
const searchScenario: Scenario = {
  name: 'search for term filtered list to only matching product names', category: 'happy', feature: 'catalogue',
  steps: [
    { kind: 'navigate', url: 'https://shop.example/' },
    { kind: 'fill', target: { level: 'role', arg: { role: 'textbox', name: 'search' }, intent: 'search input' }, value: 'Pliers' },
    { kind: 'click', target: { level: 'css', arg: '[data-test="search-submit"]', intent: 'search submit button' } },
    { kind: 'assert', name: 'c', assertion: { type: 'toContainText', target: { level: 'css', arg: "a[data-test^='product-']:first-of-type [data-test='product-name']", intent: 'first product name after search' }, text: '', pattern: '[Pp]liers', timeout: 15000 } },
  ],
};
const firstResult = await critique({ scenarios: [searchScenario], url: 'https://shop.example/', apiKey: 'fake', client: firstClient });
const firstSystem = (firstSent[0]?.system ?? []) as Anthropic.TextBlockParam[];
check('C8. a first review call through critique() sends flagging rule 6 and parses the rework naming the all-items form',
  firstSystem.length === 1 && firstSystem[0]!.text.includes(flag6) && firstResult.verdicts[0]?.verdict === 'rework' && /assert allItemsMatch/.test(firstResult.verdicts[0]?.required_fixes[0] ?? ''), JSON.stringify(firstResult.verdicts));

/* ─── D. a fix the recording shows the page cannot satisfy ──────────────── */

check('D1. the repair review prompt carries the rule: a fix a passing assertion contradicts is applied, "not satisfiable: the page renders ..."',
  REPAIR_REVIEW_PROMPT.includes(`- ${UNSATISFIABLE_FIX_RULE}`) &&
  UNSATISFIABLE_FIX_RULE.includes('A listed fix that a passing assertion in the repair recording contradicts (for example, "add a $" when the recorded price assertion /^\\d+\\.\\d{2}$/ passed on the live page) is judged "applied": true with the reason "not satisfiable: the page renders <what the passing assertion shows>".'),
  UNSATISFIABLE_FIX_RULE);
check('D2. any other unapplied fix stays not applied', UNSATISFIABLE_FIX_RULE.endsWith('Any other unapplied fix stays "applied": false.'));
// Run 7's listing to detail repair: the "$" fix could not be applied, the
// recorded /^\d+\.\d{2}$/ passed on "14.15". Through critique() with a fixture
// repair response that applies the rule, the scenario is kept.
const repairSent: Anthropic.MessageCreateParamsNonStreaming[] = [];
const detailName = 'clicked product opened detail page with same name and price as listing';
const dollarFix = 'require the unit price regex to include the dollar sign';
const otherFix = 'compare the detail heading against the captured listing name';
const repairClient: CriticClient = {
  messages: {
    create: async (params) => {
      repairSent.push(params);
      const text = JSON.stringify([{ scenario: detailName, verdict: 'pass', reasons: [], required_fixes: [], fixes: [
        { fix: dollarFix, applied: true, reason: 'not satisfiable: the page renders 14.15 (step 5, /^\\d+\\.\\d{2}$/ passed)' },
        { fix: otherFix, applied: true, reason: 'step 4 re-reads the detail heading' },
      ], observations: [] }]) + '\n<summary>kept</summary>';
      return { content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
    },
  },
};
const detailScenario: Scenario = {
  name: detailName, category: 'edge', feature: 'catalogue',
  steps: [
    { kind: 'navigate', url: 'https://shop.example/' },
    { kind: 'capture', varName: 'cap_name', source: 'text', intent: 'first product name', target: { level: 'css', arg: '.name', intent: 'first product name', ambiguous: true } },
    { kind: 'click', target: { level: 'css', arg: '.card', intent: 'first card', ambiguous: true } },
    { kind: 'assert_compare', varName: 'cap_name', readVar: 'cap_name_now', relation: 'equal', source: 'text', intent: 'detail heading', target: { level: 'css', arg: '.name', intent: 'first product name', ambiguous: true }, readTarget: { level: 'css', arg: 'h1', intent: 'detail heading' } },
    { kind: 'assert', name: 'p', assertion: { type: 'toHaveText', target: { level: 'css', arg: "[data-test='unit-price']", intent: 'detail page unit price' }, text: '', pattern: '^\\d+\\.\\d{2}$', timeout: 15000 } },
  ],
};
const repairResult = await critique({ scenarios: [detailScenario], url: 'https://shop.example/', apiKey: 'fake', client: repairClient, repairFixes: new Map([[detailName, [dollarFix, otherFix]]]) });
const repairSystem = (repairSent[0]?.system ?? []) as Anthropic.TextBlockParam[];
check('D3. the repair review call sends the rule in its second system block', repairSystem.length === 2 && repairSystem[1]!.text === REPAIR_REVIEW_PROMPT && repairSystem[1]!.text.includes(UNSATISFIABLE_FIX_RULE), String(repairSystem.length));
const firstVerdict: ScenarioVerdict = { scenario: detailName, verdict: 'rework', reasons: ['the unit price omits the dollar sign'], required_fixes: [dollarFix, otherFix] };
const outcome = repairOutcome({ first: [firstVerdict], repaired: [detailScenario], second: repairResult.verdicts });
const judged = outcome.history[0]?.fixes ?? [];
check('D4. the unsatisfiable fix is judged applied with the reason "not satisfiable: the page renders ...", and the repaired scenario is kept for replay',
  judged.length === 2 && judged[0]!.applied === true && judged[0]!.reason.startsWith('not satisfiable: the page renders 14.15') && outcome.final[0]?.verdict === 'pass' && outcome.replay.length === 1,
  JSON.stringify({ judged, final: outcome.final }));
// The other half of the rule: a fix judged not applied still drops.
const strictSecond: ScenarioVerdict[] = [{ ...repairResult.verdicts[0]!, verdict: 'rework', fixes: [{ fix: dollarFix, applied: true, reason: 'not satisfiable: the page renders 14.15' }, { fix: otherFix, applied: false, reason: 'step 4 still re-reads the listing name' }] }];
const strict = repairOutcome({ first: [firstVerdict], repaired: [detailScenario], second: strictSecond });
check('D5. any other fix judged not applied still drops the scenario', strict.final[0]?.verdict !== 'pass' && strict.replay.length === 0, JSON.stringify(strict.final));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the Critic prompt and the repair review carry one rule for secondary checks with doctrine rule 8\'s scope; the tool description, the compare line, the Critic prompt, the tool and replay all read re-read RELATION captured; doctrine rule 11 and the Critic\'s flagging rule 6 carry one universal-claim rule naming the all-items form; and the repair review judges a fix the recording shows the page cannot satisfy as applied.');
