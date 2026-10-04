import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen } from 'lucide-react';
import { api, ApiError, type ProjectCard } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { NewProjectDialog } from '@/components/NewProjectDialog';
import { ProjectsSkeleton } from '@/components/Skeleton';
import { Sparkline } from '@/components/Sparkline';
import { StatusBadge } from '@/components/StatusBadge';
import { Term, Tip } from '@/components/Term';
import { exactMoney, fmtDate, hostOf, money } from '@/lib/utils';

/**
 * Projects: one card per host with at least one run that has a report.
 * Every number on a card is a field of /api/projects (the index's aggregate
 * over run-report columns); the page formats and groups, it never computes
 * a value, and it never renders "n/a": a value the index does not have is
 * not rendered as a metric.
 *
 * Projects whose runs are all pre-v2 records, projects with no runs yet and
 * the Unassigned record are not cards. One muted line under the grid counts
 * them and a "Show" link reveals a compact table, so nothing is hidden
 * without a count and nothing is deleted from the data.
 */

const UNASSIGNED = 'unassigned';

const ENV_VARIANT: Record<string, 'accent' | 'rework' | 'neutral'> = { staging: 'accent', production: 'rework', other: 'neutral' };

/** Cards: at least one reported (v2) run. Earlier: everything else, Unassigned last. Exported for the smoke. */
export function splitProjects(projects: ProjectCard[]): { active: ProjectCard[]; earlier: ProjectCard[] } {
  const active = projects.filter((p) => p.id !== UNASSIGNED && p.reported_runs > 0);
  const earlier = projects.filter((p) => !active.includes(p)).sort((a, b) => Number(a.id === UNASSIGNED) - Number(b.id === UNASSIGNED));
  return { active, earlier };
}

export function ProjectsPage({ refreshKey }: { refreshKey: number }) {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showEarlier, setShowEarlier] = useState(false);
  useEffect(() => {
    let live = true;
    api.projects()
      .then((p) => { if (live) { setProjects(p); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError && e.status === 401 ? 'Unauthorized: add #token=<QA_CORE_GATEWAY_TOKEN> to the URL.' : (e as Error).message); });
    return () => { live = false; };
  }, [refreshKey, reload]);

  const header = (
    <PageHeader title="Projects" description="One card per host the agent has explored. Every number is read from the run index; this page computes nothing.">
      <NewProjectDialog onCreated={() => setReload((n) => n + 1)} />
    </PageHeader>
  );
  if (error) return <div className="flex flex-col gap-6">{header}<EmptyState title="Could not load projects">{error}</EmptyState></div>;
  if (projects === null) return <div className="flex flex-col gap-6">{header}<ProjectsSkeleton /></div>;
  if (projects.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState title="No projects yet" icon={<FolderOpen className="h-5 w-5" />}>
          A project appears for every host you explore, or create one with the button above. Run <code className="mono">npm run explore -- https://your-app.example/</code> or start a run from the Terminal page; the index picks it up when the run finishes, or press the rebuild button in the header.
        </EmptyState>
      </div>
    );
  }
  const { active, earlier } = splitProjects(projects);
  return (
    <div className="flex flex-col gap-6">
      {header}
      {active.length ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-grid">
          {active.map((p) => <ProjectCardView key={p.id} p={p} />)}
        </div>
      ) : (
        <EmptyState title="No project has a run with a report yet" icon={<FolderOpen className="h-5 w-5" />}>
          Every project so far is a pre-v2 summary or has no runs. Start a run from the Terminal page to get the first full report.
        </EmptyState>
      )}
      {earlier.length ? (
        <div className="flex flex-col gap-3" data-testid="earlier-experiments">
          <p className="text-s text-fg-3" data-testid="earlier-note">
            <span className="tabular-nums" data-testid="earlier-count">{earlier.length}</span> <Term term="earlierExperiments">earlier experiment{earlier.length === 1 ? '' : 's'} (pre-v2 summar{earlier.length === 1 ? 'y' : 'ies'})</Term> {earlier.length === 1 ? 'is' : 'are'} not shown.{' '}
            <button type="button" className="rounded-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setShowEarlier((v) => !v)} aria-expanded={showEarlier} aria-controls="earlier-table" data-testid="earlier-toggle">{showEarlier ? 'Hide' : 'Show'}</button>
          </p>
          {showEarlier ? <EarlierTable projects={earlier} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function ProjectCardView({ p }: { p: ProjectCard }) {
  const last = p.last_run;
  const latest = last?.shipped ?? null;
  const runsWord = p.reported_runs === p.runs ? 'run' : 'reported run';
  return (
    <Link to={`/projects/${encodeURIComponent(p.id)}`} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="project-card" data-project-id={p.id}>
      <Card className="card-lift h-full">
        <CardHeader className="gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="min-w-0 truncate" title={p.name}>{p.name}</CardTitle>
            {p.environment && p.environment !== 'other' ? <Badge variant={ENV_VARIANT[p.environment] ?? 'neutral'} data-testid="env-badge">{p.environment}</Badge> : null}
            <span className="ml-auto flex items-center gap-2 text-s text-fg-2">
              {last ? (<><StatusBadge status={last.status} /><Tip text={last.started_at ?? 'start time not recorded'}>{fmtDate(last.started_at)}</Tip></>) : <span>No runs yet</span>}
            </span>
          </div>
          {p.base_url
            ? <Tip text={p.base_url} className="block min-w-0"><p className="truncate text-s text-fg-3" data-testid="card-url">{p.base_url}</p></Tip>
            : <p className="text-s text-fg-3">no base URL</p>}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[1.3fr_1fr_1fr] grid-rows-[auto_auto_auto] gap-x-4 gap-y-0">
            <Metric col={1} label={<Term term="latestShipped">tests in the latest run</Term>} testid="latest-shipped" value={latest === null ? null : String(latest)} missing="latest run is a pre-v2 summary">
              {p.shipped === null ? null : (
                <div className="mt-1 text-xs text-fg-2" data-testid="shipped-line"><span className="tabular-nums text-fg" data-testid="shipped">{p.shipped}</span> <Term term="testsShipped">shipped</Term> across <span className="tabular-nums text-fg" data-testid="reported-runs">{p.reported_runs}</span> {runsWord}{p.reported_runs === 1 ? '' : 's'}</div>
              )}
              {p.legacy_runs ? <div className="mt-0.5 text-xs text-fg-3" data-testid="shipped-sub">{p.legacy_runs} pre-v2 run{p.legacy_runs === 1 ? '' : 's'}, {p.legacy_explored} scenario{p.legacy_explored === 1 ? '' : 's'} <Term term="explored">explored</Term></div> : null}
            </Metric>
            <Metric col={2} label={<Term term="unresolvedFindings">unresolved findings</Term>} testid="unresolved-findings" value={p.unresolved_findings === null ? null : String(p.unresolved_findings)} tone={p.unresolved_findings ? 'finding' : undefined} missing="no reported run" />
            <Metric col={3} label={<Term term="spendMonth">spend this month</Term>} testid="spend-month" tone="cost" value={<Tip text={`exact: ${exactMoney(p.spend_month)}`}>{money(p.spend_month)}</Tip>} />
          </dl>
          <div className="flex items-center justify-between gap-3 border-t border-line pt-3 text-s text-fg-3">
            <span><span className="tabular-nums text-fg-2" data-testid="runs-count">{p.runs}</span> <Term term="runs">run{p.runs === 1 ? '' : 's'}</Term></span>
            {p.coverage_series.length
              ? (<span className="flex items-center gap-2"><Term term="coverage">coverage</Term><Sparkline values={p.coverage_series.map((c) => c.percent)} /><span className="tabular-nums text-fg-2" data-testid="coverage-latest">{p.coverage_series[p.coverage_series.length - 1]!.percent}%</span></span>)
              : <Term term="srsRuns">no SRS runs</Term>}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/**
 * Label above value, left aligned. The three metrics share the grid's rows
 * (labels in row 1, values in row 2, the small lines in row 3), so a label
 * that wraps never pushes its value off the common baseline. A null value
 * renders the reason in words, never a number and never n/a.
 */
function Metric({ col, label, value, tone, testid, missing, children }: { col: 1 | 2 | 3; label: ReactNode; value: ReactNode | null; tone?: 'finding' | 'cost'; testid: string; missing?: string; children?: ReactNode }) {
  const column = { gridColumn: col };
  return (
    <>
      <dt className="min-w-0 self-end text-xs text-fg-2" style={{ ...column, gridRow: 1 }}>{label}</dt>
      {value === null
        ? <dd className="mt-1 text-s text-fg-3" style={{ ...column, gridRow: 2 }} data-testid={`${testid}-missing`}>{missing ?? 'not recorded'}</dd>
        : <dd className={`money mt-1 text-l font-semibold leading-none ${tone === 'finding' ? 'text-finding' : tone === 'cost' ? 'text-cost' : 'text-fg'}`} style={{ ...column, gridRow: 2 }} data-testid={testid}>{value}</dd>}
      {children ? <div className="min-w-0" style={{ ...column, gridRow: 3 }}>{children}</div> : null}
    </>
  );
}

/** The compact table of projects that are not cards: pre-v2 summaries, projects with no runs yet, the Unassigned record. */
function EarlierTable({ projects }: { projects: ProjectCard[] }) {
  return (
    <div id="earlier-table" className="overflow-auto rounded-lg border border-line bg-bg-1" data-testid="earlier-table">
      <table className="w-full text-m">
        <thead className="bg-bg-2 text-left text-xs font-semibold uppercase tracking-wide text-fg-2">
          <tr>
            <th className="h-9 px-4">Project</th>
            <th className="h-9 px-4">Host</th>
            <th className="h-9 px-4 text-right"><Term term="runs">Runs</Term></th>
            <th className="h-9 px-4 text-right"><Term term="explored">Scenarios explored</Term></th>
            <th className="h-9 px-4"><Term term="lastRun">Last run</Term></th>
            <th className="h-9 px-4"></th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const unassigned = p.id === UNASSIGNED;
            const noRuns = p.runs === 0;
            return (
              <tr key={p.id} className="border-t border-line hover:bg-bg-2" data-testid="earlier-row" data-project-id={p.id}>
                <td className="px-4 py-2.5"><Link to={`/projects/${encodeURIComponent(p.id)}`} className="font-medium text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="earlier-name">{unassigned ? 'Unassigned' : p.name}</Link></td>
                <td className="px-4 py-2.5 text-fg-2" data-testid="earlier-host">{unassigned ? 'no URL' : (hostOf(p.base_url) || 'no base URL')}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-fg" data-testid="earlier-runs">{p.runs}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-fg" data-testid="earlier-explored">{noRuns ? <span className="text-fg-3">none</span> : p.legacy_explored}</td>
                <td className="px-4 py-2.5 text-fg-2" data-testid="earlier-last">{p.last_run ? <Tip text={p.last_run.started_at ?? 'start time not recorded'}>{fmtDate(p.last_run.started_at)}</Tip> : <span className="text-fg-3">no runs yet</span>}</td>
                <td className="px-4 py-2.5"><Term term={noRuns ? 'runs' : 'legacy'} className="text-xs text-fg-3">{noRuns ? 'no runs' : 'summary only'}</Term></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
