import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api, ApiError, type RunDetail, type RunDetailScenario } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { fmtDate, money } from '@/lib/utils';

/**
 * Run Detail: one run, from its stored artifacts only. Every value on this
 * page is a field of /api/runs/:id/detail, which reads output/<host>/<run-id>/
 * (run-report.json, events.jsonl, the files present) or the index row built
 * from those files. Nothing is computed here.
 */
export function RunDetailPage() {
  const { id = '' } = useParams();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  useEffect(() => {
    let live = true;
    setDetail(null); setError(null);
    api.runDetail(id)
      .then((d) => { if (live) setDetail(d); })
      .catch((e: unknown) => { if (live) setError({ status: e instanceof ApiError ? e.status : 0, message: (e as Error).message }); });
    return () => { live = false; };
  }, [id]);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState title={error.status === 404 ? 'Run not found' : error.status === 401 ? 'Unauthorized' : 'Could not load this run'}>
          <span className="mono" data-testid="detail-error">{error.message}</span>
        </EmptyState>
      </div>
    );
  }
  if (!detail) return <div className="text-s text-fg-3">Loading…</div>;

  const h = detail.header;
  return (
    <div className="flex flex-col gap-6" data-testid="run-detail" data-legacy={detail.legacy ? 'true' : 'false'}>
      <BackLink projectId={h.project_id} projectName={h.project_name} />

      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-m font-semibold" data-testid="detail-host">{h.host ?? h.project_name}</h1>
          <span className="mono text-s text-fg-3" data-testid="detail-run-id">{h.run_id}</span>
          <StatusBadge status={h.status} />
          {h.environment ? <Badge variant="accent" data-testid="env-badge">{h.environment}</Badge> : null}
          {detail.legacy ? <Badge variant="neutral">summary only (pre-v2)</Badge> : null}
        </div>
        <dl className="grid gap-3 sm:grid-cols-4">
          <Fact label="started" value={fmtDate(h.started_at)} title={h.started_at ?? ''} testid="detail-started" />
          <Fact label="ended" value={fmtDate(h.ended_at)} title={h.ended_at ?? ''} testid="detail-ended" />
          <Fact label="total cost" value={money(h.cost.total, 4)} mono cost testid="detail-cost" sub={`planner ${money(h.cost.planner, 4)} · explorer ${money(h.cost.explorer, 4)} · critic ${money(h.cost.critic, 4)}${h.cost.repair ? ` · repair ${money(h.cost.repair, 4)}` : ''}`} />
          <Fact label="source" value={h.source} testid="detail-source" sub={h.url ?? undefined} />
        </dl>
        {h.stopped_reason ? <div className="rounded-md border border-transparent bg-rework-soft px-3 py-2 text-s text-rework" data-testid="detail-stopped">stopped early: {h.stopped_reason}</div> : null}
      </header>

      {detail.legacy ? (
        <section className="flex flex-col gap-3">
          <div className="rounded-lg border border-line bg-bg-1 px-4 py-3 text-m" data-testid="legacy-notice">pre-v2 record, per-scenario detail not captured</div>
          <dl className="grid gap-3 sm:grid-cols-4">
            <Fact label="scenarios explored" value={String(detail.summary.explored)} testid="legacy-explored" />
            <Fact label="total cost" value={money(detail.summary.cost_total, 4)} mono cost testid="legacy-cost" />
            <Fact label="duration" value={detail.summary.duration_sec != null ? `${detail.summary.duration_sec}s` : '–'} testid="legacy-duration" />
            <Fact label="model" value={detail.summary.model ?? '–'} mono testid="legacy-model" />
          </dl>
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-2" data-testid="scenarios-section">
            <h2 className="text-m font-semibold">Scenarios <span className="text-s font-normal text-fg-3">{detail.scenarios.length} planned or recorded · {detail.counts.shipped ?? 0} shipped as stored</span></h2>
            {detail.scenarios.length === 0 ? <EmptyState title="No scenarios recorded">The report holds no plan, verdicts or emitted scenarios for this run.</EmptyState> : (
              <Table data-testid="scenarios-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Scenario</TableHead>
                    <TableHead>Critic verdict</TableHead>
                    <TableHead>Repair</TableHead>
                    <TableHead>Replay</TableHead>
                    <TableHead>Stability</TableHead>
                    <TableHead>Shipped</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.scenarios.map((s) => <ScenarioRow key={s.name} s={s} />)}
                </TableBody>
              </Table>
            )}
          </section>

          <section className="rounded-lg border border-finding/40 bg-finding-soft p-4" data-testid="findings-section">
            <h2 className="text-m font-semibold text-finding" data-testid="findings-heading">Product behavior to review <span className="mono text-s font-normal">{detail.findings.length}</span></h2>
            <p className="mt-1 text-s text-fg-2">A finding is product behavior the agent observed that differed from what the scenario expected. It is not a test failure and is not a scenario row.</p>
            {detail.findings.length === 0 ? (
              <div className="mt-3 text-s text-fg-2" data-testid="no-findings">No findings recorded</div>
            ) : (
              <ul className="mt-3 flex flex-col gap-2">
                {detail.findings.map((f) => (
                  <li key={f.scenario} className="rounded-md border border-line bg-bg-1 px-3 py-2" data-testid="finding">
                    <div className="font-semibold text-finding">{f.scenario}</div>
                    <div className="text-s text-fg-2"><span className="font-semibold text-fg">Expected</span> {f.expected}</div>
                    <div className="text-s text-fg-2"><span className="font-semibold text-fg">What happened</span> the page stayed at <span className="mono">{f.url}</span>{f.messages.length ? `; it said "${f.messages.join(' | ')}"` : ''}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {detail.unmatched_verdicts.length ? (
            <section className="rounded-lg border border-transparent bg-rework-soft p-4" data-testid="unmatched-verdicts">
              <h2 className="text-m font-semibold text-rework">Critic verdicts that matched no scenario <span className="mono text-s font-normal">{detail.unmatched_verdicts.length}</span></h2>
              <p className="mt-1 text-s text-fg-2">These verdicts came back with names that matched no planned or recorded scenario, even after tolerant matching. They are not scenario rows; nothing is dropped silently.</p>
              <ul className="mt-2 flex flex-col gap-1">
                {detail.unmatched_verdicts.map((v) => <li key={v.scenario} className="text-s" data-testid="unmatched-verdict"><Badge variant={VERDICT_VARIANT[v.verdict as keyof typeof VERDICT_VARIANT] ?? 'neutral'}>{v.verdict}</Badge> <span className="ml-2 text-fg">{v.scenario}</span>{v.reasons.length ? <span className="text-fg-3"> · {v.reasons.join(' · ')}</span> : null}</li>)}
              </ul>
            </section>
          ) : null}
          {detail.review_summary ? <section><h2 className="text-m font-semibold">Critic summary</h2><p className="mt-1 text-s text-fg-2">{detail.review_summary}</p></section> : null}
        </>
      )}

      <section data-testid="artifacts-section">
        <h2 className="text-m font-semibold">Artifacts <span className="text-s font-normal text-fg-3">{detail.artifacts.length} file{detail.artifacts.length === 1 ? '' : 's'} in the run folder</span></h2>
        {detail.artifacts.length === 0 ? <div className="mt-2 text-s text-fg-3">{detail.legacy ? 'No run folder: this record predates per-run directories.' : 'No files present.'}</div> : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {detail.artifacts.map((a) => (
              <li key={a.name}>
                <Button variant={a.kind === 'zip' ? 'default' : 'outline'} size="sm" asChild>
                  <a href={api.withToken(a.href)} data-testid="artifact-link" data-kind={a.kind}>{a.kind === 'zip' ? 'Download ' : ''}{a.name} <span className="ml-1 font-normal opacity-70">{formatSize(a.size)}</span></a>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="rounded-lg border border-line bg-bg-1" data-testid="events-section">
        <summary className="cursor-pointer px-4 py-3 text-m font-semibold">Events <span className="text-s font-normal text-fg-3" data-testid="events-status">{detail.events_status === 'absent' ? 'no events log' : detail.events_status === 'empty' ? 'none recorded' : `${detail.events!.length} recorded, oldest first`}</span></summary>
        {detail.events_status === 'absent' ? <div className="px-4 pb-4 text-s text-fg-3" data-testid="events-note">No events log; this run predates event capture</div>
          : detail.events_status === 'empty' ? <div className="px-4 pb-4 text-s text-fg-3" data-testid="events-note">No events recorded</div> : (
          <ol className="max-h-[420px] overflow-auto px-4 pb-4 font-mono text-s text-fg-2">
            {detail.events!.map((e, i) => (
              <li key={i} className="flex gap-3 border-t border-line/50 py-1" data-testid="event-row">
                <span className="shrink-0 text-fg-3">{new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                <span className="shrink-0 text-accent">{e.type}</span>
                <span className="truncate">{describeEvent(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}

function BackLink({ projectId, projectName }: { projectId?: string; projectName?: string }) {
  return (
    <Link to={projectId ? `/runs?project_id=${encodeURIComponent(projectId)}` : '/runs'} className="inline-flex items-center gap-1 text-s text-fg-2 hover:text-fg" data-testid="back-link">
      <ArrowLeft className="h-3.5 w-3.5" /> {projectName ? `Back to ${projectName}` : 'Back to runs'}
    </Link>
  );
}

function Fact({ label, value, sub, title, mono, cost, testid }: { label: string; value: string; sub?: string; title?: string; mono?: boolean; cost?: boolean; testid: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg-1 p-3" title={title}>
      <dd className={`text-l font-semibold leading-none ${mono ? 'mono' : ''} ${cost ? 'text-cost' : ''}`} data-testid={testid}>{value}</dd>
      <dt className="mt-1 text-s text-fg-2">{label}</dt>
      {sub ? <div className="mt-1 truncate text-s text-fg-3" title={sub}>{sub}</div> : null}
    </div>
  );
}

const VERDICT_VARIANT = { pass: 'pass', rework: 'rework', reject: 'reject' } as const;

function ScenarioRow({ s }: { s: RunDetailScenario }) {
  const repairLabel = s.repair === 'none' ? 'none' : s.repair === 'repaired' ? 'repaired' : 'failed';
  return (
    <TableRow data-testid="scenario-row" data-scenario={s.name}>
      <TableCell>
        <div className="font-semibold">{s.name}</div>
        <div className="flex flex-wrap gap-1 text-s text-fg-3">
          {s.feature ? <span>{s.feature}</span> : null}{s.category ? <span>· {s.category}</span> : null}
          {s.dropped_at ? <span>· dropped at {s.dropped_at}: {s.dropped_reason}</span> : null}
          {s.incomplete_reason ? <span>· incomplete: {s.incomplete_reason}</span> : null}
          {s.skipped_reason ? <span>· skipped: {s.skipped_reason}</span> : null}
        </div>
      </TableCell>
      <TableCell>
        {s.verdict ? <Badge variant={VERDICT_VARIANT[s.verdict]} data-testid="verdict" data-verdict={s.verdict}>{s.verdict}</Badge> : <span className="text-fg-3">–</span>}
        {s.reasons.length ? <div className="mt-1 max-w-xs text-s text-fg-3">{s.reasons.join(' · ')}</div> : null}
      </TableCell>
      <TableCell><span className={s.repair === 'repaired' ? 'text-pass' : s.repair === 'failed' ? 'text-reject' : 'text-fg-3'} data-testid="repair" data-repair={s.repair}>{repairLabel}</span>{s.repair !== 'none' && s.repair_second ? <div className="text-s text-fg-3">rework → {s.repair_second}</div> : null}</TableCell>
      <TableCell>{s.replay ? <span className={s.replay === 'pass' ? 'text-pass' : 'text-reject'} data-testid="replay" data-replay={s.replay}>{s.replay}</span> : <span className="text-fg-3">–</span>}{s.replay_error ? <div className="max-w-xs truncate text-s text-fg-3" title={s.replay_error}>{s.replay_error}</div> : null}</TableCell>
      <TableCell>{s.stability ? <span className="mono" data-testid="stability">{s.stability.passes}/{s.stability.iterations}{s.stability.pattern ? <span className="ml-1 text-fg-3">{s.stability.pattern}</span> : null}{s.stability.recovered ? <span className="ml-1 text-pass">recovered</span> : null}</span> : <span className="text-fg-3">–</span>}</TableCell>
      <TableCell><span className={s.shipped ? 'text-pass' : 'text-fg-3'} data-testid="shipped" data-shipped={s.shipped ? 'yes' : 'no'}>{s.shipped ? 'yes' : 'no'}</span></TableCell>
    </TableRow>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function describeEvent(e: { type: string; [k: string]: unknown }): string {
  switch (e.type) {
    case 'message': return String(e.text ?? '');
    case 'tool_call': return `${String(e.name)}(${shortJson(e.input)})`;
    case 'tool_result': return `${String(e.name)} ${e.ok ? 'ok' : 'failed'}${e.error ? `: ${String(e.error)}` : ''}`;
    case 'plan_done': return `${Array.isArray(e.scenarios) ? e.scenarios.length : '?'} scenarios planned`;
    case 'critic_done': return `${Array.isArray(e.verdicts) ? e.verdicts.length : '?'} verdicts`;
    case 'replay_scenario_passed': case 'stability_iteration_passed': return String(e.name ?? '');
    case 'replay_scenario_failed': case 'stability_iteration_failed': return `${String(e.name ?? '')}: ${String(e.error ?? '')}`;
    case 'usage': return `$${Number(e.usd ?? 0).toFixed(4)}`;
    default: {
      const { t: _t, type: _type, ...rest } = e;
      const s = shortJson(rest);
      return s === '{}' ? '' : s;
    }
  }
}

function shortJson(v: unknown): string {
  try { const s = JSON.stringify(v); return s.length > 120 ? s.slice(0, 117) + '…' : s; } catch { return ''; }
}

