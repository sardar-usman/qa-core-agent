import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { api, ApiError, type RunDetail, type RunDetailScenario } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { StageView, formatSize } from '@/components/StageView';
import { connectGateway, followRun, startCommand, useGateway, type LiveEvent, type LiveRun } from '@/lib/gateway';
import { resumeCommand, transcribeCommand } from '@/lib/command';
import { readOverrides } from '@/lib/session-overrides';
import { liveStagesFrom } from '@/lib/live-stages';
import { fmtDate, usd } from '@/lib/utils';

/**
 * Run Detail: one run, from its stored artifacts only. Every value on this
 * page is a field of /api/runs/:id/detail, which reads output/<host>/<run-id>/
 * (run-report.json, events.jsonl, the files present) or the index row built
 * from those files. Nothing is computed here.
 *
 * Layout (PR B2): the six-stage view (rail + Discovery, Plan, Explore, Review,
 * Verify, Summary) first, rendered from the payload's `stages` block; then the
 * per-scenario table from PR B; then artifacts and the stored events log.
 * Findings live in the Summary panel, unmatched verdicts and the Critic
 * summary in the Review panel.
 *
 * Live mode (PR C): while the gateway is running this run, the same stage view
 * is fed from the event stream (lib/live-stages.ts) with pending and running
 * statuses, the runtime's console lines go to a collapsible log, and the
 * events section shows the stream as it arrives. When run_report lands the
 * page fetches the detail payload and renders it exactly as a history view,
 * so the live and historical renderings of a finished run are identical.
 */
export function RunDetailPage() {
  const { id = '' } = useParams();
  const gw = useGateway();
  const live = gw.live && gw.live.runId === id ? gw.live : null;
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  // History fetch: on load, when a live run for this id finishes, and when a regenerate lands a new zip on disk.
  const liveFinished = live?.status === 'finished';
  const liveRunning = !!live && live.status === 'running';
  useEffect(() => {
    if (liveRunning) return;
    let alive = true;
    setDetail(null); setError(null);
    api.runDetail(id)
      .then((d) => { if (alive) setDetail(d); })
      .catch((e: unknown) => {
        if (!alive) return;
        const status = e instanceof ApiError ? e.status : 0;
        // A run that just finished may be a beat ahead of the index; retry a few times before showing the 404.
        if (liveFinished && status === 404 && attempt < 5) { setTimeout(() => { if (alive) setAttempt((a) => a + 1); }, 600); return; }
        setError({ status, message: (e as Error).message });
      });
    return () => { alive = false; };
  }, [id, liveRunning, liveFinished, attempt, gw.regenerated]);

  // Not started here but the gateway says this id is running (a reload mid-run): follow it from its folder.
  useEffect(() => { if (!live && gw.activeRun?.run_id === id) followRun(id); }, [id, live, gw.activeRun]);

  if (live && live.status === 'running') return <LiveView run={live} socket={gw.socket} />;

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <EmptyState title={error.status === 404 ? 'Run not found' : error.status === 401 ? 'Unauthorized' : 'Could not load this run'}>
          <span className="mono" data-testid="detail-error">{error.message}</span>
          {live?.outcome && Array.isArray(live.outcome.diagnosis) ? <div className="mt-2 text-s text-fg-2" data-testid="live-diagnosis">{(live.outcome.diagnosis as string[]).join(' ')}</div> : null}
          {live?.status === 'failed' && live.error ? <div className="mt-2 text-s text-reject" data-testid="live-failed">{live.error}</div> : null}
        </EmptyState>
        {live ? <RunLog log={live.log} /> : null}
      </div>
    );
  }
  if (!detail) return <div className="text-s text-fg-2">{liveFinished ? 'Run finished, loading its report…' : 'Loading…'}</div>;

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
          {!detail.legacy ? <RunActions run={detail.run} activeRunId={gw.activeRun?.run_id ?? null} socket={gw.socket} /> : null}
        </div>
        <dl className="grid gap-3 sm:grid-cols-4">
          <Fact label="started" value={fmtDate(h.started_at)} title={h.started_at ?? ''} testid="detail-started" />
          <Fact label="ended" value={fmtDate(h.ended_at)} title={h.ended_at ?? ''} testid="detail-ended" />
          <Fact label="total cost" value={usd(h.cost.total)} mono cost testid="detail-cost" sub={`planner ${usd(h.cost.planner)} · explorer ${usd(h.cost.explorer)} · critic ${usd(h.cost.critic)}${h.cost.repair ? ` · repair ${usd(h.cost.repair)}` : ''}`} />
          <Fact label="source" value={h.source ?? 'unknown'} testid="detail-source" sub={h.url ? <a href={h.url} target="_blank" rel="noreferrer" className="text-accent hover:underline" data-testid="detail-site-link">{h.url}</a> : undefined} />
        </dl>
        {h.stopped_reason ? <div className="rounded-md border border-transparent bg-rework-soft px-3 py-2 text-s text-rework" data-testid="detail-stopped">stopped early: {h.stopped_reason}</div> : null}
        {gw.lastRegenerated && gw.lastRegenerated.reportPath === detail.run.report_path ? (
          <div className="rounded-md border border-transparent bg-pass-soft px-3 py-2 text-s text-pass" data-testid="regenerated-note">Framework regenerated at {new Date(gw.lastRegenerated.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}, {gw.lastRegenerated.fileCount} files, {(gw.lastRegenerated.sizeBytes / 1024).toFixed(1)} KB</div>
        ) : null}
      </header>

      {detail.legacy ? (
        <section className="flex flex-col gap-3">
          <div className="rounded-lg border border-line bg-bg-1 px-4 py-3 text-m" data-testid="legacy-notice">pre-v2 record, per-scenario detail not captured</div>
          <dl className="grid gap-3 sm:grid-cols-4">
            <Fact label="scenarios explored" value={String(detail.summary.explored)} testid="legacy-explored" />
            <Fact label="total cost" value={usd(detail.summary.cost_total)} mono cost testid="legacy-cost" />
            <Fact label="duration" value={detail.summary.duration_sec != null ? `${detail.summary.duration_sec}s` : '–'} testid="legacy-duration" />
            <Fact label="model" value={detail.summary.model ?? '–'} mono testid="legacy-model" />
          </dl>
        </section>
      ) : (
        <>
          <StageView stages={detail.stages} findings={detail.findings} unmatched={detail.unmatched_verdicts} />

          <section className="flex flex-col gap-2" data-testid="scenarios-section">
            <h2 className="text-m font-semibold">Scenarios <span className="text-s font-normal text-fg-3" data-testid="scenarios-subtitle">{detail.stages.explore.scenarios_recorded} recorded · {detail.stages.explore.skipped.length} skipped</span></h2>
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
        </>
      )}

      <section data-testid="artifacts-section">
        <h2 className="text-m font-semibold">Artifacts <span className="text-s font-normal text-fg-3">{detail.artifacts.length} file{detail.artifacts.length === 1 ? '' : 's'} in the run folder</span></h2>
        {detail.artifacts.length === 0 ? <div className="mt-2 text-s text-fg-3">{detail.legacy ? 'No run folder: this record predates per-run directories.' : 'No files present.'}</div> : (
          <ul className="mt-2 flex flex-wrap gap-2">
            {detail.artifacts.map((a) => (
              <li key={a.name}>
                <Button variant="outline" size="sm" asChild>
                  <a href={api.withToken(a.href)} data-testid="artifact-link" data-kind={a.kind}>{a.kind === 'srs' ? 'SRS: ' : ''}{a.name} <span className="ml-1 font-normal opacity-70">{formatSize(a.size)}</span></a>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <EventsSection status={detail.events_status} events={detail.events} />
      {live ? <RunLog log={live.log} /> : null}
    </div>
  );
}

/* ─────────────────── resume and regenerate ─────────────────── */

/**
 * Resume (a stopped run with its checkpoint.json) and Regenerate framework
 * (a completed run's run-report.json). Both send a slash command through the
 * gateway's parser, the same request layer the Terminal uses: /resume and
 * /transcribe. Neither appears on a legacy record; each is disabled with the
 * reason while any run is live.
 */
function RunActions({ run, activeRunId, socket }: { run: { status: string; checkpoint_path: string | null; report_path: string | null }; lang?: 'ts' | 'js'; activeRunId: string | null; socket: string }) {
  const [ceiling, setCeiling] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const blocker = socket !== 'connected' ? 'the gateway socket is not connected' : activeRunId ? `a run is already in progress: ${activeRunId}` : null;
  const canResume = run.status === 'stopped' && !!run.checkpoint_path;
  const canRegenerate = run.status === 'completed' && !!run.report_path;
  if (!canResume && !canRegenerate) return null;
  const go = (content: string) => { if (startCommand({ content, lang: 'ts', env: readOverrides() })) setSent(content); };
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2" data-testid="run-actions">
      {canResume ? (
        <>
          <input className="h-8 w-28 rounded-md border border-line-strong bg-bg-2 px-2 text-s text-fg placeholder:text-fg-3" placeholder="ceiling USD" inputMode="decimal" value={ceiling} onChange={(e) => setCeiling(e.target.value)} data-testid="resume-ceiling" aria-label="Resume cost ceiling" />
          <Button type="button" size="sm" disabled={!!blocker || !!sent} title={blocker ?? resumeCommand(run.checkpoint_path!, ceiling)} onClick={() => go(resumeCommand(run.checkpoint_path!, ceiling))} data-testid="resume">Resume</Button>
        </>
      ) : null}
      {canRegenerate ? <Button type="button" size="sm" variant="outline" disabled={!!blocker || !!sent} title={blocker ?? transcribeCommand(run.report_path!)} onClick={() => go(transcribeCommand(run.report_path!))} data-testid="regenerate">Regenerate framework</Button> : null}
      {blocker ? <span className="text-s text-fg-2" data-testid="actions-blocker">{blocker}</span> : sent ? <span className="mono text-s text-fg-2" data-testid="actions-sent">sent {sent}</span> : null}
    </div>
  );
}

/* ─────────────────── live mode ─────────────────── */

function LiveView({ run, socket }: { run: LiveRun; socket: string }) {
  const stages = liveStagesFrom(run);
  const url = typeof run.request.url === 'string' ? run.request.url : null;
  const host = (() => { try { return url ? new URL(url).host : null; } catch { return null; } })();
  return (
    <div className="flex flex-col gap-6" data-testid="run-detail" data-legacy="false" data-live="true">
      <BackLink />
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-m font-semibold" data-testid="detail-host">{host ?? run.runId}</h1>
          <span className="mono text-s text-fg-3" data-testid="detail-run-id">{run.runId}</span>
          <StatusBadge status="running" />
          <Badge variant="outline">{run.command}</Badge>
          {run.runDir ? <span className="mono text-s text-fg-2" data-testid="live-run-dir">{run.runDir}</span> : null}
        </div>
        {socket !== 'connected' ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-transparent bg-rework-soft px-3 py-2 text-s text-rework" data-testid="socket-lost">
            <span>Connection to the gateway was lost. The run continues on the gateway; on reconnect this page catches up from the run folder.</span>
            <Button type="button" size="sm" variant="outline" onClick={() => connectGateway()} data-testid="reconnect"><RefreshCw className="h-3.5 w-3.5" /> Reconnect</Button>
          </div>
        ) : null}
        {run.caughtUp ? <div className="text-s text-fg-2" data-testid="caught-up">Caught up from the run folder: {run.events.length} stored event{run.events.length === 1 ? '' : 's'}.</div> : null}
      </header>

      <StageView stages={stages} findings={[]} unmatched={[]} live />

      <RunLog log={run.log} />
      <EventsSection status={run.events.length ? 'present' : 'empty'} events={run.events} live />
    </div>
  );
}

function RunLog({ log }: { log: string[] }) {
  return (
    <details className="rounded-lg border border-line bg-bg-1" data-testid="run-log">
      <summary className="cursor-pointer px-4 py-3 text-m font-semibold">Log <span className="text-s font-normal text-fg-3">{log.length} line{log.length === 1 ? '' : 's'} from the runtime; shown as text only, never read as a number</span></summary>
      {log.length === 0 ? <div className="px-4 pb-4 text-s text-fg-3">No console lines yet.</div> : (
        <pre className="mono max-h-[360px] overflow-auto whitespace-pre-wrap px-4 pb-4 text-s text-fg-2" data-testid="run-log-lines">{log.join('\n')}</pre>
      )}
    </details>
  );
}

/* ─────────────────── shared pieces ─────────────────── */

function EventsSection({ status, events, live = false }: { status: 'present' | 'empty' | 'absent'; events: Array<LiveEvent | { t: string; type: string; [k: string]: unknown }> | null; live?: boolean }) {
  return (
    <details className="rounded-lg border border-line bg-bg-1" data-testid="events-section" open={live || undefined}>
      <summary className="cursor-pointer px-4 py-3 text-m font-semibold">Events <span className="text-s font-normal text-fg-3" data-testid="events-status">{status === 'absent' ? 'no events log' : status === 'empty' ? (live ? 'waiting for the first event' : 'none recorded') : `${events!.length} ${live ? 'so far' : 'recorded'}, oldest first`}</span></summary>
      {status === 'present' && events?.some((e) => e.type === 'transcribe') ? (() => { const t = [...events].reverse().find((e) => e.type === 'transcribe')!; return <div className="mx-4 mb-2 rounded-md bg-pass-soft px-3 py-1.5 text-s text-pass" data-testid="transcribe-pin">framework regenerated {new Date(t.t).toLocaleString()} via {String(t.source ?? 'unknown')}</div>; })() : null}
      {status === 'absent' ? <div className="px-4 pb-4 text-s text-fg-3" data-testid="events-note">No events log; this run predates event capture</div>
        : status === 'empty' ? <div className="px-4 pb-4 text-s text-fg-3" data-testid="events-note">{live ? 'No events yet' : 'No events recorded'}</div> : (
        <ol className="max-h-[420px] overflow-auto px-4 pb-4 font-mono text-s text-fg-2">
          {events!.map((e, i) => (
            <li key={i} className="flex gap-3 border-t border-line/50 py-1" data-testid="event-row">
              <span className="shrink-0 text-fg-3">{new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              <span className="shrink-0 text-accent">{e.type}</span>
              <span className="truncate">{describeEvent(e)}</span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function BackLink({ projectId, projectName }: { projectId?: string; projectName?: string }) {
  return (
    <Link to={projectId ? `/runs?project_id=${encodeURIComponent(projectId)}` : '/runs'} className="inline-flex items-center gap-1 text-s text-fg-2 hover:text-fg" data-testid="back-link">
      <ArrowLeft className="h-3.5 w-3.5" /> {projectName ? `Back to ${projectName}` : 'Back to runs'}
    </Link>
  );
}

function Fact({ label, value, sub, title, mono, cost, testid }: { label: string; value: string; sub?: React.ReactNode; title?: string; mono?: boolean; cost?: boolean; testid: string }) {
  return (
    <div className="rounded-lg border border-line bg-bg-1 p-3" title={title}>
      <dd className={`text-l font-semibold leading-none ${mono ? 'mono' : ''} ${cost ? 'text-cost' : ''}`} data-testid={testid}>{value}</dd>
      <dt className="mt-1 text-s text-fg-2">{label}</dt>
      {sub ? <div className="mt-1 break-words text-s text-fg-3" data-testid={`${testid}-sub`}>{sub}</div> : null}
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
      <TableCell><span className={s.repair === 'repaired' ? 'text-pass' : s.repair === 'failed' ? 'text-reject' : 'text-fg-3'} data-testid="repair" data-repair={s.repair}>{repairLabel}</span>{s.repair !== 'none' && s.repair_second ? <div className="text-s text-fg-3">rework to {s.repair_second}</div> : null}</TableCell>
      <TableCell>{s.replay ? <span className={s.replay === 'pass' ? 'text-pass' : 'text-reject'} data-testid="replay" data-replay={s.replay}>{s.replay}</span> : <span className="text-fg-3">–</span>}{s.replay_error ? <div className="max-w-xs truncate text-s text-fg-3" title={s.replay_error}>{s.replay_error}</div> : null}</TableCell>
      <TableCell>{s.stability ? <span className="mono" data-testid="stability">{s.stability.passes}/{s.stability.iterations}{s.stability.pattern ? <span className="ml-1 text-fg-3">{s.stability.pattern}</span> : null}{s.stability.recovered ? <span className="ml-1 text-pass">recovered</span> : null}</span> : <span className="text-fg-3">–</span>}</TableCell>
      <TableCell><span className={s.shipped ? 'text-pass' : 'text-fg-3'} data-testid="shipped" data-shipped={s.shipped ? 'yes' : 'no'}>{s.shipped ? 'yes' : 'no'}</span></TableCell>
    </TableRow>
  );
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
