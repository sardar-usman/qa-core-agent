import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import type Database from 'better-sqlite3';
import { indexOutput, renderIndexResult, type IndexResult } from './db/indexer.js';

/**
 * REST API over the index (dashboard v2 plan, section 6; PR A ships the GET
 * routes plus POST /api/reindex). JSON only. Every route is guarded by the
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
      if (method === 'GET' && parts.length === 2 && parts[1] === 'runs') {
        json(res, 200, { runs: listRuns(db, { projectId: url.searchParams.get('project_id'), status: url.searchParams.get('status'), limit: Number(url.searchParams.get('limit') ?? 100) }) });
        return true;
      }
      if (method === 'GET' && parts.length >= 3 && parts[1] === 'runs') {
        const id = decodeURIComponent(parts[2]!);
        if (!RUN_ID_SAFE.test(id)) { json(res, 400, { error: 'bad run id' }); return true; }
        const run = db.prepare('SELECT r.*, p.name AS project_name FROM runs r JOIN projects p ON p.id = r.project_id WHERE r.id = ?').get(id) as Record<string, unknown> | undefined;
        if (!run) { json(res, 404, { error: 'run not found' }); return true; }
        if (parts.length === 3) { json(res, 200, { run }); return true; }
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
  id: string; name: string; base_url: string | null; environment: string; srs_path: string | null;
  runs: number; shipped: number; open_findings: number; spend_month: number; spend_total: number;
  last_run: { id: string; status: string; started_at: string | null; shipped: number; cost_total: number } | null;
  /** Rule coverage percent per run (oldest first), for the sparkline; empty without SRS runs. */
  coverage_series: Array<{ run_id: string; started_at: string | null; percent: number }>;
}

export function listProjects(db: Database.Database): ProjectCard[] {
  const projects = db.prepare('SELECT * FROM projects ORDER BY name').all() as Array<Record<string, unknown>>;
  return projects.map((p) => projectCard(db, p));
}

function projectCard(db: Database.Database, p: Record<string, unknown>): ProjectCard {
  const id = String(p.id);
  const agg = db.prepare(`SELECT COUNT(*) AS runs, COALESCE(SUM(shipped), 0) AS shipped, COALESCE(SUM(cost_total), 0) AS spend_total,
                          COALESCE(SUM(CASE WHEN started_at >= ? THEN cost_total ELSE 0 END), 0) AS spend_month
                          FROM runs WHERE project_id = ?`).get(monthStart(), id) as { runs: number; shipped: number; spend_total: number; spend_month: number };
  const open = db.prepare("SELECT COUNT(*) AS n FROM findings WHERE project_id = ? AND status IN ('new', 'confirmed')").get(id) as { n: number };
  const last = db.prepare('SELECT id, status, started_at, shipped, cost_total FROM runs WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(id) as ProjectCard['last_run'] | undefined;
  const coverage = db.prepare(`SELECT r.id AS run_id, r.started_at,
                                 SUM(CASE WHEN c.status = 'covered' THEN 1 ELSE 0 END) AS covered, COUNT(*) AS total
                               FROM rule_coverage c JOIN runs r ON r.id = c.run_id WHERE r.project_id = ?
                               GROUP BY r.id ORDER BY r.started_at ASC, r.id ASC`).all(id) as Array<{ run_id: string; started_at: string | null; covered: number; total: number }>;
  return {
    id, name: String(p.name), base_url: (p.base_url as string | null) ?? null, environment: String(p.environment), srs_path: (p.srs_path as string | null) ?? null,
    runs: agg.runs, shipped: agg.shipped, open_findings: open.n, spend_month: agg.spend_month, spend_total: agg.spend_total,
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
  const openFindings = db.prepare("SELECT * FROM findings WHERE project_id = ? AND status IN ('new', 'confirmed') ORDER BY last_seen_run_id DESC").all(id);
  return {
    project: p,
    summary: { runs: card.runs, shipped: card.shipped, open_findings: card.open_findings, spend_total: card.spend_total, spend_month: card.spend_month, last_run: card.last_run },
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
