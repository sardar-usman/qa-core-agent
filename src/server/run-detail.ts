import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { RunReport } from '../agent/trace.js';
import { readRunEvents, type StoredEvent } from './events.js';
import { hostOf } from './db/indexer.js';
import { assignVerdicts, verdictMatchesScenario, type ScenarioVerdict } from '../agent/critic.js';
import { EVENTS_FILE } from './events.js';

/**
 * One run, truthfully, from its stored artifacts (dashboard v2 plan, PR B).
 * Every value here is read from output/<host>/<run-id>/ (the run-report, the
 * events file, the files present) or copied from the index row the indexer
 * built from those same files. No arithmetic, no derived counts: a scenario
 * is "shipped" because it is in the report's emitted list, a verdict is the
 * Critic's own, a stability pattern is the recorded one.
 *
 * Verdicts are matched to scenarios with the Critic's tolerant matcher
 * (assignVerdicts: prefixes such as "2. [negative] " stripped, normalized key,
 * then containment, each verdict claimable once), never exact string
 * equality: a live run's Critic echoed "[happy] ..." names and exact matching
 * left every scenario unverdicted while inventing rows for the echoes. A
 * verdict that matches no scenario is never a scenario row; it is reported in
 * `unmatched_verdicts` so nothing is dropped silently.
 */

export interface RunDetailScenario {
  name: string;
  feature: string | null;
  category: string | null;
  /** The Critic's final verdict, or null when the Critic did not review it. */
  verdict: 'pass' | 'rework' | 'reject' | null;
  reasons: string[];
  required_fixes: string[];
  /** none: no repair pass touched it; repaired: rework -> pass, kept; failed: rework -> rework/reject/not re-recorded, dropped. */
  repair: 'none' | 'repaired' | 'failed';
  repair_second: string | null;
  /** Reality-check replay outcome as recorded, null when the scenario never reached replay. */
  replay: 'pass' | 'fail' | null;
  replay_error: string | null;
  /** Stability as recorded: passes of iterations, the per-attempt pattern (P/F per attempt), classification. */
  stability: { passes: number; iterations: number; pattern: string | null; classification: string | null; recovered: boolean } | null;
  /** In the report's emitted scenarios list. */
  shipped: boolean;
  /** Where the reconciliation says it fell out, when it did. */
  dropped_at: string | null;
  dropped_reason: string | null;
  /** Explorer-side outcomes recorded on the report. */
  incomplete_reason: string | null;
  skipped_reason: string | null;
}

export interface RunDetailArtifact {
  name: string;
  kind: 'zip' | 'report' | 'rule-coverage' | 'requirements-map' | 'checkpoint' | 'events' | 'screenshot' | 'spec' | 'meta' | 'srs' | 'other';
  size: number;
  /** API path that serves the file. */
  href: string;
}

/**
 * done: the stage ran with nothing to flag. warning: a run problem (stopped
 * with a checkpoint, Critic verdicts that matched no scenario, an unbalanced
 * funnel; and for the middle stages, a reject/rework, an incomplete or gate-
 * broken scenario, a flake). attention: the run completed but recorded
 * findings or uncovered rules, product behavior to review, rendered with the
 * finding token, never the warning token. not-applicable: the stage did not run.
 */
export type StageStatus = 'done' | 'warning' | 'attention' | 'not-applicable';

/**
 * The six-stage view, every value a field of run-report.json (or the index
 * row built from it). Statuses and one-line stats are derived here, on the
 * server, from named report fields so the page renders and never computes.
 * The one arithmetic step is the subtraction invariant 47 allows:
 * explorer = cost.usd minus cost.repairUsd (repair is included in usd).
 */
/** The page as it was when a re-run step failed: URL, the failing target's text, visible messages. */
export interface ObservedOnFailure { url: string; target: string | null; messages: string[] }

export interface RunDetailStages {
  discovery: {
    status: StageStatus; stat: string;
    method: string | null;
    pages: Array<{ url: string; source: string; feature: string | null; volatile: boolean }>;
    warnings: string[];
  };
  plan: {
    status: StageStatus; stat: string;
    planner_usd: number;
    scenarios: Array<{ name: string; feature: string | null; category: string | null; rule_ids: string[]; page_url: string | null }>;
    /** Scenario count per planned page (from plan[].pageUrl); one entry with url null on a single-page plan. */
    pages: Array<{ url: string | null; count: number }>;
  };
  explore: {
    status: StageStatus; stat: string;
    steps: number; scenarios_recorded: number;
    /** cost.usd: the Explorer loop including the repair pass. */
    explorer_usd: number; repair_usd: number;
    gate_injections: Array<{ scenario: string; step_index: number; assertion_type: string; detail: string }>;
    gate_broken: Array<{ scenario: string; reason: string; attempts: number }>;
    skipped: Array<{ scenario: string; reason: string }>;
    incomplete: Array<{ scenario: string; reason: string }>;
    heals: Array<{ scenario: string | null; intent: string; from: string; to: string }>;
    stopped: { kind: string; reason: string } | null;
    /**
     * cost.calls summarised: API calls made and the share of every prompt
     * token served from the cache (cost.cachedInputShare), with the three
     * token totals it is computed from. null when the report predates the
     * per-call record.
     */
    cache: { calls: number; cached_share: number; input_tokens: number; cache_read_tokens: number; cache_creation_tokens: number } | null;
    /** stopped.closeout: the cost closeout grace, when it was used. */
    closeout: { scenario: string; usd: number; closed: boolean } | null;
  };
  review: {
    status: StageStatus; stat: string;
    ran: boolean;
    counts: { pass: number; rework: number; reject: number };
    critic_usd: number;
    verdicts: Array<{ scenario: string; verdict: 'pass' | 'rework' | 'reject'; reasons: string[]; required_fixes: string[] }>;
    journeys: Array<{ scenario: string; first: 'rework'; second: string | null; outcome: 'kept' | 'dropped' }>;
    /** The repair pass as the report recorded it: how many journeys, what it spent. Budget is not on the report. */
    repair: { count: number; spent_usd: number } | null;
    summary: string | null;
  };
  verify: {
    status: StageStatus; stat: string;
    replay: { passed: number; failed: number; duration_ms: number; verdicts: Array<{ name: string; passed: boolean; failed_step: number | null; step_kind: string | null; error: string | null; observed: ObservedOnFailure | null }> } | null;
    stability: {
      iterations: number; passed: number; flaked: number; flaky: number | null; broken: number | null; recovered: number | null; flake_rate: number; stabilizer_cost_usd: number | null;
      /** Sum of every verdict's attempts; the page says "none recorded" only when this is 0 AND the stabilizer cost is 0. */
      attempts_total: number;
      /** report.stability.warning: stabilizer spend with no attempt recorded. */
      warning: string | null;
      verdicts: Array<{
        name: string; iterations: number; passes: number; pattern: string | null; classification: string | null; recovered: boolean; gave_up: boolean;
        first_failure: { iteration: number; failed_step: number; step_kind: string; error: string; observed: ObservedOnFailure | null } | null;
        attempts: Array<{ attempt: number; kind: string; change: string; reason: string; pattern: string | null; outcome: string }>;
      }>;
    } | null;
  };
  summary: {
    status: StageStatus; stat: string;
    shipped: number; total_usd: number;
    findings_count: number; uncovered_count: number; attention: number;
    funnel: { planned: number; generated: number; dropped: number; dropped_by_stage: Record<string, number>; incomplete: number; findings: number; skipped: number; balanced: boolean; added: number } | null;
    cost_split: { planner: number; explorer: number; critic: number; repair: number; stabilizer: number; total: number };
    rule_coverage: { covered: Array<{ rule_id: string; scenarios: string[] }>; uncovered: Array<{ rule_id: string; text: string; reason: string }> } | null;
    zip: RunDetailArtifact | null;
    stopped: { kind: string; reason: string } | null;
  };
}

export interface RunDetailBody {
  legacy: false;
  run: Record<string, unknown>;
  header: {
    run_id: string; project_id: string; project_name: string; host: string | null; url: string | null;
    started_at: string | null; ended_at: string | null; environment: string | null; status: string; source: string | null;
    cost: { total: number; planner: number; explorer: number; critic: number; repair: number; stabilizer: number | null };
    stopped_reason: string | null;
  };
  scenarios: RunDetailScenario[];
  /** Stored counts, copied from the index row (which copied them from the report). */
  counts: { planned: number; shipped: number | null; generated: number; dropped: number; incomplete: number; findings: number; skipped: number; stable: number; flaky: number; broken: number };
  /** A Critic verdict whose name matched the finding is attached here, never discarded. */
  findings: Array<{ scenario: string; category: string | null; expected: string; url: string; messages: string[]; verdict: { verdict: 'pass' | 'rework' | 'reject'; reasons: string[] } | null }>;
  replay: RunReport['replay'] | null;
  stages: RunDetailStages;
  stability: { iterations: number; passed: number; flaked: number; flakeRate: number; recovered: number | null; stabilizerCostUsd: number | null } | null;
  review_summary: string | null;
  reconciliation: RunReport['reconciliation'] | null;
  rule_coverage: RunReport['ruleCoverage'] | null;
  /** Critic verdicts that matched no scenario even after tolerant matching. Shown as a warning, never as rows. */
  unmatched_verdicts: Array<{ scenario: string; verdict: string; reasons: string[] }>;
  artifacts: RunDetailArtifact[];
  /** null when no events.jsonl exists in the run folder (events_status 'absent'). */
  events: StoredEvent[] | null;
  events_status: 'present' | 'empty' | 'absent';
}

export interface RunDetailLegacyBody {
  legacy: true;
  run: Record<string, unknown>;
  header: RunDetailBody['header'];
  /** The numbers the pre-v2 record carried. Explored, never shipped. */
  summary: { explored: number; cost_total: number; started_at: string | null; ended_at: string | null; model: string | null; duration_sec: number | null };
  artifacts: RunDetailArtifact[];
  events: StoredEvent[] | null;
  events_status: 'present' | 'empty' | 'absent';
}

export type RunDetailResult =
  | { status: 200; body: RunDetailBody | RunDetailLegacyBody }
  | { status: 404 | 400; body: { error: string; looked_for?: string } };

const RUN_ID_SAFE = /^[A-Za-z0-9._-]+$/;
const ARTIFACT_SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function artifactKind(name: string): RunDetailArtifact['kind'] {
  if (name === 'run-report.json') return 'report';
  if (name === 'rule-coverage.json') return 'rule-coverage';
  if (name === 'requirements-map.json') return 'requirements-map';
  if (name === 'checkpoint.json') return 'checkpoint';
  if (name === 'events.jsonl') return 'events';
  if (name === 'run-meta.json') return 'meta';
  if (name.endsWith('.zip')) return 'zip';
  if (/\.(png|jpe?g|webp)$/i.test(name)) return 'screenshot';
  if (/\.spec\.[jt]s$/.test(name)) return 'spec';
  // An SRS uploaded with the run lives here under its original name (run-explore.ts, saveSrsUpload).
  if (/\.(md|txt|pdf|docx)$/i.test(name)) return 'srs';
  return 'other';
}

/** The files actually present in the run directory, each with the API path that serves it. */
export function listArtifacts(runDir: string, runId: string): RunDetailArtifact[] {
  if (!fs.existsSync(runDir)) return [];
  return fs.readdirSync(runDir)
    .filter((n) => ARTIFACT_SAFE.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(runDir, name));
      return st.isFile() ? { name, kind: artifactKind(name), size: st.size, href: `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}` } : null;
    })
    .filter((a): a is RunDetailArtifact => a !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve an artifact by name inside the run's directory only. Returns the
 * absolute path when the file exists, null otherwise. Names are restricted to
 * a plain filename, so nothing outside the run directory can be addressed.
 */
export function runArtifactFile(root: string, run: { report_path: string | null }, name: string): string | null {
  if (!run.report_path || !ARTIFACT_SAFE.test(name)) return null;
  const dir = path.dirname(path.resolve(root, run.report_path));
  const rootResolved = path.resolve(root) + path.sep;
  const file = path.join(dir, name);
  if (!dir.startsWith(rootResolved) || !file.startsWith(dir + path.sep)) return null;
  return fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

function header(run: Record<string, unknown>, env: string | null, extraCost?: { stabilizer: number | null }): RunDetailBody['header'] {
  return {
    run_id: String(run.id), project_id: String(run.project_id), project_name: String(run.project_name ?? run.project_id),
    host: hostOf(run.url as string | null), url: (run.url as string | null) ?? null,
    started_at: (run.started_at as string | null) ?? null, ended_at: (run.ended_at as string | null) ?? null,
    environment: env && env !== 'other' ? env : null,
    status: String(run.status), source: (run.source as string | null) ?? null,
    cost: {
      total: Number(run.cost_total) || 0, planner: Number(run.cost_planner) || 0, explorer: Number(run.cost_explorer) || 0,
      critic: Number(run.cost_critic) || 0, repair: Number(run.cost_repair) || 0, stabilizer: extraCost?.stabilizer ?? null,
    },
    stopped_reason: (run.stopped_reason as string | null) ?? null,
  };
}

/** Build the detail payload for a run id. Pure over the database and the run directory. */
export function buildRunDetail(db: Database.Database, root: string, id: string): RunDetailResult {
  if (!RUN_ID_SAFE.test(id)) return { status: 400, body: { error: 'bad run id' } };
  const run = db.prepare('SELECT r.*, p.name AS project_name, p.environment AS project_environment FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?').get(id) as Record<string, unknown> | undefined;
  if (!run) {
    const lookedFor = `output/*/${id}/run-report.json`;
    return { status: 404, body: { error: `no run '${id}' in the index; looked for ${lookedFor}`, looked_for: lookedFor } };
  }
  const env = (run.project_environment as string | null) ?? null;

  if (run.status === 'legacy' || !run.report_path) {
    const flags = (() => { try { return JSON.parse(String(run.flags_json ?? '{}')) as Record<string, unknown>; } catch { return {}; } })();
    return {
      status: 200,
      body: {
        legacy: true, run, header: header(run, env),
        summary: {
          explored: Number(run.generated) || 0, cost_total: Number(run.cost_total) || 0,
          started_at: (run.started_at as string | null) ?? null, ended_at: (run.ended_at as string | null) ?? null,
          model: typeof flags.model === 'string' ? flags.model : null, duration_sec: typeof flags.durationSec === 'number' ? flags.durationSec : null,
        },
        artifacts: [], events: null, events_status: 'absent',
      },
    };
  }

  const reportPath = path.resolve(root, String(run.report_path));
  if (!reportPath.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(reportPath)) {
    return { status: 404, body: { error: `run-report.json for '${id}' is missing; looked for ${String(run.report_path)}`, looked_for: String(run.report_path) } };
  }
  let report: RunReport;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as RunReport; }
  catch (err) { return { status: 404, body: { error: `run-report.json for '${id}' at ${String(run.report_path)} is not valid JSON: ${(err as Error).message}`, looked_for: String(run.report_path) } }; }
  const runDir = path.dirname(reportPath);

  // One row per scenario name the run's own records know about (plan, emitted
  // list, replay, stability, reconciliation drops, incomplete, skipped),
  // findings excluded. Critic verdicts never create rows: they are attached
  // to these names by the tolerant matcher below.
  const findings = report.findings ?? [];
  const findingNames = new Set(findings.map((f) => f.scenario));
  const rows = new Map<string, RunDetailScenario>();
  const rowFor = (name: string): RunDetailScenario => {
    let r = rows.get(name);
    if (!r) {
      r = { name, feature: null, category: null, verdict: null, reasons: [], required_fixes: [], repair: 'none', repair_second: null, replay: null, replay_error: null, stability: null, shipped: false, dropped_at: null, dropped_reason: null, incomplete_reason: null, skipped_reason: null };
      rows.set(name, r);
    }
    return r;
  };
  for (const p of report.plan ?? []) { if (findingNames.has(p.name)) continue; const r = rowFor(p.name); r.feature = p.feature ?? null; r.category = p.category ?? null; }
  for (const s of report.scenarios ?? []) { const r = rowFor(s.name); r.shipped = true; r.feature = s.feature ?? r.feature; r.category = s.category ?? r.category; }
  for (const v of report.replay?.verdicts ?? []) { const r = rowFor(v.name); r.replay = v.passed ? 'pass' : 'fail'; r.replay_error = v.error ?? null; }
  for (const v of report.stability?.verdicts ?? []) {
    const r = rowFor(v.name);
    r.stability = { passes: v.passes, iterations: v.iterations, pattern: v.pattern ?? null, classification: v.classification ?? (v.stable ? 'stable' : null), recovered: v.relaxed === true };
  }
  for (const d of report.reconciliation?.dropped ?? []) { const r = rowFor(d.name); r.dropped_at = d.stage; r.dropped_reason = d.reason; }
  for (const i of report.incomplete ?? []) { const r = rowFor(i.scenario); r.incomplete_reason = i.reason; }
  for (const s of report.skipped ?? []) { const r = rowFor(s.scenario); r.skipped_reason = s.reason; }
  for (const name of findingNames) rows.delete(name);
  // Critic verdicts and repair journeys, attached by the tolerant matcher.
  const names = [...rows.keys()];
  const verdicts: ScenarioVerdict[] = (report.review?.verdicts ?? []).map((v) => ({ scenario: v.scenario, verdict: v.verdict, reasons: v.reasons ?? [], required_fixes: v.required_fixes ?? [] }));
  const assigned = assignVerdicts(names, verdicts);
  const claimed = new Set<ScenarioVerdict>();
  for (const [name, v] of assigned) { const r = rows.get(name)!; r.verdict = v.verdict; r.reasons = v.reasons; r.required_fixes = v.required_fixes; claimed.add(v); }
  // A verdict whose name matches a finding is attached to that finding (Task 2 of PR B2): nothing is discarded.
  const findingVerdict = new Map<string, ScenarioVerdict>();
  for (const v of verdicts) {
    if (claimed.has(v)) continue;
    const f = findings.find((x) => !findingVerdict.has(x.scenario) && verdictMatchesScenario(v.scenario, x.scenario));
    if (f) { findingVerdict.set(f.scenario, v); claimed.add(v); }
  }
  const unmatched_verdicts = verdicts.filter((v) => !claimed.has(v)).map((v) => ({ scenario: v.scenario, verdict: v.verdict, reasons: v.reasons }));
  const journeys = (report.review?.repair ?? []).map((j) => ({ scenario: j.scenario, verdict: 'rework' as const, reasons: [], required_fixes: [], journey: j }));
  for (const [name, j] of assignVerdicts(names, journeys)) { const r = rows.get(name)!; const jj = (j as typeof journeys[number]).journey; r.repair = jj.outcome === 'kept' ? 'repaired' : 'failed'; r.repair_second = jj.second ?? 'not re-recorded'; }
  const planOrder = new Map((report.plan ?? []).map((p, i) => [p.name, i]));
  const scenarios = [...rows.values()].sort((a, b) => (planOrder.get(a.name) ?? 1e9) - (planOrder.get(b.name) ?? 1e9) || a.name.localeCompare(b.name));

  const stab = report.stability && !report.stability.skipped ? report.stability : null;
  const artifacts = listArtifacts(runDir, id);
  return {
    status: 200,
    body: {
      legacy: false,
      run,
      header: header(run, env, { stabilizer: stab?.stabilizerCostUsd ?? null }),
      scenarios,
      counts: {
        planned: Number(run.planned) || 0, shipped: run.shipped === null ? null : Number(run.shipped), generated: Number(run.generated) || 0,
        dropped: Number(run.dropped) || 0, incomplete: Number(run.incomplete) || 0, findings: Number(run.findings) || 0, skipped: Number(run.skipped) || 0,
        stable: Number(run.stable) || 0, flaky: Number(run.flaky) || 0, broken: Number(run.broken) || 0,
      },
      findings: findings.map((f) => { const v = findingVerdict.get(f.scenario); return { scenario: f.scenario, category: f.category ?? null, expected: f.expected, url: f.url, messages: f.messages ?? [], verdict: v ? { verdict: v.verdict, reasons: v.reasons } : null }; }),
      replay: report.replay && !report.replay.skipped ? report.replay : null,
      stability: stab ? { iterations: stab.iterations, passed: stab.passed, flaked: stab.flaked, flakeRate: stab.flakeRate, recovered: stab.recovered ?? null, stabilizerCostUsd: stab.stabilizerCostUsd ?? null } : null,
      review_summary: report.review?.summary ?? null,
      reconciliation: report.reconciliation ?? null,
      rule_coverage: report.ruleCoverage ?? null,
      unmatched_verdicts,
      stages: buildStages(report, artifacts, Number(run.cost_total) || 0, unmatched_verdicts.length),
      artifacts,
      ...eventsFor(runDir),
    },
  };
}

const usd = (v: number | undefined | null): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const observedOf = (o: { url: string; target: string | null; messages: string[] } | undefined): ObservedOnFailure | null => o ? { url: o.url, target: o.target ?? null, messages: o.messages ?? [] } : null;
const plural = (n: number, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;

/** The six stages, read off the report. See RunDetailStages. */
export function buildStages(report: RunReport, artifacts: RunDetailArtifact[], totalUsd: number, unmatchedVerdicts = 0): RunDetailStages {
  const plan = report.plan ?? [];
  const shipped = report.scenarios ?? [];
  const cost = report.cost ?? ({ usd: 0 } as RunReport['cost']);
  const stopped = report.stopped ? { kind: report.stopped.kind, reason: report.stopped.reason } : null;

  const disc = report.discovery;
  const discovery: RunDetailStages['discovery'] = disc
    ? { status: (disc.warnings ?? []).length > 0 ? 'warning' : 'done', stat: `${plural(disc.pages.length, 'page')} found`, method: disc.method, pages: disc.pages.map((p) => ({ url: p.url, source: p.source, feature: p.feature ?? null, volatile: p.volatile === true })), warnings: disc.warnings ?? [] }
    : { status: 'not-applicable', stat: 'single page', method: null, pages: [], warnings: [] };

  const pageCounts = new Map<string | null, number>();
  for (const p of plan) pageCounts.set(p.pageUrl ?? null, (pageCounts.get(p.pageUrl ?? null) ?? 0) + 1);
  const planStage: RunDetailStages['plan'] = {
    status: plan.length ? 'done' : 'warning', stat: plan.length ? `${plan.length} planned` : 'no plan',
    planner_usd: usd(cost.plannerUsd),
    scenarios: plan.map((p) => ({ name: p.name, feature: p.feature ?? null, category: p.category ?? null, rule_ids: p.ruleIds ?? [], page_url: p.pageUrl ?? null })),
    pages: [...pageCounts.entries()].map(([url, count]) => ({ url, count })),
  };

  const incomplete = (report.incomplete ?? []).map((i) => ({ scenario: i.scenario, reason: i.reason }));
  const skipped = (report.skipped ?? []).map((s) => ({ scenario: s.scenario, reason: s.reason }));
  const gateBroken = (report.gate?.broken ?? []).map((b) => ({ scenario: b.scenario, reason: b.reason, attempts: b.attempts }));
  const explore: RunDetailStages['explore'] = {
    status: stopped || incomplete.length > 0 || gateBroken.length > 0 ? 'warning' : 'done',
    stat: `${shipped.length} recorded · ${plural(report.steps ?? 0, 'step')} · $${usd(cost.usd).toFixed(4)}`,
    steps: report.steps ?? 0, scenarios_recorded: shipped.length,
    explorer_usd: usd(cost.usd), repair_usd: usd(cost.repairUsd),
    gate_injections: (report.gate?.injections ?? []).map((g) => ({ scenario: g.scenario, step_index: g.stepIndex, assertion_type: g.assertionType, detail: g.detail })),
    gate_broken: gateBroken, skipped, incomplete,
    heals: (report.heals ?? []).map((h) => ({ scenario: h.scenario ?? null, intent: h.intent, from: h.from, to: h.to })),
    stopped,
    cache: Array.isArray(cost.calls)
      ? { calls: cost.calls.length, cached_share: usd(cost.cachedInputShare), input_tokens: usd(cost.inputTokens), cache_read_tokens: usd(cost.cacheReadTokens), cache_creation_tokens: usd(cost.cacheCreationTokens) }
      : null,
    closeout: report.stopped?.closeout
      ? { scenario: report.stopped.closeout.scenario, usd: usd(report.stopped.closeout.usd), closed: report.stopped.closeout.closed === true }
      : null,
  };

  const review = report.review;
  const verdicts = (review?.verdicts ?? []).map((v) => ({ scenario: v.scenario, verdict: v.verdict, reasons: v.reasons ?? [], required_fixes: v.required_fixes ?? [] }));
  const counts = { pass: verdicts.filter((v) => v.verdict === 'pass').length, rework: verdicts.filter((v) => v.verdict === 'rework').length, reject: verdicts.filter((v) => v.verdict === 'reject').length };
  const journeys = (review?.repair ?? []).map((j) => ({ scenario: j.scenario, first: j.first, second: j.second ?? null, outcome: j.outcome }));
  const reviewStage: RunDetailStages['review'] = {
    status: !review ? 'not-applicable' : counts.rework + counts.reject > 0 ? 'warning' : 'done',
    stat: review ? `${counts.pass} pass / ${counts.rework} rework / ${counts.reject} reject` : 'critic skipped',
    ran: !!review, counts, critic_usd: usd(cost.criticUsd), verdicts, journeys,
    repair: journeys.length ? { count: journeys.length, spent_usd: usd(cost.repairUsd) } : null,
    summary: review?.summary ?? null,
  };

  const rep = report.replay && !report.replay.skipped ? report.replay : null;
  const stab = report.stability && !report.stability.skipped ? report.stability : null;
  const verify: RunDetailStages['verify'] = {
    status: !rep && !stab ? 'not-applicable' : (rep?.failed ?? 0) > 0 || (stab?.flaked ?? 0) > 0 ? 'warning' : 'done',
    stat: stab ? `${stab.passed} stable / ${stab.flaked} flaky` : rep ? `${rep.passed} passed replay / ${rep.failed} dropped` : 'replay skipped',
    replay: rep ? { passed: rep.passed, failed: rep.failed, duration_ms: rep.durationMs, verdicts: rep.verdicts.map((v) => ({ name: v.name, passed: v.passed, failed_step: v.failedStep ?? null, step_kind: v.stepKind ?? null, error: v.error ?? null, observed: observedOf(v.observed) })) } : null,
    stability: stab ? {
      iterations: stab.iterations, passed: stab.passed, flaked: stab.flaked, flaky: stab.flaky ?? null, broken: stab.broken ?? null, recovered: stab.recovered ?? null, flake_rate: stab.flakeRate, stabilizer_cost_usd: stab.stabilizerCostUsd ?? null,
      attempts_total: stab.verdicts.reduce((n, v) => n + (v.attempts ?? []).length, 0),
      warning: stab.warning ?? null,
      verdicts: stab.verdicts.map((v) => ({
        name: v.name, iterations: v.iterations, passes: v.passes, pattern: v.pattern ?? null, classification: v.classification ?? (v.stable ? 'stable' : null), recovered: v.relaxed === true, gave_up: v.gaveUp === true,
        first_failure: v.firstFailure ? { iteration: v.firstFailure.iteration, failed_step: v.firstFailure.failedStep, step_kind: String(v.firstFailure.stepKind), error: v.firstFailure.error, observed: observedOf(v.firstFailure.observed) } : null,
        attempts: (v.attempts ?? []).map((a) => ({ attempt: a.attempt, kind: a.kind, change: a.change, reason: a.reason, pattern: a.pattern ?? null, outcome: a.outcome })),
      })),
    } : null,
  };

  const rec = report.reconciliation;
  const droppedByStage: Record<string, number> = {};
  for (const d of rec?.dropped ?? []) droppedByStage[d.stage] = (droppedByStage[d.stage] ?? 0) + 1;
  const findingsCount = (report.findings ?? []).length;
  const rc = report.ruleCoverage;
  const uncoveredCount = rc ? (rc.uncovered ?? []).length : 0;
  const stabilizer = usd(report.stability?.stabilizerCostUsd);
  const summary: RunDetailStages['summary'] = {
    status: stopped || (rec && rec.balanced === false) || unmatchedVerdicts > 0 ? 'warning' : findingsCount + uncoveredCount > 0 ? 'attention' : 'done',
    stat: `${shipped.length} shipped`,
    shipped: shipped.length, total_usd: totalUsd,
    findings_count: findingsCount, uncovered_count: uncoveredCount, attention: findingsCount + uncoveredCount,
    funnel: rec ? { planned: rec.planned, generated: rec.generated, dropped: (rec.dropped ?? []).length, dropped_by_stage: droppedByStage, incomplete: (rec.incomplete ?? []).length, findings: (rec.findings ?? []).length, skipped: (rec.skipped ?? []).length, balanced: rec.balanced, added: rec.added ?? 0 } : null,
    cost_split: { planner: usd(cost.plannerUsd), explorer: usd(cost.usd) - usd(cost.repairUsd), critic: usd(cost.criticUsd), repair: usd(cost.repairUsd), stabilizer, total: totalUsd },
    rule_coverage: rc ? { covered: (rc.covered ?? []).map((c) => ({ rule_id: c.ruleId, scenarios: c.scenarios ?? [] })), uncovered: (rc.uncovered ?? []).map((u) => ({ rule_id: u.ruleId, text: u.text, reason: u.reason })) } : null,
    zip: artifacts.find((a) => a.kind === 'zip') ?? null,
    stopped,
  };

  return { discovery, plan: planStage, explore, review: reviewStage, verify, summary };
}

/** The stored timeline with its status: no file, an empty file, or events. */
export function eventsFor(runDir: string): { events: StoredEvent[] | null; events_status: 'present' | 'empty' | 'absent' } {
  if (!fs.existsSync(path.join(runDir, EVENTS_FILE))) return { events: null, events_status: 'absent' };
  const events = readRunEvents(runDir);
  return { events, events_status: events.length === 0 ? 'empty' : 'present' };
}
