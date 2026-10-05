import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, FINDING_STATUSES, type FindingRow, type ProjectCard } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { FindingsHeading, FindingsTable, LocatorFailuresSection } from '@/components/FindingsTable';

/** Every deduped finding across projects, filterable by project and status. */
export function FindingsPage({ refreshKey }: { refreshKey: number }) {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project_id') ?? '';
  const status = params.get('status') ?? '';
  const [findings, setFindings] = useState<FindingRow[] | null>(null);
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Product behavior by default; the elements the agent could not find are behind a counted toggle (invariant 67).
  const [showLocator, setShowLocator] = useState(false);
  const productFindings = (findings ?? []).filter((f) => f.kind === 'product');
  const locatorFindings = (findings ?? []).filter((f) => f.kind === 'locator');

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
    <div className="flex flex-col gap-6" data-testid="findings-page">
      <PageHeader title="To review" description="Every deduped finding across projects, with the runs that saw it. Status and notes are yours to set and survive every re-index." />
      <FindingsHeading count={productFindings.length} />
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
        <>
          <FindingsTable findings={productFindings} onChange={(u) => setFindings((cur) => (cur ?? []).map((f) => (f.id === u.id ? u : f)))} />
          <div>
            <button type="button" className="rounded-sm text-s text-fg-2 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setShowLocator((v) => !v)} aria-expanded={showLocator} data-testid="locator-toggle">
              {showLocator ? 'Hide elements not found' : 'Show elements not found'} (<span className="tabular-nums" data-testid="locator-toggle-count">{locatorFindings.length}</span>)
            </button>
          </div>
          {showLocator ? <LocatorFailuresSection findings={locatorFindings} open /> : null}
        </>
      )}
    </div>
  );
}
