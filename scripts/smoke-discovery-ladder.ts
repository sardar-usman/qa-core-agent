/**
 * Locks the multi-page discovery ladder (src/agent/discovery.ts):
 *   - rung order: srs -> user -> sitemap -> crawl -> entry (user sits above
 *     sitemap/crawl on purpose: an explicit --urls list must not be overridden
 *     by remote discovery)
 *   - robots.txt honored by BOTH sitemap and crawl; disallow-all skips both
 *     rungs and routes to the user list / entry fallback with the reason
 *     recorded
 *   - same-origin filtering, asset and fragment skipping, dedupe by pathname
 *   - the 30-page sitemap cap trims keeping the shallowest paths
 *   - sitemap-index nesting (one level)
 *   - the crawl: depth cap, page cap, robots-disallowed paths skipped,
 *     discovery user agent sent, sequential fetching
 *   - the entry-only fallback carries warnings naming what each rung tried
 *   - every crawl candidate records linkedFrom, the page whose anchor led to
 *     it (invariant 71: a volatile trigger page's origin); the crawl caps,
 *     the delay and the robots rules are unchanged by it
 *   - the sitemap is a seed, not a ceiling (invariant 75, run 59540f D1):
 *     L a 3-page sitemap whose crawl finds 6 more, with features the sitemap
 *       does not carry, merges as "sitemap+crawl" with the continuing line;
 *       L7 to L9 the browser crawl merges the same way, and adds nothing
 *       when it finds nothing new
 *     M a sitemap carrying every feature skips the crawl, with its line
 *     N no feature list: the crawl runs and merges
 *     O robots Disallow /auth with /auth/login linked from the entry and a
 *       feature "account": robotsSkipped holds /auth/login with its rule,
 *       the feature line prints (scripts/discover-site.ts as a child
 *       process too), and rule coverage reads robots-disallowed
 *
 * In-code fixtures via the injectable fetchFn and rendered-link collector,
 * plus local servers on 127.0.0.1. No outside network. No LLM.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  discoverPages,
  parseRobotsTxt,
  robotsAllows,
  robotsBlockedFeatures,
  robotsDisallowedDetails,
  discoveryFeatureList,
  DISCOVERY_UA,
  SITEMAP_PAGE_CAP,
  CRAWL_PAGE_CAP,
  CRAWL_VOLATILE_CAP,
  CRAWL_MAX_DEPTH,
  CRAWL_DELAY_MS,
  type FetchLike,
  type RenderedLinkCollector,
  waitForAnchors,
} from '../src/agent/discovery.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { featureTokenMap, type RequirementsMap } from '../src/agent/requirements.js';
import { computeRuleCoverage, renderRuleCoverage } from '../src/agent/rule-coverage.js';
import { unreachableFeatures } from '../src/agent/planner.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' — ' + hint : ''}`); }
};

const ORIGIN = 'https://shop.example';

/** Fixture fetch: URL -> body (string) or status (number). Records requests. */
function fixtureFetch(routes: Record<string, string | number>): { fetchFn: FetchLike; requests: Array<{ url: string; ua?: string }> } {
  const requests: Array<{ url: string; ua?: string }> = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({ url, ua: init?.headers?.['user-agent'] });
    const hit = routes[url];
    if (hit === undefined) return { ok: false, status: 404, text: async () => '' };
    if (typeof hit === 'number') return { ok: false, status: hit, text: async () => '' };
    return { ok: true, status: 200, text: async () => hit };
  };
  return { fetchFn, requests };
}

const sitemapXml = (urls: string[]): string =>
  `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;

/** Fake rendered-DOM collector: URL -> hrefs (or null = load failed). Counts calls. */
function fakeCollector(routes: Record<string, string[] | null>): { collect: RenderedLinkCollector; calls: string[] } {
  const calls: string[] = [];
  const collect: RenderedLinkCollector = async (url) => {
    calls.push(url);
    return routes[url] !== undefined ? routes[url] : null;
  };
  return { collect, calls };
}

/* ─── A. robots.txt parsing ────────────────────────────────────────────────── */
const robots = parseRobotsTxt(
  `# comment\nUser-agent: *\nDisallow: /admin\nDisallow: /private/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`,
);
check('A1. Disallow rules for * apply to our agent', JSON.stringify(robots.disallow) === '["/admin","/private/"]', JSON.stringify(robots.disallow));
check('A2. the Sitemap directive is noted', robots.sitemaps[0] === `${ORIGIN}/sitemap.xml`);
check('A3. a disallowed path is refused', !robotsAllows(robots, '/admin/panel') && !robotsAllows(robots, '/private/x'));
check('A4. an allowed path passes', robotsAllows(robots, '/login'));
const specific = parseRobotsTxt(`User-agent: qa-core-agent-discovery\nDisallow: /only-for-us\n\nUser-agent: *\nDisallow: /for-everyone\n`);
check('A5. a group naming our agent wins over *', JSON.stringify(specific.disallow) === '["/only-for-us"]', JSON.stringify(specific.disallow));
check('A6. Disallow: / means disallow-all', parseRobotsTxt('User-agent: *\nDisallow: /\n').disallowAll);

/* ─── B. rung 1: SRS map with stated URLs ──────────────────────────────────── */
const map: RequirementsMap = {
  features: [
    { name: 'login', description: 'sign in', urls: ['/login'], rules: [{ id: 'R1', text: 'x', type: 'validation' }] },
    { name: 'cart', description: 'cart', urls: [`${ORIGIN}/cart`, '/login'], rules: [] },
  ],
  roles: [],
  truncated: false,
};
{
  const { fetchFn, requests } = fixtureFetch({});
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, requirements: map, fetchFn, crawlDelayMs: 0 });
  check('B1. SRS rung wins when the map states URLs', r.method === 'srs' && r.pages.length === 2, JSON.stringify(r.pages));
  check('B2. SRS pages are tagged with their feature', r.pages[0]?.feature === 'login' && r.pages[1]?.feature === 'cart');
  check('B3. SRS pages dedupe by pathname (cart also cited /login)', r.pages.filter((p) => p.url.endsWith('/login')).length === 1);
  check('B4. the SRS rung makes no network fetches', requests.length === 0, String(requests.length));
}

/* ─── C. rung 2: explicit user list beats sitemap/crawl ────────────────────── */
{
  const { fetchFn, requests } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow:\n`,
    [`${ORIGIN}/sitemap.xml`]: sitemapXml([`${ORIGIN}/a`, `${ORIGIN}/b`]),
  });
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, userUrls: ['/login', `${ORIGIN}/cart`, '/login#frag', 'not a url'], fetchFn, crawlDelayMs: 0 });
  check('C1. user rung wins over an available sitemap', r.method === 'user', r.method);
  check('C2. user pages resolve, dedupe by pathname, and drop junk', r.pages.length === 2 && r.pages.every((p) => p.source === 'user'), JSON.stringify(r.pages));
  check('C3. the unusable --urls value is warned about', r.warnings.some((w) => w.includes('not a url')), JSON.stringify(r.warnings));
  check('C4. no sitemap fetch happened (rung never reached)', !requests.some((q) => q.url.includes('sitemap')), JSON.stringify(requests));
}

/* ─── D. rung 3: sitemap via robots directive, same-origin, cap, dedupe ────── */
{
  // 35 URLs: depths 1..35 scattered, plus cross-origin and asset noise and a
  // robots-disallowed path. The cap must keep the 30 shallowest.
  const deep = Array.from({ length: 33 }, (_, i) => `${ORIGIN}/${'d/'.repeat((i % 6) + 1)}page${i}`);
  const locs = [
    `${ORIGIN}/`, `${ORIGIN}/login`, `https://other.example/steal`, `${ORIGIN}/logo.png`,
    `${ORIGIN}/admin/secret`, `${ORIGIN}/login`, ...deep,
  ];
  const { fetchFn } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow: /admin\nSitemap: ${ORIGIN}/deep/sitemap-main.xml\n`,
    [`${ORIGIN}/deep/sitemap-main.xml`]: sitemapXml(locs),
  });
  // No feature list, so the crawl runs after the sitemap (invariant 75); the
  // entry page is not served here, so neither crawl adds a page and the
  // sitemap stands alone. The fake collector keeps the browser rung offline.
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn, crawlDelayMs: 0, collectRendered: fakeCollector({}).collect });
  check('D1. sitemap rung fires via the robots Sitemap directive', r.method === 'sitemap', r.method);
  check(`D2. capped at ${SITEMAP_PAGE_CAP} pages`, r.pages.length === SITEMAP_PAGE_CAP, String(r.pages.length));
  check('D3. cross-origin URL excluded', !r.pages.some((p) => p.url.includes('other.example')));
  check('D4. asset URL excluded', !r.pages.some((p) => p.url.endsWith('.png')));
  check('D5. robots-disallowed path excluded from the sitemap set', !r.pages.some((p) => p.url.includes('/admin')));
  check('D6. dedupe by pathname (login listed twice, kept once)', r.pages.filter((p) => p.url.endsWith('/login')).length === 1);
  const depths = r.pages.map((p) => new URL(p.url).pathname.split('/').filter(Boolean).length);
  check('D7. trimming keeps the shallowest paths (all kept depths <= dropped depths)', Math.max(...depths) <= 6, JSON.stringify(depths));
  check('D8. shallow pages like / and /login survive the trim', r.pages.some((p) => new URL(p.url).pathname === '/') && r.pages.some((p) => p.url.endsWith('/login')));
  check('D9. the trim is warned about', r.warnings.some((w) => w.includes(`trimmed to ${SITEMAP_PAGE_CAP}`)), JSON.stringify(r.warnings));
}

/* ─── E. sitemap index nesting (one level) ─────────────────────────────────── */
{
  const { fetchFn } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: 404,
    [`${ORIGIN}/sitemap.xml`]: `<?xml version="1.0"?><sitemapindex><sitemap><loc>${ORIGIN}/sm-1.xml</loc></sitemap><sitemap><loc>${ORIGIN}/sm-2.xml</loc></sitemap></sitemapindex>`,
    [`${ORIGIN}/sm-1.xml`]: sitemapXml([`${ORIGIN}/a`]),
    [`${ORIGIN}/sm-2.xml`]: sitemapXml([`${ORIGIN}/b`]),
  });
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn, crawlDelayMs: 0, collectRendered: fakeCollector({}).collect });
  check('E1. a sitemap index is followed one level deep', r.method === 'sitemap' && r.pages.length === 2, JSON.stringify(r.pages));
}

/* ─── F. rung 4: polite crawl when no sitemap exists ───────────────────────── */
{
  const { fetchFn, requests } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow: /admin\n`,
    [`${ORIGIN}/sitemap.xml`]: 404,
    [`${ORIGIN}/`]: `<a href="/login">L</a> <a href="/cart">C</a> <a href="/admin">A</a> <a href="/logo.svg">S</a> <a href="#top">T</a> <a href="https://other.example/x">O</a> <a href="/login#reset">dup</a>`,
    [`${ORIGIN}/login`]: `<a href="/login/help">H</a>`,
    [`${ORIGIN}/cart`]: `<a href="/checkout">K</a>`,
    [`${ORIGIN}/login/help`]: `<a href="/too/deep/now">D</a>`,
    [`${ORIGIN}/checkout`]: ``,
  });
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn, crawlDelayMs: 0 });
  check('F1. crawl rung fires when the sitemap 404s', r.method === 'crawl', r.method);
  const paths = r.pages.map((p) => new URL(p.url).pathname).sort();
  check('F2. crawl collects entry + linked pages, depth-capped', JSON.stringify(paths) === JSON.stringify(['/', '/cart', '/checkout', '/login', '/login/help']), JSON.stringify(paths));
  check('F3. depth-3 link never fetched', !requests.some((q) => q.url.includes('/too/deep/now')));
  check('F4. robots-disallowed link never fetched', !requests.some((q) => q.url.includes('/admin')));
  check('F5. asset and cross-origin links never fetched', !requests.some((q) => q.url.endsWith('.svg') || q.url.includes('other.example')));
  check('F6. crawl fetches identify with the discovery user agent', requests.filter((q) => !q.url.includes('robots') && !q.url.includes('sitemap')).every((q) => q.ua === DISCOVERY_UA));
  check(`F7. page cap constant is ${CRAWL_PAGE_CAP}`, CRAWL_PAGE_CAP === 15);
  check('F8. fragment link deduped by pathname (login fetched once)', requests.filter((q) => new URL(q.url).pathname === '/login').length === 1);
  const from = Object.fromEntries(r.pages.map((p) => [new URL(p.url).pathname, p.linkedFrom ? new URL(p.linkedFrom).pathname : null]));
  check('F9. every candidate records linkedFrom, the page whose anchor led to it; the entry has none',
    JSON.stringify(from) === JSON.stringify({ '/': null, '/login': '/', '/cart': '/', '/login/help': '/login', '/checkout': '/cart' }), JSON.stringify(from));
  check('F10. the crawl caps, delay and depth are unchanged', CRAWL_PAGE_CAP === 15 && CRAWL_VOLATILE_CAP === 3 && CRAWL_MAX_DEPTH === 2 && CRAWL_DELAY_MS === 500);
}

/* ─── G. robots disallow-all routes past sitemap AND crawl ─────────────────── */
{
  const routes = {
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow: /\n`,
    [`${ORIGIN}/sitemap.xml`]: sitemapXml([`${ORIGIN}/a`]),
    [`${ORIGIN}/`]: `<a href="/login">L</a>`,
  };
  const withUser = await discoverPages({ entryUrl: `${ORIGIN}/`, userUrls: ['/manual'], fetchFn: fixtureFetch(routes).fetchFn, crawlDelayMs: 0 });
  check('G1. disallow-all + --urls routes to the user rung', withUser.method === 'user', withUser.method);

  const f2 = fixtureFetch(routes);
  const noUser = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn: f2.fetchFn, crawlDelayMs: 0 });
  check('G2. disallow-all with no user list falls to entry-only', noUser.method === 'entry' && noUser.pages[0]?.source === 'entry');
  check('G3. the robots block is named in the warnings', noUser.warnings.some((w) => w.includes('disallows all paths')), JSON.stringify(noUser.warnings));
  check('G4. neither the sitemap nor any page was fetched', f2.requests.every((q) => q.url.endsWith('/robots.txt')), JSON.stringify(f2.requests));
}

/* ─── H. entry-only fallback carries every rung's warnings ─────────────────── */
{
  const { fetchFn } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: 404,
    [`${ORIGIN}/sitemap.xml`]: 500,
    [`${ORIGIN}/`]: `<p>no links here</p>`,
  });
  const emptyMap: RequirementsMap = {
    features: [{ name: 'login', description: 'no urls stated', rules: [] }],
    roles: [],
    truncated: false,
  };
  // Browser rung's collector fails on every page too (SPA that will not load).
  const { collect } = fakeCollector({});
  const r = await discoverPages({ entryUrl: `${ORIGIN}/landing`, requirements: emptyMap, fetchFn, crawlDelayMs: 0, collectRendered: collect });
  check('H1. everything failing yields the entry page, source entry', r.method === 'entry' && r.pages.length === 1 && r.pages[0]?.url === `${ORIGIN}/landing`);
  check('H2. the SRS rung recorded why it yielded nothing', r.warnings.some((w) => w.includes('no feature states a URL')));
  check('H3. the sitemap rung recorded its failure', r.warnings.some((w) => w.includes('HTTP 500')));
  check('H4. the crawl rung recorded why it yielded nothing', r.warnings.some((w) => w.includes('no additional same-origin pages') && w.startsWith('crawl:')));
  check('H5. the browser-crawl rung recorded its failure too', r.warnings.some((w) => w.startsWith('browser crawl:')), JSON.stringify(r.warnings));
  check('H6. the fallback itself is loud', r.warnings.some((w) => w.includes('fell back to the entry page')));
}

/* ─── I. browser-crawl rung: fires only when the fetch crawl finds nothing ─── */
{
  // A client-rendered SPA: plain fetch returns a shell with no anchors, the
  // rendered DOM has the real links (this is what happened live on
  // practicesoftwaretesting.com).
  const shell = `<div id="app"></div><script src="/main.js"></script>`;
  const { fetchFn } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow: /admin\n`,
    [`${ORIGIN}/sitemap.xml`]: 404,
    [`${ORIGIN}/`]: shell,
  });
  const { collect, calls } = fakeCollector({
    [`${ORIGIN}/`]: ['/login', '/cart', '/admin', '/logo.png', 'https://other.example/x', '/login#reset'],
    [`${ORIGIN}/login`]: ['/login/help'],
    [`${ORIGIN}/cart`]: [],
    [`${ORIGIN}/login/help`]: ['/too/deep/now'],
  });
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn, crawlDelayMs: 0, collectRendered: collect });
  check('I1. browser-crawl rung fires when the fetch crawl finds no links', r.method === 'browser-crawl', r.method);
  const paths = r.pages.map((p) => new URL(p.url).pathname).sort();
  check('I2. rendered links collected with the same depth cap and filters', JSON.stringify(paths) === JSON.stringify(['/', '/cart', '/login', '/login/help']), JSON.stringify(paths));
  check('I3. every page carries source browser-crawl', r.pages.every((p) => p.source === 'browser-crawl'));
  check('I4. robots-disallowed link never visited by the browser', !calls.includes(`${ORIGIN}/admin`), JSON.stringify(calls));
  check('I5. asset, cross-origin, and depth-3 links never visited', !calls.some((c) => c.endsWith('.png') || c.includes('other.example') || c.includes('/too/deep/now')));
  check('I6. fragment link deduped by pathname (login visited once)', calls.filter((c) => new URL(c).pathname === '/login').length === 1);
  const from = Object.fromEntries(r.pages.map((p) => [new URL(p.url).pathname, p.linkedFrom ? new URL(p.linkedFrom).pathname : null]));
  check('I7. the browser crawl records linkedFrom the same way', JSON.stringify(from) === JSON.stringify({ '/': null, '/login': '/', '/cart': '/', '/login/help': '/login' }), JSON.stringify(from));
}

/* ─── J. browser-crawl rung is SKIPPED when the fetch crawl succeeded ──────── */
{
  const { fetchFn } = fixtureFetch({
    [`${ORIGIN}/robots.txt`]: 404,
    [`${ORIGIN}/sitemap.xml`]: 404,
    [`${ORIGIN}/`]: `<a href="/login">L</a>`,
    [`${ORIGIN}/login`]: ``,
  });
  const { collect, calls } = fakeCollector({ [`${ORIGIN}/`]: ['/never-used'] });
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn, crawlDelayMs: 0, collectRendered: collect });
  check('J1. fetch crawl succeeding keeps the cheap path', r.method === 'crawl', r.method);
  check('J2. the browser collector is never invoked', calls.length === 0, JSON.stringify(calls));
}

/* ─── K. robots disallow-all also skips the browser-crawl rung ─────────────── */
{
  const { fetchFn } = fixtureFetch({ [`${ORIGIN}/robots.txt`]: `User-agent: *\nDisallow: /\n` });
  const { collect, calls } = fakeCollector({ [`${ORIGIN}/`]: ['/x'] });
  const r = await discoverPages({ entryUrl: `${ORIGIN}/`, fetchFn, crawlDelayMs: 0, collectRendered: collect });
  check('K1. disallow-all yields entry-only with the browser rung untouched', r.method === 'entry' && calls.length === 0, `${r.method} calls=${calls.length}`);
}

/* ─── I. a SPA whose anchors render after the shell is crawled by the browser rung ── */
// Live evidence: on practicesoftwaretesting.com the product anchors render
// after the settle poll returns, so the crawl never saw them. The rendered
// collector now waits for the anchor count to stop growing.
{
  const fakePage = (counts: number[]) => { let i = 0; return { evaluate: async () => counts[Math.min(i++, counts.length - 1)]! }; };
  // Six nav anchors at load, twenty product anchors after 800 ms: the wait
  // must not accept the nav's own steady count.
  const grown = await waitForAnchors(fakePage([6, 6, 6, 6, 20, 20, 20]), 3000);
  check('I1. waitForAnchors treats the first reading as the baseline and returns once the count has grown past it and held', grown.count === 20 && grown.polls[0] === 6 && grown.polls.includes(20), JSON.stringify(grown));
  const t0 = Date.now();
  const navOnly = await waitForAnchors(fakePage([6]), 600);
  check('I2. a page with nav only returns its count at the cap, never hangs, with every poll recorded', navOnly.count === 6 && navOnly.polls.every((n) => n === 6) && navOnly.polls.length >= 3 && Date.now() - t0 < 1500 && Date.now() - t0 >= 500, JSON.stringify(navOnly));
}
{
  // A local SPA: the shell has a heading and an input (so the settle poll is
  // satisfied at once) and renders its links 500ms later. robots.txt and
  // sitemap.xml are 404, so the ladder walks down to the browser crawl.
  // The anchors are built with createElement so the raw HTML carries no
  // "href=" text at all: the plain fetch crawl must see a bare shell.
  const shell = (title: string): string => `<!doctype html><html><body><h1>${title}</h1><input id="q"><div id="links"></div><script>setTimeout(function(){var d=document.getElementById('links');['/login','/cart','/product/01ABCDEFGHJKMNPQRSTVWXYZ01'].forEach(function(p){var a=document.createElement('a');a.setAttribute('h'+'ref',p);a.textContent=p;d.appendChild(a);});},500)</script></body></html>`;
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/robots.txt' || url === '/sitemap.xml') { res.writeHead(404); res.end(''); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(shell(url));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const r = await discoverPages({ entryUrl: `${base}/`, crawlDelayMs: 0 });
    const paths = r.pages.map((p) => new URL(p.url).pathname).sort();
    check('I3. the fetch crawl saw the bare shell and fell through', r.warnings.some((w) => w.startsWith('crawl:') && w.includes('no additional same-origin pages')), JSON.stringify(r.warnings));
    check('I4. the browser rung crawled the late-rendered anchors', r.method === 'browser-crawl' && paths.includes('/login') && paths.includes('/cart'), JSON.stringify({ method: r.method, paths }));
    check('I5. the generated-id product page is found and tagged volatile', r.pages.some((p) => p.url.includes('/product/') && p.volatile === true), JSON.stringify(r.pages));
    check('I6. each crawled candidate records the anchor count seen at every poll (0 at load, then the rendered links)', r.pages.every((p) => Array.isArray(p.anchorPolls) && p.anchorPolls.length >= 2 && p.anchorPolls[0] === 0 && Math.max(...p.anchorPolls) === 3), JSON.stringify(r.pages.map((p) => p.anchorPolls)));
  } finally {
    server.close();
  }
}

/* ─── L. the sitemap is a seed: features not carried, the crawl merges ─────── */
const SEED = 'https://seed.example';
const seedMap: RequirementsMap = {
  features: [
    { name: 'catalogue', description: 'browse products by category', rules: [{ id: 'R1', text: 'Products can be sorted by name.', type: 'behavior' }] },
    { name: 'account', description: 'sign in and registration', rules: [{ id: 'R2', text: 'A registered user can log in with an email and a password.', type: 'behavior' }, { id: 'R3', text: 'A wrong password shows an error.', type: 'validation' }] },
    { name: 'cart', description: 'the cart', rules: [{ id: 'R4', text: 'Items added to the cart are listed in it.', type: 'behavior' }] },
    { name: 'contact', description: 'the contact form', rules: [{ id: 'R5', text: 'The contact form requires an email.', type: 'validation' }] },
  ],
  roles: [],
  truncated: false,
};
const PRODUCT = '/product/01ABCDEFGHJKMNPQRSTVWXYZ01';
{
  const { fetchFn, requests } = fixtureFetch({
    [`${SEED}/robots.txt`]: `User-agent: *\nDisallow:\nSitemap: ${SEED}/sitemap.xml\n`,
    [`${SEED}/sitemap.xml`]: sitemapXml([`${SEED}/`, `${SEED}/contact`, `${SEED}/privacy`]),
    [`${SEED}/`]: ['/category/hand-tools', '/category/power-tools', '/rentals', PRODUCT, '/auth/login', '/auth/register', '/contact', '/privacy'].map((h) => `<a href="${h}">x</a>`).join(' '),
    [`${SEED}/category/hand-tools`]: '', [`${SEED}/category/power-tools`]: '', [`${SEED}/rentals`]: '', [`${SEED}${PRODUCT}`]: '',
    [`${SEED}/auth/login`]: '', [`${SEED}/auth/register`]: '', [`${SEED}/contact`]: '', [`${SEED}/privacy`]: '',
  });
  const browser = fakeCollector({ [`${SEED}/`]: ['/never-used'] });
  const r = await discoverPages({ entryUrl: `${SEED}/`, requirements: seedMap, fetchFn, crawlDelayMs: 0, collectRendered: browser.collect });
  const paths = r.pages.map((p) => new URL(p.url).pathname);
  check('L1. a 3-page sitemap whose crawl finds 6 more merges: method "sitemap+crawl"', r.method === 'sitemap+crawl', r.method);
  check('L2. the continuing line names the features no sitemap page carries',
    r.warnings.includes('sitemap: 3 page(s); no sitemap page carries feature(s) catalogue, account, cart; continuing to the crawl and merging.'), JSON.stringify(r.warnings));
  check('L3. sitemap entries first, then the 6 crawl pages in crawl order, deduped by origin plus pathname (/, /contact and /privacy once)',
    JSON.stringify(paths) === JSON.stringify(['/', '/contact', '/privacy', '/category/hand-tools', '/category/power-tools', '/rentals', PRODUCT, '/auth/login', '/auth/register']), JSON.stringify(paths));
  check('L4. every page keeps its own source: sitemap for the seed, crawl for the rest',
    r.pages.slice(0, 3).every((p) => p.source === 'sitemap') && r.pages.slice(3).every((p) => p.source === 'crawl'), JSON.stringify(r.pages.map((p) => p.source)));
  check('L5. crawl pages keep linkedFrom, the generated-id page is tagged volatile, and a seed page the crawl also reached gains its linkedFrom',
    r.pages.slice(3).every((p) => p.linkedFrom === `${SEED}/`) && r.pages.find((p) => p.url.endsWith(PRODUCT))?.volatile === true && r.pages.find((p) => p.url.endsWith('/contact'))?.linkedFrom === `${SEED}/`, JSON.stringify(r.pages));
  check('L6. the fetch crawl added pages, so the browser crawl never ran; robots.txt was read and skipped nothing ([] recorded)', browser.calls.length === 0 && JSON.stringify(r.robotsSkipped) === '[]', JSON.stringify({ calls: browser.calls, skipped: r.robotsSkipped }));
  check('L6b. the crawl caps, delay and user agent are unchanged on the seed path', requests.filter((q) => !q.url.endsWith('robots.txt') && !q.url.endsWith('sitemap.xml')).every((q) => q.ua === DISCOVERY_UA) && CRAWL_PAGE_CAP === 15 && CRAWL_DELAY_MS === 500);
}
{
  // The fetch crawl sees a SPA shell; the browser crawl reads the rendered links and merges.
  const { fetchFn } = fixtureFetch({
    [`${SEED}/robots.txt`]: 404,
    [`${SEED}/sitemap.xml`]: sitemapXml([`${SEED}/`, `${SEED}/contact`, `${SEED}/privacy`]),
    [`${SEED}/`]: '<div id="app"></div>',
  });
  const browser = fakeCollector({ [`${SEED}/`]: ['/category/hand-tools', '/contact'], [`${SEED}/category/hand-tools`]: [], [`${SEED}/contact`]: [] });
  const r = await discoverPages({ entryUrl: `${SEED}/`, requirements: seedMap, fetchFn, crawlDelayMs: 0, collectRendered: browser.collect });
  check('L7. the fetch crawl adds nothing, the browser crawl adds a page: method "sitemap+browser-crawl", the new page source browser-crawl',
    r.method === 'sitemap+browser-crawl' && JSON.stringify(r.pages.map((p) => `${new URL(p.url).pathname}:${p.source}`)) === JSON.stringify(['/:sitemap', '/contact:sitemap', '/privacy:sitemap', '/category/hand-tools:browser-crawl']) && !!r.pageControls,
    JSON.stringify({ method: r.method, pages: r.pages.map((p) => p.url) }));
}
{
  // Both crawls find only the sitemap's own pages: the sitemap stands alone, from one rung, and the warnings say so.
  const { fetchFn } = fixtureFetch({
    [`${SEED}/robots.txt`]: 404,
    [`${SEED}/sitemap.xml`]: sitemapXml([`${SEED}/`, `${SEED}/contact`, `${SEED}/privacy`]),
    [`${SEED}/`]: '<a href="/contact">c</a>', [`${SEED}/contact`]: '',
  });
  const browser = fakeCollector({ [`${SEED}/`]: ['/privacy'], [`${SEED}/privacy`]: [] });
  const r = await discoverPages({ entryUrl: `${SEED}/`, requirements: seedMap, fetchFn, crawlDelayMs: 0, collectRendered: browser.collect });
  check('L8. crawls that add nothing beyond the seed keep method "sitemap" and the 3 sitemap pages', r.method === 'sitemap' && r.pages.length === 3 && r.pages.every((p) => p.source === 'sitemap'), JSON.stringify({ method: r.method, pages: r.pages }));
  check('L9. both crawls say they added nothing beyond the sitemap set and the entry',
    r.warnings.includes('crawl: found 2 page(s), none beyond the sitemap set and the entry; trying the browser crawl.') && r.warnings.includes('browser crawl: added no page beyond the sitemap set and the entry; the sitemap pages stand alone.') && browser.calls.length === 2,
    JSON.stringify(r.warnings));
}

/* ─── M. a sitemap whose pages carry every feature: the crawl is skipped ───── */
{
  const carried: RequirementsMap = {
    features: [
      { name: 'contact', description: 'the contact form', rules: [{ id: 'R1', text: 'The contact form requires an email.', type: 'validation' }] },
      { name: 'login', description: 'sign in', rules: [{ id: 'R2', text: 'A wrong password shows an error.', type: 'validation' }] },
    ],
    roles: [],
    truncated: false,
  };
  const routes = {
    [`${SEED}/robots.txt`]: `User-agent: *\nDisallow:\n`,
    [`${SEED}/sitemap.xml`]: sitemapXml([`${SEED}/`, `${SEED}/contact`, `${SEED}/login`]),
    [`${SEED}/`]: '<a href="/elsewhere">x</a>',
  };
  const f = fixtureFetch(routes);
  const browser = fakeCollector({ [`${SEED}/`]: ['/elsewhere'] });
  const r = await discoverPages({ entryUrl: `${SEED}/`, requirements: carried, fetchFn: f.fetchFn, crawlDelayMs: 0, collectRendered: browser.collect });
  check('M1. every feature carried by a sitemap page: method "sitemap", the 3 pages', r.method === 'sitemap' && r.pages.length === 3, JSON.stringify({ method: r.method, pages: r.pages.map((p) => p.url) }));
  check('M2. the skipped line names every feature', r.warnings.includes('sitemap: 3 page(s) carry every feature (contact, login); crawl skipped.'), JSON.stringify(r.warnings));
  check('M3. neither crawl ran: no page fetched beyond robots.txt and the sitemap, the browser collector never called',
    f.requests.every((q) => q.url.endsWith('/robots.txt') || q.url.endsWith('/sitemap.xml')) && browser.calls.length === 0, JSON.stringify(f.requests.map((q) => q.url)));
  // The same with --features and no map.
  const f2 = fixtureFetch(routes);
  const r2 = await discoverPages({ entryUrl: `${SEED}/`, features: ['contact', 'login'], fetchFn: f2.fetchFn, crawlDelayMs: 0, collectRendered: fakeCollector({}).collect });
  check('M4. a --features list counts as the feature list: carried by the sitemap, the crawl is skipped',
    r2.method === 'sitemap' && r2.warnings.includes('sitemap: 3 page(s) carry every feature (contact, login); crawl skipped.') && f2.requests.every((q) => q.url.endsWith('/robots.txt') || q.url.endsWith('/sitemap.xml')), JSON.stringify(r2.warnings));
  check('M5. a map\'s features win over --features, as in the page filter', JSON.stringify(discoveryFeatureList(carried, ['cart'])) === '["contact","login"]' && JSON.stringify(discoveryFeatureList(undefined, [' cart ', ''])) === '["cart"]');
}

/* ─── N. no feature list: the crawl runs and merges ─────────────────────── */
{
  const { fetchFn, requests } = fixtureFetch({
    [`${SEED}/robots.txt`]: 404,
    [`${SEED}/sitemap.xml`]: sitemapXml([`${SEED}/`, `${SEED}/a`]),
    [`${SEED}/`]: '<a href="/b">b</a>', [`${SEED}/b`]: '',
  });
  const r = await discoverPages({ entryUrl: `${SEED}/`, fetchFn, crawlDelayMs: 0, collectRendered: fakeCollector({}).collect });
  check('N1. with no feature list the crawl runs after a non-empty sitemap and merges', r.method === 'sitemap+crawl' && JSON.stringify(r.pages.map((p) => new URL(p.url).pathname)) === JSON.stringify(['/', '/a', '/b']) && requests.some((q) => q.url === `${SEED}/b`), JSON.stringify(r.pages));
  check('N2. the no-feature-list line prints', r.warnings.includes('sitemap: 2 page(s); no feature list, so the crawl runs and merges.'), JSON.stringify(r.warnings));
}

/* ─── O. robots Disallow /auth: the skip, the feature line, robots-disallowed coverage ── */
{
  const accountMap: RequirementsMap = {
    features: [
      { name: 'account', description: 'the account', rules: [{ id: 'R10', text: 'A registered user can log in with an email and a password.', type: 'behavior' }, { id: 'R11', text: 'A wrong password shows an error.', type: 'validation' }] },
      { name: 'contact', description: 'the contact form', rules: [{ id: 'R5', text: 'The contact form requires an email.', type: 'validation' }] },
    ],
    roles: [],
    truncated: false,
  };
  const { fetchFn, requests } = fixtureFetch({
    [`${SEED}/robots.txt`]: `User-agent: *\nDisallow: /auth\nDisallow: /admin\n`,
    [`${SEED}/sitemap.xml`]: 404,
    [`${SEED}/`]: '<a href="/auth/login">Sign in</a> <a href="/contact">Contact</a> <a href="/admin">A</a> <a href="/auth/login#top">again</a>',
    [`${SEED}/contact`]: '<a href="/auth/login">Sign in</a>',
  });
  const r = await discoverPages({ entryUrl: `${SEED}/`, requirements: accountMap, fetchFn, crawlDelayMs: 0, collectRendered: fakeCollector({}).collect });
  check('O1. robotsSkipped holds /auth/login with the rule that matched (and /admin), deduped by path, and /auth/login was never fetched',
    JSON.stringify(r.robotsSkipped) === JSON.stringify([{ path: '/auth/login', rule: '/auth' }, { path: '/admin', rule: '/admin' }]) && !requests.some((q) => q.url.includes('/auth/')), JSON.stringify({ skipped: r.robotsSkipped, requests: requests.map((q) => q.url) }));
  const blocked = robotsBlockedFeatures({ entryUrl: `${SEED}/`, features: discoveryFeatureList(accountMap, undefined), candidates: r.pages, robotsSkipped: r.robotsSkipped, featureTokens: featureTokenMap(accountMap) });
  const LINE = 'Feature "account": robots.txt disallows its matching path(s) /auth/login (rule Disallow: /auth); not loaded.';
  check('O2. the feature line names the feature, the path and the rule; contact (carried by /contact) gets none', blocked.length === 1 && blocked[0]!.line === LINE, JSON.stringify(blocked));
  const details = robotsDisallowedDetails(accountMap, { pages: r.pages, candidates: r.pages, robotsSkipped: r.robotsSkipped }, `${SEED}/`);
  const cov = computeRuleCoverage({
    map: accountMap, planned: [{ name: 'contact form requires an email', ruleIds: ['R5'] }], scenarios: [{ name: 'contact form requires an email', ruleIds: ['R5'] }],
    unreachableFeatures: unreachableFeatures(accountMap, r.pages, [], []).map((f) => f.name),
    robotsDisallowed: details,
  });
  const u10 = cov.uncovered.find((u) => u.ruleId === 'R10');
  check('O3. coverage reads robots-disallowed, with the paths and the rule as the detail, for both uncited account rules',
    cov.uncovered.length === 2 && cov.uncovered.every((u) => u.reason === 'robots-disallowed') && u10?.detail === 'robots.txt disallows its matching path(s) /auth/login (rule Disallow: /auth); not loaded', JSON.stringify(cov.uncovered));
  const without = computeRuleCoverage({ map: accountMap, planned: [], scenarios: [], unreachableFeatures: ['account'] });
  check('O4. only those rules change: without the robots record the same rules read not-reachable, and a cited rule keeps its own reason',
    without.uncovered.filter((u) => u.ruleId !== 'R5').every((u) => u.reason === 'not-reachable') &&
    computeRuleCoverage({ map: accountMap, planned: [{ name: 'x', ruleIds: ['R10'] }], scenarios: [], robotsDisallowed: details }).uncovered.find((u) => u.ruleId === 'R10')?.reason === 'planned-but-dropped');
  check('O5. the console print names the reason and the detail', renderRuleCoverage(cov).some((l) => l.includes('R10 (robots-disallowed: robots.txt disallows its matching path(s) /auth/login (rule Disallow: /auth); not loaded)')), renderRuleCoverage(cov).join(' | '));
  check('O6. the no-discovered-page line is not printed for a robots-blocked feature (its own line says why)', !unreachableFeatures(accountMap, r.pages, [], [], ['account']).some((f) => f.name === 'account') && unreachableFeatures(accountMap, r.pages, [], []).some((f) => f.name === 'account'));

  // The same site served locally, through scripts/discover-site.ts as a child process.
  const http2 = (await import('node:http')).default;
  const site = http2.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/robots.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('User-agent: *\nDisallow: /auth\n'); return; }
    if (u.pathname === '/sitemap.xml') { res.writeHead(404); res.end(''); return; }
    if (u.pathname === '/' || u.pathname === '/contact') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<a href="/auth/login">Sign in</a> <a href="/contact">Contact</a>'); return; }
    res.writeHead(404); res.end('');
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-discover-site-'));
  try {
    const mapFile = path.join(cwd, 'requirements-map.json');
    fs.writeFileSync(mapFile, JSON.stringify(accountMap));
    const script = path.resolve('scripts/discover-site.ts');
    const tsx = path.resolve('node_modules/.bin/tsx');
    const env = { ...process.env, ANTHROPIC_API_KEY: 'fixture-key-never-sent', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };
    // Async: the fixture site answers from this process, so the child must not block it.
    const runScript = (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> => new Promise((resolve) => {
      const child = spawn(tsx, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += String(d); });
      child.stderr.on('data', (d) => { stderr += String(d); });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const out = await runScript([siteUrl, '--map', mapFile]);
    console.log(`  O script: exit ${String(out.status)}; ${out.stdout.split('\n').filter(Boolean).join(' | ')}`);
    check('O7. scripts/discover-site.ts prints the method, every candidate with its source, robotsSkipped, the feature line and the warnings, and exits 0',
      out.status === 0 && out.stdout.includes('method: crawl') && out.stdout.includes(`  ${siteUrl}  (crawl)`) && out.stdout.includes(`  ${siteUrl}contact  (crawl, linked from /)`) &&
      out.stdout.includes('robotsSkipped: 1') && out.stdout.includes('  /auth/login  (Disallow: /auth)') && out.stdout.split('\n').includes(LINE) && out.stdout.includes('warnings: '),
      out.stdout + out.stderr);
    check('O8. the script writes nothing (no output/ folder, no discovery.json) in its working directory', JSON.stringify(fs.readdirSync(cwd)) === '["requirements-map.json"]', JSON.stringify(fs.readdirSync(cwd)));
    const srs = path.join(cwd, 'toolshop-srs.md');
    fs.writeFileSync(srs, '# SRS\n');
    const refused = await runScript([siteUrl, '--map', srs]);
    check('O9. an SRS document as --map is refused before anything runs (building a map would need a model call), exit 2', refused.status === 2 && refused.stderr.includes('would need a model call to build a map, which this script never makes'), refused.stderr);
  } finally {
    site.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the discovery ladder honors rung order and robots.txt, treats a sitemap as a seed, reports every robots skip, filters and caps politely, and never falls into single-page mode silently.');
