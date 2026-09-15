import 'dotenv/config';
import path from 'node:path';
import { runTranscribeRequest } from '../server/run-explore.js';

/**
 * CLI:  npm run transcribe -- <path-to-run-report.json> [--out <dir>]
 *
 * Re-emits the framework (POM + scaffold + zip) from an EXISTING run report,
 * without re-exploring. No LLM, no browser. This is a thin wrapper over
 * runTranscribeRequest, the one transcribe every surface uses (gateway,
 * dashboard Regenerate, MCP qa_transcribe): the framework is built in a
 * temporary directory and only the zip is replaced in the run directory;
 * the run's own files are never written or slimmed. With --out the full
 * emitted tree and the zip land in that directory instead.
 */

function main(): void {
  const args = process.argv.slice(2);
  let reportPath: string | undefined;
  let outDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out') outDir = args[++i];
    else if (a && !a.startsWith('--') && !reportPath) reportPath = a;
  }
  if (!reportPath) {
    console.error('Usage: npm run transcribe -- <path-to-run-report.json> [--out <dir>]');
    process.exit(1);
  }
  console.log(`▸ Transcribing ${path.relative(process.cwd(), path.resolve(reportPath))}`);
  let outcome;
  try {
    outcome = runTranscribeRequest({ reportPath, ...(outDir ? { outDir } : {}) }, process.cwd(), 'cli');
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    process.exit(1);
  }
  for (const n of outcome.notes) console.log(`  ${n}`);
  console.log(`  ${outcome.zip.scenarios} scenario(s), ${outcome.zip.fileCount} file(s) in the framework`);
  if (outDir) console.log(`\nRun it: cd ${path.relative(process.cwd(), outcome.outDir)} && npm install && npx playwright test`);
  else console.log('\nUnzip it anywhere, then: npm install && npx playwright test');
}

main();
