import type { Locator } from '@playwright/test';
import type { TraceStep } from './trace.js';

/**
 * The all-items assertion (invariant 77, run 59540f D5).
 *
 * Run 7 shipped "[happy] search for term filtered list to only matching
 * product names" whose recording checked the FIRST card only; the name
 * claims every card. The all-items form says "every item of <list> matches
 * <pattern>, and there is at least 1 item", and both facts come from ONE
 * read of the whole list (allTextContents), polled until that one read
 * holds. The PR #55 review reproduced a false pass with the first form, two
 * checks read at different moments (no item fails to match, then at least
 * 1 item): a list that clears while new results load passed the filter
 * check on the empty in-between list and the minimum on the new list, which
 * no check examined. Reading the minimum first fails the other way (it
 * passes on the old list, then the filter on the empty one).
 *
 * Every place decides through this module: the tool and replay poll with
 * pollAllItems, and both emitters write allItemsPollLine, one expect.poll
 * whose failure prints the real list.
 *
 * RULE 7 still applies: the pattern is a value this scenario typed earlier
 * (a fill, or a search term in a navigate URL), compared case-insensitively
 * after escaping, never a literal the model wrote. The tool records the
 * escaped typed value with the 'i' flag, so the recorded pattern is the typed
 * value and nothing else.
 */

/** Flags every all-items pattern carries: case-insensitive, never g (RegExp.test with g is stateful). */
export const ALL_ITEMS_FLAGS = 'i';

/** Throws unless the flags are exactly 'i': a g flag makes RegExp.test remember lastIndex between items. */
export function assertAllItemsFlags(flags: string): void {
  if (flags !== ALL_ITEMS_FLAGS) throw new Error(`allItemsMatch flags must be exactly "${ALL_ITEMS_FLAGS}", got ${JSON.stringify(flags)}`);
}

/** What the emitted poll returns when the one read holds. */
export const ALL_ITEMS_HOLD = 'every item matches';

/**
 * An item's text, whitespace normalized the way Playwright normalizes text
 * for hasText: zero-width spaces and soft hyphens removed, trimmed, runs of
 * whitespace collapsed to one space. The emitted line repeats this exactly.
 */
export function normalizeItemText(text: string): string {
  return text.replace(/[\u200b\u00ad]/g, '').trim().replace(/\s+/g, ' ');
}

/** One read of the list: how many items, and the normalized texts that do not match. */
export interface AllItemsSnapshot {
  items: number;
  notMatching: string[];
}

/** The snapshot of one read of every item's text. */
export function allItemsSnapshot(texts: string[], re: RegExp): AllItemsSnapshot {
  const norm = texts.map(normalizeItemText);
  return { items: norm.length, notMatching: norm.filter((t) => !re.test(t)) };
}

/** The check holds on one read only: at least 1 item and every text matches. */
export function allItemsHold(s: AllItemsSnapshot): boolean {
  return s.items >= 1 && s.notMatching.length === 0;
}

/**
 * Poll ONE read of every item's text until that read holds or the time runs
 * out. Both facts (at least 1 item, every item matches) are judged on the
 * same read, so a list that clears while loading can never pass on two
 * different moments. Returns the last read either way (null when no read
 * succeeded). Used by the tool's live check and by replay.
 */
export async function pollAllItems(items: Pick<Locator, 'allTextContents'>, re: RegExp, timeoutMs: number): Promise<{ held: boolean; last: AllItemsSnapshot | null }> {
  assertAllItemsFlags(re.flags);
  const deadline = Date.now() + timeoutMs;
  let last: AllItemsSnapshot | null = null;
  for (;;) {
    try {
      last = allItemsSnapshot(await items.allTextContents(), re);
      if (allItemsHold(last)) return { held: true, last };
    } catch {
      // The page is between documents (a navigation): the next read decides.
    }
    if (Date.now() >= deadline) return { held: false, last };
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * The emitted check, both emitters and both languages: one expect.poll that
 * reads every item's text once per poll, normalizes it as normalizeItemText
 * does, and returns ALL_ITEMS_HOLD only when that read holds at least 1 item
 * and every text matches; otherwise the read itself (item count and the
 * texts that do not match), so a failure prints the real list. `items` is the
 * multi-match locator expression, `reLiteral` the pattern as a RegExp literal.
 */
export function allItemsPollLine(items: string, reLiteral: string, flags: string, timeoutMs: number): string {
  assertAllItemsFlags(flags);
  return `await expect.poll(async () => { const texts = (await ${items}.allTextContents()).map((t) => t.replace(/[\\u200b\\u00ad]/g, '').trim().replace(/\\s+/g, ' ')); const bad = texts.filter((t) => !${reLiteral}.test(t)); return texts.length >= 1 && bad.length === 0 ? ${JSON.stringify(ALL_ITEMS_HOLD)} : JSON.stringify({ items: texts.length, notMatching: bad }); }, { timeout: ${timeoutMs} }).toBe(${JSON.stringify(ALL_ITEMS_HOLD)}); // one read: at least 1 item and every item matches ${reLiteral}`;
}

/** Escape a typed value for a RegExp source (the escape selectors.escapeRegex applies). */
export function escapeForPattern(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The values a scenario typed before this point, latest last: every fill
 * value (a credential-marked fill and a generated fill excluded: the first
 * is never recorded, the second changes on every run, so the emitted pattern
 * could not match it), and every query parameter value of a navigate URL (a
 * search term the scenario opened the page with). Empty values are skipped.
 */
export function typedValues(priorSteps: TraceStep[]): string[] {
  const out: string[] = [];
  for (const s of priorSteps) {
    if (s.kind === 'fill') {
      if (s.credential || s.generate) continue;
      if (s.value.trim()) out.push(s.value.trim());
    } else if (s.kind === 'navigate') {
      let params: URLSearchParams | null = null;
      // A navigate url that does not parse carries no query values; nothing
      // typed is the honest reading, and the assertion is then refused.
      try { params = new URL(s.url).searchParams; } catch { params = null; }
      for (const v of params?.values() ?? []) if (v.trim()) out.push(v.trim());
    }
  }
  return out;
}

/**
 * The typed value an all-items pattern names, or null: the latest typed value
 * whose escaped form equals the pattern case-insensitively.
 */
export function typedValueForPattern(pattern: string, priorSteps: TraceStep[]): string | null {
  const want = pattern.toLowerCase();
  const typed = typedValues(priorSteps);
  for (let i = typed.length - 1; i >= 0; i--) {
    if (escapeForPattern(typed[i]!).toLowerCase() === want) return typed[i]!;
  }
  return null;
}
