import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { api, ApiError, type FindingRow, type ProjectCoverage, type ProjectDetail, type ProjectTrends, type RunRow } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { RunsTable } from '@/components/RunsTable';
import { FindingsHeading, FindingsTable } from '@/components/FindingsTable';
import { CoverageTable } from '@/components/CoverageTable';
import { Trends } from '@/components/Trends';
import { usd } from '@/lib/utils';

const ENV_VARIANT: Record<string, 'accent' | 'rework' | 'neutral'> = { staging: 'accent', production: 'rework', other: 'neutral' };

/**
 * One project: header, its runs, its open findings, rule coverage across its
 * SRS runs, and trends over its completed runs. Every number is an index row
 * column or a rule-coverage row the index copied from a run folder.
 */
export function ProjectPage({ refreshKey }: { refreshKey: number }) {
  const { id = '' } = useParams();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [findings, setFindings] = useState<FindingRow[] | null>(null);
  const [coverage, setCoverage] = useState<ProjectCoverage | null>(null);
  const [trends, setTrends] = useState<ProjectTrends | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    Promise.all([api.project(id), api.runs({ project_id: id, limit: 200 }), api.findings({ project_id: id }), api.projectCoverage(id), api.projectTrends(id)])
      .then(([d, r, f, c, t]) => { if (live) { setDetail(d); setRuns(r); setFindings(f); setCoverage(c); setTrends(t); } })
      .catch((e: unknown) => { if (live) setError({ status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }); });
    return () => { live = false; };
  }, [id, refreshKey]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <Link to="/" className="inline-flex items-center gap-1 text-s text-fg-2 hover:text-fg"><ArrowLeft className="h-3.5 w-3.5" /> Back to projects</Link>
        <EmptyState title={error.status === 404 ? 'Project not found' : error.status === 401 ? 'Unauthorized' : 'Could not load this project'}><span className="mono" data-testid="project-error">{error.message}</span></EmptyState>
      </div>
    );
  }
  if (!detail || !runs || !findings || !coverage || !trends) return <div className="text-s text-fg-2">Loading…</div>;
  const p = detail.project;
  const s = detail.summary;
  return (
    <div className="flex flex-col gap-6" data-testid="project-page" data-project-id={p.id}>
      <Link to="/" className="inline-flex items-center gap-1 text-s text-fg-2 hover:text-fg" data-testid="back-link"><ArrowLeft className="h-3.5 w-3.5" /> Back to projects</Link>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-m font-semibold" data-testid="project-name">{p.name}</h1>
          {p.environment && p.environment !== 'other' ? <Badge variant={ENV_VARIANT[p.environment] ?? 'neutral'} data-testid="env-badge">{p.environment}</Badge> : null}
          {p.base_url ? <a href={p.base_url} target="_blank" rel="noreferrer" className="mono inline-flex items-center gap-1 text-s text-accent hover:underline" data-testid="project-url">{p.base_url} <ExternalLink className="h-3 w-3" /></a> : <span className="text-s text-fg-3">no base URL</span>}
        </div>
        <dl className="grid gap-3 sm:grid-cols-4">
          <Fact label="tests shipped" value={s.shipped === null ? 'n/a' : String(s.shipped)} testid="project-shipped" sub={s.legacy_runs ? `${s.legacy_runs} pre-v2 run${s.legacy_runs === 1 ? '' : 's'}, ${s.legacy_explored} scenario${s.legacy_explored === 1 ? '' : 's'} explored` : undefined} />
          <Fact label="open findings" value={s.open_findings === null ? 'n/a' : String(s.open_findings)} tone={s.open_findings ? 'finding' : undefined} testid="project-open-findings" />
          <Fact label="spend this month" value={usd(s.spend_month)} tone="cost" mono testid="project-spend-month" />
          <Fact label="runs" value={String(s.runs)} testid="project-runs" sub={`${s.reported_runs} with a report`} />
        </dl>
      </header>

      <section className="flex flex-col gap-2" data-testid="project-runs">
        <h2 className="text-m font-semibold">Runs <span className="text-s font-normal text-fg-3">{runs.length}</span></h2>
        {runs.length === 0 ? <EmptyState title="No runs yet" /> : <RunsTable runs={runs} hideProject />}
      </section>

      <section className="flex flex-col gap-2" data-testid="project-findings">
        <FindingsHeading count={findings.length} />
        <FindingsTable findings={findings} showProject={false} onChange={(u) => {
          setFindings((cur) => (cur ?? []).map((f) => (f.id === u.id ? u : f)));
          // The header's open-findings count is an index number; re-read it rather than adjusting it here.
          api.project(id).then((d) => setDetail(d)).catch(() => { /* the next load shows it */ });
        }} />
      </section>

      <section className="flex flex-col gap-2" data-testid="project-coverage">
        <h2 className="text-m font-semibold">Requirements coverage</h2>
        <CoverageTable coverage={coverage} />
      </section>

      <section className="flex flex-col gap-2" data-testid="project-trends">
        <h2 className="text-m font-semibold">Trends</h2>
        <Trends trends={trends} />
      </section>
    </div>
  );
}

function Fact({ label, value, sub, tone, mono, testid }: { label: string; value: string; sub?: string; tone?: 'finding' | 'cost'; mono?: boolean; testid: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg-1 p-3">
      <dd className={`text-l font-semibold leading-none ${tone === 'finding' ? 'text-finding' : tone === 'cost' ? 'text-cost' : ''} ${mono ? 'mono' : ''}`} data-testid={testid}>{value}</dd>
      <dt className="mt-1 text-s text-fg-2">{label}</dt>
      {sub ? <div className="mt-1 text-s text-fg-3" data-testid={`${testid}-sub`}>{sub}</div> : null}
    </div>
  );
}
