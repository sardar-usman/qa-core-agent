import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge with this project's type scale registered as font sizes.
 * Without it the merger cannot tell `text-s` (a size) from `text-brand-fg`
 * (a colour), treats them as one conflicting group and drops the colour, so
 * a brand button rendered body-coloured text (dark on mint, 1.5:1 in dark).
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['xs', 's', 'm', 'section', 'title', 'l', 'xl'] }] } },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function money(v: number | null | undefined, digits = 2): string {
  return `$${Number(v ?? 0).toFixed(digits)}`;
}

/** The one currency formatter for the run detail page and the stage view: always 4 decimals, so 0.66823075 renders as $0.6682, never $0.66. */
export function usd(v: number | null | undefined): string {
  return money(v, 4);
}

/**
 * The stored value behind a rounded figure, for a tooltip: the number as the
 * API sent it, with floating-point noise beyond 12 significant digits removed
 * (6.091172000000001 reads as $6.091172). Not a rounding of the stored decimals.
 */
export function exactMoney(v: number | null | undefined): string {
  const n = Number(v ?? 0);
  return `$${Number.isFinite(n) ? String(Number(n.toPrecision(12))) : '0'}`;
}

export function pct(v: number | null | undefined): string {
  return v == null ? '–' : `${(v * 100).toFixed(1)}%`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function duration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '–';
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
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
