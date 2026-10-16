/**
 * The ONE price table (invariant 74). Every stage that calls a model prices
 * the call here, by the exact model id it sent, through costOf.
 *
 * USD per million tokens, read from the Anthropic pricing page
 * (platform.claude.com/docs/en/about-claude/pricing) on 2026-10-16. Every
 * number is written out: a cache read is never derived from a multiplier,
 * because the ratio differs by model (Opus 5.5 reads at 0.20, not 0.40).
 * Cache write is the 5 minute rate, the only TTL the stages use.
 *
 * An id that is not in the table throws, naming the id and every known id.
 * There is no fallback: before this table, an unknown Explorer model was
 * priced as Opus 4.7, the Critic and the Planner were priced at their
 * default model whatever model they called, and the Stabilizer priced any
 * Opus at 15/75 (standing rule 2: a failure path never returns a value that
 * looks legitimate). Haiku 5.5 is priced by prompt size and is left out
 * until its tiers are added; it refuses to start like any unknown id.
 */

/** Per-million-token prices of one model. */
export interface ModelPrice {
  in: number;
  out: number;
  /** 5 minute cache write. */
  cacheWrite: number;
  cacheRead: number;
}

export const MODEL_PRICES: Readonly<Record<string, Readonly<ModelPrice>>> = {
  'claude-opus-5-5':   { in: 4.00, out: 20.00, cacheWrite: 5.00, cacheRead: 0.20 },
  'claude-opus-4-7':   { in: 5.00, out: 25.00, cacheWrite: 6.25, cacheRead: 0.50 },
  'claude-sonnet-5-5': { in: 2.00, out: 10.00, cacheWrite: 2.50, cacheRead: 0.10 },
  'claude-sonnet-4-6': { in: 3.00, out: 15.00, cacheWrite: 3.75, cacheRead: 0.30 },
  'claude-haiku-4-5':  { in: 1.00, out: 5.00,  cacheWrite: 1.25, cacheRead: 0.10 },
};

/** Every model id the table prices, in table order. */
export const KNOWN_MODEL_IDS: readonly string[] = Object.keys(MODEL_PRICES);

/** The usage fields the API returns; a missing or null field counts 0. */
export interface ModelUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Thrown for a model id the table does not price. */
export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`unknown model id "${model}"; known ids: ${KNOWN_MODEL_IDS.join(', ')}`);
    this.name = 'UnknownModelError';
  }
}

/** True when the table prices this exact id. */
export function isKnownModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_PRICES, model);
}

/** The prices of one model, or a thrown UnknownModelError. Never a fallback. */
export function priceOf(model: string): Readonly<ModelPrice> {
  if (!isKnownModel(model)) throw new UnknownModelError(model);
  return MODEL_PRICES[model]!;
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** USD for one usage record (or a sum of them) on this model: all four token fields. */
export function costOf(model: string, usage: ModelUsage): number {
  const p = priceOf(model);
  return (
    // The Explorer's summation order before this table (input, output, cache
    // read, cache write), so its recorded costs stay identical to the bit.
    n(usage.input_tokens) * p.in
    + n(usage.output_tokens) * p.out
    + n(usage.cache_read_input_tokens) * p.cacheRead
    + n(usage.cache_creation_input_tokens) * p.cacheWrite
  ) / 1_000_000;
}
