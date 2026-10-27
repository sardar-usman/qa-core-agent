/**
 * The number inside formatted text, for the greater / less compare relations.
 *
 * A price reads "$48.41", a total "1,299.00", a share "42%", a caption "Total:
 * 3 items". Number() on any of those is NaN, and run 5e4394 showed the cost:
 * every numeric compare on a price failed in the tool, in replay and in the
 * emitted spec, all three of which used Number() directly. This module is the
 * one parser: tools.ts and replay.ts call parseNumber, and the emitters ship
 * the same function into the framework (helpers/parse-number in the POM
 * output, inlined in the single-file spec) so the shipped test compares the
 * same way the agent verified it.
 *
 * Rules: the FIRST number in the text wins; thousands separators (commas) are
 * dropped; a leading minus is kept; anything else around the number is
 * ignored. Text with no digit has no number: the agent side returns null and
 * every caller fails loudly with NO_NUMBER, never a silent false.
 */

const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?|-?\.\d+/;

/** The first number in the text, or null when there is none. */
export function parseNumber(text: string | number | null | undefined): number | null {
  if (typeof text === 'number') return Number.isFinite(text) ? text : null;
  const m = NUMBER_RE.exec(String(text ?? ''));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// A currency amount: a symbol or ISO code before or after a number ("$48.41",
// "EUR 12", "12,50 €", "48.41 USD"). The number part is what NUMBER_RE parses.
const CURRENCY_AMOUNT_RE = /(?:[$€£¥₹]|\b(?:usd|eur|gbp|chf|jpy|cad|aud|inr)\b)\s?-?\d[\d,]*(?:[.,]\d+)?|-?\d[\d,]*(?:[.,]\d+)?\s?(?:[$€£¥₹]|\b(?:usd|eur|gbp|chf|jpy|cad|aud|inr)\b)/i;

/**
 * The first currency amount inside the text ("Bolt Cutters ABCDE$48.41" gives
 * "$48.41"), or null when there is none. The amount must parse through the
 * same parser assert_compare uses, so a symbol with no number is not an
 * amount. Gate RULE 8 uses it: a locator name that carries a price pins a
 * catalogue value (run 51d535: three Critic reworks were role or label hints
 * whose accessible name concatenated the card's badge and price).
 */
export function currencyAmountIn(text: string | null | undefined): string | null {
  const m = CURRENCY_AMOUNT_RE.exec(String(text ?? ''));
  if (!m) return null;
  return parseNumber(m[0]) === null ? null : m[0].trim();
}

/** The loud failure every caller reports when a side has no number. */
export function noNumberMessage(text: string): string {
  return `no number found in ${JSON.stringify(String(text))}`;
}

/** The helper the POM framework ships at helpers/parse-number.{ts,js}. */
export function renderParseNumberHelper(lang: 'ts' | 'js'): string {
  if (lang === 'js') {
    return `// @ts-check
/**
 * The first number in formatted text: "$1,299.00" is 1299, "42%" is 42,
 * "Total: 3 items" is 3. Throws when the text holds no number, so a compare
 * on the wrong element fails loudly instead of comparing NaN.
 * @param {string | number | null | undefined} text
 * @returns {number}
 */
function parseNumber(text) {
  if (typeof text === 'number') return text;
  const m = /-?\\d[\\d,]*(?:\\.\\d+)?|-?\\.\\d+/.exec(String(text ?? ''));
  if (!m) throw new Error('no number found in ' + JSON.stringify(String(text ?? '')));
  return Number(m[0].replace(/,/g, ''));
}

module.exports = { parseNumber };
`;
  }
  return `/**
 * The first number in formatted text: "$1,299.00" is 1299, "42%" is 42,
 * "Total: 3 items" is 3. Throws when the text holds no number, so a compare
 * on the wrong element fails loudly instead of comparing NaN.
 */
export function parseNumber(text: string | number | null | undefined): number {
  if (typeof text === 'number') return text;
  const m = /-?\\d[\\d,]*(?:\\.\\d+)?|-?\\.\\d+/.exec(String(text ?? ''));
  if (!m) throw new Error('no number found in ' + JSON.stringify(String(text ?? '')));
  return Number(m[0].replace(/,/g, ''));
}
`;
}

/** The same helper inlined into the single-file spec (transcriber.ts). */
export function inlineParseNumberFn(): string {
  return [
    `// The first number in formatted text ("$1,299.00" is 1299, "42%" is 42).`,
    `// Throws when there is none, so a compare on the wrong element fails loudly.`,
    `function parseNumber(text) {`,
    `  if (typeof text === 'number') return text;`,
    `  const m = /-?\\d[\\d,]*(?:\\.\\d+)?|-?\\.\\d+/.exec(String(text ?? ''));`,
    `  if (!m) throw new Error('no number found in ' + JSON.stringify(String(text ?? '')));`,
    `  return Number(m[0].replace(/,/g, ''));`,
    `}`,
  ].join('\n');
}

/**
 * The one decision equal, unchanged and changed share (invariant 76).
 *
 * Run 59540f captured "$14.15" on the listing and re-read "14.15" on the
 * detail page; equal compared the raw text and failed, while greater and less,
 * which parse the number, both agreed the two are the same value. Now, when
 * BOTH sides are a plain number, the parsed numbers compare. A plain number is
 * exactly one number with only currency symbols, whitespace and a trailing
 * percent sign around it; a comma counts only as a thousands separator
 * ("1,299.00") and a dot only as the decimal point. Anything else ("Item 3",
 * "3 items", "Hammer", "12,50", "14.15 USD") compares the trimmed text exactly,
 * as before. A percent on one side and a currency symbol on the other are two
 * kinds of value, so "$5" against "5%" compares as text too (PR #54 review).
 * A side that does not parse falls back to the text compare, never to
 * "holds".
 *
 * One source. The body is JavaScript that is also valid TypeScript, with no
 * inner function and no type annotation. The agent's sameValue (tools.ts and
 * replay.ts) is built from it below, and the framework's copy
 * (helpers/same-value in the POM output, inlined in the single-file spec) is
 * the same text, so the agent and the shipped test cannot drift.
 */
const SAME_VALUE_BODY_LINES: readonly string[] = [
  String.raw`const plain = /^[\s$€£¥₹]*(-?)[\s$€£¥₹]*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)[\s%$€£¥₹]*$/;`,
  `const a = String(captured ?? '').trim();`,
  `const b = String(current ?? '').trim();`,
  `const ma = plain.exec(a);`,
  `const mb = plain.exec(b);`,
  String.raw`const mixed = (a.includes('%') && /[$€£¥₹]/.test(b)) || (b.includes('%') && /[$€£¥₹]/.test(a));`,
  `if (ma && mb && !mixed) return Number((ma[1] + ma[2]).replace(/,/g, '')) === Number((mb[1] + mb[2]).replace(/,/g, ''));`,
  `return a === b;`,
];

const SAME_VALUE_DOC_LINES: readonly string[] = [
  'True when the captured and the re-read value are the same value. Both plain',
  'numbers ("$14.15", "14.15", "1,299.00", "1.5%"): compared as numbers, so',
  '"$14.15" equals "14.15". Anything else ("Item 3", "Hammer"): the trimmed',
  'text must match exactly, and so does a percent against a currency amount',
  '("$5" is not "5%"). equal and unchanged hold when this is true, changed',
  'holds when it is false. The agent verified the recording with the same logic.',
];

// Built from the body above: the agent runs the exact text the framework ships.
const sameValueImpl = new Function('captured', 'current', SAME_VALUE_BODY_LINES.join('\n')) as (captured: unknown, current: unknown) => boolean;

/** True when both sides are the same value: plain numbers by value, anything else by exact trimmed text. */
export function sameValue(captured: string | number, current: string | number): boolean {
  return sameValueImpl(captured, current) === true;
}

/** The helper the POM framework ships at helpers/same-value.{ts,js}. */
export function renderSameValueHelper(lang: 'ts' | 'js'): string {
  const body = SAME_VALUE_BODY_LINES.map((l) => `  ${l}`);
  if (lang === 'js') {
    return [
      '// @ts-check',
      '/**',
      ...SAME_VALUE_DOC_LINES.map((l) => ` * ${l}`),
      ' * @param {string | number | null | undefined} captured',
      ' * @param {string | number | null | undefined} current',
      ' * @returns {boolean}',
      ' */',
      'function sameValue(captured, current) {',
      ...body,
      '}',
      '',
      'module.exports = { sameValue };',
      '',
    ].join('\n');
  }
  return [
    '/**',
    ...SAME_VALUE_DOC_LINES.map((l) => ` * ${l}`),
    ' */',
    'export function sameValue(captured: string | number | null | undefined, current: string | number | null | undefined): boolean {',
    ...body,
    '}',
    '',
  ].join('\n');
}

/** The same helper inlined into the single-file spec (transcriber.ts). */
export function inlineSameValueFn(): string {
  return [
    ...SAME_VALUE_DOC_LINES.map((l) => `// ${l}`),
    'function sameValue(captured, current) {',
    ...SAME_VALUE_BODY_LINES.map((l) => `  ${l}`),
    '}',
  ].join('\n');
}

/**
 * The polled read both emitters write for an equal, unchanged or changed
 * compare. It yields the captured value itself when sameValue says the re-read
 * is the same value, else the re-read, so .toBe(captured) and
 * .not.toBe(captured) decide exactly as the agent did, and a failure prints
 * the real re-read value instead of "Expected: true".
 */
export function sameValuePoll(varName: string, readRhs: string): string {
  return `async () => { const now = ${readRhs}; return sameValue(${varName}, now) ? ${varName} : now; }`;
}
