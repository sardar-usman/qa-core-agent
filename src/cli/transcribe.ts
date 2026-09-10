import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { scaffold, frameworkDirName } from '../agent/scaffold.js';
import { zipFrameworkToFile } from '../agent/zip-framework.js';
import type { RunReport } from '../agent/trace.js';
import type { RequirementsMap } from '../agent/requirements.js';

/**
 * CLI:  npm run transcribe -- <path-to-run-report.json> [--out <dir>]
 *
 * Re-emits the framework (POM + scaffold + zip) from an EXISTING run report,
 * without re-exploring. No LLM, no browser: the same emission the explore CLI
 * runs after the pipeline, for regenerating a deliverable after emitter fixes
 * or inspecting what a past run would produce today.
 *
 * When a requirements-map.json sits next to the report (SRS runs), it is
 * loaded so dataset enrichment matches the original run. The output directory
 * defaults to the report's own directory; unlike /explore, nothing is wiped
 * or slimmed, so the emitted tree stays on disk for inspection alongside the
 * zip.
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
  const resolved = path.resolve(reportPath);
  if (!fs.existsSync(resolved)) {
    console.error(`✗ Run report not found: ${resolved}`);
    process.exit(1);
  }
  let report: RunReport;
  try {
    report = JSON.parse(fs.readFileSync(resolved, 'utf8')) as RunReport;
  } catch (err) {
    console.error(`✗ ${resolved} is not valid JSON: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!report.url || !Array.isArray(report.scenarios) || report.scenarios.length === 0) {
    console.error(`✗ ${resolved} does not look like a run report (needs url + a non-empty scenarios array).`);
    process.exit(1);
  }
  report.language = report.language === 'js' ? 'js' : 'ts';

  // SRS runs keep their map next to the report; reuse it for dataset parity.
  let requirements: RequirementsMap | undefined;
  const mapPath = path.join(path.dirname(resolved), 'requirements-map.json');
  if (fs.existsSync(mapPath)) {
    try {
      requirements = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as RequirementsMap;
      console.log(`  requirements: restored from ${path.relative(process.cwd(), mapPath)}`);
    } catch { /* a broken map just means no enrichment */ }
  }

  const dir = path.resolve(outDir ?? path.dirname(resolved));
  const siteName = (() => { try { return new URL(report.url).hostname; } catch { return report.url; } })();
  console.log(`▸ Transcribing ${path.relative(process.cwd(), resolved)}`);
  console.log(`  ${report.scenarios.length} scenario(s) · ${report.language} · ${report.url}`);
  console.log(`  output: ${path.relative(process.cwd(), dir)}`);

  const result = scaffold({
    report,
    outDir: dir,
    siteName,
    ...(requirements ? { requirements } : {}),
  });
  console.log(`\nWrote ${result.fileCount} file(s):`);
  console.log(`  pages/  ${result.pomResult.pageFiles.length} page object(s)`);
  console.log(`  tests/  ${result.pomResult.specFiles.length} spec(s) + a11y`);
  if (result.pomResult.dataFiles.length > 0) {
    console.log(`  data/   ${result.pomResult.dataFiles.map((f) => path.basename(f)).join(', ')}`);
  }

  const zipPath = dir.endsWith('-automation-framework') ? `${dir}.zip` : path.join(path.dirname(dir), `${frameworkDirName(report.url)}.zip`);
  const { sizeBytes } = zipFrameworkToFile(dir, zipPath);
  console.log(`  zip:    ${path.relative(process.cwd(), zipPath)} (${(sizeBytes / 1024).toFixed(1)} KB)`);
  console.log(`\nRun it: cd ${path.relative(process.cwd(), dir)} && npm install && npx playwright test`);
}

main();
