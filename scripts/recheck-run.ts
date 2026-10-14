/**
 * Re-run the emitted-spec check and the zip on an existing run, for $0 (no
 * model call). Read only on the source run directory.
 *
 *   npx tsx scripts/recheck-run.ts <run-dir> --out <new-dir>
 *
 * From <run-dir>/run-report.json (and requirements-map.json when present)
 * the framework is re-emitted into a fresh temporary directory, the
 * emitted-spec check runs it once against the live site with the test
 * account from the env (the host-scoped pair first, read from .env the way
 * a run reads it; names printed, never values), and the zip is written with
 * the same rules as a run (src/agent/framework-zip.ts, invariant 70: a
 * session file under playwright/.auth/ or an account value refuses it, and
 * the run output folders never enter it). The updated run-report.json, its
 * rule-coverage.json and the zip land in <new-dir>, which must be empty or
 * new and outside <run-dir>. Nothing is written into <run-dir>.
 *
 * Exit code: 0 when the zip is written; 1 when it is refused or fails; 2 on
 * bad arguments.
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunReport } from '../src/agent/trace.js';
import type { RequirementsMap } from '../src/agent/requirements.js';
import { scaffold, frameworkDirName } from '../src/agent/scaffold.js';
import { emittedCheckStage, writeReportFiles } from '../src/agent/emitted-check.js';
import { resolveTestCredentials } from '../src/agent/test-credentials.js';
import { runFrameworkLines, writeFrameworkZip, zipExitCode, zipResultLines } from '../src/agent/framework-zip.js';

const USAGE = 'usage: npx tsx scripts/recheck-run.ts <run-dir> --out <new-dir>';
const argv = process.argv.slice(2);
let runArg: string | undefined;
let outArg: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === '--out') { outArg = argv[++i]; continue; }
  if (a.startsWith('--') || runArg !== undefined) { console.error(USAGE); process.exit(2); }
  runArg = a;
}
if (!runArg || !outArg || outArg.startsWith('--')) { console.error(USAGE); process.exit(2); }

const runDir = path.resolve(runArg);
const outDir = path.resolve(outArg);
const reportPath = path.join(runDir, 'run-report.json');
if (!fs.existsSync(reportPath)) { console.error(`no run-report.json in ${runArg}`); process.exit(2); }
const inside = (child: string, parent: string): boolean => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
if (inside(outDir, runDir)) { console.error(`--out must be outside the run directory (${runArg} is read only)`); process.exit(2); }
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) { console.error(`--out ${outArg} is not empty; name a new or empty directory`); process.exit(2); }

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as RunReport;
// This is a fresh attempt: an earlier refusal is not carried over.
delete report.zipRefused;
let requirements: RequirementsMap | undefined;
const mapPath = path.join(runDir, 'requirements-map.json');
if (fs.existsSync(mapPath)) { try { requirements = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as RequirementsMap; } catch { /* no enrichment */ } }

// Relative to the cwd when inside it, else absolute (a ../../ chain reads worse than the path).
const rel = (p: string): string => { const r = path.relative(process.cwd(), p); return r === '' ? p : r.startsWith('..') ? p : r; };
console.log(`recheck: ${rel(runDir)} -> ${rel(outDir)} (no model call; the source run directory is read only)`);
console.log(`  ${report.scenarios.length} scenario(s) · ${report.language} · ${report.url}`);
console.log(`  ${resolveTestCredentials(process.env, report.url).line}`);

const zipRootName = frameworkDirName(report.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-recheck-'));
const frameworkDir = path.join(tmp, zipRootName);
let siteName: string;
try { siteName = new URL(report.url).hostname; } catch { siteName = report.url; }
const scaffoldOpts = { outDir: frameworkDir, siteName, ...(requirements ? { requirements } : {}) };
let exitCode = 1;
try {
  scaffold({ report, ...scaffoldOpts });
  await emittedCheckStage({
    report, frameworkDir,
    ...(requirements ? { requirements } : {}),
    rescaffold: (r) => { scaffold({ report: r, ...scaffoldOpts }); },
    log: (line) => console.log(line),
  });
  writeReportFiles(outDir, report);
  const outcome = writeFrameworkZip({ frameworkDir, destDir: outDir, zipRootName, runDir: outDir, report });
  if (outcome.refused) writeReportFiles(outDir, report);
  const zipRel = outcome.written ? rel(outcome.written.zipPath) : undefined;
  for (const line of zipResultLines(outcome, { outDirRel: rel(outDir), ...(zipRel ? { zipRel } : {}) })) (outcome.written ? console.log : console.error)(line);
  for (const line of runFrameworkLines(outcome, { outDirRel: rel(outDir), ...(zipRel ? { zipRel } : {}) })) console.log(line);
  exitCode = zipExitCode(outcome);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(exitCode);
