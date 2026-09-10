import fs from 'node:fs';
import path from 'node:path';

/**
 * Files that survive slimming a framework directory after its zip is
 * written: the run report the dashboard scans, the SRS artefacts, and a
 * checkpoint when the run stopped early. Everything else lives in the zip.
 */
export const SLIM_KEEP = ['run-report.json', 'requirements-map.json', 'rule-coverage.json', 'checkpoint.json'];

/**
 * Replace the on-disk framework directory with a stub holding only the
 * SLIM_KEEP files. The zip is the deliverable; the directory stays as a
 * tombstone so the run-history scan still recognises the run. Shared by the
 * CLI, the gateway and the MCP server so every surface leaves the same
 * footprint.
 */
export function slimFrameworkDir(dir: string): void {
  const kept: Array<{ name: string; content: string }> = [];
  for (const name of SLIM_KEEP) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    try { kept.push({ name, content: fs.readFileSync(p, 'utf8') }); } catch { /* skip */ }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  if (kept.length > 0) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of kept) fs.writeFileSync(path.join(dir, f.name), f.content);
  }
}
