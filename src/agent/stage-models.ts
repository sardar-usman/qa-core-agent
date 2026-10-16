/**
 * The model every stage calls, resolved in ONE place (invariant 74): an
 * explicit override first, then the stage's env names in order (the
 * documented name, then the older name still honored), then the default.
 * Each stage resolves its model through stageModel, the startup check
 * resolves every stage the same way before any API call, and the run-report
 * records the result per stage (cost.models).
 */
import { isKnownModel, KNOWN_MODEL_IDS } from './pricing.js';

export type Stage = 'planner' | 'explorer' | 'critic' | 'stabilizer' | 'requirements' | 'pageFilter' | 'featureParser' | 'generate';

/** A stage's env names (documented first, then older ones) and its default model. */
export const STAGE_MODELS: Readonly<Record<Stage, { env: readonly string[]; defaultModel: string }>> = {
  planner: { env: ['QA_CORE_PLANNER_MODEL', 'QA_CORE_MODEL_PLANNER'], defaultModel: 'claude-haiku-4-5' },
  explorer: { env: ['QA_CORE_EXPLORER_MODEL', 'QA_CORE_MODEL_EXPLORE'], defaultModel: 'claude-opus-4-7' },
  critic: { env: ['QA_CORE_CRITIC_MODEL', 'QA_CORE_MODEL_CRITIC'], defaultModel: 'claude-sonnet-4-6' },
  stabilizer: { env: ['QA_CORE_MODEL_STABILIZER'], defaultModel: 'claude-sonnet-4-6' },
  requirements: { env: [], defaultModel: 'claude-haiku-4-5' },
  pageFilter: { env: [], defaultModel: 'claude-haiku-4-5' },
  featureParser: { env: [], defaultModel: 'claude-haiku-4-5' },
  generate: { env: ['QA_CORE_MODEL_TRANSCRIBE'], defaultModel: 'claude-sonnet-4-6' },
};

/** The model a stage calls: the override, else the first env name set, else the default. */
export function stageModel(stage: Stage, override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override) return override;
  for (const name of STAGE_MODELS[stage].env) {
    const v = env[name];
    if (v) return v;
  }
  return STAGE_MODELS[stage].defaultModel;
}

/** The stages an explore run calls, in pipeline order. /generate is not one of them. */
export type ExploreStage = Exclude<Stage, 'generate'>;
export const EXPLORE_STAGES: readonly ExploreStage[] = ['requirements', 'featureParser', 'pageFilter', 'planner', 'explorer', 'critic', 'stabilizer'];

/** The model per explore stage, as the run-report records it (cost.models). */
export type StageModels = Partial<Record<ExploreStage, string>>;

/** Explicit per-stage overrides: the gateway's model chip or ExploreOptions.model (explorer), ExploreOptions.stabilizerModel. */
export type StageOverrides = Partial<Record<Stage, string | undefined>>;

/** Every explore stage's model, resolved now. */
export function exploreStageModels(env: NodeJS.ProcessEnv = process.env, overrides: StageOverrides = {}): Record<ExploreStage, string> {
  const out = {} as Record<ExploreStage, string>;
  for (const stage of EXPLORE_STAGES) out[stage] = stageModel(stage, overrides[stage], env);
  return out;
}

/**
 * The startup refusal line for the first explore stage whose model the price
 * table does not know, or null. Run before discovery and before any API call
 * on every surface (CLI, gateway, MCP), so an unpriced model never spends.
 */
export function unknownModelRefusal(env: NodeJS.ProcessEnv = process.env, overrides: StageOverrides = {}): string | null {
  const models = exploreStageModels(env, overrides);
  for (const stage of EXPLORE_STAGES) {
    const model = models[stage];
    if (!isKnownModel(model)) {
      return `Run refused: the ${stage} model "${model}" is not in the price table; known ids: ${KNOWN_MODEL_IDS.join(', ')}. Nothing was spent.`;
    }
  }
  return null;
}
