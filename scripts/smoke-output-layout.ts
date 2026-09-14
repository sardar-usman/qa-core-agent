/**
 * Locks the per-run output layout (dashboard v2 plan, section 5):
 *   - output/<project-slug>/<run-id>/ per run; run id = compact ISO time + 6-char hash
 *   - <project>/latest points at the newest COMPLETED run (symlink, json fallback)
 *   - --out stays an explicit whole-directory override, no pointer
 *   - listRunDirs sees both layouts once each and never follows the symlink
 *   - the migration moves each legacy folder (and its sibling zip) into the
 *     layout as one run dated from its report, writes run-meta, sets latest,
 *     is idempotent, and its dry run changes nothing
 *   - transcribe into a run directory leaves the zip inside it and the
 *     directory slimmed to its report files
 * No browser, no model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  projectSlug, newRunId, runIdTime, RUN_ID_RE, runDirFor, setLatest, readLatest, finalizeRunDir, listRunDirs,
  migrateOutput, readRunMeta, isLayoutRunDir,
} from '../src/agent/output-layout.js';
import { outDirForRequest, defaultExploreRequest } from '../src/agent/explore-request.js';
import { listRunsFromDisk } from '../src/server/runs.js';
import { runTranscribeRequest } from '../src/server/run-explore.js';
import type { RunReport } from '../src/agent/trace.js';

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, hint?: string): void => {
  if (ok) { pass++; console.log(`OK  ${label}`); }
  else { fail++; console.log(`FAIL ${label}${hint ? ' : ' + hint : ''}`); }
};

/* ─── identity ─── */

check('A. projectSlug strips www and joins host parts with hyphens', projectSlug('https://www.saucedemo.com/') === 'saucedemo-com' && projectSlug('http://uitestingplayground.com/dynamicid') === 'uitestingplayground-com' && projectSlug('https://the-internet.herokuapp.com/login') === 'the-internet-herokuapp-com');
check('B. projectSlug falls back to unassigned for an unparseable url', projectSlug('') === 'unassigned');
const id1 = newRunId(new Date('2026-09-14T14:54:32.123Z'), 'seed');
check('C. run id is compact ISO time plus a 6-char hash', RUN_ID_RE.test(id1) && id1.startsWith('20260914T145432Z-'), id1);
check('D. run id time round-trips to the second', runIdTime(id1)?.toISOString() === '2026-09-14T14:54:32.000Z', String(runIdTime(id1)));
check('E. two ids in the same second differ', newRunId(new Date('2026-09-14T14:54:32.000Z'), 'a') !== newRunId(new Date('2026-09-14T14:54:32.000Z'), 'b'));
check('F. runDirFor is root/slug/run-id', runDirFor('/r/output', 'https://www.saucedemo.com/', id1) === path.join('/r/output', 'saucedemo-com', id1));
const req = defaultExploreRequest();
check('G. outDirForRequest uses the layout by default', outDirForRequest(req, 'https://www.saucedemo.com/', '/r/output', id1) === path.join('/r/output', 'saucedemo-com', id1));
check('H. --out is an explicit whole-directory override, untouched by the layout', outDirForRequest({ ...req, outBase: '/tmp/my-run' }, 'https://www.saucedemo.com/', '/r/output', id1) === path.resolve('/tmp/my-run'));
check('I. isLayoutRunDir recognises a run directory by its name', isLayoutRunDir(path.join('/r/output', 'x', id1)) && !isLayoutRunDir('/r/output/saucedemo-automation-framework'));

/* ─── fixture tree ─── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-layout-'));
const root = tmp;
const output = path.join(root, 'output');
const target = (intent: string, arg: string) => ({ level: 'text' as const, arg, intent });
function report(url: string, startedAt: string, opts: { stopped?: boolean; scenarios?: number } = {}): RunReport {
  const n = opts.scenarios ?? 2;
  const scenarios = Array.from({ length: n }, (_, i) => ({
    name: `scenario ${i + 1}`, feature: 'login', category: 'happy' as const,
    steps: [
      { kind: 'navigate' as const, url },
      { kind: 'assert' as const, name: 'title', assertion: { type: 'toBeVisible' as const, target: target('page title', 'Products'), timeout: 10000 } },
    ],
  }));
  return {
    url, language: 'ts', scenarios,
    cascadeStats: { role: 0, label: 0, testid: 0, css: 0, text: n } as never,
    cost: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0.5, plannerUsd: 0.01, criticUsd: 0.02 },
    steps: 4, startedAt, finishedAt: startedAt,
    plan: scenarios.map((s) => ({ name: s.name, category: 'happy', rationale: 'r', feature: 'login' })),
    ...(opts.stopped ? { stopped: { kind: 'cost_ceiling' as const, reason: 'ceiling' } } : {}),
  };
}
function writeLegacy(name: string, rep: RunReport, extra: Record<string, string> = {}, withZip = true): void {
  const dir = path.join(output, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run-report.json'), JSON.stringify(rep, null, 2));
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(dir, k), v);
  if (withZip) fs.writeFileSync(path.join(output, `${name}.zip`), 'PK' + '\0'.repeat(18));
}
writeLegacy('saucedemo-automation-framework', report('https://www.saucedemo.com/', '2026-09-12T17:28:40.805Z'));
writeLegacy('shop-automation-framework', report('https://shop.example/', '2026-09-10T10:00:00.000Z', { stopped: true }), { 'checkpoint.json': '{"version":1}', 'requirements-map.json': '{"features":[]}' });
writeLegacy('20260701-120602-uitestingplayground-com-dynamicid', report('http://uitestingplayground.com/dynamicid', '2026-07-01T12:06:02.629Z'), { 'dynamicid.spec.ts': '// spec' }, false);
fs.mkdirSync(path.join(output, '.uploads'), { recursive: true });
fs.writeFileSync(path.join(output, '.uploads', 'x.md'), '# srs');
// One run already in the new layout, with a latest pointer.
const existingId = newRunId(new Date('2026-09-13T09:00:00Z'), 'existing');
const existingDir = path.join(output, 'saucedemo-com', existingId);
fs.mkdirSync(existingDir, { recursive: true });
fs.writeFileSync(path.join(existingDir, 'run-report.json'), JSON.stringify(report('https://www.saucedemo.com/', '2026-09-13T09:00:00.000Z')));
setLatest(path.join(output, 'saucedemo-com'), existingId);

const before = listRunDirs(output);
check('J. listRunDirs sees 3 legacy folders and 1 layout run, ignoring .uploads and the latest symlink', before.length === 4 && before.filter((e) => e.legacy).length === 3 && before.some((e) => e.runId === existingId && e.projectSlug === 'saucedemo-com'), JSON.stringify(before.map((e) => e.runId)));

/* ─── latest pointer ─── */

check('K. readLatest resolves the symlink to the run id', readLatest(path.join(output, 'saucedemo-com')) === existingId);
const stoppedDir = path.join(output, 'saucedemo-com', newRunId(new Date('2026-09-13T12:00:00Z'), 'stopped'));
fs.mkdirSync(stoppedDir, { recursive: true });
fs.writeFileSync(path.join(stoppedDir, 'run-report.json'), JSON.stringify(report('https://www.saucedemo.com/', '2026-09-13T12:00:00.000Z', { stopped: true })));
fs.writeFileSync(path.join(stoppedDir, 'checkpoint.json'), '{}');
check('L. finalizeRunDir leaves latest alone for a stopped run', finalizeRunDir(stoppedDir).latest === null && readLatest(path.join(output, 'saucedemo-com')) === existingId);
const newerDir = path.join(output, 'saucedemo-com', newRunId(new Date('2026-09-13T15:00:00Z'), 'newer'));
fs.mkdirSync(newerDir, { recursive: true });
fs.writeFileSync(path.join(newerDir, 'run-report.json'), JSON.stringify(report('https://www.saucedemo.com/', '2026-09-13T15:00:00.000Z')));
const fin = finalizeRunDir(newerDir);
check('M. finalizeRunDir moves latest to a newer completed run', fin.latest !== null && readLatest(path.join(output, 'saucedemo-com')) === path.basename(newerDir), JSON.stringify(fin));
check('N. finalizeRunDir does not move latest back to an older completed run', finalizeRunDir(existingDir).latest === null && readLatest(path.join(output, 'saucedemo-com')) === path.basename(newerDir));
check('O. finalizeRunDir writes no pointer for an explicit --out directory', (() => { const d = path.join(tmp, 'my-run'); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'run-report.json'), JSON.stringify(report('https://x.example/', '2026-09-13T15:00:00.000Z'))); return finalizeRunDir(d).latest === null && !fs.existsSync(path.join(tmp, 'latest')); })());

/* ─── migration ─── */

const dry = migrateOutput(output, { dryRun: true });
check('P. dry run plans 3 moves and moves nothing', dry.dryRun && dry.moves.length === 3 && fs.existsSync(path.join(output, 'saucedemo-automation-framework', 'run-report.json')) && fs.existsSync(path.join(output, 'saucedemo-automation-framework.zip')), JSON.stringify(dry.moves.map((m) => path.relative(output, m.to))));
const sauceMove = dry.moves.find((m) => m.from.endsWith('saucedemo-automation-framework'));
check('Q. a legacy run is dated from its report and lands under its host slug', !!sauceMove && sauceMove.projectSlug === 'saucedemo-com' && sauceMove.runId.startsWith('20260912T172840Z-') && !!sauceMove.zipFrom && sauceMove.completed, JSON.stringify(sauceMove));
const shopMove = dry.moves.find((m) => m.from.endsWith('shop-automation-framework'));
check('R. a stopped legacy run is planned as not completed', !!shopMove && shopMove.completed === false && shopMove.projectSlug === 'shop-example');

const real = migrateOutput(output);
check('S. migration moves the 3 legacy folders', real.moves.length === 3 && !fs.existsSync(path.join(output, 'saucedemo-automation-framework')) && !fs.existsSync(path.join(output, 'shop-automation-framework')));
const sauceDest = sauceMove!.to;
check('T. report, zip and run-meta sit inside the run directory', fs.existsSync(path.join(sauceDest, 'run-report.json')) && fs.existsSync(path.join(sauceDest, 'saucedemo-automation-framework.zip')) && !fs.existsSync(path.join(output, 'saucedemo-automation-framework.zip')) && readRunMeta(sauceDest)?.migratedFrom === 'saucedemo-automation-framework' && readRunMeta(sauceDest)?.source === 'cli');
check('U. checkpoint and requirements map travel with a stopped run', fs.existsSync(path.join(shopMove!.to, 'checkpoint.json')) && fs.existsSync(path.join(shopMove!.to, 'requirements-map.json')));
check('V. the inline legacy run keeps its spec file', fs.existsSync(path.join(dry.moves.find((m) => m.from.includes('uitestingplayground'))!.to, 'dynamicid.spec.ts')));
check('W. latest for saucedemo stays on the newest completed run (the layout run from 15:00 beats the migrated 09-12 run)', readLatest(path.join(output, 'saucedemo-com')) === path.basename(newerDir), readLatest(path.join(output, 'saucedemo-com')) ?? 'null');
check('X. latest for shop-example is not set (its only run is stopped)', readLatest(path.join(output, 'shop-example')) === null);
check('Y. latest for uitestingplayground points at its migrated completed run', readLatest(path.join(output, 'uitestingplayground-com')) === dry.moves.find((m) => m.from.includes('uitestingplayground'))!.runId);
const again = migrateOutput(output);
check('Z. a second migration is a no-op', again.moves.length === 0 && again.skipped.length === 0);
const after = listRunDirs(output);
check('AA. after migration every run is a layout run, none legacy, symlinks not followed', after.length === 6 && after.every((e) => !e.legacy) && new Set(after.map((e) => e.runId)).size === 6, JSON.stringify(after.map((e) => `${e.projectSlug}/${e.runId}`)));
const disk = listRunsFromDisk(root);
check('AB. listRunsFromDisk lists the 6 runs once each with run-id based ids and layout report paths', disk.length === 6 && disk.every((r) => r.id.startsWith('disk_') && RUN_ID_RE.test(r.id.slice(5)) && /^output\/[a-z0-9-]+\/\d{8}T\d{6}Z-[0-9a-f]{6}\/run-report\.json$/.test(r.reportPath)), JSON.stringify(disk.map((r) => r.reportPath)));
check('AC. the stopped run keeps status stopped with its checkpoint path in the layout', disk.some((r) => r.status === 'stopped' && r.checkpointPath === `output/shop-example/${shopMove!.runId}/checkpoint.json`));

/* ─── transcribe into a run directory ─── */

const t = runTranscribeRequest({ reportPath: path.relative(root, path.join(sauceDest, 'run-report.json')) }, root);
const files = fs.readdirSync(sauceDest).sort();
check('AD. transcribe writes the zip inside the run directory and slims it back to report files', files.includes('saucedemo-automation-framework.zip') && files.includes('run-report.json') && files.includes('run-meta.json') && !files.includes('package.json') && !files.includes('tests') && t.zip.scenarios === 2, JSON.stringify(files));
check('AE. transcribe with --out keeps the full tree there and the zip inside it', (() => { const o = path.join(tmp, 'regen'); const r = runTranscribeRequest({ reportPath: path.relative(root, path.join(sauceDest, 'run-report.json')), outDir: o }, root); return fs.existsSync(path.join(o, 'package.json')) && fs.existsSync(path.join(o, 'saucedemo-automation-framework.zip')) && r.outDir === o; })());

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} checks passed.`);
if (fail > 0) process.exit(1);
console.log('OK: every run gets its own output/<project>/<run-id> directory, latest points at the newest completed run, --out still overrides, and the legacy migration is idempotent.');
