import type { DiscoveredPage, ReachAction } from './discovery.js';
import { crossPageBasisText, dedupeAcrossPages, pageFitRejectionLine, uniqueScenarioNames, type PageSnapshot, type PlannedScenario, type PlanResult, type RuleRetry } from './planner.js';
import type { RequirementsMap } from './requirements.js';
import type { RevealedFeature } from './state-probe.js';

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
 */
export function buildPlanTargets(opts: {
  pages: DiscoveredPage[];
  map?: RequirementsMap;
  features?: string[];
  revealed?: RevealedFeature[];
  /** Every crawl candidate, to find an origin the filter did not keep. */
  candidates?: DiscoveredPage[];
}): { targets: PlanTarget[]; pages: DiscoveredPage[] } {
  const revealed = opts.revealed ?? [];
  const originRules = new Map(revealed.map((r) => [r.feature, new Set(r.originRuleIds)]));
  const revealedTarget = (r: RevealedFeature): PlanTarget => {
    const feature = opts.map?.features.find((f) => f.name === r.feature);
    const keep = new Set(r.revealedRuleIds);
    return {
      page: r.page,
      ...(opts.map && feature ? { requirements: { ...opts.map, features: [{ ...feature, rules: feature.rules.filter((x) => keep.has(x.id)) }] } } : {}),
      features: [r.feature],
      snapshot: r.snapshot,
      reachedBy: { origin: r.page.reachedBy.origin, actions: r.page.reachedBy.actions },
    };
  };
  const targets: PlanTarget[] = [];
  const pages: DiscoveredPage[] = [...opts.pages];
  const placed = new Set<string>();
  for (const pg of opts.pages) {
    let requirements = narrowRules(subMapFor(opts.map, pg.feature), originRules);
    let features = pg.feature ? [pg.feature] : opts.features;
    const here = revealed.filter((r) => pageKey(r.page.reachedBy.origin) === pageKey(pg.url));
    for (const r of here) {
      // The origin's call carries the feature's origin rules even when the
      // page is tagged with another feature.
      if (requirements && opts.map && !requirements.features.some((f) => f.name === r.feature)) {
        const f = opts.map.features.find((x) => x.name === r.feature);
        if (f) requirements = { ...requirements, features: [...requirements.features, { ...f, rules: f.rules.filter((x) => originRules.get(r.feature)!.has(x.id)) }] };
        if (features && !features.includes(r.feature)) features = [...features, r.feature];
      }
    }
    targets.push({ page: pg, ...(requirements ? { requirements } : {}), ...(features ? { features } : {}), ...(pg.volatile ? { volatile: true } : {}) });
    for (const r of here) {
      targets.push(revealedTarget(r));
      pages.push(r.page);
      placed.add(r.feature);
    }
  }
  for (const r of revealed) {
    if (placed.has(r.feature)) continue;
    // The filter did not keep the origin: plan it for the feature's origin
    // rules (when there are any), then the revealed page.
    const origin = r.page.reachedBy.origin;
    const f = opts.map?.features.find((x) => x.name === r.feature);
    if (f && r.originRuleIds.length > 0) {
      const known = opts.candidates?.find((c) => pageKey(c.url) === pageKey(origin));
      const page: DiscoveredPage = { ...(known ?? { url: origin, source: 'crawl' as const }), feature: r.feature };
      targets.push({ page, requirements: { ...opts.map!, features: [{ ...f, rules: f.rules.filter((x) => originRules.get(r.feature)!.has(x.id)) }] }, features: [r.feature] });
      pages.push(page);
    }
    targets.push(revealedTarget(r));
    pages.push(r.page);
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
  const pageFeatureOf = (url: string | undefined): string | undefined => targets.find((t) => t.page.url === url)?.page.feature;
  for (const [idx, t] of targets.entries()) {
    const pg = t.page;
    if (combined.length >= GLOBAL_PLAN_CAP) {
      planCapHit = true;
      onMessage(`Planner: global cap of ${GLOBAL_PLAN_CAP} scenarios reached; ${targets.length - idx} page(s) not planned.`);
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
      onMessage(`Planner: ${pg.url} planned ${scen.length} scenarios, trimmed to the per-page cap of ${PER_PAGE_SCENARIO_CAP}.`);
      scen = scen.slice(0, PER_PAGE_SCENARIO_CAP);
    }
    const room = GLOBAL_PLAN_CAP - combined.length;
    if (scen.length > room) { planCapHit = true; scen = scen.slice(0, room); }
    // The same feature + category + intent planned on two pages is one
    // scenario: the copy on the page tagged for its feature wins, else the
    // first in ladder order. The dropped copy never reaches the plan.
    const cross = dedupeAcrossPages(combined, scen, pg, pageFeatureOf);
    for (const d of cross.dropped) {
      const keptOn = d.duplicateOf.reachedBy?.pageUrl ?? d.duplicateOf.pageUrl ?? pg.url;
      const droppedOn = d.scenario.reachedBy?.pageUrl ?? d.scenario.pageUrl ?? pg.url;
      onMessage(`Rejected cross-page duplicate: "${d.scenario.name}" on ${droppedOn} (${crossPageBasisText(d.basis)} as the scenario kept on ${keptOn})`);
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
  return { combined, dropped, rejected, citationDrops, pageFitRejected, contradictionRejected, plannerUsd, fillableMax, planCapHit };
}
