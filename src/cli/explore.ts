import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { explore, type ReviewPaused } from '../agent/runtime.js';
import { transcribe } from '../agent/transcriber.js';
import { scaffold, frameworkDirName, normalizeAndValidateUrl } from '../agent/scaffold.js';
import { runFrameworkLines, writeFrameworkZip, zipExitCode, zipResultLines, type FrameworkZipOutcome } from '../agent/framework-zip.js';
import { countRules, requirementsMapForSrs, type RequirementsMap } from '../agent/requirements.js';
import { readCsv } from '../agent/csv.js';
import { diagnoseEmptyRun } from '../agent/reconcile.js';
import { totalCost } from '../agent/cost-total.js';
import { createEventRenderer, ruleCoverageLines, runSummaryLines } from './render.js';
import { deleteCheckpoint, loadCheckpoint, markCheckpointPhase, resumeHintForRun, type Checkpoint } from '../agent/checkpoint.js';
import { emittedCheckStage, writeReportFiles } from '../agent/emitted-check.js';
import type { PlannedScenario } from '../agent/planner.js';
import {
  applyCheckpointFlags, buildExploreOptions, outDirForRequest, parseExploreArgv, resumeConflicts, slugUrl,
  type ExploreRequest,
} from '../agent/explore-request.js';
import os from 'node:os';
import { finalizeRunDir, newRunId, projectSlug, writeRunMeta } from '../agent/output-layout.js';
import { appendRunEvent } from '../server/events.js';
import { maskForDisk } from '../agent/credential-leak.js';
import { postRunLockoutCheck, preflightStopReport, runLoginPreflightGate, writePreflightStopReport } from '../agent/login-preflight.js';
import { retiredAuthEnvLine } from '../agent/test-credentials.js';

/**
 * CLI:  npm run explore -- <url> [--lang ts|js] [--name <basename>] [--out <dir>]
 *
 * Drives the tool-use loop against <url>, then transcribes the verified trace
 * into a Playwright spec under output/<run-id>/.
 *
 * Flag parsing lives in src/agent/explore-request.ts, shared with the gateway
 * and the MCP server so every surface accepts the same options.
 */

function parseArgs(argv: string[]): ExploreRequest {
  const result = parseExploreArgv(argv.slice(2));
  if (!result.ok) {
    console.error(`✗ ${result.error}`);
    process.exit(1);
  }
  const parsed = result.request;
  if (!parsed.url && !parsed.fromPlan && !parsed.resume) {
    console.error('Usage:');
    console.error('  npm run explore -- <url> [--lang ts|js] [--name foo] [--out dir] [--review]');
    console.error('                          [--features login,cart] [--srs requirements.md] [--discover]');
    console.error('                          [--urls /login,/cart] [--no-pom] [--no-replay]');
    console.error('                          [--no-stability] [--stability N] [--no-stabilize]');
    console.error('                          [--stabilize-attempts N] [--login-url <url or path>]');
    console.error('  npm run explore -- --resume <checkpoint.json>   (continue an interrupted run)');
    console.error('  npm run explore -- --from-plan <plan.csv> [--lang ts|js] [--name foo] [--no-pom]');
    console.error('                                            [--no-replay] [--no-stability] [--stability N]');
    console.error('                                            [--no-stabilize] [--stabilize-attempts N]');
    console.error('');
    console.error('  --no-stabilize          Skip Stage 5b. Flaky scenarios always drop.');
    console.error('  --stabilize-attempts N  Max Stabilizer fix attempts per flaky scenario (default 3).');
    console.error('  --login-url URL         The login page the test-account preflight tries first.');
    console.error('  --ceiling USD           Per-run QA_CORE_COST_CEILING (also --repair-reserve, --max-steps,');
    console.error('                          --planner-model, --explorer-model, --critic-model, --env NAME=VALUE).');
    process.exit(1);
  }
  return parsed;
}

interface ParsedPlanFile {
  url: string;
  scenarios: PlannedScenario[];
}

function readPlanFile(planPath: string): ParsedPlanFile {
  if (!fs.existsSync(planPath)) {
    console.error(`✗ Plan file not found: ${planPath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(planPath, 'utf8');

  // Pull the URL from the comment header the writer emits.
  const urlMatch = raw.match(/^#\s*QA-Core review plan for\s+(\S+)/m);
  const url = urlMatch?.[1] ?? '';
  if (!url) {
    console.error(`✗ Could not read the original URL from ${planPath}.`);
    console.error(`  The file's header should start with: # QA-Core review plan for <url>`);
    process.exit(1);
  }

  // Strip comment lines so the CSV reader only sees data.
  const csvText = raw.split('\n').filter((l) => !l.startsWith('#')).join('\n');
  const rows = readCsv(csvText);
  const approved = rows
    .filter((r) => /^(y|yes|true|1)$/i.test((r['Approve'] ?? '').trim()))
    .map((r): PlannedScenario => ({
      name: r['Scenario'] ?? '',
      category: (r['Category'] as PlannedScenario['category']) ?? 'happy',
      rationale: r['Rationale'] ?? '',
      ...(r['Page'] && r['Page'].trim() ? { pageUrl: r['Page'].trim() } : {}),
    }))
    .filter((s) => s.name.length > 0);

  if (approved.length === 0) {
    console.error(`✗ No scenarios approved in ${planPath}. Set Approve=yes on at least one row.`);
    process.exit(1);
  }
  return { url, scenarios: approved };
}

/** The request flags worth keeping next to the report (never engine data). */
function runFlags(req: ExploreRequest): Record<string, unknown> {
  return {
    lang: req.lang, pom: req.pom, features: req.features, srs: req.srs ?? null, discover: req.discover, urls: req.urls,
    resume: req.resume ?? null, stabilize: req.stabilize, stabilizeAttempts: req.stabilizeAttempts, replay: req.replay,
    stability: req.stability, stabilityIterations: req.stabilityIterations, emittedCheck: req.emittedCheck, env: req.env,
    loginUrl: req.loginUrl ?? null,
  };
}

async function main(): Promise<void> {
  let args = parseArgs(process.argv);
  const base = path.join(process.cwd(), 'output');

  // Per-run setting overrides (--ceiling, --planner-model, --env ...) are
  // applied through the same env names the runtime reads.
  for (const [name, value] of Object.entries(args.env)) process.env[name] = value;

  // Checkpoint resume (--resume): load, check conflicts, restore flags.
  let resumeCp: Checkpoint | undefined;
  if (args.resume) {
    try {
      resumeCp = loadCheckpoint(args.resume);
    } catch (err) {
      console.error(`✗ ${(err as Error).message}`);
      process.exit(1);
    }
    let normalizedUrl: string | undefined;
    if (args.url) {
      const check = normalizeAndValidateUrl(args.url);
      if (check.ok) normalizedUrl = check.url;
    }
    const conflicts = resumeConflicts(args, resumeCp, normalizedUrl);
    if (conflicts.length > 0) {
      console.error('✗ Cannot resume:');
      for (const c of conflicts) console.error(`  • ${c}`);
      process.exit(1);
    }
    // Reachability: a resume against a URL that no longer answers should fail
    // fast and free, before any model call.
    try {
      await fetch(resumeCp.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      console.error(`✗ Cannot resume: ${resumeCp.url} is not reachable (${(err as Error).message}). Check the network and try again.`);
      process.exit(1);
    }
    args = applyCheckpointFlags(args, resumeCp);
  }

  // Resolve URL + scenarios depending on mode (review-resume vs fresh).
  let url: string;
  let fromPlan: PlannedScenario[] | undefined;
  let outDir: string;
  if (resumeCp) {
    url = resumeCp.url;
    // The run continues in the directory the checkpoint lives in, so the
    // report, the checkpoint, and the eventual framework stay together.
    // Nothing is wiped: the checkpoint IS the state we are resuming.
    outDir = path.dirname(path.resolve(args.resume!));
    console.log(`▸ Resuming ${url}`);
    console.log(`  checkpoint: ${path.relative(process.cwd(), path.resolve(args.resume!))}`);
    console.log(`  ${resumeCp.completedScenarios.length} of ${resumeCp.plan.length} scenario(s) already completed`);
  } else if (args.fromPlan) {
    const parsed = readPlanFile(args.fromPlan);
    url = parsed.url;
    fromPlan = parsed.scenarios;
    // Keep the run alongside the plan file so the spec and the plan stay together.
    outDir = path.dirname(path.resolve(args.fromPlan));
    console.log(`▸ Resuming from plan: ${path.relative(process.cwd(), args.fromPlan)}`);
    console.log(`  ${parsed.scenarios.length} approved scenarios for ${url}`);
  } else {
    // Validate the URL BEFORE doing anything else. Stops "--", "(ts)" and
    // similar garbage from reaching the Planner, where they'd produce an
    // empty framework + a real bill.
    const urlCheck = normalizeAndValidateUrl(args.url!);
    if (!urlCheck.ok) {
      console.error(`✗ Couldn't run /explore: ${urlCheck.reason}.`);
      console.error('  Try a full URL like: npm run explore -- https://www.saucedemo.com/');
      process.exit(1);
    }
    if (urlCheck.normalized) {
      console.log(`  Note: added https:// for you — using ${urlCheck.url}`);
    }
    url = urlCheck.url;
    // Per-run layout: output/<project-slug>/<run-id>/. A run never overwrites
    // another; --out is an explicit whole-directory override. An explicit
    // --out that already holds a framework is wiped so stale POM files from a
    // previous emission do not linger.
    outDir = outDirForRequest(args, url, base, newRunId());
    if (args.outBase && args.pom && fs.existsSync(outDir)) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    console.log(`▸ Exploring ${url}`);
    if (args.features.length > 0) {
      console.log(`  features: ${args.features.join(', ')}`);
    } else {
      console.log(`  features: (none specified — Planner will infer from homepage)`);
    }
    if (args.review) console.log('  mode: review (pause after Planner)');
  }
  console.log(`  language: ${args.lang}`);
  console.log(`  output:   ${path.relative(process.cwd(), outDir)}`);
  console.log('');
  // run-meta.json at run start (source and flags are known now) and again at
  // every end, so a run that stops early still records who started it.
  writeRunMeta(outDir, { source: 'cli', flags: runFlags(args) });

  // The test account (invariant 70): which variables hold it (names only),
  // and does it sign in? Runs BEFORE the requirements map and the Planner, so
  // a failure costs nothing. A failed preflight leaves a minimal stopped
  // run-report and run-meta (the dashboard lists the run) and nothing else.
  const retired = retiredAuthEnvLine(process.env);
  if (retired) console.log(`  ${retired}`);
  const gate = await runLoginPreflightGate({ url, ...(args.loginUrl ? { loginUrl: args.loginUrl } : {}), log: (line) => console.log(`  ${line}`) });
  if (gate.stopLine) {
    if (!resumeCp) {
      writePreflightStopReport(outDir, preflightStopReport({ url, language: args.lang, line: gate.stopLine, startedAt: new Date().toISOString() }));
      writeRunMeta(outDir, { source: 'cli', flags: runFlags(args) });
    }
    console.error('');
    console.error(gate.stopLine);
    process.exit(1);
  }

  // SRS ingestion — all of it happens BEFORE the browser launches, so a bad
  // document or an empty map fails fast and free. A resumed run restores the
  // map from the checkpoint instead of rebuilding it (no Haiku call).
  let requirements: RequirementsMap | undefined;
  // What the map cost this run: the build cost, 0 when reused from the cache
  // or when there is no SRS, and on a resume the checkpoint's recorded value
  // (undefined on an older checkpoint: the report then leaves the key off).
  let requirementsUsd: number | undefined = 0;
  if (resumeCp?.requirementsMap) {
    requirements = resumeCp.requirementsMap;
    requirementsUsd = resumeCp.spentUsd.requirements;
    console.log(`  SRS: requirements map restored from the checkpoint (${requirements.features.length} feature(s))`);
  }
  if (args.srs) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('✗ --srs needs ANTHROPIC_API_KEY set (the requirements map is built with a Haiku call).');
      process.exit(1);
    }
    // One map per SRS content hash, cached under output/<slug>/srs/<hash>/:
    // the same bytes always plan from the same map (invariant 26).
    const built = await requirementsMapForSrs({ srsPath: args.srs, outputRoot: base, slug: projectSlug(url), rebuild: args.rebuildSrsMap, apiKey });
    requirements = built.map;
    requirementsUsd = built.costUsd;
    console.log(`  ${built.line}`);
    if (requirements.features.length === 0) {
      console.error(`✗ The SRS at ${args.srs} yielded no features. Nothing to plan from — check the document.`);
      process.exit(1);
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'requirements-map.json'), JSON.stringify(maskForDisk(requirements), null, 2));
    console.log(
      `  SRS: ${requirements.features.length} feature(s), ${countRules(requirements)} rule(s) · $${built.costUsd.toFixed(4)}` +
      `${requirements.truncated ? ' · truncated at cap' : ''}`,
    );
    if (args.features.length > 0) {
      console.log('  (--features wins for feature selection; the SRS rules still steer the Planner)');
    }
    console.log('');
  }

  const specName = args.name ?? slugUrl(url);

  const totalStages = 3 + (args.replay ? 1 : 0) + (args.stability ? 1 : 0);
  const renderEvent = createEventRenderer({
    totalStages,
    replay: args.replay,
    log: (line) => console.log(line),
    inline: (text) => process.stdout.write(text),
  });
  const result = await explore({
    ...buildExploreOptions(args, {
      url, outDir,
      ...(requirements ? { requirements } : {}),
      ...(requirementsUsd !== undefined ? { requirementsUsd } : {}),
      ...(resumeCp ? { resume: resumeCp } : {}),
      ...(fromPlan ? { fromPlan } : {}),
      loginPreflightDone: true,
      ...(gate.accountSkipReason ? { accountSkipReason: gate.accountSkipReason } : {}),
    }),
    onEvent: (e) => {
      // The stored timeline for the Run Detail page, next to the report.
      appendRunEvent(outDir, e);
      // The console: the renderer prints every message whole or cut at the
      // cap with a marker, never drops one (invariant 72).
      renderEvent(e);
    },
  });

  // Review mode: Explorer never ran. Print resume instructions and stop.
  if (isPaused(result)) {
    console.log('');
    console.log(`Wrote ${path.relative(process.cwd(), result.planPath)} (${result.scenarios.length} scenarios)`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Open the CSV in Excel / Numbers / Sheets / a text editor.');
    console.log('  2. Set Approve=no on any scenarios you want to skip.');
    console.log('  3. Resume:');
    console.log(`       npm run explore -- --from-plan ${path.relative(process.cwd(), result.planPath)}`);
    return;
  }

  // Empty-framework guard. If 0 scenarios came back (Planner couldn't reach
  // the page, Explorer ran out of useful actions, etc.), don't scaffold a
  // placeholder framework — that's how we ended up writing "0 scenarios, 11
  // files" to disk on a bad URL. Bail with a clear message.
  if (!result.scenarios || result.scenarios.length === 0) {
    // Wrong-password submits may have been spent before the funnel emptied.
    await postRunLockoutCheck({ report: result, ...(gate.loginUrl ? { loginUrl: gate.loginUrl } : {}), log: (line) => { console.log(line); appendRunEvent(outDir, { type: 'message', text: line }); } });
    if (result.lockoutWarning) writeReportFiles(outDir, result);
    const totalUsd = totalCost(result);
    console.error('');
    console.error('✗ No framework was written — 0 scenarios survived the pipeline.');
    // Cause-specific diagnosis: the report knows exactly where the funnel
    // emptied (planner / explorer / critic / replay). Never guess "the
    // Planner couldn't reach the URL" when the page was in fact explored.
    const diag = diagnoseEmptyRun(result);
    if (diag) {
      for (const line of diag.lines) console.error(`  ${line}`);
    }
    // The spend is never a total loss: run-report.json (full verdicts, plan,
    // findings, trace) was already written by the runtime. Keep it. Only a
    // run that never planned anything has nothing worth keeping.
    if (diag?.cause === 'planner-none') {
      try { if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* noop */ }
    } else {
      // Nothing was scaffolded, so nothing is slimmed: every artifact the run left stays (report, events, checkpoint, SRS copy, maps).
      writeRunMeta(outDir, { source: 'cli', flags: runFlags(args) });
      console.error(`  Kept ${path.relative(process.cwd(), path.join(outDir, 'run-report.json'))}: full verdicts and trace, the spend is not lost.`);
    }
    console.error(`  Cost so far: $${totalUsd.toFixed(4)}`);
    // The one rule coverage print of an empty run, from the final report.
    for (const line of ruleCoverageLines(result)) console.error(line);
    // The one resume hint, always the LAST line of an abnormal end that
    // retains a checkpoint (critic-gated-all, replay-dropped-all, and any
    // explicit stop the report carries).
    const guardHint = resumeHintForRun({
      ...(result.stopped ? { stopped: result.stopped } : {}),
      emptyCause: diag?.cause ?? null,
      checkpointExists: fs.existsSync(path.join(outDir, 'checkpoint.json')),
      cpPath: path.relative(process.cwd(), path.join(outDir, 'checkpoint.json')),
    });
    if (guardHint) console.error(guardHint);
    process.exit(2);
  }

  let primaryPath: string;
  let scenarios: number;
  let frameworkZipPath: string | undefined;
  let zipOutcome: FrameworkZipOutcome | undefined;
  if (args.pom) {
    // v3: scaffold emits the full project (package.json, configs, README, etc.)
    // and calls pom.ts internally for pages/tests/a11y. Then we zip it.
    // The framework is scaffolded in a temporary directory named by the
    // framework and zipped from there: the run directory's own files (report,
    // events, checkpoint, SRS copy, maps, run-meta) are never held aside,
    // deleted or slimmed; only the zip lands next to them.
    const zipRootName = args.name ? `${args.name}-automation-framework` : frameworkDirName(url);
    const emitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-emit-'));
    const frameworkDir = path.join(emitTmp, zipRootName);
    const scaffoldOpts = { outDir: frameworkDir, siteName: hostnameOf(url), features: args.features, ...(requirements ? { requirements } : {}) };
    let scaffoldResult = scaffold({ report: result, ...scaffoldOpts });
    // Emitted-spec check: the written framework runs once with Playwright
    // against the live site before the zip. A test that fails twice is
    // dropped and named (emitted_failed); the report files are rewritten
    // and the checkpoint reaches its last phase boundary. A stopped run
    // does not run the stage.
    await emittedCheckStage({
      report: result,
      frameworkDir,
      ...(requirements ? { requirements } : {}),
      skip: !args.emittedCheck,
      rescaffold: (r) => { scaffoldResult = scaffold({ report: r, ...scaffoldOpts }); },
      log: (line) => { console.log(line); appendRunEvent(outDir, { type: 'message', text: line }); },
    });
    // After the last stage that submits: does the account still sign in?
    await postRunLockoutCheck({ report: result, ...(gate.loginUrl ? { loginUrl: gate.loginUrl } : {}), log: (line) => { console.log(line); appendRunEvent(outDir, { type: 'message', text: line }); } });
    writeReportFiles(outDir, result);
    if (!result.stopped) markCheckpointPhase(outDir, 'emitted');
    const cpFile = path.join(outDir, 'checkpoint.json');
    primaryPath = path.join(outDir, path.relative(frameworkDir, scaffoldResult.pomResult.specFile));
    scenarios = scaffoldResult.pomResult.scenarios;
    const features = scaffoldResult.pomResult.features;
    const specCount = scaffoldResult.pomResult.specFiles.length;
    // The listing the zip holds; printed only once the zip is on disk.
    const listing = [
      `  pages/        ${scaffoldResult.pomResult.pageFiles.length} page object class(es) (one per feature + BasePage)`,
      features.length > 0
        ? `  tests/        ${specCount} spec file(s) across feature folder(s): ${features.map((f) => `tests/${f}/`).join(', ')}`
        : `  tests/        ${specCount} spec file(s)`,
      `                ${scenarios} scenarios total`,
      `  tests/a11y/   ${path.basename(scaffoldResult.pomResult.a11yFile)}`,
      `  scaffold:     package.json, playwright.config.ts, tsconfig.json, README.md, .gitignore, .env.example`,
      `  fixtures:     credentials.ts`,
      `  helpers:      assertions.ts`,
    ];
    // The zip lives INSIDE the run directory, next to run-report.json, written
    // atomically. No test-account value and no session file ships (invariant
    // 70): the guard refuses the zip, the refusal is recorded on the report,
    // and nothing claims a zip that is not on disk.
    try {
      zipOutcome = writeFrameworkZip({ frameworkDir, destDir: outDir, zipRootName, runDir: outDir, report: result });
    } finally {
      try { fs.rmSync(emitTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (zipOutcome.refused) {
      writeReportFiles(outDir, result);
      appendRunEvent(outDir, { type: 'message', text: zipOutcome.refused.reason });
    }
    if (zipOutcome.written) frameworkZipPath = zipOutcome.written.zipPath;
    const zipLines = zipResultLines(zipOutcome, { outDirRel: path.relative(process.cwd(), outDir), zipRel: frameworkZipPath ? path.relative(process.cwd(), frameworkZipPath) : undefined, listing });
    for (const line of zipLines) (zipOutcome.written ? console.log : console.error)(line);
    process.exitCode = zipExitCode(zipOutcome);
    // Checkpoint lifecycle: deleted only on a fully complete run; a stopped run keeps it for --resume.
    if (result.stopped && fs.existsSync(cpFile)) console.log(`  checkpoint:   kept at ${path.relative(process.cwd(), cpFile)} (run stopped early: ${result.stopped.reason})`);
    else deleteCheckpoint(outDir);
    writeRunMeta(outDir, { source: 'cli', flags: runFlags(args) });
    const fin = finalizeRunDir(outDir);
    if (fin.latest) console.log(`  latest:       ${path.relative(process.cwd(), path.join(path.dirname(outDir), 'latest'))} -> ${path.basename(outDir)}`);
  } else {
    await postRunLockoutCheck({ report: result, ...(gate.loginUrl ? { loginUrl: gate.loginUrl } : {}), log: (line) => { console.log(line); appendRunEvent(outDir, { type: 'message', text: line }); } });
    if (result.lockoutWarning) writeReportFiles(outDir, result);
    const r = transcribe({ report: result, outDir, name: specName });
    primaryPath = r.specPath;
    scenarios = r.scenarios;
    console.log(`\nWrote ${path.relative(process.cwd(), r.specPath)} (${scenarios} scenarios)`);
    if (result.stopped) {
      const cpFile = path.join(outDir, 'checkpoint.json');
      console.log(`Checkpoint kept at ${path.relative(process.cwd(), cpFile)} (run stopped early: ${result.stopped.reason})`);
    } else {
      deleteCheckpoint(outDir);
    }
    writeRunMeta(outDir, { source: 'cli', flags: runFlags(args) });
    finalizeRunDir(outDir);
  }
  // The end-of-run summary from the FINAL report, after the emitted-spec
  // check: the closing Critic paragraph from the final verdicts and the one
  // rule coverage print (invariant 72).
  for (const line of runSummaryLines(result)) console.log(line);
  // v3: the new framework workflow is "cd into it and use it as a project".
  // For backward compat with --no-pom, still show the single-file command.
  if (args.pom) {
    // Only when the zip is on disk: a refused or failed zip has nothing to run.
    for (const line of runFrameworkLines(zipOutcome ?? {}, { outDirRel: path.relative(process.cwd(), outDir), zipRel: frameworkZipPath ? path.relative(process.cwd(), frameworkZipPath) : undefined })) console.log(line);
  } else {
    console.log('\nRun: npx playwright test ' + path.relative(process.cwd(), primaryPath));
  }

  // The one resume hint, always the LAST line when the run stopped early
  // (ceiling, billing, api). The framework above still shipped with whatever
  // completed; the checkpoint continues the rest.
  const finalCpPath = path.join(outDir, 'checkpoint.json');
  const finalHint = resumeHintForRun({
    ...(result.stopped ? { stopped: result.stopped } : {}),
    emptyCause: null,
    checkpointExists: fs.existsSync(finalCpPath),
    cpPath: path.relative(process.cwd(), finalCpPath),
  });
  if (finalHint) {
    console.log('');
    console.log(finalHint);
  }
}

/** Hostname of a URL, falling back to the raw URL if parsing fails. */
function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function isPaused(r: { paused?: boolean }): r is ReviewPaused {
  return r.paused === true;
}

main().catch((err) => {
  console.error('\n✗ Exploration failed:', err.message);
  process.exit(1);
});
