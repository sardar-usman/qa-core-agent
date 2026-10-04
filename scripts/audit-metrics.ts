/**
 * audit-metrics: the numbers behind docs/audit-2026-09.md, read from each
 * run's run-report.json and nothing else. Read only; never writes.
 *
 *   npx tsx scripts/audit-metrics.ts
 *
 * Not named smoke-*, so the smoke suite does not run it.
 *
 * Rules (standing rule 2): every value is read from a named key of the
 * report. When a report lacks the key the cell prints "n/r" (not on this
 * report), never 0 and never a guess from another file. The few derived
 * values are ratios of named keys and say so in their header:
 *
 * - explored: what the Explorer recorded. reconciliation.generated plus the
 *   reconciliation.dropped entries at the critic, repair, replay and
 *   stability stages (the run page's "recorded" count, run-detail.ts) plus
 *   reconciliation.emitted_failed (a scenario dropped by the emitted-spec
 *   check was recorded and passed every earlier stage).
 * - critic first pass: review.verdicts holds the FINAL verdicts and
 *   review.repair the history of every rework (first: "rework"). A
 *   scenario's first-pass verdict is "rework" when it has a repair entry,
 *   else its final verdict. The rework rate is first-pass rework over the
 *   number of verdicts.
 * - explorer $ per explored: (cost.usd minus cost.repairUsd) over explored,
 *   the figure the repair decision line prints.
 * - cost total: totalCost() from src/agent/cost-total.ts; $ per shipped is
 *   total over scenarios.length.
 * - findings: findingsOf() from src/agent/reconcile.ts (a report written
 *   before the findings key was always written has none when the key is
 *   absent).
 *
 * The second block compares pages, planned, explored, shipped and cost
 * with the Toolshop runs table in STATE.md, one line per mismatch. The
 * third block prints the saucedemo proof runs in the same shape. The
 * fourth block prints, per Toolshop run, the surface (run-meta.json
 * `source`; a run with no run-meta prints n/r and shows its checkpoint
 * flags), the explore flags as recorded, and the sha256 of the SRS the run
 * used (the run folder's copy, else the file the flags name; n/r when
 * neither exists), then says which flags differ and whether every hash
 * matches.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { RunReport } from '../src/agent/trace.js';
import { totalCost, hasRequirementsCost } from '../src/agent/cost-total.js';
import { findingsOf } from '../src/agent/reconcile.js';
import { scenarioNameKey } from '../src/agent/rule-coverage.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const NR = 'n/r';

const TOOLSHOP_RUNS: Array<{ n: number; dir: string }> = [
  { n: 1, dir: 'output/practicesoftwaretesting-com/20260915T174318Z-ec8eff' },
  { n: 2, dir: 'output/practicesoftwaretesting-com/20260918T132313Z-f3b41e' },
  { n: 3, dir: 'output/practicesoftwaretesting-com/20260918T163858Z-5e4394' },
  { n: 4, dir: 'output/practicesoftwaretesting-com/20260922T152127Z-591732' },
  { n: 5, dir: 'output/practicesoftwaretesting-com/20260924T152355Z-51d535' },
  { n: 6, dir: 'output/practicesoftwaretesting-com/20261001T122557Z-44cb3d' },
];

/** The four saucedemo proof runs STATE.md dates, matched by folder and start date. */
const SAUCEDEMO_PROOF: Array<{ label: string; date: string; stateCost: string; stateShipped: number }> = [
  { label: 'Sept 14 (first dashboard run)', date: '2026-09-14', stateCost: '0.6187', stateShipped: 4 },
  { label: 'Sept 17 after #18', date: '2026-09-17', stateCost: '0.4536', stateShipped: 3 },
  { label: 'Sept 17 after #19', date: '2026-09-17', stateCost: '0.3437', stateShipped: 4 },
  { label: 'Oct 1 after #32', date: '2026-10-01', stateCost: '0.5961', stateShipped: 4 },
];

interface Row {
  run: string;
  date: string;
  pages: string;
  planned: string;
  explored: string;
  critic: string;
  reworkRate: string;
  repair: string;
  replay: string;
  stability: string;
  shipped: string;
  rules: string;
  emitted: string;
  findings: string;
  cost: string;
  mapCost: string;
  perShipped: string;
  explorerPerExplored: string;
  cacheShare: string;
  end: string;
  // raw numbers for the comparison block
  raw: { pages?: number; planned?: number; explored?: number; shipped?: number; cost: number; reworkCount?: number; verdictCount?: number };
}

function readReport(dir: string): RunReport {
  const file = path.join(ROOT, dir, 'run-report.json');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as RunReport;
}

const RECORDED_STAGES = new Set(['critic', 'repair', 'replay', 'stability']);

function exploredOf(report: RunReport): number | undefined {
  const rec = report.reconciliation;
  if (!rec) return undefined;
  const dropped = (rec.dropped ?? []).filter((d) => RECORDED_STAGES.has(d.stage)).length;
  return rec.generated + dropped + (rec.emitted_failed ?? []).length;
}

function firstPassOf(report: RunReport): { pass: number; rework: number; reject: number; total: number } | undefined {
  const verdicts = report.review?.verdicts;
  if (!verdicts) return undefined;
  const repaired = new Set((report.review?.repair ?? []).map((h) => scenarioNameKey(h.scenario)));
  let pass = 0; let rework = 0; let reject = 0;
  for (const v of verdicts) {
    const first = repaired.has(scenarioNameKey(v.scenario)) ? 'rework' : v.verdict;
    if (first === 'pass') pass++; else if (first === 'rework') rework++; else reject++;
  }
  return { pass, rework, reject, total: verdicts.length };
}

function rowFor(label: string, report: RunReport): Row {
  const raw: Row['raw'] = { cost: totalCost(report) };
  const pages = report.discovery?.pages?.length;
  raw.pages = pages;
  const planned = report.reconciliation?.planned ?? report.plan?.length;
  raw.planned = planned;
  const explored = exploredOf(report);
  raw.explored = explored;
  const shipped = report.scenarios.length;
  raw.shipped = shipped;

  const fp = firstPassOf(report);
  let critic = NR; let reworkRate = NR;
  if (fp) {
    critic = `${fp.pass}/${fp.rework}/${fp.reject} of ${fp.total}`;
    reworkRate = fp.total > 0 ? `${((fp.rework / fp.total) * 100).toFixed(1)}%` : 'n/a';
    raw.reworkCount = fp.rework; raw.verdictCount = fp.total;
  }

  const hist = report.review?.repair;
  let repair = NR;
  if (hist) {
    const kept = hist.filter((h) => h.outcome === 'kept').length;
    const dropped = hist.filter((h) => h.outcome === 'dropped').length;
    const reRecorded = hist.filter((h) => h.second !== undefined).length;
    repair = `${kept}/${dropped} (re-recorded ${reRecorded} of ${hist.length})`;
  } else if (fp && fp.rework === 0) {
    repair = 'none (0 rework)';
  }

  const replay = report.replay && !report.replay.skipped ? `${report.replay.passed}/${report.replay.verdicts.length}` : NR;
  const stability = report.stability && !report.stability.skipped ? `${report.stability.passed}/${report.stability.verdicts.length}` : NR;

  const rc = report.ruleCoverage;
  const rules = rc ? `${rc.covered.length}/${rc.covered.length + rc.uncovered.length}` : NR;

  let emitted = NR;
  if (report.emittedRun) {
    const tests = report.emittedRun.tests;
    const passed = tests.filter((t) => t.status === 'passed').length;
    emitted = `${passed}/${tests.length}`;
    if (report.emittedRun.inconclusive) emitted += ` (inconclusive: ${report.emittedRun.reason ?? 'no reason'})`;
  }

  const findings = String(findingsOf(report).length);
  const cost = `$${raw.cost.toFixed(4)}`;
  const mapCost = hasRequirementsCost(report) ? `$${(report.cost.requirementsUsd as number).toFixed(4)}` : NR;
  const perShipped = shipped > 0 ? `$${(raw.cost / shipped).toFixed(2)}` : 'n/a (0 shipped)';
  const explorerUsd = report.cost.usd - (report.cost.repairUsd ?? 0);
  const explorerPerExplored = explored && explored > 0 ? `$${(explorerUsd / explored).toFixed(4)}` : NR;
  const cacheShare = typeof report.cost.cachedInputShare === 'number' ? `${(report.cost.cachedInputShare * 100).toFixed(1)}%` : NR;
  const end = report.stopped ? `stopped (${report.stopped.kind}): ${report.stopped.reason}` : 'completed';

  return {
    run: label,
    date: report.startedAt.slice(0, 10),
    pages: pages === undefined ? NR : String(pages),
    planned: planned === undefined ? NR : String(planned),
    explored: explored === undefined ? NR : String(explored),
    critic, reworkRate, repair, replay, stability,
    shipped: String(shipped), rules, emitted, findings, cost, mapCost, perShipped, explorerPerExplored, cacheShare, end,
    raw,
  };
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(' | ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('-|-'), ...rows.map(line)].join('\n');
}

function printRows(title: string, rows: Row[]): void {
  console.log(`\n${title}`);
  console.log('\nA. Funnel (first-pass Critic is pass/rework/reject of verdicts; repair is kept/dropped)');
  console.log(table(
    ['run', 'date', 'pages', 'planned', 'explored', 'critic 1st pass', 'rework rate', 'repair', 'replay', 'stability', 'shipped', 'rules', 'emitted check', 'findings'],
    rows.map((r) => [r.run, r.date, r.pages, r.planned, r.explored, r.critic, r.reworkRate, r.repair, r.replay, r.stability, r.shipped, r.rules, r.emitted, r.findings]),
  ));
  console.log('\nB. Cost and end state');
  console.log(table(
    ['run', 'cost total', 'map cost', '$ per shipped', 'explorer $ per explored', 'cache share', 'end state'],
    rows.map((r) => [r.run, r.cost, r.mapCost, r.perShipped, r.explorerPerExplored, r.cacheShare, r.end]),
  ));
}

/** The Toolshop runs table in STATE.md: `| 1 ec8eff | Sept 15 | baseline | 3 | 10 | 6 | 0 | $6.08 | ... |`. */
function stateTable(): Map<number, { pages: string; planned: string; explored: string; shipped: string; cost: string }> {
  const text = fs.readFileSync(path.join(ROOT, 'STATE.md'), 'utf8');
  const out = new Map<number, { pages: string; planned: string; explored: string; shipped: string; cost: string }>();
  for (const line of text.split('\n')) {
    const m = /^\| (\d) [0-9a-f]{6} \|/.exec(line);
    if (!m) continue;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is '' before the first pipe: [ '', run, date, after, pages, planned, explored, shipped, cost, end, diagnosis, '' ]
    out.set(Number(m[1]), { pages: cells[4] ?? '', planned: cells[5] ?? '', explored: cells[6] ?? '', shipped: cells[7] ?? '', cost: cells[8] ?? '' });
  }
  return out;
}

function main(): void {
  const toolshop = TOOLSHOP_RUNS.map(({ n, dir }) => rowFor(`${n} ${dir.slice(-6)}`, readReport(dir)));
  printRows('Toolshop runs (practicesoftwaretesting.com, same SRS, $6 ceiling)', toolshop);

  console.log('\nC. Comparison with the STATE.md runs table (pages, planned, explored, shipped, cost)');
  const state = stateTable();
  let mismatches = 0;
  let compared = 0;
  TOOLSHOP_RUNS.forEach(({ n }, i) => {
    const row = toolshop[i]!;
    const s = state.get(n);
    if (!s) { console.log(`  run ${n}: no row in STATE.md`); mismatches++; return; }
    const checks: Array<[string, string, string]> = [
      ['pages', row.pages, s.pages],
      ['planned', row.planned, s.planned],
      ['explored', row.explored, s.explored],
      ['shipped', row.shipped, s.shipped],
      ['cost', `$${row.raw.cost.toFixed(2)}`, s.cost],
    ];
    for (const [name, report, stateValue] of checks) {
      compared++;
      if (report !== stateValue) { console.log(`  run ${n} ${name}: report ${report}, STATE.md ${stateValue}`); mismatches++; }
    }
  });
  console.log(`  ${compared} values compared, ${mismatches} mismatch(es)`);
  const total = toolshop.reduce((a, r) => a + r.raw.cost, 0);
  console.log(`  Toolshop total over six runs: $${total.toFixed(4)} (sum of totalCost per report)`);

  // Saucedemo proof runs: every folder under output/saucedemo-com, matched to STATE.md's dated list by start date.
  const sauceDir = path.join(ROOT, 'output/saucedemo-com');
  // Real run folders only: the `latest` pointer is a symlink to one of them and must not count twice.
  const folders = fs.readdirSync(sauceDir).filter((f) => !fs.lstatSync(path.join(sauceDir, f)).isSymbolicLink() && fs.existsSync(path.join(sauceDir, f, 'run-report.json'))).sort();
  const reports = folders.map((f) => ({ folder: f, report: readReport(path.join('output/saucedemo-com', f)) }));
  const rows: Row[] = [];
  const used = new Set<string>();
  const notes: string[] = [];
  for (const proof of SAUCEDEMO_PROOF) {
    const candidates = reports.filter((r) => r.report.startedAt.slice(0, 10) === proof.date && !used.has(r.folder));
    // Two proof runs share Sept 17; the cost in STATE.md tells them apart.
    const byCost = candidates.filter((r) => totalCost(r.report).toFixed(4) === proof.stateCost);
    const pick = byCost.length === 1 ? byCost[0] : candidates.length === 1 ? candidates[0] : undefined;
    if (!pick) {
      notes.push(`  ${proof.label}: ${candidates.length === 0 ? 'no folder started on ' + proof.date : 'ambiguous (' + candidates.map((c) => c.folder).join(', ') + ')'}; not guessed`);
      continue;
    }
    used.add(pick.folder);
    const row = rowFor(`${proof.label} ${pick.folder.slice(-6)}`, pick.report);
    rows.push(row);
    const costOk = totalCost(pick.report).toFixed(4) === proof.stateCost;
    const shippedOk = pick.report.scenarios.length === proof.stateShipped;
    if (!costOk || !shippedOk) notes.push(`  ${proof.label} (${pick.folder}): report cost $${totalCost(pick.report).toFixed(4)} shipped ${pick.report.scenarios.length}; STATE.md $${proof.stateCost} shipped ${proof.stateShipped}`);
  }
  printRows('saucedemo proof runs (the four dated in STATE.md)', rows);
  console.log('\nD. Comparison with the STATE.md saucedemo proof lines (cost, shipped)');
  if (notes.length === 0) console.log('  all four matched one folder each; cost and shipped agree with STATE.md');
  else for (const n of notes) console.log(n);
  const proofTotal = rows.reduce((a, r) => a + r.raw.cost, 0);
  console.log(`  saucedemo proof total over ${rows.length} matched run(s): $${proofTotal.toFixed(4)} (sum of totalCost per report)`);
  const unmatched = reports.filter((r) => !used.has(r.folder));
  if (unmatched.length > 0) console.log(`  other saucedemo folders not in STATE.md's proof list: ${unmatched.map((r) => `${r.folder} (${r.report.startedAt.slice(0, 10)}, $${totalCost(r.report).toFixed(4)}, ${r.report.scenarios.length} shipped)`).join('; ')}`);
}

/** Flags as recorded on run-meta.json (or checkpoint.json when run-meta is missing). */
type RecordedFlags = Record<string, unknown>;

interface RunSetup {
  run: string;
  surface: string;
  flagsFrom: string;
  flags: RecordedFlags | undefined;
  srsPath: string;
  srsHash: string;
}

const FLAG_KEYS = ['lang', 'pom', 'features', 'discover', 'urls', 'replay', 'stability', 'stabilityIterations', 'stabilize', 'stabilizeAttempts', 'emittedCheck', 'env'];

function flagCell(flags: RecordedFlags | undefined, key: string): string {
  if (!flags || !(key in flags)) return '(absent)';
  return JSON.stringify(flags[key]);
}

function setupFor(label: string, dir: string): RunSetup {
  const metaPath = path.join(ROOT, dir, 'run-meta.json');
  const checkpointPath = path.join(ROOT, dir, 'checkpoint.json');
  let surface = NR; let flagsFrom = 'none'; let flags: RecordedFlags | undefined;
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { source?: string; flags?: RecordedFlags };
    surface = meta.source ?? NR; flags = meta.flags; flagsFrom = 'run-meta.json';
  } else if (fs.existsSync(checkpointPath)) {
    const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as { flags?: RecordedFlags };
    flags = cp.flags; flagsFrom = 'checkpoint.json (no run-meta.json; the checkpoint records no source)';
  }
  // The SRS the run used: the run folder's own copy first, else the file the flags name.
  const ownCopy = fs.readdirSync(path.join(ROOT, dir)).find((f) => /srs/i.test(f) && f.endsWith('.md'));
  const named = typeof flags?.srs === 'string' ? (flags.srs as string) : undefined;
  let srsPath = NR; let srsHash = NR;
  const candidate = ownCopy ? path.join(dir, ownCopy) : named;
  if (candidate && fs.existsSync(path.join(ROOT, candidate))) {
    srsPath = candidate;
    srsHash = createHash('sha256').update(fs.readFileSync(path.join(ROOT, candidate))).digest('hex');
  } else if (named) {
    srsPath = `${named} (file missing)`;
  }
  return { run: label, surface, flagsFrom, flags, srsPath, srsHash };
}

function printSetups(setups: RunSetup[]): void {
  console.log('\nE. Surface, flags and SRS per Toolshop run (run-meta.json, else checkpoint.json; SRS sha256 of the file the run used)');
  console.log(table(
    ['run', 'surface', 'flags read from', 'SRS file', 'SRS sha256'],
    setups.map((s) => [s.run, s.surface, s.flagsFrom, s.srsPath, s.srsHash]),
  ));
  console.log('\nFlags as recorded (a key the record does not carry prints "(absent)")');
  console.log(table(['flag', ...setups.map((s) => s.run)], FLAG_KEYS.map((k) => [k, ...setups.map((s) => flagCell(s.flags, k))])));
  // Two kinds of difference: a key some record does not carry (an older flag shape), and a key present everywhere with different values.
  const absentSomewhere = FLAG_KEYS.filter((k) => setups.some((s) => flagCell(s.flags, k) === '(absent)') && !setups.every((s) => flagCell(s.flags, k) === '(absent)'));
  const valueDiffers = FLAG_KEYS.filter((k) => new Set(setups.filter((s) => flagCell(s.flags, k) !== '(absent)').map((s) => flagCell(s.flags, k))).size > 1);
  console.log(`  flags absent on some runs: ${absentSomewhere.length === 0 ? 'none' : absentSomewhere.map((k) => `${k} (absent on ${setups.filter((s) => flagCell(s.flags, k) === '(absent)').map((s) => s.run).join(', ')})`).join('; ')}`);
  console.log(`  flags whose recorded values differ: ${valueDiffers.length === 0 ? 'none' : valueDiffers.map((k) => `${k} (${setups.map((s) => `${s.run}: ${flagCell(s.flags, k)}`).join(', ')})`).join('; ')}`);
  const hashes = setups.filter((s) => s.srsHash !== NR).map((s) => s.srsHash);
  const distinct = new Set(hashes);
  const missing = setups.filter((s) => s.srsHash === NR).map((s) => s.run);
  console.log(`  SRS hashes: ${hashes.length} of ${setups.length} runs have a readable SRS file, ${distinct.size} distinct hash(es)${missing.length ? `; no readable SRS for: ${missing.join(', ')}` : ''}`);
  // The project-level SRS the dashboard copies into a run folder (output/<project>/srs/, srs.json beside it).
  const projectSrsDir = path.join(ROOT, 'output/practicesoftwaretesting-com/srs');
  const srsJson = path.join(projectSrsDir, 'srs.json');
  if (fs.existsSync(srsJson)) {
    const meta = JSON.parse(fs.readFileSync(srsJson, 'utf8')) as { current?: { path?: string; uploaded_at?: string } };
    const cur = meta.current?.path;
    if (cur && fs.existsSync(path.join(ROOT, cur))) {
      const h = createHash('sha256').update(fs.readFileSync(path.join(ROOT, cur))).digest('hex');
      console.log(`  project SRS: ${cur} uploaded ${meta.current?.uploaded_at ?? NR}, sha256 ${h}${distinct.size === 1 && distinct.has(h) ? ' (same as every readable run copy)' : ''}`);
    }
  }
}

main();
printSetups(TOOLSHOP_RUNS.map(({ n, dir }) => setupFor(`${n} ${dir.slice(-6)}`, dir)));
