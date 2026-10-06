/**
 * The one formatter module (design system, invariant 68). Every number,
 * date and count the dashboard shows passes through here. It formats the
 * values the server sent and never computes one (standing rule 3): no sums,
 * no averages, no defaults. A missing value is rendered as "n/a", never as
 * 0 or $0.00 (standing rule 2). Dates use a fixed en-GB locale so every
 * browser renders the same string. Nothing in this file falls back to zero.
 */

const LOCALE = 'en-GB';

function isMissing(v: unknown): v is null | undefined {
  return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
}

/** Money to 2 decimals: "$6.69". Above 0 and below 0.005 reads "<$0.01". Missing reads "n/a", never "$0.00". */
export function formatMoney(v: number | null | undefined): string {
  if (isMissing(v) || typeof v !== 'number') return 'n/a';
  if (v > 0 && v < 0.005) return '<$0.01';
  return `$${v.toFixed(2)}`;
}

/**
 * The stored value behind a rounded figure, for a tooltip: the number as the
 * API sent it, with floating-point noise beyond 12 significant digits removed
 * (6.091172000000001 reads as $6.091172). Missing reads "not recorded".
 */
export function exactMoney(v: number | null | undefined): string {
  if (isMissing(v) || typeof v !== 'number' || !Number.isFinite(v)) return 'not recorded';
  return `$${String(Number(v.toPrecision(12)))}`;
}

/** "1 test", "12 tests"; a missing count reads "n/a". */
export function formatCount(n: number | null | undefined, singular: string, plural: string): string {
  if (isMissing(n) || typeof n !== 'number') return 'n/a';
  return `${n} ${n === 1 ? singular : plural}`;
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "5 Oct", "5 Oct 2025" in another year, "Today, 14:05" for today (24-hour). Fixed en-GB locale. Missing or invalid reads "n/a". */
export function formatDate(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return 'n/a';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today, ${new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d)}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

/** The full date and time for a tooltip: "5 Oct 2026, 14:05:33" (24-hour, en-GB). Missing or invalid reads "n/a". */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return 'n/a';
  return new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

/** A time of day for an event row: "14:05:33" (24-hour, en-GB). Missing or invalid reads "n/a". */
export function formatTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return 'n/a';
  return new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

/** A ratio the server sent, as a percentage with one decimal: 0.25 reads "25.0%". Missing reads "n/a". */
export function pct(v: number | null | undefined): string {
  if (isMissing(v) || typeof v !== 'number') return 'n/a';
  return `${(v * 100).toFixed(1)}%`;
}

/** The time between two recorded instants: "45s", "3m 27s", "1h 5m". Missing or invalid reads "n/a". */
export function duration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return 'n/a';
  const ms = Date.parse(end) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A byte count as "512 B", "1.5 KB", "2.00 MB". Missing reads "n/a". */
export function formatSize(n: number | null | undefined): string {
  if (isMissing(n) || typeof n !== 'number') return 'n/a';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
