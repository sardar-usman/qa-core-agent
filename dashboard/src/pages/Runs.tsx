import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ListChecks } from 'lucide-react';
import { api, ApiError, type ProjectCard, type RunRow } from '@/lib/api';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { duration, fmtDate, money, pct } from '@/lib/utils';

const STATUSES = ['completed', 'stopped', 'empty', 'failed', 'running'];

export function RunsPage({ refreshKey }: { refreshKey: number }) {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project_id') ?? '';
  const status = params.get('status') ?? '';
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.runs({ project_id: projectId || undefined, status: status || undefined, limit: 200 }), api.projects()])
      .then(([r, p]) => { if (live) { setRuns(r); setProjects(p); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError && e.status === 401 ? 'Unauthorized: add #token=<QA_CORE_GATEWAY_TOKEN> to the URL.' : (e as Error).message); });
    return () => { live = false; };
  }, [projectId, status, refreshKey]);

  const projectName = useMemo(() => projects.find((p) => p.id === projectId)?.name, [projects, projectId]);
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-s text-fg-2">Project
          <select className="h-8 rounded-md border border-line-strong bg-bg-2 px-2 text-s text-fg" value={projectId} onChange={(e) => setFilter('project_id', e.target.value)} data-testid="filter-project">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-s text-fg-2">Status
          <select className="h-8 rounded-md border border-line-strong bg-bg-2 px-2 text-s text-fg" value={status} onChange={(e) => setFilter('status', e.target.value)} data-testid="filter-status">
            <option value="">Any</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <span className="ml-auto text-s text-fg-3" data-testid="runs-count">{runs ? `${runs.length} run${runs.length === 1 ? '' : 's'}${projectName ? ` in ${projectName}` : ''}` : ''}</span>
      </div>
      {error ? <EmptyState title="Could not load runs">{error}</EmptyState> : runs === null ? <div className="text-s text-fg-3">Loading…</div> : runs.length === 0 ? (
        <EmptyState title={projectId || status ? 'No runs match these filters' : 'No runs yet'} icon={<ListChecks className="h-8 w-8" />}>
          {projectId || status ? 'Clear a filter to see more.' : <>Every finished run lands here from output/. Start one with <code className="mono">npm run explore -- &lt;url&gt;</code>.</>}
        </EmptyState>
      ) : (
        <Table data-testid="runs-table">
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Project</TableHead>
              <TableHead className="text-right">Shipped / planned</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Flake rate</TableHead>
              <TableHead className="text-right">Duration</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id} className="cursor-pointer" data-testid="run-row" data-run-id={r.id}>
                <TableCell><Link to={`/runs/${encodeURIComponent(r.id)}`} className="block"><StatusBadge status={r.status} /></Link></TableCell>
                <TableCell><Link to={`/runs/${encodeURIComponent(r.id)}`} className="block"><div className="font-semibold">{r.project_name ?? r.project_id}</div><div className="mono truncate text-s text-fg-3" title={r.url ?? ''}>{r.url}</div></Link></TableCell>
                <TableCell className="text-right"><Link to={`/runs/${encodeURIComponent(r.id)}`} className="block"><span className="mono" data-testid="shipped-planned">{r.shipped}/{r.planned}</span></Link></TableCell>
                <TableCell className="text-right"><Link to={`/runs/${encodeURIComponent(r.id)}`} className="block money text-cost" data-testid="cost">{money(r.cost_total, 4)}</Link></TableCell>
                <TableCell className="text-right"><Link to={`/runs/${encodeURIComponent(r.id)}`} className={`block mono ${r.flake_rate ? 'text-rework' : 'text-fg-2'}`}>{pct(r.flake_rate)}</Link></TableCell>
                <TableCell className="text-right"><Link to={`/runs/${encodeURIComponent(r.id)}`} className="block mono text-fg-2">{duration(r.started_at, r.ended_at)}</Link></TableCell>
                <TableCell><Link to={`/runs/${encodeURIComponent(r.id)}`} className="block text-fg-2">{r.source}</Link></TableCell>
                <TableCell><Link to={`/runs/${encodeURIComponent(r.id)}`} className="block text-fg-2" title={r.started_at ?? ''}>{fmtDate(r.started_at)}</Link></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
