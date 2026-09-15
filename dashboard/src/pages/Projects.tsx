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
import { ApiWriteError, PROJECT_ENVIRONMENTS } from '@/lib/api';
import { Button } from '@/components/ui/button';

const UNASSIGNED = 'unassigned';

const ENV_VARIANT: Record<string, 'accent' | 'rework' | 'neutral'> = { staging: 'accent', production: 'rework', other: 'neutral' };

export function ProjectsPage({ refreshKey }: { refreshKey: number }) {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    api.projects()
      .then((p) => { if (live) { setProjects(p); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError && e.status === 401 ? 'Unauthorized: add #token=<QA_CORE_GATEWAY_TOKEN> to the URL.' : (e as Error).message); });
    return () => { live = false; };
  }, [refreshKey, reload]);

  if (error) return <EmptyState title="Could not load projects">{error}</EmptyState>;
  if (projects === null) return <div className="text-s text-fg-3">Loading…</div>;
  const creator = <CreateProject onCreated={() => setReload((n) => n + 1)} />;
  if (projects.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {creator}
        <EmptyState title="No projects yet" icon={<FolderOpen className="h-8 w-8" />}>
          A project appears for every host you explore, or create one above. Run <code className="mono">npm run explore -- https://your-app.example/</code> or start a run from the Terminal page; the index picks it up when the run finishes, or press the reindex button in the header.
        </EmptyState>
      </div>
    );
  }
  // Unassigned (pre-v2 records with no URL) sorts last and is muted; the API orders it last too.
  const ordered = [...projects].sort((a, b) => Number(a.id === UNASSIGNED) - Number(b.id === UNASSIGNED));
  return (
    <div className="flex flex-col gap-4">
    {creator}
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-grid">
      {ordered.map((p) => p.id === UNASSIGNED ? (
        <Link key={p.id} to={`/projects/${encodeURIComponent(p.id)}`} className="block rounded-lg opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="project-card" data-project-id={p.id} data-unassigned="true">
          <Card className="h-full border-dashed">
            <CardHeader>
              <CardTitle>Unassigned</CardTitle>
              <CardDescription>pre-v2 records with no URL</CardDescription>
            </CardHeader>
            <CardContent className="text-s text-fg-2" data-testid="unassigned-note">{p.legacy_runs} pre-v2 record{p.legacy_runs === 1 ? '' : 's'} with no URL{p.legacy_first_at ? `, ${dateRange(p.legacy_first_at, p.legacy_last_at)}` : ''}</CardContent>
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
                <Stat label="tests shipped" value={p.shipped === null ? 'n/a' : String(p.shipped)} testid="shipped" title={p.shipped === null ? NA_TITLE : undefined} sub={p.legacy_runs ? `${p.legacy_runs} pre-v2 run${p.legacy_runs === 1 ? '' : 's'}, ${p.legacy_explored} scenario${p.legacy_explored === 1 ? '' : 's'} explored` : undefined} />
                <Stat label="unresolved findings" value={p.unresolved_findings === null ? 'n/a' : String(p.unresolved_findings)} tone={p.unresolved_findings ? 'finding' : undefined} testid="unresolved-findings" title={p.unresolved_findings === null ? NA_TITLE : undefined} />
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
    </div>
  );
}

/** Create a project by host: name, base URL (identity), environment (unset unless chosen). */
function CreateProject({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [environment, setEnvironment] = useState('');
  const [error, setError] = useState<{ message: string; existing?: { id: string; name: string } } | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    setSaving(true); setError(null);
    try {
      await api.createProject({ name: name.trim(), base_url: baseUrl.trim(), environment: environment || null });
      setName(''); setBaseUrl(''); setEnvironment(''); setOpen(false); onCreated();
    } catch (e) {
      const w = e instanceof ApiWriteError ? e : null;
      const existing = w?.body.existing as { id: string; name: string } | undefined;
      setError({ message: (e as Error).message, ...(existing ? { existing } : {}) });
    } finally { setSaving(false); }
  };
  return (
    <details className="rounded-lg border border-line bg-bg-1" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid="create-project">
      <summary className="cursor-pointer px-4 py-3 text-m font-semibold">New project <span className="text-s font-normal text-fg-2">by host; a run against that host lands in it</span></summary>
      <form className="flex flex-wrap items-end gap-3 px-4 pb-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="flex flex-col gap-1 text-s text-fg"><span className="font-semibold">Base URL <span className="font-normal text-fg-2">required, the identity</span></span><input className={inputCls} data-testid="new-project-url" placeholder="https://shop.example/" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>
        <label className="flex flex-col gap-1 text-s text-fg"><span className="font-semibold">Name <span className="font-normal text-fg-2">defaults to the host</span></span><input className={inputCls} data-testid="new-project-name" placeholder="shop" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="flex flex-col gap-1 text-s text-fg"><span className="font-semibold">Environment <span className="font-normal text-fg-2">optional</span></span>
          <select className={inputCls} data-testid="new-project-env" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="">unset</option>
            {PROJECT_ENVIRONMENTS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <Button type="submit" size="sm" disabled={saving || !baseUrl.trim()} data-testid="new-project-submit">Create</Button>
        {error ? <span className="text-s text-reject" data-testid="new-project-error">{error.message}{error.existing ? <> <Link to={`/projects/${encodeURIComponent(error.existing.id)}`} className="underline" data-testid="new-project-existing">open {error.existing.name}</Link></> : null}</span> : null}
      </form>
    </details>
  );
}

const inputCls = 'h-8 rounded-md border border-line-strong bg-bg-2 px-2 text-s text-fg placeholder:text-fg-2 focus:outline-none focus:ring-2 focus:ring-accent';

const NA_TITLE = 'no reported runs; pre-v2 records only';

function dateRange(first: string | null, last: string | null): string {
  const a = fmtDate(first);
  const b = fmtDate(last);
  return a === b ? a : `${a} to ${b}`;
}

function Stat({ label, value, tone, mono, testid, sub, title }: { label: string; value: string; tone?: 'finding' | 'cost'; mono?: boolean; testid: string; sub?: string; title?: string }) {
  return (
    <div>
      <dd className={`text-l font-semibold leading-none ${tone === 'finding' ? 'text-finding' : tone === 'cost' ? 'text-cost' : ''} ${mono ? 'mono' : ''}`} data-testid={testid} title={title}>{value}</dd>
      <dt className="mt-1 text-s text-fg-2">{label}</dt>
      {sub ? <div className="mt-0.5 text-s text-fg-3" data-testid={`${testid}-sub`} title="Pre-v2 records only recorded scenarios explored, never a shipped count">{sub}</div> : null}
    </div>
  );
}
