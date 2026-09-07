import Anthropic from '@anthropic-ai/sdk';
import type { Scenario, TraceStep } from './trace.js';
import { scenarioNameKey } from './rule-coverage.js';

/**
 * Critic — Step 3 of the multi-agent pipeline.
 *
 * Reviews the verified trace and produces per-scenario verdicts with structured
 * reasons and required_fixes arrays. Verdicts gate Reality-Check: only 'pass'
 * scenarios proceed to replay; 'rework' and 'reject' are dropped here.
 */

export type Verdict = 'pass' | 'rework' | 'reject';

export interface ScenarioVerdict {
  scenario: string;
  verdict: Verdict;
  reasons: string[];
  required_fixes: string[];
}

export interface CriticResult {
  verdicts: ScenarioVerdict[];
  summary: string;
  costUsd: number;
}

const SYSTEM = `You are the Critic, a senior QA reviewer. You will be shown test scenarios that an exploration agent recorded against a live page. Every scenario executed successfully — the actions worked. Your job is to judge whether the ASSERTIONS would catch a real regression.

For each scenario return one JSON object:

{
  "scenario": "<exact scenario name from the input>",
  "verdict": "pass" | "rework" | "reject",
  "reasons": ["<short reason>"],
  "required_fixes": ["<concrete fix instruction>"]
}

Verdicts:
- "pass"   — assertion is specific, auto-retrying, and would fail when the feature breaks. Ready for Reality-Check.
- "rework" — the scenario tests something real but the assertion, wait strategy, or locator is wrong. List exactly what needs to change in required_fixes so the Explorer can regenerate a correct version.
- "reject" — not worth keeping: redundant, impossible, tests nothing meaningful, or the scenario name does not match what was tested.

Flagging rules — apply to every scenario:

1. Timing: any assertion on an animated or async element (progress bar, countdown timer, loading spinner, toast, live counter) with [no-timeout] is automatically "rework". The required_fix must name the correct tool: wait_for_text (polls until text matches) or assert with timeout set to at least 10000ms.

2. Vacuous or substring: asserting toBeVisible on the element the agent just clicked proves nothing about the outcome. A substring match (toContainText with a single character or a unit-only string like "%") is never acceptable. Flag as "rework".

3. a11y without ARIA: an a11y scenario that only checks visible text or element presence is automatically "rework". It must assert ARIA attributes (role, aria-valuenow, aria-valuemin, aria-valuemax, aria-label, aria-expanded) via toHaveAttribute, or prove keyboard operability produced a meaningful outcome.

4. Missing outcome assertion: a scenario where the key action (submit, navigate, toggle) has no assertion on its outcome is "rework" or "reject".

5. Volatile identifiers: an assertion or capture pinned to a specific catalog-item test id (a generated id like product-01JX8F2K or sku-8842) is "rework" — such ids rot when the data reseeds. The required_fix names a durable anchor instead: text content, a count, a relation between values, or a stable structural id (search-query, sort-select).

Return a JSON array with one element per scenario in the same order as the input, then a <summary> paragraph:

[
  { "scenario": "...", "verdict": "pass", "reasons": ["..."], "required_fixes": [] },
  { "scenario": "...", "verdict": "rework", "reasons": ["..."], "required_fixes": ["..."] }
]

<summary>
One short paragraph on overall spec quality.
</summary>`;

const CRITIC_PRICE = { in: 3.0, out: 15.0 }; // Sonnet 4.6

export async function critique(opts: {
  scenarios: Scenario[];
  url: string;
  model?: string;
  apiKey?: string;
}): Promise<CriticResult> {
  if (opts.scenarios.length === 0) {
    return { verdicts: [], summary: 'No scenarios recorded — nothing to review.', costUsd: 0 };
  }

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  // Both env names are honored: QA_CORE_CRITIC_MODEL (documented) and the
  // older QA_CORE_MODEL_CRITIC. Default unchanged.
  const model = opts.model ?? process.env.QA_CORE_CRITIC_MODEL ?? process.env.QA_CORE_MODEL_CRITIC ?? 'claude-sonnet-4-6';
  const client = new Anthropic({ apiKey });

  const traceSummary = opts.scenarios.map((s, i) => {
    const steps = s.steps.map((step) => describeStep(step)).join('\n      ');
    return `${i + 1}. [${s.category}] ${s.name}\n      ${steps}`;
  }).join('\n\n');

  const response = await client.messages.create({
    model,
    max_tokens: 3000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam],
    messages: [
      {
        role: 'user',
        content: `URL: ${opts.url}\n\nRecorded scenarios:\n\n${traceSummary}\n\nReview.`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const u = response.usage;
  const costUsd = (u.input_tokens * CRITIC_PRICE.in + u.output_tokens * CRITIC_PRICE.out) / 1_000_000;

  return { verdicts: parseVerdicts(text), summary: parseSummary(text), costUsd };
}

/**
 * Values reach the Critic intact up to this cap. The old rendering sliced the
 * QUOTED string (`JSON.stringify(v).slice(0, 30)`), which cut the closing
 * quote off any value over ~28 chars, so the Critic reviewed mangled data and
 * reported phantom truncation errors (a live run flagged a login email as
 * "truncated with a stray quote" that was filled whole on the page). Longer
 * values are cut BEFORE quoting, with an explicit marker, so the quotes stay
 * balanced and a cap can never masquerade as page data.
 */
const VALUE_RENDER_CAP = 200;

/** Render a recorded string value for the Critic: quotes balanced, cap explicit. */
export function renderValueForCritic(v: string): string {
  if (v.length <= VALUE_RENDER_CAP) return JSON.stringify(v);
  return `${JSON.stringify(v.slice(0, VALUE_RENDER_CAP))} …[value continues, ${v.length} chars total]`;
}

// Exported: the repair pass renders each rework scenario's recorded steps
// with this same compact notation so the Explorer starts from what it did.
export function describeStep(step: TraceStep): string {
  switch (step.kind) {
    case 'navigate': return `navigate(${step.url})`;
    case 'click':    return `click(${step.target.intent} via ${step.target.level})`;
    case 'fill':     return `fill(${step.target.intent}, ${renderValueForCritic(step.value)})`;
    case 'press':    return `press(${step.key} on ${step.target.intent})`;
    case 'select_option': return `select_option(${step.target.intent}, ${step.by}=${renderValueForCritic(step.option)})`;
    case 'set_checked':   return `set_checked(${step.target.intent}, ${step.checked ? 'check' : 'uncheck'})`;
    case 'set_input_files': return `set_input_files(${step.target.intent}, ${step.files.length} file(s))`;
    case 'wait':          return `wait(${step.ms}ms)`;
    case 'stability_wait': return `stability_wait(${step.ms}ms)`;
    case 'checkpoint': return `# ${step.label}`;
    case 'assert': {
      const a = step.assertion;
      switch (a.type) {
        case 'toBeVisible': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} visible${t}`;
        }
        case 'toHaveText': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} has text "${a.text}"${t}`;
        }
        case 'toContainText': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} contains "${a.text}"${t}`;
        }
        case 'toHaveURL':
          return `assert URL matches /${a.pattern}/`;
        case 'toBeHidden': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} hidden/absent${t}`;
        }
        case 'toHaveCount':
          return `assert ${a.target.intent} count=${a.count}`;
        case 'toHaveAttribute': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} ${a.attribute}="${a.value}"${t}`;
        }
        case 'toHaveValue': {
          const t = a.timeout ? ` [timeout:${a.timeout}ms]` : ' [no-timeout]';
          return `assert ${a.target.intent} value="${a.value}"${t}`;
        }
      }
    }
    case 'capture': {
      const what = step.source === 'attribute' ? `${step.attribute} of ${step.target.intent}` : step.source === 'count' ? `count of ${step.target.intent}` : `text of ${step.target.intent}`;
      return `capture ${what} -> ${step.varName}`;
    }
    case 'assert_compare': {
      const bounds = step.bounds ? `, strictly within ${step.bounds.min}..${step.bounds.max}` : '';
      return `assert_compare ${step.readVar} ${step.relation} vs captured ${step.varName}${bounds}`;
    }
    case 'wait_for_state':
      return `wait_for_state(${step.target.intent}, ${step.state})`;
  }
}

/**
 * Parse the per-scenario verdict array out of the Critic's response.
 *
 * A regex cannot extract this array: every verdict object contains nested
 * arrays (reasons, required_fixes), so a lazy match ends inside the first
 * object at the first "]", and a greedy match can run into stray brackets in
 * the prose around the array. The old lazy regex truncated on every
 * well-formed response, so every run reported 0 verdicts and the critic gate
 * never dropped anything. The summary block is removed first (its prose may
 * contain brackets), fences are stripped, then a bracket-depth scan finds the
 * first balanced top-level array that parses as JSON and contains at least
 * one verdict-shaped object. A malformed response returns [] and never throws.
 */
export function parseVerdicts(text: string): ScenarioVerdict[] {
  const withoutSummary = text.replace(/<summary>[\s\S]*?<\/summary>/gi, '');
  const stripped = withoutSummary.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  const raw = extractVerdictArray(stripped);
  if (!raw) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      scenario: String(item['scenario'] ?? ''),
      verdict: (['pass', 'rework', 'reject'].includes(String(item['verdict']))
        ? item['verdict']
        : 'rework') as Verdict,
      reasons: Array.isArray(item['reasons'])
        ? (item['reasons'] as unknown[]).map(String)
        : [String(item['reasons'] ?? '')],
      required_fixes: Array.isArray(item['required_fixes'])
        ? (item['required_fixes'] as unknown[]).map(String)
        : [],
    }));
}

/**
 * Find the first balanced top-level JSON array in the text that parses and
 * holds at least one object with a "scenario" key. The depth scan honors
 * string literals and escapes, so a bracket inside a quoted reason (the
 * Critic often quotes "[no-timeout]") does not end the array. A bracketed
 * fragment in the preamble ("scenario [login] ...") fails the parse or the
 * shape check and the scan moves to the next candidate.
 */
function extractVerdictArray(text: string): unknown[] | null {
  let from = 0;
  for (;;) {
    const start = text.indexOf('[', from);
    if (start === -1) return null;
    const end = balancedArrayEnd(text, start);
    if (end !== -1) {
      try {
        const v = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (Array.isArray(v) && v.some((x) => typeof x === 'object' && x !== null && 'scenario' in x)) {
          return v;
        }
      } catch {
        // Not JSON from this bracket; try the next one.
      }
    }
    from = start + 1;
  }
}

/** Index of the "]" closing the array opened at `start`, or -1 if unbalanced. */
function balancedArrayEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Apply the Critic's verdicts: rework and reject scenarios are dropped before
 * Reality-Check, pass scenarios continue. A verdict whose scenario name
 * matches no recorded scenario drops nothing (the prompt requires the exact
 * input name back).
 */
export function gateByVerdicts<S extends { name: string }>(
  scenarios: S[],
  verdicts: ScenarioVerdict[],
): { kept: S[]; dropped: string[] } {
  const dropSet = new Set(verdicts.filter((v) => v.verdict !== 'pass').map((v) => v.scenario));
  return {
    kept: scenarios.filter((s) => !dropSet.has(s.name)),
    dropped: scenarios.filter((s) => dropSet.has(s.name)).map((s) => s.name),
  };
}

/**
 * Strip the "N. [category] " prefix the Critic sometimes echoes back from its
 * input rendering (`1. [negative] rejected a wrong password`). The prompt asks
 * for the exact name, but the echo is not guaranteed, and an exact-equality
 * match on a prefixed echo silently emptied a live run's rework list.
 */
function stripVerdictPrefix(name: string): string {
  return name.replace(/^\s*\d+[.)]\s*/, '').replace(/^\s*(\[[^\]]*\]\s*)+/, '').trim();
}

/** Normalized comparison key for a verdict or scenario name. */
function verdictNameKey(name: string): string {
  return scenarioNameKey(stripVerdictPrefix(name));
}

/**
 * Tolerant verdict-name matching: prefixes stripped, then the same normalized
 * key + containment treatment attachRuleIds uses, so a small rephrasing or an
 * echoed "[category]" prefix never orphans a verdict from its scenario.
 */
export function verdictMatchesScenario(verdictName: string, scenarioName: string): boolean {
  const v = verdictNameKey(verdictName);
  const s = verdictNameKey(scenarioName);
  if (!v || !s) return false;
  return v === s || v.includes(s) || s.includes(v);
}

/**
 * The verdict for a scenario name: exact normalized key first, containment
 * only as a fallback. Exact-first matters when two sibling scenarios share a
 * name prefix ("logged in" / "logged in and landed on inventory"): each must
 * claim its own verdict before containment can blur them together.
 */
export function verdictFor(verdicts: ScenarioVerdict[], scenarioName: string): ScenarioVerdict | undefined {
  const k = verdictNameKey(scenarioName);
  if (!k) return undefined;
  const exact = verdicts.find((v) => verdictNameKey(v.scenario) === k);
  if (exact) return exact;
  return verdicts.find((v) => {
    const vk = verdictNameKey(v.scenario);
    return vk.length > 0 && (vk.includes(k) || k.includes(vk));
  });
}

/**
 * Assign at most one verdict to each scenario name: an exact-key pass first,
 * then a containment pass over what is left, each verdict claimable once.
 * This is what keeps a verdict for "s-rework-a" from also gating its sibling
 * "s-rework-b" when the sibling's own verdict is missing.
 */
function assignVerdicts(names: string[], verdicts: ScenarioVerdict[]): Map<string, ScenarioVerdict> {
  const out = new Map<string, ScenarioVerdict>();
  const claimed = new Set<ScenarioVerdict>();
  for (const name of names) {
    const k = verdictNameKey(name);
    if (!k) continue;
    const v = verdicts.find((x) => !claimed.has(x) && verdictNameKey(x.scenario) === k);
    if (v) {
      out.set(name, v);
      claimed.add(v);
    }
  }
  for (const name of names) {
    if (out.has(name)) continue;
    const k = verdictNameKey(name);
    if (!k) continue;
    const v = verdicts.find((x) => {
      if (claimed.has(x)) return false;
      const vk = verdictNameKey(x.scenario);
      return vk.length > 0 && (vk.includes(k) || k.includes(vk));
    });
    if (v) {
      out.set(name, v);
      claimed.add(v);
    }
  }
  return out;
}

/**
 * Split the gate three ways instead of two: reject drops for good, rework
 * earns ONE repair pass, pass continues. A scenario with no verdict counts
 * as pass (the Critic did not flag it). Matching is tolerant (see
 * verdictMatchesScenario): the live run where the Critic echoed prefixed
 * names bucketed every scenario as kept and silently skipped the repair pass.
 */
export function splitGate<S extends { name: string }>(
  scenarios: S[],
  verdicts: ScenarioVerdict[],
): { kept: S[]; rejected: S[]; rework: S[] } {
  const assigned = assignVerdicts(scenarios.map((s) => s.name), verdicts);
  const kept: S[] = [];
  const rejected: S[] = [];
  const rework: S[] = [];
  for (const s of scenarios) {
    const v = assigned.get(s.name)?.verdict;
    if (v === 'reject') rejected.push(s);
    else if (v === 'rework') rework.push(s);
    else kept.push(s);
  }
  return { kept, rejected, rework };
}

/**
 * Split scenarios for a resumed run's critic step: a scenario whose verdict
 * already exists in the checkpoint carries it (the critic is never billed
 * twice for the same trace); only scenarios with no carried verdict are
 * reviewed. Matching is the tolerant claim-based assignment, so a carried
 * verdict for a restored scenario never leaks onto a new sibling. A stale
 * carried verdict matching no current scenario is dropped.
 */
export function splitCarriedVerdicts<S extends { name: string }>(
  scenarios: S[],
  carried: ScenarioVerdict[],
): { toReview: S[]; carriedVerdicts: ScenarioVerdict[] } {
  if (carried.length === 0) return { toReview: scenarios, carriedVerdicts: [] };
  const assigned = assignVerdicts(scenarios.map((s) => s.name), carried);
  const toReview: S[] = [];
  const carriedVerdicts: ScenarioVerdict[] = [];
  for (const s of scenarios) {
    const v = assigned.get(s.name);
    if (v) carriedVerdicts.push(v);
    else toReview.push(s);
  }
  return { toReview, carriedVerdicts };
}

/** What the repair-pass entry decision resolved to. The line ALWAYS prints. */
export interface RepairDecision<S> {
  run: boolean;
  /** The recorded scenarios matched to rework verdicts. */
  rework: S[];
  /** Total ceiling minus actual spend — the budget the repair pass may use. */
  budgetUsd: number;
  /** "repair pass: N scenario(s), budget $X" or "repair pass skipped: <reason>". */
  line: string;
}

/**
 * The single entry decision for the repair pass. Returns null ONLY when no
 * rework verdicts exist (there is nothing to repair and nothing to report).
 * Otherwise the caller MUST print `line` — silent non-execution cost a live
 * run its whole repair budget with no trace of why. The budget compares the
 * TOTAL ceiling against actual spend: the Explorer legitimately overshoots
 * its own sub-ceiling by up to one API call, and that overshoot must never
 * disqualify a repair the reserve was created to fund.
 */
export function decideRepairPass<S extends { name: string }>(opts: {
  scenarios: S[];
  verdicts: ScenarioVerdict[];
  spentUsd: number;
  ceilingUsd: number;
}): RepairDecision<S> | null {
  const reworkVerdicts = opts.verdicts.filter((v) => v.verdict === 'rework');
  if (reworkVerdicts.length === 0) return null;
  const { rework } = splitGate(opts.scenarios, opts.verdicts);
  const budgetUsd = opts.ceilingUsd - opts.spentUsd;
  if (rework.length === 0) {
    return {
      run: false,
      rework,
      budgetUsd,
      line: `repair pass skipped: ${reworkVerdicts.length} rework verdict(s) matched no recorded scenario by name (verdicts: ${reworkVerdicts.map((v) => `"${v.scenario}"`).join(', ')}).`,
    };
  }
  if (budgetUsd <= 0) {
    return {
      run: false,
      rework,
      budgetUsd,
      line: `repair pass skipped: no budget remaining ($${budgetUsd.toFixed(4)} of the total ceiling left); ${rework.length} rework scenario(s) dropped.`,
    };
  }
  return {
    run: true,
    rework,
    budgetUsd,
    line: `repair pass: ${rework.length} scenario(s), budget $${budgetUsd.toFixed(2)}`,
  };
}

/** One rework scenario's journey through the single repair pass. */
export interface RepairHistoryEntry {
  scenario: string;
  first: 'rework';
  /** The verdict after the repair pass. Absent when the repair never re-recorded it. */
  second?: Verdict;
  outcome: 'kept' | 'dropped';
}

/**
 * Fold the second-round verdicts back into the first: non-rework verdicts
 * pass through untouched; each rework is replaced by its second verdict when
 * the repair pass produced one (pass keeps the repaired scenario, anything
 * else drops for real), or stays rework (drops) when the repair never
 * re-recorded it (no budget, scenario skipped, repair failed). This is the
 * ONE repair pass: a second-time rework gets no third chance, structurally.
 */
export function mergeRepairVerdicts(
  original: ScenarioVerdict[],
  repaired: ScenarioVerdict[] | null,
): { final: ScenarioVerdict[]; history: RepairHistoryEntry[] } {
  const final: ScenarioVerdict[] = [];
  const history: RepairHistoryEntry[] = [];
  // Tolerant pairing: either round's echo may carry a prefix or a rephrasing,
  // and each second verdict is claimable once (exact key wins over containment)
  // so sibling rework names never swap verdicts.
  const reworkNames = original.filter((v) => v.verdict === 'rework').map((v) => v.scenario);
  const secondByOriginal = assignVerdicts(reworkNames, repaired ?? []);
  for (const v of original) {
    if (v.verdict !== 'rework') {
      final.push(v);
      continue;
    }
    const second = secondByOriginal.get(v.scenario);
    if (!second) {
      final.push(v);
      history.push({ scenario: v.scenario, first: 'rework', outcome: 'dropped' });
      continue;
    }
    final.push(second);
    history.push({
      scenario: v.scenario,
      first: 'rework',
      second: second.verdict,
      outcome: second.verdict === 'pass' ? 'kept' : 'dropped',
    });
  }
  return { final, history };
}

function parseSummary(text: string): string {
  const m = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  return m && m[1] ? m[1].trim() : '';
}
