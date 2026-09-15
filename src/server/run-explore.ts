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
import { finalizeRunDir, newRunId, writeRunMeta } from '../agent/output-layout.js';
import { appendRunEvent, appendRunNote } from './events.js';
import os from 'node:os';

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
  /** Which surface started the run; written to run-meta.json next to the report. */
  source?: 'dashboard' | 'mcp' | 'telegram' | 'cli';
  /**
   * An SRS document uploaded with the request (the dashboard's Attach SRS and
   * the Terminal page). Saved into the run directory under its original name
   * and passed to the run as --srs <that path>. Ignored on a resume (the
   * checkpoint carries the requirements map) and when --srs names a file.
   */
  srsUpload?: SrsUpload;
  /** Called once the run directory is known, before the browser launches: the run id the dashboard navigates to. */
  onPrepared?: (p: { runId: string; outDir: string; url: string; resume: boolean }) => void;
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

export interface SrsUpload { name: string; base64: string }

/** The SRS document types every surface accepts. */
export const SRS_EXTENSIONS = ['.md', '.txt', '.pdf', '.docx'] as const;
/** Upload size cap for an SRS document. */
export const SRS_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Reject an SRS upload by name or size. Returns the user-facing message, or
 * null when the file is acceptable. The same rule runs client-side in the
 * Terminal page and here on the server, so a bad file never reaches a run.
 */
export function validateSrsUpload(name: string, sizeBytes: number): string | null {
  const ext = path.extname(path.basename(name)).toLowerCase();
  if (!(SRS_EXTENSIONS as readonly string[]).includes(ext)) {
    return `Unsupported SRS type "${ext || 'none'}" for ${path.basename(name) || 'the upload'}. Allowed: ${SRS_EXTENSIONS.join(', ')}.`;
  }
  if (sizeBytes > SRS_MAX_BYTES) {
    return `The SRS ${path.basename(name)} is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB; the cap is 2 MB.`;
  }
  return null;
}

/** A safe file name for the upload: its original basename, unsafe characters replaced. */
export function srsFileName(name: string): string {
  const base = path.basename(name).replace(/[^a-z0-9._ -]+/gi, '-').replace(/^\.+/, '').slice(0, 120);
  return base || 'srs.txt';
}

/**
 * Write an uploaded SRS into the run directory under its original name.
 * Validates first (extension, size) and throws the same message the client
 * shows. Returns the absolute path of the written file.
 */
export function saveSrsUpload(outDir: string, upload: SrsUpload): string {
  const bytes = Buffer.from(upload.base64 ?? '', 'base64');
  const err = validateSrsUpload(upload.name, bytes.length);
  if (err) throw new Error(err);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, srsFileName(upload.name));
  fs.writeFileSync(file, bytes);
  return file;
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

/** The request flags worth keeping next to the report (never engine data). */
function runFlags(req: ExploreRequest): Record<string, unknown> {
  return {
    lang: req.lang, pom: req.pom, features: req.features, srs: req.srs ?? null, discover: req.discover, urls: req.urls,
    resume: req.resume ?? null, stabilize: req.stabilize, stabilizeAttempts: req.stabilizeAttempts, replay: req.replay,
    stability: req.stability, stabilityIterations: req.stabilityIterations, env: req.env,
  };
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
  /** Absolute path of the uploaded SRS saved in the run directory, when one was attached. */
  srsFile?: string;
  notes: string[];
}

/**
 * Everything that happens before the browser launches: URL validation,
 * checkpoint load + conflict check + reachability, SRS ingestion. Throws with
 * a user-facing message on any failure, so nothing is billed for a bad ask.
 */
export async function prepareExploreRun(input: Omit<RunExploreInput, 'onEvent' | 'onNote' | 'model' | 'onPrepared'>): Promise<PreparedRun> {
  let req = input.request;
  // Reject a bad upload before anything else is decided or billed.
  if (input.srsUpload) {
    const err = validateSrsUpload(input.srsUpload.name, Buffer.byteLength(input.srsUpload.base64 ?? '', 'base64'));
    if (err) throw new Error(err);
  }
  const root = input.projectRoot;
  const notes: string[] = [];
  const base = path.join(root, 'output');

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
    outDir = outDirForRequest({ ...req, ...(req.outBase ? { outBase: path.resolve(root, req.outBase) } : {}) }, url, base, newRunId());
    if (req.outBase && req.pom && fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
    notes.push(`▸ Exploring ${url}`);
    notes.push(req.features.length > 0 ? `  features: ${req.features.join(', ')}` : '  features: (none specified, the Planner will infer from the page)');
  }
  notes.push(`  language: ${req.lang}`);
  notes.push(`  output:   ${rel(root, outDir)}`);

  // An uploaded SRS lands in the run directory under its original name and
  // becomes --srs <that path>, so Run Detail lists it as an artifact.
  let srsFile: string | undefined;
  if (input.srsUpload) {
    if (resumeCp) notes.push('Note: the uploaded SRS is ignored on a resume; the checkpoint carries the requirements map.');
    else if (req.srs) notes.push(`Note: --srs ${req.srs} was given, so the uploaded SRS is ignored.`);
    else {
      srsFile = saveSrsUpload(outDir, input.srsUpload);
      req = { ...req, srs: rel(root, srsFile) };
      notes.push(`Note: using the uploaded SRS ${path.basename(srsFile)} (saved as ${rel(root, srsFile)}).`);
    }
  }

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

  return { request: req, url, outDir, ...(requirements ? { requirements } : {}), ...(resumeCp ? { resume: resumeCp } : {}), ...(srsFile ? { srsFile } : {}), notes };
}

/** Prepare, run, emit. */
export async function runExploreRequest(input: RunExploreInput): Promise<RunExploreOutcome> {
  const root = input.projectRoot;
  const note = input.onNote ?? (() => {});
  return withEnvOverrides(input.request.env, async () => {
    const prepared = await prepareExploreRun(input);
    const { request: req, url, outDir } = prepared;
    // run-meta.json is written the moment the run directory is known (source
    // and flags are known then) and rewritten at every end, so a run that
    // stops early (ceiling, billing, API failure, SIGINT) still records who
    // started it. The indexer never defaults a missing source.
    const meta = { source: input.source ?? 'dashboard', flags: runFlags(req) } as const;
    writeRunMeta(outDir, meta);
    input.onPrepared?.({ runId: path.basename(outDir), outDir, url, resume: !!prepared.resume });
    for (const n of prepared.notes) note(n);

    const exploreFn = input.exploreImpl ?? explore;
    const result = await exploreFn({
      ...buildExploreOptions(req, {
        url, outDir,
        ...(prepared.requirements ? { requirements: prepared.requirements } : {}),
        ...(prepared.resume ? { resume: prepared.resume } : {}),
        ...(input.model ? { model: input.model } : {}),
      }),
      // Every event is also appended to <runDir>/events.jsonl, the stored
      // timeline the Run Detail page renders.
      onEvent: (e: AgentEvent) => { appendRunEvent(outDir, e); input.onEvent?.(e); },
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
        // Nothing was scaffolded, so nothing is slimmed: the run folder keeps
        // every artifact it has (report, events, checkpoint, SRS copy, maps).
        writeRunMeta(outDir, meta);
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
      // The framework is scaffolded in a temporary directory named by the
      // framework and zipped from there, so the run directory's own files
      // (report, events, checkpoint, SRS copy, requirements map, rule
      // coverage, run-meta) are never held aside, deleted or slimmed. The
      // redacted report the scaffold writes lives under the framework root
      // only; the run's raw report is untouched. Only the zip lands here.
      const zipRootName = req.name ? `${req.name}-automation-framework` : frameworkDirName(url);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-emit-'));
      let scaffoldResult: ReturnType<typeof scaffold>;
      let zipBuf: Buffer;
      try {
        const frameworkDir = path.join(tmp, zipRootName);
        scaffoldResult = scaffold({
          report, outDir: frameworkDir, siteName: hostnameOf(url), features: req.features,
          ...(prepared.requirements ? { requirements: prepared.requirements } : {}),
        });
        zipBuf = zipFrameworkToBuffer(frameworkDir, zipRootName);
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      }
      const filename = `${zipRootName}.zip`;
      const tmpZip = path.join(outDir, `.${filename}.${process.pid}.tmp`);
      fs.writeFileSync(tmpZip, zipBuf);
      fs.renameSync(tmpZip, path.join(outDir, filename));
      // Checkpoint lifecycle: deleted only on a fully complete run; a stopped run keeps it for --resume.
      if (!report.stopped) deleteCheckpoint(outDir);
      writeRunMeta(outDir, meta);
      finalizeRunDir(outDir);
      const hint = resumeHintForRun({
        ...(report.stopped ? { stopped: report.stopped } : {}),
        emptyCause: null,
        checkpointExists: fs.existsSync(cpFile),
        cpPath: rel(root, cpFile),
      });
      return {
        kind: 'framework', report, outDir, reportPath, summary,
        zip: { buffer: zipBuf, filename, sizeBytes: zipBuf.length, fileCount: scaffoldResult.fileCount, scenarios: scaffoldResult.pomResult.scenarios },
        ...(fs.existsSync(cpFile) ? { checkpointPath: rel(root, cpFile) } : {}),
        ...(hint ? { resumeHint: hint } : {}),
      };
    }

    const r = transcribe({ report, outDir, name: req.name ?? frameworkDirName(url).replace(/-automation-framework$/, '') });
    if (!report.stopped) deleteCheckpoint(outDir);
    writeRunMeta(outDir, meta);
    finalizeRunDir(outDir);
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
  /** Output directory override: the full emitted tree and the zip land there. Defaults to replacing only the zip in the report's run directory. */
  outDir?: string;
}

export interface TranscribeOutcome {
  report: RunReport;
  /** Where the zip was written: the run directory, or the explicit outDir. */
  outDir: string;
  /** Absolute path of the zip written. */
  zipPath: string;
  zip: FrameworkZip;
  notes: string[];
}

/**
 * Re-emit the framework from an existing run-report.json without exploring.
 * The ONE transcribe every surface uses (CLI `npm run transcribe`, the
 * gateway's /transcribe and the dashboard's Regenerate, MCP qa_transcribe).
 *
 * The framework is scaffolded into a temporary directory named
 * <brand>-automation-framework, zipped with that name as the archive root,
 * and the zip alone is written into the run directory atomically (temp name,
 * then rename over the previous zip). The run directory's own files
 * (run-report.json, events.jsonl, run-meta.json, requirements-map.json,
 * rule-coverage.json, checkpoint.json, an SRS) are read, never written,
 * never slimmed, and never enter the zip; the redacted run-report copy the
 * scaffold ships under the framework root is the only report inside it. The
 * single write outside the zip is a `transcribe` note in events.jsonl.
 *
 * With an explicit outDir the emitted tree and the zip land there instead
 * (the CLI's --out for inspection); nothing in the run directory changes.
 */
export function runTranscribeRequest(req: TranscribeRequest, projectRoot: string, source: 'cli' | 'dashboard' | 'mcp' | 'telegram' = 'cli'): TranscribeOutcome {
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
  const runDir = path.dirname(resolved);
  let requirements: RequirementsMap | undefined;
  const mapPath = path.join(runDir, 'requirements-map.json');
  if (fs.existsSync(mapPath)) {
    try {
      requirements = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as RequirementsMap;
      notes.push(`requirements: restored from ${rel(projectRoot, mapPath)}`);
    } catch { /* a broken map just means no enrichment */ }
  }

  const rootName = frameworkDirName(report.url);
  const filename = `${rootName}.zip`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-core-transcribe-'));
  try {
    const frameworkDir = path.join(tmp, rootName);
    const result = scaffold({ report, outDir: frameworkDir, siteName: hostnameOf(report.url), ...(requirements ? { requirements } : {}) });
    const zipBuf = zipFrameworkToBuffer(frameworkDir, rootName);
    const zip: FrameworkZip = { buffer: zipBuf, filename, sizeBytes: zipBuf.length, fileCount: result.fileCount, scenarios: result.pomResult.scenarios };

    let outDir: string;
    let zipPath: string;
    if (req.outDir) {
      // An explicit destination gets the full tree for inspection plus the zip; the run directory is untouched.
      outDir = path.resolve(projectRoot, req.outDir);
      fs.mkdirSync(outDir, { recursive: true });
      fs.cpSync(frameworkDir, outDir, { recursive: true });
      zipPath = path.join(outDir, filename);
      fs.writeFileSync(zipPath, zipBuf);
    } else {
      // Replace ONLY the zip in the run directory, atomically.
      outDir = runDir;
      zipPath = path.join(runDir, filename);
      const tmpZip = path.join(runDir, `.${filename}.${process.pid}.tmp`);
      fs.writeFileSync(tmpZip, zipBuf);
      fs.renameSync(tmpZip, zipPath);
      appendRunNote(runDir, { type: 'transcribe', source });
    }
    notes.push(`Transcribed ${rel(projectRoot, resolved)}: ${report.scenarios.length} scenario(s) · ${report.language} · ${report.url}`);
    notes.push(`zip: ${rel(projectRoot, zipPath)} (${(zipBuf.length / 1024).toFixed(1)} KB, root ${rootName}/)`);
    return { report, outDir, zipPath, zip, notes };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
