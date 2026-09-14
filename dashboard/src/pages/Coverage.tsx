import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, type ProjectCard, type ProjectCoverage } from '@/lib/api';
import { EmptyState } from '@/components/EmptyState';
import { CoverageTable } from '@/components/CoverageTable';

/** Requirements coverage per project, from the rule-coverage rows the index recorded. */
export function CoveragePage({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<Array<{ project: ProjectCard; coverage: ProjectCoverage }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.projects()
      .then(async (projects) => {
        const real = projects.filter((p) => p.id !== 'unassigned');
        const covs = await Promise.all(real.map((p) => api.projectCoverage(p.id)));
        if (live) { setItems(real.map((p, i) => ({ project: p, coverage: covs[i]! }))); setError(null); }
      })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError && e.status === 401 ? 'Unauthorized: add #token=<QA_CORE_GATEWAY_TOKEN> to the URL.' : (e as Error).message); });
    return () => { live = false; };
  }, [refreshKey]);
  if (error) return <EmptyState title="Could not load coverage">{error}</EmptyState>;
  if (items === null) return <div className="text-s text-fg-2">Loading…</div>;
  if (items.length === 0) return <EmptyState title="No projects yet">A project appears for every host you explore.</EmptyState>;
  return (
    <div className="flex flex-col gap-6" data-testid="coverage-page">
      <h1 className="text-m font-semibold">Requirements coverage <span className="text-s font-normal text-fg-3">per project, from each SRS run's rule-coverage.json</span></h1>
      {items.map(({ project, coverage }) => (
        <section key={project.id} className="flex flex-col gap-2" data-testid="coverage-project" data-project-id={project.id}>
          <h2 className="text-m font-semibold"><Link to={`/projects/${encodeURIComponent(project.id)}`} className="hover:underline">{project.name}</Link></h2>
          <CoverageTable coverage={coverage} />
        </section>
      ))}
    </div>
  );
}
