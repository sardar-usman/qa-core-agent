import { Badge } from '@/components/ui/badge';
import { TermTip } from '@/components/Term';
import type { GlossaryKey } from '@/lib/glossary';

/** The one status-to-colour mapping; the badge, the card status line and anything else that colours a status read it. */
export const VARIANT: Record<string, 'pass' | 'rework' | 'reject' | 'neutral' | 'accent'> = {
  completed: 'pass', stopped: 'rework', empty: 'reject', failed: 'reject', running: 'accent', legacy: 'neutral',
};
// 'legacy' is a pre-v2 gateway record: the numbers it carried, no report or zip on disk.
/** The one status-to-word mapping, shared with the card status line. */
export const LABEL: Record<string, string> = { completed: 'completed', stopped: 'stopped, checkpoint kept', empty: 'empty', failed: 'failed', running: 'running', legacy: 'summary only (pre-v2)' };
/** Each status value the index can hold, mapped to its glossary entry (the key type makes a missing entry a compile error). */
export const STATUS_TERM: Record<string, GlossaryKey> = {
  completed: 'statusCompleted', stopped: 'statusStopped', empty: 'statusEmpty', failed: 'statusFailed', running: 'statusRunning', legacy: 'legacy',
};
/** The variant's text and dot colour classes (presentation only; the status mapping above decides the variant). */
const VARIANT_TEXT: Record<string, string> = { pass: 'text-pass', rework: 'text-rework', reject: 'text-reject', neutral: 'text-neutral', accent: 'text-accent' };
const VARIANT_DOT: Record<string, string> = { pass: 'bg-pass', rework: 'bg-rework', reject: 'bg-reject', neutral: 'bg-neutral', accent: 'bg-accent' };

/** A run status as a badge in its semantic colour, with the status's glossary entry as its tooltip. */
export function StatusBadge({ status }: { status: string }) {
  const badge = <Badge tabIndex={0} variant={VARIANT[status] ?? 'neutral'} data-status={status}>{LABEL[status] ?? status}</Badge>;
  const term = STATUS_TERM[status];
  return term ? <TermTip term={term}>{badge}</TermTip> : badge;
}

/**
 * A run status as a coloured dot and the status word, for a card's
 * "Last run <word> · <date>" line. Same VARIANT and LABEL as the badge,
 * same glossary tooltip; no mapping of its own.
 */
export function StatusWord({ status, className, prefix }: { status: string; className?: string; prefix?: string }) {
  const variant = VARIANT[status] ?? 'neutral';
  const word = <span tabIndex={0} data-status={status} className={`${VARIANT_TEXT[variant]} rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${className ?? ''}`}>{LABEL[status] ?? status}</span>;
  const term = STATUS_TERM[status];
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${VARIANT_DOT[variant]}`} data-testid="status-dot" data-variant={variant} />
      {prefix ? <span>{prefix}</span> : null}
      {term ? <TermTip term={term}>{word}</TermTip> : word}
    </span>
  );
}
