/**
 * PR A acceptance line (dashboard v2 plan, section 9): delete the database,
 * restart, every past run appears under the right project with numbers equal
 * to its run-report.
 *
 * Default: a fixture output tree in a temp root. `--real` runs the same
 * checks against this repository's own output/ (read-only; the index goes to
 * a temp file) and prints the counts per project. Both modes:
 *   1. index from nothing, 2. delete the database file, 3. index again
 *   (the gateway does exactly this on start), 4. compare every runs row to
 *   its report and its project to the run URL's host, 5. rows identical
 *   across the two indexes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/server/db/migrate.js';
import { indexOutput, hostOf, UNASSIGNED_PROJECT_ID } from '../src/server/db/indexer.js';
import { listRunDirs, newRunId } from '../src/agent/output-layout.js';
import type { RunReport } from '../src/agent/trace.js';

const real = process.argv.includes('--real');
let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

let root: string;
let tmp: string | null = null;
if (real) {
  root = process.cwd();
} else {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-accept-'));
  root = tmp;
  const output = path.join(root, 'output');
  const mk = (url: string, startedAt: string, shipped: number, planned: number, extra: Record<string, unknown> = {}) => ({
    url, language: 'ts', startedAt, finishedAt: startedAt, steps: 1,
    scenarios: Array.from({ length: shipped }, (_, i) => ({ name: `s${i}`, feature: 'login', category: 'happy', steps: [] })),
    cascadeStats: {}, cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0.7, plannerUsd: 0.02, criticUsd: 0.01 },
    plan: Array.from({ length: planned }, (_, i) => ({ name: `p${i}`, category: 'happy', rationale: 'r' })),
    reconciliation: { planned, generated: shipped, dropped: [], incomplete: [], findings: [], skipped: [], accountedFor: shipped, added: 0, balanced: true, stable: shipped, recovered: 0, flaky: 0, broken: 0 },
    ...extra,
  });
  const runs: Array<[string, string, Record<string, unknown>, Record<string, string>]> = [
    ['saucedemo-com', newRunId(new Date('2026-09-10T10:00:00Z'), '1'), mk('https://www.saucedemo.com/', '2026-09-10T10:00:00.000Z', 3, 4), {}],
    ['saucedemo-com', newRunId(new Date('2026-09-12T10:00:00Z'), '2'), mk('https://saucedemo.com/inventory.html', '2026-09-12T10:00:00.000Z', 2, 6, { stopped: { kind: 'cost_ceiling', reason: 'ceiling' } }), { 'checkpoint.json': '{}' }],
    ['the-internet-herokuapp-com', newRunId(new Date('2026-09-11T10:00:00Z'), '3'), mk('https://the-internet.herokuapp.com/login', '2026-09-11T10:00:00.000Z', 4, 4), {}],
    ['unassigned', newRunId(new Date('2026-09-09T10:00:00Z'), '4'), mk('not a url', '2026-09-09T10:00:00.000Z', 1, 1), {}],
  ];
  for (const [slug, id, rep, files] of runs) {
    const dir = path.join(output, slug, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(rep));
    for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), v);
  }
  // A legacy folder, still in place.
  fs.mkdirSync(path.join(output, 'legacy-automation-framework'), { recursive: true });
  fs.writeFileSync(path.join(output, 'legacy-automation-framework', 'run-report.json'), JSON.stringify(mk('https://legacy.example/', '2026-08-01T10:00:00.000Z', 2, 2)));
  // The gateway's pre-v2 record store: one record covered by the 09-10 report, one older with no report.
  fs.mkdirSync(path.join(root, '.qa-core', 'sites'), { recursive: true });
  fs.writeFileSync(path.join(root, '.qa-core', 'sites', 'www.saucedemo.com.json'), JSON.stringify({ host: 'www.saucedemo.com', recentRuns: [
    { at: '2026-09-10T10:00:30.000Z', url: 'https://www.saucedemo.com/', scenarios: 3, cost: 0.73, model: 'claude-opus-4-7', durationSec: 30 },
    { at: '2026-06-01T10:00:00.000Z', url: 'https://www.saucedemo.com/', scenarios: 4, cost: 0.51, model: 'claude-opus-4-7', durationSec: 90 },
  ] }));
}

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-accept-db-'));
const dbPath = path.join(dbDir, 'qa-core.sqlite');

function dump(d: ReturnType<typeof openDatabase>): string {
  const out: Record<string, unknown> = {};
  for (const t of ['projects', 'runs', 'findings', 'rule_coverage', 'verdicts']) {
    const rows = d.prepare(`SELECT * FROM ${t}`).all() as Array<Record<string, unknown>>;
    for (const r of rows) { delete r.created_at; delete r.updated_at; }
    out[t] = rows.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).sort()))).sort();
  }
  return JSON.stringify(out);
}

// 1. Index from nothing.
const db1 = openDatabase(dbPath);
const r1 = indexOutput(db1, root);
const first = dump(db1);
db1.close();
// 2 + 3. Delete the database, open again (what the gateway does on start), index.
for (const f of fs.readdirSync(dbDir)) fs.rmSync(path.join(dbDir, f), { force: true });
const db = openDatabase(dbPath);
const r2 = indexOutput(db, root);
const second = dump(db);

const onDisk = listRunDirs(path.join(root, 'output'));
check(`${real ? 'real' : 'fixture'}: every run directory on disk is a runs row (${onDisk.length}) plus ${r2.legacyRecords} imported pre-v2 record(s)`, r2.runs === onDisk.length + r2.legacyRecords, JSON.stringify({ rows: r2.runs, dirs: onDisk.length, records: r2.legacyRecords }));
check('rows after delete + reindex are identical to the first index', first === second && JSON.stringify(r1) === JSON.stringify({ ...r2, removed: r1.removed }), JSON.stringify({ r1, r2 }));

// 4. Every row equals its report and sits under the right project.
const rows = db.prepare('SELECT r.*, p.base_url FROM runs r JOIN projects p ON p.id = r.project_id ORDER BY r.started_at').all() as Array<Record<string, unknown>>;
let mismatches = 0;
const perProject = new Map<string, { runs: number; shipped: number; explored: number; legacy: number; cost: number; name: string }>();
let legacyCount = 0;
for (const row of rows) {
  if (row.status === 'legacy') {
    // A pre-v2 record: no report to compare against; it must carry no invented numbers and no file paths.
    legacyCount++;
    if (row.report_path !== null || row.zip_path !== null || Number(row.planned) !== 0 || row.shipped !== null) { mismatches++; console.log(`  legacy row ${String(row.id)} carries invented data (shipped must be NULL, the record only knew explored)`); }
    const pid = String(row.project_id);
    const agg = perProject.get(pid) ?? { runs: 0, shipped: 0, explored: 0, legacy: 0, cost: 0, name: '' };
    agg.runs++; agg.legacy++; agg.explored += Number(row.generated); agg.cost += Number(row.cost_total);
    perProject.set(pid, agg);
    continue;
  }
  const rep = JSON.parse(fs.readFileSync(path.join(root, String(row.report_path)), 'utf8')) as RunReport;
  const rec = rep.reconciliation;
  // Older reports may lack an array (skipped arrived in a later phase); a missing list counts as 0.
  const n = (v: unknown): number => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0);
  const expected = rec
    ? { planned: n(rec.planned), generated: n(rec.generated), dropped: n(rec.dropped), incomplete: n(rec.incomplete), findings: n(rec.findings), skipped: n(rec.skipped), stable: n(rec.stable), flaky: n(rec.flaky), broken: n(rec.broken) }
    : { planned: n(rep.plan), generated: rep.scenarios.length, dropped: 0, incomplete: n(rep.incomplete), findings: n(rep.findings), skipped: n(rep.skipped), stable: rep.stability && !rep.stability.skipped ? rep.stability.passed : 0, flaky: rep.stability?.flaky ?? 0, broken: rep.stability?.broken ?? 0 };
  const exp = { ...expected, shipped: rep.scenarios.length, cost_total: rep.cost.usd + (rep.cost.plannerUsd ?? 0) + (rep.cost.criticUsd ?? 0), cost_planner: rep.cost.plannerUsd ?? 0, cost_critic: rep.cost.criticUsd ?? 0, cost_repair: rep.cost.repairUsd ?? 0, stopped_reason: rep.stopped?.reason ?? null, url: rep.url };
  const bad = Object.entries(exp).filter(([k, v]) => (typeof v === 'number' ? Math.abs(Number(row[k]) - v) > 1e-9 : row[k] !== v)).map(([k]) => k);
  if (bad.length) { mismatches++; console.log(`  mismatch ${String(row.id)}: ${bad.join(', ')}`); }
  const host = hostOf(rep.url);
  const rightProject = host ? hostOf(String(row.base_url)) === host : row.project_id === UNASSIGNED_PROJECT_ID;
  if (!rightProject) { mismatches++; console.log(`  wrong project for ${String(row.id)}: ${String(row.project_id)} (host ${host})`); }
  const pid = String(row.project_id);
  const agg = perProject.get(pid) ?? { runs: 0, shipped: 0, explored: 0, legacy: 0, cost: 0, name: '' };
  agg.runs++; agg.shipped += Number(row.shipped); agg.cost += Number(row.cost_total);
  perProject.set(pid, agg);
}
check('every runs row equals its run-report and sits under the project matching its host', mismatches === 0, `${mismatches} mismatch(es)`);
check('legacy rows equal the imported record count', legacyCount === r2.legacyRecords, JSON.stringify({ legacyCount, imported: r2.legacyRecords }));
if (!real) {
  check('fixture: the record covered by a report was skipped, the older one imported as legacy under saucedemo', r2.legacyRecords === 1 && r2.legacyCovered === 1 && (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE project_id = 'saucedemo-com' AND status = 'legacy'").get() as { n: number }).n === 1);
  check('fixture: two saucedemo hosts (www and bare) share one project (plus its imported record); the bad url is Unassigned; the legacy folder has its own project', (db.prepare("SELECT COUNT(*) AS n FROM runs WHERE project_id = 'saucedemo-com' AND status != 'legacy'").get() as { n: number }).n === 2 && (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE project_id = ?').get(UNASSIGNED_PROJECT_ID) as { n: number }).n === 1 && r2.projects === 4 && r2.legacy === 1);
}
const names = db.prepare('SELECT id, name FROM projects').all() as Array<{ id: string; name: string }>;
console.log(`\nIndex of ${root === process.cwd() ? 'the real output/' : 'the fixture'}: ${r2.runs} run(s) (${r2.runs - r2.legacyRecords} with reports, ${r2.legacyRecords} pre-v2 records imported, ${r2.legacyCovered} records covered by a report), ${r2.projects} project(s), ${r2.legacy} legacy folder(s) in place, ${r2.findings} finding(s)`);
for (const [pid, agg] of [...perProject.entries()].sort()) console.log(`  ${names.find((n) => n.id === pid)?.name ?? pid} (${pid}): ${agg.runs} run(s), ${agg.shipped} shipped${agg.legacy ? ` (+${agg.legacy} legacy run(s), ${agg.explored} explored)` : ''}, $${agg.cost.toFixed(4)}`);
const unassigned = perProject.get(UNASSIGNED_PROJECT_ID);
console.log(`  unassigned: ${unassigned ? unassigned.runs : 0}`);
db.close();
fs.rmSync(dbDir, { recursive: true, force: true });
if (tmp) fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: delete the database, index again, every past run is under the right project with numbers equal to its run-report.');
