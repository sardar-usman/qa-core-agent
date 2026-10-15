import fs from 'node:fs';
import path from 'node:path';
import type { RunReport } from './trace.js';
import { assertNoCredentialLeak, CredentialLeakError } from './credential-leak.js';
import { zipFrameworkToBuffer } from './zip-framework.js';

/**
 * Writing the framework zip, and saying only what happened (invariant 70,
 * standing rule 2). The CLI, the gateway and scripts/recheck-run.ts all go
 * through writeFrameworkZip:
 *
 *   1. the pre-zip guard (assertNoCredentialLeak): a file under
 *      playwright/.auth/ refuses the zip by its path, an env account value
 *      anywhere in the tree (or the run directory) refuses it by value;
 *   2. the zip, with RUN_ARTIFACTS and RUN_OUTPUT_DIRS excluded;
 *   3. an atomic write (temp name, rename) into the destination directory.
 *
 * A refusal is recorded on the report as `zipRefused` (the files and fields,
 * never a value); the caller rewrites the report files. Run 4b0e43 printed
 * "Wrote complete framework zip" and the "Run the framework" steps before
 * the guard refused the zip, and exited 0 with no zip on disk.
 */

export type ZipRefusal = NonNullable<RunReport['zipRefused']>;

export interface FrameworkZipOutcome {
  /** Set when the zip is on disk. */
  written?: { zipPath: string; sizeBytes: number; buffer: Buffer };
  /** Set when the guard refused the zip. */
  refused?: ZipRefusal;
  /** Set when zipping failed for another reason (the zip tool, the disk). */
  failed?: string;
}

export function writeFrameworkZip(opts: { frameworkDir: string; destDir: string; zipRootName: string; runDir?: string; report?: RunReport }): FrameworkZipOutcome {
  try {
    assertNoCredentialLeak({ frameworkDir: opts.frameworkDir, ...(opts.runDir ? { runDir: opts.runDir } : {}) });
  } catch (err) {
    if (!(err instanceof CredentialLeakError)) throw err;
    const refused: ZipRefusal = { reason: err.message, files: err.hits.map((h) => ({ file: h.file, field: h.field })) };
    if (opts.report) opts.report.zipRefused = refused;
    return { refused };
  }
  try {
    const buffer = zipFrameworkToBuffer(opts.frameworkDir, opts.zipRootName);
    const zipPath = path.join(opts.destDir, `${opts.zipRootName}.zip`);
    const tmpZip = path.join(opts.destDir, `.${opts.zipRootName}.zip.${process.pid}.tmp`);
    fs.mkdirSync(opts.destDir, { recursive: true });
    fs.writeFileSync(tmpZip, buffer);
    fs.renameSync(tmpZip, zipPath);
    if (opts.report) delete opts.report.zipRefused;
    return { written: { zipPath, sizeBytes: buffer.length, buffer } };
  } catch (err) {
    return { failed: (err as Error).message };
  }
}

/** 0 only when the zip is on disk. */
export function zipExitCode(outcome: FrameworkZipOutcome): number {
  return outcome.written ? 0 : 1;
}

/**
 * The lines about the zip. "Wrote complete framework zip" appears only when
 * it is written; a refusal prints its line (files and fields, never a value).
 */
export function zipResultLines(outcome: FrameworkZipOutcome, opts: { outDirRel: string; zipRel?: string; listing?: string[] }): string[] {
  if (outcome.written) {
    return [
      '',
      `Wrote complete framework zip to ${opts.outDirRel}/`,
      ...(opts.listing ?? []),
      `  zip:          ${opts.zipRel ?? outcome.written.zipPath} (${(outcome.written.sizeBytes / 1024).toFixed(1)} KB)`,
      '  (framework files live in the zip; the run directory keeps its own files and the zip)',
    ];
  }
  if (outcome.refused) {
    return ['', `✗ ${outcome.refused.reason}`, '  The framework zip was not written; run-report.json records the refusal (zipRefused).'];
  }
  return ['', `✗ zip not written: ${outcome.failed ?? 'unknown error'}`];
}

/** A path for a printed shell step: quoted only when it holds a character the shell would split or expand. */
function shellArg(p: string): string {
  return /^[A-Za-z0-9_./@:+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * The "Run the framework" steps: only when there is a zip to run, and
 * runnable as printed (invariant 72). The run directory holds the zip, not
 * the framework files, so the steps unzip it first (the real zip filename),
 * then cd into the folder it extracts to (the zip is rooted at
 * `<brand>-automation-framework/`, the zip's own basename, invariant 49),
 * then install and test. The old steps said "cd <run dir> && npm install",
 * which found no package.json there.
 */
export function runFrameworkLines(outcome: FrameworkZipOutcome, opts: { outDirRel: string; zipRel?: string }): string[] {
  if (!outcome.written) return [];
  const zipName = path.basename(outcome.written.zipPath);
  const rootName = zipName.replace(/\.zip$/, '');
  return [
    '',
    'Run the framework:',
    '  cd ' + shellArg(opts.outDirRel),
    '  unzip -o ' + shellArg(zipName),
    '  cd ' + shellArg(rootName),
    '  npm install',
    '  npx playwright test',
    '',
    `Or share the zip: ${opts.zipRel ?? outcome.written.zipPath}`,
  ];
}
