import type { RunReport, Scenario, TraceStep } from './trace.js';
import { emitLocatorCall } from './selectors.js';

/**
 * storageState auth for emitted frameworks.
 *
 * When a run recorded a successful happy-path login, the emitted framework
 * logs in ONCE (tests/auth.setup) and every authenticated spec reuses the
 * saved session (playwright/.auth/user.json) instead of driving the login UI
 * per test. Login-feature specs keep their own project WITHOUT storageState:
 * a login test that starts logged in is vacuous.
 *
 * Credentials never appear as literals anywhere in the emitted tree: the
 * setup file and the login spec read process.env.QA_CORE_TEST_USER /
 * QA_CORE_TEST_PASS, and the framework .env.example lists those vars (with
 * the recorded values only for known public demo sites, empty otherwise).
 */

export const AUTH_ENV_USER = 'QA_CORE_TEST_USER';
export const AUTH_ENV_PASS = 'QA_CORE_TEST_PASS';
export const STORAGE_STATE_PATH = 'playwright/.auth/user.json';

const CREDENTIAL_PASS_RE = /passw(or)?d|passcode/i;
const CREDENTIAL_USER_RE = /user(name)?|e-?mail|login|account/i;

/**
 * Public demo sites whose well-known throwaway credentials may be seeded into
 * the framework .env.example. Anything else gets empty placeholders.
 */
const DEMO_HOSTS = new Set([
  'www.saucedemo.com', 'saucedemo.com',
  'practicesoftwaretesting.com', 'www.practicesoftwaretesting.com',
  'the-internet.herokuapp.com',
  'demoqa.com', 'www.demoqa.com',
  'letcode.in', 'www.letcode.in',
  'opensource-demo.orangehrmlive.com',
]);

export function isDemoHost(url: string): boolean {
  try { return DEMO_HOSTS.has(new URL(url).hostname.toLowerCase()); } catch { return false; }
}

/**
 * The env var a login-scenario fill maps to, or null for a non-credential
 * fill. Password-intent wins; the remaining user/email/login-intent fill is
 * the username.
 */
export function credentialEnvFor(intent: string): typeof AUTH_ENV_USER | typeof AUTH_ENV_PASS | null {
  if (CREDENTIAL_PASS_RE.test(intent)) return AUTH_ENV_PASS;
  if (CREDENTIAL_USER_RE.test(intent)) return AUTH_ENV_USER;
  return null;
}

/**
 * The happy login the auth setup replays: an emitted login-feature scenario,
 * happy category, that filled a password. Null when the run has none (and
 * then NOTHING about the emitted framework changes — the emitter-only
 * guarantee).
 */
export function findHappyLoginScenario(report: RunReport): Scenario | null {
  return report.scenarios.find((s) =>
    s.feature === 'login' &&
    s.category === 'happy' &&
    s.steps.some((st) => st.kind === 'fill' && CREDENTIAL_PASS_RE.test(st.target.intent)),
  ) ?? null;
}

/** The recorded credential values (for demo-host .env.example seeding only). */
export function recordedCredentials(login: Scenario): { user?: string; pass?: string } {
  const out: { user?: string; pass?: string } = {};
  for (const st of login.steps) {
    if (st.kind !== 'fill') continue;
    const env = credentialEnvFor(st.target.intent);
    if (env === AUTH_ENV_PASS && out.pass === undefined) out.pass = st.value;
    if (env === AUTH_ENV_USER && out.user === undefined) out.user = st.value;
  }
  return out;
}

/**
 * Strip the leading login sequence from an authenticated-feature scenario:
 * storageState replaces it. The sequence is everything from the start through
 * the submit click/press that follows the password fill, plus the login
 * success assertions that immediately follow (they verified a state the
 * storage state now provides). The scenario's own navigates and actions after
 * that stay intact. Scenarios with no leading password fill are returned
 * unchanged.
 */
export function stripLeadingLogin(steps: TraceStep[]): TraceStep[] {
  // Find a password fill within the leading action region.
  let passIdx = -1;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i]!;
    if (st.kind === 'fill' && CREDENTIAL_PASS_RE.test(st.target.intent)) { passIdx = i; break; }
    // Only navigates, fills, clicks, presses, waits, and checkpoints may
    // precede the login submit; anything else means no leading login block.
    if (!['navigate', 'fill', 'click', 'press', 'wait', 'stability_wait', 'checkpoint'].includes(st.kind)) return steps;
  }
  if (passIdx === -1) return steps;
  // The submit that follows the password fill.
  let submitIdx = -1;
  for (let i = passIdx + 1; i < steps.length; i++) {
    const st = steps[i]!;
    if (st.kind === 'click' || st.kind === 'press') { submitIdx = i; break; }
    if (st.kind !== 'fill' && st.kind !== 'wait' && st.kind !== 'stability_wait' && st.kind !== 'checkpoint') break;
  }
  if (submitIdx === -1) return steps;
  // Drop login-success assertions directly after the submit, up to the next action.
  let end = submitIdx;
  for (let i = submitIdx + 1; i < steps.length; i++) {
    const st = steps[i]!;
    if (st.kind === 'assert' || st.kind === 'wait_for_state') { end = i; continue; }
    break;
  }
  return steps.slice(end + 1);
}

/** Locator expression for a step target, standalone (no page object). */
function loc(target: Extract<TraceStep, { kind: 'fill' }>['target']): string {
  return emitLocatorCall(target.level, target.arg, target.ambiguous === true, target.frameChain, target.filterText);
}

/**
 * Render tests/auth.setup.(ts|js): replays the recorded login with env
 * credentials, then saves the storage state. Runs as its own Playwright
 * project; the authenticated projects depend on it.
 */
export function renderAuthSetup(login: Scenario, url: string, lang: 'ts' | 'js'): string {
  const out: string[] = [];
  if (lang === 'ts') {
    out.push(`import { test as setup, expect } from '@playwright/test';`);
  } else {
    out.push(`// @ts-check`);
    out.push(`const { test: setup, expect } = require('@playwright/test');`);
  }
  out.push('');
  out.push(`/* Auto-generated by QA-Core. Logs in once with the recorded flow and saves`);
  out.push(` * the session to ${STORAGE_STATE_PATH}; authenticated projects reuse it`);
  out.push(` * instead of driving the login UI in every test. Credentials come from`);
  out.push(` * ${AUTH_ENV_USER} / ${AUTH_ENV_PASS} (see .env.example). */`);
  out.push('');
  out.push(`const STORAGE_STATE = ${JSON.stringify(STORAGE_STATE_PATH)};`);
  out.push('');
  out.push(`setup('authenticate', async ({ page }) => {`);
  // First navigate: the login scenario's recorded starting URL, else the run URL.
  const firstNav = login.steps.find((s) => s.kind === 'navigate');
  out.push(`  await page.goto(${JSON.stringify(firstNav && firstNav.kind === 'navigate' ? firstNav.url : url)});`);
  let sawNav = false;
  for (const step of login.steps) {
    if (step.kind === 'navigate') {
      if (!sawNav) { sawNav = true; continue; } // first navigate emitted above
      out.push(`  await page.goto(${JSON.stringify(step.url)});`);
      continue;
    }
    if (step.kind === 'fill') {
      const env = credentialEnvFor(step.target.intent);
      const value = env ? `process.env.${env} ?? ''` : JSON.stringify(step.value);
      out.push(`  await ${loc(step.target)}.fill(${value});`);
      continue;
    }
    if (step.kind === 'click') {
      out.push(`  await ${loc(step.target)}.click();`);
      continue;
    }
    if (step.kind === 'press') {
      out.push(`  await ${loc(step.target)}.press(${JSON.stringify(step.key)});`);
      continue;
    }
    if (step.kind === 'assert') {
      const a = step.assertion;
      // Keep the recorded login-success signal so a bad credential fails HERE,
      // loudly, instead of cascading into every authenticated spec.
      if (a.type === 'toHaveURL') {
        out.push(`  await expect(page).toHaveURL(new RegExp(${JSON.stringify(a.pattern)}), { timeout: 10000 });`);
      } else if ('target' in a && (a.type === 'toBeVisible' || a.type === 'toHaveText' || a.type === 'toContainText')) {
        const call = a.type === 'toBeVisible'
          ? `toBeVisible({ timeout: 10000 })`
          : `${a.type}(${JSON.stringify((a as { text: string }).text)}, { timeout: 10000 })`;
        out.push(`  await expect(${loc(a.target)}).${call};`);
      }
      continue;
    }
    // wait/stability_wait/checkpoint/capture steps add nothing to a setup login.
  }
  out.push(`  await page.context().storageState({ path: STORAGE_STATE });`);
  out.push(`});`);
  out.push('');
  return out.join('\n');
}
