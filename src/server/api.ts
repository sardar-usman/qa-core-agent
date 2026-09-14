import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type Database from 'better-sqlite3';
import { indexOutput, renderIndexResult, type IndexResult } from './db/indexer.js';
import { buildRunDetail, runArtifactFile } from './run-detail.js';
import { parseGatewayCommand } from './commands.js';

/**
 * REST API over the index (dashboard v2 plan, section 6; PR A ships the GET
 * routes plus POST /api/reindex; PR B adds /api/runs/:id/detail and
 * /api/runs/:id/artifacts/:name). JSON only. Every route is guarded by the
 * same token as the WebSocket: `Authorization: Bearer <token>` or `?token=`.
 * Without a configured token the gateway is local-only and the API is open,
 * exactly like the socket.
 *
 * Every number returned is a column the indexer copied from a run-report;
 * the aggregates (lifetime shipped, open findings, spend this month) are
 * sums over those columns, so a page can never disagree with the reports.
 */

export interface ApiContext {
  db: Database.Database;
  root: string;
  token: string;
  /** Called by POST /api/reindex; defaults to a full indexOutput pass. */
  reindex?: () => IndexResult;
  log?: (line: string) => void;
}

export type ApiHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

/** True when the request carries the configured token (or none is configured). */
export function authorized(req: http.IncomingMessage, token: string): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${token}`) return true;
  try {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.searchParams.get('token') === token) return true;
  } catch { /* fall through */ }
  return false;
}

const RUN_ID_SAFE = /^[A-Za-z0-9._-]+$/;

/** Build the /api handler. Returns false for non-/api paths so static serving can take over. */
export function createApiHandler(ctx: ApiContext): ApiHandler {
  const { db, root } = ctx;
  const reindex = ctx.reindex ?? (() => indexOutput(db, root));

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (!url.pathname.startsWith('/api/')) return false;
    if (!authorized(req, ctx.token)) { json(res, 401, { error: 'unauthorized: pass Authorization: Bearer <QA_CORE_GATEWAY_TOKEN> or ?token=' }); return true; }
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    try {
      if (method === 'GET' && parts.length === 2 && parts[1] === 'projects') { json(res, 200, { projects: listProjects(db) }); return true; }
      if (method === 'GET' && parts.length === 3 && parts[1] === 'projects') {
        const p = projectDetail(db, decodeURIComponent(parts[2]!));
        if (!p) { json(res, 404, { error: 'project not found' }); return true; }
        json(res, 200, p); return true;
      }
      if (method === 'GET' && parts.length === 4 && parts[1] === 'projects' && (parts[3] === 'coverage' || parts[3] === 'trends')) {
        const id = decodeURIComponent(parts[2]!);
        if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id)) { json(res, 404, { error: 'project not found' }); return true; }
        json(res, 200, parts[3] === 'coverage' ? projectCoverage(db, id) : projectTrends(db, id)); return true;
      }
      if (method === 'GET' && parts.length === 2 && parts[1] === 'findings') {
        json(res, 200, { findings: listFindings(db, { projectId: url.searchParams.get('project_id'), status: url.searchParams.get('status') }) }); return true;
      }
      if (method === 'PATCH' && parts.length === 3 && parts[1] === 'findings') {
        const id = decodeURIComponent(parts[2]!);
        const body = await readJsonBody(req);
        const result = patchFinding(db, id, body);
        json(res, result.status, result.body); return true;
      }
      if (method === 'GET' && parts.length === 2 && parts[1] === 'runs') {
        json(res, 200, { runs: listRuns(db, { projectId: url.searchParams.get('project_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') ?? 100) }) });
        return true;
      }
      if (method === 'GET' && parts.length >= 3 && parts[1] === 'runs') {
        const id = decodeURIComponent(parts[2]!);
        if (!RUN_ID_SAFE.test(id)) { json(res, 400, { error: 'bad run id' }); return true; }
        const run = db.prepare('SELECT r.*, p.name AS project_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?').get(id) as Record<string, unknown> | undefined;
        if (!run) {
          // Loud, and it names what was looked for (the detail route carries the same message).
          const lookedFor = `output/*/${id}/run-report.json`;
          json(res, 404, { error: `no run '${id}' in the index; looked for ${lookedFor}`, looked_for: lookedFor }); return true;
        }
        if (parts.length === 3) { json(res, 200, { run }); return true; }
        if (parts[3] === 'detail') {
          const detail = buildRunDetail(db, root, id);
          json(res, detail.status, detail.body); return true;
        }
        if (parts[3] === 'artifacts' && parts.length === 5) {
          const name = decodeURIComponent(parts[4]!);
          const file = runArtifactFile(root, { report_path: (run.report_path as string | null) ?? null }, name);
          if (!file) { json(res, 404, { error: `no artifact '${name}' in this run's directory` }); return true; }
          const stat = fs.statSync(file);
          const type = name.endsWith('.json') ? 'application/json; charset=utf-8' : name.endsWith('.jsonl') ? 'application/x-ndjson; charset=utf-8' : name.endsWith('.zip') ? 'application/zip' : /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store', ...(name.endsWith('.zip') ? { 'Content-Disposition': `attachment; filename="${name}"` } : {}) });
          fs.createReadStream(file).pipe(res); return true;
        }
        if (parts[3] === 'report') {
          if (!run.report_path) { json(res, 404, { error: 'this run is a pre-v2 record with no report on disk' }); return true; }
          const file = safeRunFile(root, String(run.report_path));
          if (!file) { json(res, 404, { error: 'report not found' }); return true; }
          const body = fs.readFileSync(file);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
          res.end(body); return true;
        }
        if (parts[3] === 'zip') {
          const zipRel = run.zip_path ? String(run.zip_path) : null;
          const file = zipRel ? safeRunFile(root, zipRel) : null;
          if (!file) { json(res, 404, { error: 'no zip for this run' }); return true; }
          const stat = fs.statSync(file);
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${path.basename(file)}"` });
          fs.createReadStream(file).pipe(res); return true;
        }
      }
      // The Terminal page's one parser: the same parseGatewayCommand the
      // socket runs, so the form never parses a flag itself.
      if (method === 'POST' && parts.length === 3 && parts[1] === 'command' && parts[2] === 'parse') {
        const body = await readJsonBody(req);
        const content = typeof body.content === 'string' ? body.content : '';
        const lang = body.lang === 'js' ? 'js' : 'ts';
        json(res, 200, parseCommandForUi(content, lang)); return true;
      }
      if (method === 'POST' && parts.length === 2 && parts[1] === 'reindex') {
        const result = reindex();
        ctx.log?.(renderIndexResult(result));
        json(res, 200, { ok: true, result }); return true;
      }
      json(res, 404, { error: `no route for ${method} ${url.pathname}` });
      return true;
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
      return true;
    }
  };
}

async function readJsonBody(req: http.IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => { if (data.length < limit) data += c.toString('utf8'); });
    req.on('end', () => { try { const v = JSON.parse(data || '{}') as unknown; resolve(v && typeof v === 'object' ? v as Record<string, unknown> : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/** What POST /api/command/parse returns: the parsed command, or the parser's own message. */
export type ParsedCommandForUi =
  | { ok: true; kind: 'explore'; request: Record<string, unknown>; notes: string[]; naturalHint: string | null }
  | { ok: true; kind: 'transcribe' | 'generate' | 'heal' | 'eval'; summary: string }
  | { ok: false; error: string };

export function parseCommandForUi(content: string, lang: 'ts' | 'js'): ParsedCommandForUi {
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, error: 'Type a command: /explore <url> [flags], /resume <checkpoint.json>, /transcribe <run-report.json>, /heal <spec>, /generate <story>.' };
  const cmd = parseGatewayCommand(trimmed, { lang });
  switch (cmd.kind) {
    case 'reply': return { ok: false, error: cmd.text };
    case 'explore': return { ok: true, kind: 'explore', request: cmd.request as unknown as Record<string, unknown>, notes: cmd.notes, naturalHint: cmd.naturalHint ?? null };
    case 'transcribe': return { ok: true, kind: 'transcribe', summary: `regenerate the framework from ${cmd.reportPath}${cmd.outDir ? ` into ${cmd.outDir}` : ''}` };
    case 'generate': return { ok: true, kind: 'generate', summary: `generate an unverified spec from the story` };
    case 'heal': return { ok: true, kind: 'heal', summary: `heal the selectors in ${cmd.specPath}` };
    case 'eval': return { ok: true, kind: 'eval', summary: `run the benchmark${cmd.pom ? '' : ' (inline mode)'}` };
  }
}

/**
 * A run file the index recorded, resolved under the project root. The path
 * must stay inside root and name the recorded file, so an id cannot be
 * used to read anything else.
 */
export function safeRunFile(root: string, relPath: string): string | null {
  const resolved = path.resolve(root, relPath);
  const rootResolved = path.resolve(root) + path.sep;
  if (!resolved.startsWith(rootResolved)) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

function monthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export interface ProjectCard {
  id: string; name: string; base_url: string | null; environment: string | null; srs_path: string | null;
  /** All runs, reported and legacy. */
  runs: number;
  /** Runs with a report on disk. */
  reported_runs: number;
  /** Tests shipped, summed over runs that have a report. NULL when the project has no reported run (legacy only): nothing is known, never 0. */
  shipped: number | null;
  /** Pre-v2 records (summary only): counted apart, never added to shipped. */
  legacy_runs: number;
  /** Scenarios the pre-v2 records explored (their only count). */
  legacy_explored: number;
  /** Open or triaged findings. NULL when the project has no reported run. */
  open_findings: number | null;
  spend_month: number; spend_total: number;
  last_run: { id: string; status: string; started_at: string | null; shipped: number | null; generated: number; cost_total: number } | null;
  /** Rule coverage percent per run (oldest first), for the sparkline; empty without SRS runs. */
  coverage_series: Array<{ run_id: string; started_at: string | null; percent: number }>;
}

export function listProjects(db: Database.Database): ProjectCard[] {
  // Unassigned (records with no URL) sorts last; the UI mutes it.
  const projects = db.prepare("SELECT * FROM projects ORDER BY CASE WHEN id = 'unassigned' THEN 1 ELSE 0 END, name").all() as Array<Record<string, unknown>>;
  return projects.map((p) => projectCard(db, p));
}

function projectCard(db: Database.Database, p: Record<string, unknown>): ProjectCard {
  const id = String(p.id);
  const agg = db.prepare(`SELECT COUNT(*) AS runs,
                          SUM(CASE WHEN report_path IS NOT NULL THEN 1 ELSE 0 END) AS reported_runs,
                          COALESCE(SUM(CASE WHEN report_path IS NOT NULL THEN shipped ELSE 0 END), 0) AS shipped,
                          SUM(CASE WHEN status = 'legacy' THEN 1 ELSE 0 END) AS legacy_runs,
                          COALESCE(SUM(CASE WHEN status = 'legacy' THEN generated ELSE 0 END), 0) AS legacy_explored,
                          COALESCE(SUM(cost_total), 0) AS spend_total,
                          COALESCE(SUM(CASE WHEN started_at >= ? THEN cost_total ELSE 0 END), 0) AS spend_month
                          FROM runs WHERE project_id = ?`).get(monthStart(), id) as { runs: number; reported_runs: number | null; shipped: number; legacy_runs: number | null; legacy_explored: number; spend_total: number; spend_month: number };
  const open = db.prepare("SELECT COUNT(*) AS n FROM findings WHERE project_id = ? AND status IN ('open', 'triaged')").get(id) as { n: number };
  const reported = agg.reported_runs ?? 0;
  const last = db.prepare('SELECT id, status, started_at, shipped, generated, cost_total FROM runs WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(id) as ProjectCard['last_run'] | undefined;
  const coverage = db.prepare(`SELECT r.id AS run_id, r.started_at,
                                 SUM(CASE WHEN c.status = 'covered' THEN 1 ELSE 0 END) AS covered, COUNT(*) AS total
                               FROM rule_coverage c JOIN runs r ON r.id = c.run_id WHERE r.project_id = ?
                               GROUP BY r.id ORDER BY r.started_at ASC, r.id ASC`).all(id) as Array<{ run_id: string; started_at: string | null; covered: number; total: number }>;
  return {
    id, name: String(p.name), base_url: (p.base_url as string | null) ?? null, environment: (p.environment as string | null) ?? null, srs_path: (p.srs_path as string | null) ?? null,
    runs: agg.runs, reported_runs: reported, shipped: reported > 0 ? agg.shipped : null, legacy_runs: agg.legacy_runs ?? 0, legacy_explored: agg.legacy_explored,
    open_findings: reported > 0 ? open.n : null, spend_month: agg.spend_month, spend_total: agg.spend_total,
    last_run: last ?? null,
    coverage_series: coverage.map((c) => ({ run_id: c.run_id, started_at: c.started_at, percent: c.total ? Math.round((c.covered / c.total) * 100) : 0 })),
  };
}

export function projectDetail(db: Database.Database, id: string): Record<string, unknown> | null {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!p) return null;
  const card = projectCard(db, p);
  const trend = db.prepare(`SELECT id AS run_id, started_at, status, shipped, planned, cost_total, flake_rate FROM runs WHERE project_id = ? ORDER BY started_at ASC, id ASC`).all(id) as Array<Record<string, unknown>>;
  const coverageByRun = new Map(card.coverage_series.map((c) => [c.run_id, c.percent]));
  const openFindings = listFindings(db, { projectId: id, status: 'open,triaged' });
  return {
    project: p,
    summary: { runs: card.runs, reported_runs: card.reported_runs, shipped: card.shipped, legacy_runs: card.legacy_runs, legacy_explored: card.legacy_explored, open_findings: card.open_findings, spend_total: card.spend_total, spend_month: card.spend_month, last_run: card.last_run },
    trend: trend.map((t) => ({ ...t, coverage_percent: coverageByRun.get(String(t.run_id)) ?? null })),
    open_findings: openFindings,
  };
}

export function listRuns(db: Database.Database, f: { projectId: string | null; status: string | null; limit: number }): Array<Record<string, unknown>> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.projectId) { where.push('r.project_id = ?'); args.push(f.projectId); }
  if (f.status) { where.push('r.status = ?'); args.push(f.status); }
  const limit = Number.isFinite(f.limit) && f.limit > 0 ? Math.min(f.limit, 500) : 100;
  return db.prepare(`SELECT r.*, p.name AS project_name FROM runs r JOIN projects p ON p.id = r.project_id
                     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.started_at DESC, r.id DESC LIMIT ?`).all(...args, limit) as Array<Record<string, unknown>>;
}

/* ─────────────────── findings ─────────────────── */

export const FINDING_STATUSES = ['open', 'triaged', 'fixed', 'wont-fix'] as const;
export type FindingStatus = typeof FINDING_STATUSES[number];

export interface FindingRow {
  id: string; project_id: string; project_name: string; scenario: string; expected: string; observed: string | null; page_url: string | null;
  status: FindingStatus; notes: string | null;
  first_seen_run_id: string; last_seen_run_id: string; first_seen_at: string | null; last_seen_at: string | null;
  /** Runs this finding was seen in (finding_runs rows), newest first. */
  run_ids: string[];
  times_seen: number;
}

/**
 * Deduped findings (one row per project + normalized scenario + expected,
 * the indexer's key), each with every run that saw it. `status` accepts a
 * single value or a comma-separated set.
 */
export function listFindings(db: Database.Database, f: { projectId: string | null; status: string | null }): FindingRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.projectId) { where.push('f.project_id = ?'); args.push(f.projectId); }
  const statuses = (f.status ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (statuses.length) { where.push(`f.status IN (${statuses.map(() => '?').join(', ')})`); args.push(...statuses); }
  const rows = db.prepare(`SELECT f.*, p.name AS project_name, r1.started_at AS first_seen_at, r2.started_at AS last_seen_at
                           FROM findings f JOIN projects p ON p.id = f.project_id
                           LEFT JOIN runs r1 ON r1.id = f.first_seen_run_id LEFT JOIN runs r2 ON r2.id = f.last_seen_run_id
                           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                           ORDER BY r2.started_at DESC, f.id`).all(...args) as Array<Record<string, unknown>>;
  const runsFor = db.prepare('SELECT fr.run_id FROM finding_runs fr LEFT JOIN runs r ON r.id = fr.run_id WHERE fr.finding_id = ? ORDER BY r.started_at DESC, fr.run_id DESC');
  return rows.map((r) => {
    const runIds = (runsFor.all(String(r.id)) as Array<{ run_id: string }>).map((x) => x.run_id);
    return {
      id: String(r.id), project_id: String(r.project_id), project_name: String(r.project_name), scenario: String(r.scenario), expected: String(r.expected),
      observed: (r.observed as string | null) ?? null, page_url: (r.page_url as string | null) ?? null,
      status: (r.status as FindingStatus) ?? 'open', notes: (r.notes as string | null) ?? null,
      first_seen_run_id: String(r.first_seen_run_id), last_seen_run_id: String(r.last_seen_run_id),
      first_seen_at: (r.first_seen_at as string | null) ?? null, last_seen_at: (r.last_seen_at as string | null) ?? null,
      run_ids: runIds, times_seen: runIds.length,
    };
  });
}

/** PATCH /api/findings/:id: status (one of FINDING_STATUSES) and/or notes (string or null). Nothing else is writable. */
export function patchFinding(db: Database.Database, id: string, body: Record<string, unknown>): { status: number; body: unknown } {
  const existing = db.prepare('SELECT id FROM findings WHERE id = ?').get(id);
  if (!existing) return { status: 404, body: { error: `no finding '${id}'` } };
  const sets: string[] = [];
  const args: unknown[] = [];
  if ('status' in body) {
    if (typeof body.status !== 'string' || !(FINDING_STATUSES as readonly string[]).includes(body.status)) {
      return { status: 400, body: { error: `status must be one of ${FINDING_STATUSES.join(', ')}` } };
    }
    sets.push('status = ?'); args.push(body.status);
  }
  if ('notes' in body) {
    if (body.notes !== null && typeof body.notes !== 'string') return { status: 400, body: { error: 'notes must be a string or null' } };
    if (typeof body.notes === 'string' && body.notes.length > 4000) return { status: 400, body: { error: 'notes must be 4000 characters or fewer' } };
    sets.push('notes = ?'); args.push(body.notes === '' ? null : body.notes);
  }
  if (!sets.length) return { status: 400, body: { error: 'nothing to update: send status and/or notes' } };
  db.prepare(`UPDATE findings SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  const row = listFindings(db, { projectId: null, status: null }).find((f) => f.id === id);
  return { status: 200, body: { finding: row } };
}

/* ─────────────────── coverage and trends ─────────────────── */

export type RuleStatus = 'covered' | 'not_planned' | 'planned_but_dropped' | 'planned_not_explored';

export interface ProjectCoverage {
  project_id: string;
  /** Runs of this project that recorded rule coverage (an SRS run). */
  srs_runs: number;
  rules: Array<{
    rule_id: string; text: string | null; feature: string | null;
    /** The classification from the most recent SRS run that reported this rule. */
    latest_status: RuleStatus; latest_run_id: string; latest_run_at: string | null;
    /** The most recent run in which the rule was covered, and by which scenarios; null when never covered. */
    last_covered_run_id: string | null; last_covered_at: string | null; last_covered_scenarios: string[];
    /** How many SRS runs reported the rule, and how many of those covered it. */
    runs_reported: number; runs_covered: number;
  }>;
  /** Rules whose latest classification is not covered, with the reason as recorded. */
  not_automated: Array<{ rule_id: string; text: string | null; reason: RuleStatus; run_id: string }>;
}

/** Every rule id seen across a project's SRS runs, read from the rule_coverage rows the indexer copied from rule-coverage.json. */
export function projectCoverage(db: Database.Database, projectId: string): ProjectCoverage {
  const rows = db.prepare(`SELECT c.*, r.started_at FROM rule_coverage c JOIN runs r ON r.id = c.run_id
                           WHERE r.project_id = ? ORDER BY r.started_at ASC, r.id ASC, c.rule_id ASC`).all(projectId) as Array<Record<string, unknown>>;
  const srsRuns = new Set(rows.map((r) => String(r.run_id)));
  const byRule = new Map<string, ProjectCoverage['rules'][number]>();
  for (const r of rows) {
    const id = String(r.rule_id);
    const status = String(r.status) as RuleStatus;
    const runId = String(r.run_id);
    const at = (r.started_at as string | null) ?? null;
    const scenarios = (() => { try { return JSON.parse(String(r.scenarios_json ?? '[]')) as string[]; } catch { return []; } })();
    const cur = byRule.get(id) ?? { rule_id: id, text: null, feature: null, latest_status: status, latest_run_id: runId, latest_run_at: at, last_covered_run_id: null, last_covered_at: null, last_covered_scenarios: [], runs_reported: 0, runs_covered: 0 };
    // Rows arrive oldest first, so the last assignment is the latest run.
    cur.text = (r.rule_text as string | null) ?? cur.text;
    cur.feature = (r.feature as string | null) ?? cur.feature;
    cur.latest_status = status; cur.latest_run_id = runId; cur.latest_run_at = at;
    cur.runs_reported++;
    if (status === 'covered') { cur.runs_covered++; cur.last_covered_run_id = runId; cur.last_covered_at = at; cur.last_covered_scenarios = scenarios; }
    byRule.set(id, cur);
  }
  const rules = [...byRule.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id, undefined, { numeric: true }));
  return {
    project_id: projectId, srs_runs: srsRuns.size, rules,
    not_automated: rules.filter((x) => x.latest_status !== 'covered').map((x) => ({ rule_id: x.rule_id, text: x.text, reason: x.latest_status, run_id: x.latest_run_id })),
  };
}

export interface ProjectTrends {
  project_id: string;
  /** Completed runs with a report, oldest first: the points. Each value is the index row's column. */
  points: Array<{ run_id: string; started_at: string | null; shipped: number | null; cost_total: number; flake_rate: number | null }>;
  /** Runs left out of the charts, by reason. */
  excluded: { legacy: number; stopped: number; empty: number; failed: number };
}

/** Trend points from index rows only: completed runs in run order. No smoothing, no averages. */
export function projectTrends(db: Database.Database, projectId: string): ProjectTrends {
  const points = db.prepare(`SELECT id AS run_id, started_at, shipped, cost_total, flake_rate FROM runs
                             WHERE project_id = ? AND status = 'completed' AND report_path IS NOT NULL ORDER BY started_at ASC, id ASC`).all(projectId) as ProjectTrends['points'];
  const count = (status: string): number => (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status = ?').get(projectId, status) as { n: number }).n;
  return { project_id: projectId, points, excluded: { legacy: count('legacy'), stopped: count('stopped'), empty: count('empty'), failed: count('failed') } };
}
