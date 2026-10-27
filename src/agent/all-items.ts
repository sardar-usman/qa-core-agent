import type { TraceStep } from './trace.js';

/**
 * The all-items assertion (invariant 77, run 59540f D5).
 *
 * Run 7 shipped "[happy] search for term filtered list to only matching
 * product names" whose recording checked the FIRST card only; the name
 * claims every card. The all-items form says "no item in <list> fails to
 * match <pattern>" and is recorded as two checks on the same item locator:
 *   1. the items whose text does not match number exactly 0
 *      (`locator.filter({ hasNotText: /pattern/flags })` with toHaveCount(0)),
 *   2. the list has at least 1 item (toHaveCount atLeast 1), so an empty
 *      list can never pass.
 * The filter check is recorded first on purpose: a stale list shown before
 * the search lands satisfies "at least 1" at once, so the minimum read first
 * would let an empty result pass; read second, it holds only for the list
 * the filter check saw.
 *
 * RULE 7 still applies: the pattern is a value this scenario typed earlier
 * (a fill, or a search term in a navigate URL), compared case-insensitively
 * after escaping, never a literal the model wrote. The tool records the
 * escaped typed value with the 'i' flag, so the recorded pattern is the typed
 * value and nothing else.
 */

/** Flags every all-items pattern carries: case-insensitive. */
export const ALL_ITEMS_FLAGS = 'i';

/** Escape a typed value for a RegExp source (the escape selectors.escapeRegex applies). */
export function escapeForPattern(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The values a scenario typed before this point, latest last: every fill
 * value (a credential-marked fill and a generated fill excluded: the first
 * is never recorded, the second changes on every run, so the emitted pattern
 * could not match it), and every query parameter value of a navigate URL (a
 * search term the scenario opened the page with). Empty values are skipped.
 */
export function typedValues(priorSteps: TraceStep[]): string[] {
  const out: string[] = [];
  for (const s of priorSteps) {
    if (s.kind === 'fill') {
      if (s.credential || s.generate) continue;
      if (s.value.trim()) out.push(s.value.trim());
    } else if (s.kind === 'navigate') {
      let params: URLSearchParams | null = null;
      // A navigate url that does not parse carries no query values; nothing
      // typed is the honest reading, and the assertion is then refused.
      try { params = new URL(s.url).searchParams; } catch { params = null; }
      for (const v of params?.values() ?? []) if (v.trim()) out.push(v.trim());
    }
  }
  return out;
}

/**
 * The typed value an all-items pattern names, or null: the latest typed value
 * whose escaped form equals the pattern case-insensitively.
 */
export function typedValueForPattern(pattern: string, priorSteps: TraceStep[]): string | null {
  const want = pattern.toLowerCase();
  const typed = typedValues(priorSteps);
  for (let i = typed.length - 1; i >= 0; i--) {
    if (escapeForPattern(typed[i]!).toLowerCase() === want) return typed[i]!;
  }
  return null;
}
