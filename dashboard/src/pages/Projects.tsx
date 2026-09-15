import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen } from 'lucide-react';
import { api, ApiError, type ProjectCard } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { Sparkline } from '@/components/Sparkline';
import { StatusBadge } from '@/components/StatusBadge';
import { fmtDate, usd } from '@/lib/utils';

const UNASSIGNED = 'unassigned';

const ENV_VARIANT: Record<string, 'accent' | 'rework' | 'neutral'> = { staging: 'accent', production: 'rework', other: 'neutral' };

export function ProjectsPage({ refreshKey }: { refreshKey: number }) {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.projects()
      .then((p) => { if (live) { setProjects(p); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError && e.status === 401 ? 'Unauthorized: add #token=<QA_CORE_GATEWAY_TOKEN> to the URL.' : (e as Error).message); });
    return () => { live = false; };
  }, [refreshKey]);

  if (error) return <EmptyState title="Could not load projects">{error}</EmptyState>;
  if (projects === null) return <div className="text-s text-fg-3">Loading…</div>;
  if (projects.length === 0) {
    return (
      <EmptyState title="No projects yet" icon={<FolderOpen className="h-8 w-8" />}>
        A project appears for every host you explore. Run <code className="mono">npm run explore -- https://your-app.example/</code> (or start a run from the legacy UI at <a className="text-accent underline" href="/legacy">/legacy</a>); the index picks it up when the run finishes, or press the reindex button in the header.
      </EmptyState>
    );
  }
  // Unassigned (pre-v2 records with no URL) sorts last and is muted; the API orders it last too.
  const ordered = [...projects].sort((a, b) => Number(a.id === UNASSIGNED) - Number(b.id === UNASSIGNED));
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-grid">
      {ordered.map((p) => p.id === UNASSIGNED ? (
        <Link key={p.id} to={`/projects/${encodeURIComponent(p.id)}`} className="block rounded-lg opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="project-card" data-project-id={p.id} data-unassigned="true">
          <Card className="h-full border-dashed">
            <CardHeader>
              <CardTitle>Unassigned</CardTitle>
              <CardDescription>pre-v2 records with no URL</CardDescription>
            </CardHeader>
            <CardContent className="text-s text-fg-2" data-testid="unassigned-note">{p.legacy_runs} pre-v2 record{p.legacy_runs === 1 ? '' : 's'} with no URL</CardContent>
          </Card>
        </Link>
      ) : (
        <Link key={p.id} to={`/projects/${encodeURIComponent(p.id)}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="project-card" data-project-id={p.id}>
          <Card className="h-full transition-colors hover:border-line-strong">
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="truncate" title={p.name}>{p.name}</CardTitle>
                {p.environment && p.environment !== 'other' ? <Badge variant={ENV_VARIANT[p.environment] ?? 'neutral'} data-testid="env-badge">{p.environment}</Badge> : null}
              </div>
              <CardDescription className="mono truncate" title={p.base_url ?? ''}>{p.base_url ?? 'no base URL'}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-center gap-2 text-s text-fg-2">
                {p.last_run ? (<><span>Last run</span><StatusBadge status={p.last_run.status} /><span>{fmtDate(p.last_run.started_at)}</span></>) : <span>No runs yet</span>}
              </div>
              <dl className="grid grid-cols-3 gap-2">
                <Stat label="tests shipped" value={p.shipped === null ? 'n/a' : String(p.shipped)} testid="shipped" sub={p.legacy_runs ? `${p.legacy_runs} pre-v2 run${p.legacy_runs === 1 ? '' : 's'}, ${p.legacy_explored} scenario${p.legacy_explored === 1 ? '' : 's'} explored` : undefined} />
                <Stat label="unresolved findings" value={p.unresolved_findings === null ? 'n/a' : String(p.unresolved_findings)} tone={p.unresolved_findings ? 'finding' : undefined} testid="unresolved-findings" />
                <Stat label="spend this month" value={usd(p.spend_month)} tone="cost" mono testid="spend-month" />
              </dl>
              <div className="flex items-center justify-between text-s text-fg-3">
                <span>{p.runs} run{p.runs === 1 ? '' : 's'}</span>
                {p.coverage_series.length
                  ? (<span className="flex items-center gap-2"><span>coverage</span><Sparkline values={p.coverage_series.map((c) => c.percent)} /><span className="mono text-fg-2">{p.coverage_series[p.coverage_series.length - 1]!.percent}%</span></span>)
                  : <span>no SRS runs</span>}
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}

function Stat({ label, value, tone, mono, testid, sub }: { label: string; value: string; tone?: 'finding' | 'cost'; mono?: boolean; testid: string; sub?: string }) {
  return (
    <div>
      <dd className={`text-l font-semibold leading-none ${tone === 'finding' ? 'text-finding' : tone === 'cost' ? 'text-cost' : ''} ${mono ? 'mono' : ''}`} data-testid={testid}>{value}</dd>
      <dt className="mt-1 text-s text-fg-2">{label}</dt>
      {sub ? <div className="mt-0.5 text-s text-fg-3" data-testid={`${testid}-sub`} title="Pre-v2 records only recorded scenarios explored, never a shipped count">{sub}</div> : null}
    </div>
  );
}
