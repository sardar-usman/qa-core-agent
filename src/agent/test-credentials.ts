import type { RequirementsMap } from './requirements.js';
import type { CredentialMarker, RunReport, Scenario, TraceStep } from './trace.js';
import { CREATION_FLOW_RE, DUPLICATE_EMAIL_RE, FORGOT_FLOW_RE, LOGIN_NAME_RE } from './unique-data.js';

export { FORGOT_FLOW_RE };

/**
 * The dedicated test account (invariant 70).
 *
 * Login scenarios sign in with an account the client supplies through the
 * host .env, never with a value the model types. The model passes a marker
 * (`credential: 'user' | 'pass'` on fill); every stage reads the value from
 * the env at the moment it fills, and no stage records it.
 *
 * Variable names. For a run against host H, the host-scoped pair
 * QA_CORE_TEST_USER_<H> / QA_CORE_TEST_PASS_<H> is tried first (H is the
 * host uppercased with every non-alphanumeric character as _, so
 * practicesoftwaretesting.com is PRACTICESOFTWARETESTING_COM), then the same
 * host without a leading www., then the generic QA_CORE_TEST_USER /
 * QA_CORE_TEST_PASS. Both values always come from ONE pair: a host pair with
 * only one half set is reported and never completed from another pair. The
 * console names the variables, never the values.
 */

export const TEST_USER_VAR = 'QA_CORE_TEST_USER';
export const TEST_PASS_VAR = 'QA_CORE_TEST_PASS';

export interface TestCredentials {
  user: string;
  pass: string;
  /** The env variable names the values came from (printed; the values never are). */
  userVar: string;
  passVar: string;
  scope: 'host' | 'generic';
}

export interface CredentialResolution {
  creds: TestCredentials | null;
  /** One console line naming the variables used (or why none were), never a value. */
  line: string;
}

/** HOST as the variable suffix: uppercased, every non-alphanumeric character as _. */
export function hostEnvSuffix(host: string): string {
  return host.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** The host-scoped variable pairs tried for a run URL, most specific first. */
export function hostCredentialVars(url: string | undefined): Array<{ userVar: string; passVar: string }> {
  const host = hostOf(url);
  if (!host) return [];
  const hosts = [host];
  if (host.startsWith('www.') && host.length > 4) hosts.push(host.slice(4));
  return hosts.map((h) => ({ userVar: `${TEST_USER_VAR}_${hostEnvSuffix(h)}`, passVar: `${TEST_PASS_VAR}_${hostEnvSuffix(h)}` }));
}

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name];
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Which pair of variables holds the test account for this run, and the one
 * line that says so. Never prints a value.
 */
export function resolveTestCredentials(env: NodeJS.ProcessEnv, url: string | undefined): CredentialResolution {
  for (const pair of hostCredentialVars(url)) {
    const user = nonEmpty(env, pair.userVar);
    const pass = nonEmpty(env, pair.passVar);
    if (user && pass) {
      return { creds: { user, pass, ...pair, scope: 'host' }, line: `test credentials: ${pair.userVar} / ${pair.passVar} (host-scoped)` };
    }
    if (user || pass) {
      const set = user ? pair.userVar : pair.passVar;
      const missing = user ? pair.passVar : pair.userVar;
      return {
        creds: null,
        line: `test credentials not provided: ${set} is set but ${missing} is not; a host pair is never completed from another pair`,
      };
    }
  }
  const user = nonEmpty(env, TEST_USER_VAR);
  const pass = nonEmpty(env, TEST_PASS_VAR);
  if (user && pass) {
    return { creds: { user, pass, userVar: TEST_USER_VAR, passVar: TEST_PASS_VAR, scope: 'generic' }, line: `test credentials: ${TEST_USER_VAR} / ${TEST_PASS_VAR}` };
  }
  const hostNames = hostCredentialVars(url).map((p) => `${p.userVar} / ${p.passVar}`);
  const names = [...hostNames, `${TEST_USER_VAR} / ${TEST_PASS_VAR}`].join(', ');
  if (user || pass) {
    return { creds: null, line: `test credentials not provided: ${user ? TEST_USER_VAR : TEST_PASS_VAR} is set but ${user ? TEST_PASS_VAR : TEST_USER_VAR} is not` };
  }
  return { creds: null, line: `test credentials not provided (none of ${names} is set)` };
}

/** Both values from one pair, or null. */
export function readTestCredentials(env: NodeJS.ProcessEnv, url: string | undefined): TestCredentials | null {
  return resolveTestCredentials(env, url).creds;
}

/** The env value a marker reads. */
export function credentialValue(creds: Pick<TestCredentials, 'user' | 'pass'>, marker: CredentialMarker): string {
  return marker === 'user' ? creds.user : creds.pass;
}

/** The reason a marked step cannot run without the test account. */
export const CREDENTIALS_NOT_PROVIDED = 'test credentials not provided';

/* ─── retired names ─────────────────────────────────────────────────────── */

export const RETIRED_AUTH_LINE = 'QA_CORE_AUTH_* is retired; use QA_CORE_TEST_USER / QA_CORE_TEST_PASS';
let retiredWarned = false;

/**
 * The one line printed when any QA_CORE_AUTH_* variable is set, once per
 * process; null otherwise and on every later call. Those names drove the
 * repo's own tests/auth.setup.ts, retired with the runtime's loading of
 * playwright/.auth/user.json.
 */
export function retiredAuthEnvLine(env: NodeJS.ProcessEnv = process.env): string | null {
  if (retiredWarned) return null;
  if (!Object.keys(env).some((k) => k.startsWith('QA_CORE_AUTH_') && env[k] !== undefined)) return null;
  retiredWarned = true;
  return RETIRED_AUTH_LINE;
}

/** Test seam: forget that the retired line was printed. */
export function resetRetiredAuthWarning(): void { retiredWarned = false; }

/* ─── which scenarios use the account ───────────────────────────────────── */

/** A reset that names a registered account needs that account's inbox: skipped, never sent to the test account. */
export const NEEDS_INBOX_RE = /\b(?:registered|existing|known)\b/i;
const WRONG_PASSWORD_NAME_RE = /(?:wrong|incorrect|invalid|bad|mistyped|mismatched)[\s_-]+password|password[\s_-]+(?:is[\s_-]+|was[\s_-]+)?(?:wrong|incorrect|invalid)/i;
const ACCOUNT_WORD_RE = /e[\s_-]?mail|account|user/i;
const PASSWORD_FIELD_RE = /pass[\s_-]?word|\bpasswd\b|\bpwd\b|passcode/i;

/** A login flow by its name or feature tag; a sign-up or forgot-password flow is not one. */
export function isLoginFlow(s: Pick<Scenario, 'name'> & { feature?: string }): boolean {
  if (CREATION_FLOW_RE.test(s.name) || FORGOT_FLOW_RE.test(s.name)) return false;
  return LOGIN_NAME_RE.test(s.name) || s.feature === 'login';
}

/**
 * Why a planned scenario needs the test account, or null: a happy login, a
 * wrong-password negative (the test account's identifier with a wrong
 * password), a duplicate-email negative (the account's email as the
 * existing one). Without credentials these are skipped before the Explorer.
 */
export function needsTestAccount(s: Pick<Scenario, 'name' | 'category'> & { feature?: string }): string | null {
  if (s.category === 'happy' && isLoginFlow(s)) return 'a happy login';
  if (s.category === 'negative' && isLoginFlow(s) && WRONG_PASSWORD_NAME_RE.test(s.name)) return 'a wrong-password negative';
  if ((s.category === 'negative' || s.category === 'edge') && DUPLICATE_EMAIL_RE.test(s.name) && ACCOUNT_WORD_RE.test(s.name)) return 'a duplicate-email negative';
  return null;
}

/** The plan line printed when credentials are missing. */
export function missingCredentialsPlanLine(n: number): string {
  return `${n} planned scenario${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} the test account; credentials not provided`;
}

/* ─── the wrong-password counter ────────────────────────────────────────── */

type FillStep = Extract<TraceStep, { kind: 'fill' }>;
export type WrongPasswordStage = 'explorer' | 'repair' | 'replay' | 'stability' | 'emitted';
export type WrongPasswordLedger = NonNullable<RunReport['wrongPasswordAttempts']>;

export const WRONG_PASSWORD_CAP_DEFAULT = 10;

function isPasswordFill(st: FillStep): boolean {
  return st.credential === 'pass' || PASSWORD_FIELD_RE.test(`${st.target.intent} ${JSON.stringify(st.target.arg)}`);
}

/**
 * Wrong-password submits one execution of this scenario makes against the
 * test account: in a login flow that fills the account's identifier (a
 * 'user' marker), every non-empty password fill that is not the account's
 * own password. A scenario that never fills the account counts 0, so a
 * wrong-credential negative on a generated identifier spends nothing.
 */
export function wrongPasswordSubmits(s: Pick<Scenario, 'name' | 'steps'> & { feature?: string }): number {
  if (!isLoginFlow(s)) return 0;
  const fills = s.steps.filter((st): st is FillStep => st.kind === 'fill');
  if (!fills.some((f) => f.credential === 'user')) return 0;
  return fills.filter((f) => f.credential === undefined && !f.generate && f.value !== '' && isPasswordFill(f)).length;
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const THRESHOLD_RE = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:consecutive|failed|unsuccessful|incorrect|wrong|invalid|bad)\s+)*(?:(?:login|log-in|sign[\s-]?in|password)\s+)?(?:attempts?|tries|times|failures)\b/i;

/**
 * The lockout threshold the requirements map states (a rule that names a
 * lock and a number of attempts, "locked after 3 failed attempts"), the
 * smallest when several do, or null.
 */
export function lockoutThreshold(map?: RequirementsMap): number | null {
  let min: number | null = null;
  for (const f of map?.features ?? []) {
    for (const r of f.rules) {
      if (!/\block(ed|s|out|ing)?\b/i.test(r.text)) continue;
      const m = r.text.match(THRESHOLD_RE);
      if (!m) continue;
      const raw = m[1]!.toLowerCase();
      const n = NUMBER_WORDS[raw] ?? Number(raw);
      if (Number.isInteger(n) && n > 0 && (min === null || n < min)) min = n;
    }
  }
  return min;
}

/**
 * The cap: QA_CORE_WRONG_PASSWORD_CAP when it is a whole number (default
 * 10), lowered to N - 1 when the map states a lockout after N attempts.
 */
export function wrongPasswordCap(env: NodeJS.ProcessEnv, map?: RequirementsMap): { cap: number; capSource: string } {
  const raw = env.QA_CORE_WRONG_PASSWORD_CAP;
  let cap = WRONG_PASSWORD_CAP_DEFAULT;
  let capSource = `default ${WRONG_PASSWORD_CAP_DEFAULT}`;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0) { cap = n; capSource = `QA_CORE_WRONG_PASSWORD_CAP=${n}`; }
    else capSource = `default ${WRONG_PASSWORD_CAP_DEFAULT} (QA_CORE_WRONG_PASSWORD_CAP="${raw}" is not a whole number and was ignored)`;
  }
  const threshold = lockoutThreshold(map);
  if (threshold !== null && threshold - 1 < cap) {
    cap = Math.max(0, threshold - 1);
    capSource = `${capSource}, lowered to ${cap} by the stated lockout after ${threshold} attempts`;
  }
  return { cap, capSource };
}

export function newWrongPasswordLedger(env: NodeJS.ProcessEnv, map?: RequirementsMap): WrongPasswordLedger {
  return { ...wrongPasswordCap(env, map), count: 0, byStage: {}, refused: [] };
}

/** True when n more submits stay within the cap. */
export function canSubmitWrongPassword(ledger: WrongPasswordLedger, n: number): boolean {
  return n <= 0 || ledger.count + n <= ledger.cap;
}

/** Count n submits against a stage. */
export function recordWrongPassword(ledger: WrongPasswordLedger, n: number, stage: WrongPasswordStage): void {
  if (n <= 0) return;
  ledger.count += n;
  ledger.byStage[stage] = (ledger.byStage[stage] ?? 0) + n;
}

/** Record a scenario refused at a stage (once per scenario and stage). */
export function refuseWrongPassword(ledger: WrongPasswordLedger, scenario: string, stage: WrongPasswordStage): void {
  if (!ledger.refused.some((r) => r.scenario === scenario && r.stage === stage)) ledger.refused.push({ scenario, stage });
}

/** The skip or drop reason of a refused submit. */
export function wrongPasswordCapReason(ledger: Pick<WrongPasswordLedger, 'cap'>): string {
  return `would exceed the wrong-password cap (${ledger.cap})`;
}

/** The count line printed after each stage. */
export function wrongPasswordCountLine(ledger: WrongPasswordLedger, stage: WrongPasswordStage): string {
  return `wrong-password attempts against the test account: ${ledger.count} of cap ${ledger.cap} (after ${stage})`;
}

/** The post-run line when the account no longer signs in. */
export function lockoutWarningLine(n: number): string {
  return `the test account no longer signs in after ${n} wrong-password attempts`;
}
