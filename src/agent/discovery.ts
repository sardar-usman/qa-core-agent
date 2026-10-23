import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { featureTokenMap, type RequirementsMap } from './requirements.js';
import { pagesCarryingFeature } from './page-filter.js';
import type { PageControl, StateProbe } from './state-probe.js';
import { isVolatilePath } from './volatile-id.js';

/**
 * Multi-page discovery — the ladder that decides WHICH pages a run covers.
 *
 * Without discovery the agent tests only the entry page. With it, the run
 * walks a ladder of sources, stopping at the first rung that yields pages:
 *
 *   1. SRS map    — features in the requirements map that state URLs
 *   2. User list  — an explicit --urls flag value
 *   3. Sitemap    — robots.txt Sitemap directive, then sitemap.xml. A seed,
 *       not a ceiling: the ladder continues to the crawl and merges, unless
 *       a feature list exists and every feature is carried by a sitemap page
 *       by page evidence (run 59540f stopped at a 3-URL sitemap)
 *   4. Polite crawl — same-origin links from the entry page, depth 2
 *   4b. Browser crawl — same walk, links read off the RENDERED DOM. Only
 *       when the fetch crawl found nothing (client-rendered SPAs serve a
 *       shell with no anchors), or added nothing beyond the sitemap set;
 *       static sites keep the cheap path
 *   5. Entry only — the entry URL, with a warning naming why 1-4 failed
 *
 * Note on rung order: the written spec listed the user list AFTER sitemap and
 * crawl. It sits above them here on purpose: an explicit --urls value is the
 * user naming exactly what to test, and letting a sitemap override it would
 * make the flag dead on any site that has one. The SRS stays on top (a stated
 * requirements document outranks a quick flag, and rung 1 only fires when the
 * SRS actually states URLs).
 *
 * Politeness rules (locked by smoke-discovery-ladder):
 * - robots.txt is fetched once and honored by BOTH the sitemap and crawl
 *   rungs. A disallow-all robots skips straight past both, with the reason
 *   recorded. Disallowed paths never appear in the page set.
 * - The crawl is sequential (never parallel), waits CRAWL_DELAY_MS between
 *   fetches, identifies itself with the DISCOVERY_UA user agent, uses plain
 *   HTTP fetch (no browser), and stops at CRAWL_MAX_DEPTH / CRAWL_PAGE_CAP.
 * - The sitemap set is capped at SITEMAP_PAGE_CAP, preferring shallow paths
 *   (fewer segments) when trimming.
 *
 * Never fails silently into single-page mode: every rung that yields nothing
 * records what it tried in `warnings`, and the entry-only fallback names the
 * failed rungs.
 */

/**
 * One step of the action that reveals a state-dependent page (invariant 71).
 * `control` is the locator as emitLocatorCall writes it, without the page
 * receiver: getByTestId("nav-cart"). `via: 'item-link'` is the click on an
 * item by its visible name that leaves the stable origin for a volatile item
 * page (invariant 42). Only 'click' is recorded today; 'login' is designed
 * (docs/design/state-dependent-pages.md section 7), not built.
 */
export interface ReachAction {
  kind: 'click' | 'login';
  control?: string;
  via?: 'item-link';
}

/** How a page found by an action is reached: start on `origin`, perform `actions`. */
export interface ReachedBy {
  origin: string;
  feature: string;
  actions: ReachAction[];
}

export interface DiscoveredPage {
  url: string;
  /** 'action': a page found by an action (state probe), never by a link in a fresh session. */
  source: 'srs' | 'sitemap' | 'crawl' | 'browser-crawl' | 'user' | 'entry' | 'action';
  /** Feature this page belongs to, when the source knows it (SRS rung). */
  feature?: string;
  /**
   * True when the path carries a generated identifier (product/<long-id>).
   * Such URLs rot when the site reseeds its data, so the page filter keeps at
   * most one and the Planner steers scenarios to reach it by durable
   * interaction (listing + click by name), never by direct URL.
   */
  volatile?: boolean;
  /**
   * Browser crawl only: the rendered anchor count at each poll of
   * waitForAnchors, so the record shows whether the page's links had
   * rendered when they were read (run f3b41e read the nav before the
   * catalogue).
   */
  anchorPolls?: number[];
  /**
   * Set by the page filter on a page that shares a path template with a
   * planned page (/category/power-tools when /category/hand-tools is the
   * representative): the representative's URL. Recorded in discovery.json
   * and shown on the Discovery panel, never planned.
   */
  sameTemplateAs?: string;
  /** Crawl candidates only: the page whose anchor led to this candidate. A volatile trigger page's origin is the stable page that linked to it. */
  linkedFrom?: string;
  /** source 'action' only: the origin page and the actions that reveal this page. It is reached by those actions, never navigated to. */
  reachedBy?: ReachedBy;
}

// The generated-id shapes live in volatile-id.ts, shared with the gate's RULE 6.
export { isVolatilePath };

/** Tag each page whose path looks like a generated-id URL. */
function tagVolatile(pages: DiscoveredPage[]): DiscoveredPage[] {
  return pages.map((p) => {
    try {
      return isVolatilePath(new URL(p.url).pathname) ? { ...p, volatile: true } : p;
    } catch {
      return p;
    }
  });
}

/**
 * Collect anchor hrefs from a page's RENDERED DOM (a real browser), for the
 * browser-crawl rung. Returns null when the page could not be loaded.
 * Injectable so the smoke drives the rung with no browser.
 */
export type RenderedLinkCollector = (url: string) => Promise<string[] | { hrefs: string[]; anchorPolls: number[]; controls?: PageControl[] } | null>;

/**
 * The rung, or rungs, that yielded the page set. A result from one rung
 * names it; a sitemap seed merged with a crawl reads "sitemap+crawl" or
 * "sitemap+browser-crawl" (invariant 75).
 */
export type DiscoveryMethod = 'srs' | 'user' | 'sitemap' | 'crawl' | 'browser-crawl' | 'sitemap+crawl' | 'sitemap+browser-crawl' | 'entry';

/** A path a remote rung did not load because robots.txt disallows it, with the Disallow rule that matched. */
export interface RobotsSkip {
  path: string;
  rule: string;
}

/**
 * A requirements feature no candidate carries by page evidence while a
 * robots-skipped path does: the paths, the rules that matched them, and the
 * one line the console prints and the warnings keep.
 */
export interface RobotsBlockedFeature {
  feature: string;
  paths: string[];
  rules: string[];
  line: string;
}

export interface DiscoveryResult {
  pages: DiscoveredPage[];
  /**
   * Every page the winning rung found, BEFORE the relevance filter. The
   * runtime fills this so discovery.json and the Discovery panel can show
   * what was seen and not picked (run ec8eff found 15 and kept 3, and the
   * other 12 were recorded nowhere).
   */
  candidates?: DiscoveredPage[];
  /** The rung, or merged rungs, that yielded the pages. */
  method: DiscoveryMethod;
  warnings: string[];
  /**
   * Every path a remote rung (the sitemap and both crawls) skipped because
   * robots.txt disallows it, with the matching rule, deduped by path, none
   * dropped. [] when a remote rung read robots.txt and skipped nothing;
   * absent when no remote rung ran (an SRS or user rung won, or robots.txt
   * disallows everything, which the warnings say).
   */
  robotsSkipped?: RobotsSkip[];
  /** One record per state-dependent feature the probe ran on (invariant 71). Written to discovery.json and the report. */
  stateProbes?: StateProbe[];
  /**
   * In memory only, never written: the robots.txt rules the remote rungs
   * read, so the state probe honors the same rules without a second fetch.
   * Absent when an SRS or user rung won before robots.txt was read.
   */
  robots?: RobotsInfo;
  /**
   * In memory only, never written: the buttons and links the browser crawl
   * read on each page it loaded, by URL. The state probe looks for a trigger
   * here first, so a page the crawl already loaded costs no second load.
   */
  pageControls?: Record<string, PageControl[]>;
}

/** User agent the sitemap fetches and the crawl identify with. */
export const DISCOVERY_UA = 'qa-core-agent-discovery';
/** Cap on pages taken from a sitemap (shallow paths preferred when trimming). */
export const SITEMAP_PAGE_CAP = 30;
/** Cap on STABLE pages the crawl collects. Volatile generated-id pages never count against it. */
export const CRAWL_PAGE_CAP = 15;
/**
 * How many volatile generated-id pages the crawl loads at all. They are one
 * template (the page filter keeps one), and run 5e4394 spent seven of its
 * fifteen loads on product pages and never reached /auth/register.
 */
export const CRAWL_VOLATILE_CAP = 3;
/** How many link hops from the entry page the crawl follows. */
export const CRAWL_MAX_DEPTH = 2;
/** Pause between crawl fetches. One page at a time, never parallel. */
export const CRAWL_DELAY_MS = 500;
/** Cap on child sitemaps fetched from one sitemap index (one nesting level). */
const SITEMAP_INDEX_CHILD_CAP = 10;
/** Timeout per discovery fetch. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The slice of fetch() discovery uses. Injectable so the smoke test drives the
 * whole ladder from in-code fixtures with zero network.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Default fetch: global fetch with the discovery UA and a hard timeout. */
const defaultFetch: FetchLike = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': DISCOVERY_UA, ...(init?.headers ?? {}) },
      signal: controller.signal,
      redirect: 'follow',
    });
    return { ok: res.ok, status: res.status, text: () => res.text() };
  } finally {
    clearTimeout(timer);
  }
};

/** File extensions that are assets, not pages. Links to these are skipped. */
const ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|rss|atom|pdf|zip|gz|tar|rar|7z|mp4|mp3|wav|webm|mov|woff2?|ttf|eot|otf|map|txt|csv|xlsx?|docx?|pptx?)(\?|$)/i;

/** Schemes that are never pages. */
const NON_PAGE_SCHEME_RE = /^(mailto:|tel:|javascript:|data:|ftp:)/i;

export interface RobotsInfo {
  /** False when robots.txt could not be fetched (treated as allow-all). */
  fetched: boolean;
  /** Disallow path rules that apply to our agent (specific group wins over *). */
  disallow: string[];
  /** Sitemap directive URLs, in file order. */
  sitemaps: string[];
  /** True when a rule disallows every path for our agent. */
  disallowAll: boolean;
}

/**
 * Parse robots.txt for the rules that apply to our agent. Standard group
 * semantics: the group naming our agent (substring match, case-insensitive)
 * wins; otherwise the `*` group applies. Sitemap directives are global.
 * Empty Disallow lines mean allow-all and contribute no rule.
 */
export function parseRobotsTxt(text: string, agent: string = DISCOVERY_UA): Omit<RobotsInfo, 'fetched'> {
  const sitemaps: string[] = [];
  type Group = { agents: string[]; disallow: string[] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'disallow' && current) {
      if (value) current.disallow.push(value);
    }
  }
  const agentLower = agent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && (agentLower.includes(a) || a.includes(agentLower))));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const disallow = (specific ?? wildcard)?.disallow ?? [];
  const disallowAll = disallow.some((d) => d === '/' || d === '/*');
  return { disallow, sitemaps, disallowAll };
}

/** Does robots.txt allow this pathname for our agent? Prefix rules, basic `*` and `$`. */
export function robotsAllows(robots: Pick<RobotsInfo, 'disallow'>, pathname: string): boolean {
  return robotsRuleFor(robots, pathname) === null;
}

/** The first Disallow rule that refuses this pathname, or null when robots.txt allows it. */
export function robotsRuleFor(robots: Pick<RobotsInfo, 'disallow'>, pathname: string): string | null {
  for (const rule of robots.disallow) {
    if (rule.includes('*') || rule.endsWith('$')) {
      const rx = new RegExp(
        '^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$$/, '$').replace(/\*/g, '.*'),
      );
      if (rx.test(pathname)) return rule;
    } else if (pathname.startsWith(rule)) {
      return rule;
    }
  }
  return null;
}

/** Record a robots skip once per path (the first rule seen for it wins). */
function noteRobotsSkip(skipped: Map<string, string>, pathname: string, rule: string): void {
  if (!skipped.has(pathname)) skipped.set(pathname, rule);
}

/** Resolve a candidate href/loc to a same-origin page URL, or null. */
function toPageUrl(candidate: string, base: URL): URL | null {
  const trimmed = candidate.trim();
  if (!trimmed || NON_PAGE_SCHEME_RE.test(trimmed)) return null;
  let u: URL;
  try {
    u = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.origin !== base.origin) return null;
  if (ASSET_EXT_RE.test(u.pathname)) return null;
  u.hash = '';
  return u;
}

/** Count path segments, so trimming can prefer shallow pages. */
function pathDepth(u: URL): number {
  return u.pathname.split('/').filter(Boolean).length;
}

/** Dedupe by pathname, keeping first occurrence order. */
function dedupeByPathname(urls: URL[]): URL[] {
  const seen = new Set<string>();
  const out: URL[] = [];
  for (const u of urls) {
    if (seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    out.push(u);
  }
  return out;
}

/** Extract <loc> values from a sitemap or sitemap-index body. */
function sitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Extract href values from an HTML body. Plain regex, no browser. */
function extractHrefs(html: string): string[] {
  const out: string[] = [];
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const v = (m[1] ?? m[2] ?? '').trim();
    if (v && !v.startsWith('#')) out.push(v);
  }
  return out;
}

export interface DiscoverOptions {
  entryUrl: string;
  /** Rung 1: requirements map whose features may state URLs. */
  requirements?: RequirementsMap;
  /**
   * The --features list. With no requirements map it is the feature list the
   * sitemap seed is judged against; a map's features win when both are set,
   * the same choice the page filter makes.
   */
  features?: string[];
  /** Rung 2: explicit page list from --urls. */
  userUrls?: string[];
  /** Injectable fetch for offline tests. Defaults to global fetch + UA + timeout. */
  fetchFn?: FetchLike;
  /** Crawl pause override. Tests set 0; the default is CRAWL_DELAY_MS. */
  crawlDelayMs?: number;
  /**
   * Injectable rendered-DOM link collector for the browser-crawl rung.
   * Defaults to a real Playwright browser, launched ONLY when the rung runs.
   */
  collectRendered?: RenderedLinkCollector;
}

/** Walk the discovery ladder. See the module doc for the rung order. */
export async function discoverPages(opts: DiscoverOptions): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const entry = new URL(opts.entryUrl);
  const fetchFn = opts.fetchFn ?? defaultFetch;

  // Rung 1 — SRS map. Only fires when the map actually states URLs.
  if (opts.requirements) {
    const pages: DiscoveredPage[] = [];
    const seen = new Set<string>();
    for (const f of opts.requirements.features) {
      for (const raw of f.urls ?? []) {
        const u = toPageUrl(raw, entry) ?? absoluteUrlOrNull(raw);
        if (!u) {
          warnings.push(`SRS: could not resolve stated URL "${raw}" for feature "${f.name}"; skipped.`);
          continue;
        }
        const key = `${u.origin}${u.pathname}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pages.push({ url: u.toString(), source: 'srs', feature: f.name });
      }
    }
    if (pages.length > 0) {
      return { pages: tagVolatile(pages), method: 'srs', warnings };
    }
    warnings.push('SRS map present but no feature states a URL; falling through to the next rung.');
  }

  // Rung 2 — explicit user list. Above sitemap/crawl on purpose (module doc).
  if (opts.userUrls && opts.userUrls.length > 0) {
    const resolved: URL[] = [];
    for (const raw of opts.userUrls) {
      // A user URL must be absolute (https://...) or site-absolute (/path).
      // Anything else ("not a url", "login") would silently resolve as a
      // relative path, which is never what the flag meant.
      const trimmed = raw.trim();
      const wellFormed = /^https?:\/\//i.test(trimmed) || trimmed.startsWith('/');
      const u = wellFormed ? (toPageUrl(trimmed, entry) ?? absoluteUrlOrNull(trimmed)) : null;
      if (!u) {
        warnings.push(`--urls: "${raw}" is not a usable page URL; skipped.`);
        continue;
      }
      resolved.push(u);
    }
    const pages = dedupeByPathname(resolved).map((u): DiscoveredPage => ({ url: u.toString(), source: 'user' }));
    if (pages.length > 0) {
      return { pages: tagVolatile(pages), method: 'user', warnings };
    }
    warnings.push('--urls was provided but none of its values resolved to a usable URL; falling through.');
  }

  // robots.txt — fetched once, honored by BOTH the sitemap and crawl rungs.
  const robots = await fetchRobots(entry, fetchFn, warnings);
  // Every path a remote rung skipped for robots, with the rule that matched:
  // reported, never silent (run 59540f: /auth/login was skipped and nothing
  // said so). Honoring is unchanged; only the record is new.
  const skipped = new Map<string, string>();
  const robotsSkipped = (): RobotsSkip[] => [...skipped].map(([p, rule]) => ({ path: p, rule }));

  if (robots.disallowAll) {
    warnings.push('robots.txt disallows all paths for our agent; sitemap and crawl rungs skipped out of politeness.');
  } else {
    // Rung 3 — sitemap. A seed, not a ceiling: unless every feature of a
    // feature list is carried by a sitemap page by page evidence, the ladder
    // continues to the crawl and merges (run 59540f planned 3 pages off a
    // 3-URL sitemap and never saw a category or product page).
    const sitemapPages = await sitemapRung(entry, robots, fetchFn, warnings, skipped);
    if (sitemapPages.length > 0) {
      const seed = sitemapSeedDecision(sitemapPages, discoveryFeatureList(opts.requirements, opts.features), opts.requirements ? featureTokenMap(opts.requirements) : undefined);
      warnings.push(seed.line);
      if (!seed.crawl) {
        return { pages: tagVolatile(sitemapPages), method: 'sitemap', warnings, robots, robotsSkipped: robotsSkipped() };
      }
    }

    // Rung 4 — polite crawl (plain fetch).
    const crawlPages = await crawlRung(entry, robots, fetchFn, opts.crawlDelayMs ?? CRAWL_DELAY_MS, warnings, skipped);
    if (sitemapPages.length === 0) {
      if (crawlPages.length > 0) {
        return { pages: tagVolatile(crawlPages), method: 'crawl', warnings, robots, robotsSkipped: robotsSkipped() };
      }
    } else if (pagesBeyondSeed(crawlPages, sitemapPages, entry).length > 0) {
      return { pages: tagVolatile(mergeSeedPages(sitemapPages, crawlPages)), method: 'sitemap+crawl', warnings, robots, robotsSkipped: robotsSkipped() };
    } else if (crawlPages.length > 0) {
      warnings.push(`crawl: found ${crawlPages.length} page(s), none beyond the sitemap set and the entry; trying the browser crawl.`);
    }

    // Rung 4b — browser-assisted crawl. Only when the fetch crawl yielded
    // nothing (or nothing beyond the sitemap seed): a client-rendered SPA
    // serves a shell with no anchors to plain fetch
    // (practicesoftwaretesting.com found zero links on the live run), so the
    // links must be read off the RENDERED DOM. Static sites never pay the
    // browser cost. Same robots rules, caps, delay, and dedupe.
    let collect = opts.collectRendered;
    let closeCollector: (() => Promise<void>) | undefined;
    if (!collect) {
      const d = await defaultRenderedCollector(warnings);
      if (d) {
        collect = d.collect;
        closeCollector = d.close;
      }
    }
    let pageControls: Record<string, PageControl[]> | undefined;
    if (collect) {
      try {
        const controls = new Map<string, PageControl[]>();
        const rendered = await walkCrawl({
          entry,
          robots,
          getLinks: collect,
          delayMs: opts.crawlDelayMs ?? CRAWL_DELAY_MS,
          warnings,
          label: 'browser crawl',
          source: 'browser-crawl',
          controlsOut: controls,
          skippedOut: skipped,
        });
        pageControls = Object.fromEntries(controls);
        if (sitemapPages.length === 0) {
          if (rendered.length > 0) {
            return { pages: tagVolatile(rendered), method: 'browser-crawl', warnings, robots, robotsSkipped: robotsSkipped(), pageControls };
          }
        } else if (pagesBeyondSeed(rendered, sitemapPages, entry).length > 0) {
          return { pages: tagVolatile(mergeSeedPages(sitemapPages, rendered)), method: 'sitemap+browser-crawl', warnings, robots, robotsSkipped: robotsSkipped(), pageControls };
        } else {
          warnings.push(`browser crawl: added no page beyond the sitemap set and the entry; the sitemap pages stand alone.`);
        }
      } finally {
        await closeCollector?.();
      }
    }
    // Neither crawl added a page: the sitemap seed is the page set, from one rung.
    if (sitemapPages.length > 0) {
      return { pages: tagVolatile(sitemapPages), method: 'sitemap', warnings, robots, robotsSkipped: robotsSkipped(), ...(pageControls ? { pageControls } : {}) };
    }
  }

  // Rung 5 — entry only. Loud, never silent.
  warnings.push(
    `Discovery fell back to the entry page only. No rung yielded pages — see the warnings above for what each rung tried.`,
  );
  return {
    pages: [{ url: entry.toString(), source: 'entry' }],
    method: 'entry',
    warnings,
    robots,
    // No remote rung examined a link under a disallow-all robots.txt; the
    // warning above says so, and no empty list stands in for that.
    ...(robots.disallowAll ? {} : { robotsSkipped: robotsSkipped() }),
  };
}

/**
 * The feature list discovery judges pages against: the requirements map's
 * features when a map is given (the page filter makes the same choice), else
 * the --features list, else none. Exported for the runtime and the script.
 */
export function discoveryFeatureList(requirements: RequirementsMap | undefined, features: string[] | undefined): string[] {
  const fromMap = (requirements?.features ?? []).map((f) => f.name.trim()).filter((f) => f.length > 0);
  if (fromMap.length > 0) return fromMap;
  return (features ?? []).map((f) => f.trim()).filter((f) => f.length > 0);
}

/**
 * Whether a non-empty sitemap is enough on its own, and the one warning line
 * that says why. The sitemap ends the ladder only when a feature list exists
 * and every feature is carried by at least one sitemap page by page evidence
 * (pagesCarryingFeature: path segments only, never a model-written tag).
 * With no feature list the crawl always runs. Exported for the smoke.
 */
export function sitemapSeedDecision(
  pages: DiscoveredPage[],
  features: string[],
  featureTokens?: Record<string, string[]>,
): { crawl: boolean; uncarried: string[]; line: string } {
  const n = pages.length;
  if (features.length === 0) {
    return { crawl: true, uncarried: [], line: `sitemap: ${n} page(s); no feature list, so the crawl runs and merges.` };
  }
  const uncarried = features.filter((f) => pagesCarryingFeature(pages, f, featureTokens).length === 0);
  if (uncarried.length === 0) {
    return { crawl: false, uncarried, line: `sitemap: ${n} page(s) carry every feature (${features.join(', ')}); crawl skipped.` };
  }
  return { crawl: true, uncarried, line: `sitemap: ${n} page(s); no sitemap page carries feature(s) ${uncarried.join(', ')}; continuing to the crawl and merging.` };
}

/** origin + pathname: the merge's dedupe key. */
function originPathKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** The crawl pages that are neither in the sitemap seed nor the entry, by origin plus pathname. */
function pagesBeyondSeed(crawl: DiscoveredPage[], seed: DiscoveredPage[], entry: URL): DiscoveredPage[] {
  const known = new Set([...seed.map((p) => originPathKey(p.url)), originPathKey(entry.toString())]);
  return crawl.filter((p) => !known.has(originPathKey(p.url)));
}

/**
 * Sitemap seed merged with a crawl: deduped by origin plus pathname, sitemap
 * entries first, every page keeping its own source. A sitemap page the crawl
 * also reached keeps source 'sitemap' and gains the crawl's linkedFrom and
 * anchorPolls when it has none (the state probe and the template grouping
 * read them). Exported for the smoke.
 */
export function mergeSeedPages(seed: DiscoveredPage[], crawl: DiscoveredPage[]): DiscoveredPage[] {
  const byKey = new Map<string, DiscoveredPage>();
  for (const p of seed) {
    const k = originPathKey(p.url);
    if (!byKey.has(k)) byKey.set(k, p);
  }
  for (const p of crawl) {
    const k = originPathKey(p.url);
    const have = byKey.get(k);
    if (!have) {
      byKey.set(k, p);
      continue;
    }
    byKey.set(k, {
      ...have,
      ...(have.linkedFrom === undefined && p.linkedFrom !== undefined ? { linkedFrom: p.linkedFrom } : {}),
      ...(have.anchorPolls === undefined && p.anchorPolls !== undefined ? { anchorPolls: p.anchorPolls } : {}),
    });
  }
  return [...byKey.values()];
}

/**
 * The requirements features no candidate carries by page evidence while a
 * robots-skipped path does (the same pagesCarryingFeature test, run on the
 * skipped paths): each with its paths, the rules that matched and the one
 * line the console prints and the discovery warnings keep. Robots honoring
 * is unchanged; this only says what it cost. Exported for the runtime, the
 * coverage rebuild and scripts/discover-site.ts.
 */
export function robotsBlockedFeatures(opts: {
  entryUrl: string;
  features: string[];
  candidates: Array<{ url: string }>;
  robotsSkipped: RobotsSkip[] | undefined;
  featureTokens?: Record<string, string[]>;
}): RobotsBlockedFeature[] {
  // No skipped path means no evidence either way: nothing is reported.
  const skippedList = opts.robotsSkipped ?? [];
  if (skippedList.length === 0) return [];
  // Every caller passes the run's validated entry URL; a bad one throws.
  const origin = new URL(opts.entryUrl).origin;
  const asPages = (urls: string[]): DiscoveredPage[] => urls.map((url) => ({ url, source: 'crawl' }));
  const candidatePages = asPages(opts.candidates.map((c) => c.url));
  const skippedPages = asPages(skippedList.map((s) => `${origin}${s.path}`));
  const ruleByUrl = new Map(skippedList.map((s) => [`${origin}${s.path}`, s.rule]));
  const out: RobotsBlockedFeature[] = [];
  for (const feature of opts.features) {
    if (pagesCarryingFeature(candidatePages, feature, opts.featureTokens).length > 0) continue;
    const carrying = pagesCarryingFeature(skippedPages, feature, opts.featureTokens);
    if (carrying.length === 0) continue;
    const paths = carrying.map((p) => new URL(p.url).pathname);
    const rules = [...new Set(carrying.map((p) => ruleByUrl.get(p.url)!))];
    out.push({ feature, paths, rules, line: robotsBlockedLine(feature, paths, rules) });
  }
  return out;
}

/**
 * The robots-blocked features of a recorded discovery, by feature name, with
 * the detail rule coverage carries (robots-disallowed). Read from the
 * report's own discovery block (the candidates and robotsSkipped) and the
 * requirements map, so the runtime and the emitted-spec check's coverage
 * rebuild classify the same rules. A feature whose state probe revealed a
 * page has a page, so it is left out. {} with no map or no discovery.
 */
export function robotsDisallowedDetails(
  map: RequirementsMap | undefined,
  discovery: { candidates?: Array<{ url: string }>; pages: Array<{ url: string; source: string }>; robotsSkipped?: RobotsSkip[]; stateProbes?: Array<{ feature: string; outcome: string }> } | undefined,
  entryUrl: string,
): Record<string, string> {
  if (!map || !discovery) return {};
  const revealed = new Set((discovery.stateProbes ?? []).filter((p) => p.outcome === 'revealed').map((p) => p.feature));
  const blocked = robotsBlockedFeatures({
    entryUrl,
    features: discoveryFeatureList(map, undefined),
    candidates: discovery.candidates ?? discovery.pages.filter((p) => p.source !== 'action'),
    robotsSkipped: discovery.robotsSkipped,
    featureTokens: featureTokenMap(map),
  });
  const out: Record<string, string> = {};
  for (const b of blocked) if (!revealed.has(b.feature)) out[b.feature] = robotsBlockedDetail(b.paths, b.rules);
  return out;
}

/** The text after 'Feature "<name>": ', which rule coverage keeps as the detail. */
export function robotsBlockedDetail(paths: string[], rules: string[]): string {
  return `robots.txt disallows its matching path(s) ${paths.join(', ')} (rule${rules.length === 1 ? '' : 's'} ${rules.map((r) => `Disallow: ${r}`).join(', ')}); not loaded`;
}

/** The one console line and discovery warning for a feature robots.txt keeps out of reach. */
export function robotsBlockedLine(feature: string, paths: string[], rules: string[]): string {
  return `Feature "${feature}": ${robotsBlockedDetail(paths, rules)}.`;
}

/**
 * Fetch and parse robots.txt for the entry's origin. A fetch failure or a
 * non-OK status reads as allow-all, with the reason in `warnings`. Exported
 * so the state probe honors robots on a run whose SRS or user rung won
 * before robots.txt was read.
 */
export async function fetchRobots(entry: URL, fetchFn: FetchLike = defaultFetch, warnings: string[] = []): Promise<RobotsInfo> {
  let robots: RobotsInfo = { fetched: false, disallow: [], sitemaps: [], disallowAll: false };
  try {
    const res = await fetchFn(`${entry.origin}/robots.txt`);
    if (res.ok) {
      robots = { fetched: true, ...parseRobotsTxt(await res.text()) };
      if (robots.disallow.length > 0) {
        warnings.push(`robots.txt: ${robots.disallow.length} Disallow rule(s) apply to our agent; disallowed paths are excluded.`);
      }
      if (robots.sitemaps.length > 0) {
        warnings.push(`robots.txt: Sitemap directive found (${robots.sitemaps.length}).`);
      }
    } else {
      warnings.push(`robots.txt: HTTP ${res.status}; treating as allow-all.`);
    }
  } catch (err) {
    warnings.push(`robots.txt: fetch failed (${(err as Error).message}); treating as allow-all.`);
  }
  return robots;
}

/** Parse an absolute URL with no base, or null. Used for cross-origin SRS/user URLs. */
function absoluteUrlOrNull(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (ASSET_EXT_RE.test(u.pathname)) return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

/** Rung 3: robots Sitemap directive first, then /sitemap.xml, one index level deep. */
async function sitemapRung(
  entry: URL,
  robots: RobotsInfo,
  fetchFn: FetchLike,
  warnings: string[],
  skippedOut: Map<string, string>,
): Promise<DiscoveredPage[]> {
  // A listed path robots.txt disallows is dropped, as before, and recorded.
  const allowed = (u: URL | null): u is URL => {
    if (!u) return false;
    const rule = robotsRuleFor(robots, u.pathname);
    if (rule === null) return true;
    noteRobotsSkip(skippedOut, u.pathname, rule);
    return false;
  };
  const candidates = robots.sitemaps.length > 0
    ? robots.sitemaps
    : [`${entry.origin}/sitemap.xml`];

  const collected: URL[] = [];
  for (const smUrl of candidates) {
    let body: string;
    try {
      const res = await fetchFn(new URL(smUrl, entry).toString());
      if (!res.ok) {
        warnings.push(`sitemap: ${smUrl} returned HTTP ${res.status}.`);
        continue;
      }
      body = await res.text();
    } catch (err) {
      warnings.push(`sitemap: fetch of ${smUrl} failed (${(err as Error).message}).`);
      continue;
    }
    const locs = sitemapLocs(body);
    if (/<sitemapindex/i.test(body)) {
      // One nesting level: fetch child sitemaps listed by the index.
      const children = locs.slice(0, SITEMAP_INDEX_CHILD_CAP);
      if (locs.length > children.length) {
        warnings.push(`sitemap: index lists ${locs.length} child sitemaps; fetched the first ${children.length}.`);
      }
      for (const child of children) {
        try {
          const res = await fetchFn(new URL(child, entry).toString());
          if (!res.ok) continue;
          for (const loc of sitemapLocs(await res.text())) {
            const u = toPageUrl(loc, entry);
            if (allowed(u)) collected.push(u);
          }
        } catch {
          // A broken child sitemap is skipped; the others still count.
        }
      }
    } else {
      for (const loc of locs) {
        const u = toPageUrl(loc, entry);
        if (allowed(u)) collected.push(u);
      }
    }
  }

  let pages = dedupeByPathname(collected);
  if (pages.length === 0) {
    warnings.push('sitemap: no usable same-origin pages found; falling through to the crawl.');
    return [];
  }
  if (pages.length > SITEMAP_PAGE_CAP) {
    // Stable sort by depth so shallow paths survive the trim.
    const before = pages.length;
    pages = pages
      .map((u, i) => ({ u, i }))
      .sort((a, b) => pathDepth(a.u) - pathDepth(b.u) || a.i - b.i)
      .slice(0, SITEMAP_PAGE_CAP)
      .map((x) => x.u);
    warnings.push(`sitemap: ${before} pages trimmed to ${SITEMAP_PAGE_CAP}, keeping the shallowest paths.`);
  }
  return pages.map((u): DiscoveredPage => ({ url: u.toString(), source: 'sitemap' }));
}

/**
 * The shared polite crawl walker used by BOTH crawl rungs. Sequential,
 * delayed, depth- and count-capped, robots-respecting, fragment-free, deduped
 * by pathname. Only the link source differs: plain fetch + href regex for the
 * fetch rung, a rendered-DOM collector for the browser rung. Yields nothing
 * when the entry page has no same-origin links (the entry alone is not
 * "discovery").
 */
async function walkCrawl(opts: {
  entry: URL;
  robots: RobotsInfo;
  /** Links found on one page, or null when the page could not be loaded. */
  getLinks: RenderedLinkCollector;
  delayMs: number;
  warnings: string[];
  /** Warning prefix: 'crawl' or 'browser crawl'. */
  label: string;
  source: DiscoveredPage['source'];
  /** When given, the controls a collector returned are kept here by page URL (browser crawl only). */
  controlsOut?: Map<string, PageControl[]>;
  /** Every path skipped for robots, with the rule that matched, by path. */
  skippedOut: Map<string, string>;
}): Promise<DiscoveredPage[]> {
  const { entry, robots, getLinks, delayMs, warnings, label, source, controlsOut, skippedOut } = opts;
  const entryRule = robotsRuleFor(robots, entry.pathname);
  if (entryRule !== null) {
    noteRobotsSkip(skippedOut, entry.pathname, entryRule);
    warnings.push(`${label}: robots.txt disallows the entry path ${entry.pathname}; ${label} skipped.`);
    return [];
  }
  const visited = new Set<string>([entry.pathname]);
  const collected: URL[] = [];
  const pollsByUrl = new Map<string, number[]>();
  // Which page's anchor led to each candidate (the entry has none). The state
  // probe needs it: a volatile trigger page's origin is the stable page that
  // linked to it (invariant 71).
  const parentByUrl = new Map<string, string>();
  const queue: Array<{ u: URL; depth: number; parent?: string }> = [{ u: entry, depth: 0 }];
  let loads = 0;
  let failures = 0;
  // The page cap counts stable paths only; volatile generated-id pages are
  // collected apart, and past their own small cap they are not even loaded.
  let stableCount = 0;
  let volatileCount = 0;

  while (queue.length > 0 && stableCount < CRAWL_PAGE_CAP) {
    const { u, depth, parent } = queue.shift()!;
    const volatile = isVolatilePath(u.pathname);
    if (volatile && volatileCount >= CRAWL_VOLATILE_CAP) continue;
    if (loads > 0 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    loads++;
    let hrefs: string[] | null;
    let anchorPolls: number[] | undefined;
    let controls: PageControl[] | undefined;
    try {
      const got = await getLinks(u.toString());
      if (got === null) hrefs = null;
      else if (Array.isArray(got)) hrefs = got;
      else { hrefs = got.hrefs; anchorPolls = got.anchorPolls; controls = got.controls; }
    } catch {
      hrefs = null;
    }
    if (hrefs === null) {
      failures++;
      continue;
    }
    collected.push(u);
    if (volatile) volatileCount++; else stableCount++;
    if (anchorPolls) pollsByUrl.set(u.toString(), anchorPolls);
    if (parent) parentByUrl.set(u.toString(), parent);
    if (controls && controlsOut) controlsOut.set(u.toString(), controls);
    if (depth >= CRAWL_MAX_DEPTH) continue;
    for (const href of hrefs) {
      const link = toPageUrl(href, u);
      if (!link) continue;
      if (visited.has(link.pathname)) continue;
      // Never loaded (invariant 29), and recorded with the rule that matched.
      const rule = robotsRuleFor(robots, link.pathname);
      if (rule !== null) {
        noteRobotsSkip(skippedOut, link.pathname, rule);
        continue;
      }
      visited.add(link.pathname);
      queue.push({ u: link, depth: depth + 1, parent: u.toString() });
      if (visited.size > CRAWL_PAGE_CAP * 4) break; // frontier guard
    }
  }

  if (failures > 0) {
    warnings.push(`${label}: ${failures} page load(s) failed or returned non-OK status.`);
  }
  if (collected.length <= 1) {
    warnings.push(`${label}: found no additional same-origin pages beyond the entry; falling through.`);
    return [];
  }
  // Stable pages never exceed the cap by construction; volatile ones ride along.
  return collected.map((u): DiscoveredPage => {
    const polls = pollsByUrl.get(u.toString());
    const from = parentByUrl.get(u.toString());
    return { url: u.toString(), source, ...(polls ? { anchorPolls: polls } : {}), ...(from ? { linkedFrom: from } : {}) };
  });
}

/** Rung 4: the plain-fetch crawl. Cheap; fails on client-rendered SPAs. */
async function crawlRung(
  entry: URL,
  robots: RobotsInfo,
  fetchFn: FetchLike,
  delayMs: number,
  warnings: string[],
  skippedOut: Map<string, string>,
): Promise<DiscoveredPage[]> {
  return walkCrawl({
    entry,
    robots,
    skippedOut,
    getLinks: async (url) => {
      try {
        const res = await fetchFn(url, { headers: { 'user-agent': DISCOVERY_UA } });
        if (!res.ok) return null;
        return extractHrefs(await res.text());
      } catch {
        return null;
      }
    },
    delayMs,
    warnings,
    label: 'crawl',
    source: 'crawl',
  });
}

/**
 * Default rendered-DOM collector for the browser-crawl rung: one headless
 * Playwright browser for the whole rung, the same settle logic the Planner
 * snapshot uses, anchors read off the rendered DOM. Launched lazily so static
 * sites (whose fetch crawl succeeds) never pay for a browser. Returns null
 * with a warning when a browser cannot be launched.
 */
async function defaultRenderedCollector(
  warnings: string[],
): Promise<{ collect: RenderedLinkCollector; close: () => Promise<void> } | null> {
  try {
    const { chromium } = await import('playwright');
    const { installEvalShim } = await import('./eval-shim.js');
    const { settleForSnapshot } = await import('./planner.js');
    const { readControls } = await import('./state-probe.js');
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ userAgent: DISCOVERY_UA });
    await installEvalShim(ctx);
    const page = await ctx.newPage();
    const collect: RenderedLinkCollector = async (url) => {
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 15_000 });
        await settleForSnapshot(page);
        // The settle poll counts headings and form controls, which a SPA shell
        // satisfies before its catalogue list has rendered; the product anchors
        // arrive later. Wait for the anchor count to stop growing before
        // reading links, or the crawl never sees them.
        const anchors = await waitForAnchors(page);
        const hrefs = await page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]'))
            .map((a) => a.getAttribute('href') || '')
            .filter((h) => h.length > 0),
        );
        // The page's buttons and links, kept in memory so the state probe can
        // look for a trigger without loading the page again (invariant 71).
        const controls = await readControls(page).catch(() => undefined);
        return { hrefs, anchorPolls: anchors.polls, ...(controls ? { controls } : {}) };
      } catch {
        return null;
      }
    };
    return {
      collect,
      close: async () => {
        await browser.close().catch(() => {});
      },
    };
  } catch (err) {
    warnings.push(`browser crawl: could not launch a browser (${(err as Error).message}); rung skipped.`);
    return null;
  }
}

/** Cap on how long the browser crawl waits for a page's anchors to stop changing. */
export const ANCHOR_SETTLE_CAP_MS = 3000;
const ANCHOR_SETTLE_POLL_MS = 200;

/**
 * Wait for the page's links to render past the shell. The first reading is
 * the baseline: the navigation anchors a SPA shell already carries. The wait
 * ends when the count has grown past the baseline and then held for two
 * polls, or when the cap expires (a page with nav only returns at the cap,
 * never hangs). Run f3b41e accepted the nav's own steady count and read the
 * links before the catalogue rendered. Returns the final count and every
 * poll, which the crawl records on the candidate. Exported for the smoke.
 */
export async function waitForAnchors(page: Pick<Page, 'evaluate'>, capMs = ANCHOR_SETTLE_CAP_MS): Promise<{ count: number; polls: number[] }> {
  const count = async (): Promise<number> => page.evaluate(() => document.querySelectorAll('a[href]').length);
  const deadline = Date.now() + capMs;
  const baseline = await count();
  const polls: number[] = [baseline];
  let last = baseline;
  let steady = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ANCHOR_SETTLE_POLL_MS));
    const n = await count();
    polls.push(n);
    if (n > baseline && n === last) {
      steady++;
      if (steady >= 2) break;
    } else {
      steady = 0;
    }
    last = n;
  }
  return { count: last, polls };
}

/**
 * Write the discovery record (method, every candidate, the pages kept,
 * warnings) to discovery.json in the run directory, so the candidate set a
 * run saw is a file, not a lost console line.
 */
export function writeDiscoveryJson(outDir: string, info: { method: string; pages: DiscoveredPage[]; candidates?: DiscoveredPage[]; warnings: string[]; stateProbes?: StateProbe[]; robotsSkipped?: RobotsSkip[] }): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'discovery.json');
  // A page found by an action is a page, never a crawled candidate: the
  // candidates list stays the crawl's own (invariant 71).
  const record = {
    method: info.method,
    candidates: info.candidates ?? info.pages.filter((p) => p.source !== 'action'),
    pages: info.pages,
    warnings: info.warnings,
    // Every path a remote rung skipped for robots (invariant 75); absent when no remote rung ran.
    ...(info.robotsSkipped ? { robotsSkipped: info.robotsSkipped } : {}),
    ...(info.stateProbes && info.stateProbes.length > 0 ? { stateProbes: info.stateProbes } : {}),
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}
