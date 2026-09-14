import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { RunReport } from './trace.js';

/**
 * Per-run output layout (dashboard v2 plan, section 5, "Run identity").
 *
 *   output/<project-slug>/<run-id>/
 *     run-report.json            always
 *     <brand>-automation-framework.zip   POM runs
 *     checkpoint.json            when the run stopped early
 *     requirements-map.json, rule-coverage.json   SRS runs
 *     run-meta.json              surface metadata (source, flags), no engine data
 *   output/<project-slug>/latest -> <run-id>   newest completed run (symlink,
 *     or latest.json on filesystems without symlinks)
 *
 * Every run gets its own directory, so a run never overwrites another and
 * the index (src/server/db) can be rebuilt from the files alone. The legacy
 * layout (output/<brand>-automation-framework/ plus a sibling zip, or the
 * inline output/<stamp>-<slug>/) is moved into this layout once by
 * `npm run migrate-output`; the indexer still reads legacy folders in place
 * until then, so nothing is lost either way.
 */

export const LATEST_NAME = 'latest';
export const LATEST_JSON = 'latest.json';
export const RUN_META = 'run-meta.json';
/** Directories under output/ that are not projects. */
export const OUTPUT_IGNORE = new Set(['.uploads']);

/** Project slug from a URL: the host without www, dots and other separators as hyphens. */
export function projectSlug(url: string): string {
  let host: string;
  try { host = new URL(url).hostname; } catch { host = url.replace(/^https?:\/\//i, '').split(/[/?#]/)[0] ?? url; }
  host = host.toLowerCase().replace(/^www\./, '');
  const slug = host.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  return slug || 'unassigned';
}

/** `YYYYMMDDTHHMMSSZ-xxxxxx`: sortable timestamp plus a 6-char hash. */
export function newRunId(now: Date = new Date(), seed: string = crypto.randomBytes(8).toString('hex')): string {
  return `${compactTimestamp(now)}-${shortHash(seed + now.toISOString())}`;
}

export function compactTimestamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function shortHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 6);
}

export const RUN_ID_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]{6})$/;

/** The start time encoded in a run id, or null for a non-conforming id. */
export function runIdTime(runId: string): Date | null {
  const m = runId.match(RUN_ID_RE);
  if (!m) return null;
  const t = m[1]!;
  const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** output/<project-slug>/<run-id> under `root`. */
export function runDirFor(root: string, url: string, runId: string): string {
  return path.join(root, projectSlug(url), runId);
}

/** Is `dir` shaped like a run directory of the new layout (parent is a project, name is a run id)? */
export function isLayoutRunDir(dir: string): boolean {
  return RUN_ID_RE.test(path.basename(dir));
}

/**
 * Point <projectDir>/latest at `runId`. A relative symlink where the
 * filesystem allows it, otherwise latest.json with the same target, so a
 * reader can always find the newest completed run.
 */
export function setLatest(projectDir: string, runId: string): 'symlink' | 'json' {
  const link = path.join(projectDir, LATEST_NAME);
  try {
    try { fs.unlinkSync(link); } catch { /* absent */ }
    fs.symlinkSync(runId, link, 'dir');
    try { fs.unlinkSync(path.join(projectDir, LATEST_JSON)); } catch { /* absent */ }
    return 'symlink';
  } catch {
    fs.writeFileSync(path.join(projectDir, LATEST_JSON), JSON.stringify({ runId, updatedAt: new Date().toISOString() }, null, 2));
    return 'json';
  }
}

/** The run id the project's latest pointer names, or null. */
export function readLatest(projectDir: string): string | null {
  const link = path.join(projectDir, LATEST_NAME);
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink()) return path.basename(fs.readlinkSync(link));
  } catch { /* no symlink */ }
  try {
    const j = JSON.parse(fs.readFileSync(path.join(projectDir, LATEST_JSON), 'utf8')) as { runId?: string };
    return j.runId ?? null;
  } catch { return null; }
}

/** A run counts as completed for the latest pointer when it shipped scenarios and left no checkpoint. */
export function isCompletedRunDir(dir: string): boolean {
  try {
    if (fs.existsSync(path.join(dir, 'checkpoint.json'))) return false;
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'run-report.json'), 'utf8')) as { scenarios?: unknown[]; stopped?: unknown };
    return Array.isArray(r.scenarios) && r.scenarios.length > 0 && !r.stopped;
  } catch { return false; }
}

export interface RunMeta {
  /** Which surface started the run. */
  source: 'cli' | 'dashboard' | 'mcp' | 'telegram';
  /** The request flags as the surface parsed them. */
  flags?: Record<string, unknown>;
  /** Set by the migration for a run moved out of the legacy layout. */
  migratedFrom?: string;
  writtenAt: string;
}

/** Write the surface's metadata next to the report. Engine data never lives here. */
export function writeRunMeta(runDir: string, meta: Omit<RunMeta, 'writtenAt'>): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, RUN_META), JSON.stringify({ ...meta, writtenAt: new Date().toISOString() }, null, 2));
}

export function readRunMeta(runDir: string): RunMeta | null {
  try { return JSON.parse(fs.readFileSync(path.join(runDir, RUN_META), 'utf8')) as RunMeta; } catch { return null; }
}

/**
 * After a run's files are final: update the project's latest pointer when
 * the run completed and is at least as new as the current latest. A run
 * written to an explicit --out directory (not under a project) gets no
 * pointer. Returns what was done, for the console line.
 */
export function finalizeRunDir(runDir: string): { latest: 'symlink' | 'json' | null } {
  if (!isLayoutRunDir(runDir) || !isCompletedRunDir(runDir)) return { latest: null };
  const projectDir = path.dirname(runDir);
  const runId = path.basename(runDir);
  const current = readLatest(projectDir);
  if (current && current > runId && fs.existsSync(path.join(projectDir, current, 'run-report.json'))) return { latest: null };
  return { latest: setLatest(projectDir, runId) };
}

/* ─────────────────── Scanning ─────────────────── */

export interface RunDirEntry {
  dir: string;
  runId: string;
  /** Project slug (the layout's directory) or null for a legacy folder. */
  projectSlug: string | null;
  legacy: boolean;
}

/**
 * Every run directory under `root`: new-layout runs (project/run-id) and
 * legacy folders holding a run-report.json directly. Symlinks (latest) are
 * never followed, so a run is listed once.
 */
export function listRunDirs(root: string): RunDirEntry[] {
  const out: RunDirEntry[] = [];
  if (!fs.existsSync(root)) return out;
  for (const name of safeReaddir(root)) {
    if (OUTPUT_IGNORE.has(name) || name.startsWith('.')) continue;
    const full = path.join(root, name);
    if (!isRealDir(full)) continue;
    if (fs.existsSync(path.join(full, 'run-report.json'))) {
      out.push({ dir: full, runId: name, projectSlug: null, legacy: true });
      continue;
    }
    for (const child of safeReaddir(full)) {
      const runDir = path.join(full, child);
      if (child === LATEST_NAME || child === LATEST_JSON || !isRealDir(runDir)) continue;
      if (fs.existsSync(path.join(runDir, 'run-report.json'))) out.push({ dir: runDir, runId: child, projectSlug: name, legacy: false });
    }
  }
  return out.sort((a, b) => a.runId.localeCompare(b.runId));
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function isRealDir(p: string): boolean {
  try { const st = fs.lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; }
}

/* ─────────────────── Migration ─────────────────── */

export interface MigrationMove {
  from: string;
  to: string;
  runId: string;
  projectSlug: string;
  zipFrom?: string;
  completed: boolean;
}

export interface MigrationResult {
  moves: MigrationMove[];
  skipped: Array<{ dir: string; reason: string }>;
  latest: Array<{ projectSlug: string; runId: string }>;
  dryRun: boolean;
}

/**
 * Plan (and unless dryRun, perform) the one-time move of legacy output
 * folders into output/<project-slug>/<run-id>/. One run per legacy folder,
 * dated from its run-report (startedAt; the folder's mtime when absent),
 * with a run id that is deterministic for that report, so running the
 * migration twice moves nothing the second time: a legacy folder is gone
 * once moved, and a destination that already exists is skipped.
 */
export function migrateOutput(root: string, opts: { dryRun?: boolean } = {}): MigrationResult {
  const dryRun = opts.dryRun === true;
  const result: MigrationResult = { moves: [], skipped: [], latest: [], dryRun };
  if (!fs.existsSync(root)) return result;
  for (const entry of listRunDirs(root).filter((e) => e.legacy)) {
    const reportPath = path.join(entry.dir, 'run-report.json');
    let report: Partial<RunReport>;
    try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Partial<RunReport>; }
    catch (err) { result.skipped.push({ dir: entry.dir, reason: `run-report.json is not valid JSON: ${(err as Error).message}` }); continue; }
    const url = typeof report.url === 'string' ? report.url : '';
    const started = report.startedAt && !Number.isNaN(Date.parse(report.startedAt)) ? new Date(report.startedAt) : fs.statSync(reportPath).mtime;
    const slug = projectSlug(url);
    const runId = `${compactTimestamp(started)}-${shortHash(`${url}|${report.startedAt ?? ''}|${entry.runId}`)}`;
    const to = path.join(root, slug, runId);
    if (fs.existsSync(to)) { result.skipped.push({ dir: entry.dir, reason: `destination already exists: ${path.relative(root, to)}` }); continue; }
    const zipCandidate = path.join(root, `${entry.runId}.zip`);
    const move: MigrationMove = {
      from: entry.dir, to, runId, projectSlug: slug,
      ...(fs.existsSync(zipCandidate) ? { zipFrom: zipCandidate } : {}),
      completed: isCompletedRunDir(entry.dir),
    };
    result.moves.push(move);
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(entry.dir, to);
    if (move.zipFrom) fs.renameSync(move.zipFrom, path.join(to, path.basename(move.zipFrom)));
    writeRunMeta(to, { source: 'cli', migratedFrom: entry.runId });
  }
  // Latest pointers: the newest completed run per touched project.
  const touched = new Set(result.moves.map((m) => m.projectSlug));
  for (const slug of touched) {
    const projectDir = path.join(root, slug);
    const completed = (dryRun
      ? result.moves.filter((m) => m.projectSlug === slug && m.completed).map((m) => m.runId)
      : safeReaddir(projectDir).filter((c) => RUN_ID_RE.test(c) && isCompletedRunDir(path.join(projectDir, c)))
    ).sort();
    const newest = completed[completed.length - 1];
    if (!newest) continue;
    result.latest.push({ projectSlug: slug, runId: newest });
    if (!dryRun) setLatest(projectDir, newest);
  }
  return result;
}

/** Console rendering of a migration result. */
export function renderMigration(result: MigrationResult, root: string): string[] {
  const rel = (p: string) => path.relative(root, p) || '.';
  const lines: string[] = [];
  lines.push(`${result.dryRun ? 'Would move' : 'Moved'} ${result.moves.length} legacy run folder(s)${result.dryRun ? ' (dry run, nothing changed)' : ''}.`);
  for (const m of result.moves) {
    lines.push(`  ${rel(m.from)} -> ${rel(m.to)}${m.zipFrom ? ` (+ ${path.basename(m.zipFrom)})` : ''}${m.completed ? '' : ' [not completed]'}`);
  }
  for (const s of result.skipped) lines.push(`  skipped ${rel(s.dir)}: ${s.reason}`);
  for (const l of result.latest) lines.push(`  ${l.projectSlug}/latest -> ${l.runId}`);
  if (result.moves.length === 0 && result.skipped.length === 0) lines.push('  Nothing to migrate: output/ already uses the per-run layout.');
  return lines;
}
