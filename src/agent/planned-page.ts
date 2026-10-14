/**
 * Planned-page integrity (invariant 65).
 *
 * Run 44cb3d (run 6) found /rentals empty, recorded the planned rental
 * scenario on /category/hand-tools instead, and shipped it under the rental
 * name with no finding; the repair pass re-recorded it without visiting
 * /rentals. Nothing compared where a scenario was recorded with where it was
 * planned. This module is that comparison, pure and browser-free, so
 * end_scenario (tools.ts) and the offline false-positive check can share it.
 *
 * The rule: for a plan entry with a pageUrl and volatilePage not true, the
 * trace must contain at least one navigate step to the planned page, and every
 * navigate step must target the planned page. Same page means same origin and
 * same path, trailing slash ignored, query and hash ignored. Pages reached by
 * click are never checked; only navigate steps are. A plan entry with no
 * pageUrl (single-page run) and a volatile planned page are exempt.
 *
 * A page that exists only after an action (invariant 71) is never navigated
 * to by URL: for every scenario of a feature with a revealed page, a
 * navigate step to that page is refused ('navigated-to-reached-page') with
 * no exemption, the volatile and no-pageUrl exemptions included.
 */
import type { TraceStep } from './trace.js';

export interface PlannedPageEntry {
  pageUrl?: string;
  volatilePage?: boolean;
  /** The revealed page of the scenario's feature (invariant 71): reached by action, never navigated to. */
  reachedPageUrl?: string;
}

export interface PlannedPageViolation {
  /**
   * 'navigated-elsewhere': a navigate step left the planned page. 'never-navigated': no navigate step reached it.
   * 'navigated-to-reached-page': a navigate step opened the feature's revealed page, which is reached by action only.
   */
  kind: 'navigated-elsewhere' | 'never-navigated' | 'navigated-to-reached-page';
  /** The planned page, normalized (origin dropped when it matches the offending page's origin). */
  plannedPath: string;
  /** The first navigate target that is not the planned page; absent when the trace holds no navigate step at all. */
  offendingPath?: string;
  /** One sentence naming both paths. */
  message: string;
}

/** origin + pathname, trailing slash dropped, query and hash dropped; null when the URL does not parse. */
function normalizePage(url: string): { origin: string; path: string } | null {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return { origin: u.origin, path };
  } catch {
    return null;
  }
}

/** True when both URLs name the same page: same origin and same path, trailing slash, query and hash ignored. */
export function samePage(a: string, b: string): boolean {
  const na = normalizePage(a);
  const nb = normalizePage(b);
  if (!na || !nb) return false;
  return na.origin === nb.origin && na.path === nb.path;
}

/** The page as a human reads it in a refusal: the path, with the origin only when it differs from `relativeTo`. */
function describePage(url: string, relativeTo?: string): string {
  const n = normalizePage(url);
  if (!n) return url;
  const other = relativeTo ? normalizePage(relativeTo) : null;
  return other && other.origin !== n.origin ? `${n.origin}${n.path}` : n.path;
}

/**
 * Null when the recorded steps honor the plan entry's page, else a violation
 * naming the planned path and the offending path. Exempt (always null): no
 * plan entry, no pageUrl, or volatilePage true (a generated-id page is
 * reached by clicking through from a listing, so its trace legitimately
 * navigates elsewhere; a known gap, stated in the invariant).
 */
export function plannedPageViolation(steps: TraceStep[], planEntry: PlannedPageEntry | undefined): PlannedPageViolation | null {
  const navigates = steps.filter((s): s is Extract<TraceStep, { kind: 'navigate' }> => s.kind === 'navigate');
  // A revealed page is reached by action, never by its URL; no exemption.
  const reached = planEntry?.reachedPageUrl;
  if (reached) {
    const opened = navigates.find((s) => samePage(s.url, reached));
    if (opened) {
      const plannedPath = planEntry?.pageUrl ? describePage(planEntry.pageUrl, opened.url) : describePage(reached);
      const offendingPath = describePage(opened.url, planEntry?.pageUrl);
      return {
        kind: 'navigated-to-reached-page',
        plannedPath,
        offendingPath,
        message: `planned on ${plannedPath}, but the trace navigated to ${offendingPath}, a page that is reached by action from ${plannedPath} and never by its URL`,
      };
    }
  }
  if (!planEntry?.pageUrl || planEntry.volatilePage) return null;
  const planned = planEntry.pageUrl;
  const elsewhere = navigates.find((s) => !samePage(s.url, planned));
  if (elsewhere) {
    const plannedPath = describePage(planned, elsewhere.url);
    const offendingPath = describePage(elsewhere.url, planned);
    return {
      kind: 'navigated-elsewhere',
      plannedPath,
      offendingPath,
      message: `planned on ${plannedPath}, but the trace navigated to ${offendingPath}`,
    };
  }
  if (navigates.length === 0) {
    const plannedPath = describePage(planned);
    return {
      kind: 'never-navigated',
      plannedPath,
      message: `planned on ${plannedPath}, but the trace never navigated to it (no navigate step recorded)`,
    };
  }
  return null;
}

/**
 * The end_scenario refusal text: the violation plus the three ways out, in
 * order. Restart on the planned page; assert the expectation on the planned
 * page so a real absence becomes a finding through the assertion retry cap;
 * skip with a concrete reason only when the scenario cannot be expressed on
 * that page at all.
 */
export function plannedPageRefusal(scenario: string, v: PlannedPageViolation, attempt: number, cap: number): string {
  const page = v.plannedPath;
  return (
    `Planned-page violation (attempt ${attempt}/${cap}): "${scenario}" was ${v.message}. ` +
    `A scenario is recorded on its planned page; it may reach other pages by clicking, never by navigating away. ` +
    (v.kind === 'navigated-to-reached-page'
      ? `${v.offendingPath} exists only after an action: open ${page}, then reach ${v.offendingPath} by the clicks the plan names. `
      : '') +
    `The trace is abandoned. Three ways out, in this order: ` +
    `(1) restart with begin_scenario and record the scenario on ${page}; ` +
    `(2) if ${page} does not show what the scenario expects, assert that expectation on ${page} anyway, ` +
    `because the assertion retry cap records a real absence as a finding; ` +
    `(3) use skip_scenario with a concrete reason only when the scenario cannot be expressed on ${page} at all.`
  );
}

/** The brokenByGate reason on the second violation of the same planned scenario. */
export function plannedPageBrokenReason(v: PlannedPageViolation): string {
  return `planned-page violation: ${v.message}; a scenario is recorded on its planned page or refused`;
}
