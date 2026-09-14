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
  kind: 'zip' | 'report' | 'rule-coverage' | 'requirements-map' | 'checkpoint' | 'events' | 'screenshot' | 'spec' | 'meta' | 'other';
  size: number;
  /** API path that serves the file. */
  href: string;
}

export interface RunDetailBody {
  legacy: false;
  run: Record<string, unknown>;
  header: {
    run_id: string; project_id: string; project_name: string; host: string | null; url: string | null;
    started_at: string | null; ended_at: string | null; environment: string | null; status: string; source: string;
    cost: { total: number; planner: number; explorer: number; critic: number; repair: number; stabilizer: number | null };
    stopped_reason: string | null;
  };
  scenarios: RunDetailScenario[];
  /** Stored counts, copied from the index row (which copied them from the report). */
  counts: { planned: number; shipped: number | null; generated: number; dropped: number; incomplete: number; findings: number; skipped: number; stable: number; flaky: number; broken: number };
  findings: Array<{ scenario: string; category: string | null; expected: string; url: string; messages: string[] }>;
  replay: RunReport['replay'] | null;
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
    status: String(run.status), source: String(run.source),
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
  const unmatched_verdicts = verdicts.filter((v) => !claimed.has(v) && ![...findingNames].some((f) => verdictMatchesScenario(v.scenario, f))).map((v) => ({ scenario: v.scenario, verdict: v.verdict, reasons: v.reasons }));
  const journeys = (report.review?.repair ?? []).map((j) => ({ scenario: j.scenario, verdict: 'rework' as const, reasons: [], required_fixes: [], journey: j }));
  for (const [name, j] of assignVerdicts(names, journeys)) { const r = rows.get(name)!; const jj = (j as typeof journeys[number]).journey; r.repair = jj.outcome === 'kept' ? 'repaired' : 'failed'; r.repair_second = jj.second ?? 'not re-recorded'; }
  const planOrder = new Map((report.plan ?? []).map((p, i) => [p.name, i]));
  const scenarios = [...rows.values()].sort((a, b) => (planOrder.get(a.name) ?? 1e9) - (planOrder.get(b.name) ?? 1e9) || a.name.localeCompare(b.name));

  const stab = report.stability && !report.stability.skipped ? report.stability : null;
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
      findings: findings.map((f) => ({ scenario: f.scenario, category: f.category ?? null, expected: f.expected, url: f.url, messages: f.messages ?? [] })),
      replay: report.replay && !report.replay.skipped ? report.replay : null,
      stability: stab ? { iterations: stab.iterations, passed: stab.passed, flaked: stab.flaked, flakeRate: stab.flakeRate, recovered: stab.recovered ?? null, stabilizerCostUsd: stab.stabilizerCostUsd ?? null } : null,
      review_summary: report.review?.summary ?? null,
      reconciliation: report.reconciliation ?? null,
      rule_coverage: report.ruleCoverage ?? null,
      unmatched_verdicts,
      artifacts: listArtifacts(runDir, id),
      ...eventsFor(runDir),
    },
  };
}

/** The stored timeline with its status: no file, an empty file, or events. */
export function eventsFor(runDir: string): { events: StoredEvent[] | null; events_status: 'present' | 'empty' | 'absent' } {
  if (!fs.existsSync(path.join(runDir, EVENTS_FILE))) return { events: null, events_status: 'absent' };
  const events = readRunEvents(runDir);
  return { events, events_status: events.length === 0 ? 'empty' : 'present' };
}
