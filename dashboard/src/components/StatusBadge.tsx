import { Badge } from '@/components/ui/badge';

const VARIANT: Record<string, 'pass' | 'rework' | 'reject' | 'neutral' | 'accent'> = {
  completed: 'pass', stopped: 'rework', empty: 'reject', failed: 'reject', running: 'accent',
};
const LABEL: Record<string, string> = { completed: 'completed', stopped: 'stopped, checkpoint kept', empty: 'empty', failed: 'failed', running: 'running' };

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANT[status] ?? 'neutral'} data-status={status}>{LABEL[status] ?? status}</Badge>;
}
