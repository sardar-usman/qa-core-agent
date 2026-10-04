import { Badge } from '@/components/ui/badge';
import { TermTip } from '@/components/Term';
import type { GlossaryKey } from '@/lib/glossary';

const VARIANT: Record<string, 'pass' | 'rework' | 'reject' | 'neutral' | 'accent'> = {
  completed: 'pass', stopped: 'rework', empty: 'reject', failed: 'reject', running: 'accent', legacy: 'neutral',
};
// 'legacy' is a pre-v2 gateway record: the numbers it carried, no report or zip on disk.
const LABEL: Record<string, string> = { completed: 'completed', stopped: 'stopped, checkpoint kept', empty: 'empty', failed: 'failed', running: 'running', legacy: 'summary only (pre-v2)' };
/** Each status value the index can hold, mapped to its glossary entry (the key type makes a missing entry a compile error). */
const STATUS_TERM: Record<string, GlossaryKey> = {
  completed: 'statusCompleted', stopped: 'statusStopped', empty: 'statusEmpty', failed: 'statusFailed', running: 'statusRunning', legacy: 'legacy',
};

/** A run status as a badge in its semantic colour, with the status's glossary entry as its tooltip. */
export function StatusBadge({ status }: { status: string }) {
  const badge = <Badge tabIndex={0} variant={VARIANT[status] ?? 'neutral'} data-status={status}>{LABEL[status] ?? status}</Badge>;
  const term = STATUS_TERM[status];
  return term ? <TermTip term={term}>{badge}</TermTip> : badge;
}
