import type { DiscoveredPage, ReachAction } from './discovery.js';
import { pagesCarryingFeature } from './page-filter.js';
import { crossPageBasisText, dedupeAcrossPages, pageFitRejectionLine, uniqueScenarioNames, type CarriesFeature, type PageSnapshot, type PlannedScenario, type PlanResult, type RuleRetry } from './planner.js';
import type { RequirementsMap } from './requirements.js';
import type { BlockedFeature, OriginPage, RevealedFeature } from './state-probe.js';
import type { PlanSkippedPage, PlanTrimmed } from './trace.js';

/**
 * Per-page planning for a discovery run: which plan() call each page gets,
 * and the loop that runs them under the scenario caps with cross-page dedup
 * and unique names. Lifted out of runtime.ts so the smoke and the $0 proof
 * drive the same chain the runtime runs, with a fixture plan function.
 *
 * A page reached by action (invariant 71) adds one plan call of its own,
 * right after its origin page: planned from the probe's post-action
 * snapshot, with the feature's revealed-page rules only. The feature's
 * origin rules stay on every other page's call. Without a revealed page the
 * targets are exactly the filtered pages with their sub-maps, as before.
 */

/** Cap on scenarios planned per discovered page. */
export const PER_PAGE_SCENARIO_CAP = 4;
/** Global cap on planned scenarios per run; planning stops once reached. */
export const GLOBAL_PLAN_CAP = 20;

/** A requirements map narrowed to one feature, for per-page rule context. */
export function subMapFor(map: RequirementsMap | undefined, feature: string | undefined): RequirementsMap | undefined {
  if (!map || !feature) return map;
  const matched = map.features.filter((f) => f.name === feature);
  return matched.length > 0 ? { ...map, features: matched } : map;
}

/** One plan() call: the page it is made for and what it is given. */
export interface PlanTarget {
  /** The page the call plans: the revealed page for a page reached by action. Its feature drives dedup and names. */
  page: DiscoveredPage;
  requirements?: RequirementsMap;
  features?: string[];
  volatile?: boolean;
  /** The probe's post-action snapshot, for a page reached by action. */
  snapshot?: PageSnapshot;
  /** Set for a page reached by action: every scenario starts on the origin. */
  reachedBy?: { origin: string; actions: ReachAction[] };
  /** The features whose state probe found its trigger on this page (the probe's origin): page evidence for those features. */
  originOf?: string[];
}

/** What plan() receives from the loop; the caller adds the key, the model and the retry budget. */
export interface PlanCallArgs {
  url: string;
  features?: string[];
  requirements?: RequirementsMap;
  volatilePage?: boolean;
  snapshot?: PageSnapshot;
  reachedBy?: { origin: string; actions: ReachAction[] };
}

/** origin + path, trailing slash, query and hash dropped. */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return url;
  }
}

/** The map with each revealed feature's rules narrowed to the given ids. */
function narrowRules(map: RequirementsMap | undefined, keep: Map<string, Set<string>>): RequirementsMap | undefined {
  if (!map || keep.size === 0) return map;
  return { ...map, features: map.features.map((f) => (keep.has(f.name) ? { ...f, rules: f.rules.filter((r) => keep.get(f.name)!.has(r.id)) } : f)) };
}

/**
 * The plan calls for a discovery run, in order, and the page set the run
 * records. Every filtered page keeps its call and its sub-map; for a feature
 * with a revealed page, that feature's rules on those calls are narrowed to
 * its origin rules, the origin page's call carries them even when the
 * origin is tagged with another feature, and the revealed page's own call
 * follows its origin's with the revealed-page rules. An origin the filter
 * did not keep is added (from the crawl candidates) when it has origin
 * rules to plan. With no revealed feature the targets are the pages with
 * their sub-maps, exactly as before.
 *
 * The item hop (invariant 78): when the origin is an item page the probe
 * reached from a listing, the origin rules get a call of their own on that
 * item page, planned from its snapshot and reached by the item click from
 * the listing (its scenarios start on the listing; the item URL is never
 * navigated to), placed right after the listing's call. A robots-blocked
 * reveal (`blocked`) plans the origin rules on its origin the same way and
 * narrows nothing, since no revealed page takes the other rules.
 */
export function buildPlanTargets(opts: {
  pages: DiscoveredPage[];
  map?: RequirementsMap;
  features?: string[];
  revealed?: RevealedFeature[];
  /** Features whose revealed page robots.txt disallows, with the origin their origin rules go to. */
  blocked?: BlockedFeature[];
  /** Every crawl candidate, to find an origin the filter did not keep. */
  candidates?: DiscoveredPage[];
}): { targets: PlanTarget[]; pages: DiscoveredPage[] } {
  const revealed = opts.revealed ?? [];
  const blocked = opts.blocked ?? [];
  const originRules = new Map(revealed.map((r) => [r.feature, new Set(r.originRuleIds)]));
  /** The map narrowed to one feature's given rules, or undefined without a map. */
  const featureMap = (feature: string, ruleIds: string[]): RequirementsMap | undefined => {
    const f = opts.map?.features.find((x) => x.name === feature);
    return opts.map && f ? { ...opts.map, features: [{ ...f, rules: f.rules.filter((x) => ruleIds.includes(x.id)) }] } : undefined;
  };
  const revealedTarget = (r: RevealedFeature): PlanTarget => {
    const requirements = featureMap(r.feature, r.revealedRuleIds);
    return {
      page: r.page,
      ...(requirements ? { requirements } : {}),
      features: [r.feature],
      snapshot: r.snapshot,
      reachedBy: { origin: r.page.reachedBy.origin, actions: r.page.reachedBy.actions },
    };
  };
  /** The item page the hop made the origin: its own call, from its own snapshot, reached by the item click. */
  const itemOriginTarget = (feature: string, op: OriginPage, ruleIds: string[]): PlanTarget => {
    const requirements = featureMap(feature, ruleIds);
    return {
      page: op.page,
      ...(requirements ? { requirements } : {}),
      features: [feature],
      snapshot: op.snapshot,
      reachedBy: { origin: op.page.reachedBy.origin, actions: op.page.reachedBy.actions },
      originOf: [feature],
    };
  };
  /** A stable origin page's call carries the feature's origin rules, even when the page is tagged with another feature. */
  const carryOriginRules = (requirements: RequirementsMap | undefined, features: string[] | undefined, feature: string, ruleIds: string[]): { requirements: RequirementsMap | undefined; features: string[] | undefined } => {
    if (requirements && opts.map && !requirements.features.some((f) => f.name === feature)) {
      const f = opts.map.features.find((x) => x.name === feature);
      if (f) requirements = { ...requirements, features: [...requirements.features, { ...f, rules: f.rules.filter((x) => ruleIds.includes(x.id)) }] };
      if (features && !features.includes(feature)) features = [...features, feature];
    }
    return { requirements, features };
  };
  const targets: PlanTarget[] = [];
  const pages: DiscoveredPage[] = [...opts.pages];
  const placed = new Set<string>();
  const placedBlocked = new Set<string>();
  for (const pg of opts.pages) {
    let requirements = narrowRules(subMapFor(opts.map, pg.feature), originRules);
    let features = pg.feature ? [pg.feature] : opts.features;
    const originOf: string[] = [];
    const here = revealed.filter((r) => pageKey(r.page.reachedBy.origin) === pageKey(pg.url));
    const hereBlocked = blocked.filter((b) => pageKey(b.origin) === pageKey(pg.url));
    // The origin's call carries the feature's origin rules even when the
    // page is tagged with another feature; with the hop the item page is the
    // origin and carries them instead.
    for (const r of here) {
      if (r.originPage) continue;
      ({ requirements, features } = carryOriginRules(requirements, features, r.feature, r.originRuleIds));
      originOf.push(r.feature);
    }
    for (const b of hereBlocked) {
      if (b.originPage || b.originRuleIds.length === 0) continue;
      ({ requirements, features } = carryOriginRules(requirements, features, b.feature, b.originRuleIds));
      originOf.push(b.feature);
    }
    targets.push({ page: pg, ...(requirements ? { requirements } : {}), ...(features ? { features } : {}), ...(pg.volatile ? { volatile: true } : {}), ...(originOf.length > 0 ? { originOf } : {}) });
    for (const r of here) {
      if (r.originPage && r.originRuleIds.length > 0) {
        targets.push(itemOriginTarget(r.feature, r.originPage, r.originRuleIds));
        pages.push(r.originPage.page);
      }
      targets.push(revealedTarget(r));
      pages.push(r.page);
      placed.add(r.feature);
    }
    for (const b of hereBlocked) {
      if (b.originPage && b.originRuleIds.length > 0) {
        targets.push(itemOriginTarget(b.feature, b.originPage, b.originRuleIds));
        pages.push(b.originPage.page);
      }
      placedBlocked.add(b.feature);
    }
  }
  /** An origin the filter did not keep: from the crawl candidates, tagged with the feature, carrying its origin rules. */
  const unkeptOrigin = (feature: string, origin: string, ruleIds: string[]): PlanTarget | null => {
    const requirements = featureMap(feature, ruleIds);
    if (!requirements) return null;
    const known = opts.candidates?.find((c) => pageKey(c.url) === pageKey(origin));
    const page: DiscoveredPage = { ...(known ?? { url: origin, source: 'crawl' as const }), feature };
    return { page, requirements, features: [feature], originOf: [feature] };
  };
  for (const r of revealed) {
    if (placed.has(r.feature)) continue;
    // The filter did not keep the origin: plan it for the feature's origin
    // rules (when there are any), then the revealed page.
    if (r.originRuleIds.length > 0) {
      const t = r.originPage ? itemOriginTarget(r.feature, r.originPage, r.originRuleIds) : unkeptOrigin(r.feature, r.page.reachedBy.origin, r.originRuleIds);
      if (t) {
        targets.push(t);
        pages.push(t.page);
      }
    }
    targets.push(revealedTarget(r));
    pages.push(r.page);
  }
  for (const b of blocked) {
    if (placedBlocked.has(b.feature) || b.originRuleIds.length === 0) continue;
    const t = b.originPage ? itemOriginTarget(b.feature, b.originPage, b.originRuleIds) : unkeptOrigin(b.feature, b.origin, b.originRuleIds);
    if (t) {
      targets.push(t);
      pages.push(t.page);
    }
  }
  return { targets, pages };
}

/** The console line for one rule retry. */
export function ruleRetryLine(rr: RuleRetry): string {
  const what = rr.outcome === 'planned'
    ? `planned "${rr.scenario}"`
    : rr.outcome === 'rejected'
      ? `rejected "${rr.scenario}": ${rr.reason}`
      : `no scenario returned (${rr.reason})`;
  return `Planner rule retry ${rr.ruleId}: ${what} · $${rr.costUsd.toFixed(4)}`;
}

export interface PlanAcrossPagesResult {
  combined: PlannedScenario[];
  dropped: Array<{ scenario: PlannedScenario; duplicateOf: PlannedScenario }>;
  rejected: Array<{ scenario: PlannedScenario; reason: string }>;
  citationDrops: Array<{ scenario: string; ruleId: string; reason: string }>;
  pageFitRejected: PlannedScenario[];
  contradictionRejected: PlannedScenario[];
  /** The plan calls' cost only (the page filter's is the caller's). */
  plannerUsd: number;
  fillableMax: number;
  planCapHit: boolean;
  /** Every scenario a cap cut (the per-page cap or the global cap, named by `cause`), with its page and cited rules; [] when nothing was cut. Never in `combined`. */
  planTrimmed: PlanTrimmed[];
  /** Every page the global cap left unplanned, by URL with its feature tag; [] when the cap left none. */
  planSkippedPages: PlanSkippedPage[];
}

/**
 * Plan every target in order: up to PER_PAGE_SCENARIO_CAP scenarios per
 * call, GLOBAL_PLAN_CAP in all, the same feature + category + intent kept
 * once across pages, names unique across pages. A scenario planned on a page
 * reached by action carries pageUrl = the origin and reachedBy. A failed
 * call is handed to onPlanError (which throws to stop the run) and is
 * otherwise skipped with a line.
 */
export async function planAcrossPages(opts: {
  targets: PlanTarget[];
  planFn: (args: PlanCallArgs) => Promise<PlanResult>;
  onMessage: (text: string) => void;
  onPlanError?: (err: unknown, target: PlanTarget, partial: { combined: PlannedScenario[]; plannerUsd: number }) => void | Promise<void>;
  /** Extra path tokens per feature (featureTokenMap), for the page-evidence check of the cross-page dedup. */
  featureTokens?: Record<string, string[]>;
}): Promise<PlanAcrossPagesResult> {
  const { targets, onMessage } = opts;
  let combined: PlannedScenario[] = [];
  const dropped: PlanAcrossPagesResult['dropped'] = [];
  const rejected: PlanAcrossPagesResult['rejected'] = [];
  const citationDrops: PlanAcrossPagesResult['citationDrops'] = [];
  const pageFitRejected: PlannedScenario[] = [];
  const contradictionRejected: PlannedScenario[] = [];
  let plannerUsd = 0;
  let fillableMax = 0;
  let planCapHit = false;
  const planTrimmed: PlanTrimmed[] = [];
  const planSkippedPages: PlanSkippedPage[] = [];
  const pageFeatureOf = (url: string | undefined): string | undefined => targets.find((t) => t.page.url === url)?.page.feature;
  const carriesFeature = targetEvidence(targets, opts.featureTokens);
  for (const [idx, t] of targets.entries()) {
    const pg = t.page;
    if (combined.length >= GLOBAL_PLAN_CAP) {
      planCapHit = true;
      // Every page the cap leaves unplanned is named and recorded (it used
      // to say only how many), so a rule whose feature lives on one of them
      // reads page-not-planned-global-cap, never not-planned.
      const left = targets.slice(idx);
      for (const l of left) planSkippedPages.push({ url: l.page.url, ...(l.page.feature ? { feature: l.page.feature } : {}) });
      onMessage(globalCapPagesLine(left.map((l) => l.page.url)));
      break;
    }
    let p: PlanResult;
    try {
      p = await opts.planFn({
        url: pg.url,
        ...(t.features ? { features: t.features } : {}),
        ...(t.requirements ? { requirements: t.requirements } : {}),
        ...(t.volatile ? { volatilePage: true } : {}),
        ...(t.snapshot ? { snapshot: t.snapshot } : {}),
        ...(t.reachedBy ? { reachedBy: t.reachedBy } : {}),
      });
    } catch (err) {
      await opts.onPlanError?.(err, t, { combined, plannerUsd });
      onMessage(`Planner failed on ${pg.url} (${(err as Error).message}); page skipped.`);
      continue;
    }
    const placeOf = (s: PlannedScenario): PlannedScenario => ({
      ...s,
      pageUrl: t.reachedBy ? t.reachedBy.origin : pg.url,
      ...(t.volatile ? { volatilePage: true } : {}),
      ...(pg.feature && !s.feature ? { feature: pg.feature } : {}),
      ...(t.reachedBy ? { reachedBy: { pageUrl: pg.url, origin: t.reachedBy.origin, actions: t.reachedBy.actions } } : {}),
    });
    let scen = p.scenarios.map(placeOf);
    // Page fit: each drop is named with its page, and the scenario never
    // reaches the plan, so the funnel stays balanced.
    for (const r of p.pageFitRejected) {
      onMessage(pageFitRejectionLine(r.scenario, pg.url, r.reason));
      pageFitRejected.push(placeOf(r.scenario));
    }
    for (const r of p.contradictionRejected) {
      onMessage(`Rejected contradiction scenario: "${r.scenario.name}" on ${pg.url}: ${r.reason}`);
      contradictionRejected.push(placeOf(r.scenario));
    }
    for (const rr of p.ruleRetries) onMessage(ruleRetryLine(rr));
    if (scen.length > PER_PAGE_SCENARIO_CAP) {
      planCapHit = true;
      // A rule's only citer on this page is kept first; every cut scenario
      // is named with its rules and recorded (run 59540f cut R3's only
      // citer and said nothing, and R3 read not-planned).
      const trim = trimToPageCap(scen, PER_PAGE_SCENARIO_CAP);
      onMessage(pageCapLine(pg.url, scen.length, PER_PAGE_SCENARIO_CAP, trim.cut));
      for (const c of trim.cut) planTrimmed.push({ pageUrl: pg.url, name: c.name, ruleIds: [...(c.ruleIds ?? [])], cause: 'page-cap' });
      scen = trim.kept;
    }
    const room = GLOBAL_PLAN_CAP - combined.length;
    if (scen.length > room) {
      planCapHit = true;
      // The global cap names every scenario it cuts, with its rules, and
      // records it beside the per-page cuts (it used to cut silently).
      const cut = scen.slice(room);
      onMessage(globalCapLine(pg.url, scen.length, room, cut));
      for (const c of cut) planTrimmed.push({ pageUrl: pg.url, name: c.name, ruleIds: [...(c.ruleIds ?? [])], cause: 'global-cap' });
      scen = scen.slice(0, room);
    }
    // The same feature + category + intent planned on two pages is one
    // scenario: the copy on the page tagged for its feature wins, else the
    // first in ladder order. The same rules on a later page that does not
    // carry the feature by page evidence is one scenario too, whatever the
    // name overlap (invariant 78). The dropped copy never reaches the plan.
    const cross = dedupeAcrossPages(combined, scen, pg, pageFeatureOf, carriesFeature);
    for (const d of cross.dropped) {
      const keptOn = d.duplicateOf.reachedBy?.pageUrl ?? d.duplicateOf.pageUrl ?? pg.url;
      const droppedOn = d.scenario.reachedBy?.pageUrl ?? d.scenario.pageUrl ?? pg.url;
      onMessage(d.basis.kind === 'evidence'
        ? `Rejected cross-page duplicate: "${d.scenario.name}" on ${droppedOn} (${crossPageBasisText(d.basis)}, as "${d.duplicateOf.name}" kept on ${keptOn})`
        : `Rejected cross-page duplicate: "${d.scenario.name}" on ${droppedOn} (${crossPageBasisText(d.basis)} as the scenario kept on ${keptOn})`);
    }
    combined = cross.existing;
    scen = cross.incoming;
    // Names unique across pages: skip_scenario, verdict matching and the
    // funnel key on the name, so a genuinely different scenario that shares
    // a name with one from another page gets the feature or path appended.
    const unique = uniqueScenarioNames(combined, scen, pg);
    for (const r of unique.renames) {
      onMessage(`Renamed duplicate scenario: "${r.from}" -> "${r.to}" (the same name was planned on another page)`);
    }
    scen = unique.scenarios;
    combined.push(...scen);
    dropped.push(...p.dropped);
    rejected.push(...p.rejected);
    citationDrops.push(...p.citationDrops);
    fillableMax = Math.max(fillableMax, p.fillableFields);
    plannerUsd += p.costUsd;
    const label = t.reachedBy ? `${pg.url} (reached by action from ${t.reachedBy.origin})` : pg.url;
    onMessage(`Planner [${idx + 1}/${targets.length}] ${label}: ${scen.length} scenario(s) · $${p.costUsd.toFixed(4)}`);
  }
  return { combined, dropped, rejected, citationDrops, pageFitRejected, contradictionRejected, plannerUsd, fillableMax, planCapHit, planTrimmed, planSkippedPages };
}

/**
 * Whether a plan target's page carries a feature by PAGE EVIDENCE: an
 * SRS-stated URL tagged with it, a page the state probe revealed for it or
 * reached by action for it (source 'action'), a page the probe found the
 * feature's trigger on (originOf), or a path segment that matches the
 * feature's tokens (pagesCarryingFeature). A tag from the page filter's
 * model pick is never read (standing rule 1). A URL that is no target's
 * page carries nothing.
 */
export function targetEvidence(targets: PlanTarget[], featureTokens?: Record<string, string[]>): CarriesFeature {
  return (url, feature) => {
    const t = targets.find((x) => x.page.url === url);
    if (!t) return false;
    const pg = t.page;
    if ((pg.source === 'srs' || pg.source === 'action') && pg.feature === feature) return true;
    if (t.originOf?.includes(feature)) return true;
    return pagesCarryingFeature([pg], feature, featureTokens).length > 0;
  };
}

/** The console line for a global-cap cut on one page: every cut scenario named with the rules it cited. */
export function globalCapLine(url: string, planned: number, kept: number, cut: Array<{ name: string; ruleIds?: string[] }>): string {
  const named = cut.map((c) => `"${c.name}" (${c.ruleIds && c.ruleIds.length > 0 ? `cited ${c.ruleIds.join(', ')}` : 'cited no rule'})`).join(', ');
  return `Planner: ${url} planned ${planned} scenarios, kept ${kept} under the global cap of ${GLOBAL_PLAN_CAP}; cut: ${named}.`;
}

/** The console line when the global cap leaves pages unplanned: every page named by URL. */
export function globalCapPagesLine(urls: string[]): string {
  return `Planner: global cap of ${GLOBAL_PLAN_CAP} scenarios reached; ${urls.length} page(s) not planned: ${urls.join(', ')}.`;
}

/**
 * Trim one page's plan to the per-page cap. A scenario that is the only one
 * on this page's plan citing some rule is kept first; the rest fill the room
 * left; ties keep the Planner's order, and the kept scenarios stay in the
 * Planner's order. A scenario citing no rule is never kept ahead of a rule's
 * only citer. Exported for the smoke.
 */
export function trimToPageCap<T extends { name: string; ruleIds?: string[] }>(scenarios: T[], cap: number): { kept: T[]; cut: T[] } {
  if (scenarios.length <= cap) return { kept: [...scenarios], cut: [] };
  const citers = new Map<string, number>();
  for (const s of scenarios) for (const id of new Set(s.ruleIds ?? [])) citers.set(id, (citers.get(id) ?? 0) + 1);
  const soleCiter = (s: T): boolean => (s.ruleIds ?? []).some((id) => citers.get(id) === 1);
  const order = scenarios.map((s, i) => ({ s, i }));
  const priority = [...order.filter((x) => soleCiter(x.s)), ...order.filter((x) => !soleCiter(x.s))];
  const keep = new Set(priority.slice(0, cap).map((x) => x.i));
  return {
    kept: order.filter((x) => keep.has(x.i)).map((x) => x.s),
    cut: order.filter((x) => !keep.has(x.i)).map((x) => x.s),
  };
}

/** The console line for a per-page trim: every cut scenario named with the rules it cited. */
export function pageCapLine(url: string, planned: number, cap: number, cut: Array<{ name: string; ruleIds?: string[] }>): string {
  const named = cut.map((c) => `"${c.name}" (${c.ruleIds && c.ruleIds.length > 0 ? `cited ${c.ruleIds.join(', ')}` : 'cited no rule'})`).join(', ');
  return `Planner: ${url} planned ${planned} scenarios, trimmed to the per-page cap of ${cap}; cut: ${named}.`;
}
