import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, FolderOpen } from 'lucide-react';
import { api, ApiError, type ProjectCard } from '@/lib/api';
import type { GlossaryKey } from '@/lib/glossary';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { NewProjectDialog } from '@/components/NewProjectDialog';
import { ProjectsSkeleton } from '@/components/Skeleton';
import { StatusWord } from '@/components/StatusBadge';
import { InfoTerm, InfoTip, Term, Tip } from '@/components/Term';
import { cn, exactMoney, fmtDate, hostOf, money } from '@/lib/utils';

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
    <PageHeader title={<Term term="projectsPage" className="decoration-line-strong">Projects</Term>} description="Each card is one website the agent has tested. Click a card to see its runs, tests and requirements.">
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
            <span className="tabular-nums" data-testid="earlier-count">{earlier.length}</span> <Term term="earlierExperiments">earlier experiment{earlier.length === 1 ? '' : 's'}</Term> {earlier.length === 1 ? 'is' : 'are'} hidden.{' '}
            <button type="button" className="rounded-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" onClick={() => setShowEarlier((v) => !v)} aria-expanded={showEarlier} aria-controls="earlier-table" data-testid="earlier-toggle">{showEarlier ? 'Hide' : 'Show'}</button>
          </p>
          {showEarlier ? <EarlierTable projects={earlier} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One project card (docs/ui/redesign-pr1/cards-target.png). The name is the
 * link; its ::after overlay stretches over the whole card so the card is
 * clickable without nesting interactive elements. Tooltip triggers (the
 * info icons, the status word, the date and the exact money value) sit
 * above the overlay (relative, z-10) so they open without navigating.
 * Every card has the same structure, so the cards share one height and the
 * footer is pinned to the bottom.
 */
function ProjectCardView({ p }: { p: ProjectCard }) {
  const last = p.last_run;
  const latest = last?.shipped ?? null;
  const cov = p.coverage_series.length ? p.coverage_series[p.coverage_series.length - 1]! : null;
  const href = `/projects/${encodeURIComponent(p.id)}`;
  return (
    <Card className="card-lift relative flex h-full flex-col" data-testid="project-card" data-project-id={p.id} data-href={href}>
      <CardHeader className="gap-3 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <CardTitle className="min-w-0 truncate" title={p.name}>
                <Link to={href} className="rounded-sm after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="project-card-link">{p.name}</Link>
              </CardTitle>
              {p.environment && p.environment !== 'other' ? <Badge variant={ENV_VARIANT[p.environment] ?? 'neutral'} className="shrink-0" data-testid="env-badge">{p.environment}</Badge> : null}
            </div>
            {p.base_url
              ? <Tip text={p.base_url} className="relative z-10 mt-1 block min-w-0"><p className="truncate text-s text-fg-3" data-testid="card-url">{p.base_url}</p></Tip>
              : <p className="mt-1 text-s text-fg-3" data-testid="card-url">no base URL</p>}
          </div>
          <ChevronRight className="h-4 w-4 shrink-0 text-fg-3" aria-hidden="true" />
        </div>
        <div className="flex items-center gap-2 text-s text-fg-2" data-testid="card-status-line">
          {last
            ? (<>
                <StatusWord status={last.status} className="relative z-10" prefix="Last run" />
                <span aria-hidden="true">·</span>
                <Tip text={last.started_at ?? 'start time not recorded'} className="relative z-10">{fmtDate(last.started_at)}</Tip>
              </>)
            : <span>No runs yet</span>}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4 pt-0">
        <dl className="grid grid-cols-3 gap-1.5" data-testid="card-tiles">
          <CardTile label="Verified tests" term="latestShipped" testid="latest-shipped" value={latest === null ? null : String(latest)} missing="pre-v2 summary" sub="in the latest run" />
          <CardTile label="To review" term="unresolvedFindings" testid="unresolved-findings" value={p.unresolved_findings === null ? null : String(p.unresolved_findings)} tone={p.unresolved_findings ? 'finding' : 'muted'} missing="no reported run" sub="product behavior" />
          <CardTile label="Spent" term="spendMonth" testid="spend-month" tone="cost" value={<Tip className="relative z-10" text={`exact: ${exactMoney(p.spend_month)}`}>{money(p.spend_month)}</Tip>} sub="this month" />
        </dl>
        <div className="flex flex-col gap-2" data-testid="card-coverage">
          <div className="flex items-center justify-between gap-2 text-s">
            <span className="flex items-center gap-1 text-fg-2">Requirements covered <InfoTerm term="coverage" className="relative z-10" /></span>
            {cov ? <span className="tabular-nums font-medium text-fg" data-testid="coverage-latest">{cov.covered} of {cov.total}</span> : null}
          </div>
          <div className="flex h-8 items-center">
            {cov
              ? (<div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-3" role="progressbar" aria-label="Requirements covered" aria-valuemin={0} aria-valuemax={100} aria-valuenow={cov.percent} data-testid="coverage-bar" data-percent={cov.percent}>
                  <div className="h-full rounded-full bg-accent" style={{ width: `${cov.percent}%` }} data-testid="coverage-bar-fill" />
                </div>)
              : <span className="text-s text-fg-3" data-testid="coverage-none">No requirements document used yet</span>}
          </div>
        </div>
        <div className="mt-auto flex items-center gap-1.5 border-t border-line pt-3 text-s text-fg-3" data-testid="card-footer">
          <span className="font-medium text-fg"><span data-testid="runs-count">{p.runs}</span> run{p.runs === 1 ? '' : 's'}</span>
          {p.shipped === null ? null : (<>
            <span aria-hidden="true">·</span>
            <span><span className="tabular-nums" data-testid="shipped">{p.shipped}</span> verified test{p.shipped === 1 ? '' : 's'} in total</span>
          </>)}
          {p.legacy_runs ? <InfoTip testid="legacy-note" label="About pre-v2 runs" className="relative z-10" text={`${p.legacy_runs} pre-v2 run${p.legacy_runs === 1 ? '' : 's'}, ${p.legacy_explored} scenario${p.legacy_explored === 1 ? '' : 's'} explored; pre-v2 runs have no verified-test count.`} /> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One metric tile on a card: a label with its glossary icon, the number,
 * one muted sub-line. A null value renders the reason in words, never a
 * number and never n/a.
 */
function CardTile({ label, term, value, sub, tone, testid, missing }: { label: string; term: GlossaryKey; value: ReactNode | null; sub: string; tone?: 'finding' | 'cost' | 'muted'; testid: string; missing?: string }) {
  return (
    <div className="flex min-w-0 flex-col rounded-md border border-line bg-bg-2 px-2.5 py-2.5">
      <dt className="flex items-center gap-1 whitespace-nowrap text-s text-fg-2"><span>{label}</span><InfoTerm term={term} className="relative z-10 h-3.5 w-3.5 [&>svg]:h-3 [&>svg]:w-3" /></dt>
      {value === null
        ? <dd className="mt-1.5 text-s text-fg-3" data-testid={`${testid}-missing`}>{missing ?? 'not recorded'}</dd>
        : <dd className={cn('money mt-1.5 text-l font-semibold leading-none', tone === 'finding' ? 'text-finding' : tone === 'cost' ? 'text-cost' : tone === 'muted' ? 'text-neutral' : 'text-fg')} data-testid={testid}>{value}</dd>}
      <dd className="mt-1.5 text-s text-fg-3">{sub}</dd>
    </div>
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
            <th className="h-9 px-4"><Term term="legacy">Record</Term></th>
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
