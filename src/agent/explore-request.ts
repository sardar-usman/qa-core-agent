import path from 'node:path';
import type { ExploreOptions } from './runtime.js';
import type { Checkpoint } from './checkpoint.js';
import type { RequirementsMap } from './requirements.js';
import type { PlannedScenario } from './planner.js';
import { parseCommaSeparated } from './parse-features.js';

/**
 * The ONE description of an explore run, shared by every surface.
 *
 * The CLI (`npm run explore -- ...`), the gateway (`/explore ...` typed in the
 * dashboard) and the MCP server (`qa_explore` tool arguments) each parse
 * their own input shape into an ExploreRequest, then hand it to
 * `buildExploreOptions` to get the ExploreOptions the runtime receives. So a
 * flag added here is reachable from all three, and the parity smoke can
 * compare the objects without a live run.
 */
export interface ExploreRequest {
  /** Entry URL. Absent only for --resume / --from-plan. */
  url?: string;
  lang: 'ts' | 'js';
  /** Emit the POM framework (true) or a single inline spec (false). */
  pom: boolean;
  /** Feature names from --features. Empty: the Planner infers. */
  features: string[];
  /** SRS document path (.md/.txt/.pdf/.docx). */
  srs?: string;
  /** Multi-page discovery. Also activated by urls or srs. */
  discover: boolean;
  /** Explicit page list from --urls. */
  urls: string[];
  /** checkpoint.json path to resume from. */
  resume?: string;
  /** Reality-check replay pass. */
  replay: boolean;
  /** Stability iteration. */
  stability: boolean;
  stabilityIterations: number;
  /** Stage 5b Stabilizer. */
  stabilize: boolean;
  stabilizeAttempts: number;
  /** Review mode: pause after the Planner and write plan.csv. CLI only. */
  review: boolean;
  /** Resume from a reviewed plan.csv. CLI only. */
  fromPlan?: string;
  /** Output basename override (--name). */
  name?: string;
  /** Output root override (--out). */
  outBase?: string;
  /** True when --lang was passed explicitly (resume conflict detection). */
  langProvided: boolean;
  /** True when --pom / --no-pom / --inline was passed explicitly. */
  pomProvided: boolean;
  /**
   * Per-run overrides of the env-driven settings, keyed by the SAME env
   * names the runtime reads (QA_CORE_COST_CEILING, ...). Only names in
   * RUN_ENV_SETTINGS are accepted; anything else is rejected at parse time.
   */
  env: Record<string, string>;
}

/** Env-driven settings a run may override, with their defaults. */
export const RUN_ENV_SETTINGS: ReadonlyArray<{ name: string; label: string; defaultValue: string; flag: string }> = [
  { name: 'QA_CORE_COST_CEILING', label: 'Cost ceiling (USD)', defaultValue: '2.00', flag: '--ceiling' },
  { name: 'QA_CORE_REPAIR_RESERVE', label: 'Repair reserve (fraction)', defaultValue: '0.15', flag: '--repair-reserve' },
  { name: 'QA_CORE_MAX_STEPS', label: 'Max explorer steps', defaultValue: '40', flag: '--max-steps' },
  { name: 'QA_CORE_PLANNER_MODEL', label: 'Planner model', defaultValue: 'claude-haiku-4-5', flag: '--planner-model' },
  { name: 'QA_CORE_EXPLORER_MODEL', label: 'Explorer model', defaultValue: 'claude-opus-4-7', flag: '--explorer-model' },
  { name: 'QA_CORE_CRITIC_MODEL', label: 'Critic model', defaultValue: 'claude-sonnet-4-6', flag: '--critic-model' },
];

const ENV_NAMES = new Set(RUN_ENV_SETTINGS.map((s) => s.name));
const FLAG_TO_ENV = new Map(RUN_ENV_SETTINGS.map((s) => [s.flag, s.name]));

/** Older env names still honored by the runtime, mapped to the documented one. */
const LEGACY_ENV: Record<string, string> = {
  QA_CORE_MAX_USD: 'QA_CORE_COST_CEILING',
  QA_CORE_MODEL_PLANNER: 'QA_CORE_PLANNER_MODEL',
  QA_CORE_MODEL_EXPLORE: 'QA_CORE_EXPLORER_MODEL',
  QA_CORE_MODEL_CRITIC: 'QA_CORE_CRITIC_MODEL',
};

/** Current effective value of each overridable setting (env or default). */
export function readRunSettings(env: NodeJS.ProcessEnv = process.env): Array<{ name: string; label: string; value: string; fromEnv: boolean }> {
  return RUN_ENV_SETTINGS.map((s) => {
    const legacy = Object.entries(LEGACY_ENV).find(([, canon]) => canon === s.name)?.[0];
    const raw = env[s.name] ?? (legacy ? env[legacy] : undefined);
    return { name: s.name, label: s.label, value: raw ?? s.defaultValue, fromEnv: raw !== undefined };
  });
}

/** Validate one override. Returns an error string or null. */
export function validateEnvOverride(name: string, value: string): string | null {
  if (!ENV_NAMES.has(name)) return `${name} is not a per-run setting (allowed: ${[...ENV_NAMES].join(', ')})`;
  if (name === 'QA_CORE_COST_CEILING') {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return `QA_CORE_COST_CEILING must be a positive number of USD (got "${value}")`;
  } else if (name === 'QA_CORE_REPAIR_RESERVE') {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n >= 1) return `QA_CORE_REPAIR_RESERVE must be a fraction in [0, 1) (got "${value}")`;
  } else if (name === 'QA_CORE_MAX_STEPS') {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return `QA_CORE_MAX_STEPS must be a positive integer (got "${value}")`;
  } else if (!/^[a-z0-9][a-z0-9.-]*$/i.test(value)) {
    return `${name} must be a model id (got "${value}")`;
  }
  return null;
}

/**
 * Every explore flag the CLI accepts, with its reach on the other surfaces.
 * `mcp` names the qa_explore / qa_resume argument (null when the flag has no
 * MCP form); `gateway` says whether `/explore` accepts it in the dashboard.
 * The parity smoke walks this table, so a flag added to the parser without a
 * row here fails the build.
 */
export const EXPLORE_FLAGS: ReadonlyArray<{ flag: string; takesValue: boolean; mcp: string | null; gateway: boolean; note?: string }> = [
  { flag: '--lang', takesValue: true, mcp: 'language', gateway: true },
  { flag: '--features', takesValue: true, mcp: 'features', gateway: true },
  { flag: '--srs', takesValue: true, mcp: 'srs', gateway: true },
  { flag: '--urls', takesValue: true, mcp: 'urls', gateway: true },
  { flag: '--discover', takesValue: false, mcp: 'discover', gateway: true },
  { flag: '--pom', takesValue: false, mcp: 'pom', gateway: true },
  { flag: '--no-pom', takesValue: false, mcp: 'pom', gateway: true },
  { flag: '--inline', takesValue: false, mcp: 'pom', gateway: true },
  { flag: '--resume', takesValue: true, mcp: 'checkpointPath', gateway: true },
  { flag: '--name', takesValue: true, mcp: 'name', gateway: true },
  { flag: '--replay', takesValue: false, mcp: 'replay', gateway: true },
  { flag: '--no-replay', takesValue: false, mcp: 'replay', gateway: true },
  { flag: '--stability', takesValue: true, mcp: 'stabilityIterations', gateway: true },
  { flag: '--no-stability', takesValue: false, mcp: 'stability', gateway: true },
  { flag: '--stabilize', takesValue: false, mcp: 'stabilize', gateway: true },
  { flag: '--no-stabilize', takesValue: false, mcp: 'stabilize', gateway: true },
  { flag: '--stabilize-attempts', takesValue: true, mcp: 'stabilizeAttempts', gateway: true },
  { flag: '--ceiling', takesValue: true, mcp: 'ceilingUsd', gateway: true },
  { flag: '--repair-reserve', takesValue: true, mcp: 'repairReserve', gateway: true },
  { flag: '--max-steps', takesValue: true, mcp: 'maxSteps', gateway: true },
  { flag: '--planner-model', takesValue: true, mcp: 'plannerModel', gateway: true },
  { flag: '--explorer-model', takesValue: true, mcp: 'explorerModel', gateway: true },
  { flag: '--critic-model', takesValue: true, mcp: 'criticModel', gateway: true },
  { flag: '--env', takesValue: true, mcp: null, gateway: true, note: 'generic NAME=VALUE form of the setting flags above; MCP exposes each setting as a typed argument instead' },
  { flag: '--out', takesValue: true, mcp: null, gateway: false, note: 'output root; the dashboard scans output/ and the MCP server uses QA_CORE_PROJECT_ROOT, so a custom root would hide the run from both' },
  { flag: '--review', takesValue: false, mcp: null, gateway: false, note: 'pauses for a CSV edit at the terminal; no plan-editing UI exists on the other surfaces' },
  { flag: '--from-plan', takesValue: true, mcp: null, gateway: false, note: 'the resume half of --review' },
];

/** Defaults every surface starts from. */
export function defaultExploreRequest(): ExploreRequest {
  return {
    lang: 'ts',
    pom: true,
    features: [],
    discover: false,
    urls: [],
    replay: true,
    stability: true,
    stabilityIterations: 3,
    stabilize: true,
    stabilizeAttempts: 3,
    review: false,
    langProvided: false,
    pomProvided: false,
    env: {},
  };
}

export type ParseRequestResult =
  | { ok: true; request: ExploreRequest; positional: string[] }
  | { ok: false; error: string };

/**
 * Walk a token list (argv after the script name, or a tokenized chat
 * command) into an ExploreRequest. Every explore flag lives here and only
 * here. Unknown `--flags` are an error (a typo must not silently become part
 * of a natural-language hint); bare tokens are returned as `positional` for
 * the caller (the CLI takes the first as the URL and ignores the rest; the
 * gateway takes the first as the URL and the rest as a natural-language
 * feature hint).
 */
export function parseExploreTokens(tokens: string[]): ParseRequestResult {
  const req = defaultExploreRequest();
  const positional: string[] = [];
  const need = (flag: string, i: number): string | undefined => {
    const v = tokens[i + 1];
    return v !== undefined && !v.startsWith('--') ? v : undefined;
  };
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i]!;
    if (!a.startsWith('--')) { positional.push(a); continue; }
    switch (a) {
      case '--lang': {
        const v = need(a, i);
        if (v !== 'ts' && v !== 'js') return { ok: false, error: '--lang expects ts or js' };
        req.lang = v; req.langProvided = true; i++; break;
      }
      case '--name': { const v = need(a, i); if (!v) return { ok: false, error: '--name expects a value' }; req.name = v; i++; break; }
      case '--out': { const v = need(a, i); if (!v) return { ok: false, error: '--out expects a directory' }; req.outBase = v; i++; break; }
      case '--review': req.review = true; break;
      case '--from-plan': { const v = need(a, i); if (!v) return { ok: false, error: '--from-plan expects a plan.csv path' }; req.fromPlan = v; i++; break; }
      case '--no-pom': case '--inline': req.pom = false; req.pomProvided = true; break;
      case '--pom': req.pom = true; req.pomProvided = true; break;
      case '--resume': { const v = need(a, i); if (!v) return { ok: false, error: '--resume expects a checkpoint.json path' }; req.resume = v; i++; break; }
      case '--no-replay': req.replay = false; break;
      case '--replay': req.replay = true; break;
      case '--no-stability': req.stability = false; break;
      case '--stability': {
        const n = Number(need(a, i));
        if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--stability expects a positive integer (got "${tokens[i + 1] ?? ''}")` };
        req.stabilityIterations = n; i++; break;
      }
      case '--no-stabilize': req.stabilize = false; break;
      case '--stabilize': req.stabilize = true; break;
      case '--stabilize-attempts': {
        const n = Number(need(a, i));
        if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--stabilize-attempts expects a positive integer (got "${tokens[i + 1] ?? ''}")` };
        req.stabilizeAttempts = n; i++; break;
      }
      case '--features': {
        const v = need(a, i);
        if (!v) return { ok: false, error: '--features expects a comma-separated value (e.g. --features login,cart,checkout)' };
        req.features = parseCommaSeparated(v); i++; break;
      }
      case '--discover': req.discover = true; break;
      case '--urls': {
        const v = need(a, i);
        if (!v) return { ok: false, error: '--urls expects a comma-separated list of page URLs' };
        req.urls = v.split(',').map((s) => s.trim()).filter(Boolean); i++; break;
      }
      case '--srs': {
        const v = need(a, i);
        if (!v) return { ok: false, error: '--srs expects a file path (.md, .txt, .pdf, or .docx)' };
        req.srs = v; i++; break;
      }
      case '--env': {
        const v = need(a, i);
        const eq = v?.indexOf('=') ?? -1;
        if (!v || eq <= 0) return { ok: false, error: '--env expects NAME=VALUE' };
        const name = v.slice(0, eq);
        const value = v.slice(eq + 1);
        const err = validateEnvOverride(name, value);
        if (err) return { ok: false, error: err };
        req.env[name] = value; i++; break;
      }
      default: {
        const envName = FLAG_TO_ENV.get(a);
        if (envName) {
          const v = need(a, i);
          if (!v) return { ok: false, error: `${a} expects a value` };
          const err = validateEnvOverride(envName, v);
          if (err) return { ok: false, error: err };
          req.env[envName] = v; i++; break;
        }
        return { ok: false, error: `Unknown flag ${a}` };
      }
    }
  }
  return { ok: true, request: req, positional };
}

/** CLI entry: argv after the script name. The first bare token is the URL. */
export function parseExploreArgv(args: string[]): ParseRequestResult {
  const r = parseExploreTokens(args);
  if (!r.ok) return r;
  const url = r.positional[0];
  if (url) r.request.url = url;
  return r;
}

/**
 * Conflicts between explicit flags and a loaded checkpoint. The checkpoint
 * is the truth for a resumed run; a flag that contradicts it is an error,
 * never a silent override. Pure so every surface reports the same list.
 */
export function resumeConflicts(req: ExploreRequest, cp: Checkpoint, normalizedUrl?: string): string[] {
  const out: string[] = [];
  if (normalizedUrl && normalizedUrl !== cp.url) out.push(`URL ${normalizedUrl} conflicts with the checkpoint's ${cp.url}`);
  if (req.langProvided && req.lang !== cp.flags.lang) out.push(`--lang ${req.lang} conflicts with the checkpoint's ${cp.flags.lang}`);
  if (req.pomProvided && req.pom !== cp.flags.pom) out.push(`--${req.pom ? 'pom' : 'no-pom'} conflicts with the checkpoint's ${cp.flags.pom ? 'pom' : 'no-pom'} mode`);
  if (req.srs) out.push('--srs conflicts with --resume (the checkpoint already carries the requirements map)');
  if (req.features.length > 0) out.push('--features conflicts with --resume (features are recorded in the checkpoint)');
  if (req.urls.length > 0) out.push('--urls conflicts with --resume (the page set is recorded in the checkpoint)');
  if (req.discover) out.push('--discover conflicts with --resume (discovery is recorded in the checkpoint)');
  if (req.review) out.push('--review conflicts with --resume');
  if (req.fromPlan) out.push('--from-plan conflicts with --resume');
  return out;
}

/** Restore the flags a checkpoint recorded onto the request (after conflicts pass). */
export function applyCheckpointFlags(req: ExploreRequest, cp: Checkpoint): ExploreRequest {
  return { ...req, url: cp.url, lang: cp.flags.lang, pom: cp.flags.pom, features: [...cp.flags.features] };
}

export interface BuildExploreContext {
  /** Validated entry URL. */
  url: string;
  outDir: string;
  requirements?: RequirementsMap;
  resume?: Checkpoint;
  fromPlan?: PlannedScenario[];
  /** Explorer model override from the dashboard's model chip. */
  model?: string;
}

/**
 * The runtime options for a request. This is the single mapping from "what
 * the user asked for" to "what explore() receives"; the parity smoke asserts
 * the CLI, gateway and MCP produce identical objects for identical asks.
 * `onEvent` is added by the caller.
 */
export function buildExploreOptions(req: ExploreRequest, ctx: BuildExploreContext): Omit<ExploreOptions, 'onEvent'> {
  const cp = ctx.resume;
  return {
    url: ctx.url,
    language: req.lang,
    outDir: ctx.outDir,
    ...(ctx.model ? { model: ctx.model } : {}),
    review: req.review,
    ...(ctx.fromPlan ? { fromPlan: ctx.fromPlan } : {}),
    skipReplay: !req.replay,
    skipStability: !req.stability,
    stabilityIterations: req.stabilityIterations,
    stabilize: req.stabilize,
    maxStabilizeAttempts: req.stabilizeAttempts,
    features: req.features,
    ...(ctx.requirements ? { requirements: ctx.requirements } : {}),
    discover: cp?.flags.discover ?? req.discover,
    urls: cp ? cp.flags.urls : req.urls,
    ...(cp ? { resume: cp } : {}),
    checkpointFlags: {
      pom: req.pom,
      ...(req.srs ? { srsPath: req.srs } : cp?.flags.srs ? { srsPath: cp.flags.srs } : {}),
    },
  };
}

/**
 * Where a fresh (non-resume, non-plan) run writes. POM runs use the stable
 * <brand>-automation-framework name (re-runs overwrite); inline runs keep a
 * timestamped name so history is never lost. Mirrors the CLI's historical
 * behavior so the gateway and MCP land runs where the dashboard scans.
 */
export function outDirForRequest(req: ExploreRequest, url: string, base: string, frameworkDirName: (u: string) => string, stamp: () => string): string {
  const baseName = req.name ?? slugUrl(url);
  const dirName = req.pom
    ? (req.name ? `${baseName}-automation-framework` : frameworkDirName(url))
    : `${stamp()}-${baseName}`;
  return path.join(base, dirName);
}

export function slugUrl(s: string): string {
  return s.replace(/^https?:\/\//, '').replace(/[^a-z0-9-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase();
}

/**
 * Split a chat command body into tokens, honoring double or single quotes so
 * a path with spaces (`--srs "docs/My SRS.pdf"`) stays one token.
 */
export function tokenizeCommand(body: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of body) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}
