/**
 * Locks the page relevance filter (src/agent/page-filter.ts):
 *   - passthrough when the set is already under the cap
 *   - the caps: 8 pages with a feature list, 5 without
 *   - the deterministic fallback: first N shallowest unique-pathname pages,
 *     stable on ties, used when no API key is available
 *   - parsePickResponse validates the model's pick against the input list
 *     (URL or pathname match, cap enforced, dedupe, feature tags carried)
 *
 * Pure in-code fixtures. No network. No LLM (the LLM path is exercised only
 * through its offline parser + the no-key fallback).
 */
import {
  fallbackFilter,
  filterPages,
  pageCapFor,
  parsePickResponse,
  FILTERED_SOURCES,
  MAX_PAGES_WITH_FEATURES,
  MAX_PAGES_NO_FEATURES,
} from '../src/agent/page-filter.js';
import { capVolatile } from '../src/agent/page-filter.js';
import { isVolatilePath, type DiscoveredPage } from '../src/agent/discovery.js';
import { VOLATILE_PAGE_GUIDANCE } from '../src/agent/planner.js';
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const page = (url: string): DiscoveredPage => ({ url, source: 'sitemap' });

/* ─── A. caps ──────────────────────────────────────────────────────────────── */
check('A1. cap is 8 with a feature list', pageCapFor(['login', 'cart']) === MAX_PAGES_WITH_FEATURES && MAX_PAGES_WITH_FEATURES === 8);
check('A2. cap is 5 without one', pageCapFor(undefined) === MAX_PAGES_NO_FEATURES && MAX_PAGES_NO_FEATURES === 5);
check('A3. an empty feature list counts as none', pageCapFor([]) === MAX_PAGES_NO_FEATURES);

/* ─── B. deterministic fallback ────────────────────────────────────────────── */
const many = [
  page('https://s.example/a/b/c/deep1'),
  page('https://s.example/login'),
  page('https://s.example/'),
  page('https://s.example/a/b/mid1'),
  page('https://s.example/cart'),
  page('https://s.example/login'), // duplicate pathname
  page('https://s.example/x/y/mid2'),
  page('https://s.example/contact'),
  page('https://s.example/p/q/r/deep2'),
  page('https://s.example/search'),
];
const fb = fallbackFilter(many, 5);
check('B1. fallback keeps the cap', fb.length === 5, String(fb.length));
check('B2. shallowest pages win', JSON.stringify(fb.map((p) => new URL(p.url).pathname)) === JSON.stringify(['/', '/login', '/cart', '/contact', '/search']), JSON.stringify(fb.map((p) => p.url)));
check('B3. duplicate pathname removed', fb.filter((p) => p.url.endsWith('/login')).length === 1);
const tie = fallbackFilter([page('https://s.example/b'), page('https://s.example/a')], 2);
check('B4. ties keep discovery order (stable)', tie[0]?.url.endsWith('/b') === true && tie[1]?.url.endsWith('/a') === true);

/* ─── C. filterPages: passthrough and no-key fallback ──────────────────────── */
{
  const few = [page('https://s.example/login'), page('https://s.example/cart')];
  const r = await filterPages({ pages: few, features: ['login'], apiKey: undefined });
  check('C1. a set under the cap passes through untouched', r.method === 'passthrough' && JSON.stringify(r.pages) === JSON.stringify(few) && r.costUsd === 0);
}
{
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await filterPages({ pages: many, features: undefined });
    check('C2. over the cap with no API key uses the deterministic fallback', r.method === 'fallback' && r.pages.length === 5);
    check('C3. fallback result equals fallbackFilter output', JSON.stringify(r.pages) === JSON.stringify(fallbackFilter(many, 5)));
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
}

/* ─── D. parsePickResponse validation ──────────────────────────────────────── */
const pool = [
  page('https://s.example/login'),
  page('https://s.example/cart'),
  page('https://s.example/search'),
  page('https://s.example/contact'),
];
{
  const picked = parsePickResponse(
    `[{"url":"https://s.example/login","feature":"login"},{"url":"https://s.example/cart","feature":"cart"}]`,
    pool, 8,
  );
  check('D1. a clean pick parses with feature tags carried', picked.length === 2 && picked[0]?.feature === 'login' && picked[1]?.feature === 'cart');
}
{
  const picked = parsePickResponse(
    `Here you go:\n[{"url":"https://s.example/search"},{"url":"https://s.example/invented"},{"url":"https://s.example/search"}]`,
    pool, 8,
  );
  check('D2. invented URLs are rejected and duplicates deduped', picked.length === 1 && picked[0]?.url.endsWith('/search') === true, JSON.stringify(picked));
}
{
  const picked = parsePickResponse(`[{"url":"/cart","feature":"cart"}]`, pool, 8);
  check('D3. a pathname-only echo matches the input page', picked.length === 1 && picked[0]?.url === 'https://s.example/cart');
}
{
  const picked = parsePickResponse(
    `[${pool.map((p) => `{"url":"${p.url}"}`).join(',')}]`,
    pool, 2,
  );
  check('D4. the cap is enforced on the pick', picked.length === 2);
}
check('D5. garbage returns [] (caller falls back)', parsePickResponse('no json here', pool, 8).length === 0);
check('D6. malformed JSON returns [] without throwing', parsePickResponse('[{"url": broken]', pool, 8).length === 0);

/* ─── E. which discovery sources go through the filter ─────────────────────── */
check('E1. sitemap and both crawls are filtered',
  FILTERED_SOURCES.has('sitemap') && FILTERED_SOURCES.has('crawl') && FILTERED_SOURCES.has('browser-crawl'));
check('E2. SRS and user page sets are never trimmed', !FILTERED_SOURCES.has('srs') && !FILTERED_SOURCES.has('user') && !FILTERED_SOURCES.has('entry'));
{
  const browserPages = many.map((p) => ({ ...p, source: 'browser-crawl' as const }));
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await filterPages({ pages: browserPages, features: undefined });
    check('E3. a browser-crawl set over the cap is trimmed like any remote set',
      r.pages.length === 5 && r.pages.every((p) => p.source === 'browser-crawl'));
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
}

/* ─── F. volatile-page detection and preference ────────────────────────────── */
check('F1. a uuid segment is volatile', isVolatilePath('/product/3f2b8a9c-1d4e-4f6a-9b2c-8d7e6f5a4b3c'));
check('F2. a 24-char hex id is volatile', isVolatilePath('/product/507f1f77bcf86cd799439011'));
check('F3. a 26-char ulid-style id is volatile', isVolatilePath('/product/01jx8f2k9d3m7q5w8r2t4y6z'));
check('F4. stable paths are not volatile',
  !isVolatilePath('/login') && !isVolatilePath('/contact') && !isVolatilePath('/product-category/rakes') && !isVolatilePath('/checkout/payment'));
check('F5. a long pure-alpha segment is not volatile (words are not ids)', !isVolatilePath('/internationalization'));

const vol = (id: string): DiscoveredPage => ({ url: `https://s.example/product/${id}`, source: 'browser-crawl', volatile: true });
const stable = (p: string): DiscoveredPage => ({ url: `https://s.example${p}`, source: 'browser-crawl' });
{
  // A volatile detail page listed FIRST must still lose to stable pages.
  const mixed = [vol('01jx8f2k9d3m7q5w8r2t4y6z'), stable('/login'), vol('01jx8f2k9d3m7q5w8r2t4y7a'), stable('/contact'), vol('01jx8f2k9d3m7q5w8r2t4y8b'), stable('/category/rakes')];
  const picked = fallbackFilter(mixed, 4);
  check('F6. the fallback prefers stable-path pages over volatile detail pages',
    picked.slice(0, 3).every((p) => !p.volatile), JSON.stringify(picked.map((p) => p.url)));
  check('F7. at most ONE volatile page survives the filter',
    picked.filter((p) => p.volatile).length === 1, JSON.stringify(picked.map((p) => p.url)));
}
check('F8. capVolatile keeps the first volatile page and every stable one',
  JSON.stringify(capVolatile([stable('/a'), vol('01jx8f2k9d3m7q5w8r2t4y6z'), vol('01jx8f2k9d3m7q5w8r2t4y7a'), stable('/b')]).map((p) => new URL(p.url).pathname))
    === JSON.stringify(['/a', '/product/01jx8f2k9d3m7q5w8r2t4y6z', '/b']));
{
  // Passthrough (under the cap) still applies the one-volatile rule.
  const r = await filterPages({ pages: [vol('01jx8f2k9d3m7q5w8r2t4y6z'), vol('01jx8f2k9d3m7q5w8r2t4y7a'), stable('/login')], features: undefined, apiKey: undefined });
  check('F9. passthrough sets keep at most one volatile page', r.pages.filter((p) => p.volatile).length === 1 && r.pages.length === 2);
}

/* ─── G. the durable-navigation prompt text exists (presence, not behavior) ── */
check('G1. the LLM filter guidance prefers stable paths and caps volatile picks',
  /STABLE-PATH pages/.test(fs.readFileSync('src/agent/page-filter.ts', 'utf8')) &&
  /at most ONE such volatile detail page/.test(fs.readFileSync('src/agent/page-filter.ts', 'utf8')));
check('G2. the Planner volatile-page guidance instructs the durable path',
  /DURABLE INTERACTION/.test(VOLATILE_PAGE_GUIDANCE) && /VISIBLE NAME/.test(VOLATILE_PAGE_GUIDANCE) && /Never plan a scenario that hardcodes this URL/.test(VOLATILE_PAGE_GUIDANCE));
check('G3. the Explorer doctrine bans direct generated-id navigation',
  /Never navigate directly to a URL that carries a generated id/.test(fs.readFileSync('src/agent/runtime.ts', 'utf8')));
check('G4. the plan text marks volatile pages for the Explorer',
  /VOLATILE generated-id URL/.test(fs.readFileSync('src/agent/runtime.ts', 'utf8')));

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the page filter passes small sets through, falls back deterministically to the shallowest unique pages, and validates every model pick against the input.');
