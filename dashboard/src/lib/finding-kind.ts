/**
 * The finding kinds the API carries (invariant 67). `product`: the expected
 * outcome never occurred, product behavior to review. `locator`: the element
 * could not be found, a limit of the run, never counted in To review.
 *
 * LOCATOR_EXPECTED_PREFIX mirrors src/agent/finding-kind.ts (the dashboard
 * does not import from the engine); scripts/smoke-projects.ts locks the two
 * values equal. No `@/` imports here so a smoke can load this file under tsx.
 */
export type FindingKind = 'product' | 'locator';

export const LOCATOR_EXPECTED_PREFIX = 'locate element: ';

/** The element a locator finding looked for: its `expected` without the prefix. */
export function elementLookedFor(expected: string): string {
  return expected.startsWith(LOCATOR_EXPECTED_PREFIX) ? expected.slice(LOCATOR_EXPECTED_PREFIX.length) : expected;
}
