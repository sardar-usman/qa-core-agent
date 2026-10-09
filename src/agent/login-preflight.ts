import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { installEvalShim } from './eval-shim.js';
import { maskForDisk } from './credential-leak.js';
import { reconcile } from './reconcile.js';
import type { RunReport } from './trace.js';
import { lockoutWarningLine, resolveTestCredentials, type TestCredentials } from './test-credentials.js';

/**
 * Login preflight (invariant 70): does the test account sign in, before a
 * run spends anything? No model call, no API key. The logic used to live in
 * scripts/preflight-site.ts, which is now a wrapper around preflightLogin.
 *
 * It opens the login page (the --login-url first when given, then the run
 * URL, a login link on it, then the common LOGIN_PATHS), fills the account,
 * submits, and reports exactly one outcome: ok (with the positive signal it
 * saw), failed (with the page's visible error text verbatim) or unreached
 * (with every URL it tried). Success is never inferred from the absence of
 * an error: the URL must leave the login page, or a logged-in element must
 * appear that the login page did not already show.
 */

export const LOGIN_PATHS = ['/auth/login', '/login', '/signin', '/sign-in', '/account/login', '/user/login'];
const LOGIN_LINK_RE = /\b(log\s?in|sign\s?in)\b/i;
// Text that only a signed-in page shows. A bare "account" is not one: the
// login page's own "Register your account" link matched it and a wrong
// password read as LOGIN OK.
const LOGGED_IN_RE = /\b(log\s?out|sign\s?out|my account)\b/i;

export interface PreflightLoginOptions {
  url: string;
  /** --login-url: tried before anything else. */
  loginUrl?: string;
  user: string;
  pass: string;
  /** How long a positive signal may take after submit. Default 15 s. */
  signalTimeoutMs?: number;
}

export interface PreflightLoginResult {
  outcome: 'ok' | 'failed' | 'unreached';
  /** The page the form was found on. */
  loginUrl?: string;
  /** Every URL opened while looking for the login form, in order. */
  tried: string[];
  /** The positive signal, on ok. */
  signal?: string;
  /** The page's visible error text verbatim, on failed. */
  pageText: string[];
  /** Report lines, what preflight-site prints (never a credential value). */
  lines: string[];
}

/** Visible text from the elements a site uses for a rejection, verbatim. */
async function visibleErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
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

/** Open a URL and report whether it shows a password field. */
async function tryPage(page: Page, url: string, tried: string[], waitMs: number): Promise<boolean> {
  tried.push(url);
  const res = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (!res || !res.ok()) return false;
  await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: waitMs }).catch(() => undefined);
  return hasPasswordField(page);
}

export async function preflightLogin(opts: PreflightLoginOptions): Promise<PreflightLoginResult> {
  const tried: string[] = [];
  const lines: string[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await installEvalShim(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);

    // Reach the login page: --login-url, the URL itself, a login link on it, or a common path.
    let loginUrl: string | null = null;
    let first: string | undefined;
    try { first = opts.loginUrl ? new URL(opts.loginUrl, opts.url).toString() : undefined; } catch { first = opts.loginUrl; }
    try {
      if (first && await tryPage(page, first, tried, 10_000)) loginUrl = page.url();
      if (!loginUrl && await tryPage(page, opts.url, tried, 3_000)) loginUrl = page.url();
      if (!loginUrl && tried.length > 0) {
        const link = page.getByRole('link', { name: LOGIN_LINK_RE }).first();
        if ((await link.count().catch(() => 0)) > 0) {
          await link.click();
          await page.waitForLoadState('domcontentloaded');
          tried.push(page.url());
          await page.locator('input[type="password"]').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
          if (await hasPasswordField(page)) loginUrl = page.url();
        }
      }
      if (!loginUrl) {
        let origin: string;
        try { origin = new URL(opts.url).origin; } catch { origin = ''; }
        for (const p of origin ? LOGIN_PATHS : []) {
          if (await tryPage(page, origin + p, tried, 5_000)) { loginUrl = page.url(); break; }
        }
      }
    } catch (err) {
      lines.push(`PAGE NOT REACHED: ${(err as Error).message}`);
      return { outcome: 'unreached', tried, pageText: [], lines };
    }
    if (!loginUrl) {
      lines.push(`PAGE NOT REACHED: no page with a password field was found (tried ${tried.join(', ')}).`);
      return { outcome: 'unreached', tried, pageText: [], lines };
    }
    lines.push(`login page: ${loginUrl}`);
    const password = page.locator('input[type="password"]').first();
    const form = password.locator('xpath=ancestor::form[1]');
    const scope = (await form.count()) > 0 ? form : page.locator('body');
    const identifier = scope.locator('input[type="email"], input[name*="email" i], input[id*="email" i], input[name*="user" i], input[id*="user" i], input[name*="login" i], input[type="text"]').first();
    if ((await identifier.count()) === 0) {
      const text = 'the login page has a password field but no identifier field could be found';
      lines.push(`LOGIN FAILED: ${text}.`);
      return { outcome: 'failed', loginUrl, tried, pageText: [text], lines };
    }
    const loginPath = new URL(loginUrl).pathname;
    // What the login page already shows: none of it can be the success signal.
    const before = new Set(await loggedInCandidates(page));
    await identifier.fill(opts.user);
    await password.fill(opts.pass);
    const submit = scope.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Log in"), button:has-text("Sign in")').first();
    if ((await submit.count()) > 0) await submit.click();
    else await password.press('Enter');

    // A positive signal: the URL left the login page, or a logged-in element
    // appeared. Silence is not success.
    const deadline = Date.now() + (opts.signalTimeoutMs ?? 15_000);
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
      lines.push(`LOGIN OK (signal: ${signal})`);
      return { outcome: 'ok', loginUrl, tried, signal, pageText: [], lines };
    }
    const errors = await visibleErrors(page);
    lines.push(`LOGIN FAILED (no positive signal within ${Math.round((opts.signalTimeoutMs ?? 15_000) / 1000)} s; still at ${page.url()})`);
    if (errors.length > 0) for (const e of errors) lines.push(`  page says: ${e}`);
    else lines.push('  page shows no visible error text');
    return { outcome: 'failed', loginUrl, tried, pageText: errors.length > 0 ? errors : [`no visible error text; still at ${page.url()}`], lines };
  } finally {
    await browser.close();
  }
}

/** The one line a failed preflight stops the run with. */
export function preflightStopLine(r: Pick<PreflightLoginResult, 'outcome' | 'pageText' | 'tried'>): string {
  const what = r.outcome === 'unreached'
    ? `no login page was found; tried ${r.tried.join(', ')}`
    : r.pageText.join(' | ');
  return `Run stopped: the test account did not sign in (${what}). Nothing was spent.`;
}

export interface LoginPreflightGateOptions {
  url: string;
  loginUrl?: string;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Test seam: replaces preflightLogin. */
  preflight?: typeof preflightLogin;
}

export interface LoginPreflightGateResult {
  creds: TestCredentials | null;
  /** Set when the account did not sign in: the run must stop with this line. */
  stopLine: string | null;
  /** Where the form was found, for the post-run check. */
  loginUrl?: string;
}

/**
 * Run the preflight when the run has test credentials. Every surface calls
 * it before the requirements map and the Planner, so a failure costs $0. It
 * prints which variables were used (names only) and the preflight's lines;
 * with no credentials it prints why and returns no stop.
 */
export async function runLoginPreflightGate(opts: LoginPreflightGateOptions): Promise<LoginPreflightGateResult> {
  const resolution = resolveTestCredentials(opts.env ?? process.env, opts.url);
  opts.log(resolution.line);
  if (!resolution.creds) return { creds: null, stopLine: null };
  const r = await (opts.preflight ?? preflightLogin)({ url: opts.url, ...(opts.loginUrl ? { loginUrl: opts.loginUrl } : {}), user: resolution.creds.user, pass: resolution.creds.pass });
  for (const l of r.lines) opts.log(`login preflight: ${l.trim()}`);
  if (r.outcome === 'ok') return { creds: resolution.creds, stopLine: null, ...(r.loginUrl ? { loginUrl: r.loginUrl } : {}) };
  if (r.outcome === 'unreached') {
    opts.log(`login preflight: no login page was found with ${resolution.creds.userVar} / ${resolution.creds.passVar} set; pass --login-url <page>, or, for a site with no login, run without a test account (a host-scoped pair applies to one site only)`);
  }
  return { creds: resolution.creds, stopLine: maskForDisk(preflightStopLine(r)), ...(r.loginUrl ? { loginUrl: r.loginUrl } : {}) };
}

/**
 * The minimal run-report a failed preflight leaves (owner decision B):
 * stopped with the line verbatim, cost 0, no scenarios, an empty funnel, so
 * the dashboard lists the run. The caller writes run-meta.json; nothing else
 * is written.
 */
export function preflightStopReport(opts: { url: string; language: 'ts' | 'js'; line: string; startedAt: string }): RunReport {
  const report: RunReport = {
    url: opts.url,
    language: opts.language,
    stopped: { kind: 'login_preflight', reason: opts.line },
    scenarios: [],
    cascadeStats: { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 },
    cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0, plannerUsd: 0, criticUsd: 0, requirementsUsd: 0 },
    steps: 0,
    startedAt: opts.startedAt,
    finishedAt: new Date().toISOString(),
    findings: [],
  };
  report.reconciliation = reconcile(report);
  return report;
}

export function writePreflightStopReport(outDir: string, report: RunReport): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'run-report.json');
  fs.writeFileSync(file, JSON.stringify(maskForDisk(report), null, 2));
  return file;
}

/**
 * After the last stage that submits a wrong password: when any submit was
 * counted, sign in once more. A failure means the account is probably
 * locked: the line is printed and recorded as report.lockoutWarning.
 */
export async function postRunLockoutCheck(opts: { report: RunReport; loginUrl?: string; env?: NodeJS.ProcessEnv; log: (line: string) => void; preflight?: typeof preflightLogin }): Promise<void> {
  const n = opts.report.wrongPasswordAttempts?.count ?? 0;
  if (n === 0) return;
  const creds = resolveTestCredentials(opts.env ?? process.env, opts.report.url).creds;
  if (!creds) return;
  const r = await (opts.preflight ?? preflightLogin)({ url: opts.report.url, ...(opts.loginUrl ? { loginUrl: opts.loginUrl } : {}), user: creds.user, pass: creds.pass });
  if (r.outcome === 'ok') {
    opts.log(`post-run login check: the test account still signs in after ${n} wrong-password attempt${n === 1 ? '' : 's'}`);
    return;
  }
  opts.report.lockoutWarning = lockoutWarningLine(n);
  opts.log(`WARNING: ${opts.report.lockoutWarning}`);
}
