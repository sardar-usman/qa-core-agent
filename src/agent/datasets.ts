import type { RunReport, Scenario, TraceStep } from './trace.js';
import type { RequirementsMap } from './requirements.js';
import { canonicalIntent } from './pom.js';
import { findHappyLoginScenario, recordedCredentials } from './auth-emit.js';

/**
 * Dataset extraction — turns a run's recorded fill values into per-feature
 * JSON datasets the emitted framework parameterizes over.
 *
 * For each feature, every scenario that filled form fields contributes one
 * named case: valid (happy scenarios), invalid (negative scenarios, carrying
 * the error text the scenario asserted), boundary (edge scenarios probing a
 * limit). When a RequirementsMap exists, validation rules stating lengths or
 * formats synthesize additional boundary/invalid cases with their ruleIds.
 *
 * Hard exclusions:
 * - Credential-like values NEVER land in a dataset: password-intent fields
 *   are dropped everywhere, and the login feature contributes no dataset at
 *   all (its fills fed a login flow). Emitted specs reference credentials as
 *   env placeholders instead (see auth-emit.ts).
 * - A generated-unique field keeps its generator reference ({{uniqueEmail}} /
 *   {{uniqueToken}}), never the literal the run happened to use, so every
 *   replay of the dataset gets a fresh value.
 */

export interface DatasetCase {
  name: string;
  /** field key (canonical intent) -> value or generator marker. */
  values: Record<string, string>;
  expect: 'success' | 'error';
  errorText?: string;
  ruleIds?: string[];
}

export interface FeatureDataset {
  feature: string;
  cases: DatasetCase[];
}

/** Generator markers a dataset value may carry instead of a literal. */
export const GENERATOR_MARKERS: Record<string, string> = {
  email: '{{uniqueEmail}}',
  token: '{{uniqueToken}}',
};

const CREDENTIAL_INTENT_RE = /passw(or)?d|passcode/i;

/** True when this fill must never appear in a dataset. */
export function isCredentialFill(step: Extract<TraceStep, { kind: 'fill' }>, feature: string | undefined): boolean {
  if (CREDENTIAL_INTENT_RE.test(step.target.intent)) return true;
  // Every fill inside a login flow fed a credential exchange; none of it is
  // reusable test data.
  return feature === 'login';
}

type FillStep = Extract<TraceStep, { kind: 'fill' }>;

/** The placeholder a redacted credential fill value carries. */
export const CREDENTIAL_REDACTION = '[redacted:credential]';

/**
 * A copy of the report with the REAL credential values masked, for the
 * run-report.json that ships INSIDE the framework zip (the deliverable a
 * client receives). VALUE-BASED: only fills whose value equals a credential
 * the happy login used (the values the setup project reads from env) are
 * redacted, wherever they appear — the login scenario, an embedded leading
 * login block, anywhere. Wrong-credential test data (wrong_password, an
 * empty string, an injection payload) is deliberately KEPT: it is what the
 * negative test asserts against, not a secret. Without a happy login there
 * are no real credentials to mask and the report passes through byte for
 * byte. The input report is NOT mutated: the working-directory
 * run-report.json keeps the raw values.
 */
export function redactCredentialValues(report: RunReport): RunReport {
  const login = findHappyLoginScenario(report);
  if (!login) return report;
  const creds = recordedCredentials(login);
  const secret = new Set([creds.user, creds.pass].filter((v): v is string => v !== undefined && v !== ''));
  if (secret.size === 0) return report;
  return {
    ...report,
    scenarios: report.scenarios.map((s) => ({
      ...s,
      steps: s.steps.map((st) =>
        st.kind === 'fill' && secret.has(st.value)
          ? { ...st, value: CREDENTIAL_REDACTION }
          : st,
      ),
    })),
  };
}

/** The dataset-relevant fills of a scenario, keyed by canonical intent. */
function fillValues(scenario: Scenario): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const step of scenario.steps) {
    if (step.kind !== 'fill') continue;
    if (isCredentialFill(step, scenario.feature)) continue;
    if (step.generate === 'password') continue; // credential generator: never a dataset value
    const key = canonicalIntent(step.target.intent);
    out[key] = step.generate ? (GENERATOR_MARKERS[step.generate] ?? step.value) : step.value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** First asserted error text in the scenario (toHaveText/toContainText). */
function assertedErrorText(scenario: Scenario): string | undefined {
  for (const step of scenario.steps) {
    if (step.kind !== 'assert') continue;
    const a = step.assertion;
    if ((a.type === 'toHaveText' || a.type === 'toContainText') && a.text.trim()) return a.text;
  }
  return undefined;
}

/** Does an edge scenario's data plausibly probe a limit? */
function looksLikeBoundary(scenario: Scenario, values: Record<string, string>): boolean {
  if (/boundar|limit|min(imum)?|max(imum)?|length|character|exactly|edge/i.test(scenario.name)) return true;
  return Object.values(values).some((v) => !v.startsWith('{{') && (v.length <= 2 || v.length >= 20));
}

/**
 * Derive per-feature datasets from the emitted scenarios, enriched from the
 * requirements map's validation rules when one exists.
 */
export function deriveDatasets(report: RunReport, map?: RequirementsMap): FeatureDataset[] {
  const byFeature = new Map<string, Scenario[]>();
  for (const s of report.scenarios) {
    if (!s.feature || s.feature === 'login') continue;
    const list = byFeature.get(s.feature) ?? [];
    list.push(s);
    byFeature.set(s.feature, list);
  }

  const out: FeatureDataset[] = [];
  for (const [feature, scenarios] of byFeature) {
    const cases: DatasetCase[] = [];
    for (const s of scenarios) {
      const values = fillValues(s);
      if (!values) continue;
      const errorText = assertedErrorText(s);
      if (s.category === 'happy') {
        cases.push({ name: s.name, values, expect: 'success', ...(ruleIdsOf(s)) });
      } else if (s.category === 'negative') {
        cases.push({ name: s.name, values, expect: 'error', ...(errorText ? { errorText } : {}), ...(ruleIdsOf(s)) });
      } else if (s.category === 'edge' && looksLikeBoundary(s, values)) {
        cases.push({
          name: `boundary: ${s.name}`,
          values,
          expect: errorText ? 'error' : 'success',
          ...(errorText ? { errorText } : {}),
          ...(ruleIdsOf(s)),
        });
      }
    }
    if (map) {
      cases.push(...enrichFromRules(feature, cases, map));
    }
    if (cases.length > 0) out.push({ feature, cases: dedupeCases(cases) });
  }
  return out;
}

function ruleIdsOf(s: Scenario): { ruleIds?: string[] } {
  return s.ruleIds && s.ruleIds.length > 0 ? { ruleIds: [...s.ruleIds] } : {};
}

/** Drop later cases whose values duplicate an earlier case exactly. */
function dedupeCases(cases: DatasetCase[]): DatasetCase[] {
  const seen = new Set<string>();
  return cases.filter((c) => {
    const key = JSON.stringify(Object.entries(c.values).sort()) + '|' + c.expect;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const MIN_LEN_RE = /(?:at least|minimum(?: of)?|min(?:imum)?(?: length)?(?: of)?|no (?:fewer|less) than)\s+(\d+)\s*characters?/i;
const MAX_LEN_RE = /(?:at most|maximum(?: of)?|max(?:imum)?(?: length)?(?: of)?|no (?:more|longer) than|up to)\s+(\d+)\s*characters?/i;
const EMAIL_FORMAT_RE = /valid e-?mail|e-?mail (?:address )?format|format of an e-?mail/i;

/**
 * Which recorded field a validation rule constrains: the field key sharing a
 * word with the rule text. Credential fields never match (they are excluded
 * from datasets outright).
 */
function fieldForRule(ruleText: string, fieldKeys: string[]): string | undefined {
  const text = ruleText.toLowerCase();
  return fieldKeys.find((key) => {
    if (CREDENTIAL_INTENT_RE.test(key)) return false;
    return key.split(' ').some((word) => word.length >= 3 && text.includes(word));
  });
}

/**
 * Synthesize boundary/invalid cases from stated validation rules. Each
 * synthesized case starts from the first valid (happy) case's values, so the
 * whole form still fills, and overrides only the constrained field. Without a
 * valid baseline nothing is synthesized (a partial form proves nothing).
 */
function enrichFromRules(feature: string, existing: DatasetCase[], map: RequirementsMap): DatasetCase[] {
  const baseline = existing.find((c) => c.expect === 'success');
  if (!baseline) return [];
  const fieldKeys = Object.keys(baseline.values);
  const featureRules = map.features.find((f) => f.name === feature)?.rules ?? [];
  const out: DatasetCase[] = [];

  for (const rule of featureRules) {
    if (rule.type !== 'validation') continue;
    const field = fieldForRule(rule.text, fieldKeys);
    if (!field) continue;
    if (baseline.values[field]?.startsWith('{{')) continue; // do not override a generator

    const min = rule.text.match(MIN_LEN_RE);
    if (min?.[1]) {
      const n = Number(min[1]);
      out.push({
        name: `boundary: ${field} at the ${n}-character minimum`,
        values: { ...baseline.values, [field]: 'x'.repeat(n) },
        expect: 'success',
        ruleIds: [rule.id],
      });
      if (n > 1) {
        out.push({
          name: `invalid: ${field} one character under the ${n}-character minimum`,
          values: { ...baseline.values, [field]: 'x'.repeat(n - 1) },
          expect: 'error',
          ruleIds: [rule.id],
        });
      }
      continue;
    }
    const max = rule.text.match(MAX_LEN_RE);
    if (max?.[1]) {
      const n = Number(max[1]);
      out.push({
        name: `boundary: ${field} at the ${n}-character maximum`,
        values: { ...baseline.values, [field]: 'x'.repeat(n) },
        expect: 'success',
        ruleIds: [rule.id],
      });
      out.push({
        name: `invalid: ${field} one character over the ${n}-character maximum`,
        values: { ...baseline.values, [field]: 'x'.repeat(n + 1) },
        expect: 'error',
        ruleIds: [rule.id],
      });
      continue;
    }
    if (EMAIL_FORMAT_RE.test(rule.text)) {
      out.push({
        name: `invalid: ${field} breaks the email format`,
        values: { ...baseline.values, [field]: 'not-an-email' },
        expect: 'error',
        ruleIds: [rule.id],
      });
    }
  }
  return out;
}

/**
 * Serialize a dataset for data/<feature>.json: pretty-printed, stable key
 * order (case fields in a fixed order, value keys alphabetical) so re-running
 * the emitter is byte-identical.
 */
export function renderDatasetJson(dataset: FeatureDataset): string {
  const cases = dataset.cases.map((c) => ({
    name: c.name,
    values: Object.fromEntries(Object.entries(c.values).sort(([a], [b]) => a.localeCompare(b))),
    expect: c.expect,
    ...(c.errorText !== undefined ? { errorText: c.errorText } : {}),
    ...(c.ruleIds !== undefined ? { ruleIds: c.ruleIds } : {}),
  }));
  return JSON.stringify(cases, null, 2) + '\n';
}
