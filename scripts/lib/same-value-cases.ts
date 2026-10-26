/**
 * The one table of sameValue cases (invariant 76), driven through all four
 * places that decide equal, unchanged and changed: the tool (relationHolds),
 * replay (compareHolds), and the emitted framework, POM and single file, in
 * TypeScript and JavaScript. smoke-capture-compare runs it through the agent
 * side and the rendered helpers; smoke-emitted-run executes it on a fixture
 * page. `equal` is the expected answer for equal and unchanged; changed is
 * always its negation.
 */
export interface SameValueCase {
  captured: string;
  current: string;
  equal: boolean;
  why: string;
}

export const SAME_VALUE_CASES: readonly SameValueCase[] = [
  { captured: '$14.15', current: '14.15', equal: true, why: 'run 59540f: listing price against detail price' },
  { captured: '$1,299.00', current: '1299', equal: true, why: 'thousands separator and decimals' },
  { captured: '14.15', current: '14.150', equal: true, why: 'trailing zero' },
  { captured: '1.5%', current: '1.5', equal: true, why: 'percent sign' },
  { captured: '$14.15', current: '$14.16', equal: false, why: 'a real price change' },
  { captured: 'Item 3', current: '3', equal: false, why: 'a word beside the number: text compare' },
  { captured: '3 items', current: '3', equal: false, why: 'a word after the number: text compare' },
  { captured: 'Hammer', current: 'Hammer', equal: true, why: 'plain text, exact' },
  { captured: '12,50', current: '12.50', equal: false, why: 'a comma that is not a thousands group: text compare' },
  { captured: '$14.15', current: '14.15 USD', equal: false, why: 'a currency code is letters: text compare' },
];
