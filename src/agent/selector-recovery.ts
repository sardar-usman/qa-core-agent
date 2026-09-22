import type { Page } from '@playwright/test';
import { resolve, type ResolvedLocator } from './selectors.js';

/**
 * In-run selector recovery used by the Explorer (tools.ts). This is NOT the
 * healer: healing an existing spec is done by the published qa-core-heal
 * package (see src/cli/heal.ts). Recovery repairs a selector that failed to
 * resolve DURING exploration, before any spec exists. Deterministic: no
 * model call.
 */

/** The selector hints the model gives when asking for an element. */
export type ResolveInput = { intent: string; role?: string; label?: string; testid?: string; css?: string; text?: string };

/**
 * Re-resolve a failed selector against the live page using the SAME locator
 * ladder, but by the semantic intent only (the brittle hint that failed is
 * dropped). Polls briefly so a slow element still gets a second chance. Returns
 * the recovered locator, or null when the element truly is not there.
 */
export async function recoverResolve(
  page: Page,
  input: ResolveInput,
): Promise<ResolvedLocator | null> {
  const relaxed: ResolveInput = { intent: input.intent };
  let r = namedOnly(await resolve(page, relaxed));
  for (let i = 0; i < 3 && !r; i++) {
    await new Promise((res) => setTimeout(res, 200));
    r = namedOnly(await resolve(page, relaxed));
  }
  return r;
}

/**
 * Recovery accepts only NAMED matches. By intent alone the cascade may end
 * on the nameless fallback of a guessed role (the page's one button for a
 * "submit button" intent). For the model's own resolve that is a fair last
 * resort; for a recovery it would swap the element the model asked for with
 * whatever shares its role, and a recovery to the wrong element is worse
 * than no recovery. A nameless role match therefore counts as not found.
 */
function namedOnly(r: ResolvedLocator | null): ResolvedLocator | null {
  if (!r) return null;
  if (r.level === 'role' && typeof r.arg === 'object' && r.arg !== null && !('name' in r.arg)) return null;
  return r;
}
