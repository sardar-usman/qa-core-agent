/**
 * Locks dataset extraction (src/agent/datasets.ts):
 *   - happy -> valid case, negative -> invalid case with asserted errorText,
 *     edge -> boundary case when the data plausibly probes a limit
 *   - SRS validation rules synthesize boundary/invalid cases carrying ruleIds
 *   - credential exclusion: password fields never appear, the login feature
 *     contributes no dataset at all
 *   - generated-unique fields keep their generator marker, not the literal
 *   - renderDatasetJson is pretty-printed with stable key order
 *
 * Pure fixtures. No network. No LLM. No browser.
 */
import { deriveDatasets, renderDatasetJson, GENERATOR_MARKERS, isCredentialFill, RULE_DERIVED_ERROR_UNCARRIABLE } from '../src/agent/datasets.js';
import type { RunReport, Scenario, TraceStep } from '../src/agent/trace.js';
import type { RequirementsMap } from '../src/agent/requirements.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const fill = (intent: string, value: string, generate?: 'email' | 'token'): TraceStep =>
  ({ kind: 'fill', target: { level: 'label', arg: intent, intent }, value, ...(generate ? { generate } : {}) } as TraceStep);
const click = (intent: string): TraceStep =>
  ({ kind: 'click', target: { level: 'role', arg: { role: 'button', name: intent }, intent } } as TraceStep);
const errAssert = (text: string): TraceStep =>
  ({ kind: 'assert', name: 'error shown', assertion: { type: 'toContainText', target: { level: 'css', arg: '.error', intent: 'error message' }, text } } as TraceStep);
const sc = (name: string, category: Scenario['category'], feature: string, steps: TraceStep[]): Scenario =>
  ({ name, category, feature, steps } as Scenario);

const report = {
  url: 'https://shop.example/',
  language: 'ts',
  scenarios: [
    sc('sent the contact form', 'happy', 'contact', [
      fill('name input', 'Ada Lovelace'),
      fill('email input', 'qa+recorded@shop.example', 'email'),
      fill('message textarea', 'A perfectly reasonable inquiry.'),
      click('send button'),
    ]),
    sc('rejected a malformed email', 'negative', 'contact', [
      fill('name input', 'Ada Lovelace'),
      fill('email input', 'nope@'),
      fill('message textarea', 'A perfectly reasonable inquiry.'),
      click('send button'),
      errAssert('Please enter a valid email'),
    ]),
    sc('accepted a message at the 200 character limit', 'edge', 'contact', [
      fill('name input', 'Ada Lovelace'),
      fill('email input', 'edge@shop.example'),
      fill('message textarea', 'x'.repeat(200)),
      click('send button'),
    ]),
    // The login feature never contributes a dataset.
    sc('logged in with valid credentials', 'happy', 'login', [
      fill('username input', 'standard_user'),
      fill('password input', 'secret_sauce'),
      click('login button'),
    ]),
    // Password fields are excluded even outside the login feature.
    sc('registered a new account', 'happy', 'registration', [
      fill('email input', 'reg@shop.example', 'email'),
      fill('password input', 'S3cret!Pass'),
      fill('display name input', 'Ada'),
      click('register button'),
    ]),
  ],
} as unknown as RunReport;

/* ─── A. grouping by category ──────────────────────────────────────────────── */
const datasets = deriveDatasets(report);
const contact = datasets.find((d) => d.feature === 'contact');
check('A1. the contact feature yields a dataset', contact !== undefined && contact.cases.length === 3, JSON.stringify(contact?.cases.map((c) => c.name)));
const valid = contact?.cases.find((c) => c.expect === 'success' && !c.name.startsWith('boundary:'));
check('A2. the happy scenario becomes a valid case', valid?.values['message textarea'] === 'A perfectly reasonable inquiry.');
const invalid = contact?.cases.find((c) => c.expect === 'error');
check('A3. the negative scenario carries its recorded error check: the literal, on its own error element',
  invalid?.errors?.length === 1 && invalid.errors[0]!.check === 'contains' && invalid.errors[0]!.text === 'Please enter a valid email' && invalid.errors[0]!.target.arg === '.error' && invalid.values['email'] === 'nope@' && invalid.uncarriable === undefined, JSON.stringify(invalid));
const boundary = contact?.cases.find((c) => c.name.startsWith('boundary:'));
check('A4. the edge scenario probing a limit becomes a boundary case',
  boundary !== undefined && boundary.values['message textarea']?.length === 200 && boundary.expect === 'success');

/* ─── B. credential exclusion ──────────────────────────────────────────────── */
check('B1. the login feature contributes NO dataset', !datasets.some((d) => d.feature === 'login'));
const reg = datasets.find((d) => d.feature === 'registration');
check('B2. password fields are excluded from other features',
  reg !== undefined && reg.cases.every((c) => !Object.keys(c.values).some((k) => /password/i.test(k))), JSON.stringify(reg));
check('B3. non-credential fields of that scenario survive', reg?.cases[0]?.values['display name'] === 'Ada' || reg?.cases[0]?.values['display name input'] === 'Ada', JSON.stringify(reg?.cases[0]?.values));
check('B4. isCredentialFill flags password intents and login-feature fills',
  isCredentialFill(fill('password input', 'x') as Extract<TraceStep, { kind: 'fill' }>, 'registration') &&
  isCredentialFill(fill('username input', 'x') as Extract<TraceStep, { kind: 'fill' }>, 'login') &&
  !isCredentialFill(fill('email input', 'x') as Extract<TraceStep, { kind: 'fill' }>, 'contact'));
check('B5. no dataset value anywhere carries the recorded password', JSON.stringify(datasets).includes('secret_sauce') === false && JSON.stringify(datasets).includes('S3cret!Pass') === false);

/* ─── C. generator preservation ────────────────────────────────────────────── */
check('C1. a generated email keeps its marker, not the recorded literal',
  valid?.values['email'] === GENERATOR_MARKERS['email'] && !JSON.stringify(valid).includes('qa+recorded'));

/* ─── D. SRS-rule enrichment ───────────────────────────────────────────────── */
const map: RequirementsMap = {
  features: [{
    name: 'contact',
    description: 'contact form',
    rules: [
      { id: 'R1', text: 'The message must be at least 20 characters.', type: 'validation' },
      { id: 'R2', text: 'The email must be a valid email address format.', type: 'validation' },
      { id: 'R3', text: 'Submitting navigates to a thank-you page.', type: 'navigation' },
      { id: 'R4', text: 'The captcha must be solved.', type: 'validation' },
    ],
  }],
  roles: [],
  truncated: false,
};
const enriched = deriveDatasets(report, map).find((d) => d.feature === 'contact');
const minBoundary = enriched?.cases.find((c) => c.name.includes('20-character minimum') && c.expect === 'success');
const minInvalid = enriched?.cases.find((c) => c.name.includes('under the 20-character minimum'));
check('D1. a min-length rule synthesizes an at-limit boundary case with its ruleId',
  minBoundary?.values['message textarea']?.length === 20 && minBoundary.ruleIds?.[0] === 'R1', JSON.stringify(minBoundary));
check('D2. and an under-limit invalid case', minInvalid?.values['message textarea']?.length === 19 && minInvalid.expect === 'error');
check('D3. a format rule synthesizes an invalid case (but never overrides a generator)',
  // email is a generated field in the baseline, so the format rule is skipped for it.
  !enriched?.cases.some((c) => c.values['email'] === 'not-an-email'));
check('D4. rules matching no recorded field are skipped (captcha, navigation)',
  !JSON.stringify(enriched).includes('R3') && !JSON.stringify(enriched).includes('R4'));
check('D5. non-message fields in synthesized cases keep the valid baseline', minInvalid?.values['name'] === 'Ada Lovelace');

check('D6. a rule-derived invalid case has no recording, so it is marked uncarriable, never given an empty error expectation (invariant 77)',
  minInvalid?.uncarriable === RULE_DERIVED_ERROR_UNCARRIABLE && minInvalid.errors === undefined, JSON.stringify(minInvalid));

/* ─── E. serialization ─────────────────────────────────────────────────────── */
// Only carried cases are written; the POM emitter leaves the others out with a line.
const carried = enriched!.cases.filter((c) => !c.uncarriable);
const json = renderDatasetJson({ feature: 'contact', cases: carried });
const parsed = JSON.parse(json) as Array<Record<string, unknown>>;
check('E1. the data file parses and is pretty-printed', Array.isArray(parsed) && json.includes('\n  '));
check('E2. case keys come in a stable order (name, values, expect, ...)',
  JSON.stringify(Object.keys(parsed[0]!)) === JSON.stringify(['name', 'values', 'expect']) ||
  JSON.stringify(Object.keys(parsed[0]!).slice(0, 3)) === JSON.stringify(['name', 'values', 'expect']), JSON.stringify(Object.keys(parsed[0]!)));
check('E3. value keys are sorted alphabetically',
  JSON.stringify(Object.keys((parsed[0] as { values: Record<string, string> }).values)) ===
  JSON.stringify(Object.keys((parsed[0] as { values: Record<string, string> }).values).sort()));
check('E4. serialization is deterministic', json === renderDatasetJson({ feature: 'contact', cases: carried }));
const errorRow = parsed.find((c) => c['expect'] === 'error') as { errors?: Array<Record<string, unknown>>; errorText?: unknown } | undefined;
check('E5. an error case is written with its own checks (element, check, text), never an errorText',
  errorRow?.errorText === undefined && JSON.stringify(errorRow?.errors) === JSON.stringify([{ element: 'error message', check: 'contains', text: 'Please enter a valid email' }]), JSON.stringify(errorRow));
let threw = '';
try { renderDatasetJson({ feature: 'contact', cases: enriched!.cases }); } catch (e) { threw = (e as Error).name + ': ' + (e as Error).message; }
check('E6. writing a case that cannot be carried throws EmptyDatasetExpectationError naming it and its reason',
  threw === `EmptyDatasetExpectationError: refusing to write data case "invalid: message textarea one character under the 20-character minimum": ${RULE_DERIVED_ERROR_UNCARRIABLE}`, threw);
// An uncarriable case that does carry checks (its select value could not be
// carried) is refused for that reason, not written with the wrong select.
let threwSelect = '';
try { renderDatasetJson({ feature: 'contact', cases: [{ name: 'select gap', values: { a: 'b' }, expect: 'error', errors: [{ target: { level: 'css', arg: '.e', intent: 'e' }, check: 'visible' }], uncarriable: 'it selects "subject" twice with different values' }] }); } catch (e) { threwSelect = (e as Error).message; }
check('E8. an uncarriable case with checks is refused for its own reason', threwSelect === 'refusing to write data case "select gap": it selects "subject" twice with different values', threwSelect);
let threwEmpty = '';
try { renderDatasetJson({ feature: 'contact', cases: [{ name: 'empty', values: { a: 'b' }, expect: 'error', errors: [{ target: { level: 'css', arg: '.e', intent: 'e' }, check: 'contains', text: '' }] }] }); } catch (e) { threwEmpty = (e as Error).name; }
check('E7. writing a text check with an empty expected text throws', threwEmpty === 'EmptyDatasetExpectationError', threwEmpty);

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: datasets group valid/invalid/boundary cases, enrich from SRS rules with ruleIds, exclude credentials, and keep generator markers.');
