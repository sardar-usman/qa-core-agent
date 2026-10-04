import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, FolderOpen } from 'lucide-react';
import { api, ApiError, ApiWriteError, PROJECT_ENVIRONMENTS, type ProjectCard } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { ProjectsSkeleton } from '@/components/Skeleton';
import { Sparkline } from '@/components/Sparkline';
import { StatusBadge } from '@/components/StatusBadge';
import { Term, Tip } from '@/components/Term';
import { exactMoney, fmtDate, money } from '@/lib/utils';

/**
 * Projects: one card per host. Every number on a card is a field of
 * /api/projects (the index's aggregate over run-report columns); the page
 * formats and groups, it never computes a value.
 *
 * Grouping (PR F part 1): projects with at least one run that has a report
 * come first. Projects whose runs are all pre-v2 records, projects with no
 * runs, and the Unassigned record sit in a collapsed "Earlier experiments
 * (pre-v2)" section with its count. Nothing is hidden without a count.
 */

const UNASSIGNED = 'unassigned';

const ENV_VARIANT: Record<string, 'accent' | 'rework' | 'neutral'> = { staging: 'accent', production: 'rework', other: 'neutral' };

/** Active: at least one reported (v2) run. Earlier: everything else, Unassigned last. Exported for the smoke. */
export function splitProjects(projects: ProjectCard[]): { active: ProjectCard[]; earlier: ProjectCard[] } {
  const active = projects.filter((p) => p.id !== UNASSIGNED && p.reported_runs > 0);
  const earlier = projects.filter((p) => !active.includes(p)).sort((a, b) => Number(a.id === UNASSIGNED) - Number(b.id === UNASSIGNED));
  return { active, earlier };
}

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

  const header = <PageHeader title="Projects" description="One card per host the agent has explored. Every number is read from the run index; this page computes nothing." />;
  if (error) return <div className="flex flex-col gap-6">{header}<EmptyState title="Could not load projects">{error}</EmptyState></div>;
  if (projects === null) return <div className="flex flex-col gap-6">{header}<ProjectsSkeleton /></div>;
  const creator = <CreateProject onCreated={() => setReload((n) => n + 1)} />;
  if (projects.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        {creator}
        <EmptyState title="No projects yet" icon={<FolderOpen className="h-5 w-5" />}>
          A project appears for every host you explore, or create one above. Run <code className="mono">npm run explore -- https://your-app.example/</code> or start a run from the Terminal page; the index picks it up when the run finishes, or press the rebuild button in the header.
        </EmptyState>
      </div>
    );
  }
  const { active, earlier } = splitProjects(projects);
  return (
    <div className="flex flex-col gap-6">
      {header}
      {creator}
      {active.length ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-grid">
          {active.map((p) => <ProjectCardView key={p.id} p={p} />)}
        </div>
      ) : (
        <EmptyState title="No project has a v2 run yet" icon={<FolderOpen className="h-5 w-5" />}>
          Every project so far is a pre-v2 record or has no runs. They are listed below. Start a run from the Terminal page to get the first full report.
        </EmptyState>
      )}
      {earlier.length ? (
        <details className="group rounded-lg border border-line bg-bg-1/60" data-testid="earlier-experiments">
          <summary className="flex cursor-pointer select-none items-center gap-3 rounded-lg px-5 py-3.5 text-m text-fg-2 marker:content-none hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
            <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
            <Term term="earlierExperiments" className="font-semibold text-fg">Earlier experiments (pre-v2)</Term>
            <span className="mono rounded-full bg-bg-3 px-2 py-0.5 text-s text-fg-2" data-testid="earlier-count">{earlier.length}</span>
            <span className="text-s text-fg-3">pre-v2 records, projects with no runs yet, and the Unassigned record</span>
          </summary>
          <div className="grid gap-5 px-5 pb-5 pt-1 sm:grid-cols-2 lg:grid-cols-3" data-testid="earlier-grid">
            {earlier.map((p) => p.id === UNASSIGNED ? <UnassignedCard key={p.id} p={p} /> : <ProjectCardView key={p.id} p={p} />)}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ProjectCardView({ p }: { p: ProjectCard }) {
  const latest = p.last_run?.shipped ?? null;
  const na = <Term term="notAvailable">n/a</Term>;
  return (
    <Link to={`/projects/${encodeURIComponent(p.id)}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="project-card" data-project-id={p.id}>
      <Card className="card-lift h-full">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="truncate" title={p.name}>{p.name}</CardTitle>
            {p.environment && p.environment !== 'other' ? <Badge variant={ENV_VARIANT[p.environment] ?? 'neutral'} data-testid="env-badge">{p.environment}</Badge> : null}
          </div>
          <CardDescription className="mono truncate" title={p.base_url ?? ''}>{p.base_url ?? 'no base URL'}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-s text-fg-2">
            {p.last_run ? (<><Term term="lastRun">Last run</Term><StatusBadge status={p.last_run.status} /><Tip text={p.last_run.started_at ?? 'start time not recorded'}>{fmtDate(p.last_run.started_at)}</Tip></>) : <span>No runs yet</span>}
          </div>

          <div>
            <div className="text-l font-semibold leading-none text-fg" data-testid="latest-shipped">{latest === null ? na : latest}</div>
            <div className="mt-1.5 text-s text-fg-2"><Term term="latestShipped">tests in the latest run</Term></div>
            <div className="mt-2 text-s text-fg-2" data-testid="shipped-line">
              {p.shipped === null
                ? (<><span className="mono text-fg" data-testid="shipped">{na}</span> <Term term="testsShipped">tests shipped</Term></>)
                : (<><span className="mono text-fg" data-testid="shipped">{p.shipped}</span> <Term term="testsShipped">shipped</Term> across <span className="mono text-fg" data-testid="reported-runs">{p.reported_runs}</span> reported run{p.reported_runs === 1 ? '' : 's'}</>)}
            </div>
            {p.legacy_runs ? <div className="mt-0.5 text-s text-fg-3" data-testid="shipped-sub">{p.legacy_runs} pre-v2 run{p.legacy_runs === 1 ? '' : 's'}, {p.legacy_explored} scenario{p.legacy_explored === 1 ? '' : 's'} <Term term="explored">explored</Term></div> : null}
          </div>

          <dl className="grid grid-cols-2 gap-3 border-t border-line pt-4">
            <Stat label={<Term term="unresolvedFindings">unresolved findings</Term>} value={p.unresolved_findings === null ? na : String(p.unresolved_findings)} tone={p.unresolved_findings ? 'finding' : undefined} testid="unresolved-findings" />
            <Stat label={<Term term="spendMonth">spend this month</Term>} value={<Tip text={`exact: ${exactMoney(p.spend_month)}`}>{money(p.spend_month)}</Tip>} tone="cost" mono testid="spend-month" />
          </dl>

          <div className="flex items-center justify-between gap-3 border-t border-line pt-3 text-s text-fg-3">
            <span><span className="mono text-fg-2" data-testid="runs-count">{p.runs}</span> <Term term="runs">run{p.runs === 1 ? '' : 's'}</Term></span>
            {p.coverage_series.length
              ? (<span className="flex items-center gap-2"><Term term="coverage">coverage</Term><Sparkline values={p.coverage_series.map((c) => c.percent)} /><span className="mono text-fg-2" data-testid="coverage-latest">{p.coverage_series[p.coverage_series.length - 1]!.percent}%</span></span>)
              : <Term term="srsRuns">no SRS runs</Term>}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function UnassignedCard({ p }: { p: ProjectCard }) {
  return (
    <Link to={`/projects/${encodeURIComponent(p.id)}`} className="block rounded-lg opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="project-card" data-project-id={p.id} data-unassigned="true">
      <Card className="card-lift h-full border-dashed">
        <CardHeader>
          <CardTitle>Unassigned</CardTitle>
          <CardDescription>pre-v2 records with no URL</CardDescription>
        </CardHeader>
        <CardContent className="text-s text-fg-2" data-testid="unassigned-note">{p.legacy_runs} pre-v2 record{p.legacy_runs === 1 ? '' : 's'} with no URL{p.legacy_first_at ? `, ${dateRange(p.legacy_first_at, p.legacy_last_at)}` : ''}</CardContent>
      </Card>
    </Link>
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
    <details className="group rounded-lg border border-line bg-bg-1" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid="create-project">
      <summary className="flex cursor-pointer select-none items-center gap-3 rounded-lg px-5 py-3 text-m marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 text-fg-3 transition-transform group-open:rotate-90" aria-hidden="true" />
        <span className="font-semibold">New project</span>
        <span className="text-s text-fg-2">by host; a run against that host lands in it</span>
      </summary>
      <form className="flex flex-wrap items-end gap-3 px-5 pb-5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
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

const inputCls = 'h-9 rounded-md border border-line-strong bg-bg-2 px-2.5 text-s text-fg placeholder:text-fg-3 focus:outline-none focus:ring-2 focus:ring-accent';

function dateRange(first: string | null, last: string | null): string {
  const a = fmtDate(first);
  const b = fmtDate(last);
  return a === b ? a : `${a} to ${b}`;
}

function Stat({ label, value, tone, mono, testid }: { label: ReactNode; value: ReactNode; tone?: 'finding' | 'cost'; mono?: boolean; testid: string }) {
  return (
    <div>
      <dd className={`text-section font-semibold leading-none ${tone === 'finding' ? 'text-finding' : tone === 'cost' ? 'text-cost' : 'text-fg'} ${mono ? 'mono' : ''}`} data-testid={testid}>{value}</dd>
      <dt className="mt-1.5 text-s text-fg-2">{label}</dt>
    </div>
  );
}
