import type { RunDetailStages, StageStatus } from './api';
import type { LiveRun } from './gateway';

/**
 * The six stages of a run in progress, read off the event stream (invariant
 * 47: live panels read counts off events). Counts are counts of events and
 * sums of the `usd` fields the runtime emits; nothing is read from the
 * console-style log lines. When run_report arrives the page stops using this
 * and renders the report exactly as a history view does.
 */

const money = (v: number): string => `$${v.toFixed(4)}`;
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

export function liveStagesFrom(run: LiveRun): RunDetailStages {
  const ev = run.events;
  const has = (type: string): boolean => ev.some((e) => e.type === type);
  const of = (type: string) => ev.filter((e) => e.type === type);
  const req = run.request;
  const discoveryActive = run.command === 'resume' ? false : req.discover === true || (Array.isArray(req.urls) && req.urls.length > 0) || !!req.srs;
  const planStarted = has('plan_started');
  const planDone = of('plan_done')[0];
  const explorerStarted = has('tool_call');
  const criticStarted = has('critic_started');
  const replayStarted = has('replay_started');
  const stabilityDone = of('stability_done')[0];
  const done = of('done')[0];
  const finished = run.status !== 'running';

  const discovery: RunDetailStages['discovery'] = !discoveryActive
    ? { status: 'not-applicable', stat: 'single page', method: null, pages: [], candidates: [], warnings: [] }
    : { status: planStarted || finished ? 'done' : 'running', stat: planStarted || finished ? 'pages in the report' : 'discovering', method: null, pages: [], candidates: [], warnings: [] };

  const planScenarios = Array.isArray(planDone?.scenarios) ? (planDone!.scenarios as Array<Record<string, unknown>>) : [];
  const plan: RunDetailStages['plan'] = {
    status: planDone ? 'done' : planStarted ? 'running' : 'pending',
    stat: planDone ? `${planScenarios.length} planned` : planStarted ? 'planning' : 'waiting',
    planner_usd: Number(planDone?.usd ?? 0),
    scenarios: planScenarios.map((p) => ({ name: String(p.name ?? ''), feature: (p.feature as string | undefined) ?? null, category: (p.category as string | undefined) ?? null, rule_ids: Array.isArray(p.ruleIds) ? (p.ruleIds as string[]) : [], page_url: (p.pageUrl as string | undefined) ?? null })),
    pages: [],
  };

  const toolCalls = of('tool_call');
  const okResults = new Set(of('tool_result').filter((r) => r.ok === true).map((r) => String(r.name)));
  const recorded = of('tool_result').filter((r) => r.name === 'end_scenario' && r.ok === true).length;
  const usage = of('usage').reduce((a, u) => a + Number(u.usd ?? 0), 0);
  const skipped = toolCalls.filter((c) => c.name === 'skip_scenario').map((c) => { const i = (c.input as Record<string, unknown>) ?? {}; return { scenario: String(i.name ?? ''), reason: String(i.reason ?? '') }; });
  void okResults;
  const exploreStatus: StageStatus = criticStarted || replayStarted || done || finished ? 'done' : explorerStarted ? 'running' : 'pending';
  const explore: RunDetailStages['explore'] = {
    status: exploreStatus,
    stat: explorerStarted || finished ? `${recorded} recorded · ${plural(toolCalls.length, 'step')} · ${money(usage)}` : 'waiting',
    steps: toolCalls.length, scenarios_recorded: recorded, explorer_usd: usage, repair_usd: 0,
    gate_injections: of('gate_injection').map((g) => ({ scenario: String(g.scenario ?? ''), step_index: Number(g.step ?? 0), assertion_type: String(g.assertionType ?? ''), detail: String(g.detail ?? '') })),
    gate_broken: of('gate_broken').map((g) => ({ scenario: String(g.scenario ?? ''), reason: String(g.reason ?? ''), attempts: Number(g.attempts ?? 0) })),
    skipped, incomplete: [],
    heals: of('heal').map((h) => ({ scenario: (h.scenario as string | undefined) ?? null, intent: String(h.intent ?? ''), from: String(h.from ?? ''), to: String(h.to ?? '') })),
    stopped: null,
    // The per-call cache record and the closeout grace live on the report only; the live view never derives them.
    cache: null, closeout: null,
  };

  // The latest critic_done for a scenario wins: a repaired scenario's second verdict replaces its first.
  const byScenario = new Map<string, { scenario: string; verdict: 'pass' | 'rework' | 'reject'; reasons: string[]; required_fixes: string[] }>();
  let criticUsd = 0;
  for (const c of of('critic_done')) {
    criticUsd += Number(c.usd ?? 0);
    for (const v of (Array.isArray(c.verdicts) ? c.verdicts : []) as Array<Record<string, unknown>>) {
      const verdict = v.verdict === 'pass' || v.verdict === 'rework' || v.verdict === 'reject' ? v.verdict : 'rework';
      byScenario.set(String(v.scenario), { scenario: String(v.scenario), verdict, reasons: Array.isArray(v.reasons) ? (v.reasons as string[]) : [], required_fixes: Array.isArray(v.required_fixes) ? (v.required_fixes as string[]) : [] });
    }
  }
  const verdicts = [...byScenario.values()];
  const counts = { pass: verdicts.filter((v) => v.verdict === 'pass').length, rework: verdicts.filter((v) => v.verdict === 'rework').length, reject: verdicts.filter((v) => v.verdict === 'reject').length };
  // The repair pass, from its own events: announced with a count, closed with the spend.
  const repairStarted = of('repair_started')[0];
  const repairDone = of('repair_done')[0];
  const repairInFlight = !!repairStarted && !repairDone;
  const reviewDone = has('critic_done') && !repairInFlight && (replayStarted || done || finished);
  const review: RunDetailStages['review'] = {
    status: reviewDone ? (counts.rework + counts.reject > 0 ? 'warning' : 'done') : criticStarted || has('critic_done') ? 'running' : 'pending',
    stat: repairInFlight ? `repair pass: ${Number(repairStarted!.count ?? 0)} scenario${Number(repairStarted!.count ?? 0) === 1 ? '' : 's'} re-explored` : has('critic_done') ? `${counts.pass} pass / ${counts.rework} rework / ${counts.reject} reject` : criticStarted ? 'reviewing' : 'waiting',
    ran: criticStarted || has('critic_done'), counts, critic_usd: criticUsd, verdicts, journeys: [],
    repair: repairStarted ? { count: Number(repairStarted.count ?? 0), spent_usd: Number(repairDone?.usd ?? 0) } : null,
    summary: null,
  };

  const replayRows = [
    ...of('replay_scenario_passed').map((r) => ({ name: String(r.name ?? ''), passed: true, failed_step: null, step_kind: null, error: null, observed: null })),
    ...of('replay_scenario_failed').map((r) => ({ name: String(r.name ?? ''), passed: false, failed_step: Number(r.failedStep ?? 0), step_kind: (r.stepKind as string | undefined) ?? null, error: (r.error as string | undefined) ?? null, observed: null })),
  ];
  const replayDone = of('replay_done')[0];
  const patterns = new Map<string, string[]>();
  for (const e of ev) {
    if (e.type === 'stability_iteration_passed' || e.type === 'stability_iteration_failed') {
      const name = String(e.name ?? '');
      const list = patterns.get(name) ?? [];
      list.push(e.type === 'stability_iteration_passed' ? 'P' : 'F');
      patterns.set(name, list);
    }
  }
  const stabilityStarted = of('stability_started')[0];
  const verify: RunDetailStages['verify'] = {
    status: stabilityDone ? ((Number(replayDone?.failed ?? 0) > 0 || Number(stabilityDone.flaked ?? 0) > 0) ? 'warning' : 'done') : replayStarted ? 'running' : 'pending',
    stat: stabilityDone ? `${Number(stabilityDone.stable ?? 0)} stable / ${Number(stabilityDone.flaked ?? 0)} flaky` : replayDone ? `${Number(replayDone.passed ?? 0)} passed replay / ${Number(replayDone.failed ?? 0)} dropped` : replayStarted ? 'replaying' : 'waiting',
    replay: replayStarted ? { passed: Number(replayDone?.passed ?? replayRows.filter((r) => r.passed).length), failed: Number(replayDone?.failed ?? replayRows.filter((r) => !r.passed).length), duration_ms: Number(replayDone?.durationMs ?? 0), verdicts: replayRows } : null,
    stability: stabilityStarted ? {
      iterations: Number(stabilityStarted.iterations ?? 0), passed: Number(stabilityDone?.stable ?? 0), flaked: Number(stabilityDone?.flaked ?? 0), flaky: null, broken: null,
      recovered: stabilityDone ? Number(stabilityDone.recovered ?? 0) : null, flake_rate: Number(stabilityDone?.flakeRate ?? 0), stabilizer_cost_usd: stabilityDone ? Number(stabilityDone.stabilizerCostUsd ?? 0) : null,
      // Attempts, observed text and the warning live on the report only; the live view never derives them.
      attempts_total: 0, warning: null,
      verdicts: [...patterns.entries()].map(([name, p]) => ({ name, iterations: Number(stabilityStarted.iterations ?? p.length), passes: p.filter((x) => x === 'P').length, pattern: p.join('-'), classification: null, recovered: false, gave_up: false, first_failure: null, attempts: [] })),
    } : null,
  };

  const total = plan.planner_usd + usage + criticUsd + (verify.stability?.stabilizer_cost_usd ?? 0);
  const summary: RunDetailStages['summary'] = {
    status: done || finished ? 'running' : 'pending',
    stat: done ? `${Number(done.scenarios ?? 0)} shipped, writing the framework` : 'pending',
    shipped: Number(done?.scenarios ?? recorded), total_usd: total, findings_count: 0, uncovered_count: 0, attention: 0,
    funnel: null,
    cost_split: { planner: plan.planner_usd, explorer: usage, critic: criticUsd, repair: 0, stabilizer: verify.stability?.stabilizer_cost_usd ?? 0, total },
    rule_coverage: null, zip: null, stopped: null,
  };

  return { discovery, plan, explore, review, verify, summary };
}
