/**
 * Locks the SQLite index (dashboard v2 plan, section 5) and its acceptance
 * line: files are truth, the index is rebuildable.
 *   - a fixture output tree (two hosts, a stopped run, an SRS run, a legacy
 *     folder, a run with no parseable host) indexes to the expected row counts
 *   - every runs row's numbers equal its run-report (re-derived here from the
 *     report, independently of the indexer)
 *   - runs are assigned to projects by host; the bad-url run lands in Unassigned
 *   - a finding seen in two runs is ONE row with first/last seen run ids
 *   - verdicts carry their repair journey; rule coverage carries statuses
 *   - delete the database, re-index: identical rows; re-index again: identical;
 *     remove a run directory: its rows vanish
 * No browser, no model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, schemaVersion } from '../src/server/db/migrate.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { indexOutput, runRowFromReport, findingKey, UNASSIGNED_PROJECT_ID, runRowFromLegacyRecord, legacyRunId, importLegacyRecords } from '../src/server/db/indexer.js';
import { newRunId, setLatest } from '../src/agent/output-layout.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* ─── fixture ─── */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-index-'));
const output = path.join(root, 'output');
const dbPath = path.join(root, 'data', 'qa-core.sqlite');

function mkReport(url: string, startedAt: string, o: { shipped: number; planned: number; dropped?: string[]; incomplete?: number; findings?: Array<{ scenario: string; expected: string; page: string }>; skipped?: number; stopped?: boolean; cost?: Partial<RunReport['cost']>; flake?: number; rules?: boolean }): RunReport {
  const scenarios = Array.from({ length: o.shipped }, (_, i) => ({ name: `scenario ${i + 1}`, feature: 'login', category: 'happy' as const, steps: [{ kind: 'navigate' as const, url }] }));
  const findings = (o.findings ?? []).map((f) => ({ scenario: f.scenario, expected: f.expected, url: f.page, messages: [] as string[] }));
  const dropped = (o.dropped ?? []).map((n) => ({ name: n, stage: 'critic' as const, reason: 'rework -> reject' }));
  const incomplete = Array.from({ length: o.incomplete ?? 0 }, (_, i) => ({ scenario: `incomplete ${i}`, reason: 'budget' }));
  const skipped = Array.from({ length: o.skipped ?? 0 }, (_, i) => ({ scenario: `skipped ${i}`, reason: 'n/a' }));
  return {
    url, language: 'ts', scenarios,
    cascadeStats: {} as never,
    cost: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 1.2, plannerUsd: 0.01, criticUsd: 0.02, repairUsd: 0.3, ...(o.cost ?? {}) },
    steps: 10, startedAt, finishedAt: startedAt,
    plan: Array.from({ length: o.planned }, (_, i) => ({ name: `planned ${i}`, category: 'happy', rationale: 'r', feature: 'login', ruleIds: i === 0 ? ['R1'] : [] })),
    review: {
      verdicts: [
        { scenario: 'scenario 1', verdict: 'pass', reasons: ['asserts the outcome'], required_fixes: [] },
        ...(o.dropped ?? []).map((n) => ({ scenario: n, verdict: 'reject' as const, reasons: ['circular'], required_fixes: ['capture first'] })),
      ],
      summary: 'ok',
      repair: (o.dropped ?? []).map((n) => ({ scenario: n, first: 'rework' as const, second: 'reject' as const, outcome: 'dropped' as const })),
    },
    ...(o.flake !== undefined ? { stability: { iterations: 3, passed: o.shipped, flaked: 0, flakeRate: o.flake, durationMs: 1, verdicts: [] } } : {}),
    findings,
    incomplete,
    skipped,
    ...(o.stopped ? { stopped: { kind: 'cost_ceiling' as const, reason: 'ceiling hit' } } : {}),
    reconciliation: {
      planned: o.planned, generated: o.shipped, dropped, incomplete: incomplete.map((i) => ({ name: i.scenario, reason: i.reason })),
      findings: findings.map((f) => ({ name: f.scenario, expected: f.expected, url: f.url, messages: [] })), skipped: skipped.map((sk) => ({ name: sk.scenario, reason: sk.reason })),
      accountedFor: o.shipped + dropped.length + incomplete.length + findings.length + skipped.length, added: 0, balanced: true,
      stable: o.shipped, recovered: 0, flaky: 0, broken: 0,
    },
    ...(o.rules ? { ruleCoverage: { covered: [{ ruleId: 'R1', scenarios: ['scenario 1'] }], uncovered: [{ ruleId: 'R2', text: 'Lockout after 5 tries', reason: 'planned-but-dropped' as const }, { ruleId: 'R3', text: 'Reset link expires', reason: 'not-planned' as const }] } } : {}),
  };
}

function writeRun(projectSlug: string, runId: string, rep: RunReport, extra: Record<string, string> = {}): string {
  const dir = path.join(output, projectSlug, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(rep, null, 2));
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(dir, k), v);
  return dir;
}

const sauce1 = newRunId(new Date('2026-09-10T10:00:00Z'), 's1');
const sauce2 = newRunId(new Date('2026-09-12T10:00:00Z'), 's2');
const sauce3 = newRunId(new Date('2026-09-13T10:00:00Z'), 's3');
const shop1 = newRunId(new Date('2026-09-11T10:00:00Z'), 'p1');
const bad1 = newRunId(new Date('2026-09-09T10:00:00Z'), 'b1');
const finding = { scenario: 'Footer social links open', expected: 'a new tab with twitter.com', page: 'https://www.saucedemo.com/inventory.html' };
writeRun('saucedemo-com', sauce1, mkReport('https://www.saucedemo.com/', '2026-09-10T10:00:00.000Z', { shipped: 3, planned: 5, dropped: ['sort by price'], findings: [finding] }), { 'saucedemo-automation-framework.zip': 'PK' });
writeRun('saucedemo-com', sauce2, mkReport('https://www.saucedemo.com/', '2026-09-12T10:00:00.000Z', { shipped: 4, planned: 6, dropped: ['remove from cart'], findings: [{ ...finding, scenario: 'footer social links open.' }], flake: 0.25, rules: true }),
  { 'requirements-map.json': JSON.stringify({ features: [{ name: 'login', rules: [{ id: 'R1', text: 'Valid login lands on inventory', type: 'behavior' }, { id: 'R2', text: 'Lockout after 5 tries', type: 'validation' }] }], roles: [] }), 'run-meta.json': JSON.stringify({ source: 'dashboard', flags: { lang: 'ts' }, writtenAt: 'x' }) });
writeRun('saucedemo-com', sauce3, mkReport('https://www.saucedemo.com/', '2026-09-13T10:00:00.000Z', { shipped: 2, planned: 8, incomplete: 1, stopped: true }), { 'checkpoint.json': '{"version":1}' });
setLatest(path.join(output, 'saucedemo-com'), sauce2);
writeRun('shop-example', shop1, mkReport('https://shop.example/', '2026-09-11T10:00:00.000Z', { shipped: 0, planned: 3, skipped: 1 }));
writeRun('unassigned', bad1, mkReport('', '2026-09-09T10:00:00.000Z', { shipped: 1, planned: 1 }));
// A legacy folder still in place (indexed where it is).
fs.mkdirSync(path.join(output, 'legacy-automation-framework'), { recursive: true });
fs.writeFileSync(path.join(output, 'legacy-automation-framework', 'run-report.json'), JSON.stringify(mkReport('https://legacy.example/app', '2026-08-01T10:00:00.000Z', { shipped: 2, planned: 2 })));
fs.mkdirSync(path.join(output, '.uploads'), { recursive: true });
// The gateway's pre-v2 record store (.qa-core/sites/<host>.json recentRuns):
//  - one saucedemo record finishing 40s after sauce2's report -> covered, skipped
//  - one saucedemo record from July with no report -> imported as 'legacy'
//  - one record for a host with no runs on disk -> its own project
//  - the 'unknown' host with url "--" -> Unassigned
fs.mkdirSync(path.join(root, '.qa-core', 'sites'), { recursive: true });
const legacyAt = '2026-07-03T09:15:00.000Z';
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'www.saucedemo.com.json'), JSON.stringify({ host: 'www.saucedemo.com', recentRuns: [
  { at: '2026-09-12T10:00:40.000Z', url: 'https://www.saucedemo.com/', scenarios: 4, cost: 1.53, model: 'claude-opus-4-7', durationSec: 40 },
  { at: legacyAt, url: 'https://www.saucedemo.com/', scenarios: 5, cost: 0.7647535, model: 'claude-opus-4-7', durationSec: 101 },
] }));
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'demo.playwright.dev.json'), JSON.stringify({ host: 'demo.playwright.dev', recentRuns: [
  { at: '2026-05-14T08:10:23.238Z', url: 'https://demo.playwright.dev/todomvc/', scenarios: 5, cost: 0.242101, model: 'claude-opus-4-7', durationSec: 108 },
] }));
fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'unknown.json'), JSON.stringify({ host: 'unknown', recentRuns: [
  { at: '2026-06-25T11:47:58.921Z', url: '--', scenarios: 0, cost: 0.02517125, model: 'claude-opus-4-7', durationSec: 3 },
] }));

/* ─── first index ─── */

const db = openDatabase(dbPath);
check('A. schema migrated to the current version (6: run source nullable, never defaulted)', schemaVersion(db) === 6);
const r1 = indexOutput(db, root);
check('A2. every auto-created project stores environment NULL, never a default label', (db.prepare('SELECT COUNT(*) AS n FROM projects WHERE environment IS NOT NULL').get() as { n: number }).n === 0 && (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n > 0);
check('B. 6 reported runs + 3 pre-v2 records indexed (1 record covered by a report, skipped)', r1.runs === 9 && r1.legacy === 1 && r1.legacyRecords === 3 && r1.legacyCovered === 1, JSON.stringify(r1));
check('C. 5 projects: saucedemo, shop, legacy, demo.playwright.dev (records only), Unassigned', r1.projects === 5, String(r1.projects));
const projects = db.prepare('SELECT id, name, base_url FROM projects ORDER BY id').all() as Array<{ id: string; name: string; base_url: string | null }>;
check('D. projects are keyed by host slug with brand names and origin base urls', JSON.stringify(projects) === JSON.stringify([
  { id: 'demo-playwright-dev', name: 'demo-playwright', base_url: 'https://demo.playwright.dev/' },
  { id: 'legacy-example', name: 'legacy', base_url: 'https://legacy.example/' },
  { id: 'saucedemo-com', name: 'saucedemo', base_url: 'https://www.saucedemo.com/' },
  { id: 'shop-example', name: 'shop', base_url: 'https://shop.example/' },
  { id: 'unassigned', name: 'Unassigned', base_url: null },
]), JSON.stringify(projects));
const allRuns = db.prepare('SELECT * FROM runs ORDER BY id').all() as Array<Record<string, unknown>>;
const runs = allRuns.filter((r) => r.status !== 'legacy');
const legacyRows = allRuns.filter((r) => r.status === 'legacy');
check('E. the three reported saucedemo runs plus the imported July record share one project by host', runs.filter((r) => r.project_id === 'saucedemo-com').length === 3 && legacyRows.filter((r) => r.project_id === 'saucedemo-com').length === 1);
check('F. the run with no parseable host is Unassigned', runs.find((r) => r.id === bad1)?.project_id === UNASSIGNED_PROJECT_ID);

// Every row equals its report, re-derived here.
for (const row of runs) {
  const rep = JSON.parse(fs.readFileSync(path.join(root, String(row.report_path)), 'utf8')) as RunReport;
  const rec = rep.reconciliation!;
  const expected = {
    planned: rec.planned, generated: rec.generated, dropped: rec.dropped.length, incomplete: rec.incomplete.length, findings: rec.findings.length, skipped: rec.skipped.length,
    stable: rec.stable, flaky: rec.flaky, broken: rec.broken, shipped: rep.scenarios.length,
    cost_total: rep.cost.usd + (rep.cost.plannerUsd ?? 0) + (rep.cost.criticUsd ?? 0) + (rep.stability?.stabilizerCostUsd ?? 0), cost_planner: rep.cost.plannerUsd ?? 0,
    cost_explorer: rep.cost.usd - (rep.cost.repairUsd ?? 0), cost_critic: rep.cost.criticUsd ?? 0, cost_repair: rep.cost.repairUsd ?? 0,
    flake_rate: rep.stability ? rep.stability.flakeRate : null, started_at: rep.startedAt, stopped_reason: rep.stopped?.reason ?? null,
    status: fs.existsSync(path.join(root, path.dirname(String(row.report_path)), 'checkpoint.json')) ? 'stopped' : rep.scenarios.length === 0 ? 'empty' : 'completed',
  };
  const actual = Object.fromEntries(Object.keys(expected).map((k) => [k, row[k]]));
  check(`G. runs row ${String(row.id).slice(0, 16)} equals its run-report`, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify({ actual, expected }));
}
check('H. runRowFromReport is the same mapping the smoke re-derived (spot check)', (() => {
  const rep = JSON.parse(fs.readFileSync(path.join(output, 'saucedemo-com', sauce1, 'run-report.json'), 'utf8')) as RunReport;
  const row = runRowFromReport({ runId: sauce1, projectId: 'saucedemo-com', report: rep, reportPath: 'x', zipPath: null, checkpointPath: null });
  return row.planned === 5 && row.generated === 3 && row.dropped === 1 && row.findings === 1 && Math.abs(row.cost_total - 1.23) < 1e-9 && Math.abs(row.cost_explorer - 0.9) < 1e-9;
})());
const s2 = runs.find((r) => r.id === sauce2)!;
check('I. source and flags come from run-meta; zip and checkpoint paths are relative', s2.source === 'dashboard' && s2.flags_json === '{"lang":"ts"}' && runs.find((r) => r.id === sauce1)?.zip_path === `output/saucedemo-com/${sauce1}/saucedemo-automation-framework.zip` && runs.find((r) => r.id === sauce3)?.checkpoint_path === `output/saucedemo-com/${sauce3}/checkpoint.json` && runs.find((r) => r.id === sauce3)?.status === 'stopped');
check('J. a legacy folder is indexed in place under its host project; with no run-meta its source is NULL, never a default', runs.find((r) => r.id === 'legacy-automation-framework')?.project_id === 'legacy-example' && runs.find((r) => r.id === 'legacy-automation-framework')?.source === null);
check('J2. a per-run directory without run-meta.json has source NULL (unknown), never cli', runs.find((r) => r.id === sauce1)?.source === null, JSON.stringify(runs.find((r) => r.id === sauce1)?.source));

const findings = db.prepare('SELECT * FROM findings').all() as Array<Record<string, unknown>>;
check('K. the finding seen in two runs (name differs by case and a full stop) is ONE row', findings.length === 1 && findings[0]?.id === findingKey('saucedemo-com', finding.scenario, finding.expected), JSON.stringify(findings));
check('L. first_seen is the earlier run, last_seen and run_id the later', findings[0]?.first_seen_run_id === sauce1 && findings[0]?.last_seen_run_id === sauce2 && findings[0]?.run_id === sauce2 && findings[0]?.status === 'open');
check('L2. finding_runs holds both runs the finding was seen in (one row, two run references)', JSON.stringify((db.prepare('SELECT run_id FROM finding_runs WHERE finding_id = ? ORDER BY run_id').all(findings[0]?.id as string) as Array<{ run_id: string }>).map((r) => r.run_id)) === JSON.stringify([sauce1, sauce2].sort()));
const verdicts = db.prepare('SELECT * FROM verdicts ORDER BY run_id, scenario').all() as Array<Record<string, unknown>>;
check('M. verdict rows: one per scenario per run, rejects carry their repair journey', r1.verdicts === verdicts.length && verdicts.filter((v) => v.verdict === 'reject').every((v) => typeof v.journey_json === 'string' && JSON.parse(String(v.journey_json)).outcome === 'dropped'));
const cov = db.prepare('SELECT * FROM rule_coverage WHERE run_id = ? ORDER BY rule_id').all(sauce2) as Array<Record<string, unknown>>;
check('N. rule coverage rows carry status, text and feature from the requirements map', cov.length === 3 && cov[0]?.status === 'covered' && cov[0]?.rule_text === 'Valid login lands on inventory' && cov[0]?.feature === 'login' && cov[1]?.status === 'planned_but_dropped' && cov[2]?.status === 'not_planned' && cov[2]?.rule_text === 'Reset link expires');

/* ─── pre-v2 gateway records ─── */

const julyRec = { at: legacyAt, url: 'https://www.saucedemo.com/', scenarios: 5, cost: 0.7647535, model: 'claude-opus-4-7', durationSec: 101 };
const july = legacyRows.find((r) => r.id === legacyRunId('www.saucedemo.com', julyRec))!;
check('T1. the July record is a legacy row: its scenario count is EXPLORED (generated), shipped is NULL, nothing invented', !!july && july.status === 'legacy' && july.shipped === null && july.generated === 5 && july.planned === 0 && Math.abs(Number(july.cost_total) - 0.7647535) < 1e-9 && Number(july.cost_explorer) === Number(july.cost_total) && july.report_path === null && july.zip_path === null && july.flake_rate === null, JSON.stringify(july));
check('T2. legacy timing: ended_at is the record time, started_at is durationSec earlier', july.ended_at === legacyAt && july.started_at === '2026-07-03T09:13:19.000Z', JSON.stringify([july.started_at, july.ended_at]));
check('T3. legacy flags keep the model and duration; a pre-v2 record has no known source (NULL)', JSON.parse(String(july.flags_json)).model === 'claude-opus-4-7' && JSON.parse(String(july.flags_json)).durationSec === 101 && july.source === null);
check('T4. a record covered by a real report (same host, finished within the window) is NOT imported and the report row is untouched', !legacyRows.some((r) => r.ended_at === '2026-09-12T10:00:40.000Z') && runs.find((r) => r.id === sauce2)?.shipped === 4 && runs.find((r) => r.id === sauce2)?.status === 'completed');
check('T5. a host with records but no reports gets its own project', legacyRows.find((r) => r.project_id === 'demo-playwright-dev')?.generated === 5 && legacyRows.find((r) => r.project_id === 'demo-playwright-dev')?.shipped === null);
check('T6. the unknown host record lands in Unassigned with a null url', legacyRows.find((r) => r.project_id === UNASSIGNED_PROJECT_ID)?.url === null);
check('T7. runRowFromLegacyRecord is a pure mapping with a deterministic id and a NULL shipped', runRowFromLegacyRecord('h', julyRec, 'p').id === runRowFromLegacyRecord('h', julyRec, 'p').id && runRowFromLegacyRecord('h', julyRec, 'p').id.startsWith('legacy-20260703T091500Z-') && runRowFromLegacyRecord('h', julyRec, 'p').shipped === null && runRowFromLegacyRecord('h', julyRec, 'p').generated === 5);
// A legacy id can never overwrite a reported row: force the collision and re-import.
// (The swap rewrites primary keys that derived rows reference; those rows are
// rebuilt right after, so the constraint is paused for the swap only.)
db.pragma('foreign_keys = OFF');
db.prepare('UPDATE runs SET id = ? WHERE id = ?').run('tmp-swap', sauce1);
db.prepare('UPDATE runs SET id = ? WHERE id = ?').run(sauce1, july.id);
db.prepare('UPDATE runs SET id = ? WHERE id = ?').run(july.id, 'tmp-swap');
db.pragma('foreign_keys = ON');
const reimport = importLegacyRecords(db, root);
const shadowed = db.prepare('SELECT report_path, shipped, status FROM runs WHERE id = ?').get(july.id) as { report_path: string | null; shipped: number; status: string } | undefined;
check('T8. a row that has a real report is never overwritten by a legacy record with the same id', !!shadowed && shadowed.report_path !== null && shadowed.shipped === 3 && shadowed.status === 'completed' && !reimport.ids.includes(String(july.id)), JSON.stringify({ shadowed, imported: reimport.ids.length }));
// Restore the fixture state for the equality checks below.
for (const t of ['verdicts', 'rule_coverage', 'finding_runs', 'findings', 'runs']) db.prepare(`DELETE FROM ${t}`).run();
indexOutput(db, root);

/* ─── acceptance: delete the database, re-index, identical rows ─── */

function dump(d: ReturnType<typeof openDatabase>): string {
  const out: Record<string, unknown> = {};
  for (const t of ['projects', 'runs', 'findings', 'finding_runs', 'rule_coverage', 'verdicts', 'terminals']) {
    const rows = d.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>;
    for (const r of rows) { delete r.created_at; delete r.updated_at; }
    out[t] = rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort()))).sort();
  }
  return JSON.stringify(out);
}
const dump1 = dump(db);
db.prepare("UPDATE findings SET status = 'triaged', notes = 'seen by hand'").run();
indexOutput(db, root);
const kept = db.prepare('SELECT status, notes FROM findings').get() as { status: string; notes: string };
check('O. re-indexing in place preserves finding status and notes', kept.status === 'triaged' && kept.notes === 'seen by hand');
db.prepare("UPDATE findings SET status = 'open', notes = NULL").run();
check('P. re-indexing in place changes no other row', dump(db) === dump1);
db.close();
fs.rmSync(dbPath, { force: true });
for (const f of fs.readdirSync(path.dirname(dbPath))) if (f.startsWith('qa-core.sqlite')) fs.rmSync(path.join(path.dirname(dbPath), f), { force: true });
const db2 = openDatabase(dbPath);
const r2 = indexOutput(db2, root);
check('Q. after deleting the database, a fresh index has identical counts', JSON.stringify(r2) === JSON.stringify({ ...r1, removed: 0 }), JSON.stringify({ r1, r2 }));
check('R. after deleting the database, every row is identical', dump(db2) === dump1);

/* ─── migration v4 on a v3-shaped database with referencing runs rows ─── */
// The real failure: a v3 database whose runs rows reference a project. The
// old v4 dropped projects with foreign keys ON (the pragma is a no-op inside
// the transaction) and died with SQLITE_CONSTRAINT_FOREIGNKEY.
const v3Path = path.join(root, 'data', 'qa-core-v3.sqlite');
{
  const schemaFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server', 'db', 'schema.sql');
  const v3Schema = fs.readFileSync(schemaFile, 'utf8').replace(
    /environment\s+TEXT CHECK \(environment IS NULL OR environment IN \('staging', 'production', 'other'\)\)/,
    "environment TEXT NOT NULL DEFAULT 'other' CHECK (environment IN ('staging', 'production', 'other'))",
  );
  if (!/DEFAULT 'other'/.test(v3Schema)) throw new Error('could not shape the v3 schema from schema.sql');
  const v3 = new Database(v3Path);
  v3.pragma('foreign_keys = ON');
  v3.exec(v3Schema);
  v3.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const [v, n] of [[1, 'initial schema'], [2, 'legacy run records'], [3, 'legacy rows count explored, not shipped']] as const) v3.prepare('INSERT INTO schema_version VALUES (?, ?, ?)').run(v, n, '2026-09-14T12:00:00.000Z');
  v3.prepare("INSERT INTO projects (id, name, base_url, environment, created_at, updated_at) VALUES ('saucedemo-com', 'saucedemo', 'https://www.saucedemo.com/', 'other', '2026-09-14T12:00:00.000Z', '2026-09-14T12:00:00.000Z')").run();
  const reportedRow = runRowFromReport({ runId: sauce1, projectId: 'saucedemo-com', report: JSON.parse(fs.readFileSync(path.join(output, 'saucedemo-com', sauce1, 'run-report.json'), 'utf8')) as RunReport, reportPath: path.join('output', 'saucedemo-com', sauce1, 'run-report.json'), zipPath: null, checkpointPath: null });
  const legacyRow = runRowFromLegacyRecord('www.saucedemo.com', julyRec, 'saucedemo-com');
  const cols = Object.keys(reportedRow);
  const ins = v3.prepare(`INSERT INTO runs (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`);
  ins.run(reportedRow as unknown as Record<string, unknown>);
  ins.run(Object.fromEntries(cols.map((c) => [c, (legacyRow as unknown as Record<string, unknown>)[c] ?? null])));
  check('V1. the v3-shaped database has one project (environment other) and two referencing runs rows before migration', (v3.prepare('SELECT COUNT(*) AS n FROM runs WHERE project_id = ?').get('saucedemo-com') as { n: number }).n === 2 && (v3.prepare('SELECT environment FROM projects').get() as { environment: string }).environment === 'other' && schemaVersion(v3) === 3);
  v3.close();
}
let migrated: ReturnType<typeof openDatabase> | null = null;
let migrateError: string | null = null;
try { migrated = openDatabase(v3Path); } catch (e) { migrateError = String(e); }
check('V2. migration reaches the current version (6) on a database with referencing runs rows, without throwing', migrated !== null && schemaVersion(migrated) === 6, migrateError ?? (migrated ? `version ${schemaVersion(migrated)}` : ''));
if (migrated) {
  const runsAfter = migrated.prepare("SELECT id, project_id, status FROM runs ORDER BY id").all() as Array<{ id: string; project_id: string; status: string }>;
  check('V3. every runs row survives with its project_id intact (one reported, one legacy)', runsAfter.length === 2 && runsAfter.every((r) => r.project_id === 'saucedemo-com') && runsAfter.some((r) => r.status === 'legacy') && runsAfter.some((r) => r.id === sauce1), JSON.stringify(runsAfter));
  check('V4. the migrated project stores environment NULL', (migrated.prepare('SELECT environment FROM projects').get() as { environment: string | null }).environment === null);
  check('V5. PRAGMA foreign_key_check returns nothing and foreign keys are back on', (migrated.pragma('foreign_key_check') as unknown[]).length === 0 && (migrated.pragma('foreign_keys', { simple: true }) as number) === 1);
  const rm = indexOutput(migrated, root);
  check('V6. a migrated database and a fresh database produce identical rows after reindex', dump(migrated) === dump(db2) && JSON.stringify(rm) === JSON.stringify(r2), JSON.stringify(rm));
  // Person-set rows survive a reopen at the current version and a re-index: project name and environment, finding status and notes.
  migrated.prepare("UPDATE projects SET name = 'Sauce Renamed', environment = 'production' WHERE id = 'saucedemo-com'").run();
  migrated.prepare("UPDATE findings SET status = 'wont-fix', notes = 'by design'").run();
  migrated.close();
  const reopened = openDatabase(v3Path);
  indexOutput(reopened, root);
  const proj = reopened.prepare("SELECT name, environment FROM projects WHERE id = 'saucedemo-com'").get() as { name: string; environment: string | null };
  const fnd = reopened.prepare('SELECT status, notes FROM findings').get() as { status: string; notes: string | null };
  check('V7. reopening a current-version database applies no migration and a re-index never overwrites a person-set project name or environment', schemaVersion(reopened) === 6 && proj.name === 'Sauce Renamed' && proj.environment === 'production', JSON.stringify(proj));
  check('V8. finding status and notes survive the reopen and re-index too', fnd.status === 'wont-fix' && fnd.notes === 'by design', JSON.stringify(fnd));
  reopened.close();
}

/* ─── observed text: report data only, no inference ─── */
{
  const oroot = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-observed-'));
  const dir = path.join(oroot, 'output', 'msg-example', newRunId(new Date('2026-09-15T10:00:00Z'), 'obs'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify({ url: 'https://msg.example/', language: 'ts', startedAt: '2026-09-15T10:00:00.000Z', finishedAt: '2026-09-15T10:01:00.000Z', steps: 1, scenarios: [{ name: 's1', steps: [] }], cascadeStats: {}, cost: { usd: 0.1 }, plan: [],
    findings: [
      { scenario: 'login shows an error', expected: 'an error banner', url: 'https://msg.example/login', messages: ['Epic sadface: Username is required', 'Please try again'] },
      { scenario: 'checkout redirects', expected: 'the confirmation page', url: 'https://msg.example/cart', messages: [] },
    ],
    reconciliation: { planned: 3, generated: 1, dropped: [], incomplete: [], findings: [{ name: 'a', expected: 'b', url: 'u', messages: [] }, { name: 'c', expected: 'd', url: 'u', messages: [] }], skipped: [], accountedFor: 3, added: 0, balanced: true, stable: 1, recovered: 0, flaky: 0, broken: 0 } }));
  const odb = openDatabase(path.join(oroot, 'db.sqlite'));
  indexOutput(odb, oroot);
  const observed = (odb.prepare('SELECT scenario, observed FROM findings ORDER BY scenario').all() as Array<{ scenario: string; observed: string }>);
  check('W1. observed is the page\'s messages verbatim, joined, when there are any', observed.find((o) => o.scenario === 'login shows an error')?.observed === 'Epic sadface: Username is required | Please try again', JSON.stringify(observed));
  check('W2. without messages, observed says so and gives the URL at the time', observed.find((o) => o.scenario === 'checkout redirects')?.observed === 'no message recorded; URL at the time: https://msg.example/cart');
  check('W3. no inference about navigation anywhere in observed', observed.every((o) => !/stayed|navigat|redirect/i.test(o.observed.replace(o.scenario, ''))), JSON.stringify(observed));
  odb.close();
  fs.rmSync(oroot, { recursive: true, force: true });
}
fs.rmSync(path.join(output, 'shop-example', shop1), { recursive: true, force: true });
const r3 = indexOutput(db2, root);
check('S. a run directory removed from disk vanishes from the index', r3.runs === 8 && r3.removed === 1 && !db2.prepare('SELECT 1 FROM runs WHERE id = ?').get(shop1));
fs.rmSync(path.join(root, '.qa-core', 'sites', 'demo.playwright.dev.json'));
const r4 = indexOutput(db2, root);
check('T9. a record removed from the store vanishes from the index', r4.runs === 7 && r4.removed === 1 && !db2.prepare("SELECT 1 FROM runs WHERE project_id = 'demo-playwright-dev'").get());
db2.close();

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: the index is rebuilt from output/ alone; every runs row equals its run-report, projects follow the host, findings dedupe across runs.');
