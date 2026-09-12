import fs from 'node:fs';
import path from 'node:path';
import { explore, type AgentEvent } from '../agent/runtime.js';
import type { RunReport } from '../agent/trace.js';
import { transcribe } from '../agent/transcriber.js';
import { scaffold, frameworkDirName, normalizeAndValidateUrl } from '../agent/scaffold.js';
import { zipFrameworkToBuffer } from '../agent/zip-framework.js';
import { buildRequirementsMap, countRules, loadSrsText, type RequirementsMap } from '../agent/requirements.js';
import { renderRuleCoverage } from '../agent/rule-coverage.js';
import { diagnoseEmptyRun, renderReconciliation } from '../agent/reconcile.js';
import { deleteCheckpoint, loadCheckpoint, resumeHintForRun, type Checkpoint } from '../agent/checkpoint.js';
import {
  applyCheckpointFlags, buildExploreOptions, outDirForRequest, resumeConflicts,
  type ExploreRequest,
} from '../agent/explore-request.js';
import { slimFrameworkDir } from '../agent/framework-dir.js';

/**
 * The explore run the gateway and the MCP server share: prepare (resume
 * checkpoint or SRS), run the pipeline, emit the framework, zip it, slim the
 * directory. It is the CLI's main() without the terminal printing, so the
 * three surfaces leave the same files behind and report the same numbers.
 * Progress goes out through callbacks; nothing here writes to stdout.
 */

export interface RunExploreInput {
  request: ExploreRequest;
  /** Where output/ lives. */
  projectRoot: string;
  /** Explorer model override (the dashboard's model chip). */
  model?: string;
  onEvent?: (e: AgentEvent) => void;
  /** Human-readable progress lines (what the CLI would print). */
  onNote?: (text: string) => void;
  /**
   * Test seam: replaces the runtime's explore(). A smoke passes a fake that
   * runs the real critic against a fixture response, so the gateway's env
   * application and report handling are exercised without a browser or a
   * model. Production callers leave it unset.
   */
  exploreImpl?: typeof explore;
}

export interface FrameworkZip {
  buffer: Buffer;
  filename: string;
  sizeBytes: number;
  fileCount: number;
  scenarios: number;
}

export interface RunExploreOutcome {
  kind: 'empty' | 'framework' | 'inline';
  report: RunReport;
  outDir: string;
  /** Relative to projectRoot, forward slashes. */
  reportPath: string;
  zip?: FrameworkZip;
  specPath?: string;
  /** Relative checkpoint path when one was kept (the run can be resumed). */
  checkpointPath?: string;
  /** The single resume hint line, when due. */
  resumeHint?: string;
  /** Summary lines (cost, replay, stability, reconciliation, rule coverage). */
  summary: string[];
  /** Empty-run diagnosis lines, when kind is 'empty'. */
  diagnosis?: string[];
}

function rel(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join('/');
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Run `fn` with the request's per-run setting overrides applied to
 * process.env, restoring the previous values afterwards. The runtime reads
 * these env names at call time, so this is how "change the ceiling for this
 * run" reaches it without a new option per setting.
 */
export async function withEnvOverrides<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) { previous.set(k, process.env[k]); process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

export interface PreparedRun {
  request: ExploreRequest;
  url: string;
  outDir: string;
  requirements?: RequirementsMap;
  resume?: Checkpoint;
  notes: string[];
}

/**
 * Everything that happens before the browser launches: URL validation,
 * checkpoint load + conflict check + reachability, SRS ingestion. Throws with
 * a user-facing message on any failure, so nothing is billed for a bad ask.
 */
export async function prepareExploreRun(input: Omit<RunExploreInput, 'onEvent' | 'onNote' | 'model'>): Promise<PreparedRun> {
  let req = input.request;
  const root = input.projectRoot;
  const notes: string[] = [];
  const base = req.outBase ? path.resolve(root, req.outBase) : path.join(root, 'output');

  if (req.fromPlan || req.review) {
    throw new Error('Review mode (--review / --from-plan) needs the CLI: it pauses for a CSV edit at the terminal.');
  }

  let resumeCp: Checkpoint | undefined;
  let url: string;
  let outDir: string;
  if (req.resume) {
    const cpFile = path.resolve(root, req.resume);
    resumeCp = loadCheckpoint(cpFile); // throws a clear message on a bad file
    let normalizedUrl: string | undefined;
    if (req.url) {
      const check = normalizeAndValidateUrl(req.url);
      if (check.ok) normalizedUrl = check.url;
    }
    const conflicts = resumeConflicts(req, resumeCp, normalizedUrl);
    if (conflicts.length > 0) throw new Error(`Cannot resume:\n${conflicts.map((c) => `  • ${c}`).join('\n')}`);
    try {
      await fetch(resumeCp.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new Error(`Cannot resume: ${resumeCp.url} is not reachable (${(err as Error).message}). Check the network and try again.`);
    }
    req = applyCheckpointFlags(req, resumeCp);
    url = resumeCp.url;
    outDir = path.dirname(cpFile);
    notes.push(`▸ Resuming ${url}`);
    notes.push(`  checkpoint: ${rel(root, cpFile)}`);
    notes.push(`  ${resumeCp.completedScenarios.length} of ${resumeCp.plan.length} scenario(s) already completed`);
  } else {
    if (!req.url) throw new Error('An entry URL is required.');
    const urlCheck = normalizeAndValidateUrl(req.url);
    if (!urlCheck.ok) throw new Error(`Couldn't run /explore: ${urlCheck.reason}. Try a full URL like https://www.saucedemo.com/`);
    if (urlCheck.normalized) notes.push(`Note: added https:// for you, using ${urlCheck.url}`);
    url = urlCheck.url;
    outDir = outDirForRequest(req, url, base, frameworkDirName, stamp);
    if (req.pom && fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
    notes.push(`▸ Exploring ${url}`);
    notes.push(req.features.length > 0 ? `  features: ${req.features.join(', ')}` : '  features: (none specified, the Planner will infer from the page)');
  }
  notes.push(`  language: ${req.lang}`);
  notes.push(`  output:   ${rel(root, outDir)}`);

  let requirements: RequirementsMap | undefined;
  if (resumeCp?.requirementsMap) {
    requirements = resumeCp.requirementsMap;
    notes.push(`  SRS: requirements map restored from the checkpoint (${requirements.features.length} feature(s))`);
  }
  if (req.srs) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('--srs needs ANTHROPIC_API_KEY set (the requirements map is built with a Haiku call).');
    const srsPath = path.resolve(root, req.srs);
    const { text, truncated } = await loadSrsText(srsPath);
    const built = await buildRequirementsMap({ srsText: text, truncated, apiKey });
    requirements = built.map;
    if (requirements.features.length === 0) {
      throw new Error(`The SRS at ${req.srs} yielded no features. Nothing to plan from; check the document.`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'requirements-map.json'), JSON.stringify(requirements, null, 2));
    notes.push(`  SRS: ${requirements.features.length} feature(s), ${countRules(requirements)} rule(s) · $${built.costUsd.toFixed(4)}${requirements.truncated ? ' · truncated at cap' : ''}`);
    if (req.features.length > 0) notes.push('  (--features wins for feature selection; the SRS rules still steer the Planner)');
  }

  return { request: req, url, outDir, ...(requirements ? { requirements } : {}), ...(resumeCp ? { resume: resumeCp } : {}), notes };
}

/** Prepare, run, emit. */
export async function runExploreRequest(input: RunExploreInput): Promise<RunExploreOutcome> {
  const root = input.projectRoot;
  const note = input.onNote ?? (() => {});
  return withEnvOverrides(input.request.env, async () => {
    const prepared = await prepareExploreRun(input);
    for (const n of prepared.notes) note(n);
    const { request: req, url, outDir } = prepared;

    const exploreFn = input.exploreImpl ?? explore;
    const result = await exploreFn({
      ...buildExploreOptions(req, {
        url, outDir,
        ...(prepared.requirements ? { requirements: prepared.requirements } : {}),
        ...(prepared.resume ? { resume: prepared.resume } : {}),
        ...(input.model ? { model: input.model } : {}),
      }),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    });

    const reportPath = rel(root, path.join(outDir, 'run-report.json'));
    if (result.paused) {
      // prepareExploreRun rejects review mode, so this cannot happen; fail loudly if it does.
      throw new Error(`Unexpected pause. Plan written to ${rel(root, result.planPath)}; resume via CLI with --from-plan.`);
    }
    const report = result;
    const cpFile = path.join(outDir, 'checkpoint.json');

    if (!report.scenarios || report.scenarios.length === 0) {
      const diag = diagnoseEmptyRun(report);
      const lines = diag ? [...diag.lines] : [];
      if (diag?.cause === 'planner-none') {
        try { if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* noop */ }
      } else {
        slimFrameworkDir(outDir);
        lines.push(`Kept ${reportPath}: full verdicts and trace, the spend is not lost.`);
      }
      lines.push(`Cost so far: $${totalCost(report).toFixed(4)}`);
      const hint = resumeHintForRun({
        ...(report.stopped ? { stopped: report.stopped } : {}),
        emptyCause: diag?.cause ?? null,
        checkpointExists: fs.existsSync(cpFile),
        cpPath: rel(root, cpFile),
      });
      return {
        kind: 'empty', report, outDir, reportPath, summary: [], diagnosis: lines,
        ...(fs.existsSync(cpFile) ? { checkpointPath: rel(root, cpFile) } : {}),
        ...(hint ? { resumeHint: hint } : {}),
      };
    }

    const summary = summarize(report);
    if (req.pom) {
      const scaffoldResult = scaffold({
        report, outDir, siteName: hostnameOf(url), features: req.features,
        ...(prepared.requirements ? { requirements: prepared.requirements } : {}),
      });
      // Checkpoint lifecycle mirrors the CLI: never inside the zip; deleted on
      // a complete run, held aside and restored on a stopped one.
      const heldCheckpoint = report.stopped && fs.existsSync(cpFile) ? fs.readFileSync(cpFile, 'utf8') : undefined;
      deleteCheckpoint(outDir);
      const zipBuf = zipFrameworkToBuffer(outDir);
      const filename = `${path.basename(outDir)}.zip`;
      fs.writeFileSync(path.join(path.dirname(outDir), filename), zipBuf);
      slimFrameworkDir(outDir);
      if (heldCheckpoint !== undefined) fs.writeFileSync(cpFile, heldCheckpoint);
      // The zip carries the redacted report; the working copy keeps raw values.
      try { fs.writeFileSync(path.join(outDir, 'run-report.json'), JSON.stringify(report, null, 2)); } catch { /* best effort */ }
      const hint = resumeHintForRun({
        ...(report.stopped ? { stopped: report.stopped } : {}),
        emptyCause: null,
        checkpointExists: fs.existsSync(cpFile),
        cpPath: rel(root, cpFile),
      });
      return {
        kind: 'framework', report, outDir, reportPath, summary,
        zip: { buffer: zipBuf, filename, sizeBytes: zipBuf.length, fileCount: scaffoldResult.fileCount, scenarios: scaffoldResult.pomResult.scenarios },
        specPath: scaffoldResult.pomResult.specFile,
        ...(heldCheckpoint !== undefined ? { checkpointPath: rel(root, cpFile) } : {}),
        ...(hint ? { resumeHint: hint } : {}),
      };
    }

    const r = transcribe({ report, outDir, name: req.name ?? path.basename(outDir) });
    if (!report.stopped) deleteCheckpoint(outDir);
    const hint = resumeHintForRun({
      ...(report.stopped ? { stopped: report.stopped } : {}),
      emptyCause: null,
      checkpointExists: fs.existsSync(cpFile),
      cpPath: rel(root, cpFile),
    });
    return {
      kind: 'inline', report, outDir, reportPath, summary, specPath: r.specPath,
      ...(fs.existsSync(cpFile) ? { checkpointPath: rel(root, cpFile) } : {}),
      ...(hint ? { resumeHint: hint } : {}),
    };
  });
}

export function totalCost(report: RunReport): number {
  return report.cost.usd + (report.cost.plannerUsd ?? 0) + (report.cost.criticUsd ?? 0);
}

/** The CLI's post-run summary lines, minus the file listing. */
export function summarize(report: RunReport): string[] {
  const out: string[] = [];
  out.push(`Cost: $${totalCost(report).toFixed(4)} total (planner $${(report.cost.plannerUsd ?? 0).toFixed(4)}, explorer $${report.cost.usd.toFixed(4)}, critic $${(report.cost.criticUsd ?? 0).toFixed(4)})`);
  if (report.review?.summary) out.push(`Critic: ${report.review.summary}`);
  if (report.replay && !report.replay.skipped) {
    const total = report.replay.passed + report.replay.failed;
    const pct = total > 0 ? Math.round((report.replay.passed / total) * 100) : 0;
    out.push(`Reality check: ${report.replay.passed}/${total} passed twice (${pct}%)`);
  }
  if (report.stability && !report.stability.skipped) {
    const total = report.stability.passed + report.stability.flaked;
    const strictStable = report.reconciliation ? report.reconciliation.stable : report.stability.passed;
    const recovered = report.reconciliation?.recovered ?? report.stability.recovered ?? 0;
    out.push(`Stability: ${strictStable}/${total} stable across ${report.stability.iterations}x${recovered > 0 ? ` (+${recovered} recovered)` : ''} · flake_rate=${(report.stability.flakeRate * 100).toFixed(1)}%`);
  }
  if (report.reconciliation) out.push(...renderReconciliation(report.reconciliation));
  if (report.ruleCoverage) out.push(...renderRuleCoverage(report.ruleCoverage));
  return out;
}

/* ─────────────────── transcribe (regenerate) ─────────────────── */

export interface TranscribeRequest {
  /** run-report.json path, relative to projectRoot or absolute. */
  reportPath: string;
  /** Output directory override. Defaults to the report's directory. */
  outDir?: string;
}

export interface TranscribeOutcome {
  report: RunReport;
  outDir: string;
  zip: FrameworkZip;
  notes: string[];
}

/**
 * Re-emit the framework from an existing run-report.json without exploring.
 * Same emission as `npm run transcribe`: scaffold + zip; a requirements map
 * next to the report is reused. The emitted tree is slimmed back to the
 * report files after zipping when it lands in an existing run directory, so
 * the dashboard's scan keeps working.
 */
export function runTranscribeRequest(req: TranscribeRequest, projectRoot: string): TranscribeOutcome {
  const resolved = path.resolve(projectRoot, req.reportPath);
  if (!fs.existsSync(resolved)) throw new Error(`Run report not found: ${req.reportPath}`);
  let report: RunReport;
  try {
    report = JSON.parse(fs.readFileSync(resolved, 'utf8')) as RunReport;
  } catch (err) {
    throw new Error(`${req.reportPath} is not valid JSON: ${(err as Error).message}`);
  }
  if (!report.url || !Array.isArray(report.scenarios) || report.scenarios.length === 0) {
    throw new Error(`${req.reportPath} does not look like a run report (needs url + a non-empty scenarios array).`);
  }
  report.language = report.language === 'js' ? 'js' : 'ts';
  const notes: string[] = [];
  let requirements: RequirementsMap | undefined;
  const mapPath = path.join(path.dirname(resolved), 'requirements-map.json');
  if (fs.existsSync(mapPath)) {
    try {
      requirements = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as RequirementsMap;
      notes.push(`requirements: restored from ${rel(projectRoot, mapPath)}`);
    } catch { /* a broken map just means no enrichment */ }
  }
  const dir = path.resolve(projectRoot, req.outDir ?? path.dirname(resolved));
  const sameDir = dir === path.dirname(resolved);
  const held = new Map<string, string>();
  if (sameDir) {
    // Keep the run's own files intact through the re-emission.
    for (const name of ['run-report.json', 'requirements-map.json', 'rule-coverage.json', 'checkpoint.json']) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) held.set(name, fs.readFileSync(p, 'utf8'));
    }
  }
  const result = scaffold({ report, outDir: dir, siteName: hostnameOf(report.url), ...(requirements ? { requirements } : {}) });
  const zipBuf = zipFrameworkToBuffer(dir);
  const filename = dir.endsWith('-automation-framework') ? `${path.basename(dir)}.zip` : `${frameworkDirName(report.url)}.zip`;
  fs.writeFileSync(path.join(path.dirname(dir), filename), zipBuf);
  if (sameDir) {
    slimFrameworkDir(dir);
    for (const [name, content] of held) fs.writeFileSync(path.join(dir, name), content);
  }
  notes.push(`Transcribed ${rel(projectRoot, resolved)}: ${report.scenarios.length} scenario(s) · ${report.language} · ${report.url}`);
  notes.push(`zip: ${rel(projectRoot, path.join(path.dirname(dir), filename))} (${(zipBuf.length / 1024).toFixed(1)} KB)`);
  return {
    report, outDir: dir, notes,
    zip: { buffer: zipBuf, filename, sizeBytes: zipBuf.length, fileCount: result.fileCount, scenarios: result.pomResult.scenarios },
  };
}
