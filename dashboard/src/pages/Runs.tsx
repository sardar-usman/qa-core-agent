import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ListChecks } from 'lucide-react';
import { api, ApiError, type ProjectCard, type RunRow } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { TableSkeleton } from '@/components/Skeleton';
import { RunsTable } from '@/components/RunsTable';
import { Term } from '@/components/Term';
import { formatCount } from '@/lib/format';

const STATUSES = ['completed', 'stopped', 'empty', 'failed', 'running', 'legacy'];

/**
 * Runs: every run the index knows, newest first, filterable by project and
 * status. Pre-v2 summaries are hidden behind a visible toggle (off by
 * default) while the total count stays on screen, so nothing disappears
 * without a number. Choosing the "legacy" status filter shows them too.
 */
export function RunsPage({ refreshKey }: { refreshKey: number }) {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project_id') ?? '';
  const status = params.get('status') ?? '';
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [projects, setProjects] = useState<ProjectCard[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showLegacy, setShowLegacy] = useState(false);

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

  const legacyCount = runs ? runs.filter((r) => r.status === 'legacy').length : 0;
  const legacyShown = showLegacy || status === 'legacy';
  const visible = runs ? (legacyShown ? runs : runs.filter((r) => r.status !== 'legacy')) : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Runs" description="Every run the index knows, newest first. Each value is the run's own report field; nothing is computed on this page." />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-small text-fg-2">Project
          <select className={selectCls} value={projectId} onChange={(e) => setFilter('project_id', e.target.value)} data-testid="filter-project">
            <option value="">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-small text-fg-2">Status
          <select className={selectCls} value={status} onChange={(e) => setFilter('status', e.target.value)} data-testid="filter-status">
            <option value="">Any</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-small text-fg-2">
          {runs && legacyCount > 0 && status !== 'legacy' ? (
            <button type="button" role="switch" aria-checked={showLegacy} onClick={() => setShowLegacy((v) => !v)} data-testid="toggle-legacy" data-checked={showLegacy ? 'true' : 'false'}
              className={`inline-flex h-8 items-center gap-2 rounded-md border px-3 text-small font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${showLegacy ? 'border-transparent bg-accent-soft text-accent' : 'border-line-strong bg-bg-2 text-fg-2 hover:text-fg'}`}>
              <span className={`inline-block h-2 w-2 rounded-full ${showLegacy ? 'bg-accent' : 'bg-neutral'}`} aria-hidden="true" />
              <Term term="legacy" className="no-underline">Show pre-v2 summaries</Term> <span className="mono" data-testid="legacy-count">({legacyCount})</span>
            </button>
          ) : null}
          <span data-testid="runs-count">{runs ? <><span className="font-medium text-fg">{formatCount(runs.length, 'run', 'runs')}</span>{projectName ? ` in ${projectName}` : ''}{!legacyShown && legacyCount ? <span className="text-fg-2">, {legacyCount} pre-v2 hidden</span> : null}</> : ''}</span>
        </div>
      </div>
      {error ? <EmptyState title="Could not load runs">{error}</EmptyState> : visible === null ? <TableSkeleton /> : visible.length === 0 ? (
        runs && runs.length > 0 ? (
          <EmptyState title={`All ${formatCount(runs.length, 'run', 'runs')} here ${runs.length === 1 ? 'is a' : 'are'} pre-v2 summar${runs.length === 1 ? 'y' : 'ies'}`} icon={<ListChecks className="h-5 w-5" />}>Turn on "Show pre-v2 summaries" above to list them. They carry an explored count, a cost and a duration, never a shipped count.</EmptyState>
        ) : (
          <EmptyState title={projectId || status ? 'No runs match these filters' : 'No runs yet'} icon={<ListChecks className="h-5 w-5" />}>
            {projectId || status ? 'Clear a filter to see more.' : <>Every finished run lands here from output/. Start one with <code className="mono">npm run explore -- &lt;url&gt;</code>.</>}
          </EmptyState>
        )
      ) : (
        <RunsTable runs={visible} />
      )}
    </div>
  );
}

const selectCls = 'h-9 rounded-md border border-line-strong bg-bg-2 px-2 text-body text-fg focus:outline-none focus:ring-2 focus:ring-accent';
