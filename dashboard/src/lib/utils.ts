import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge with this project's type scale registered as font sizes.
 * Without it the merger cannot tell `text-body` (a size) from `text-brand-fg`
 * (a colour), treats them as one conflicting group and drops the colour, so
 * a brand button rendered body-coloured text (dark on mint, 1.5:1 in dark).
 * The seven names are the whole scale (design system, invariant 68).
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['display', 'title', 'heading', 'subheading', 'body', 'small', 'caption'] }] } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** The path and query of a URL, for a column whose host is already known; the full URL stays in the tooltip. */
export function pathOf(url: string | null | undefined): string {
  if (!url) return '';
  try { const u = new URL(url); return `${u.pathname}${u.search}` || '/'; } catch { return url; }
}

export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try { return new URL(url).host; } catch { return url; }
}
