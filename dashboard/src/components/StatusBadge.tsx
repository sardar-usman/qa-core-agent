import { Badge } from '@/components/ui/badge';

const VARIANT: Record<string, 'pass' | 'rework' | 'reject' | 'neutral' | 'accent'> = {
  completed: 'pass', stopped: 'rework', empty: 'reject', failed: 'reject', running: 'accent', legacy: 'neutral',
};
// 'legacy' is a pre-v2 gateway record: the numbers it carried, no report or zip on disk.
const LABEL: Record<string, string> = { completed: 'completed', stopped: 'stopped, checkpoint kept', empty: 'empty', failed: 'failed', running: 'running', legacy: 'summary only (pre-v2)' };

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANT[status] ?? 'neutral'} data-status={status}>{LABEL[status] ?? status}</Badge>;
}
