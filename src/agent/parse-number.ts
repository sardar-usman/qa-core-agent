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
