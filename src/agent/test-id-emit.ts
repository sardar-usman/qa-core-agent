/**
 * Test ids emitted as getByTestId (invariant 73).
 *
 * The resolver tries Playwright's default `data-testid` first and records a
 * `data-test` match as css `[data-test="x"]` (selectors.ts, step 7), so a
 * data-test site's framework ships `page.locator('[data-test="x"]')` where a
 * Playwright user would write `page.getByTestId("x")` with
 * `testIdAttribute: 'data-test'` in the config.
 *
 * The decision reads the shipped scenarios' recorded steps only: when every
 * exact-match test-id css selector (`[data-test="x"]` or `[data-testid="x"]`)
 * uses data-test AND no step was recorded at level testid (which reads the
 * default data-testid), those selectors become level testid and the emitted
 * config sets testIdAttribute. Mixed attributes, or none, emit exactly as
 * before. A prefix or partial selector (`[data-test^="product-"]`) and any
 * selector that is more than one exact attribute stay css in every case.
 */
import type { RunReport, Scenario, SelectorRecord } from './trace.js';

/** The attribute the emitted framework's getByTestId reads, when not Playwright's default. */
export type EmittedTestIdAttribute = 'data-test';

// One exact attribute selector and nothing else: [data-test="x"], [data-test='x'],
// [data-testid="x"]. A prefix (^=), suffix ($=), substring (*=), a tag or a
// descendant part is not an exact-match test-id selector.
const EXACT_TEST_ID_RE = /^\[(data-testid|data-test)=(["'])((?:\\.|(?!\2).)*)\2\]$/;

/** The attribute and the id of an exact-match test-id css selector, or null. */
export function exactTestIdSelector(css: string): { attribute: 'data-test' | 'data-testid'; id: string } | null {
  const m = EXACT_TEST_ID_RE.exec(css.trim());
  if (!m) return null;
  return { attribute: m[1] as 'data-test' | 'data-testid', id: m[3]!.replace(/\\(.)/g, '$1') };
}

function isSelectorRecord(v: unknown): v is SelectorRecord {
  return typeof v === 'object' && v !== null && 'level' in v && 'arg' in v && typeof (v as { level: unknown }).level === 'string';
}

/** Every selector record a scenario's steps carry (targets, assertion targets, read targets), found by a walk. */
function selectorRecords(scenarios: Scenario[]): SelectorRecord[] {
  const out: SelectorRecord[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v !== 'object' || v === null) return;
    if (isSelectorRecord(v)) { out.push(v); return; }
    for (const x of Object.values(v)) walk(x);
  };
  for (const s of scenarios) walk(s.steps);
  return out;
}

/**
 * The attribute the emitted framework should set, or null to emit as today.
 * 'data-test' only when at least one exact-match test-id css selector exists,
 * every one of them uses data-test, and no record sits at level testid.
 */
export function decideTestIdAttribute(scenarios: Scenario[]): EmittedTestIdAttribute | null {
  const records = selectorRecords(scenarios);
  if (records.some((r) => r.level === 'testid')) return null;
  const exact = records
    .filter((r) => r.level === 'css' && typeof r.arg === 'string')
    .map((r) => exactTestIdSelector(r.arg as string))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (exact.length === 0) return null;
  return exact.every((x) => x.attribute === 'data-test') ? 'data-test' : null;
}

/**
 * The report the emitters write from, plus the attribute for the config.
 * With an attribute, a deep copy of the report whose shipped scenarios carry
 * every exact `[data-test="x"]` css record as level testid with arg x (the
 * intent, ambiguity, frame chain, filter text and element key kept). Without
 * one, the report itself, untouched, so the output is byte-identical.
 */
export function applyTestIdAttribute(report: RunReport): { report: RunReport; testIdAttribute: EmittedTestIdAttribute | null } {
  const attribute = decideTestIdAttribute(report.scenarios);
  if (!attribute) return { report, testIdAttribute: null };
  const rewrite = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(rewrite);
    if (typeof v !== 'object' || v === null) return v;
    if (isSelectorRecord(v)) {
      const exact = v.level === 'css' && typeof v.arg === 'string' ? exactTestIdSelector(v.arg) : null;
      return exact ? { ...v, level: 'testid', arg: exact.id } : { ...v };
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
  };
  const scenarios = report.scenarios.map((s) => ({ ...s, steps: rewrite(s.steps) as Scenario['steps'] }));
  return { report: { ...report, scenarios }, testIdAttribute: attribute };
}
