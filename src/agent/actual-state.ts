import type { Page } from 'playwright';

/**
 * Reads what the page actually did, for a finding: the current URL plus any
 * visible alert / validation / toast / status text. This is the honest record
 * of "the expected outcome did not occur, here is what happened instead".
 * Shared by the Explorer (a finding at the retry cap, tools.ts) and by replay
 * and stability (an assertion that fails on a re-run, replay.ts), so both
 * record the same reading of the page.
 */
export async function captureActualState(page: Page): Promise<{ url: string; messages: string[] }> {
  const url = page.url();
  const messages = await page
    .evaluate(() => {
      // Every helper is a function declaration, never a const arrow, so tsx's
      // __name wrapper is not injected into the serialized body. See summarizeDom.
      const selectors = [
        '[role="alert"]', '[role="status"]', '[aria-live]',
        '.alert', '.error', '.invalid-feedback', '.field-error',
        '.toast', '.notification', '.help-block', '.text-danger',
      ];
      function isShown(el: Element): boolean {
        const e = el as HTMLElement;
        const r = e.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(e);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
      }
      const out: string[] = [];
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i] as HTMLElement;
          if (!isShown(el)) continue;
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (text && out.indexOf(text) === -1) out.push(text.slice(0, 160));
          if (out.length >= 8) return out;
        }
      }
      return out;
    })
    .catch(() => [] as string[]);
  return { url, messages };
}
