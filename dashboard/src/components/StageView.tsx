import { Download } from 'lucide-react';
import { api, type RunDetailFinding, type RunDetailStages, type StageKey, type StageStatus } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { usd } from '@/lib/utils';

/**
 * The six-stage run view (dashboard v2 plan, PR B, deferred part), ported
 * from the legacy UI. Rendered from the detail payload's `stages` block only:
 * every number on screen is a report field the server copied. Nothing is
 * computed here; the one derived value (explorer = usd minus repair) is done
 * server-side, as invariant 47 allows. Live events are PR C.
 */

const STAGES: Array<{ key: StageKey; num: number; name: string; sub: string }> = [
  { key: 'discovery', num: 1, name: 'Discovery', sub: 'which pages' },
  { key: 'plan', num: 2, name: 'Plan', sub: 'Haiku, one snapshot' },
  { key: 'explore', num: 3, name: 'Explore', sub: 'Opus drives the browser' },
  { key: 'review', num: 4, name: 'Review', sub: 'Sonnet critiques every trace' },
  { key: 'verify', num: 5, name: 'Verify', sub: 'replay, then 3x stability' },
  { key: 'summary', num: 6, name: 'Summary', sub: 'what shipped, what it cost' },
];

const STATUS_LABEL: Record<StageStatus, string> = { done: 'done', warning: 'warning', attention: 'to review', 'not-applicable': 'not run', pending: 'pending', running: 'running' };
// attention is product behavior to review: the finding token, never the warning token.
// pending and running exist only while a run is live (built from events, never from the report).
const STATUS_CLASS: Record<StageStatus, string> = { done: 'text-pass', warning: 'text-rework', attention: 'text-finding', 'not-applicable': 'text-fg-2', pending: 'text-fg-2', running: 'text-accent' };
const VERDICT_VARIANT = { pass: 'pass', rework: 'rework', reject: 'reject' } as const;
const CATEGORY_VARIANT: Record<string, 'pass' | 'reject' | 'rework' | 'neutral'> = { happy: 'pass', negative: 'reject', edge: 'rework' };

function scrollToStage(key: StageKey): void {
  document.getElementById(`stage-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export type UnmatchedVerdict = { scenario: string; verdict: string; reasons: string[] };

/**
 * `live` marks a run in progress: the stages come from the event stream, and
 * the Summary shows what will appear when the report lands instead of an
 * empty funnel. Once run_report arrives the page renders the report through
 * the same component with live off, identical to a history view.
 */
export function StageView({ stages, findings, unmatched, live = false }: { stages: RunDetailStages; findings: RunDetailFinding[]; unmatched: UnmatchedVerdict[]; live?: boolean }) {
  return (
    <div className="flex flex-col gap-4" data-testid="stage-view" data-live={live ? 'true' : 'false'}>
      <nav className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Pipeline stages" data-testid="stage-rail">
        {STAGES.map((s) => {
          const st = stages[s.key];
          return (
            <button key={s.key} type="button" onClick={() => scrollToStage(s.key)} className="flex flex-col items-start gap-1 rounded-lg border border-line bg-bg-1 px-3 py-2 text-left hover:border-line-strong" data-testid="rail-item" data-stage={s.key} data-status={st.status} title={`Jump to ${s.name}`}>
              <span className="flex w-full items-center gap-2 text-s"><span className="mono text-fg-2">{s.num}</span><span className="font-semibold text-fg">{s.name}</span><span className={`ml-auto ${STATUS_CLASS[st.status]} ${st.status === 'running' ? 'animate-pulse' : ''}`} data-testid="rail-status">{STATUS_LABEL[st.status]}</span></span>
              <span className="mono whitespace-normal break-words text-s leading-snug text-fg-2" data-testid="rail-stat">{st.stat}</span>
            </button>
          );
        })}
      </nav>

      <Panel k="discovery" s={stages.discovery.status}><Discovery d={stages.discovery} /></Panel>
      <Panel k="plan" s={stages.plan.status}><Plan p={stages.plan} /></Panel>
      <Panel k="explore" s={stages.explore.status}><Explore e={stages.explore} /></Panel>
      <Panel k="review" s={stages.review.status}><Review r={stages.review} unmatched={unmatched} /></Panel>
      <Panel k="verify" s={stages.verify.status}><Verify v={stages.verify} /></Panel>
      <Panel k="summary" s={stages.summary.status}><Summary sm={stages.summary} findings={findings} live={live} /></Panel>
    </div>
  );
}

function Panel({ k, s, children }: { k: StageKey; s: StageStatus; children: React.ReactNode }) {
  const meta = STAGES.find((x) => x.key === k)!;
  return (
    <section id={`stage-${k}`} className="scroll-mt-4 rounded-lg border border-line bg-bg-1 p-4" data-testid="stage-panel" data-stage={k} data-status={s}>
      <header className="mb-3 flex flex-wrap items-baseline gap-2">
        <span className="mono text-s text-fg-2">{meta.num}</span>
        <h2 className="text-m font-semibold">{meta.name}</h2>
        <span className="text-s text-fg-2">{meta.sub}</span>
        <span className={`ml-auto text-s ${STATUS_CLASS[s]}`} data-testid="panel-status">{STATUS_LABEL[s]}</span>
      </header>
      {children}
    </section>
  );
}

function KV({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-1 text-s text-fg-2">{children}</div>;
}
function K({ label, value, mono, cost, testid }: { label: string; value: React.ReactNode; mono?: boolean; cost?: boolean; testid?: string }) {
  return <span>{label} <b className={`${mono || cost ? 'mono' : ''} ${cost ? 'text-cost' : 'text-fg'}`} data-testid={testid}>{value}</b></span>;
}
function SubLabel({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 mb-1 text-s font-semibold uppercase tracking-wide text-fg-2">{children}</div>;
}
function Empty({ children, testid }: { children: React.ReactNode; testid?: string }) {
  return <div className="rounded-md border border-dashed border-line-strong px-3 py-2 text-s text-fg-2" data-testid={testid}>{children}</div>;
}
function Row({ tag, tagVariant, name, why, mono }: { tag?: string; tagVariant?: 'pass' | 'rework' | 'reject' | 'finding' | 'neutral' | 'accent' | 'outline'; name: string; why?: string | null; mono?: boolean }) {
  return (
    <li className="flex flex-wrap items-baseline gap-2 border-t border-line/60 py-1 text-s first:border-t-0">
      {tag ? <Badge variant={tagVariant ?? 'neutral'}>{tag}</Badge> : null}
      <span className={`text-fg ${mono ? 'mono' : ''}`} title={name}>{name}</span>
      {why ? <span className="text-fg-2">{why}</span> : null}
    </li>
  );
}

function Discovery({ d }: { d: RunDetailStages['discovery'] }) {
  if (d.status === 'not-applicable') return <Empty testid="discovery-na">single-page run, no discovery</Empty>;
  const bySource: Record<string, number> = {};
  for (const p of d.pages) bySource[p.source] = (bySource[p.source] ?? 0) + 1;
  return (
    <>
      <KV>
        <K label="rung" value={d.method ?? '?'} mono testid="discovery-method" />
        <K label="pages" value={d.pages.length} testid="discovery-pages" />
        {Object.entries(bySource).map(([src, n]) => <K key={src} label={src} value={n} />)}
      </KV>
      <ul className="mt-2" data-testid="discovery-page-list">
        {d.pages.map((p) => (
          <li key={p.url} className="flex flex-wrap items-baseline gap-2 border-t border-line/60 py-1 text-s first:border-t-0" data-testid="discovery-page">
            <span className="mono truncate text-fg" title={p.url}>{p.url}</span>
            <Badge variant="outline">{p.source}</Badge>
            {p.feature ? <Badge variant="accent">{p.feature}</Badge> : null}
            {p.volatile ? <Badge variant="neutral">volatile</Badge> : null}
          </li>
        ))}
      </ul>
      {d.warnings.length ? (
        <>
          <SubLabel>Robots and rung warnings</SubLabel>
          <ul>{d.warnings.map((w, i) => <Row key={i} tag="warning" tagVariant="rework" name={w} />)}</ul>
        </>
      ) : <div className="mt-2 text-s text-fg-2">No robots or rung warnings recorded.</div>}
    </>
  );
}

function Plan({ p }: { p: RunDetailStages['plan'] }) {
  if (!p.scenarios.length) return <Empty testid="plan-empty">The Planner produced no scenarios on this run.</Empty>;
  const multiPage = p.pages.some((pg) => pg.url !== null);
  return (
    <>
      <KV>
        <K label="scenarios" value={p.scenarios.length} testid="plan-count" />
        <K label="planner" value={usd(p.planner_usd)} cost testid="plan-cost" />
      </KV>
      {multiPage ? (
        <>
          <SubLabel>Pages planned</SubLabel>
          <ul data-testid="plan-pages">{p.pages.map((pg, i) => <Row key={i} name={pg.url ?? '(entry page)'} why={`${pg.count} scenario${pg.count === 1 ? '' : 's'}`} mono />)}</ul>
          <div className="mt-1 text-s text-fg-2">Per-page planner cost is not recorded in run-report.json; the planner total above is.</div>
        </>
      ) : null}
      <SubLabel>Scenarios</SubLabel>
      <ul data-testid="plan-list">
        {p.scenarios.map((s) => (
          <li key={s.name} className="flex flex-wrap items-baseline gap-2 border-t border-line/60 py-1 text-s first:border-t-0" data-testid="plan-scenario">
            {s.feature ? <Badge variant="accent">{s.feature}</Badge> : null}
            {s.category ? <Badge variant={CATEGORY_VARIANT[s.category] ?? 'neutral'}>{s.category}</Badge> : null}
            {s.rule_ids.length ? <Badge variant="outline" data-testid="rule-tag">{s.rule_ids.join(',')}</Badge> : null}
            <span className="text-fg">{s.name}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Explore({ e }: { e: RunDetailStages['explore'] }) {
  return (
    <>
      <KV>
        <K label="steps" value={e.steps} testid="explore-steps" />
        <K label="scenarios recorded" value={e.scenarios_recorded} testid="explore-recorded" />
        <K label="explorer" value={usd(e.explorer_usd)} cost testid="explore-cost" />
        {e.repair_usd ? <K label="of which repair pass" value={usd(e.repair_usd)} cost /> : null}
        {e.heals.length ? <K label="recovered selectors" value={e.heals.length} testid="explore-heals-count" /> : null}
      </KV>
      <div className="mt-1 text-s text-fg-2">The step budget and the explorer sub-ceiling are console settings, not recorded in run-report.json; steps and cost above are the report's own.</div>
      {e.stopped ? <div className="mt-2 rounded-md bg-rework-soft px-3 py-2 text-s text-rework" data-testid="explore-stopped"><b>stopped</b> {e.stopped.reason}</div> : null}
      {e.gate_injections.length || e.gate_broken.length ? (
        <>
          <SubLabel>Gate</SubLabel>
          <KV>
            <K label="injections" value={e.gate_injections.length} testid="explore-gate-injections" />
            {e.gate_broken.length ? <span className="text-reject">broken <b>{e.gate_broken.length}</b></span> : null}
          </KV>
          <ul>
            {e.gate_injections.map((g, i) => <Row key={`i${i}`} tag={g.assertion_type} tagVariant="outline" name={g.scenario} why={`step ${g.step_index + 1}: ${g.detail}`} />)}
            {e.gate_broken.map((b, i) => <Row key={`b${i}`} tag="broken" tagVariant="reject" name={b.scenario} why={`${b.reason} (${b.attempts} attempt${b.attempts === 1 ? '' : 's'})`} />)}
          </ul>
        </>
      ) : null}
      {e.skipped.length ? (<><SubLabel>Skipped</SubLabel><ul data-testid="explore-skipped">{e.skipped.map((s) => <Row key={s.scenario} tag="skipped" name={s.scenario} why={s.reason} />)}</ul></>) : null}
      {e.incomplete.length ? (<><SubLabel>Incomplete</SubLabel><ul data-testid="explore-incomplete">{e.incomplete.map((s) => <Row key={s.scenario} tag="incomplete" name={s.scenario} why={s.reason} />)}</ul></>) : null}
      {e.heals.length ? (
        <>
          <SubLabel>Selector recoveries</SubLabel>
          <ul data-testid="explore-heals">
            {e.heals.map((h, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2 border-t border-line/60 py-1 text-s first:border-t-0" data-testid="explore-heal">
                <Badge variant="pass">recovered</Badge>
                {h.scenario ? <span className="text-fg">{h.scenario}</span> : null}
                <span className="text-fg-2">{h.intent}:</span>
                <span className="mono text-fg-2 line-through">{h.from}</span>
                <span className="text-fg-2">to</span>
                <span className="mono text-fg">{h.to}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {!e.gate_injections.length && !e.gate_broken.length && !e.skipped.length && !e.incomplete.length && !e.heals.length && !e.stopped ? <div className="mt-2 text-s text-fg-2">No gate injections, skips, incomplete scenarios or selector recoveries recorded.</div> : null}
    </>
  );
}

function Review({ r, unmatched }: { r: RunDetailStages['review']; unmatched: UnmatchedVerdict[] }) {
  if (!r.ran) return <Empty testid="review-na">The Critic did not run on this run.</Empty>;
  return (
    <>
      <KV>
        <span className="text-pass">pass <b data-testid="review-pass">{r.counts.pass}</b></span>
        <span className="text-rework">rework <b data-testid="review-rework">{r.counts.rework}</b></span>
        <span className="text-reject">reject <b data-testid="review-reject">{r.counts.reject}</b></span>
        <K label="critic" value={usd(r.critic_usd)} cost testid="review-cost" />
      </KV>
      {r.repair ? (
        <div className="mt-2 rounded-md bg-accent-soft px-3 py-2 text-s text-fg" data-testid="repair-banner"><b>repair pass</b> {r.repair.count} scenario{r.repair.count === 1 ? '' : 's'} re-explored · spent <span className="mono text-cost">{usd(r.repair.spent_usd)}</span> <span className="text-fg-2">(the repair budget is a console setting, not recorded in run-report.json)</span></div>
      ) : (
        <div className="mt-2 text-s text-fg-2" data-testid="repair-banner">{r.counts.rework + r.counts.reject === 0 ? 'Nothing gated: every scenario passed review, so no repair pass was needed.' : 'No repair pass recorded.'}</div>
      )}
      <SubLabel>Final verdicts</SubLabel>
      <div className="grid gap-2 md:grid-cols-2" data-testid="verdict-cards">
        {r.verdicts.map((v) => (
          <article key={v.scenario} className="rounded-md border border-line bg-bg-2 p-3" data-testid="verdict-card" data-verdict={v.verdict}>
            <div className="flex items-baseline gap-2"><Badge variant={VERDICT_VARIANT[v.verdict]}>{v.verdict}</Badge><span className="text-s font-semibold text-fg">{v.scenario}</span></div>
            {v.reasons.length ? <ul className="mt-1 list-disc pl-5 text-s text-fg-2">{v.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul> : null}
            {v.verdict !== 'pass' && v.required_fixes.length ? <div className="mt-1 text-s text-fg-2"><b className="text-fg">Why it matters:</b> {v.required_fixes.join(' ')}</div> : null}
          </article>
        ))}
      </div>
      {r.journeys.length ? (
        <>
          <SubLabel>Verdict journeys</SubLabel>
          <ul data-testid="journeys">
            {r.journeys.map((j) => (
              <li key={j.scenario} className="flex flex-wrap items-center gap-2 border-t border-line/60 py-1 text-s first:border-t-0" data-testid="journey" data-outcome={j.outcome}>
                <span className="text-fg">{j.scenario}</span>
                <Badge variant="rework">{j.first}</Badge>
                <span className="text-fg-2">to</span>
                <Badge variant={j.second === 'pass' ? 'pass' : j.second === 'reject' ? 'reject' : j.second === 'rework' ? 'rework' : 'neutral'}>{j.second ?? 'not re-recorded'}</Badge>
                <span className={j.outcome === 'kept' ? 'text-pass' : 'text-reject'}>{j.outcome}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {unmatched.length ? (
        <div className="mt-3 rounded-lg bg-rework-soft p-3" data-testid="unmatched-verdicts">
          <h3 className="text-s font-semibold text-rework">Critic verdicts that matched no scenario <span className="mono font-normal">{unmatched.length}</span></h3>
          <p className="mt-1 text-s text-fg-2">These verdicts came back with names that matched no planned or recorded scenario, even after tolerant matching. They are not scenario rows; nothing is dropped silently.</p>
          <ul className="mt-2 flex flex-col gap-1">
            {unmatched.map((v) => <li key={v.scenario} className="text-s" data-testid="unmatched-verdict"><Badge variant={VERDICT_VARIANT[v.verdict as keyof typeof VERDICT_VARIANT] ?? 'neutral'}>{v.verdict}</Badge> <span className="ml-2 text-fg">{v.scenario}</span>{v.reasons.length ? <span className="text-fg-2"> · {v.reasons.join(' · ')}</span> : null}</li>)}
          </ul>
        </div>
      ) : null}
      {r.summary ? (<><SubLabel>Critic summary</SubLabel><p className="text-s text-fg-2" data-testid="critic-summary">{r.summary}</p></>) : null}
    </>
  );
}

function Verify({ v }: { v: RunDetailStages['verify'] }) {
  if (!v.replay && !v.stability) return <Empty testid="verify-na">Replay and stability did not run on this run.</Empty>;
  return (
    <>
      {v.replay ? (
        <>
          <SubLabel>Reality check <span className="mono font-normal normal-case text-fg-2">{v.replay.passed} passed · {v.replay.failed} dropped</span></SubLabel>
          <ul data-testid="replay-list">
            {v.replay.verdicts.map((x) => (
              <li key={x.name} className="flex flex-wrap items-baseline gap-2 border-t border-line/60 py-1 text-s first:border-t-0" data-testid="replay-row" data-passed={x.passed ? 'yes' : 'no'}>
                <span className={x.passed ? 'text-pass' : 'text-reject'}>{x.passed ? 'pass' : 'fail'}</span>
                <span className="text-fg">{x.name}</span>
                {!x.passed ? <span className="text-fg-2">step {(x.failed_step ?? 0) + 1} {x.step_kind ?? ''}{x.error ? `: ${x.error}` : ''}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : <Empty>Replay did not run on this run.</Empty>}
      {v.stability ? (
        <>
          <SubLabel>
            Stability <span className="mono font-normal normal-case text-fg-2"><span data-testid="stability-iterations">{v.stability.iterations}</span>x re-run · <span data-testid="stability-passed">{v.stability.passed}</span> stable · <span data-testid="stability-flaked">{v.stability.flaked}</span> flaked · <span data-testid="stability-recovered">{v.stability.recovered ?? 0}</span> recovered · flake rate {(v.stability.flake_rate * 100).toFixed(1)}%</span>
          </SubLabel>
          <ul data-testid="stability-list">
            {v.stability.verdicts.map((x) => (
              <li key={x.name} className="flex flex-wrap items-baseline gap-2 border-t border-line/60 py-1 text-s first:border-t-0" data-testid="stability-row">
                <span className="text-fg">{x.name}</span>
                <span className={`mono ${x.gave_up ? 'text-reject' : x.recovered ? 'text-pass' : x.classification === 'flaky' ? 'text-rework' : 'text-fg-2'}`} data-testid="stability-pattern">{x.pattern ?? `${x.passes}/${x.iterations}`}</span>
                <Badge variant={x.gave_up ? 'reject' : x.recovered ? 'pass' : x.classification === 'stable' ? 'pass' : x.classification === 'flaky' ? 'rework' : 'neutral'}>{x.gave_up ? 'broken' : x.recovered ? 'recovered' : x.classification ?? 'unknown'}</Badge>
              </li>
            ))}
          </ul>
          <KV>
            <K label="stabilizer attempts" value={(v.stability.recovered ?? 0) + v.stability.verdicts.filter((x) => x.gave_up).length ? `${v.stability.recovered ?? 0} recovered, ${v.stability.verdicts.filter((x) => x.gave_up).length} gave up` : 'none recorded'} testid="stabilizer-attempts" />
            <K label="stabilizer cost" value={usd(v.stability.stabilizer_cost_usd ?? 0)} cost testid="stabilizer-cost" />
          </KV>
        </>
      ) : <Empty>Stability did not run on this run.</Empty>}
    </>
  );
}

const FUNNEL_ROWS: Array<{ key: 'planned' | 'generated' | 'dropped' | 'incomplete' | 'findings' | 'skipped'; label: string; cls: string }> = [
  { key: 'planned', label: 'planned', cls: 'bg-accent' },
  { key: 'generated', label: 'shipped', cls: 'bg-pass' },
  { key: 'dropped', label: 'dropped', cls: 'bg-reject' },
  { key: 'incomplete', label: 'incomplete', cls: 'bg-neutral' },
  { key: 'findings', label: 'findings', cls: 'bg-finding' },
  { key: 'skipped', label: 'skipped', cls: 'bg-neutral' },
];

function Summary({ sm, findings, live }: { sm: RunDetailStages['summary']; findings: RunDetailFinding[]; live: boolean }) {
  if (live) {
    return (
      <div data-testid="summary-live">
        <KV>
          <K label="recorded so far" value={sm.shipped} />
          <K label="cost so far" value={usd(sm.total_usd)} cost />
        </KV>
        <Empty>The funnel, cost split, coverage, findings and download appear when the run finishes and its report is written.</Empty>
      </div>
    );
  }
  const f = sm.funnel;
  const shown = f ? FUNNEL_ROWS.filter((r) => r.key === 'planned' || f[r.key] > 0) : [];
  const zero = f ? FUNNEL_ROWS.filter((r) => r.key !== 'planned' && f[r.key] === 0) : [];
  const denom = f ? Math.max(1, f.planned) : 1;
  const cs = sm.cost_split;
  const parts: Array<{ key: string; usd: number; opacity: string }> = [
    { key: 'planner', usd: cs.planner, opacity: 'opacity-100' }, { key: 'explorer', usd: cs.explorer, opacity: 'opacity-80' },
    { key: 'critic', usd: cs.critic, opacity: 'opacity-60' }, { key: 'repair', usd: cs.repair, opacity: 'opacity-45' }, { key: 'stabilizer', usd: cs.stabilizer, opacity: 'opacity-30' },
  ];
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3" data-testid="hero">
        <Hero n={String(sm.shipped)} label="tests shipped" testid="hero-shipped" />
        <Hero n={usd(sm.total_usd)} label="total cost" cost testid="hero-cost" />
        <Hero n={String(sm.attention)} label={`need${sm.attention === 1 ? 's' : ''} attention`} sub={`${sm.findings_count} finding${sm.findings_count === 1 ? '' : 's'} · ${sm.uncovered_count} uncovered rule${sm.uncovered_count === 1 ? '' : 's'}`} attention={sm.attention > 0} testid="hero-attention" />
      </div>
      {sm.stopped ? <div className="mt-3 rounded-md bg-rework-soft px-3 py-2 text-s text-rework"><b>stopped early</b> {sm.stopped.reason}</div> : null}

      <SubLabel>Reconciliation funnel</SubLabel>
      {!f ? <Empty>No reconciliation on this report.</Empty> : (
        <div data-testid="funnel">
          {shown.map((r) => (
            <div key={r.key} className="grid grid-cols-[88px_1fr_40px] items-center gap-2 py-0.5 text-s" data-testid="funnel-row" data-key={r.key} data-n={f[r.key]}>
              <span className={r.key === 'planned' ? 'font-semibold text-fg' : 'text-fg-2'}>{r.label}</span>
              <div className="h-2 rounded-sm bg-bg-3"><i className={`block h-2 rounded-sm ${r.cls}`} style={{ width: `${((f[r.key] / denom) * 100).toFixed(1)}%` }} /></div>
              <span className="mono text-right text-fg">{f[r.key]}</span>
              {r.key === 'dropped' && Object.keys(f.dropped_by_stage).length ? <span className="col-span-3 pl-[96px] text-s text-fg-2">{Object.entries(f.dropped_by_stage).map(([s, n]) => `${s} ${n}`).join(' · ')}</span> : null}
            </div>
          ))}
          {zero.length ? <div className="mt-1 text-s text-fg-2" data-testid="funnel-zero">{zero.map((r) => `${r.label} 0`).join(' · ')}</div> : null}
          <div className="mt-2 flex flex-wrap gap-3 text-s">
            <span className="mono text-fg-2" data-testid="funnel-eq">{f.planned} = {f.generated} + {f.dropped} + {f.incomplete} + {f.findings} + {f.skipped}</span>
            <span className={f.balanced ? 'text-pass' : 'text-rework'} data-testid="funnel-balanced">{f.balanced ? 'balanced' : 'not balanced'}</span>
            {f.added ? <span className="text-fg-2">+{f.added} unplanned</span> : null}
          </div>
        </div>
      )}

      <SubLabel>Cost split</SubLabel>
      <div data-testid="cost-split">
        <div className="text-s text-fg-2"><span className="mono text-cost" data-testid="cost-total">{usd(cs.total)}</span> total</div>
        <div className="mt-1 flex h-2 overflow-hidden rounded-sm bg-bg-3">
          {parts.filter((p) => p.usd > 0 && cs.total > 0).map((p) => <i key={p.key} className={`block h-2 bg-cost ${p.opacity}`} style={{ width: `${((p.usd / cs.total) * 100).toFixed(2)}%` }} title={`${p.key} ${usd(p.usd)}`} />)}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-s text-fg-2">
          {parts.map((p) => <span key={p.key} data-testid="cost-part" data-part={p.key} data-usd={p.usd}>{p.key} <span className="mono text-cost">{usd(p.usd)}</span></span>)}
        </div>
      </div>

      <SubLabel>Requirements coverage</SubLabel>
      {!sm.rule_coverage ? <Empty testid="coverage-na">No SRS on this run. Add one with --srs to get requirements coverage.</Empty> : (
        <div data-testid="coverage">
          <div className="text-s text-fg-2"><span className="mono text-fg" data-testid="coverage-covered">{sm.rule_coverage.covered.length}</span> of <span className="mono text-fg">{sm.rule_coverage.covered.length + sm.rule_coverage.uncovered.length}</span> rules covered</div>
          {sm.rule_coverage.covered.length ? <ul>{sm.rule_coverage.covered.map((c) => <Row key={c.rule_id} tag={c.rule_id} tagVariant="outline" name="covered" why={c.scenarios.join(', ')} />)}</ul> : null}
          {sm.rule_coverage.uncovered.length ? (
            <>
              <div className="mt-2 text-s font-semibold text-fg">Considered, not automated <span className="mono font-normal text-fg-2" data-testid="coverage-uncovered">{sm.rule_coverage.uncovered.length}</span></div>
              <ul data-testid="uncovered-list">{sm.rule_coverage.uncovered.map((u) => <Row key={u.rule_id} tag={u.rule_id} tagVariant="outline" name={u.text} why={u.reason} />)}</ul>
            </>
          ) : null}
        </div>
      )}

      <section className="mt-4 rounded-lg border border-finding/40 bg-finding-soft p-4" data-testid="findings-section">
        <h3 className="text-m font-semibold text-finding" data-testid="findings-heading">Product behavior to review <span className="mono text-s font-normal">{findings.length}</span></h3>
        <p className="mt-1 text-s text-fg-2">A finding is product behavior the agent observed that differed from what the scenario expected. It is not a test failure and is not a scenario row.</p>
        {findings.length === 0 ? <div className="mt-3 text-s text-fg-2" data-testid="no-findings">No findings recorded</div> : (
          <ul className="mt-3 flex flex-col gap-2">
            {findings.map((fd) => (
              <li key={fd.scenario} className="rounded-md border border-line bg-bg-1 px-3 py-2" data-testid="finding">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold text-finding">{fd.scenario}</span>
                  {fd.verdict ? <Badge variant={VERDICT_VARIANT[fd.verdict.verdict]} data-testid="finding-verdict" data-verdict={fd.verdict.verdict} title={fd.verdict.reasons.join(' · ')}>critic: {fd.verdict.verdict}</Badge> : null}
                </div>
                <div className="text-s text-fg-2"><span className="font-semibold text-fg">Expected</span> {fd.expected}</div>
                <div className="text-s text-fg-2"><span className="font-semibold text-fg">URL at the time</span> <span className="mono">{fd.url}</span>{fd.messages.length ? `; the page said "${fd.messages.join(' | ')}"` : ''}</div>
                {fd.verdict?.reasons.length ? <div className="mt-1 text-s text-fg-2" data-testid="finding-verdict-reasons">{fd.verdict.reasons.join(' · ')}</div> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-4" data-testid="summary-download">
        {sm.zip ? (
          <Button asChild><a href={api.withToken(sm.zip.href)} data-testid="download-zip"><Download className="mr-1 h-4 w-4" /> Download {sm.zip.name} <span className="ml-1 font-normal opacity-70">{formatSize(sm.zip.size)}</span></a></Button>
        ) : <div className="text-s text-fg-2" data-testid="no-zip">No framework zip in the run folder.</div>}
      </div>
    </>
  );
}

function Hero({ n, label, sub, cost, attention, testid }: { n: string; label: string; sub?: string; cost?: boolean; attention?: boolean; testid: string }) {
  return (
    <div className={`rounded-lg border p-3 ${attention ? 'border-finding/40 bg-finding-soft' : 'border-line bg-bg-2'}`}>
      <div className={`text-l font-semibold leading-none ${cost ? 'mono text-cost' : attention ? 'text-finding' : 'text-fg'}`} data-testid={testid}>{n}</div>
      <div className="mt-1 text-s text-fg-2">{label}</div>
      {sub ? <div className="text-s text-fg-2" data-testid={`${testid}-sub`}>{sub}</div> : null}
    </div>
  );
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
