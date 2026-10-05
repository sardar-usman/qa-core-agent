import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderOpen } from 'lucide-react';
import { api, ApiError, type ProjectCard, type ProjectTotals } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { NewProjectDialog } from '@/components/NewProjectDialog';
import { ProjectsSkeleton } from '@/components/Skeleton';
import { LABEL } from '@/components/StatusBadge';
import { Term, Tip } from '@/components/Term';
import { hostOf } from '@/lib/utils';
import { exactMoney, formatCount, formatDate, formatDateTime, formatMoney } from '@/lib/format';

/**
 * Projects (redesign v2, docs/ui/redesign-v2/projects-target-*.png): a
 * headline built from the server-summed totals of /api/projects, then one
 * card per host with at least one run that has a report. Every number on
 * the page is a field of /api/projects (the index's aggregate over
 * run-report columns, the totals summed on the server); the page formats
 * and groups, it never computes a value, and it never renders "n/a": a
 * value the index does not have is not rendered as a metric.
 *
 * Projects whose runs are all pre-v2 records, projects with no runs yet and
 * the Unassigned record are not cards. One muted line under the grid counts
 * them and a "Show" link reveals a compact table, so nothing is hidden
 * without a count and nothing is deleted from the data.
 */

const UNASSIGNED = 'unassigned';

/** The short pill text for a last run that is not completed; the full LABEL text is in the pill's tooltip. */
const STATUS_SHORT: Record<string, string> = { stopped: 'Stopped early', empty: 'Empty run', failed: 'Run failed', running: 'Running', legacy: 'Summary only' };

/** Cards: at least one reported (v2) run. Earlier: everything else, Unassigned last. Exported for the smoke. */
export function splitProjects(projects: ProjectCard[]): { active: ProjectCard[]; earlier: ProjectCard[] } {
  const active = projects.filter((p) => p.id !== UNASSIGNED && p.reported_runs > 0);
  const earlier = projects.filter((p) => !active.includes(p)).sort((a, b) => Number(a.id === UNASSIGNED) - Number(b.id === UNASSIGNED));
  return { active, earlier };
}

export function ProjectsPage({ refreshKey }: { refreshKey: number }) {
  const [projects, setProjects] = useState<ProjectCard[] | null>(null);
  const [totals, setTotals] = useState<ProjectTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showEarlier, setShowEarlier] = useState(false);
  useEffect(() => {
    let live = true;
    api.projectsWithTotals()
      .then((r) => { if (live) { setProjects(r.projects); setTotals(r.totals); setError(null); } })
      .catch((e: unknown) => { if (live) setError(e instanceof ApiError && e.status === 401 ? 'Unauthorized: add #token=<QA_CORE_GATEWAY_TOKEN> to the URL.' : (e as Error).message); });
    return () => { live = false; };
  }, [refreshKey, reload]);

  const header = (
    <section className="flex flex-wrap items-end justify-between gap-5" data-testid="page-header">
      <div className="max-w-[940px]">
        <p className="text-caption font-medium uppercase tracking-wide text-brand"><Term term="projectsPage" className="decoration-line-strong">Projects</Term></p>
        <h1 className="mt-2 text-display font-semibold text-fg" data-testid="projects-headline">{totals ? headline(totals) : '\u00a0'}</h1>
        <p className="mt-2 text-body text-fg-2" data-testid="projects-subline">{totals ? <Term term="projectTotals">{subline(totals)}</Term> : null}</p>
      </div>
      <NewProjectDialog onCreated={() => setReload((n) => n + 1)} />
    </section>
  );
  if (error) return <div className="flex flex-col gap-6">{header}<EmptyState title="Could not load projects">{error}</EmptyState></div>;
  if (projects === null) return <div className="flex flex-col gap-6">{header}<ProjectsSkeleton /></div>;
  if (projects.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState title="No projects yet" icon={<FolderOpen className="h-5 w-5" />}>
          A project appears for every host you explore, or create one with the button above. Run <code className="mono">npm run explore -- https://your-app.example/</code> or start a run from Run a test; the index picks it up when the run finishes, or press the rebuild button in the sidebar.
        </EmptyState>
      </div>
    );
  }
  const { active, earlier } = splitProjects(projects);
  return (
    <div className="flex flex-col gap-8">
      {header}
      {active.length ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
          {active.map((p) => <ProjectCardView key={p.id} p={p} />)}
        </div>
      ) : (
        <EmptyState title="No project has a run with a report yet" icon={<FolderOpen className="h-5 w-5" />}>
          Every project so far is a pre-v2 summary or has no runs. Start a run from Run a test to get the first full report.
        </EmptyState>
      )}
      {earlier.length ? (
        <div className="flex flex-col gap-3" data-testid="earlier-experiments">
          <p className="text-small text-fg-2" data-testid="earlier-note">
            <span className="tabular-nums" data-testid="earlier-count">{earlier.length}</span> <Term term="earlierExperiments">earlier experiment{earlier.length === 1 ? '' : 's'}</Term> {earlier.length === 1 ? 'is' : 'are'} hidden.{' '}
            <button type="button" className="rounded-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setShowEarlier((v) => !v)} aria-expanded={showEarlier} aria-controls="earlier-table" data-testid="earlier-toggle">{showEarlier ? 'Hide them' : 'Show them'}</button>
          </p>
          {showEarlier ? <EarlierTable projects={earlier} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The headline words from the server totals (standing rule 3: the page only
 * pluralises). Exported for the smoke.
 */
export function headline(t: ProjectTotals): string {
  const ready = t.latest_verified === 0 ? 'No tests are ready yet.' : t.latest_verified === 1 ? '1 test is ready to run.' : `${t.latest_verified} tests are ready to run.`;
  const eyes = t.to_review === 0 ? 'Nothing needs your eyes.' : t.to_review === 1 ? '1 thing needs your eyes.' : `${t.to_review} things need your eyes.`;
  return `${ready} ${eyes}`;
}
export function subline(t: ProjectTotals): string {
  return `Across ${t.websites} website${t.websites === 1 ? '' : 's'}. ${formatMoney(t.spend_month)} spent on testing this month.`;
}

/**
 * One project card (docs/ui/redesign-v2/projects-target-*.png). The name is
 * the link; its ::after overlay stretches over the whole card so the card is
 * clickable without nesting interactive elements, and the tooltip triggers
 * (the host, the date, the exact money value, the row labels) sit above the
 * overlay (relative, z-10) so they open without navigating. Every card has
 * the same structure, so the cards share one height and "Open project" is
 * pinned to the bottom. A last run that is not completed shows an amber
 * pill beside the name from the LABEL map; it is never hidden.
 */
function ProjectCardView({ p }: { p: ProjectCard }) {
  const last = p.last_run;
  const latest = last?.shipped ?? null;
  const cov = p.coverage_series.length ? p.coverage_series[p.coverage_series.length - 1]! : null;
  const href = `/projects/${encodeURIComponent(p.id)}`;
  const review = p.unresolved_findings ?? 0;
  const letter = (p.name.trim()[0] ?? '?').toUpperCase();
  return (
    <article className="card-lift relative flex h-full flex-col gap-5 rounded-lg border border-line bg-bg-1 p-6 text-fg" data-testid="project-card" data-project-id={p.id} data-href={href}>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-nav-active text-subheading font-semibold text-nav-active-fg" aria-hidden="true" data-testid="card-letter">{letter}</span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-subheading font-semibold" title={p.name}>
              <Link to={href} className="rounded-sm after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="project-card-link">{p.name}</Link>
            </h2>
            {last && last.status !== 'completed' ? <Tip className="relative z-10 shrink-0" text={`Last run ${LABEL[last.status] ?? last.status}`}><Badge variant="rework" data-testid="card-status" data-status={last.status}>{STATUS_SHORT[last.status] ?? `Last run ${last.status}`}</Badge></Tip> : null}
            {p.environment && p.environment !== 'other' ? <Badge variant="neutral" className="relative z-10 shrink-0" data-testid="env-badge">{p.environment}</Badge> : null}
          </div>
          {p.base_url
            ? <Tip text={p.base_url} className="relative z-10 mt-1 block min-w-0"><p className="truncate text-small text-fg-2" data-testid="card-url">{hostOf(p.base_url)}</p></Tip>
            : <p className="mt-1 text-small text-fg-2" data-testid="card-url">no base URL</p>}
        </div>
      </div>
      <div>
        {latest === null
          ? <div className="text-body font-medium text-fg-2" data-testid="latest-shipped-missing">latest run is a pre-v2 summary</div>
          : (<div className="flex items-baseline gap-2">
              <span className="money text-title font-semibold" data-testid="latest-shipped">{latest}</span>
              <span className="text-body font-medium">{formatCount(latest, 'test', 'tests').replace(/^\d+ /, '')} ready</span>
            </div>)}
        <div className="mt-1 text-small text-fg-2" data-testid="card-sentence">
          {last ? (<>Verified in the run on <Tip text={formatDateTime(last.started_at)} className="relative z-10">{formatDate(last.started_at)}</Tip>. </>) : 'No runs yet. '}
          {p.legacy_runs
            ? (<><span className="tabular-nums" data-testid="legacy-runs">{formatCount(p.legacy_runs, 'older run', 'older runs')}</span> kept a summary only.</>)
            : (<><span className="tabular-nums" data-testid="shipped">{p.shipped === null ? 'n/a' : p.shipped}</span> across all <span className="tabular-nums" data-testid="runs-count">{formatCount(p.reported_runs, 'run', 'runs')}</span>.</>)}
        </div>
      </div>
      <div className="flex flex-col gap-3 border-t border-line pt-4 text-body">
        <div className="flex items-center justify-between gap-3" data-testid="card-review-row">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${review ? 'bg-finding' : 'bg-pass'}`} data-testid="review-dot" data-tone={review ? 'finding' : 'pass'} />
            <Term term="unresolvedFindings" className="relative z-10">{review ? 'Product behavior to review' : 'Nothing to review'}</Term>
          </span>
          <span className={`money inline-flex h-5 items-center rounded-full px-2 text-caption font-medium ${review ? 'bg-finding-soft text-finding' : 'bg-pass-soft text-pass'}`} data-testid="unresolved-findings">{review}</span>
        </div>
        <div className="flex flex-col gap-2" data-testid="card-coverage">
          <div className="flex items-center justify-between gap-3">
            <Term term="coverage" className="relative z-10">Requirements covered</Term>
            {cov
              ? <span className="font-medium" data-testid="coverage-latest">{cov.covered} of {cov.total}</span>
              : <span className="text-fg-2" data-testid="coverage-none">No document yet</span>}
          </div>
          <div className="h-2 overflow-hidden rounded-sm bg-bg-3" role={cov ? 'progressbar' : undefined} aria-label={cov ? 'Requirements covered' : undefined} aria-valuemin={cov ? 0 : undefined} aria-valuemax={cov ? 100 : undefined} aria-valuenow={cov ? cov.percent : undefined} data-testid={cov ? 'coverage-bar' : 'coverage-bar-empty'} data-percent={cov ? cov.percent : undefined}>
            {cov ? <div className="h-full rounded-sm bg-brand" style={{ width: `${cov.percent}%` }} data-testid="coverage-bar-fill" /> : null}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <Term term="spendMonth" className="relative z-10">Spent this month</Term>
          <span className="money font-medium text-fg" data-testid="spend-month"><Tip className="relative z-10" text={`exact: ${exactMoney(p.spend_month)}`}>{formatMoney(p.spend_month)}</Tip></span>
        </div>
      </div>
      <span className="mt-auto text-body font-medium text-brand" aria-hidden="true" data-testid="card-open">Open project →</span>
    </article>
  );
}

/** The compact table of projects that are not cards: pre-v2 summaries, projects with no runs yet, the Unassigned record. */
function EarlierTable({ projects }: { projects: ProjectCard[] }) {
  return (
    <div id="earlier-table" className="overflow-auto rounded-lg border border-line bg-bg-1" data-testid="earlier-table">
      <table className="w-full text-body">
        <thead className="bg-bg-2 text-left text-caption font-medium text-fg-3">
          <tr>
            <th className="h-9 px-4 font-medium">Project</th>
            <th className="h-9 px-4 font-medium">Host</th>
            <th className="h-9 px-4 text-right font-medium"><Term term="runs">Runs</Term></th>
            <th className="h-9 px-4 text-right font-medium"><Term term="explored">Scenarios explored</Term></th>
            <th className="h-9 px-4 font-medium"><Term term="lastRun">Last run</Term></th>
            <th className="h-9 px-4 font-medium"><Term term="legacy">Record</Term></th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => {
            const unassigned = p.id === UNASSIGNED;
            const noRuns = p.runs === 0;
            return (
              <tr key={p.id} className="border-t border-line hover:bg-bg-2" data-testid="earlier-row" data-project-id={p.id}>
                <td className="px-4 py-3"><Link to={`/projects/${encodeURIComponent(p.id)}`} className="font-medium text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="earlier-name">{unassigned ? 'Unassigned' : p.name}</Link></td>
                <td className="px-4 py-3 text-fg-2" data-testid="earlier-host">{unassigned ? 'no URL' : (hostOf(p.base_url) || 'no base URL')}</td>
                <td className="px-4 py-3 text-right tabular-nums text-fg" data-testid="earlier-runs">{p.runs}</td>
                <td className="px-4 py-3 text-right tabular-nums text-fg" data-testid="earlier-explored">{noRuns ? <span className="text-fg-2">none</span> : p.legacy_explored}</td>
                <td className="px-4 py-3 text-fg-2" data-testid="earlier-last">{p.last_run ? <Tip text={formatDateTime(p.last_run.started_at)}>{formatDate(p.last_run.started_at)}</Tip> : <span className="text-fg-2">no runs yet</span>}</td>
                <td className="px-4 py-3"><Term term={noRuns ? 'runs' : 'legacy'} className="text-caption text-fg-2">{noRuns ? 'no runs' : 'summary only'}</Term></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
