import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type RunRow } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/StatusBadge';
import { EmptyState } from '@/components/EmptyState';
import { fmtDate, money } from '@/lib/utils';

/** PR A placeholder. PR B ports the six-stage run view here. */
export function RunPlaceholderPage() {
  const { id = '' } = useParams();
  const [run, setRun] = useState<RunRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.run(id).then(setRun).catch((e: Error) => setError(e.message)); }, [id]);
  if (error) return <EmptyState title="Run not found">{error}</EmptyState>;
  if (!run) return <div className="text-s text-fg-3">Loading…</div>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-m font-semibold">{run.project_name ?? run.project_id}</h1>
        <StatusBadge status={run.status} />
        <span className="mono text-s text-fg-3">{run.id}</span>
      </div>
      <dl className="grid gap-3 sm:grid-cols-4">
        {[[run.status === 'legacy' ? 'shipped' : 'shipped / planned', run.status === 'legacy' ? String(run.shipped) : `${run.shipped}/${run.planned}`], ['total cost', money(run.cost_total, 4)], ['started', fmtDate(run.started_at)], ['source', run.source]].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-line bg-bg-1 p-3"><dd className="text-l font-semibold">{v}</dd><dt className="mt-1 text-s text-fg-2">{k}</dt></div>
        ))}
      </dl>
      {run.status === 'legacy' ? (
        <EmptyState title="Summary only (pre-v2)">
          This run predates the per-run output layout. Only the numbers the gateway recorded at the time exist: scenarios shipped, cost, duration and model. There is no report or framework zip to open.
        </EmptyState>
      ) : (
        <EmptyState title="Run detail arrives in PR B">
          The six-stage view (Discovery, Plan, Explore, Review, Verify, Summary) is ported next. Until then the report is served at <code className="mono">{`/api/runs/${run.id}/report`}</code>.
        </EmptyState>
      )}
      <div className="flex gap-2">
        {run.zip_path && run.status !== 'legacy' ? <Button asChild><a href={api.zipUrl(run.id)}>Download framework zip</a></Button> : null}
        <Button variant="outline" asChild><Link to="/runs">Back to runs</Link></Button>
      </div>
    </div>
  );
}
