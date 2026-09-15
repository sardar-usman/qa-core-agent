import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RunReport } from '../../agent/trace.js';
import type { RequirementsMap } from '../../agent/requirements.js';
import { brandSlug } from '../../agent/scaffold.js';
import { listRunDirs, projectSlug, readRunMeta, runIdTime, compactTimestamp, shortHash, type RunDirEntry } from '../../agent/output-layout.js';

/**
 * The indexer: scan output/ for run directories and upsert the index rows
 * (dashboard v2 plan, section 5). Files are truth; every number in `runs`
 * is copied from the run-report, never computed differently, so deleting
 * data/qa-core.sqlite and re-indexing rebuilds every page exactly.
 *
 * Project assignment: by the run URL's host. A run whose host matches no
 * project gets a project created for that host (id = project slug, name =
 * brand); a run with no parseable host goes to "Unassigned".
 *
 * Findings dedupe across runs on (project_id, normalized scenario name,
 * expected text): one row per distinct finding, first_seen / last_seen run
 * ids maintained, status and notes preserved across re-indexes.
 */

export const UNASSIGNED_PROJECT_ID = 'unassigned';

export interface RunRow {
  id: string;
  project_id: string;
  started_at: string | null;
  ended_at: string | null;
  status: 'running' | 'completed' | 'stopped' | 'empty' | 'failed' | 'legacy';
  source: 'cli' | 'dashboard' | 'mcp' | 'telegram';
  url: string | null;
  flags_json: string | null;
  planned: number;
  generated: number;
  dropped: number;
  incomplete: number;
  findings: number;
  skipped: number;
  stable: number;
  flaky: number;
  broken: number;
  /** Scenarios in the emitted framework. NULL for a legacy record, which only knew how many were explored. */
  shipped: number | null;
  cost_total: number;
  cost_planner: number;
  cost_explorer: number;
  cost_critic: number;
  cost_repair: number;
  flake_rate: number | null;
  /** Null for a legacy record: no report on disk. */
  report_path: string | null;
  zip_path: string | null;
  checkpoint_path: string | null;
  stopped_reason: string | null;
}

export interface IndexResult {
  runs: number;
  projects: number;
  findings: number;
  verdicts: number;
  ruleCoverage: number;
  /** Run directories still in the legacy layout (indexed in place). */
  legacy: number;
  /** Pre-v2 gateway records imported from .qa-core/sites/*.json (status 'legacy'). */
  legacyRecords: number;
  /** Records skipped because a real report covers the same run. */
  legacyCovered: number;
  removed: number;
}

const rel = (root: string, p: string): string => path.relative(root, p).split(path.sep).join('/');
const len = (v: unknown): number => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0);

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/** Normalized scenario name for the findings key: lowercase, punctuation and articles dropped, spaces collapsed. */
export function normalizeScenarioName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\b(the|a|an)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

export function findingKey(projectId: string, scenario: string, expected: string): string {
  return crypto.createHash('sha1').update(`${projectId}|${normalizeScenarioName(scenario)}|${expected.trim().toLowerCase()}`).digest('hex').slice(0, 16);
}

/**
 * The runs row for a report: a pure mapping, exported so the smoke can
 * compare a row against its report field by field. Numbers come from
 * `reconciliation` (the funnel the CLI prints); a report without one (older
 * runs) falls back to plan.length / scenarios.length and zeros.
 */
export function runRowFromReport(opts: {
  runId: string;
  projectId: string;
  report: Partial<RunReport>;
  reportPath: string;
  zipPath: string | null;
  checkpointPath: string | null;
  source?: RunRow['source'];
  flags?: Record<string, unknown> | undefined;
}): RunRow {
  const r = opts.report;
  const rec = r.reconciliation;
  const cost = r.cost ?? { usd: 0 } as NonNullable<RunReport['cost']>;
  const scenarios = Array.isArray(r.scenarios) ? r.scenarios : [];
  const repair = cost.repairUsd ?? 0;
  const status: RunRow['status'] = opts.checkpointPath ? 'stopped' : scenarios.length === 0 ? 'empty' : 'completed';
  const started = typeof r.startedAt === 'string' && !Number.isNaN(Date.parse(r.startedAt)) ? r.startedAt : (runIdTime(opts.runId)?.toISOString() ?? null);
  return {
    id: opts.runId,
    project_id: opts.projectId,
    started_at: started,
    ended_at: typeof r.finishedAt === 'string' ? r.finishedAt : null,
    status,
    source: opts.source ?? 'cli',
    url: typeof r.url === 'string' ? r.url : null,
    flags_json: opts.flags ? JSON.stringify(opts.flags) : null,
    planned: rec ? len(rec.planned) : len(r.plan),
    generated: rec ? len(rec.generated) : scenarios.length,
    dropped: rec ? len(rec.dropped) : 0,
    incomplete: rec ? len(rec.incomplete) : len(r.incomplete),
    findings: rec ? len(rec.findings) : len(r.findings),
    skipped: rec ? len(rec.skipped) : len(r.skipped),
    stable: rec ? len(rec.stable) : (r.stability && !r.stability.skipped ? r.stability.passed : 0),
    flaky: rec ? len(rec.flaky) : (r.stability?.flaky ?? 0),
    broken: rec ? len(rec.broken) : (r.stability?.broken ?? 0),
    shipped: scenarios.length,
    // Every cost line the dashboard shows: explorer (incl. repair) + planner + critic + stabilizer.
    cost_total: (cost.usd ?? 0) + (cost.plannerUsd ?? 0) + (cost.criticUsd ?? 0) + (r.stability?.stabilizerCostUsd ?? 0),
    cost_planner: cost.plannerUsd ?? 0,
    cost_explorer: (cost.usd ?? 0) - repair,
    cost_critic: cost.criticUsd ?? 0,
    cost_repair: repair,
    flake_rate: r.stability && !r.stability.skipped && typeof r.stability.flakeRate === 'number' ? r.stability.flakeRate : null,
    report_path: opts.reportPath,
    zip_path: opts.zipPath,
    checkpoint_path: opts.checkpointPath,
    stopped_reason: r.stopped?.reason ?? null,
  };
}

/** The project a run belongs to, created for its host when none matches. */
export function ensureProjectForUrl(db: Database.Database, url: string | null | undefined, now: string = new Date().toISOString()): string {
  const host = hostOf(url);
  if (!host) {
    upsertProject(db, { id: UNASSIGNED_PROJECT_ID, name: 'Unassigned', base_url: null, environment: null }, now);
    return UNASSIGNED_PROJECT_ID;
  }
  const rows = db.prepare('SELECT id, base_url FROM projects').all() as Array<{ id: string; base_url: string | null }>;
  const match = rows.find((p) => hostOf(p.base_url) === host);
  if (match) return match.id;
  const id = projectSlug(url!);
  let origin: string;
  try { origin = new URL(url!).origin + '/'; } catch { origin = url!; }
  // No environment is known for an auto-created project: stored as NULL, never a default label.
  upsertProject(db, { id, name: brandSlug(url!), base_url: origin, environment: null }, now);
  return id;
}

function upsertProject(db: Database.Database, p: { id: string; name: string; base_url: string | null; environment: string | null }, now: string): void {
  db.prepare(`INSERT INTO projects (id, name, base_url, environment, created_at, updated_at)
              VALUES (@id, @name, @base_url, @environment, @now, @now)
              ON CONFLICT(id) DO NOTHING`).run({ ...p, now });
}

const RUN_COLUMNS: Array<keyof RunRow> = [
  'id', 'project_id', 'started_at', 'ended_at', 'status', 'source', 'url', 'flags_json', 'planned', 'generated', 'dropped', 'incomplete',
  'findings', 'skipped', 'stable', 'flaky', 'broken', 'shipped', 'cost_total', 'cost_planner', 'cost_explorer', 'cost_critic', 'cost_repair',
  'flake_rate', 'report_path', 'zip_path', 'checkpoint_path', 'stopped_reason',
];

function upsertRun(db: Database.Database, row: RunRow): void {
  const cols = RUN_COLUMNS.join(', ');
  const vals = RUN_COLUMNS.map((c) => `@${c}`).join(', ');
  const sets = RUN_COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
  db.prepare(`INSERT INTO runs (${cols}) VALUES (${vals}) ON CONFLICT(id) DO UPDATE SET ${sets}`).run(row);
}

const UNCOVERED_STATUS: Record<string, 'not_planned' | 'planned_but_dropped' | 'planned_not_explored'> = {
  'not-planned': 'not_planned',
  'planned-but-dropped': 'planned_but_dropped',
  'planned-not-explored': 'planned_not_explored',
};

/** Index one run directory: the runs row and its derived rows. */
export function indexRunDir(db: Database.Database, root: string, entry: RunDirEntry): RunRow | null {
  const reportPath = path.join(entry.dir, 'run-report.json');
  let report: Partial<RunReport>;
  try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Partial<RunReport>; } catch { return null; }
  if (!Array.isArray(report.scenarios)) return null;
  const meta = readRunMeta(entry.dir);
  const zip = fs.readdirSync(entry.dir).find((f) => f.endsWith('.zip'));
  const cpFile = path.join(entry.dir, 'checkpoint.json');
  const projectId = ensureProjectForUrl(db, report.url);
  const row = runRowFromReport({
    runId: entry.runId, projectId, report,
    reportPath: rel(root, reportPath),
    zipPath: zip ? rel(root, path.join(entry.dir, zip)) : null,
    checkpointPath: fs.existsSync(cpFile) ? rel(root, cpFile) : null,
    ...(meta?.source ? { source: meta.source } : {}),
    flags: meta?.flags,
  });
  let map: RequirementsMap | null = null;
  try { map = JSON.parse(fs.readFileSync(path.join(entry.dir, 'requirements-map.json'), 'utf8')) as RequirementsMap; } catch { /* no SRS */ }

  db.transaction(() => {
    upsertRun(db, row);
    // Derived rows are rebuilt for the run; findings keep their status/notes.
    db.prepare('DELETE FROM verdicts WHERE run_id = ?').run(row.id);
    db.prepare('DELETE FROM rule_coverage WHERE run_id = ?').run(row.id);
    const review = report.review;
    if (review && Array.isArray(review.verdicts)) {
      const journeys = new Map((review.repair ?? []).map((j) => [j.scenario, j]));
      const ins = db.prepare('INSERT OR REPLACE INTO verdicts (run_id, scenario, verdict, journey_json, reasons_json) VALUES (?, ?, ?, ?, ?)');
      for (const v of review.verdicts) {
        const verdict = ['pass', 'rework', 'reject'].includes(v.verdict) ? v.verdict : 'rework';
        const j = journeys.get(v.scenario);
        ins.run(row.id, v.scenario, verdict, j ? JSON.stringify(j) : null, JSON.stringify(v.reasons ?? []));
      }
    }
    const rc = report.ruleCoverage;
    if (rc) {
      const ruleInfo = new Map<string, { text: string; feature: string }>();
      for (const f of map?.features ?? []) for (const r of f.rules ?? []) ruleInfo.set(r.id, { text: r.text, feature: f.name });
      const ins = db.prepare('INSERT OR REPLACE INTO rule_coverage (run_id, rule_id, rule_text, feature, status, scenarios_json) VALUES (?, ?, ?, ?, ?, ?)');
      for (const c of rc.covered ?? []) ins.run(row.id, c.ruleId, ruleInfo.get(c.ruleId)?.text ?? null, ruleInfo.get(c.ruleId)?.feature ?? null, 'covered', JSON.stringify(c.scenarios ?? []));
      for (const u of rc.uncovered ?? []) ins.run(row.id, u.ruleId, u.text ?? ruleInfo.get(u.ruleId)?.text ?? null, ruleInfo.get(u.ruleId)?.feature ?? null, UNCOVERED_STATUS[u.reason] ?? 'not_planned', '[]');
    }
    for (const f of report.findings ?? []) {
      const id = findingKey(projectId, f.scenario, f.expected);
      // Report data only, no inference: the page's messages verbatim, or the URL at the time when it said nothing.
      const observed = f.messages && f.messages.length ? f.messages.join(' | ') : `no message recorded; URL at the time: ${f.url}`;
      const existing = db.prepare('SELECT first_seen_run_id, last_seen_run_id FROM findings WHERE id = ?').get(id) as { first_seen_run_id: string; last_seen_run_id: string } | undefined;
      if (!existing) {
        db.prepare(`INSERT INTO findings (id, run_id, project_id, scenario, expected, observed, page_url, status, first_seen_run_id, last_seen_run_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(id, row.id, projectId, f.scenario, f.expected, observed, f.url, row.id, row.id);
      } else {
        const first = runOrder(existing.first_seen_run_id, db) <= runOrder(row.id, db) ? existing.first_seen_run_id : row.id;
        const last = runOrder(existing.last_seen_run_id, db) >= runOrder(row.id, db) ? existing.last_seen_run_id : row.id;
        db.prepare('UPDATE findings SET run_id = ?, observed = ?, page_url = ?, first_seen_run_id = ?, last_seen_run_id = ? WHERE id = ?')
          .run(last, observed, f.url, first, last, id);
      }
      db.prepare('INSERT OR IGNORE INTO finding_runs (finding_id, run_id) VALUES (?, ?)').run(id, row.id);
    }
  })();
  return row;
}

/* ─────────────────── Pre-v2 gateway records ─────────────────── */

/**
 * The gateway's per-host record store, written by memory.ts after every run:
 * .qa-core/sites/<host>.json holds `recentRuns` [{ at, url, scenarios, cost,
 * model, durationSec }] (the last 5 per host). Runs from before the per-run
 * layout survive only there, so they are imported as `runs` rows with status
 * 'legacy', report_path null, and the numbers the record carries. The
 * record's `scenarios` is how many the run EXPLORED (memory.saveRun wrote it
 * before replay and stability dropped anything), so it is stored as
 * `generated` and `shipped` stays NULL: a legacy row never claims a shipped
 * count. cost_total = cost, started_at = at - durationSec, ended_at = at.
 * Nothing else is invented (planned and the funnel stay 0).
 *
 * A record is skipped when a real report covers the same run: same host and
 * the report's finish time within LEGACY_MATCH_MS of the record's `at` (the
 * record is written when the run ends). A real report therefore always wins
 * and a legacy row is never allowed to shadow or overwrite it.
 */
export interface LegacyRecord { at: string; url: string; scenarios: number; cost: number; model: string; durationSec: number }

export const LEGACY_MATCH_MS = 120_000;

export function legacyRunId(host: string, rec: LegacyRecord): string {
  const at = new Date(rec.at);
  return `legacy-${Number.isNaN(at.getTime()) ? 'undated' : compactTimestamp(at)}-${shortHash(`${host}|${rec.at}|${rec.url}`)}`;
}

export function readLegacyRecords(root: string): Array<{ host: string; record: LegacyRecord }> {
  const dir = path.join(root, '.qa-core', 'sites');
  const out: Array<{ host: string; record: LegacyRecord }> = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const site = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { host?: string; recentRuns?: LegacyRecord[] };
      for (const r of site.recentRuns ?? []) {
        if (!r || typeof r.at !== 'string') continue;
        out.push({ host: String(site.host ?? f.replace(/\.json$/, '')), record: r });
      }
    } catch { /* an unreadable memory file is not a run */ }
  }
  return out;
}

/** The runs row a legacy record becomes. Pure, exported for the smoke. */
export function runRowFromLegacyRecord(host: string, rec: LegacyRecord, projectId: string): RunRow {
  const at = Date.parse(rec.at);
  const ended = Number.isNaN(at) ? null : new Date(at).toISOString();
  const started = Number.isNaN(at) ? null : new Date(at - Math.max(0, Number(rec.durationSec) || 0) * 1000).toISOString();
  const explored = Number(rec.scenarios) || 0;
  const cost = Number(rec.cost) || 0;
  return {
    id: legacyRunId(host, rec),
    project_id: projectId,
    started_at: started,
    ended_at: ended,
    status: 'legacy',
    source: 'cli',
    url: rec.url && rec.url !== '--' ? rec.url : null,
    flags_json: JSON.stringify({ model: rec.model, durationSec: rec.durationSec, legacyHost: host }),
    planned: 0, generated: explored, dropped: 0, incomplete: 0, findings: 0, skipped: 0,
    stable: 0, flaky: 0, broken: 0, shipped: null,
    cost_total: cost, cost_planner: 0, cost_explorer: cost, cost_critic: 0, cost_repair: 0,
    flake_rate: null,
    report_path: null, zip_path: null, checkpoint_path: null, stopped_reason: null,
  };
}

/** Does a real (reported) run cover this record? Same host, finished within the match window. */
function coveredByReport(db: Database.Database, host: string | null, rec: LegacyRecord): boolean {
  const at = Date.parse(rec.at);
  if (Number.isNaN(at)) return false;
  const rows = db.prepare("SELECT url, ended_at, started_at FROM runs WHERE report_path IS NOT NULL").all() as Array<{ url: string | null; ended_at: string | null; started_at: string | null }>;
  return rows.some((r) => {
    if (hostOf(r.url) !== host) return false;
    const end = r.ended_at ? Date.parse(r.ended_at) : NaN;
    const start = r.started_at ? Date.parse(r.started_at) : NaN;
    return (!Number.isNaN(end) && Math.abs(end - at) <= LEGACY_MATCH_MS) || (!Number.isNaN(start) && at >= start - LEGACY_MATCH_MS && !Number.isNaN(end) && at <= end + LEGACY_MATCH_MS);
  });
}

/**
 * Import the record store. Returns the ids now present so indexOutput can
 * keep them, plus the count skipped because a report covers them.
 */
export function importLegacyRecords(db: Database.Database, root: string): { ids: string[]; covered: number } {
  const ids: string[] = [];
  let covered = 0;
  for (const { host, record } of readLegacyRecords(root)) {
    const recHost = hostOf(record.url) ?? (host && host !== 'unknown' ? host.toLowerCase().replace(/^www\./, '') : null);
    if (coveredByReport(db, recHost, record)) { covered++; continue; }
    const projectId = ensureProjectForUrl(db, record.url && record.url !== '--' ? record.url : (recHost ? `https://${recHost}/` : null));
    const row = runRowFromLegacyRecord(host, record, projectId);
    // Never overwrite a row that has a real report (a legacy id never
    // collides with a run-id, this guards the invariant explicitly).
    const existing = db.prepare('SELECT report_path FROM runs WHERE id = ?').get(row.id) as { report_path: string | null } | undefined;
    if (existing && existing.report_path) continue;
    upsertRun(db, row);
    ids.push(row.id);
  }
  return { ids, covered };
}

/** Ordering key for first/last seen: the run's start time, then its id. */
function runOrder(runId: string, db: Database.Database): string {
  const row = db.prepare('SELECT started_at FROM runs WHERE id = ?').get(runId) as { started_at: string | null } | undefined;
  return `${row?.started_at ?? ''}|${runId}`;
}

/**
 * Full scan of output/: index every run directory (both layouts) and drop
 * rows whose report no longer exists on disk. Idempotent.
 */
export function indexOutput(db: Database.Database, root: string): IndexResult {
  const entries = listRunDirs(path.join(root, 'output'));
  // Oldest first so first_seen_run_id lands on the earliest run.
  entries.sort((a, b) => (startedAtOf(a) ?? a.runId).localeCompare(startedAtOf(b) ?? b.runId));
  const seen = new Set<string>();
  let legacy = 0;
  for (const e of entries) {
    const row = indexRunDir(db, root, e);
    if (row) { seen.add(row.id); if (e.legacy) legacy++; }
  }
  // Pre-v2 gateway records, after the reports so a report always wins.
  const legacyImport = importLegacyRecords(db, root);
  for (const id of legacyImport.ids) seen.add(id);
  // Runs that vanished from disk (and legacy rows whose record is gone or is now covered by a report).
  const known = db.prepare('SELECT id FROM runs').all() as Array<{ id: string }>;
  let removed = 0;
  const del = db.transaction((ids: string[]) => {
    for (const id of ids) {
      db.prepare('DELETE FROM verdicts WHERE run_id = ?').run(id);
      db.prepare('DELETE FROM rule_coverage WHERE run_id = ?').run(id);
      db.prepare('DELETE FROM finding_runs WHERE run_id = ? OR finding_id IN (SELECT id FROM findings WHERE run_id = ? OR first_seen_run_id = ? OR last_seen_run_id = ?)').run(id, id, id, id);
      db.prepare('DELETE FROM findings WHERE run_id = ? OR first_seen_run_id = ? OR last_seen_run_id = ?').run(id, id, id);
      db.prepare('UPDATE terminals SET run_id = NULL WHERE run_id = ?').run(id);
      db.prepare('DELETE FROM runs WHERE id = ?').run(id);
      removed++;
    }
  });
  del(known.map((k) => k.id).filter((id) => !seen.has(id)));
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  return {
    runs: count('SELECT COUNT(*) AS n FROM runs'),
    projects: count('SELECT COUNT(*) AS n FROM projects'),
    findings: count('SELECT COUNT(*) AS n FROM findings'),
    verdicts: count('SELECT COUNT(*) AS n FROM verdicts'),
    ruleCoverage: count('SELECT COUNT(*) AS n FROM rule_coverage'),
    legacy,
    legacyRecords: legacyImport.ids.length,
    legacyCovered: legacyImport.covered,
    removed,
  };
}

function startedAtOf(e: RunDirEntry): string | null {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(e.dir, 'run-report.json'), 'utf8')) as { startedAt?: string };
    return typeof r.startedAt === 'string' ? r.startedAt : null;
  } catch { return null; }
}

/** Console line for an index pass. */
export function renderIndexResult(r: IndexResult): string {
  return `Index: ${r.runs} run(s) across ${r.projects} project(s), ${r.findings} finding(s), ${r.verdicts} verdict(s), ${r.ruleCoverage} rule row(s)` +
    (r.legacy ? ` · ${r.legacy} legacy folder(s) indexed in place, run \`npm run migrate-output\` to move them` : '') +
    (r.legacyRecords ? ` · ${r.legacyRecords} pre-v2 record(s) imported as summary-only runs` : '') +
    (r.legacyCovered ? ` · ${r.legacyCovered} pre-v2 record(s) covered by a report` : '') +
    (r.removed ? ` · ${r.removed} vanished run(s) removed` : '');
}
