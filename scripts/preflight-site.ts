/**
 * Zero-cost preflight for a site before an audit run: no model calls, no
 * API key. Answers "is the site up" and, with --login, "does the test
 * account still sign in" (a happy login that fails costs a whole run).
 *
 *   npx tsx scripts/preflight-site.ts <url> [--login] [--login-url <url>]
 *
 * Without --login: HTTP HEAD the URL, print the status and the response
 * time. With --login: the same login preflight every run makes before it
 * spends anything (src/agent/login-preflight.ts, invariant 70), with the
 * test account read from .env the way a run reads it (the host-scoped
 * QA_CORE_TEST_USER_<HOST> / QA_CORE_TEST_PASS_<HOST> first, then the
 * generic pair; the variable names are printed, never the values). It
 * reports exactly one of LOGIN OK, LOGIN FAILED (with the page's visible
 * error text verbatim) or PAGE NOT REACHED (with every URL it tried).
 *
 * Exit code: 0 only on a reachable site (and LOGIN OK when --login is
 * passed); non-zero otherwise.
 */
import 'dotenv/config';
import { preflightLogin } from '../src/agent/login-preflight.js';
import { resolveTestCredentials } from '../src/agent/test-credentials.js';

const args = process.argv.slice(2);
const loginUrlIdx = args.indexOf('--login-url');
const loginUrl = loginUrlIdx >= 0 ? args[loginUrlIdx + 1] : undefined;
const url = args.find((a, i) => !a.startsWith('--') && i !== loginUrlIdx + 1);
const wantLogin = args.includes('--login');
if (!url || (loginUrlIdx >= 0 && !loginUrl)) {
  console.error('usage: npx tsx scripts/preflight-site.ts <url> [--login] [--login-url <url>]');
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
const resolution = resolveTestCredentials(process.env, url);
console.log(resolution.line);
if (!resolution.creds) {
  console.log('LOGIN FAILED: test credentials not provided; nothing was attempted.');
  process.exit(1);
}
const result = await preflightLogin({ url, ...(loginUrl ? { loginUrl } : {}), user: resolution.creds.user, pass: resolution.creds.pass });
for (const line of result.lines) console.log(line);
process.exit(result.outcome === 'ok' ? 0 : 1);
