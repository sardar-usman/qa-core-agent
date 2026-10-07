import type { GenerateKind } from './trace.js';

/**
 * Per-run unique test data.
 *
 * Creation flows (registration, anything behind a unique-email or unique-name
 * constraint) cannot reuse a fixed value. The first run creates the record, and
 * every run after it hits a duplicate and fails. A sign-up password has the same
 * problem from the other side: a fixed weak or breached value is rejected by a
 * strength or data-leak check. Real suites solve both with data that is fresh and
 * strong on every run. This module is the single source of truth for that data in
 * three places that must agree:
 *
 *   1. exploration   (tools.ts fills a generated value so the flow really succeeds)
 *   2. replay + 3x stability (replay.ts fills a fresh value each run)
 *   3. the emitted spec (a helper the generated project ships and calls)
 *
 * The runtime generator and the emitted helper produce the same SHAPE of value
 * (qa.user.<stamp>@example.com), so a trace recorded with a generated email
 * replays and ships as a spec that is unique on every `playwright test` run.
 */

let runtimeSeq = 0;
let runtimePassword: string | undefined;

/** Runtime generator used during exploration and replay/stability. */
export function generateUnique(kind: GenerateKind): string {
  if (kind === 'password') {
    // One strong password per process. A sign-up form often has a confirm-password
    // field that must match the first, so every password fill in a run returns the
    // same value. It is random enough never to appear in a data-leak / breach list,
    // and carries all four character classes so it passes strength validators.
    if (!runtimePassword) runtimePassword = strongPassword();
    return runtimePassword;
  }
  runtimeSeq += 1;
  const stamp = Date.now().toString(36) + runtimeSeq.toString(36) + Math.random().toString(36).slice(2, 8);
  if (kind === 'token') return `qa${stamp}`;
  return `qa.user.${stamp}@example.com`;
}

/** A 24-char password with upper, lower, digit, and symbol, random body. */
function strongPassword(): string {
  const body = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return `Qa9!${body}Zx7$`;
}

/** The call expression emitted into the spec for a generated fill. */
export function uniqueCallExpr(kind: GenerateKind): string {
  if (kind === 'token') return 'uniqueToken()';
  if (kind === 'password') return 'uniquePassword()';
  return 'uniqueEmail()';
}

/** The helper function names the spec imports, by generate kind. */
export function uniqueFnName(kind: GenerateKind): string {
  if (kind === 'token') return 'uniqueToken';
  if (kind === 'password') return 'uniquePassword';
  return 'uniqueEmail';
}

export interface UniqueFieldHints {
  /** Scenario category. Happy creation flows generate email, username and password. */
  category?: string;
  /** feature + scenario name + page URL, lowercased, used to spot a creation flow. */
  flowHint: string;
  /** intent + testid + label + role + css + placeholder for the field being filled. */
  fieldHint: string;
  /**
   * The plan's canonical scenario name (the planned name the recorded one
   * matches; the recorded name only when the run has no plan). A negative or
   * edge scenario is judged on this alone, never on text the model echoed.
   */
  canonicalName?: string;
  /** The value the model asked to fill. A non-happy email is generated only when it is well-formed. */
  value?: string;
}

const CREATION_FLOW_RE = /regist|sign[\s_-]?up|create|join|enrol|new[\s_-]?account|onboard/i;
const EMAIL_FIELD_RE = /e[\s_-]?mail/i;
// A scenario that is ABOUT the email already being taken keeps its literal:
// generating a fresh one would make the duplicate test pass for the wrong reason.
const DUPLICATE_EMAIL_RE = /duplicate|\bexisting\b|already[\s_-]+(?:registered|in[\s_-]+use|used|taken|exists)/i;
// A login flow: the credential rules (invariants 43 and 56) own its fields.
const LOGIN_NAME_RE = /\blog(?:s|ged|ging)?[\s_-]?in\b|\bsign(?:s|ed|ing)?[\s_-]?in\b/i;

/** True when the field hints name an email field (the same pattern the creation-email rule uses). */
export function isEmailField(fieldHint: string): boolean {
  return EMAIL_FIELD_RE.test(fieldHint);
}

/**
 * A well-formed email: one @, a non-empty local part, a dotted domain, no
 * spaces. The same check keeps the two negatives that test the email itself
 * literal: an empty value and a malformed one (no @).
 */
export function isWellFormedEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Decide whether a field being filled feeds a uniqueness constraint and so needs
 * generated data. General, not tied to any one site:
 *
 *  - Happy-path creation flows generate email, username and password.
 *    Negative and edge creation flows generate only a well-formed email, and
 *    only when the canonical scenario name neither mentions the email nor
 *    names a duplicate or existing one (nonHappyCreationEmail); an empty or
 *    malformed email, a
 *    username and a password stay literal, since those are what such
 *    scenarios test.
 *  - The flow has to look like a creation/sign-up flow.
 *  - An email field on such a flow gets a unique email. A username/handle field
 *    on such a flow gets a unique token. A password field gets a strong random
 *    password, so a sign-up form with a strength or data-leak check is not
 *    rejected for a weak or breached value the model happened to type.
 */
export function detectUniqueField(h: UniqueFieldHints): GenerateKind | undefined {
  if (h.category && h.category !== 'happy') return nonHappyCreationEmail(h);
  const isCreationFlow = CREATION_FLOW_RE.test(h.flowHint);
  if (!isCreationFlow) return undefined;
  if (EMAIL_FIELD_RE.test(h.fieldHint)) return 'email';
  if (/user[\s_-]?name|\bhandle\b|\bnickname\b/i.test(h.fieldHint)) return 'token';
  if (/pass[\s_-]?word|\bpasswd\b|\bpwd\b/i.test(h.fieldHint)) return 'password';
  return undefined;
}

/**
 * A negative or edge creation flow fills a generated email when the email is
 * not the field under test. Run 44cb3d: the first-name and date-of-birth
 * registration negatives typed unique2+qa@example.com and unique3+qa@example.com,
 * and the Critic reworked both, because the second run hits a duplicate email
 * and fails for a reason that is not the one the test names. Judged on the
 * plan's canonical scenario name only. Kept literal: a scenario whose name
 * mentions the email (the email IS the field under test: "an invalid email
 * format" filling a@b.c), an empty or malformed value, a scenario that names
 * a duplicate, existing or already-registered email or account (kept beside
 * the email check: "an already registered account" names no email), and a
 * login flow.
 */
function nonHappyCreationEmail(h: UniqueFieldHints): GenerateKind | undefined {
  const name = h.canonicalName ?? '';
  if (!CREATION_FLOW_RE.test(name)) return undefined;
  if (EMAIL_FIELD_RE.test(name)) return undefined;
  if (DUPLICATE_EMAIL_RE.test(name) || LOGIN_NAME_RE.test(name)) return undefined;
  if (!EMAIL_FIELD_RE.test(h.fieldHint)) return undefined;
  if (!isWellFormedEmail(h.value ?? '')) return undefined;
  return 'email';
}

/**
 * The helper file shipped in POM output at helpers/unique-data.{ts,js}. The spec
 * imports uniqueEmail / uniqueToken from it. Same value shape as generateUnique.
 */
export function renderUniqueDataHelper(lang: 'ts' | 'js'): string {
  if (lang === 'js') {
    return `// @ts-check
/**
 * Per-run unique test data.
 *
 * Creation flows (registration, a unique email or username) fail on the second
 * run if they reuse a fixed value, because the first run already created it.
 * These return a fresh value on every call, so the same test passes on every
 * run and across parallel workers.
 */

let seq = 0;

function stamp() {
  seq += 1;
  return Date.now().toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * A unique email, e.g. qa.user.lm3x9a@example.com. Safe to register repeatedly.
 * @param {string} [domain]
 * @returns {string}
 */
function uniqueEmail(domain = 'example.com') {
  return \`qa.user.\${stamp()}@\${domain}\`;
}

/**
 * A unique alphanumeric token, e.g. for a unique username or reference.
 * @param {string} [prefix]
 * @returns {string}
 */
function uniqueToken(prefix = 'qa') {
  return \`\${prefix}\${stamp()}\`;
}

let cachedPassword;

/**
 * A strong random password, the same value for every call in a run so a
 * confirm-password field matches. Random enough to pass a strength or data-leak
 * check, with an upper, lower, digit, and symbol so it clears complexity rules.
 * @returns {string}
 */
function uniquePassword() {
  if (!cachedPassword) {
    const body = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    cachedPassword = \`Qa9!\${body}Zx7$\`;
  }
  return cachedPassword;
}

module.exports = { uniqueEmail, uniqueToken, uniquePassword };
`;
  }
  return `/**
 * Per-run unique test data.
 *
 * Creation flows (registration, a unique email or username) fail on the second
 * run if they reuse a fixed value, because the first run already created it.
 * These return a fresh value on every call, so the same test passes on every
 * run and across parallel workers.
 */

let seq = 0;

function stamp(): string {
  seq += 1;
  return Date.now().toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 8);
}

/** A unique email, e.g. qa.user.lm3x9a@example.com. Safe to register repeatedly. */
export function uniqueEmail(domain = 'example.com'): string {
  return \`qa.user.\${stamp()}@\${domain}\`;
}

/** A unique alphanumeric token, e.g. for a unique username or reference. */
export function uniqueToken(prefix = 'qa'): string {
  return \`\${prefix}\${stamp()}\`;
}

let cachedPassword: string | undefined;

/**
 * A strong random password, the same value for every call in a run so a
 * confirm-password field matches. Random enough to pass a strength or data-leak
 * check, with an upper, lower, digit, and symbol so it clears complexity rules.
 */
export function uniquePassword(): string {
  if (!cachedPassword) {
    const body = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    cachedPassword = \`Qa9!\${body}Zx7$\`;
  }
  return cachedPassword;
}
`;
}

/**
 * Bare function declarations for the single-file inline transcriber (--no-pom),
 * which has no helpers directory to import from. Valid in both .ts and .js.
 */
export function inlineUniqueDataFns(): string {
  return [
    `// Per-run unique test data. Creation flows cannot reuse a fixed email/name,`,
    `// or the second run fails on a duplicate. These are fresh on every run.`,
    `let __qaSeq = 0;`,
    `function __qaStamp() {`,
    `  __qaSeq += 1;`,
    `  return Date.now().toString(36) + __qaSeq.toString(36) + Math.random().toString(36).slice(2, 8);`,
    `}`,
    `function uniqueEmail(domain = 'example.com') { return \`qa.user.\${__qaStamp()}@\${domain}\`; }`,
    `function uniqueToken(prefix = 'qa') { return \`\${prefix}\${__qaStamp()}\`; }`,
    `let __qaPassword = '';`,
    `function uniquePassword() {`,
    `  if (!__qaPassword) __qaPassword = \`Qa9!\${Math.random().toString(36).slice(2, 10)}\${Math.random().toString(36).slice(2, 10)}Zx7$\`;`,
    `  return __qaPassword;`,
    `}`,
  ].join('\n');
}
