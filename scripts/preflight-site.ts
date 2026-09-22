/**
 * Zero-cost preflight for a site before an audit run: no model calls, no
 * API key. Answers "is the site up" and, with --login, "does the shared
 * test account still sign in" (a shared demo account can be locked by
 * outside traffic, and a happy login that fails costs a whole run).
 *
 *   npx tsx scripts/preflight-site.ts <url> [--login]
 *
 * Without --login: HTTP HEAD the URL, print the status and the response
 * time. With --login: launch Playwright Chromium, install the eval shim
 * (invariant 5), open the site's login page, sign in with
 * QA_CORE_TEST_USER / QA_CORE_TEST_PASS from .env, and report exactly one of
 * LOGIN OK, LOGIN FAILED (with the page's visible error text verbatim) or
 * PAGE NOT REACHED. Success is never inferred from the absence of an error:
 * a positive signal is required (the URL left the login page, or a
 * logged-in element appeared) and the report says which one.
 *
 * Exit code: 0 only on a reachable site (and LOGIN OK when --login is
 * passed); non-zero otherwise.
 */
import 'dotenv/config';
import { chromium, type Page } from 'playwright';
import { installEvalShim } from '../src/agent/eval-shim.js';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const wantLogin = args.includes('--login');
if (!url) {
  console.error('usage: npx tsx scripts/preflight-site.ts <url> [--login]');
  process.exit(2);
}

/* ─── 1. HEAD ────────────────────────────────────────────────────────────── */
let reachable = false;
{
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    const ms = Date.now() - t0;
    reachable = res.ok;
    console.log(`HEAD ${url}: HTTP ${res.status} in ${ms} ms${res.url !== url ? ` (final URL ${res.url})` : ''}`);
  } catch (err) {
    console.log(`HEAD ${url}: failed after ${Date.now() - t0} ms: ${(err as Error).message}`);
  }
}
if (!wantLogin) {
  if (!reachable) console.log('PAGE NOT REACHED');
  process.exit(reachable ? 0 : 1);
}

/* ─── 2. login ───────────────────────────────────────────────────────────── */
if (!reachable) {
  console.log('PAGE NOT REACHED');
  process.exit(1);
}
const user = process.env.QA_CORE_TEST_USER ?? '';
const pass = process.env.QA_CORE_TEST_PASS ?? '';
if (!user || !pass) {
  console.log('LOGIN FAILED: QA_CORE_TEST_USER / QA_CORE_TEST_PASS are not both set (.env or the environment); nothing was attempted.');
  process.exit(1);
}

const LOGIN_LINK_RE = /\b(log\s?in|sign\s?in)\b/i;
// Text that only a signed-in page shows. A bare "account" is not one: the
// login page's own "Register your account" link matched it and a wrong
// password read as LOGIN OK.
const LOGGED_IN_RE = /\b(log\s?out|sign\s?out|my account)\b/i;
const LOGIN_PATHS = ['/auth/login', '/login', '/signin', '/sign-in', '/account/login', '/user/login'];

/** Visible text from the elements a site uses for a rejection, verbatim. */
async function visibleErrors(page: Page): Promise<string[]> {
  const out = await page.evaluate(() => {
    const sel = '[role="alert"], .alert, .error, .errors, .invalid-feedback, .help-block, .text-danger, [class*="error" i], [data-test*="error" i], [id*="error" i]';
    const seen = new Set<string>();
    const texts: string[] = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const e = el as HTMLElement;
      const style = getComputedStyle(e);
      if (style.display === 'none' || style.visibility === 'hidden' || e.offsetParent === null && style.position !== 'fixed') continue;
      const t = (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && !seen.has(t)) { seen.add(t); texts.push(t); }
    }
    return texts;
  });
  return out;
}

/** The logged-in candidates visible right now, by text, so a signal must be NEW after submit. */
async function loggedInCandidates(page: Page): Promise<string[]> {
  const loc = page.getByRole('link', { name: LOGGED_IN_RE }).or(page.getByRole('button', { name: LOGGED_IN_RE })).or(page.locator('[data-test="nav-menu"], [data-testid="nav-menu"], [data-test="logout"], [data-testid="logout"]'));
  const n = await loc.count();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    out.push(((await el.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 60));
  }
  return out;
}

async function hasPasswordField(page: Page): Promise<boolean> {
  return (await page.locator('input[type="password"]').count()) > 0;
}

const browser = await chromium.launch({ headless: true });
let outcome: 'ok' | 'failed' | 'unreached' = 'unreached';
try {
  const context = await browser.newContext();
  await installEvalShim(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);

  // Reach the login page: the URL itself, a login link on it, or a common path.
  let loginUrl: string | null = null;
  let reachError = false;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (await hasPasswordField(page)) loginUrl = page.url();
    else {
      const link = page.getByRole('link', { name: LOGIN_LINK_RE }).first();
      if ((await link.count()) > 0) {
        await link.click();
        await page.waitForLoadState('domcontentloaded');
        await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
        if (await hasPasswordField(page)) loginUrl = page.url();
      }
    }
    if (!loginUrl) {
      const origin = new URL(page.url()).origin;
      for (const p of LOGIN_PATHS) {
        const res = await page.goto(origin + p, { waitUntil: 'domcontentloaded' }).catch(() => null);
        if (!res || !res.ok()) continue;
        await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
        if (await hasPasswordField(page)) { loginUrl = page.url(); break; }
      }
    }
  } catch (err) {
    console.log(`PAGE NOT REACHED: ${(err as Error).message}`);
    loginUrl = null;
    reachError = true;
  }
  if (!loginUrl) {
    if (!reachError) console.log('PAGE NOT REACHED: no page with a password field was found (the URL, a login link on it, or the common login paths).');
  } else {
    console.log(`login page: ${loginUrl}`);
    const password = page.locator('input[type="password"]').first();
    const form = password.locator('xpath=ancestor::form[1]');
    const scope = (await form.count()) > 0 ? form : page.locator('body');
    const identifier = scope.locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[name*="user" i], input[id*="user" i], input[name*="login" i], input[type="text"]').first();
    if ((await identifier.count()) === 0) {
      console.log('LOGIN FAILED: the login page has a password field but no identifier field could be found.');
      outcome = 'failed';
    } else {
      const loginPath = new URL(loginUrl).pathname;
      // What the login page already shows: none of it can be the success signal.
      const before = new Set(await loggedInCandidates(page));
      await identifier.fill(user);
      await password.fill(pass);
      const submit = scope.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Log in"), button:has-text("Sign in")').first();
      if ((await submit.count()) > 0) await submit.click();
      else await password.press('Enter');

      // A positive signal, within 15 s: the URL left the login page, or a
      // logged-in element appeared. Silence is not success.
      const deadline = Date.now() + 15_000;
      let signal: string | null = null;
      while (Date.now() < deadline && !signal) {
        const now = new URL(page.url());
        if (now.pathname !== loginPath) signal = `URL changed to ${now.pathname}`;
        else {
          const fresh = (await loggedInCandidates(page)).find((t) => !before.has(t));
          if (fresh !== undefined) signal = `logged-in element "${fresh}" appeared after submit (not on the login page before)`;
        }
        if (!signal) await page.waitForTimeout(300);
      }
      if (signal) {
        console.log(`LOGIN OK (signal: ${signal})`);
        outcome = 'ok';
      } else {
        const errors = await visibleErrors(page);
        console.log(`LOGIN FAILED (no positive signal within 15 s; still at ${page.url()})`);
        if (errors.length > 0) for (const e of errors) console.log(`  page says: ${e}`);
        else console.log('  page shows no visible error text');
        outcome = 'failed';
      }
    }
  }
} finally {
  await browser.close();
}
process.exit(outcome === 'ok' ? 0 : 1);
