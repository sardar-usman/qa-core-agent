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
 *
 * The repair review is driven through critique() with a fixture client, so
 * the lock reads the system blocks and the user message the API would get.
 * No network, no model call, no browser.
 */
import { CRITIC_SYSTEM_PROMPT, REPAIR_REVIEW_PROMPT, SECONDARY_CHECK_RULE, COMPARE_READING_RULES, critique, describeStep, type CriticClient } from '../src/agent/critic.js';
import { EXPLORER_SYSTEM_PROMPT } from '../src/agent/runtime.js';
import { ASSERTION_DOCTRINE } from '../src/agent/doctrine.js';
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

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the Critic prompt and the repair review carry one rule for secondary checks with doctrine rule 8\'s scope, and the tool description, the compare line, the Critic prompt, the tool and replay all read re-read RELATION captured.');
