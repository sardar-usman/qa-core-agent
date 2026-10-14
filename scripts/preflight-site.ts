/**
 * Zero-cost preflight for a site before an audit run: no model calls, no
 * API key. Answers "is the site up" and, with --login, "does the test
 * account still sign in" (a happy login that fails costs a whole run).
 *
 *   npx tsx scripts/preflight-site.ts <url> [--login] [--login-url <url-or-path>]
 *
 * The URL may come in any position; --login-url takes the next argument as
 * its value (a URL, or a path resolved against <url>) and implies --login.
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

const USAGE = 'usage: npx tsx scripts/preflight-site.ts <url> [--login] [--login-url <url-or-path>]';

/**
 * The URL in any position; the value after --login-url is never taken as
 * the URL. --login-url implies --login. Null when the arguments are not
 * usable (no URL, --login-url with no value, an unknown flag, a second URL).
 * The old parser excluded index loginUrlIdx + 1, which is 0 when
 * --login-url is absent, so "<url> --login" lost its URL.
 */
function parsePreflightArgs(argv: string[]): { url: string; loginUrl?: string; wantLogin: boolean } | null {
  let url: string | undefined;
  let loginUrl: string | undefined;
  let wantLogin = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--login') { wantLogin = true; continue; }
    if (a === '--login-url') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return null;
      loginUrl = v;
      wantLogin = true;
      i++;
      continue;
    }
    if (a.startsWith('--')) return null;
    if (url !== undefined) return null;
    url = a;
  }
  return url ? { url, ...(loginUrl ? { loginUrl } : {}), wantLogin } : null;
}

const parsed = parsePreflightArgs(process.argv.slice(2));
if (!parsed) {
  console.error(USAGE);
  process.exit(2);
}
const { url, loginUrl, wantLogin } = parsed;

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
