import Anthropic from '@anthropic-ai/sdk';
import type { DiscoveredPage } from './discovery.js';

/**
 * Page relevance filter — trims a discovered page set to what is worth
 * exploring. 30 sitemap pages is too many to plan blindly; one cheap Haiku
 * call (same pattern as parse-features) picks:
 *
 *   - with a feature list: the most relevant page per feature, at most
 *     MAX_PAGES_WITH_FEATURES total, each tagged with its feature
 *   - without one: up to MAX_PAGES_NO_FEATURES pages that look like DISTINCT
 *     features (login, search, product, cart, contact) over near-duplicates
 *
 * Deterministic fallback when the call fails or no API key is available:
 * the first N shallowest unique-pathname pages. SRS and user page sets are
 * never trimmed here (the SRS states them, the user typed them); the caller
 * only filters sitemap/crawl sets.
 */

export const MAX_PAGES_WITH_FEATURES = 8;
export const MAX_PAGES_NO_FEATURES = 5;

/**
 * The discovery methods whose page sets go through the relevance filter:
 * every remote-discovered set (sitemap and BOTH crawls). SRS pages are stated
 * requirements and user pages are explicit intent; neither is ever trimmed.
 */
export const FILTERED_SOURCES: ReadonlySet<string> = new Set(['sitemap', 'crawl', 'browser-crawl']);

/**
 * At most ONE volatile-id page in a final page set. Detail pages behind
 * generated ids (product/<20-char-id>) all exercise the same template, and
 * their URLs rot when the site reseeds, so one representative is plenty.
 * First volatile page in order wins; stable pages pass through untouched.
 * Exported for the smoke.
 */
export function capVolatile(pages: DiscoveredPage[]): DiscoveredPage[] {
  let seen = false;
  return pages.filter((p) => {
    if (!p.volatile) return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}

/**
 * The template a path belongs to: the parent prefix and the last segment,
 * for paths with two or more segments. /category/hand-tools and
 * /category/power-tools share the prefix /category and differ only in the
 * last segment: one template, one plan (run 5e4394 planned four such pages
 * separately and repeated ten scenarios, $1.87 of $5.08 exploration).
 */
export function pathTemplate(url: string): { prefix: string; last: string } | null {
  let segments: string[];
  try {
    segments = new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
  } catch {
    return null;
  }
  if (segments.length < 2) return null;
  return { prefix: '/' + segments.slice(0, -1).join('/'), last: segments[segments.length - 1]! };
}

/**
 * The feature a single path segment plainly names, from the token table, or
 * null. Two siblings under one prefix that name DIFFERENT features
 * (/auth/login, /auth/register) are not one template.
 */
export function segmentFeature(segment: string): string | null {
  for (const [feature, tokens] of Object.entries(FEATURE_PATH_TOKENS)) {
    if (tokens.some((tok) => segment === tok || segment.startsWith(`${tok}-`) || segment.startsWith(`${tok}_`))) return feature;
  }
  return null;
}

/** A browser-crawl page whose anchor count grew past its first reading rendered content beyond the shell. */
function hasRenderedContent(p: DiscoveredPage): boolean {
  const polls = p.anchorPolls;
  if (!polls || polls.length === 0) return false;
  return Math.max(...polls) > polls[0]!;
}

export interface TemplateGrouping {
  /** The pages to plan: one representative per template plus every page outside a template, in discovery order. */
  pages: DiscoveredPage[];
  /** The other members of each template, each carrying sameTemplateAs = the representative's URL. Never planned. */
  sameTemplate: DiscoveredPage[];
}

/**
 * One plan per path template. Stable pages whose paths differ only in the
 * last segment under a shared prefix are grouped, unless their last segments
 * plainly name different features. The representative is the first member
 * with rendered content (a browser-crawl page whose anchors grew past the
 * shell), else the first member. Volatile pages are left to capVolatile.
 * Exported for the smoke.
 */
export function groupByTemplate(pages: DiscoveredPage[]): TemplateGrouping {
  const groups = new Map<string, DiscoveredPage[]>();
  const keyOf = new Map<DiscoveredPage, string>();
  for (const p of pages) {
    if (p.volatile) continue;
    const t = pathTemplate(p.url);
    if (!t) continue;
    const feature = segmentFeature(t.last);
    const key = feature ? `${t.prefix}#${feature}` : t.prefix;
    keyOf.set(p, key);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const representative = new Map<string, DiscoveredPage>();
  for (const [key, members] of groups) {
    if (members.length < 2) continue;
    representative.set(key, members.find(hasRenderedContent) ?? members[0]!);
  }
  const out: DiscoveredPage[] = [];
  const sameTemplate: DiscoveredPage[] = [];
  for (const p of pages) {
    const key = keyOf.get(p);
    const rep = key ? representative.get(key) : undefined;
    if (rep && rep !== p) sameTemplate.push({ ...p, sameTemplateAs: rep.url });
    else out.push(p);
  }
  return { pages: out, sameTemplate };
}

/**
 * Path tokens that plainly name a feature. A candidate whose path segment
 * equals or starts with one of a feature's tokens is kept BEFORE the model
 * pick, tagged with that feature: a page called /auth/register serves the
 * registration feature whatever Haiku thinks of it (run ec8eff dropped it).
 */
export const FEATURE_PATH_TOKENS: Record<string, string[]> = {
  // "auth" is NOT a login token: /auth/register and /auth/forgot-password sit
  // under it too, and tagging them login sent the Planner login-only steering
  // for a registration form (run f3b41e).
  login: ['login', 'signin', 'sign-in'],
  registration: ['register', 'registration', 'signup', 'sign-up', 'create-account'],
  register: ['register', 'registration', 'signup', 'sign-up', 'create-account'],
  'password-recovery': ['forgot', 'forgot-password', 'reset', 'reset-password', 'recover', 'recovery'],
  'forgot-password': ['forgot', 'forgot-password', 'reset', 'reset-password', 'recover', 'recovery'],
  'reset-password': ['forgot', 'forgot-password', 'reset', 'reset-password', 'recover', 'recovery'],
  cart: ['cart', 'basket', 'checkout'],
  checkout: ['checkout', 'cart'],
  product: ['product', 'products', 'item', 'items'],
  catalogue: ['catalogue', 'catalog', 'category', 'products', 'shop'],
  catalog: ['catalogue', 'catalog', 'category', 'products', 'shop'],
  contact: ['contact'],
  search: ['search'],
  account: ['account', 'profile'],
};

/**
 * The tokens that plainly name a feature: the table's entry for the whole
 * name, else the union of the entries for its words (so an SRS feature called
 * "user-registration" gets the registration tokens and "contact-form" gets
 * "contact"), else the name itself.
 */
export function tokensFor(feature: string): string[] {
  const key = feature.trim().toLowerCase();
  if (FEATURE_PATH_TOKENS[key]) return FEATURE_PATH_TOKENS[key];
  const words = key.split(/[^a-z0-9]+/).filter((w) => w.length > 0);
  const byWord = words.flatMap((w) => FEATURE_PATH_TOKENS[w] ?? []);
  return byWord.length > 0 ? [...new Set(byWord)] : [key];
}

/**
 * Candidates whose path plainly matches a feature name, each tagged with the
 * feature. Exported so the smoke locks it.
 */
export function plainFeatureMatches(pages: DiscoveredPage[], features?: string[], featureTokens?: Record<string, string[]>): DiscoveredPage[] {
  const names = (features ?? []).map((f) => f.trim()).filter((f) => f.length > 0);
  if (names.length === 0) return [];
  // The name's own tokens plus whatever the feature's rule content names
  // (featureTokenMap in requirements.ts): an SRS feature called "account"
  // whose rules speak of login and registration matches /auth/login and
  // /auth/register, which its name alone never would.
  const tokensOf = (f: string): string[] => [...new Set([...tokensFor(f), ...(featureTokens?.[f] ?? [])])];
  const out: DiscoveredPage[] = [];
  for (const p of pages) {
    let segments: string[];
    try {
      segments = new URL(p.url).pathname.toLowerCase().split('/').filter(Boolean);
    } catch {
      continue;
    }
    const feature = names.find((f) => tokensOf(f).some((tok) => segments.some((seg) => seg === tok || seg.startsWith(`${tok}-`) || seg.startsWith(`${tok}_`))));
    if (feature && !out.some((o) => o.url === p.url)) out.push({ ...p, feature: p.feature ?? feature });
  }
  return out;
}

const HAIKU_MODEL = 'claude-haiku-4-5';
const PRICE = { in: 1.0, out: 5.0 };

export interface FilterPagesOptions {
  pages: DiscoveredPage[];
  /** Feature list from the SRS map or --features. Drives per-feature picking. */
  features?: string[];
  /** Extra path tokens per feature, from the SRS rule content (featureTokenMap). */
  featureTokens?: Record<string, string[]>;
  apiKey?: string;
  model?: string;
}

export interface FilterPagesResult {
  pages: DiscoveredPage[];
  /** llm = Haiku picked; fallback = deterministic; passthrough = under the cap. */
  method: 'llm' | 'fallback' | 'passthrough';
  costUsd: number;
  /** Pages that share a path template with a planned page: recorded, shown, never planned. */
  sameTemplate: DiscoveredPage[];
}

/** The cap that applies for a given feature list. */
export function pageCapFor(features?: string[]): number {
  return features && features.length > 0 ? MAX_PAGES_WITH_FEATURES : MAX_PAGES_NO_FEATURES;
}

/**
 * Deterministic fallback: the first `cap` shallowest unique-pathname pages.
 * Stable: ties keep discovery order. Exported so the smoke locks it.
 */
export function fallbackFilter(pages: DiscoveredPage[], cap: number): DiscoveredPage[] {
  const seen = new Set<string>();
  const unique: Array<{ p: DiscoveredPage; depth: number; i: number }> = [];
  for (const [i, p] of pages.entries()) {
    let pathname: string;
    try {
      pathname = new URL(p.url).pathname;
    } catch {
      continue;
    }
    if (seen.has(pathname)) continue;
    seen.add(pathname);
    unique.push({ p, depth: pathname.split('/').filter(Boolean).length, i });
  }
  // Stable-path pages first (volatile generated-id URLs rot when the site
  // reseeds), then shallowest, then discovery order. capVolatile then keeps
  // at most one volatile survivor.
  return capVolatile(
    unique
      .sort((a, b) => Number(a.p.volatile ?? false) - Number(b.p.volatile ?? false) || a.depth - b.depth || a.i - b.i)
      .map((x) => x.p),
  ).slice(0, cap);
}

const SYSTEM = `You pick the most test-worthy pages from a list of URLs discovered on one site.

Rules:
- Output ONLY a JSON array. No prose. No code fence.
- Each element: { "url": "<one of the input URLs, verbatim>", "feature": "<short kebab-case feature name>" }.
- When a FEATURES list is given: pick the single most relevant page per feature (skip a feature no URL plausibly serves), and never exceed the stated cap.
- When no FEATURES list is given: pick pages that look like DISTINCT features of the site (login, search, product, cart, contact, registration) over near-duplicates of each other. Never exceed the stated cap.
- Prefer functional pages (forms, flows) over marketing/blog/legal pages.
- Prefer STABLE-PATH pages (login, contact, category listings, search) over detail pages whose URL carries a generated id (product/<long-random-id>): those URLs rot when the site reseeds its data. Pick at most ONE such volatile detail page, and only when nothing stable covers the feature.
- Never invent a URL that is not in the input list.`;

/**
 * Filter a discovered page set to the most relevant pages. Under the cap the
 * set passes through untouched. The Haiku pick is validated (chosen URLs must
 * come from the input, cap enforced); anything unusable falls back to the
 * deterministic shallowest-first trim, never an error.
 */
export async function filterPages(opts: FilterPagesOptions): Promise<FilterPagesResult> {
  const cap = pageCapFor(opts.features);
  // One plan per path template: the cap and the pick see one representative
  // per template, and the other members are recorded, never planned.
  const grouped = groupByTemplate(opts.pages);
  const { sameTemplate } = grouped;
  const candidates = grouped.pages;
  if (candidates.length <= cap) {
    // Under the cap the set passes through, but the one-volatile-page rule
    // still applies: three generated-id detail pages are one template.
    return { pages: capVolatile(candidates), method: 'passthrough', costUsd: 0, sameTemplate };
  }
  // Plain feature matches are kept before any pick and never trimmed: the
  // model chooses only among the rest, for the room left under the cap.
  const kept = plainFeatureMatches(candidates, opts.features, opts.featureTokens);
  const keptUrls = new Set(kept.map((p) => p.url));
  const rest = candidates.filter((p) => !keptUrls.has(p.url));
  const room = Math.max(0, cap - kept.length);
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { pages: capVolatile([...kept, ...fallbackFilter(rest, room)]), method: 'fallback', costUsd: 0, sameTemplate };
  }
  if (room === 0) {
    return { pages: capVolatile(kept), method: 'fallback', costUsd: 0, sameTemplate };
  }

  try {
    const client = new Anthropic({ apiKey });
    const features = (opts.features ?? []).filter((f) => f.trim().length > 0);
    const featureBlock = features.length > 0
      ? `FEATURES (pick the most relevant page per feature, cap ${room} total):\n${features.map((f) => `- ${f}`).join('\n')}`
      : `No feature list. Pick up to ${room} pages that look like distinct features.`;
    const response = await client.messages.create({
      model: opts.model ?? HAIKU_MODEL,
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
      messages: [
        {
          role: 'user',
          content: `${featureBlock}\n\nDiscovered URLs:\n${rest.map((p) => p.url).join('\n')}`,
        },
      ],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const u = response.usage;
    const costUsd = (u.input_tokens * PRICE.in + u.output_tokens * PRICE.out) / 1_000_000;

    const picked = parsePickResponse(text, rest, room);
    if (picked.length === 0) {
      return { pages: capVolatile([...kept, ...fallbackFilter(rest, room)]), method: 'fallback', costUsd, sameTemplate };
    }
    return { pages: capVolatile([...kept, ...picked]), method: 'llm', costUsd, sameTemplate };
  } catch {
    return { pages: capVolatile([...kept, ...fallbackFilter(rest, room)]), method: 'fallback', costUsd: 0, sameTemplate };
  }
}

/**
 * Validate the model's pick: JSON array of {url, feature}, every url from the
 * input list (matched by exact string or by pathname), capped, deduped.
 * Returns [] when nothing usable parsed. Exported for the smoke test.
 */
export function parsePickResponse(text: string, pages: DiscoveredPage[], cap: number): DiscoveredPage[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const byUrl = new Map<string, DiscoveredPage>();
  const byPath = new Map<string, DiscoveredPage>();
  for (const p of pages) {
    byUrl.set(p.url, p);
    try {
      byPath.set(new URL(p.url).pathname, p);
    } catch { /* unparseable page url — exact match only */ }
  }
  const out: DiscoveredPage[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= cap) break;
    const url = typeof item === 'string' ? item : (item as { url?: unknown })?.url;
    if (typeof url !== 'string') continue;
    const trimmed = url.trim();
    let page = byUrl.get(trimmed);
    if (!page && trimmed.startsWith('/')) {
      // The model echoed a bare pathname; match it directly.
      page = byPath.get(trimmed);
    }
    if (!page) {
      try {
        page = byPath.get(new URL(trimmed).pathname);
      } catch { /* not a URL the input knows */ }
    }
    if (!page || seen.has(page.url)) continue;
    seen.add(page.url);
    const feature = typeof item === 'object' && item !== null && typeof (item as { feature?: unknown }).feature === 'string'
      ? ((item as { feature: string }).feature.trim() || undefined)
      : undefined;
    out.push(feature ? { ...page, feature } : page);
  }
  return out;
}
