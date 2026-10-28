import type { Page } from 'playwright';
import {
  CRAWL_DELAY_MS,
  DISCOVERY_UA,
  robotsAllows,
  robotsRuleFor,
  waitForAnchors,
  type DiscoveredPage,
  type ReachAction,
  type RobotsInfo,
} from './discovery.js';
import { pagesCarryingFeature, segmentMatchesTokens, tokensFor } from './page-filter.js';
import { normalizeWords, settleForSnapshot, snapshotPage, type PageSnapshot } from './planner.js';
import type { RequirementFeature, RequirementRule, RequirementsMap } from './requirements.js';
import { emitLocatorCall } from './selectors.js';
import { currencyAmountIn } from './parse-number.js';
import { generatedIdFragment, isVolatilePath } from './volatile-id.js';

/**
 * State probe: the action-first discovery rung for pages that exist only
 * after an action (invariant 71, docs/design/state-dependent-pages.md).
 *
 * On practicesoftwaretesting.com the header cart link renders only after an
 * add-to-cart, so no crawl of a fresh session finds the cart page (runs 4 to
 * 6). A requirements feature with rules and no page carrying it by page
 * evidence is probed in a real browser with no model call: a trigger control
 * from STATE_TRIGGERS is clicked on a candidate page, and a same-origin
 * anchor that appears after the click and matches the feature's tokens is
 * the revealed page. The revealed page is recorded as reached by that
 * action (origin plus actions), never as a URL to navigate to.
 *
 * The probe only ADDS a revealed page. When it reveals nothing, planning is
 * exactly as before; only the feature's rules still uncited after planning
 * read not-revealed, with the probe's detail.
 *
 * Matching is on normalized words against fixed tables and the feature's own
 * tokens, never on a string the model wrote (standing rule 1).
 */

/** Most pages the probe loads per feature. A page the browser crawl read costs no load. */
export const STATE_PROBE_PAGE_CAP = 4;
/** Most trigger clicks per feature. */
export const STATE_PROBE_CLICK_CAP = 2;
/** How long the probe waits after a trigger click for a new link to appear. */
export const STATE_PROBE_REVEAL_WAIT_MS = 3000;

/**
 * Trigger phrases per feature token set. A feature whose path tokens
 * (tokensFor plus featureTokenMap) meet a row's tokens is probed with that
 * row's phrases. The table grows by evidence from runs, never by guessing.
 * Account pages use login as the trigger (brief section 7, not built).
 */
export const STATE_TRIGGERS: ReadonlyArray<{ tokens: string[]; phrases: string[] }> = [
  { tokens: ['cart', 'basket', 'checkout'], phrases: ['add to cart', 'add to basket', 'add to bag'] },
  { tokens: ['wishlist'], phrases: ['add to wishlist', 'add to favourites'] },
  { tokens: ['compare'], phrases: ['add to compare'] },
];

/**
 * Never clicked, whatever the trigger table says: a control whose normalized
 * words name payment, an order, deletion or a subscription. Each phrase
 * matches as whole words, its last word with any ending ("pay" matches
 * "payment", "delete" matches "deleted"). Checked before any click.
 */
export const STATE_TRIGGER_DENY: readonly string[] = [
  'place order',
  'pay',
  'buy now',
  'checkout now',
  'delete',
  'remove account',
  'subscribe',
  'confirm purchase',
];

/** One button or link as the probe reads it off a rendered page. */
export interface PageControl {
  /** Position in document.querySelectorAll(CONTROL_SELECTOR), so the probe clicks this exact element. */
  index: number;
  tag: string;
  /** 'link' for an anchor, 'button' otherwise. */
  role: 'button' | 'link';
  label: string;
  testid?: string;
  /** Absolute href, anchors only. */
  href?: string;
  /** True when the control carries the disabled attribute or aria-disabled="true" (an out-of-stock "Add to cart"). Never clicked. */
  disabled?: boolean;
}

/** A control whose words contain a trigger phrase, with the deny verdict. */
export interface TriggerControl extends PageControl {
  phrase: string;
  /** The deny phrase the control names; such a control is never clicked. */
  denied?: string;
  /** The locator as emitLocatorCall writes it, without the page receiver. */
  control: string;
}

/** The record every probe writes, revealed or not. */
export interface StateProbe {
  feature: string;
  outcome: 'revealed' | 'no-trigger' | 'no-new-link' | 'robots' | 'no-credentials' | 'error';
  /** Every page that qualified as an origin (a trigger that revealed a link), best first. */
  origins: string[];
  /** Every page and control the probe tried, in order, with what happened. */
  tried: Array<{ url: string; control?: string; result: string }>;
  /** The revealed page's URL, when outcome is revealed. */
  revealed?: string;
  /** One line: "revealed /checkout from /" or "no page revealed: tried /, /product/..." */
  detail: string;
  /** Every rule of the feature and its side: planned on the origin, or on the revealed page (splitRulesByPage). */
  rulesSplit: Array<{ ruleId: string; side: 'origin' | 'revealed' }>;
  /** Set when a cap stopped the probe with candidates left: the cap and every candidate path it did not try. */
  capped?: string;
  /**
   * Set when the trigger was found by the item hop (invariant 78): a
   * candidate with no trigger linked to item pages none of which was a
   * candidate, the probe followed the first one, and that item page is the
   * origin. `listing` is the page hopped from, `item` the item page used,
   * `control` the item link clicked. The item page is reached by that click
   * and never navigated to by its URL.
   */
  hop?: { listing: string; item: string; control: string };
  /**
   * Set when a trigger click revealed a link whose path robots.txt
   * disallows (invariant 78): the origin found, the revealed path and the
   * Disallow rule. The origin rules are still planned on that origin; the
   * revealed-side rules still uncited after planning read robots-disallowed.
   */
  robotsBlocked?: { origin: string; path: string; rule: string };
}

/** A page handle in a fresh browser context. */
export interface ProbePageHandle {
  page: Page;
  close(): Promise<void>;
}

/** Opens a page in a FRESH context (no cookies, no storage). Injectable so smokes drive the probe against a fixture site. */
export type ProbePageFactory = () => Promise<ProbePageHandle>;

const CONTROL_SELECTOR = 'button, a, [role="button"], input[type="submit"], input[type="button"]';

/**
 * Read the page's visible buttons and links. Function declarations only:
 * tsx wraps arrow functions assigned to consts with __name, which breaks in
 * page.evaluate (invariant 5). Exported so the browser crawl keeps them.
 */
export async function readControls(page: Pick<Page, 'evaluate'>): Promise<PageControl[]> {
  return page.evaluate((sel) => {
    const out: Array<{ index: number; tag: string; role: 'button' | 'link'; label: string; testid?: string; href?: string; disabled?: boolean }> = [];
    const els = Array.from(document.querySelectorAll(sel));
    for (let i = 0; i < els.length; i++) {
      const el = els[i] as HTMLElement;
      if (el.getClientRects().length === 0) continue;
      const tag = el.tagName.toLowerCase();
      const label = (el.getAttribute('aria-label') || (el.innerText || '').trim() || (el as HTMLInputElement).value || el.getAttribute('title') || '').replace(/\s+/g, ' ').slice(0, 80);
      const testid = el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
      const href = tag === 'a' ? (el as HTMLAnchorElement).href : '';
      const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
      out.push({ index: i, tag, role: tag === 'a' ? 'link' : 'button', label, ...(testid ? { testid } : {}), ...(href ? { href } : {}), ...(disabled ? { disabled: true } : {}) });
    }
    return out;
  }, CONTROL_SELECTOR);
}

/** The locator a control is recorded under: its test id, else its role and accessible name. */
export function controlLocator(c: Pick<PageControl, 'role' | 'label' | 'testid'>): string {
  const call = c.testid
    ? emitLocatorCall('testid', c.testid)
    : emitLocatorCall('role', { role: c.role, ...(c.label ? { name: c.label } : {}) });
  return call.replace(/^page\./, '');
}

/** True when the normalized words contain the phrase as whole words. */
function hasPhrase(words: string, phrase: string): boolean {
  return ` ${words} `.includes(` ${normalizeWords(phrase)} `);
}

/** The deny phrase a control's words name, or null. The phrase's last word may carry any ending. */
export function deniedBy(words: string): string | null {
  for (const phrase of STATE_TRIGGER_DENY) {
    const parts = normalizeWords(phrase).split(' ');
    const last = parts.pop()!;
    const rx = new RegExp(`(^| )${[...parts, `${last}[a-z]*`].join(' ')}( |$)`);
    if (rx.test(words)) return phrase;
  }
  return null;
}

/**
 * The controls whose normalized label or test id contains one of the
 * phrases, each with the phrase that matched and the deny verdict. A
 * disabled control is skipped: it can never be clicked (disabledTriggers
 * names it). Pure, so it reads a crawl's kept controls as well as a fresh
 * page's.
 */
export function findTriggers(controls: PageControl[], phrases: string[]): TriggerControl[] {
  return matchTriggers(controls.filter((c) => !c.disabled), phrases);
}

/** The disabled controls that would otherwise be triggers (an out-of-stock "Add to cart"), so the probe can say so. */
export function disabledTriggers(controls: PageControl[], phrases: string[]): TriggerControl[] {
  return matchTriggers(controls.filter((c) => c.disabled), phrases);
}

function matchTriggers(controls: PageControl[], phrases: string[]): TriggerControl[] {
  const out: TriggerControl[] = [];
  for (const c of controls) {
    const words = normalizeWords(`${c.label} ${c.testid ?? ''}`);
    const phrase = phrases.find((p) => hasPhrase(normalizeWords(c.label), p) || hasPhrase(normalizeWords(c.testid ?? ''), p));
    if (!phrase) continue;
    const denied = deniedBy(words);
    out.push({ ...c, phrase, ...(denied ? { denied } : {}), control: controlLocator(c) });
  }
  return out;
}

/** The trigger phrases for a feature's tokens, from STATE_TRIGGERS. Empty when no row applies. */
export function triggerPhrasesFor(tokens: string[]): string[] {
  const set = new Set(tokens.map((t) => t.toLowerCase()));
  return [...new Set(STATE_TRIGGERS.filter((row) => row.tokens.some((t) => set.has(t))).flatMap((row) => row.phrases))];
}

/** A feature's path tokens: the name's own plus the rule-content ones, when given. */
export function featureTokensOf(feature: string, featureTokens?: Record<string, string[]>): string[] {
  return [...new Set([...tokensFor(feature), ...(featureTokens?.[feature] ?? [])])];
}

/** How many of the feature's tokens a link names, by path segment, label or test id. 0 means no match. */
export function linkTokenMatches(link: Pick<PageControl, 'href' | 'label' | 'testid'>, tokens: string[]): number {
  let segments: string[] = [];
  try { segments = link.href ? new URL(link.href).pathname.toLowerCase().split('/').filter(Boolean) : []; } catch { segments = []; }
  const words = new Set(normalizeWords(`${link.label} ${link.testid ?? ''}`).split(' ').filter(Boolean));
  let n = 0;
  for (const tok of tokens) {
    const tokWords = normalizeWords(tok);
    if (segments.some((s) => segmentMatchesTokens(s, [tok])) || (tokWords.length > 0 && tokWords.split(' ').every((w) => words.has(w)))) n++;
  }
  return n;
}

/** origin + path, trailing slash and query and hash dropped. */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return url;
  }
}

/** The path a human reads in a line. */
function pathOf(url: string): string {
  try { return new URL(url).pathname || '/'; } catch { return url; }
}

/* ── Rule split ───────────────────────────────────────────────────────────── */

/**
 * Which side each rule of a state-dependent feature is planned on. A rule
 * whose words name the trigger's action (the verb of the trigger phrase:
 * "add" as add, adds, adding, added) and do not name the revealed page is an
 * origin rule: R6 "Adding a product from its detail page increases the cart
 * count shown in the header" is verified before the cart link is followed.
 * Every other rule is a revealed-page rule. The revealed page is named by
 * "<feature token> page" ("cart page") or by a heading or title phrase of
 * two or more words read off the revealed page; a single-word heading such
 * as "Cart" is the feature's own noun and names nothing on its own. Judged on
 * the rule text from the requirements map, normalized like featureTokenMap
 * reads rule content, never on a scenario name the model wrote.
 */
export function splitRulesByPage(
  rules: Array<Pick<RequirementRule, 'id' | 'text'>>,
  opts: { tokens: string[]; phrases: string[]; revealedTitle?: string; revealedHeadings?: string[] },
): Array<{ ruleId: string; side: 'origin' | 'revealed' }> {
  const verbs = [...new Set(opts.phrases.map((p) => normalizeWords(p).split(' ')[0]!).filter(Boolean))];
  const verbRe = verbs.length > 0 ? new RegExp(`\\b(${verbs.join('|')})(s|es|ed|d|ing)?\\b`) : null;
  const tokenWords = opts.tokens.map((t) => normalizeWords(t)).filter(Boolean);
  const pageRe = tokenWords.length > 0 ? new RegExp(`\\b(${tokenWords.join('|')}) pages?\\b`) : null;
  const pagePhrases = [...(opts.revealedHeadings ?? []), ...(opts.revealedTitle ?? '').split(/[|:·•\-]+/)]
    .map((h) => normalizeWords(h))
    .filter((h) => h.split(' ').length >= 2);
  return rules.map((r) => {
    const words = normalizeWords(r.text);
    const namesAction = !!verbRe && verbRe.test(words);
    const namesPage = (!!pageRe && pageRe.test(words)) || pagePhrases.some((p) => ` ${words} `.includes(` ${p} `));
    return { ruleId: r.id, side: namesAction && !namesPage ? 'origin' : 'revealed' };
  });
}

/* ── Detection ────────────────────────────────────────────────────────────── */

/** One feature the probe should run on: its tokens and the trigger phrases that apply. */
export interface StateCandidateFeature {
  feature: RequirementFeature;
  tokens: string[];
  phrases: string[];
}

/**
 * The state-dependent candidates: features with stated rules that no
 * candidate page carries by page evidence (an SRS-stated URL, or a path
 * segment matching the feature's tokens over EVERY candidate before the
 * filter) and whose tokens have a trigger row. A tag from the page filter's
 * model pick is never read: it is model text, not page evidence.
 */
export function detectStateFeatures(map: RequirementsMap | undefined, candidates: DiscoveredPage[], featureTokens?: Record<string, string[]>): StateCandidateFeature[] {
  if (!map) return [];
  const out: StateCandidateFeature[] = [];
  for (const f of map.features) {
    if (f.rules.length === 0) continue;
    if (candidates.some((p) => p.source === 'srs' && p.feature === f.name)) continue;
    if (pagesCarryingFeature(candidates.filter((p) => p.source !== 'action'), f.name, featureTokens).length > 0) continue;
    const tokens = featureTokensOf(f.name, featureTokens);
    const phrases = triggerPhrasesFor(tokens);
    if (phrases.length === 0) continue;
    out.push({ feature: f, tokens, phrases });
  }
  return out;
}

/* ── The probe ────────────────────────────────────────────────────────────── */

/** One crawl candidate as the probe sees it: its URL, whether it is volatile, which page linked to it, and the controls the crawl kept. */
export interface ProbeCandidate {
  url: string;
  volatile?: boolean;
  linkedFrom?: string;
  controls?: PageControl[];
  /** Set on an item page the probe reached by the item hop: the item link clicked on the listing (linkedFrom). */
  hopControl?: string;
}

export interface ProbeOptions {
  feature: string;
  tokens: string[];
  phrases: string[];
  /** The crawl candidates in crawl order (every page the winning rung found, before the filter). */
  candidates: ProbeCandidate[];
  robots?: Pick<RobotsInfo, 'disallow'>;
  /** Fresh-context page factory. Defaults to a headless Chromium launched only when a page must load. */
  openPage?: ProbePageFactory;
  /** Pause between page loads. Smokes set 0; the default is CRAWL_DELAY_MS. */
  delayMs?: number;
  /** How long to wait for a new link after a trigger click. */
  revealWaitMs?: number;
  /** The anchor settle cap before the pre-click read (discovery's waitForAnchors). */
  anchorWaitMs?: number;
  /** The settle cap for a loaded page. */
  settleCapMs?: number;
}

export interface ProbeResult {
  probe: Omit<StateProbe, 'rulesSplit'>;
  /** The revealed page, source 'action', with reachedBy. */
  page?: DiscoveredPage;
  /** The revealed page as the probe's own context saw it after the action. In memory only. */
  snapshot?: PageSnapshot;
  /** The trigger phrase that fired. */
  phrase?: string;
  /**
   * The origin when it is an item page the hop reached (revealed or robots):
   * source 'action', reachedBy the item click from the listing, and its
   * snapshot before the trigger click (in memory only).
   */
  originPage?: OriginPage;
  /** The origin a robots-blocked reveal found (outcome robots), so its origin rules are still planned there. */
  blocked?: { origin: string; originPage?: OriginPage };
}

/** An item page the hop made the origin: reached by clicking the item on the listing, never by its URL. */
export interface OriginPage {
  page: DiscoveredPage & { reachedBy: NonNullable<DiscoveredPage['reachedBy']> };
  snapshot: PageSnapshot;
}

interface Qualified {
  triggerUrl: string;
  triggerVolatile: boolean;
  origin: string;
  revealed: string;
  actions: ReachAction[];
  tokensMatched: number;
  depth: number;
  index: number;
  snapshot: PageSnapshot;
  phrase: string;
  /** Set when the trigger page was reached by the item hop. */
  hop?: { listing: string; item: string; control: string; snapshot: PageSnapshot };
}

/** A robots-blocked reveal: the origin found, the path and the rule, and the hop when the origin is an item page. */
interface Blocked {
  triggerVolatile: boolean;
  origin: string;
  path: string;
  rule: string;
  depth: number;
  index: number;
  hop?: { listing: string; item: string; control: string; snapshot: PageSnapshot };
}

/**
 * The item links on a page, in document order: same-origin anchors whose
 * path carries a generated id (isVolatilePath, the kind discovery tags
 * volatile, such as /product/<ulid>). Category and other stable listings are
 * never item links, so a hop never lands on another listing.
 */
export function itemLinks(controls: PageControl[], pageUrl: string): PageControl[] {
  let origin = '';
  try { origin = new URL(pageUrl).origin; } catch { return []; }
  const seen = new Set<string>();
  return controls.filter((c) => {
    if (c.role !== 'link' || !c.href) return false;
    let u: URL;
    try { u = new URL(c.href); } catch { return false; }
    if (u.origin !== origin || !isVolatilePath(u.pathname)) return false;
    const key = pageKey(c.href);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The locator an item link is clicked by: its test id when the test id holds
 * no generated id, else its role and visible name (gate RULE 6 refuses a
 * selector that embeds a generated id). A card's name often ends with its
 * price ("Combination Pliers $14.15"); the name is cut before the first
 * currency amount, because gate RULE 8 refuses a price in a locator name.
 */
export function itemLinkLocator(c: Pick<PageControl, 'label' | 'testid'>): string {
  const testid = c.testid && !generatedIdFragment(c.testid) ? c.testid : undefined;
  const price = currencyAmountIn(c.label);
  const name = price ? c.label.slice(0, c.label.indexOf(price)).trim() || c.label : c.label;
  return controlLocator({ role: 'link', label: name, ...(testid ? { testid } : {}) });
}

/** The nearest stable page up the linkedFrom chain, or null. */
function stableAncestor(c: ProbeCandidate, byUrl: Map<string, ProbeCandidate>): string | null {
  let cur: string | undefined = c.linkedFrom;
  for (let hops = 0; cur && hops < 6; hops++) {
    let volatile = false;
    try { volatile = isVolatilePath(new URL(cur).pathname); } catch { return null; }
    if (!volatile) return cur;
    cur = byUrl.get(cur)?.linkedFrom;
  }
  return null;
}

/** Same-origin anchors that are new against a path set and name the feature, best match first. */
function newMatchingLinks(anchors: PageControl[], before: Set<string>, origin: string, tokens: string[]): Array<{ a: PageControl; n: number }> {
  const out: Array<{ a: PageControl; n: number }> = [];
  for (const a of anchors) {
    if (a.role !== 'link' || !a.href) continue;
    let u: URL;
    try { u = new URL(a.href); } catch { continue; }
    if (u.origin !== origin) continue;
    if (before.has(pageKey(a.href))) continue;
    const n = linkTokenMatches(a, tokens);
    if (n > 0) out.push({ a, n });
  }
  return out.sort((x, y) => y.n - x.n);
}

/**
 * Probe one feature. Looks for a trigger on at most STATE_PROBE_PAGE_CAP
 * loaded pages (a page whose controls the browser crawl kept is judged from
 * that load), stable before volatile, then shallowest, then crawl order;
 * clicks at most STATE_PROBE_CLICK_CAP triggers, each in a fresh context,
 * never a denied control; takes as revealed a same-origin anchor that was
 * absent before the click and names the feature's tokens; follows it in the
 * same context and snapshots the page. Robots is honored for the page loaded
 * and for the revealed path. Never throws: a browser failure is outcome
 * error with its message.
 */
export async function probeStateFeature(opts: ProbeOptions): Promise<ProbeResult> {
  const { feature, tokens, phrases } = opts;
  const robots = opts.robots ?? { disallow: [] };
  const delayMs = opts.delayMs ?? CRAWL_DELAY_MS;
  const revealWaitMs = opts.revealWaitMs ?? STATE_PROBE_REVEAL_WAIT_MS;
  const tried: StateProbe['tried'] = [];
  const qualified: Qualified[] = [];
  const blocked: Blocked[] = [];
  const byUrl = new Map(opts.candidates.map((c) => [c.url, c]));
  const candidateKeys = new Set(opts.candidates.map((c) => pageKey(c.url)));
  const ordered = opts.candidates
    .map((c, i) => ({ c, i, volatile: c.volatile ?? (() => { try { return isVolatilePath(new URL(c.url).pathname); } catch { return false; } })(), depth: pathOf(c.url).split('/').filter(Boolean).length }))
    .sort((a, b) => Number(a.volatile) - Number(b.volatile) || a.depth - b.depth || a.i - b.i);
  // The item hop (invariant 78): a page with no trigger whose item links are
  // none of them candidates gets its FIRST item link tried right after it,
  // as a page of its own (a load against the page cap, after the delay,
  // robots checked). When an item page is already a candidate it is probed
  // on its own, as before.
  const hopFrom = (c: ProbeCandidate, controls: PageControl[], volatile: boolean): { item: PageControl; control: string } | null => {
    // One hop, from a stable listing only: an item page never hops again.
    if (c.hopControl || volatile) return null;
    const items = itemLinks(controls, c.url);
    if (items.length === 0 || items.some((l) => candidateKeys.has(pageKey(l.href!)))) return null;
    return { item: items[0]!, control: itemLinkLocator(items[0]!) };
  };

  let loads = 0;
  let clicks = 0;
  let robotsBlocked = false;
  let browserClose: (() => Promise<void>) | undefined;
  let open = opts.openPage;
  const openFresh = async (): Promise<ProbePageHandle> => {
    if (!open) {
      const d = await defaultPageFactory();
      open = d.open;
      browserClose = d.close;
    }
    return open();
  };

  // Every page that ended in an error, with the step and the message. A
  // failure is recorded on its own candidate and never ends the probe.
  const errored: Array<{ url: string; result: string }> = [];
  // Clicks that completed without qualifying (no new link, a denied link, no stable origin).
  let cleanMisses = 0;
  const pageCapUntried: string[] = [];
  let clickCapUntried: string[] = [];

  /** The item page a hop made the origin, reached by clicking the item on the listing. */
  const originPageOf = (feature: string, hop: NonNullable<Qualified['hop']>): OriginPage => ({
    page: {
      url: pageKey(hop.item),
      source: 'action',
      feature,
      volatile: true,
      reachedBy: { origin: hop.listing, feature, actions: [{ kind: 'click', via: 'item-link', control: hop.control }] },
    },
    snapshot: hop.snapshot,
  });
  const hopRecord = (hop: Qualified['hop']): Pick<StateProbe, 'hop'> => (hop ? { hop: { listing: hop.listing, item: pageKey(hop.item), control: hop.control } } : {});

  const finish = (globalError?: string): ProbeResult => {
    qualified.sort((a, b) => Number(a.triggerVolatile) - Number(b.triggerVolatile) || b.tokensMatched - a.tokensMatched || a.depth - b.depth || a.index - b.index);
    blocked.sort((a, b) => Number(a.triggerVolatile) - Number(b.triggerVolatile) || a.depth - b.depth || a.index - b.index);
    const best = qualified[0];
    const triedPaths = tried.map((t) => pathOf(t.url)).filter((p, i, a) => a.indexOf(p) === i);
    const capNotes = [
      ...(pageCapUntried.length > 0 ? [`page cap ${STATE_PROBE_PAGE_CAP} reached; not tried: ${pageCapUntried.join(', ')}`] : []),
      ...(clickCapUntried.length > 0 ? [`click cap ${STATE_PROBE_CLICK_CAP} reached; not tried: ${clickCapUntried.join(', ')}`] : []),
    ];
    const capped = capNotes.length > 0 ? capNotes.join('; ') : undefined;
    const capSuffix = capped ? `; ${capped}` : '';
    // A page that qualified is never discarded by a later failure.
    if (best) {
      const page: DiscoveredPage = { url: best.revealed, source: 'action', feature, reachedBy: { origin: best.origin, feature, actions: best.actions } };
      // With the hop, the item page is the origin (it holds the trigger); a
      // scenario still starts on the listing and clicks the item.
      const originOf = (q: Qualified): string => (q.hop ? pageKey(q.hop.item) : q.origin);
      return {
        probe: {
          feature,
          outcome: 'revealed',
          origins: qualified.map(originOf).filter((o, i, a) => a.indexOf(o) === i),
          tried,
          revealed: best.revealed,
          detail: best.hop
            ? `revealed ${pathOf(best.revealed)} from item page ${pathOf(best.hop.item)}, hopped from listing ${pathOf(best.hop.listing)}${capSuffix}`
            : `revealed ${pathOf(best.revealed)} from ${pathOf(best.origin)}${capSuffix}`,
          ...(capped ? { capped } : {}),
          ...hopRecord(best.hop),
        },
        page,
        snapshot: best.snapshot,
        phrase: best.phrase,
        ...(best.hop ? { originPage: originPageOf(feature, best.hop) } : {}),
      };
    }
    // Nothing qualified. robots first, then a click that completed and found
    // no link, then errors: 'error' only when every page the probe acted on
    // (loaded, clicked) failed with one, never when a clean result exists.
    const outcome: StateProbe['outcome'] = globalError
      ? 'error'
      : robotsBlocked ? 'robots' : cleanMisses > 0 ? 'no-new-link' : errored.length > 0 ? 'error' : 'no-trigger';
    const triedText = triedPaths.length > 0 ? `tried ${triedPaths.join(', ')}` : 'no candidate page to try';
    const robotsHit = tried.find((t) => /robots\.txt disallows/.test(t.result));
    const detail = globalError
      ? `no page revealed: probe error (${globalError}); ${triedText}${capSuffix}`
      : outcome === 'error'
        ? `no page revealed: probe error on ${errored.map((e) => `${pathOf(e.url)} (${e.result})`).join(', ')}; ${triedText}${capSuffix}`
        : `no page revealed: ${triedText}${outcome === 'robots' && robotsHit ? `; ${robotsHit.result}` : ''}${capSuffix}`;
    // A robots-blocked reveal still found an origin: its origin rules are
    // planned there (invariant 78), the hop's item page reached by action.
    const b = outcome === 'robots' ? blocked[0] : undefined;
    return {
      probe: {
        feature, outcome, origins: [], tried, detail, ...(capped ? { capped } : {}),
        ...(b ? { robotsBlocked: { origin: b.hop ? pageKey(b.hop.item) : b.origin, path: b.path, rule: b.rule }, ...hopRecord(b.hop) } : {}),
      },
      ...(b ? { blocked: { origin: b.origin, ...(b.hop ? { originPage: originPageOf(feature, b.hop) } : {}) } } : {}),
    };
  };

  /** One line of a Playwright error: its first line, without the trailing full stop. */
  const brief = (err: unknown): string => ((err as Error)?.message ?? String(err)).split('\n')[0]!.trim().replace(/\.$/, '');

  try {
    for (let k = 0; k < ordered.length; k++) {
      const { c, volatile, depth, i } = ordered[k]!;
      if (clicks >= STATE_PROBE_CLICK_CAP) {
        // The click cap stopped the probe: every candidate left is named.
        clickCapUntried = ordered.slice(k).map((o) => pathOf(o.c.url));
        break;
      }
      let path = '/';
      try { path = new URL(c.url).pathname; } catch { continue; }
      if (!robotsAllows(robots, path)) {
        tried.push({ url: c.url, result: `robots.txt disallows ${path}` });
        robotsBlocked = true;
        continue;
      }
      /** The tried entry for a page with no usable trigger; it queues the item hop when the page has one. */
      const noTrigger = (controls: PageControl[], triggers: TriggerControl[]): void => {
        const result = disabledResult(disabledTriggers(controls, phrases)) ?? deniedResult(triggers) ?? 'no trigger';
        const hop = result === 'no trigger' ? hopFrom(c, controls, volatile) : null;
        if (!hop) { tried.push({ url: c.url, result }); return; }
        const itemUrl = pageKey(hop.item.href!);
        tried.push({ url: c.url, result: `no trigger; hopped to item page ${pathOf(itemUrl)} by ${hop.control}` });
        let itemDepth = 0;
        try { itemDepth = new URL(itemUrl).pathname.split('/').filter(Boolean).length; } catch { itemDepth = 0; }
        ordered.splice(k + 1, 0, { c: { url: itemUrl, volatile: true, linkedFrom: c.url, hopControl: hop.control }, i, volatile: true, depth: itemDepth });
      };
      // A page the browser crawl already read is judged from that load.
      if (c.controls) {
        const known = findTriggers(c.controls, phrases);
        if (!known.some((t) => !t.denied)) {
          noTrigger(c.controls, known);
          continue;
        }
      }
      if (loads >= STATE_PROBE_PAGE_CAP) {
        // The page cap: this page needed a load. Pages the crawl read are still judged.
        pageCapUntried.push(path);
        continue;
      }
      if (loads > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      loads++;
      // Each candidate's work is its own: a failure names the step on THIS
      // page and the probe moves on to the next candidate.
      let fail = (msg: string): string => `opening a browser page failed (${msg})`;
      let handle: ProbePageHandle | undefined;
      let clicked: string | undefined;
      try {
        handle = await openFresh();
        const { page } = handle;
        fail = (msg) => `load failed (${msg})`;
        await page.goto(c.url, { waitUntil: 'load', timeout: 15_000 });
        fail = (msg) => `reading the page failed (${msg})`;
        await settleForSnapshot(page, opts.settleCapMs);
        await waitForAnchors(page, opts.anchorWaitMs);
        const controls = await readControls(page);
        const triggers = findTriggers(controls, phrases);
        const usable = triggers.filter((t) => !t.denied);
        if (usable.length === 0) {
          noTrigger(controls, triggers);
          continue;
        }
        const trigger = usable[0]!;
        clicked = trigger.control;
        // An item page the hop reached is the origin: its snapshot before the
        // trigger click is what its origin rules are planned from.
        const hop = c.hopControl && c.linkedFrom
          ? { listing: c.linkedFrom, item: c.url, control: c.hopControl, snapshot: await snapshotPage(page) }
          : undefined;
        const before = new Set((await readControls(page)).filter((a) => a.role === 'link' && a.href).map((a) => pageKey(a.href!)));
        before.add(pageKey(page.url()));
        clicks++;
        fail = (msg) => `clicked ${trigger.control} failed (${msg})`;
        await page.locator(CONTROL_SELECTOR).nth(trigger.index).click({ timeout: 5000 });
        // Read the anchors again until a new one names the feature, or the wait ends.
        const deadline = Date.now() + revealWaitMs;
        let links: Array<{ a: PageControl; n: number }> = [];
        const origin = new URL(c.url).origin;
        while (Date.now() <= deadline) {
          try { links = newMatchingLinks(await readControls(page), before, origin, tokens); } catch { links = []; }
          if (links.length > 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        if (links.length === 0) {
          tried.push({ url: c.url, control: trigger.control, result: `clicked ${trigger.control}, no new ${feature} link within ${revealWaitMs} ms` });
          cleanMisses++;
          continue;
        }
        // The deny list is checked before every click, the link's too.
        const allowed = links.filter((l) => !deniedBy(normalizeWords(`${l.a.label} ${l.a.testid ?? ''}`)));
        if (allowed.length === 0) {
          const d = links[0]!.a;
          tried.push({ url: c.url, control: trigger.control, result: `clicked ${trigger.control}, the new link ${controlLocator(d)} names "${deniedBy(normalizeWords(`${d.label} ${d.testid ?? ''}`))}" and was never clicked` });
          cleanMisses++;
          continue;
        }
        const link = allowed[0]!;
        const revealedPath = new URL(link.a.href!).pathname;
        const linkControl = controlLocator(link.a);
        // Only a qualifying page's entry says "revealed"; these say what appeared.
        const originUrl = volatile ? stableAncestor(c, byUrl) : c.url;
        const revealedRule = robotsRuleFor(robots, revealedPath);
        if (revealedRule !== null) {
          tried.push({ url: c.url, control: trigger.control, result: `clicked ${trigger.control}, a new link to ${revealedPath} appeared, but robots.txt disallows ${revealedPath}` });
          robotsBlocked = true;
          // The origin is still found: its origin rules are planned there.
          if (originUrl) blocked.push({ triggerVolatile: volatile, origin: originUrl, path: revealedPath, rule: revealedRule, depth, index: i, ...(hop ? { hop } : {}) });
          continue;
        }
        if (!originUrl) {
          tried.push({ url: c.url, control: trigger.control, result: `clicked ${trigger.control}, a new link to ${revealedPath} appeared, but no stable page links to this volatile page` });
          cleanMisses++;
          continue;
        }
        // Follow the revealed link in the same context, so the snapshot is
        // the page with the action's state in it (one item in the cart).
        fail = (msg) => `clicked ${trigger.control}, a new link to ${revealedPath} appeared, then clicking ${linkControl} failed (${msg})`;
        await page.locator(CONTROL_SELECTOR).nth(link.a.index).click({ timeout: 5000 });
        await page.waitForURL((u) => pageKey(u.toString()) === pageKey(link.a.href!), { timeout: 10_000 }).catch(() => {});
        await page.waitForLoadState('load').catch(() => {});
        fail = (msg) => `clicked ${trigger.control} and ${linkControl}, but the snapshot of ${revealedPath} failed (${msg})`;
        await settleForSnapshot(page, opts.settleCapMs);
        const snapshot = await snapshotPage(page);
        const revealed = pageKey(link.a.href!);
        const actions: ReachAction[] = [
          ...(volatile ? [(hop ? { kind: 'click', via: 'item-link', control: hop.control } : { kind: 'click', via: 'item-link' }) as ReachAction] : []),
          { kind: 'click', control: trigger.control },
          { kind: 'click', control: linkControl },
        ];
        tried.push({ url: c.url, control: trigger.control, result: `clicked ${trigger.control}, revealed ${revealedPath}` });
        qualified.push({ triggerUrl: c.url, triggerVolatile: volatile, origin: originUrl, revealed, actions, tokensMatched: link.n, depth, index: i, snapshot, phrase: trigger.phrase, ...(hop ? { hop } : {}) });
      } catch (err) {
        const result = fail(brief(err));
        tried.push({ url: c.url, ...(clicked ? { control: clicked } : {}), result });
        errored.push({ url: c.url, result });
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    return finish();
  } catch (err) {
    return finish(brief(err) || 'unknown error');
  } finally {
    await browserClose?.().catch(() => {});
  }
}

/** The tried result for a page whose only triggers are disabled, or null when none is. */
function disabledResult(triggers: TriggerControl[]): string | null {
  const d = triggers[0];
  return d ? `trigger disabled (${d.control})` : null;
}

/** The tried result for a page whose only triggers are denied, or null when none is. */
function deniedResult(triggers: TriggerControl[]): string | null {
  const d = triggers.find((t) => t.denied);
  return d ? `never clicked ${d.control} (names "${d.denied}")` : null;
}

/** A headless Chromium with a fresh context per page, the discovery user agent and the eval shim. */
async function defaultPageFactory(): Promise<{ open: ProbePageFactory; close: () => Promise<void> }> {
  const { chromium } = await import('playwright');
  const { installEvalShim } = await import('./eval-shim.js');
  const browser = await chromium.launch({ headless: true });
  return {
    open: async () => {
      const ctx = await browser.newContext({ userAgent: DISCOVERY_UA });
      await installEvalShim(ctx);
      const page = await ctx.newPage();
      return { page, close: () => ctx.close() };
    },
    close: () => browser.close(),
  };
}

/* ── Lines ────────────────────────────────────────────────────────────────── */

/** The actions as a reader follows them: "click an item" for the item hop (with the item link the hop used, when known), else the control. */
export function describeActions(actions: ReachAction[]): string {
  return actions.map((a) => (a.via === 'item-link' ? (a.control ? `click the item ${a.control}` : 'click an item') : a.kind === 'login' ? 'sign in' : a.control ?? a.kind)).join(', ');
}

/** The coverage detail of a revealed-side rule whose revealed page robots.txt disallows (invariant 78). */
export function robotsBlockedRuleDetail(rb: NonNullable<StateProbe['robotsBlocked']>): string {
  return `the action on ${pathOf(rb.origin)} reveals ${rb.path}, which robots.txt disallows (rule Disallow: ${rb.rule}); not loaded`;
}

/**
 * Per rule, the coverage reason a robots-blocked probe gives (invariant 78):
 * a revealed-side rule reads robots-disallowed with the path and the rule; an
 * origin-side rule was planned on the origin, so it reads not-planned when no
 * scenario cites it, never not-revealed. Rules of every other probe are
 * absent. A structural type, so the report's stored probes feed it.
 */
export function probeRuleReasons(stateProbes: Array<Pick<StateProbe, 'robotsBlocked' | 'rulesSplit'>> | undefined): Record<string, { reason: 'robots-disallowed' | 'not-planned'; detail?: string }> {
  const out: Record<string, { reason: 'robots-disallowed' | 'not-planned'; detail?: string }> = {};
  for (const p of stateProbes ?? []) {
    if (!p.robotsBlocked) continue;
    for (const r of p.rulesSplit ?? []) {
      out[r.ruleId] = r.side === 'revealed' ? { reason: 'robots-disallowed', detail: robotsBlockedRuleDetail(p.robotsBlocked) } : { reason: 'not-planned' };
    }
  }
  return out;
}

/**
 * The one console line per probe, printed whole (the CLI exempts it from the
 * message cap). Revealed names the page, the origin and the actions; not
 * revealed names every page and control tried.
 */
export function stateProbeLine(probe: StateProbe, reachedBy?: { actions: ReachAction[] }): string {
  const head = `State probe "${probe.feature}":`;
  if (probe.outcome === 'revealed' && probe.revealed && probe.origins[0]) {
    const from = probe.hop ? `item page ${pathOf(probe.hop.item)}, hopped from listing ${pathOf(probe.hop.listing)}` : pathOf(probe.origins[0]);
    return `${head} revealed ${pathOf(probe.revealed)} from ${from}${reachedBy ? ` (${describeActions(reachedBy.actions)})` : ''}${probe.capped ? `; ${probe.capped}` : ''}`;
  }
  const n = probe.rulesSplit.length;
  const plural = (k: number): string => `rule${k === 1 ? '' : 's'}`;
  // A robots-blocked reveal found its origin: the origin rules are planned
  // there, and the rest read robots-disallowed, never not-revealed.
  const rb = probe.robotsBlocked;
  const originIds = probe.rulesSplit.filter((r) => r.side === 'origin').map((r) => r.ruleId);
  const where = rb ? (probe.hop ? `item page ${pathOf(probe.hop.item)}, reached from listing ${pathOf(probe.hop.listing)} by a click` : pathOf(rb.origin)) : '';
  const tail = rb
    ? `${originIds.length > 0 ? `its origin ${plural(originIds.length)} ${originIds.join(', ')} ${originIds.length === 1 ? 'is' : 'are'} planned on ${where}; ` : ''}any of its ${n - originIds.length} ${originIds.length > 0 ? 'other ' : ''}${plural(n - originIds.length)} still uncited after planning will report robots-disallowed`
    : `any of its ${n} ${plural(n)} still uncited after planning will report not-revealed`;
  if (probe.outcome === 'error') return `${head} ${probe.detail}; ${tail}`;
  const tried = probe.tried.length > 0
    ? `tried ${probe.tried.map((t) => `${pathOf(t.url)} (${t.result})`).join(', ')}`
    : 'no candidate page to try';
  return `${head} no page revealed; ${tried}${probe.capped ? `; ${probe.capped}` : ''}; ${tail}`;
}

/** The rule split line: every rule id and its side. */
export function rulesSplitLine(probe: Pick<StateProbe, 'feature' | 'rulesSplit'>): string {
  return `State probe "${probe.feature}" rule split: ${probe.rulesSplit.map((r) => `${r.ruleId} ${r.side}`).join(', ') || 'no rules'}`;
}

/* ── All features ─────────────────────────────────────────────────────────── */

/** A feature whose probe revealed a page: the page, its snapshot, and which rules go where. */
export interface RevealedFeature {
  feature: string;
  page: DiscoveredPage & { reachedBy: NonNullable<DiscoveredPage['reachedBy']> };
  snapshot: PageSnapshot;
  originRuleIds: string[];
  revealedRuleIds: string[];
  /** Set when the item hop found the trigger: the item page is the origin, planned from its own snapshot and reached by a click (invariant 78). */
  originPage?: OriginPage;
}

/**
 * A feature whose trigger revealed a link robots.txt disallows (invariant
 * 78): nothing is revealed, and the origin rules are still planned on the
 * origin. `origin` is the page a scenario starts on; `originPage` is set when
 * the origin is an item page the hop reached.
 */
export interface BlockedFeature {
  feature: string;
  origin: string;
  originPage?: OriginPage;
  originRuleIds: string[];
  revealedRuleIds: string[];
}

export interface StateProbesResult {
  probes: StateProbe[];
  revealed: RevealedFeature[];
  /** Features whose revealed page robots.txt disallows, each with the origin its origin rules are planned on. */
  blocked: BlockedFeature[];
  /** The console lines, in order: per feature, the probe line then the rule split line. */
  lines: string[];
}

/**
 * Detect the state-dependent features and probe each one. Sequential, one
 * feature at a time. With no candidate feature nothing loads and nothing is
 * printed.
 */
export async function runStateProbes(opts: {
  map: RequirementsMap | undefined;
  /** Every candidate the winning rung found, before the filter. */
  candidates: DiscoveredPage[];
  pageControls?: Record<string, PageControl[]>;
  robots?: Pick<RobotsInfo, 'disallow'>;
  featureTokens?: Record<string, string[]>;
  openPage?: ProbePageFactory;
  delayMs?: number;
  revealWaitMs?: number;
  anchorWaitMs?: number;
  settleCapMs?: number;
}): Promise<StateProbesResult> {
  const features = detectStateFeatures(opts.map, opts.candidates, opts.featureTokens);
  const probes: StateProbe[] = [];
  const revealed: RevealedFeature[] = [];
  const blocked: BlockedFeature[] = [];
  const lines: string[] = [];
  const candidates: ProbeCandidate[] = opts.candidates
    .filter((p) => p.source !== 'action')
    .map((p) => ({ url: p.url, ...(p.volatile ? { volatile: true } : {}), ...(p.linkedFrom ? { linkedFrom: p.linkedFrom } : {}), ...(opts.pageControls?.[p.url] ? { controls: opts.pageControls[p.url] } : {}) }));
  for (const f of features) {
    const r = await probeStateFeature({
      feature: f.feature.name,
      tokens: f.tokens,
      phrases: f.phrases,
      candidates,
      ...(opts.robots ? { robots: opts.robots } : {}),
      ...(opts.openPage ? { openPage: opts.openPage } : {}),
      ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
      ...(opts.revealWaitMs !== undefined ? { revealWaitMs: opts.revealWaitMs } : {}),
      ...(opts.anchorWaitMs !== undefined ? { anchorWaitMs: opts.anchorWaitMs } : {}),
      ...(opts.settleCapMs !== undefined ? { settleCapMs: opts.settleCapMs } : {}),
    });
    const rulesSplit = splitRulesByPage(f.feature.rules, {
      tokens: f.tokens,
      phrases: r.phrase ? [r.phrase] : f.phrases,
      ...(r.snapshot ? { revealedTitle: r.snapshot.title, revealedHeadings: r.snapshot.headings.map((h) => h.label ?? '') } : {}),
    });
    const probe: StateProbe = { ...r.probe, rulesSplit };
    probes.push(probe);
    lines.push(stateProbeLine(probe, r.page?.reachedBy), rulesSplitLine(probe));
    const originRuleIds = rulesSplit.filter((s) => s.side === 'origin').map((s) => s.ruleId);
    const revealedRuleIds = rulesSplit.filter((s) => s.side === 'revealed').map((s) => s.ruleId);
    if (r.page?.reachedBy && r.snapshot) {
      revealed.push({
        feature: f.feature.name,
        page: { ...r.page, reachedBy: r.page.reachedBy },
        snapshot: r.snapshot,
        originRuleIds,
        revealedRuleIds,
        ...(r.originPage ? { originPage: r.originPage } : {}),
      });
    } else if (r.blocked) {
      blocked.push({ feature: f.feature.name, origin: r.blocked.origin, ...(r.blocked.originPage ? { originPage: r.blocked.originPage } : {}), originRuleIds, revealedRuleIds });
    }
  }
  return { probes, revealed, blocked, lines };
}
