import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Framework zipper.
 *
 * Turns a scaffolded framework directory into either:
 *   - A `.zip` file on disk (used by the CLI path so the user can move the
 *     bundle around the filesystem), OR
 *   - A `Buffer` of zip bytes in memory (used by the WebSocket gateway path
 *     so the bytes can be base64-encoded and streamed to the UI for download).
 *
 * Implementation note: we shell out to the platform `zip` command via
 * `spawnSync` (no shell interpretation, no injection surface). This avoids
 * adding a new npm dependency for a feature we only need in one place.
 * The agent already assumes a Unix-like environment elsewhere (setup.sh,
 * gateway, playwright/.auth layout), so this is consistent.
 *
 * The `zip` flags used:
 *   -r   recurse into subdirectories
 *   -q   quiet (suppress per-file logging)
 *   -X   strip extra attributes (uid/gid/extended attrs) so the zip is
 *        reproducible across machines
 */

const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 100 MB — pathological cap, real frameworks are <1 MB

/**
 * Run-folder artifacts that never belong in a framework zip, excluded by
 * name at zip time (`zip -x`) whenever the zipped directory is a run
 * directory. The redacted run-report the scaffold writes under the framework
 * root is a different file and stays.
 */
export const RUN_ARTIFACTS: readonly string[] = ['checkpoint.json', 'events.jsonl', 'run-meta.json', 'requirements-map.json', 'rule-coverage.json', '*.zip', '*-srs.md', '*-srs.txt', '*-srs.pdf', '*-srs.docx'];

/**
 * Where to run `zip` from and what to name the archive root. By default the
 * root is the source directory's own name. A run directory is named by its
 * run id, so callers pass `rootName` (the <brand>-automation-framework name)
 * and the directory is zipped through a same-named symlink in a temporary
 * wrapper; `zip -r` follows directory symlinks, so the entries land under
 * the requested root. `cleanup` removes the wrapper.
 */
function zipRoot(srcDir: string, rootName?: string): { cwd: string; base: string; cleanup: () => void } {
  const resolved = path.resolve(srcDir);
  const base = path.basename(resolved);
  if (!rootName || rootName === base) return { cwd: path.dirname(resolved), base, cleanup: () => {} };
  if (!/^[A-Za-z0-9._-]+$/.test(rootName)) throw new Error(`zip root name must be a plain directory name (got "${rootName}")`);
  const wrapper = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-zip-'));
  fs.symlinkSync(resolved, path.join(wrapper, rootName), 'dir');
  return { cwd: wrapper, base: rootName, cleanup: () => { try { fs.rmSync(wrapper, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

export interface ZipResult {
  /** Absolute path to the .zip on disk. */
  zipPath: string;
  /** Size of the .zip in bytes. */
  sizeBytes: number;
}

/**
 * Zip a directory to disk. The resulting zip preserves the source directory
 * as its top-level folder (so unzipping it produces `srcDir-basename/...`,
 * not loose files dumped into cwd).
 */
export function zipFrameworkToFile(srcDir: string, destZipPath: string, rootName?: string): ZipResult {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error(`Source is not a directory: ${srcDir}`);
  }
  // Overwrite any pre-existing zip rather than letting `zip` append into it.
  if (fs.existsSync(destZipPath)) fs.unlinkSync(destZipPath);

  const root = zipRoot(srcDir, rootName);
  const result = spawnSync('zip', ['-rqX', path.resolve(destZipPath), root.base], { cwd: root.cwd, encoding: 'buffer' });
  root.cleanup();
  if (result.error) {
    throw new Error(
      `Failed to invoke 'zip': ${result.error.message}. ` +
      `Is the 'zip' command available on this system?`,
    );
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8') ?? '';
    throw new Error(`zip exited with code ${result.status}. stderr: ${stderr}`);
  }
  if (!fs.existsSync(destZipPath)) {
    throw new Error(`zip reported success but no file at ${destZipPath}`);
  }
  const stats = fs.statSync(destZipPath);
  return { zipPath: destZipPath, sizeBytes: stats.size };
}

/**
 * Zip a directory and return the bytes as a Buffer. Used by the gateway
 * which then base64-encodes and streams over the WebSocket.
 *
 * Throws if the result would exceed `MAX_ZIP_BYTES` — that's a sanity cap
 * against pathological inputs, real generated frameworks are well under 1 MB.
 */
export function zipFrameworkToBuffer(srcDir: string, rootName?: string, exclude: readonly string[] = RUN_ARTIFACTS): Buffer {
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    throw new Error(`Source is not a directory: ${srcDir}`);
  }
  const root = zipRoot(srcDir, rootName);

  // `zip -rqX -` writes the archive to stdout. Run-folder artifacts are excluded by name, never moved aside.
  const excludeArgs = exclude.length ? ['-x', ...exclude.map((name) => `${root.base}/${name}`)] : [];
  const result = spawnSync('zip', ['-rqX', '-', root.base, ...excludeArgs], {
    cwd: root.cwd,
    maxBuffer: MAX_ZIP_BYTES,
  });
  root.cleanup();
  if (result.error) {
    throw new Error(
      `Failed to invoke 'zip': ${result.error.message}. ` +
      `Is the 'zip' command available on this system?`,
    );
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8') ?? '';
    throw new Error(`zip exited with code ${result.status}. stderr: ${stderr}`);
  }
  if (!result.stdout || result.stdout.length === 0) {
    throw new Error('zip produced no output');
  }
  if (result.stdout.length > MAX_ZIP_BYTES) {
    throw new Error(`zip output (${result.stdout.length} bytes) exceeds MAX_ZIP_BYTES (${MAX_ZIP_BYTES})`);
  }
  return result.stdout;
}

/**
 * Convenience: zip a framework, base64-encode it, return the data URL form
 * the UI can drop into an `<a href=...>` to trigger a browser download.
 *
 * Output prefix is `data:application/zip;base64,` followed by the encoded
 * bytes. Total payload is ~33% larger than the raw zip — acceptable for
 * typical framework sizes (50–500 KB).
 */
export function zipFrameworkToDataUrl(srcDir: string): string {
  const buf = zipFrameworkToBuffer(srcDir);
  return 'data:application/zip;base64,' + buf.toString('base64');
}
