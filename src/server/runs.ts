import fs from 'node:fs';
import path from 'node:path';
import type { RunReport } from '../agent/trace.js';
import type { Reconciliation } from '../agent/reconcile.js';

/**
 * Run history from disk: every run-report.json under output/ and
 * eval-results/, as compact records for the dashboard. Pure fs, no gateway
 * side effects, so the UI smokes can build fixtures against the same shape.
 */

export type RunStatus = 'completed' | 'stopped' | 'empty';

export interface DiskRun {
  id: string;
  timestamp: number;
  type: 'explore' | 'generate' | 'heal';
  target: string | null;
  host: string | null;
  scenarios: number;
  passRate: number | null;
  costUsd: number;
  spec: string;
  summary: string | null;
  verdicts: Array<{ verdict: string; scenario: string; reasons: string[]; required_fixes: string[] }> | null;
  /** Unique feature tags across the run's scenarios, first-encountered order. */
  features: string[] | null;
  /**
   * completed: framework shipped, nothing left to resume.
   * stopped: a checkpoint.json sits next to the report, so the run can resume.
   * empty: zero scenarios and no checkpoint.
   */
  status: RunStatus;
  stoppedReason: string | null;
  /** Relative to the project root, forward slashes. Present only when status is 'stopped'. */
  checkpointPath: string | null;
  /** Relative to the project root, forward slashes. */
  reportPath: string;
  language: 'ts' | 'js';
  reconciliation: Reconciliation | null;
  ruleCoverage: { covered: number; total: number } | null;
  findings: number;
  discovery: { method: string; pages: number } | null;
  /** The verdict journeys of the repair pass, when one ran. */
  repair: NonNullable<RunReport['review']>['repair'] | null;
}

function rel(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join('/');
}

/** Newest first, capped at 50. */
export function listRunsFromDisk(root: string): DiskRun[] {
  const found: DiskRun[] = [];
  for (const sub of ['output', 'eval-results']) {
    const dir = path.join(root, sub);
    if (fs.existsSync(dir)) walk(root, dir, found, 0);
  }
  found.sort((a, b) => b.timestamp - a.timestamp);
  return found.slice(0, 50);
}

function walk(root: string, dir: string, out: DiskRun[], depth: number): void {
  if (depth > 3) return;
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return; }
  const reportPath = path.join(dir, 'run-report.json');
  if (fs.existsSync(reportPath)) {
    const run = parseRunReport(root, dir, reportPath);
    if (run) out.push(run);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try { if (fs.statSync(full).isDirectory()) walk(root, full, out, depth + 1); } catch { /* skip */ }
  }
}

export function parseRunReport(root: string, dir: string, reportPath: string): DiskRun | null {
  try {
    const r = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Partial<RunReport> & Record<string, unknown>;
    const cost = (r.cost ?? {}) as Partial<RunReport['cost']>;
    const usd = (cost.usd ?? 0) + (cost.plannerUsd ?? 0) + (cost.criticUsd ?? 0);
    const url = String(r.url ?? '');
    const startedAt = String(r.startedAt ?? '');
    const ts = startedAt ? Date.parse(startedAt) : Date.now();
    let spec = '';
    try {
      const specName = fs.readdirSync(dir).find((f) => f.endsWith('.spec.ts') || f.endsWith('.spec.js')) ?? '';
      if (specName) spec = fs.readFileSync(path.join(dir, specName), 'utf8');
    } catch { /* spec is best-effort */ }
    let passRate: number | null = null;
    const pwPath = path.join(dir, 'pw-results.json');
    if (fs.existsSync(pwPath)) {
      try {
        const pw = JSON.parse(fs.readFileSync(pwPath, 'utf8')) as { stats?: Record<string, number> };
        const stats = pw.stats ?? {};
        const total = (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.flaky ?? 0);
        if (total > 0) passRate = Math.round(((stats.expected ?? 0) / total) * 100);
      } catch { /* ignore */ }
    }
    let host: string | null = null;
    try { host = url ? new URL(url).host : null; } catch { /* keep null */ }
    const scenarios = Array.isArray(r.scenarios) ? r.scenarios : [];
    const seen = new Set<string>();
    const features: string[] = [];
    for (const sc of scenarios) {
      const f = typeof sc?.feature === 'string' ? sc.feature.trim() : '';
      if (f && !seen.has(f)) { seen.add(f); features.push(f); }
    }
    const cpFile = path.join(dir, 'checkpoint.json');
    const hasCheckpoint = fs.existsSync(cpFile);
    const status: RunStatus = hasCheckpoint ? 'stopped' : scenarios.length > 0 ? 'completed' : 'empty';
    const rc = r.ruleCoverage;
    return {
      id: 'disk_' + path.basename(dir),
      timestamp: ts,
      type: 'explore',
      target: url ? `/explore ${url}` : null,
      host,
      scenarios: scenarios.length,
      passRate,
      costUsd: usd,
      spec,
      summary: r.review?.summary ?? null,
      verdicts: r.review?.verdicts ?? null,
      features: features.length > 0 ? features : null,
      status,
      stoppedReason: r.stopped?.reason ?? null,
      checkpointPath: hasCheckpoint ? rel(root, cpFile) : null,
      reportPath: rel(root, reportPath),
      language: r.language === 'js' ? 'js' : 'ts',
      reconciliation: r.reconciliation ?? null,
      ruleCoverage: rc ? { covered: rc.covered.length, total: rc.covered.length + rc.uncovered.length } : null,
      findings: Array.isArray(r.findings) ? r.findings.length : 0,
      discovery: r.discovery ? { method: r.discovery.method, pages: r.discovery.pages.length } : null,
      repair: r.review?.repair ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The report as the dashboard receives it at the end of a run: everything
 * except the per-step traces (large, and the panels do not read steps).
 * Every number the UI shows comes from this object or from the event stream.
 */
export function reportForUi(report: RunReport): Record<string, unknown> {
  return {
    ...report,
    scenarios: report.scenarios.map(({ steps, ...rest }) => ({ ...rest, stepCount: steps.length })),
  };
}
