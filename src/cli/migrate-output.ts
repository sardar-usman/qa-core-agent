import path from 'node:path';
import { migrateOutput, renderMigration } from '../agent/output-layout.js';

/**
 * CLI:  npm run migrate-output [-- --dry-run] [--root <dir>]
 *
 * One-time move of the legacy output layout (output/<brand>-automation-framework/
 * with a sibling zip, or inline output/<stamp>-<slug>/) into the per-run
 * layout output/<project-slug>/<run-id>/. One run per legacy folder, dated
 * from its run-report. Idempotent: a second run moves nothing. --dry-run
 * prints the plan and changes nothing.
 */
function main(): void {
  const args = process.argv.slice(2);
  let dryRun = false;
  let root = path.join(process.cwd(), 'output');
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--root') { const v = args[++i]; if (v) root = path.resolve(v); }
  }
  const result = migrateOutput(root, { dryRun });
  for (const line of renderMigration(result, root)) console.log(line);
}

main();
