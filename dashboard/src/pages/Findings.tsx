import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, FINDING_STATUSES, type FindingRow, type ProjectCard } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { FindingsHeading, FindingsTable } from '@/components/FindingsTable';

/** Every deduped finding across projects, filterable by project and status. */
export function FindingsPage({ refreshKey }: { refreshKey: number }) {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project_id') ?? '';
  const status = params.get('status') ?? '';
  const [findings, setFindings] = useState<FindingRow[] | null>(null);
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.findings({ project_id: projectId || undefined, status: status || undefined }), api.projects()])
      .then(([f, p]) => { if (live) { setFindings(f); setProjects(p); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError && e.status === 401 ? 'Unauthorized: add #token=<QA_CORE_GATEWAY_TOKEN> to the URL.' : (e as Error).message); });
    return () => { live = false; };
  }, [projectId, status, refreshKey]);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="findings-page">
      <FindingsHeading count={findings?.length ?? 0} />
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
            {FINDING_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      {error ? <EmptyState title="Could not load findings">{error}</EmptyState> : findings === null ? <div className="text-s text-fg-2">Loading…</div> : (
        <FindingsTable findings={findings} onChange={(u) => setFindings((cur) => (cur ?? []).map((f) => (f.id === u.id ? u : f)))} />
      )}
    </div>
  );
}
