import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { explore, type ReviewPaused } from '../agent/runtime.js';
import { transcribe } from '../agent/transcriber.js';
import { scaffold, frameworkDirName, normalizeAndValidateUrl } from '../agent/scaffold.js';
import { zipFrameworkToBuffer } from '../agent/zip-framework.js';
import { buildRequirementsMap, countRules, loadSrsText, type RequirementsMap } from '../agent/requirements.js';
import { renderRuleCoverage } from '../agent/rule-coverage.js';
import { readCsv } from '../agent/csv.js';
import { diagnoseEmptyRun, renderReconciliation } from '../agent/reconcile.js';
import { deleteCheckpoint, loadCheckpoint, markCheckpointPhase, resumeHintForRun, type Checkpoint } from '../agent/checkpoint.js';
import { emittedCheckStage, writeReportFiles } from '../agent/emitted-check.js';
import type { PlannedScenario } from '../agent/planner.js';
import {
  applyCheckpointFlags, buildExploreOptions, outDirForRequest, parseExploreArgv, resumeConflicts, slugUrl,
  type ExploreRequest,
} from '../agent/explore-request.js';
import os from 'node:os';
import { finalizeRunDir, newRunId, writeRunMeta } from '../agent/output-layout.js';
import { appendRunEvent } from '../server/events.js';

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
    console.error('                          [--stabilize-attempts N]');
    console.error('  npm run explore -- --resume <checkpoint.json>   (continue an interrupted run)');
    console.error('  npm run explore -- --from-plan <plan.csv> [--lang ts|js] [--name foo] [--no-pom]');
    console.error('                                            [--no-replay] [--no-stability] [--stability N]');
    console.error('                                            [--no-stabilize] [--stabilize-attempts N]');
    console.error('');
    console.error('  --no-stabilize          Skip Stage 5b. Flaky scenarios always drop.');
    console.error('  --stabilize-attempts N  Max Stabilizer fix attempts per flaky scenario (default 3).');
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

  // SRS ingestion — all of it happens BEFORE the browser launches, so a bad
  // document or an empty map fails fast and free. A resumed run restores the
  // map from the checkpoint instead of rebuilding it (no Haiku call).
  let requirements: RequirementsMap | undefined;
  if (resumeCp?.requirementsMap) {
    requirements = resumeCp.requirementsMap;
    console.log(`  SRS: requirements map restored from the checkpoint (${requirements.features.length} feature(s))`);
  }
  if (args.srs) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('✗ --srs needs ANTHROPIC_API_KEY set (the requirements map is built with a Haiku call).');
      process.exit(1);
    }
    const { text, truncated } = await loadSrsText(args.srs);
    const built = await buildRequirementsMap({ srsText: text, truncated, apiKey });
    requirements = built.map;
    if (requirements.features.length === 0) {
      console.error(`✗ The SRS at ${args.srs} yielded no features. Nothing to plan from — check the document.`);
      process.exit(1);
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'requirements-map.json'), JSON.stringify(requirements, null, 2));
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
  const result = await explore({
    ...buildExploreOptions(args, {
      url, outDir,
      ...(requirements ? { requirements } : {}),
      ...(resumeCp ? { resume: resumeCp } : {}),
      ...(fromPlan ? { fromPlan } : {}),
    }),
    onEvent: (e) => {
      // The stored timeline for the Run Detail page, next to the report.
      appendRunEvent(outDir, e);
      switch (e.type) {
        case 'plan_started':
          console.log(`\n[1/${totalStages}] Planner …`); break;
        case 'plan_done':
          console.log(`      ${e.scenarios.length} scenarios planned · $${e.usd.toFixed(4)}`);
          for (const s of e.scenarios) {
            console.log(`        · [${s.category}] ${s.name}`);
          }
          console.log(`\n[2/${totalStages}] Explorer …`);
          break;
        case 'thinking_started':
          process.stdout.write('      · thinking…\r'); break;
        case 'tool_call':
          console.log(`      → ${e.name}(${trimJson(e.input)})`); break;
        case 'tool_result':
          if (!e.ok) console.log(`        ✗ ${e.error}`); break;
        case 'message':
          // Resume hints are printed exactly once, as the LAST line of output
          // (see resumeHintForRun at the end of main). The mid-run copies the
          // runtime emits for the gateway are suppressed here; without this,
          // the 240-char cap below also silently ate them, which is how two
          // live ceiling runs ended with no hint at all.
          if (e.text.startsWith('Run stopped:')) break;
          if (e.text.length < 240) console.log(`      ${e.text.trim()}`); break;
        case 'usage':
          process.stdout.write(`      $${e.usd.toFixed(4)} · ${e.tokens} tok\r`); break;
        case 'critic_started':
          console.log(`\n[3/${totalStages}] Critic …`); break;
        case 'critic_done':
          console.log(`      ${e.verdicts.length} verdicts · $${e.usd.toFixed(4)}`);
          for (const v of e.verdicts) {
            const mark = v.verdict === 'pass' ? '✓' : v.verdict === 'rework' ? '!' : '✗';
            console.log(`        ${mark} ${v.scenario}: ${v.reasons.join('; ')}`);
          }
          break;
        case 'replay_started':
          console.log(`\n[4/${totalStages}] Reality check · replaying ${e.total} scenario(s) headlessly …`); break;
        case 'replay_scenario_passed':
          console.log(`      ✓ ${e.name}  (${e.durationMs}ms)`); break;
        case 'replay_scenario_failed':
          console.log(`      ✗ ${e.name}  (step ${e.failedStep + 1} ${e.stepKind}: ${truncate(e.error, 120)})`); break;
        case 'replay_done':
          console.log(`      ${e.passed} passed · ${e.failed} dropped · ${(e.durationMs / 1000).toFixed(1)}s`); break;
        case 'stability_started': {
          const stage = args.replay ? 5 : 4;
          console.log(`\n[${stage}/${totalStages}] Stability · ${e.iterations}× re-run on ${e.total} survivor(s) …`);
          break;
        }
        case 'stability_iteration_passed':
          console.log(`      ✓ ${e.name}  iter ${e.iteration}  (${e.durationMs}ms)`); break;
        case 'stability_iteration_failed':
          console.log(`      ✗ ${e.name}  iter ${e.iteration} (step ${e.failedStep + 1} ${e.stepKind}: ${truncate(e.error, 120)})`); break;
        case 'stability_done': {
          const recovered = e.recovered ?? 0;
          const recoveredChip = recovered > 0 ? ` · ${recovered} recovered by Stabilizer` : '';
          const stabilizerCost = e.stabilizerCostUsd ?? 0;
          const stabilizerCostChip = stabilizerCost > 0 ? ` · stabilizer $${stabilizerCost.toFixed(4)}` : '';
          console.log(
            `      ${e.stable} stable${recoveredChip} · ${e.flaked} flaked · flake_rate=${(e.flakeRate * 100).toFixed(1)}% · ` +
            `${(e.durationMs / 1000).toFixed(1)}s${stabilizerCostChip}`,
          );
          break;
        }
        case 'gate_injection':
          console.log(`      [gate] ${e.detail} in "${e.scenario}"`); break;
        case 'gate_broken':
          console.log(`      [gate] BROKEN "${e.scenario}" after ${e.attempts} attempt(s): ${e.reason}`); break;
        case 'heal':
          console.log(`      ↺ healed: ${e.from} re-resolved to ${e.to} (${e.intent})`); break;
        case 'review_paused':
          console.log(`\n■ Paused for review.`); break;
        case 'done':
          // This is the Explorer's count. The final emitted (generated) count
          // and the planned = generated + dropped reconciliation print below.
          console.log(`\n✓ ${e.scenarios} scenario(s) explored`); break;
      }
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
    const totalUsd = result.cost.usd + (result.cost.plannerUsd ?? 0) + (result.cost.criticUsd ?? 0);
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
    writeReportFiles(outDir, result);
    if (!result.stopped) markCheckpointPhase(outDir, 'emitted');
    const cpFile = path.join(outDir, 'checkpoint.json');
    primaryPath = path.join(outDir, path.relative(frameworkDir, scaffoldResult.pomResult.specFile));
    scenarios = scaffoldResult.pomResult.scenarios;
    const features = scaffoldResult.pomResult.features;
    const specCount = scaffoldResult.pomResult.specFiles.length;
    console.log(`\nWrote complete framework zip to ${path.relative(process.cwd(), outDir)}/`);
    console.log(`  pages/        ${scaffoldResult.pomResult.pageFiles.length} page object class(es) (one per feature + BasePage)`);
    if (features.length > 0) {
      console.log(`  tests/        ${specCount} spec file(s) across feature folder(s): ${features.map((f) => `tests/${f}/`).join(', ')}`);
    } else {
      console.log(`  tests/        ${specCount} spec file(s)`);
    }
    console.log(`                ${scenarios} scenarios total`);
    console.log(`  tests/a11y/   ${path.basename(scaffoldResult.pomResult.a11yFile)}`);
    console.log(`  scaffold:     package.json, playwright.config.ts, tsconfig.json, README.md, .gitignore, .env.example`);
    console.log(`  fixtures:     credentials.ts`);
    console.log(`  helpers:      assertions.ts`);
    // Zip the framework alongside the directory for easy distribution.
    // After the zip is in place, slim the directory to just run-report.json
    // so the on-disk footprint is the zip (the deliverable) plus a tiny
    // tombstone that keeps the dashboard's run-history scan working.
    try {
      // The zip lives INSIDE the run directory, next to run-report.json, so a
      // run's files stay together; it is written atomically (temp name, rename).
      const zipBuf = zipFrameworkToBuffer(frameworkDir, zipRootName);
      const zipPath = path.join(outDir, `${zipRootName}.zip`);
      const tmpZip = path.join(outDir, `.${zipRootName}.zip.${process.pid}.tmp`);
      fs.writeFileSync(tmpZip, zipBuf);
      fs.renameSync(tmpZip, zipPath);
      frameworkZipPath = zipPath;
      console.log(`  zip:          ${path.relative(process.cwd(), zipPath)} (${(zipBuf.length / 1024).toFixed(1)} KB)`);
      console.log(`  (framework files live in the zip; the run directory keeps its own files and the zip)`);
    } catch (err) {
      console.log(`  zip:          skipped, ${(err as Error).message}`);
    } finally {
      try { fs.rmSync(emitTmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    // Checkpoint lifecycle: deleted only on a fully complete run; a stopped run keeps it for --resume.
    if (result.stopped && fs.existsSync(cpFile)) console.log(`  checkpoint:   kept at ${path.relative(process.cwd(), cpFile)} (run stopped early: ${result.stopped.reason})`);
    else deleteCheckpoint(outDir);
    writeRunMeta(outDir, { source: 'cli', flags: runFlags(args) });
    const fin = finalizeRunDir(outDir);
    if (fin.latest) console.log(`  latest:       ${path.relative(process.cwd(), path.join(path.dirname(outDir), 'latest'))} -> ${path.basename(outDir)}`);
  } else {
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
  const totalUsd = result.cost.usd + (result.cost.plannerUsd ?? 0) + (result.cost.criticUsd ?? 0);
  console.log(`Cost: $${totalUsd.toFixed(4)} total ` +
    `(planner $${(result.cost.plannerUsd ?? 0).toFixed(4)}, ` +
    `explorer $${result.cost.usd.toFixed(4)}, ` +
    `critic $${(result.cost.criticUsd ?? 0).toFixed(4)}) · ` +
    `cache_read=${result.cost.cacheReadTokens}`);
  console.log(`Cascade: ${JSON.stringify(result.cascadeStats)}`);
  if (result.review?.summary) {
    console.log(`\nCritic: ${result.review.summary}`);
  }
  if (result.replay && !result.replay.skipped) {
    const total = result.replay.passed + result.replay.failed;
    const pct = total > 0 ? Math.round((result.replay.passed / total) * 100) : 0;
    console.log(`Reality check: ${result.replay.passed}/${total} passed twice (${pct}%) · ${(result.replay.durationMs / 1000).toFixed(1)}s`);
  } else if (result.replay?.skipped) {
    console.log('Reality check: skipped (--no-replay)');
  }
  if (result.stability && !result.stability.skipped) {
    const total = result.stability.passed + result.stability.flaked;
    const pct = (result.stability.flakeRate * 100).toFixed(1);
    // Headline uses strict stable (excludes recovered) when reconciliation is
    // present, so a relaxed-rule survivor is never counted as a clean pass.
    const strictStable = result.reconciliation ? result.reconciliation.stable : result.stability.passed;
    const recovered = result.reconciliation?.recovered ?? result.stability.recovered ?? 0;
    const recoveredNote = recovered > 0 ? ` (+${recovered} recovered)` : '';
    console.log(`Stability:     ${strictStable}/${total} stable across ${result.stability.iterations}×${recoveredNote} · flake_rate=${pct}% · ${(result.stability.durationMs / 1000).toFixed(1)}s`);
  } else if (result.stability?.skipped) {
    console.log('Stability:     skipped (--no-stability)');
  }
  if (result.reconciliation) {
    console.log('');
    for (const line of renderReconciliation(result.reconciliation)) console.log(line);
  }
  if (result.ruleCoverage) {
    console.log('');
    for (const line of renderRuleCoverage(result.ruleCoverage)) console.log(line);
  }
  // v3: the new framework workflow is "cd into it and use it as a project".
  // For backward compat with --no-pom, still show the single-file command.
  if (args.pom) {
    console.log('\nRun the framework:');
    console.log('  cd ' + path.relative(process.cwd(), outDir));
    console.log('  npm install');
    console.log('  npx playwright test');
    if (frameworkZipPath) {
      console.log(`\nOr share the zip: ${path.relative(process.cwd(), frameworkZipPath)}`);
    }
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

function trimJson(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

main().catch((err) => {
  console.error('\n✗ Exploration failed:', err.message);
  process.exit(1);
});
