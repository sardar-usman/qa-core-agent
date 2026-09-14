import { z } from 'zod';
import { defaultExploreRequest, validateEnvOverride, type ExploreRequest } from '../agent/explore-request.js';
import { parseCommaSeparated } from '../agent/parse-features.js';

/**
 * MCP tool schemas and their mapping onto the shared ExploreRequest. Pure:
 * no server, no transport, so the parity smoke can import it and assert that
 * a qa_explore call builds the same request the CLI builds from flags. The
 * server (server.ts) registers these schemas verbatim.
 *
 * Every argument documents its CLI equivalent in its description; the smoke
 * checks that the documented set covers every CLI flag with parity.
 */

export const TOOL_NAMES = ['qa_explore', 'qa_resume', 'qa_transcribe', 'qa_generate', 'qa_heal'] as const;

const settingArgs = {
  ceilingUsd: z.number().positive().optional().describe('Per-run cost ceiling in USD (CLI: --ceiling, env QA_CORE_COST_CEILING, default 2.00). Completed scenarios are salvaged when it is hit.'),
  repairReserve: z.number().min(0).lt(1).optional().describe('Fraction of the ceiling reserved for the critic repair pass (CLI: --repair-reserve, env QA_CORE_REPAIR_RESERVE, default 0.15).'),
  maxSteps: z.number().int().positive().optional().describe('Hard ceiling on Explorer tool calls (CLI: --max-steps, env QA_CORE_MAX_STEPS, default 40).'),
  plannerModel: z.string().optional().describe('Planner model id (CLI: --planner-model, env QA_CORE_PLANNER_MODEL, default claude-haiku-4-5).'),
  explorerModel: z.string().optional().describe('Explorer model id (CLI: --explorer-model, env QA_CORE_EXPLORER_MODEL, default claude-opus-4-7).'),
  criticModel: z.string().optional().describe('Critic model id (CLI: --critic-model, env QA_CORE_CRITIC_MODEL, default claude-sonnet-4-6).'),
};

export const exploreArgs = {
  url: z.string().describe('The entry URL to explore (http:// or https://). CLI: the positional <url>.'),
  language: z.enum(['ts', 'js']).default('ts').describe('Output language of the generated framework (CLI: --lang ts|js, default ts).'),
  features: z.array(z.string()).optional().describe('Feature names to steer the Planner, e.g. ["login","cart"]. Omit and the Planner infers 2-3 flows from the page (CLI: --features login,cart).'),
  srs: z.string().optional().describe('Path to an SRS document (.md/.txt/.pdf/.docx), relative to the project root or absolute. Builds a requirements map for rule-first planning and a rule-coverage report (CLI: --srs <file>).'),
  srsText: z.string().optional().describe('The SRS content inline, when the client holds the text rather than a file. Written to output/.uploads and treated like --srs. Ignored when srs is given.'),
  urls: z.array(z.string()).optional().describe('Explicit page list for multi-page discovery, paths or absolute URLs (CLI: --urls /login,/cart).'),
  discover: z.boolean().default(false).describe('Multi-page discovery ladder: sitemap, then a polite crawl, then entry-only (CLI: --discover). Also activated by urls or srs.'),
  pom: z.boolean().default(true).describe('true: emit the Page Object Model framework + zip (default). false: a single inline spec file (CLI: --no-pom / --inline).'),
  name: z.string().optional().describe('Output basename override (CLI: --name).'),
  replay: z.boolean().default(true).describe('Run the reality-check replay pass (CLI: --no-replay to disable).'),
  stability: z.boolean().default(true).describe('Run the stability iteration (CLI: --no-stability to disable).'),
  stabilityIterations: z.number().int().positive().default(3).describe('Stability re-runs per scenario (CLI: --stability N, default 3).'),
  stabilize: z.boolean().default(true).describe('Run the Stage 5b Stabilizer on flaky scenarios (CLI: --no-stabilize to disable).'),
  stabilizeAttempts: z.number().int().positive().default(3).describe('Max Stabilizer fix attempts per flaky scenario (CLI: --stabilize-attempts N, default 3).'),
  ...settingArgs,
};

export const resumeArgs = {
  checkpointPath: z.string().describe('Path to the checkpoint.json a stopped run left behind, relative to the project root or absolute (CLI: --resume <path>). URL, language, features, page set and requirements map are restored from it.'),
  ...settingArgs,
};

export const transcribeArgs = {
  reportPath: z.string().describe('Path to an existing run-report.json, relative to the project root or absolute. Regenerates the framework and zip from it with no exploration and no model call (CLI: npm run transcribe -- <path>).'),
  outDir: z.string().optional().describe('Output directory override; defaults to the report\'s own directory (CLI: --out <dir>).'),
};

export const generateArgs = {
  story: z.string().min(10).describe('The user story or acceptance criteria. Vague stories produce vague tests; be specific.'),
  language: z.enum(['ts', 'js']).default('ts').describe('Output language of the generated spec.'),
  baseUrl: z.string().optional().describe('Optional base URL to bake into the generated spec.'),
};

export const healArgs = {
  specPath: z.string().describe('Path to the spec file (relative to project root or absolute).'),
  baseUrl: z.string().optional().describe('Target URL override when the spec has no absolute goto.'),
};

export const TOOL_SCHEMAS: Record<(typeof TOOL_NAMES)[number], Record<string, z.ZodTypeAny>> = {
  qa_explore: exploreArgs,
  qa_resume: resumeArgs,
  qa_transcribe: transcribeArgs,
  qa_generate: generateArgs,
  qa_heal: healArgs,
};

export type ExploreToolArgs = z.infer<z.ZodObject<typeof exploreArgs>>;
export type ResumeToolArgs = z.infer<z.ZodObject<typeof resumeArgs>>;
export type TranscribeToolArgs = z.infer<z.ZodObject<typeof transcribeArgs>>;

type SettingArgs = z.infer<z.ZodObject<typeof settingArgs>>;

function envFromSettings(a: SettingArgs): Record<string, string> {
  const pairs: Array<[string, string | number | undefined]> = [
    ['QA_CORE_COST_CEILING', a.ceilingUsd],
    ['QA_CORE_REPAIR_RESERVE', a.repairReserve],
    ['QA_CORE_MAX_STEPS', a.maxSteps],
    ['QA_CORE_PLANNER_MODEL', a.plannerModel],
    ['QA_CORE_EXPLORER_MODEL', a.explorerModel],
    ['QA_CORE_CRITIC_MODEL', a.criticModel],
  ];
  const env: Record<string, string> = {};
  for (const [name, v] of pairs) {
    if (v === undefined) continue;
    const value = String(v);
    const err = validateEnvOverride(name, value);
    if (err) throw new Error(err);
    env[name] = value;
  }
  return env;
}

/**
 * qa_explore arguments to the shared request. `srsPath` is the resolved
 * file when srsText was written to disk by the server (pure callers pass
 * nothing and the request carries `srs` only when a path was given).
 */
export function exploreRequestFromToolArgs(a: ExploreToolArgs, srsPathFromText?: string): ExploreRequest {
  const req = defaultExploreRequest();
  req.url = a.url;
  req.lang = a.language ?? 'ts';
  req.langProvided = a.language !== undefined;
  req.pom = a.pom ?? true;
  req.pomProvided = a.pom !== undefined;
  req.features = (a.features ?? []).flatMap((f) => parseCommaSeparated(f));
  if (a.srs) req.srs = a.srs;
  else if (srsPathFromText) req.srs = srsPathFromText;
  req.discover = a.discover ?? false;
  req.urls = (a.urls ?? []).map((u) => u.trim()).filter(Boolean);
  if (a.name) req.name = a.name;
  req.replay = a.replay ?? true;
  req.stability = a.stability ?? true;
  req.stabilityIterations = a.stabilityIterations ?? 3;
  req.stabilize = a.stabilize ?? true;
  req.stabilizeAttempts = a.stabilizeAttempts ?? 3;
  req.env = envFromSettings(a);
  return req;
}

/** qa_resume arguments to the shared request (`--resume <path>` plus settings). */
export function resumeRequestFromToolArgs(a: ResumeToolArgs): ExploreRequest {
  const req = defaultExploreRequest();
  req.resume = a.checkpointPath;
  req.env = envFromSettings(a);
  return req;
}
