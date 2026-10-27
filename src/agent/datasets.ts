import type { RunReport, Scenario, SelectorRecord, TraceStep } from './trace.js';
import type { RequirementsMap } from './requirements.js';
import { canonicalIntent } from './pom.js';
import { findHappyLoginScenario, recordedCredentials } from './auth-emit.js';
import { CREDENTIAL_REDACTION, envCredentialValues, maskDeep } from './credential-leak.js';

/**
 * Dataset extraction — turns a run's recorded fill values into per-feature
 * JSON datasets the emitted framework parameterizes over.
 *
 * For each feature, every scenario that filled form fields contributes one
 * named case: valid (happy scenarios), invalid (negative scenarios, carrying
 * every check the scenario recorded on its own error element: a literal
 * text, a pattern with its flags, and visibility), boundary (edge scenarios
 * probing a limit). Every case also carries each select_option value its
 * recording chose. When a RequirementsMap exists, validation rules stating
 * lengths or formats synthesize additional boundary/invalid cases with their
 * ruleIds.
 *
 * A case whose recorded error assertion cannot be carried (a check type the
 * data shape cannot express, an assertion before the last action, a captured
 * value, nothing asserted at all, or a rule-derived case with no recording)
 * is marked `uncarriable` with the reason: the POM emitter leaves it out of
 * the data file with one line naming it, and a recorded case ships as its
 * own test. It is never emitted with an empty expectation (invariant 77,
 * run 59540f D7b: the R14 email case asserted toContainText('')).
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

/**
 * One check an error case carries from its own recording (invariant 77): the
 * error element it asserted on, and what it asserted there. A text check
 * holds a non-empty literal or a pattern with its flags, never neither.
 */
export interface DatasetErrorCheck {
  /** The error element the recording asserted on; the emitter names it (the page-object field). */
  target: SelectorRecord;
  /** visible: toBeVisible; text: toHaveText; contains: toContainText. */
  check: 'visible' | 'text' | 'contains';
  /** The literal the recording asserted (text and contains), never empty. */
  text?: string;
  /** The pattern source the recording asserted (text and contains). */
  pattern?: string;
  /** The pattern's flags ('' for a recorded regex source). */
  flags?: string;
  /** The recorded timeout. */
  timeout?: number;
}

/** A select_option value a case's recording chose, with its match mode. */
export interface DatasetSelect {
  by: 'value' | 'label' | 'index' | 'auto';
  option: string;
}

export interface DatasetCase {
  name: string;
  /** field key (canonical intent) -> value or generator marker. */
  values: Record<string, string>;
  /** select key (canonical intent) -> every select_option value the recording chose. */
  selects?: Record<string, DatasetSelect>;
  expect: 'success' | 'error';
  /** An error case's own recorded checks, in order; never empty on a carried error case. */
  errors?: DatasetErrorCheck[];
  /** Why this case cannot be carried in a data file (invariant 77); the emitter leaves it out and says so. */
  uncarriable?: string;
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
  // The test account (invariant 70): its value lives in the env only.
  if (step.credential) return true;
  if (CREDENTIAL_INTENT_RE.test(step.target.intent)) return true;
  // Every fill inside a login flow fed a credential exchange; none of it is
  // reusable test data.
  return feature === 'login';
}

type FillStep = Extract<TraceStep, { kind: 'fill' }>;

/** The placeholder a redacted credential value carries (one constant, credential-leak.ts). */
export { CREDENTIAL_REDACTION };

/**
 * The credential values a run must never write where a diagnosis or a client
 * reads them. Built from:
 *   - the happy login among the shipped scenarios (as before),
 *   - the happy login among the dropped traces (a dropped happy login would
 *     otherwise leak its password into droppedTraces),
 *   - the values of every test-account variable in the env
 *     (QA_CORE_TEST_USER / QA_CORE_TEST_PASS and every host-scoped pair,
 *     QA_CORE_TEST_USER_<HOST> / QA_CORE_TEST_PASS_<HOST>, when set),
 *   - the set remembered on this report object when its dropped traces were
 *     attached (rememberCredentialSecrets), so a later stage that drops more
 *     scenarios still masks a password the earlier redaction already hid.
 * VALUE-BASED: wrong-credential test data never equals a real credential,
 * so it is never in the set (invariant 43).
 */
export function credentialSecrets(report: RunReport, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const out = new Set<string>(rememberedSecrets.get(report) ?? []);
  const addLogin = (login: Scenario | null): void => {
    if (!login) return;
    const creds = recordedCredentials(login);
    for (const v of [creds.user, creds.pass]) if (v !== undefined && v !== '') out.add(v);
  };
  addLogin(findHappyLoginScenario(report));
  const droppedAsScenarios = (report.droppedTraces ?? []).flatMap((t) => [
    { name: t.name, category: t.category ?? 'happy', feature: t.feature, steps: t.steps },
    ...(t.repairSteps ? [{ name: t.name, category: t.category ?? 'happy', feature: t.feature, steps: t.repairSteps }] : []),
  ]) as Scenario[];
  addLogin(findHappyLoginScenario({ ...report, scenarios: droppedAsScenarios }));
  for (const v of envCredentialValues(env)) out.add(v);
  out.delete(CREDENTIAL_REDACTION);
  return out;
}

// Secrets derived from raw traces, kept per report OBJECT and never
// serialized: once a dropped trace is redacted in memory, its happy-login
// password can no longer be read back from it.
const rememberedSecrets = new WeakMap<RunReport, Set<string>>();

/** Remember a secret set on this report object (see credentialSecrets). */
export function rememberCredentialSecrets(report: RunReport, secrets: Set<string>): void {
  rememberedSecrets.set(report, new Set([...(rememberedSecrets.get(report) ?? []), ...secrets]));
}

/** Steps with every fill whose value is a secret masked; other steps untouched. */
export function redactSteps(steps: TraceStep[], secret: Set<string>): TraceStep[] {
  return steps.map((st) => (st.kind === 'fill' && secret.has(st.value) ? { ...st, value: CREDENTIAL_REDACTION } : st));
}

/**
 * Dropped traces with their steps and repair steps redacted, and every other
 * string in them (a reason, an assertion's text) masked where it holds a
 * secret (invariant 70).
 */
export function redactDroppedTraces(traces: NonNullable<RunReport['droppedTraces']>, secret: Set<string>): NonNullable<RunReport['droppedTraces']> {
  if (secret.size === 0) return traces;
  const redacted = traces.map((t) => ({ ...t, steps: redactSteps(t.steps, secret), ...(t.repairSteps ? { repairSteps: redactSteps(t.repairSteps, secret) } : {}) }));
  return maskDeep(redacted, [...secret].sort((a, b) => b.length - a.length));
}

/**
 * A copy of the report with the REAL credential values masked, for the
 * run-report.json that ships INSIDE the framework zip (the deliverable a
 * client receives). VALUE-BASED: only fills whose value equals a credential
 * in credentialSecrets (the happy login's values, from the shipped scenarios
 * or the dropped traces, and the env credential variables) are redacted,
 * wherever they appear: the login scenario, an embedded leading login block,
 * a dropped trace. Wrong-credential test data (wrong_password, an empty
 * string, an injection payload) is deliberately KEPT: it is what the
 * negative test asserts against, not a secret. With no secret the report
 * passes through byte for byte. The input report is NOT mutated: the
 * working-directory run-report.json keeps the raw scenario values (its
 * droppedTraces are redacted when attached, invariant 69).
 */
export function redactCredentialValues(report: RunReport): RunReport {
  const secret = credentialSecrets(report);
  if (secret.size === 0) return report;
  const redacted: RunReport = {
    ...report,
    scenarios: report.scenarios.map((s) => ({ ...s, steps: redactSteps(s.steps, secret) })),
    ...(report.droppedTraces ? { droppedTraces: redactDroppedTraces(report.droppedTraces, secret) } : {}),
  };
  // Every other string too: a skip reason, a Critic reason, a finding's page
  // text (run 5's zip held the demo password twice in a skip reason).
  return maskDeep(redacted, [...secret].sort((a, b) => b.length - a.length));
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

/** A step that drives the page; the checks a data case carries sit after the last one. */
function isDataAction(st: TraceStep): boolean {
  return st.kind === 'click' || st.kind === 'fill' || st.kind === 'press' || st.kind === 'select_option' || st.kind === 'set_checked' || st.kind === 'set_input_files';
}

/**
 * Every check a scenario recorded on its error element(s), in order, or why
 * none can be carried. The data loop checks a case only after all its
 * actions, so an assertion before the last action, a captured value, a check
 * type the data shape cannot express, or an empty text cannot be carried;
 * neither can a recording that asserted nothing.
 */
export function recordedErrorChecks(s: Scenario): { checks: DatasetErrorCheck[] } | { reason: string } {
  let lastAction = -1;
  s.steps.forEach((st, i) => { if (isDataAction(st)) lastAction = i; });
  const checks: DatasetErrorCheck[] = [];
  for (let i = 0; i < s.steps.length; i++) {
    const st = s.steps[i]!;
    if (st.kind === 'capture' || st.kind === 'assert_compare') return { reason: `step ${i + 1} reads a captured value, which a data case cannot carry` };
    if (st.kind !== 'assert') continue;
    if (i < lastAction) return { reason: `step ${i + 1} asserts before the last action, which a data case cannot carry` };
    const a = st.assertion;
    const timeout = 'timeout' in a && typeof a.timeout === 'number' ? { timeout: a.timeout } : {};
    if (a.type === 'toBeVisible') {
      checks.push({ target: a.target, check: 'visible', ...timeout });
    } else if (a.type === 'toHaveText' || a.type === 'toContainText') {
      const check = a.type === 'toHaveText' ? 'text' : 'contains';
      if (a.pattern) checks.push({ target: a.target, check, pattern: a.pattern, flags: '', ...timeout });
      else if (a.text.trim()) checks.push({ target: a.target, check, text: a.text, ...timeout });
      else return { reason: `step ${i + 1} asserts an empty text, which proves nothing` };
    } else {
      return { reason: `step ${i + 1} asserts ${a.type}, which a data case cannot carry` };
    }
  }
  if (checks.length === 0) return { reason: 'its recording asserts nothing on an error element' };
  return { checks };
}

/** True when the scenario asserted a text (a literal or a pattern): an edge case that did is an error-expect case. */
function assertsText(s: Scenario): boolean {
  return s.steps.some((st) => st.kind === 'assert' && (st.assertion.type === 'toHaveText' || st.assertion.type === 'toContainText'));
}

/**
 * Every select_option value the scenario chose, keyed by the select's
 * canonical intent, or why it cannot be carried (the same select chose two
 * values: a key holds one).
 */
export function recordedSelects(s: Scenario): { selects: Record<string, DatasetSelect> } | { reason: string } {
  const out: Record<string, DatasetSelect> = {};
  for (const st of s.steps) {
    if (st.kind !== 'select_option') continue;
    const key = canonicalIntent(st.target.intent);
    const prev = out[key];
    if (prev && (prev.by !== st.by || prev.option !== st.option)) return { reason: `it selects ${JSON.stringify(key)} twice with different values, which a data case cannot carry` };
    out[key] = { by: st.by, option: st.option };
  }
  return { selects: out };
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
    // A scenario that types the test account reads it from the env; a data
    // case would carry no value for that field (invariant 70).
    if (s.steps.some((st) => st.kind === 'fill' && st.credential)) continue;
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
      // Every select value the recording chose travels with the case (run
      // 59540f: the R14 email case selected "warranty", the data loop reused
      // the happy case's "customer-service").
      const sel = recordedSelects(s);
      const selects = 'selects' in sel ? (Object.keys(sel.selects).length > 0 ? { selects: sel.selects } : {}) : {};
      const selectGap = 'reason' in sel ? sel.reason : undefined;
      // An error case carries its own recorded checks, or why it cannot.
      const errorPart = (): Pick<DatasetCase, 'errors' | 'uncarriable'> => {
        const rec = recordedErrorChecks(s);
        if ('reason' in rec) return { uncarriable: rec.reason };
        return selectGap ? { errors: rec.checks, uncarriable: selectGap } : { errors: rec.checks };
      };
      const gap = selectGap ? { uncarriable: selectGap } : {};
      if (s.category === 'happy') {
        cases.push({ name: s.name, values, ...selects, expect: 'success', ...gap, ...(ruleIdsOf(s)) });
      } else if (s.category === 'negative') {
        cases.push({ name: s.name, values, ...selects, expect: 'error', ...errorPart(), ...(ruleIdsOf(s)) });
      } else if (s.category === 'edge' && looksLikeBoundary(s, values)) {
        const isError = assertsText(s);
        cases.push({
          name: `boundary: ${s.name}`,
          values,
          ...selects,
          expect: isError ? 'error' : 'success',
          ...(isError ? errorPart() : gap),
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

/** Drop later cases whose values and select values duplicate an earlier case exactly. */
function dedupeCases(cases: DatasetCase[]): DatasetCase[] {
  const seen = new Set<string>();
  return cases.filter((c) => {
    const key = JSON.stringify(Object.entries(c.values).sort()) + '|' + JSON.stringify(Object.entries(c.selects ?? {}).sort()) + '|' + c.expect;
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
/**
 * Why a rule-derived error case is never carried: it has no recording, so no
 * error element and no asserted text (invariant 77). Before this it asserted
 * toContainText('') on another case's error element, which proves nothing.
 */
export const RULE_DERIVED_ERROR_UNCARRIABLE = 'a rule-derived case has no recording, so it carries no error assertion';

function enrichFromRules(feature: string, existing: DatasetCase[], map: RequirementsMap): DatasetCase[] {
  const baseline = existing.find((c) => c.expect === 'success' && !c.uncarriable);
  if (!baseline) return [];
  // A synthesized case fills the whole form from the baseline, select values included.
  const baseSelects = baseline.selects ? { selects: baseline.selects } : {};
  const noRecording = { uncarriable: RULE_DERIVED_ERROR_UNCARRIABLE };
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
        ...baseSelects,
        expect: 'success',
        ruleIds: [rule.id],
      });
      if (n > 1) {
        out.push({
          name: `invalid: ${field} one character under the ${n}-character minimum`,
          values: { ...baseline.values, [field]: 'x'.repeat(n - 1) },
          ...baseSelects,
          expect: 'error',
          ...noRecording,
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
        ...baseSelects,
        expect: 'success',
        ruleIds: [rule.id],
      });
      out.push({
        name: `invalid: ${field} one character over the ${n}-character maximum`,
        values: { ...baseline.values, [field]: 'x'.repeat(n + 1) },
        ...baseSelects,
        expect: 'error',
        ...noRecording,
        ruleIds: [rule.id],
      });
      continue;
    }
    if (EMAIL_FORMAT_RE.test(rule.text)) {
      out.push({
        name: `invalid: ${field} breaks the email format`,
        values: { ...baseline.values, [field]: 'not-an-email' },
        ...baseSelects,
        expect: 'error',
        ...noRecording,
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
export function renderDatasetJson(dataset: FeatureDataset, elementName: (target: SelectorRecord) => string = (t) => t.intent): string {
  const cases = dataset.cases.map((c) => {
    // Never write a case that cannot be carried, nor an error case with no
    // check or a text check with neither a literal nor a pattern (invariant
    // 77): it would assert nothing and look like a test.
    if (c.uncarriable) throw new EmptyDatasetExpectationError(c.name, c.uncarriable);
    if (c.expect === 'error' && (!c.errors || c.errors.length === 0)) throw new EmptyDatasetExpectationError(c.name, 'an error case with no recorded error assertion');
    for (const e of c.errors ?? []) {
      if (e.check !== 'visible' && e.pattern === undefined && !(e.text ?? '').trim()) throw new EmptyDatasetExpectationError(c.name, 'a text check with an empty expected text');
    }
    return {
      name: c.name,
      values: Object.fromEntries(Object.entries(c.values).sort(([a], [b]) => a.localeCompare(b))),
      ...(c.selects ? { selects: Object.fromEntries(Object.entries(c.selects).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.option])) } : {}),
      expect: c.expect,
      ...(c.errors ? {
        errors: c.errors.map((e) => ({
          element: elementName(e.target),
          check: e.check,
          ...(e.text !== undefined ? { text: e.text } : {}),
          ...(e.pattern !== undefined ? { pattern: e.pattern, flags: e.flags ?? '' } : {}),
          ...(e.timeout !== undefined ? { timeout: e.timeout } : {}),
        })),
      } : {}),
      ...(c.ruleIds !== undefined ? { ruleIds: c.ruleIds } : {}),
    };
  });
  return JSON.stringify(cases, null, 2) + '\n';
}

/**
 * Thrown when a data file would carry a case that asserts nothing: an
 * uncarriable case, an error case with no check, or a text check with no
 * literal and no pattern (invariant 77, standing rule 2). The POM emitter
 * leaves such cases out before rendering, so this is the last guard.
 */
export class EmptyDatasetExpectationError extends Error {
  constructor(caseName: string, why: string) {
    super(`refusing to write data case ${JSON.stringify(caseName)}: ${why}`);
    this.name = 'EmptyDatasetExpectationError';
  }
}
