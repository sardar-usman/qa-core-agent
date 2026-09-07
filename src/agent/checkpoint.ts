import fs from 'node:fs';
import path from 'node:path';
import type { PlannedScenario } from './planner.js';
import type { RequirementsMap } from './requirements.js';
import type { RunReport, Scenario } from './trace.js';
import type { ScenarioVerdict } from './critic.js';
import type { EmptyRunCause } from './reconcile.js';
import { scenarioNameKey } from './rule-coverage.js';

/**
 * Crash-safe checkpoint/resume.
 *
 * The run writes checkpoint.json into the output directory after every
 * completed scenario and at each phase boundary (discovery done, plan done,
 * explorer done). Writing is atomic (temp file + rename), so a crash mid-write
 * can never corrupt the previous checkpoint. The file is deleted only on
 * fully successful completion (framework written); any abnormal end keeps it,
 * and the user resumes with:
 *
 *   npm run explore -- --resume <outDir>/checkpoint.json
 *
 * A resumed run restores flags, discovery, the requirements map, the plan,
 * every completed trace, and the itemized spend, then continues the Explorer
 * on the scenarios that were never completed, under the same total ceiling
 * accounting (the ceiling read at resume time may be higher; spend carries
 * over).
 */

export const CHECKPOINT_VERSION = 1;
export const CHECKPOINT_FILENAME = 'checkpoint.json';

export type CheckpointPhase = 'discovery' | 'planning' | 'exploring' | 'explored' | 'reviewing';

export interface CheckpointSpend {
  planner: number;
  explorer: number;
  critic: number;
  repair: number;
}

export interface Checkpoint {
  version: typeof CHECKPOINT_VERSION;
  url: string;
  flags: {
    lang: 'ts' | 'js';
    pom: boolean;
    features: string[];
    srs?: string;
    discover: boolean;
    urls: string[];
  };
  discovery?: RunReport['discovery'];
  requirementsMap?: RequirementsMap;
  plan: PlannedScenario[];
  /** Form-control count from the snapshot, so the resumed step budget matches. */
  fillableFields: number;
  /** Full traces of every scenario completed so far. */
  completedScenarios: Scenario[];
  /**
   * Critic verdicts from the original run, when the run got that far. A
   * resume carries these instead of re-reviewing the same scenarios, so the
   * critic is never billed twice for the same trace.
   */
  verdicts?: ScenarioVerdict[];
  spentUsd: CheckpointSpend;
  phase: CheckpointPhase;
  /** completedScenarios.length, as an index into plan (for the resume banner). */
  nextScenarioIndex: number;
  startedAt: string;
  updatedAt: string;
}

/** Canonical checkpoint location for a run output directory. */
export function checkpointPath(outDir: string): string {
  return path.join(outDir, CHECKPOINT_FILENAME);
}

/**
 * Atomic write: serialize to a temp file in the same directory, then rename.
 * rename(2) is atomic on the same filesystem, so a reader never sees a
 * half-written checkpoint and a crash mid-write leaves the previous one
 * intact. Returns the checkpoint path.
 */
export function writeCheckpoint(outDir: string, cp: Checkpoint): string {
  fs.mkdirSync(outDir, { recursive: true });
  const target = checkpointPath(outDir);
  const tmp = path.join(outDir, `.${CHECKPOINT_FILENAME}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(cp, null, 2));
  fs.renameSync(tmp, target);
  return target;
}

/** Delete the checkpoint (fully successful completion). Missing file is fine. */
export function deleteCheckpoint(outDir: string): void {
  try { fs.rmSync(checkpointPath(outDir), { force: true }); } catch { /* best effort */ }
  try { fs.rmSync(path.join(outDir, `.${CHECKPOINT_FILENAME}.tmp`), { force: true }); } catch { /* ditto */ }
}

/**
 * Load and validate a checkpoint file. Throws with a plain-English reason on
 * a missing file, unparseable JSON, an unsupported version, or a shape that
 * cannot be resumed.
 */
export function loadCheckpoint(file: string): Checkpoint {
  if (!fs.existsSync(file)) {
    throw new Error(`Checkpoint not found: ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Checkpoint is not valid JSON (${(err as Error).message}): ${file}`);
  }
  const cp = raw as Partial<Checkpoint>;
  if (cp.version !== CHECKPOINT_VERSION) {
    throw new Error(`Checkpoint version ${String(cp.version)} is not supported (expected ${CHECKPOINT_VERSION}): ${file}`);
  }
  if (typeof cp.url !== 'string' || !cp.url) {
    throw new Error(`Checkpoint has no url: ${file}`);
  }
  if (!Array.isArray(cp.plan)) {
    throw new Error(`Checkpoint has no plan array: ${file}`);
  }
  if (!Array.isArray(cp.completedScenarios)) {
    throw new Error(`Checkpoint has no completedScenarios array: ${file}`);
  }
  if (typeof cp.flags !== 'object' || cp.flags === null) {
    throw new Error(`Checkpoint has no flags: ${file}`);
  }
  const spend = cp.spentUsd ?? { planner: 0, explorer: 0, critic: 0, repair: 0 };
  return {
    version: CHECKPOINT_VERSION,
    url: cp.url,
    flags: {
      lang: cp.flags.lang === 'js' ? 'js' : 'ts',
      pom: cp.flags.pom !== false,
      features: Array.isArray(cp.flags.features) ? cp.flags.features : [],
      ...(cp.flags.srs ? { srs: cp.flags.srs } : {}),
      discover: cp.flags.discover === true,
      urls: Array.isArray(cp.flags.urls) ? cp.flags.urls : [],
    },
    ...(cp.discovery ? { discovery: cp.discovery } : {}),
    ...(cp.requirementsMap ? { requirementsMap: cp.requirementsMap } : {}),
    plan: cp.plan,
    fillableFields: typeof cp.fillableFields === 'number' ? cp.fillableFields : 0,
    completedScenarios: cp.completedScenarios,
    ...(Array.isArray(cp.verdicts) ? { verdicts: cp.verdicts } : {}),
    spentUsd: {
      planner: Number(spend.planner) || 0,
      explorer: Number(spend.explorer) || 0,
      critic: Number(spend.critic) || 0,
      repair: Number(spend.repair) || 0,
    },
    phase: (cp.phase as CheckpointPhase) ?? 'exploring',
    nextScenarioIndex: typeof cp.nextScenarioIndex === 'number' ? cp.nextScenarioIndex : cp.completedScenarios.length,
    startedAt: typeof cp.startedAt === 'string' ? cp.startedAt : new Date().toISOString(),
    updatedAt: typeof cp.updatedAt === 'string' ? cp.updatedAt : new Date().toISOString(),
  };
}

/**
 * The planned scenarios a resumed run still has to explore: everything the
 * completed traces do not account for. Matching tolerates the Explorer's
 * small rephrasings, the same treatment attachRuleIds and the salvage path
 * use.
 */
export function remainingPlan(plan: PlannedScenario[], completed: Array<{ name: string }>): PlannedScenario[] {
  const doneKeys = completed.map((s) => scenarioNameKey(s.name)).filter((k) => k.length > 0);
  return plan.filter((p) => {
    const k = scenarioNameKey(p.name);
    if (!k) return false;
    return !doneKeys.some((d) => d === k || d.includes(k) || k.includes(d));
  });
}

/** Total prior spend across every itemized bucket. */
export function priorSpend(spend: CheckpointSpend): number {
  return spend.planner + spend.explorer + spend.critic + spend.repair;
}

/** The one message printed on every clean stop that leaves a checkpoint behind. */
export function stopMessage(reason: string, cpPath: string): string {
  return `Run stopped: ${reason}. State saved. Resume with: npm run explore -- --resume ${cpPath}`;
}

/**
 * The SINGLE resume hint the CLI prints as the LAST line of an abnormal end,
 * or null when no hint is due (no checkpoint on disk, or a planner-none run
 * where there is nothing to resume). Every abnormal end that retains a
 * checkpoint gets exactly one hint: an explicit stop (ceiling / billing /
 * api), or an empty pipeline outcome (explorer-none / critic-gated-all /
 * replay-dropped-all). The CLI suppresses any mid-run "Run stopped:" event
 * text and prints only this, so the hint is always exactly once and always
 * last. Pure and exported so smoke-checkpoint locks every branch.
 */
export function resumeHintForRun(opts: {
  stopped?: { kind: string; reason: string };
  emptyCause?: EmptyRunCause | null;
  checkpointExists: boolean;
  cpPath: string;
}): string | null {
  if (!opts.checkpointExists) return null;
  if (opts.stopped) return stopMessage(opts.stopped.reason, opts.cpPath);
  switch (opts.emptyCause) {
    case 'critic-gated-all':
      return stopMessage('the critic gated every recorded scenario (traces and verdicts are in the checkpoint)', opts.cpPath);
    case 'replay-dropped-all':
      return stopMessage('replay/stability dropped every survivor', opts.cpPath);
    case 'explorer-none':
      return stopMessage('the explorer recorded no scenarios', opts.cpPath);
    default:
      return null;
  }
}

/** How an error at an Anthropic call site should end the run. */
export interface StopClassification {
  kind: 'billing' | 'api' | 'other';
  reason: string;
}

const BILLING_RE = /credit balance|insufficient credit|insufficient_quota|billing|purchase (more )?credits|payment required|plans & billing/i;
const API_RE = /overloaded|rate.?limit|too many requests|connection (error|refused|reset)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|internal server error|service unavailable|api_error/i;
const API_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Classify an error thrown by an Anthropic call site. 'billing' (credit
 * exhaustion) and 'api' (persistent API failure, surfacing means the SDK's
 * own retries are exhausted) end the run CLEANLY: completed work is salvaged,
 * the checkpoint is written, and the resume hint prints. 'other' is a real
 * bug and still throws.
 */
export function classifyRunError(err: unknown): StopClassification {
  const e = err as { message?: string; status?: number; error?: { error?: { type?: string; message?: string } } };
  const message = [
    e?.message ?? '',
    e?.error?.error?.type ?? '',
    e?.error?.error?.message ?? '',
  ].join(' ');
  if (BILLING_RE.test(message)) {
    return { kind: 'billing', reason: `billing/credit exhaustion (${firstLine(e?.message) || 'credit balance too low'})` };
  }
  if ((typeof e?.status === 'number' && API_STATUSES.has(e.status)) || API_RE.test(message)) {
    return { kind: 'api', reason: `persistent API failure (${firstLine(e?.message) || `HTTP ${e?.status}`})` };
  }
  return { kind: 'other', reason: firstLine(e?.message) || 'unknown error' };
}

function firstLine(s: string | undefined): string {
  return (s ?? '').split('\n')[0]?.trim() ?? '';
}
