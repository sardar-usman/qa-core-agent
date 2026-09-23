import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createContext, runTool, TOOL_DEFS, type ToolContext } from './tools.js';
import type { RunReport, Scenario } from './trace.js';
import { renderMemoryBlock, saveRun, type RunSummary } from './memory.js';
import { plan, lockoutScenarioNames, knownAccountIdentifiers, uniqueScenarioNames, dedupeAcrossPages, unreachableFeatures, unreachableFeatureLine, type PlannedScenario } from './planner.js';
import { alignVerdictNames, critique, decideRepairPass, describeStep, mergeRepairVerdicts, repairDoneEvent, repairScenarioEvents, splitCarriedVerdicts, splitGate, verdictFor, type RepairDoneEvent, type RepairScenarioEvent, type RepairStartedEvent, type ScenarioVerdict } from './critic.js';
import { replay, type ReplayEvent } from './replay.js';
import { stability, type StabilityEvent } from './stability.js';
import { reconcile } from './reconcile.js';
import { attachRuleIds, computeDerivation, computeRuleCoverage, renderRuleCoverage, scenarioNameKey, claimPlanned } from './rule-coverage.js';
import type { RequirementsMap } from './requirements.js';
import { discoverPages, writeDiscoveryJson } from './discovery.js';
import { filterPages, FILTERED_SOURCES, MAX_PAGES_WITH_FEATURES } from './page-filter.js';
import { featureTokenMap } from './requirements.js';
import {
  CHECKPOINT_VERSION,
  checkpointPath,
  classifyRunError,
  priorSpend,
  remainingPlan,
  stopMessage,
  writeCheckpoint,
  type Checkpoint,
  type CheckpointPhase,
  type StopClassification,
} from './checkpoint.js';
import { installEvalShim } from './eval-shim.js';
import { ASSERTION_DOCTRINE } from './doctrine.js';
import { gateBrokenReason } from './gate.js';
import type { CascadeLevel } from './selectors.js';
import { writeCsv } from './csv.js';

/**
 * Agent runtime — agentic tool-use loop on Claude.
 *
 * The agent explores a URL by interacting with a real Playwright browser via
 * tool calls. Every action it takes is verified before the next step. At the
 * end, the trace is handed to the transcriber which emits a Playwright spec.
 *
 * This is fundamentally more reliable than "generate code from a DOM dump"
 * because the generated spec is a transcription of a session that ran.
 */

export const EXPLORER_SYSTEM_PROMPT = `You are QA-Core, an autonomous QA agent that generates Playwright tests by exploring a web application like an experienced tester would.

You will be given a URL. Your job:

1. Navigate to the URL.
2. Use get_dom to understand what's on the page.
3. For each meaningful flow, call begin_scenario, then drive Playwright through the steps you would take to verify it, then call assert at least once, then end_scenario.
4. Cover happy paths AND at least one negative case AND one accessibility-friendly check (e.g. that landmark elements have the right roles or that error states are announced).
5. Call finish only when EVERY planned scenario has been explored or explicitly skipped. A planned scenario you cannot test (page unreachable, missing credentials, control not present) must be skipped with skip_scenario and a concrete reason — never silently abandoned. finish is rejected while planned scenarios remain unexplored and unskipped.

Rules:
- Describe selectors by INTENT first (e.g. "username input", "submit button") and let the cascade resolve them. Provide hints (role, label, testid, css) when you can see them in the DOM.
- Match the tool to the control type. Look at the element's tag and type in get_dom before you act:
  - <select> dropdown: use select_option, never fill. Pass optionValue, optionLabel (the visible text), or optionIndex. The DOM summary lists each select's options so you can pass a real value.
  - checkbox or radio (input type=checkbox / type=radio): use set_checked, never fill.
  - file input (input type=file): use set_input_files.
  - text input or textarea: use fill.
  fill auto-corrects if you point it at the wrong control, but choose the right tool so the intent is clear.
- Never assert on something you have not seen visible. Every scenario must have at least one assert.
- Negative scenarios should record assertions on the failure state (e.g. an error message appearing), not on success URLs.
- Stay within your step budget. Be decisive. Do not loop on get_dom.

Feature tagging — IMPORTANT:
- When you call begin_scenario, pass a \`feature\` field tagging which feature this scenario belongs to (e.g. "login", "cart", "search", "checkout").
- The framework groups page objects and tests by feature. All "login" scenarios share pages/login-page.ts and live under tests/login/. All "cart" scenarios share pages/cart-page.ts and tests/cart/. Etc.
- If a Plan with feature names was provided in this system prompt, use those exact names verbatim. Don't invent variants or aliases ("login" not "logging-in", "auth" not "authentication").
- If no plan was provided and you are inferring features yourself, pick the simplest noun for the page: "login" for an auth form, "cart" for a shopping cart, "search" for a search interface, etc. Use kebab-case for multi-word features ("forgot-password", "user-profile").

Animated and time-varying elements — CRITICAL:
- Semantic state attributes win over text. When an element exposes an ARIA value/state attribute (aria-valuenow, aria-checked, aria-selected, aria-expanded, aria-pressed), assert THAT attribute, never the displayed text. A progress bar at completion is asserted as aria-valuenow="100", NOT toHaveText("100%"). The attribute is what assistive tech reads and it does not depend on display formatting. wait_for_text already records the attribute automatically when the element exposes one, so keep using it for completion — it will emit the aria-valuenow assertion for you.
- For elements whose value changes over time (progress bars, countdown timers, loading spinners, toast messages), use wait_for_text to wait for the terminal state instead of stacking wait() calls. wait_for_text polls until the target is reached or times out — it is immune to timing variance. Fixed waits fail whenever the page is even 100ms slower than expected.
- After clicking Stop or Pause on a value widget, use assert_freeze with attribute="aria-valuenow". It reads the value, waits a bounded interval under 1000ms, re-reads, and asserts the two readings are equal AND strictly between aria-valuemin and aria-valuemax. That proves the animation stopped mid-progress without depending on catching any specific number. For an animated element with no ARIA value attribute, call assert_freeze without attribute to compare its text across two reads.
- Never assert an exact intermediate value of a continuously changing element (for example "30%" or aria-valuenow="30"). You cannot reliably catch a specific number mid-animation. Use wait_for_text for the terminal state, or assert_freeze for the stopped state.

ASSERTION RULES — apply before every end_scenario:

1. Match assertion to scenario category. Never copy the happy-path final-state assertion onto a negative, edge, or a11y scenario unless that exact state is genuinely the expected outcome for that case. Before writing an edge or negative assertion, state the expected behavior for that specific case, then assert it. Example: for "start clicked while already running", the expected behavior is that the animation is not reset — assert that, not a copied "100%" check that may never be true.

2. Use web-first auto-retry assertions: toHaveText, toHaveAttribute, toBeVisible, toHaveValue, toBeChecked. For a FORMAT instead of a literal (a price is rendered, a name-shaped string is present, an image has a src), pass regex to toHaveText / toContainText / toHaveAttribute (regex: "^\\$\\d+\\.\\d{2}$", "^\\S+ \\S+$", "\\S"); the gate allows a pattern where it rejects a literal. For "at least one" of something, toHaveCount with atLeast: 1 (polled), never the exact catalogue count. For a checkbox or radio state, toBeChecked (checked: false for unchecked). For any assertion that depends on animation or async state, set an explicit timeout of 15000 on the assert call. Do not read a value with get_dom and then assert that same value statically — use wait_for_text or assert with a timeout and let Playwright poll. The one exception is the capture-and-compare flow in rule 8: there you capture the REAL value with the capture tool and assert_compare how it changed, never a static literal you typed.

3. a11y assertions must check accessibility properties, not just visible text. Use toHaveAttribute to assert role="progressbar", aria-valuenow, aria-valuemin, aria-valuemax. Use getByRole to assert a control is keyboard-reachable. A keyboard flow test must assert that the keyboard action SUCCEEDED (URL changed, success message appeared, form hidden) — not just that a static element is visible.

4. Assertion specificity: prefer exact attribute values or exact text over substring matches. Never assert a bare "%" substring. If the element exposes a semantic ARIA state attribute, you MUST assert that attribute, not the text. For a progress bar reaching completion that means aria-valuenow="100" (wait_for_text records this automatically), never toHaveText("100%"). Text is a fallback only when the element has no semantic attribute.

5. Locator priority: getByRole first, then getByLabel, then getByText, then getByTestId, then CSS only as a last resort. Provide the highest-tier hint available in the DOM. Record which tier resolved (role, label, placeholder, testid, css).

6. Every scenario must have at least one meaningful assertion before end_scenario. If assert_freeze or wait_for_text returns an error, stop and surface the error — do not silently retry with a weaker assertion. Retrying with toBeVisible after a freeze failure hides the bug and inflates cost.

7. Falsifiability: ASSERTION DOCTRINE rule 8 below. The Critic judges vacuous assertions under that same number.

8. Value-change features. When the point of the page is that a value changes (a regenerating id, a rotating token, an incrementing counter, a shuffled order), use the capture-and-compare tools — never type the value yourself. The flow is exactly three steps:
   a. capture — read the REAL value off the page into a named variable. Pass a name and the source: source="attribute" with attribute="id" for a regenerating id, source="text" for visible text, source="count" for a list length. Give the same locator hints (role/label/css) you would for any element.
   b. perform the action — reload, click, resubmit, whatever triggers the change.
   c. assert_compare — pass the SAME name and the relation: "changed" for an id/token that must regenerate, "greater" or "less" for a count that must move, "absent" when the old value must no longer match any element, "equal"/"unchanged" when it must hold. With no element hints it re-reads the element you captured from; with hints (css / testid / role / label) it re-reads THAT element, so two different elements can be compared: capture the listing name, click through, assert_compare {name, relation:"equal", css:"h1"} against the detail heading; capture the first price after a sort, assert_compare {relation:"greater"} with the second card's hints. "greater" and "less" parse the first number out of formatted text ($1,299.00 compares as 1299). An "equal"/"unchanged" compare on the same element with no action since the capture is rejected as circular (it compares a value to itself): act first, or use "changed".
   Concrete dynamic-id example: capture {name:"oldId", source:"attribute", attribute:"id", role:"button", label:"..."} → click the button → assert_compare {name:"oldId", relation:"changed"}. The comparison runs against the real captured id, so it fails exactly when the id stops regenerating. NEVER invent a placeholder like "button-fixed-id" or "previously-captured-id-12345" — capture reads the truth from the page. A value that is supposed to stay STABLE uses assert_freeze, which is the same primitive with relation="unchanged".

9. Unverified success signals. A happy-path assertion is only as good as the signal it checks. If the plan says "lands on /auth/login" or "redirects to /dashboard" but you submit and the page stays put, the redirect was assumed, not real. Do NOT re-fill the whole form and resubmit again and again hoping it works the next time. After one honest retry, stop. Look at what the page ACTUALLY did: read the URL with get_dom, look for a visible success or error message, a toast, an inline validation error. Then assert the real signal you can see (the confirmation message, the cleared form, the error that explains the rejection). If the expected outcome genuinely did not occur, that is a real finding, not something to retry: the system records what the page did. Once a scenario is recorded as a finding, do NOT re-attempt that same flow with different data. Move on to the OTHER planned scenarios (the negative and edge cases) first, so a single expensive happy path does not starve them. Come back to re-attempt the flow only if every other scenario is already done and budget remains. Never burn the budget thrashing one scenario on a success signal that may be wrong. Do NOT call wait() to let the page settle after a submit; wait() is rejected inside a scenario. Use wait_for_text for the state you expect, or assert with a timeout and let Playwright poll. To just re-read the page, call get_dom.

${ASSERTION_DOCTRINE}

Assertion economy:
- One strong, specific assertion (an exact error string, the destination URL, a concrete element count) is worth more than several weak ones.
- If you have already asserted the definitive outcome of the scenario, DO NOT pad with redundant toBeVisible / toHaveURL checks on the same state. Padding adds noise and weakens the suite.
- Prefer toHaveText / toHaveAttribute / toHaveURL over toBeVisible whenever the outcome can be expressed as text, an attribute value, or a URL.

a11y scenarios must actually exercise accessibility:
- An a11y scenario MUST do one of the following, not just check that something is visible:
  (a) Drive a flow using only the keyboard — use press("Tab") to traverse fields and press("Enter") or press("Space") to activate controls, then assert the outcome.
  (b) Assert on ARIA attributes — use assert(toHaveAttribute) to check role, aria-valuenow, aria-valuemin, aria-valuemax, aria-label on controls. For a progress bar: assert role="progressbar", aria-valuemin="0", aria-valuemax="100", and that aria-valuenow updates to "100" after completion.
- For (a), the closing assertion MUST verify the keyboard action SUCCEEDED:
    GOOD: assert toHaveURL("/secure/") after a keyboard-only login (URL changed → login worked).
    GOOD: assert toContainText on a success/error flash that only appears after submit.
    GOOD: assert that the previously-visible login form is now hidden / no longer in the DOM.
    BAD:  assert toBeVisible on the Username input you just typed into (it was visible before, this proves nothing).
    BAD:  end the scenario with no assertion that depends on the keyboard outcome.
- A scenario whose only assertion is toBeVisible on a static element is NOT an a11y scenario. Re-categorize it as happy / edge before ending the scenario.

CRITICAL — each scenario runs in isolation:
- begin_scenario CLEARS cookies, localStorage, and sessionStorage.
- The transcribed spec gives each test a fresh browser context, matching what begin_scenario does here.
- Therefore every scenario MUST be SELF-CONTAINED: include the navigate + any login/setup steps it needs.
- Never write a scenario that assumes the previous scenario left state behind (e.g. "I am already logged in"). If two scenarios share setup, repeat the setup steps in both.

Do not write code. Use the tools.`;

export interface ExploreOptions {
  url: string;
  language: 'ts' | 'js';
  maxSteps?: number;
  maxUsd?: number;
  model?: string;
  outDir: string;
  /** Skip the Planner pre-step (default: enabled). */
  skipPlan?: boolean;
  /** Skip the Critic post-step (default: enabled). */
  skipCritic?: boolean;
  /**
   * Skip the replay reality-check (default: enabled). When skipped, the
   * Transcriber emits every recorded scenario whether or not it replays.
   * Disable only for cost-sensitive runs; replay itself is free (no LLM).
   */
  skipReplay?: boolean;
  /** Override the replay step timeout. Defaults to 10s. */
  replayTimeoutMs?: number;
  /**
   * Skip the stability iteration (default: enabled). Stability re-runs every
   * replay survivor N times and drops any that fail an iteration. Free of LLM
   * cost; the trade-off is wall-clock time.
   */
  skipStability?: boolean;
  /** Number of stability iterations per scenario. Defaults to 3. */
  stabilityIterations?: number;
  /**
   * Enable Stage 5b — the Stabilizer. Defaults to true. When true, flaky
   * scenarios get one LLM-guided fix attempt (wait insertion or selector
   * swap) before being dropped. Set false for offline / fully deterministic
   * stability (no Sonnet call on flake).
   */
  stabilize?: boolean;
  /** Override the model used by the Stabilizer. Defaults to claude-sonnet-4-6. */
  stabilizerModel?: string;
  /**
   * Max number of Stabilizer fix attempts per flaky scenario. Defaults to 3.
   * Each attempt: LLM proposes a fix → patched scenario re-runs the
   * stability iterations → stop if stable, otherwise feed the failure
   * pattern back to the LLM for a different proposal.
   */
  maxStabilizeAttempts?: number;
  /**
   * Review mode: after Planner runs, export the scenario list to plan.csv and
   * exit. Resume the run with `fromPlan` once the CSV has been reviewed.
   */
  review?: boolean;
  /**
   * Pre-approved scenario list — skips the Planner stage and feeds these
   * directly to the Explorer. Used when resuming from a reviewed plan.csv.
   */
  fromPlan?: PlannedScenario[];
  /**
   * Feature list (e.g. ['login', 'cart']). When present, the Planner is
   * steered to propose scenarios ONLY for these features. Empty/undefined
   * → Planner infers 2-3 highest-signal flows from the homepage snapshot.
   * Ignored when `fromPlan` is supplied (the plan already defines scope).
   */
  features?: string[];
  /**
   * Optional requirements map built from an SRS (--srs). Flows to the Planner
   * for rule-first planning, and the run ends with a rule-coverage report
   * (report.ruleCoverage + rule-coverage.json in the output directory).
   */
  requirements?: RequirementsMap;
  /**
   * Multi-page discovery (--discover). Discovery activates when this is set,
   * OR when `urls` is non-empty, OR when `requirements` is present. Without
   * all three, behavior is byte-identical to single-entry-page runs.
   */
  discover?: boolean;
  /** Explicit page list from --urls. Feeds the discovery ladder's user rung. */
  urls?: string[];
  /**
   * Resume state loaded from a checkpoint (--resume). Discovery and planning
   * are skipped, completed traces are restored, spend carries over, and the
   * Explorer continues on the scenarios the checkpoint does not account for.
   */
  resume?: Checkpoint;
  /** CLI-level flags recorded into the checkpoint so --resume can restore them. */
  checkpointFlags?: { pom?: boolean; srsPath?: string };
  onEvent?: (event: AgentEvent) => void;
}

/** Cap on scenarios planned per discovered page. */
export const PER_PAGE_SCENARIO_CAP = 4;
/** Global cap on planned scenarios per run; planning stops once reached. */
export const GLOBAL_PLAN_CAP = 20;

/** Default fraction of the cost ceiling reserved for the repair pass. */
export const DEFAULT_REPAIR_RESERVE = 0.15;

/**
 * Split the cost ceiling between exploration and the repair pass. The last
 * live run spent the whole ceiling exploring, so the repair pass received $0
 * and every rework verdict dropped unrepaired. Reserving a fraction
 * (QA_CORE_REPAIR_RESERVE, default 0.15) caps the Explorer at
 * ceiling * (1 - reserve); the repair pass may spend the remainder. When no
 * rework verdicts exist the reserve goes unused — it is never re-opened for
 * exploration (simplicity wins). The fraction is clamped to [0, 0.5]: zero
 * disables the reserve, and more than half the ceiling for repairs would
 * starve the exploration that produces anything to repair.
 */
export function splitCeiling(
  ceilingUsd: number,
  reserveFraction?: number,
): { explorerUsd: number; reserveUsd: number; reserve: number } {
  const raw = reserveFraction ?? Number(process.env.QA_CORE_REPAIR_RESERVE ?? DEFAULT_REPAIR_RESERVE);
  const reserve = Number.isFinite(raw) ? Math.min(0.5, Math.max(0, raw)) : DEFAULT_REPAIR_RESERVE;
  const reserveUsd = ceilingUsd * reserve;
  return { explorerUsd: ceilingUsd - reserveUsd, reserveUsd, reserve };
}

/**
 * Closeout grace at the cost ceiling, in USD above the loop's ceiling. When
 * the ceiling trips while the scenario in progress already holds a passed
 * assertion, the loop keeps running closing calls only (assert,
 * assert_compare, capture, end_scenario: the same set as the step-budget
 * CLOSEOUT_GRACE in tools.ts) until the scenario closes or the spend passes
 * ceiling + grace. Like the ceiling itself, the grace bounds when a call may
 * START, not its size, so the overshoot is at most one call past it. A
 * scenario with no assertion yet is never salvaged, and begin_scenario and
 * every action tool are refused throughout, so the grace can never start new
 * work. Applies to the repair pass too, since it runs the same loop.
 */
export const COST_CLOSEOUT_GRACE_USD = 0.10;

/** cacheReadTokens over every prompt token (input + cache read + cache creation); 0 when nothing was billed. */
export function cachedInputShare(cost: Pick<RunReport['cost'], 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>): number {
  const total = cost.inputTokens + cost.cacheReadTokens + cost.cacheCreationTokens;
  return total > 0 ? cost.cacheReadTokens / total : 0;
}

/**
 * Place the prompt-cache breakpoints for one API call and return how many the
 * request carries. Four are allowed per request; this is the whole budget:
 *
 *   1. the frozen EXPLORER_SYSTEM_PROMPT block (marked at construction; caches the tool
 *      definitions with it, since tools render before system)
 *   2. the per-host memory block, when present (marked at construction)
 *   3. the LAST system block when it is the plan or the repair note: stable for
 *      the whole loop, so one marker on the last of them covers both
 *   4. the last content block of the last message: the growing conversation.
 *      Moved forward every call (the previous call's marker is removed), so
 *      each call reads the whole prior history from cache and writes only the
 *      round just appended. Earlier positions stay valid read points.
 *
 * Without a memory block or a plan the count is lower, never higher. The
 * prefix is always above the model's minimum cacheable length (2048 tokens on
 * Opus 4.7; the system prompt alone is over 10k), so the marker is never
 * silently ignored. Exported so smoke-prompt-cache locks the placement.
 */
export function placeCacheBreakpoints(systemBlocks: Anthropic.TextBlockParam[], messages: Anthropic.MessageParam[]): number {
  type Marked = { cache_control?: { type: 'ephemeral' } };
  const mark = (b: object): void => { (b as Marked).cache_control = { type: 'ephemeral' }; };
  const unmark = (b: object): void => { delete (b as Marked).cache_control; };
  const last = systemBlocks[systemBlocks.length - 1];
  if (last) mark(last);
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const b of m.content) unmark(b);
  }
  const tail = messages[messages.length - 1];
  if (tail) {
    if (typeof tail.content === 'string') tail.content = [{ type: 'text', text: tail.content }];
    const block = tail.content[tail.content.length - 1];
    if (block) mark(block);
  }
  let count = systemBlocks.filter((b) => (b as Marked).cache_control).length;
  for (const m of messages) {
    if (Array.isArray(m.content)) count += m.content.filter((b) => (b as Marked).cache_control).length;
  }
  return count;
}

/** What the run keeps and loses when the cost ceiling stops the Explorer. */
export interface CostCeilingSalvage {
  /** The in-progress scenario that was discarded, when there was one. */
  discardedInProgress?: string;
  /** Planned scenarios the Explorer never started. */
  unexplored: string[];
  /** Reconciliation entries: the discarded scenario + every unexplored one. */
  incomplete: Array<{ scenario: string; reason: string }>;
  /** The console line: ceiling hit, N completed, M never explored. */
  summary: string;
}

/**
 * Salvage bookkeeping for a run stopped by the cost ceiling. Pure: the caller
 * keeps every completed scenario, discards the in-progress one, and records
 * each planned-but-never-started scenario as incomplete so the reconciliation
 * funnel stays balanced and rule coverage can classify the unexplored rules.
 * Name matching tolerates the Explorer's small rephrasings (same treatment
 * attachRuleIds uses). Exported so smoke-cost-ceiling locks it offline.
 */
export function salvageOnCostCeiling(opts: {
  planned: PlannedScenario[];
  /** Names of every scenario that was started, whatever its outcome. */
  begun: string[];
  /** Count of completed (kept) scenarios, for the summary line. */
  completed: number;
  /** In-progress scenario name; discarded, never shipped half-built. */
  current?: string;
  costUsd: number;
  ceilingUsd: number;
  /**
   * When the stop is not the ceiling (billing exhaustion, persistent API
   * failure), the cause replaces the ceiling wording in the summary. The
   * bookkeeping is identical either way.
   */
  cause?: string;
}): CostCeilingSalvage {
  // Exact key first, containment second, each planned name claimed once
  // (claimPlanned), so a suffixed duplicate is never hidden by its base name.
  const claimed = claimPlanned(opts.planned.map((p) => p.name), opts.begun);
  const unexplored = opts.planned.filter((p) => scenarioNameKey(p.name).length > 0 && !claimed.has(p.name)).map((p) => p.name);
  const incomplete: CostCeilingSalvage['incomplete'] = [];
  if (opts.current) {
    incomplete.push({ scenario: opts.current, reason: 'cost ceiling hit mid-scenario; in-progress work discarded' });
  }
  for (const name of unexplored) {
    incomplete.push({ scenario: name, reason: 'never explored: cost ceiling hit before this scenario started' });
  }
  const summary = opts.cause
    ? `Run stopped (${opts.cause}). ` +
      `${opts.completed} scenario(s) completed and kept, ${unexplored.length} planned scenario(s) never explored. ` +
      `Continuing the pipeline with the survivors.`
    : `Cost ceiling hit ($${opts.costUsd.toFixed(4)} > $${opts.ceilingUsd}). ` +
      `${opts.completed} scenario(s) completed and kept, ${unexplored.length} planned scenario(s) never explored. ` +
      `Continuing the pipeline with the survivors. Raise QA_CORE_COST_CEILING for broader runs.`;
  return {
    ...(opts.current ? { discardedInProgress: opts.current } : {}),
    unexplored,
    incomplete,
    summary,
  };
}

/**
 * The single repair pass for rework verdicts. Launches a fresh browser (the
 * exploration context is already closed by critic time), re-invokes the
 * Explorer with ONLY the rework scenarios as the plan, each carrying the
 * critic's reasons verbatim plus its recorded steps as the starting point,
 * and returns the re-recorded traces. Respects the remaining cost budget:
 * runAgentLoop's ceiling break applies, so completed repairs are salvaged.
 */
async function repairPass(args: {
  client: Anthropic;
  model: string;
  price: (typeof PRICE)[ModelId];
  remainingUsd: number;
  url: string;
  rework: Scenario[];
  verdicts: ScenarioVerdict[];
  onEvent?: ExploreOptions['onEvent'];
  /** The Explorer's credential context (known real accounts, lockout-exempt scenarios), applied to the repair context too. */
  credentials?: { knownAccounts: Set<string>; lockoutScenarioKeys: Set<string> };
}): Promise<{
  scenarios: Scenario[];
  cost: RunReport['cost'];
  steps: number;
  heals: Array<{ scenario?: string; intent: string; from: string; to: string }>;
  /** Human-readable notes about repair-internal outcomes (findings, incompletes). */
  notes: string[];
  /** Why a rework scenario was not re-recorded, by scenario name (the structured form of `notes`). */
  reasons: Record<string, string>;
}> {
  const plan: PlannedScenario[] = args.rework.map((s) => {
    const v = verdictFor(args.verdicts, s.name);
    return {
      name: s.name,
      category: s.category ?? 'happy',
      rationale: `REWORK: ${(v?.reasons ?? []).join('; ') || 'assertion too weak'}`,
      ...(s.feature ? { feature: s.feature } : {}),
    };
  });
  const repairNote = [
    'REPAIR PASS. The planned scenarios above were recorded earlier, but the Critic judged their assertions too weak. Re-record each one now:',
    '- Reuse the recorded steps below as your starting point; do not change what the scenario tests.',
    '- Strengthen exactly the named weaknesses: add the missing outcome assertion, replace the vacuous one.',
    '',
    ...args.rework.map((s) => {
      const v = verdictFor(args.verdicts, s.name);
      const fixes = v?.required_fixes?.length ? `\n  required fixes: ${v.required_fixes.join('; ')}` : '';
      return `"${s.name}"\n  critic reasons: ${(v?.reasons ?? []).join('; ') || '(none given)'}${fixes}\n  recorded steps: ${s.steps.map(describeStep).join(' -> ')}`;
    }),
  ].join('\n');

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const storageStatePath = path.join(process.cwd(), 'playwright', '.auth', 'user.json');
    context = await browser.newContext(
      fs.existsSync(storageStatePath) ? { storageState: storageStatePath } : undefined,
    );
    await installEvalShim(context);
    const page = await context.newPage();
    const maxSteps = stepBudgetFor(args.rework.length, 0);
    const ctx = createContext(page, maxSteps);
    if (args.credentials) {
      ctx.knownAccounts = new Set(args.credentials.knownAccounts);
      ctx.lockoutScenarioKeys = new Set(args.credentials.lockoutScenarioKeys);
    }
    const loop = await runAgentLoop({
      client: args.client,
      model: args.model,
      maxUsd: args.remainingUsd,
      price: args.price,
      maxSteps,
      ctx,
      url: args.url,
      plan,
      repairNote,
      onEvent: args.onEvent,
    });
    const notes: string[] = [];
    const reasons: Record<string, string> = {};
    if (loop.closeout) {
      notes.push(loop.closeout.closed
        ? `"${loop.closeout.scenario}" closed under the cost closeout grace ($${loop.closeout.usd.toFixed(4)}).`
        : `"${loop.closeout.scenario}" did not close within the cost closeout grace ($${loop.closeout.usd.toFixed(4)} spent).`);
    }
    if (ctx.current) {
      const why = loop.endedReason === 'cost_ceiling' ? 'mid-repair when the cost ceiling hit; the in-progress work is discarded' : 'left unfinished by the repair pass; discarded';
      notes.push(`"${ctx.current.name}" was ${why}.`);
      reasons[ctx.current.name] = why;
      ctx.current = null;
    }
    for (const f of ctx.findings) { notes.push(`finding during repair of "${f.scenario}": expected ${f.expected}, page stayed at ${f.url}.`); reasons[f.scenario] ??= `finding: expected ${f.expected}, URL at the time ${f.url}`; }
    for (const i of ctx.incomplete) { notes.push(`"${i.scenario}" not re-recorded: ${i.reason}.`); reasons[i.scenario] ??= i.reason; }
    for (const b of ctx.brokenByGate) { notes.push(`"${b.scenario}" rejected by the gate during repair: ${b.reason}.`); reasons[b.scenario] ??= `rejected by the gate: ${b.reason}`; }
    for (const s of ctx.skipped) { notes.push(`"${s.scenario}" skipped during repair: ${s.reason}.`); reasons[s.scenario] ??= `skipped: ${s.reason}`; }
    if (loop.endedReason === 'cost_ceiling') for (const p of plan) reasons[p.name] ??= 'never re-explored: the repair budget ran out first';
    return { scenarios: ctx.scenarios, cost: loop.cost, steps: ctx.steps, heals: ctx.heals, notes, reasons };
  } finally {
    await context?.close();
    await browser?.close();
  }
}

/** A requirements map narrowed to one feature, for per-page rule context. */
function subMapFor(map: RequirementsMap | undefined, feature: string | undefined): RequirementsMap | undefined {
  if (!map || !feature) return map;
  const matched = map.features.filter((f) => f.name === feature);
  return matched.length > 0 ? { ...map, features: matched } : map;
}

/**
 * Result of a paused review-mode run.
 *
 * The runtime returns this instead of a RunReport when review mode is active.
 * Callers should treat it as a terminal state and resume from the CSV later.
 */
export interface ReviewPaused {
  paused: true;
  planPath: string;
  scenarios: PlannedScenario[];
  outDir: string;
  url: string;
  language: 'ts' | 'js';
}

export type AgentEvent =
  | { type: 'plan_started' }
  | { type: 'plan_done'; scenarios: PlannedScenario[]; usd: number }
  | { type: 'review_paused'; planPath: string; scenarios: PlannedScenario[] }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; data?: unknown; error?: string }
  | { type: 'thinking_started' }
  | { type: 'message'; text: string }
  | { type: 'usage'; usd: number; tokens: number }
  | { type: 'critic_started' }
  | { type: 'critic_done'; verdicts: Array<{ scenario: string; verdict: string; reasons: string[]; required_fixes: string[] }>; usd: number }
  | { type: 'replay_started'; total: number }
  | { type: 'replay_scenario_passed'; name: string; durationMs: number }
  | { type: 'replay_scenario_failed'; name: string; failedStep: number; stepKind: string; error: string }
  | { type: 'replay_done'; passed: number; failed: number; durationMs: number }
  | { type: 'stability_started'; total: number; iterations: number }
  | { type: 'stability_iteration_passed'; name: string; iteration: number; durationMs: number }
  | { type: 'stability_iteration_failed'; name: string; iteration: number; failedStep: number; stepKind: string; error: string }
  | { type: 'stability_done'; stable: number; flaked: number; recovered?: number; iterations: number; flakeRate: number; durationMs: number; stabilizerCostUsd?: number }
  | { type: 'gate_injection'; scenario: string; step: number; assertionType: string; detail: string }
  | { type: 'gate_broken'; scenario: string; reason: string; attempts: number }
  // Reports an IN-RUN SELECTOR RECOVERY (a locator that failed to resolve was
  // re-resolved a different stable way during exploration). The type stays
  // 'heal' and the payload shape stays fixed because the dashboard consumes it.
  | { type: 'heal'; from: string; to: string; intent: string; scenario?: string }
  // The single repair pass (invariant 32): announced with its count and budget,
  // one event per re-explored scenario with its outcome, and a closing event
  // with the spend and the kept/dropped split from the verdict history.
  | RepairStartedEvent
  | RepairScenarioEvent
  | RepairDoneEvent
  | { type: 'done'; scenarios: number };

const PRICE = {
  // USD per million tokens.
  'claude-opus-4-7':   { in: 5.0,  out: 25.0, cacheRead: 0.5,  cacheWrite: 6.25 },
  'claude-sonnet-4-6': { in: 3.0,  out: 15.0, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5':  { in: 1.0,  out: 5.0,  cacheRead: 0.1,  cacheWrite: 1.25 },
} as const;

type ModelId = keyof typeof PRICE;

function priceFor(model: string): (typeof PRICE)[ModelId] {
  if (model in PRICE) return PRICE[model as ModelId];
  return PRICE['claude-opus-4-7'];
}

/** Orientation calls (navigate + get_dom) before any scenario starts. */
const ORIENTATION_STEPS = 6;
/**
 * Base per-scenario allowance for a light page. A scenario costs ~7 tool calls
 * of real work (begin, navigate, 2-4 actions, 1-2 asserts, end), plus room for
 * one gate-forced retry. This stays the floor per scenario so a low-field page
 * keeps its historical budget and does not balloon.
 */
const STEPS_PER_SCENARIO_BASE = 14;
/**
 * Non-fill work in a form scenario: begin, navigate, submit click, a get_dom,
 * one or two asserts, end. The fill count is added on top, so a scenario on an
 * f-field form is budgeted PER_SCENARIO_OVERHEAD + f. The form term only raises
 * the budget once 8 + f exceeds the base 14, i.e. past ~6 fillable fields, so
 * light pages are untouched and long forms scale by one step per extra field.
 */
const PER_SCENARIO_OVERHEAD = 8;
/** Cap the fill term so a pathological mega-form cannot run the budget away. */
const FILL_FIELD_CAP = 24;
/** Floor so the budget never regresses below the historical default of 40. */
const STEP_BUDGET_FLOOR = 40;

/**
 * Per-run Explorer step budget. Scales with BOTH the plan size and the form
 * complexity of the page: a scenario that fills a 12-field form genuinely needs
 * ~12 steps just for the fills, which the old scenario-count-only budget could
 * not cover (three such scenarios is ~36 fills against a 48-step budget). Each
 * scenario is budgeted `max(base, overhead + fillableFields)`, so a 1-action
 * page keeps the base 14 per scenario while a long form gets one step per field.
 * The $QA_CORE_MAX_USD ceiling is still the ultimate runaway guard.
 */
/**
 * The effective step budget: the formula, raised to the floor when one is
 * set (QA_CORE_MAX_STEPS, --max-steps, opts.maxSteps). The floor can only
 * raise the budget, so a setting can never cut a large plan short; the cost
 * ceiling is what stops a large run. Exported for smoke-settings.
 */
export function stepBudgetWithFloor(formula: number, floor?: number): number {
  return floor === undefined || !Number.isFinite(floor) ? formula : Math.max(formula, Math.floor(floor));
}

export function stepBudgetFor(planCount: number, fillableFields = 0): number {
  const n = Math.max(1, planCount);
  const f = Math.min(Math.max(0, fillableFields), FILL_FIELD_CAP);
  const perScenario = Math.max(STEPS_PER_SCENARIO_BASE, PER_SCENARIO_OVERHEAD + f);
  return Math.max(STEP_BUDGET_FLOOR, ORIENTATION_STEPS + perScenario * n);
}

export async function explore(opts: ExploreOptions): Promise<RunReport | ReviewPaused> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.');

  // Step budget. The adaptive formula (stepBudgetFor) is computed below once
  // the plan size is known; an explicit opts.maxSteps or QA_CORE_MAX_STEPS is
  // its FLOOR, never a cap (stepBudgetWithFloor): the run gets the larger of
  // the two. A fixed 40 was too tight for a 3-scenario plan once one gate
  // retry (a full begin..end cycle, ~7 calls) is spent.
  const maxStepsOverride =
    opts.maxSteps ?? (process.env.QA_CORE_MAX_STEPS ? Number(process.env.QA_CORE_MAX_STEPS) : undefined);
  // Cost ceiling. QA_CORE_COST_CEILING is the documented name; the older
  // QA_CORE_MAX_USD still works. Default unchanged ($2). Multi-page runs
  // should set a higher ceiling; hitting it no longer aborts the run (the
  // completed scenarios are salvaged, see salvageOnCostCeiling).
  const maxUsd = opts.maxUsd ?? Number(process.env.QA_CORE_COST_CEILING ?? process.env.QA_CORE_MAX_USD ?? 2);
  // Repair reserve: the Explorer runs under a reduced ceiling so the repair
  // pass is never handed $0 (the last live run spent the whole ceiling
  // exploring and every rework verdict dropped unrepaired). With the critic
  // skipped there is no repair pass, so the Explorer keeps the full ceiling.
  const { explorerUsd, reserveUsd } = opts.skipCritic
    ? { explorerUsd: maxUsd, reserveUsd: 0 }
    : splitCeiling(maxUsd);
  opts.onEvent?.({
    type: 'message',
    text: reserveUsd > 0
      ? `Cost ceiling: $${maxUsd.toFixed(2)} total — explorer $${explorerUsd.toFixed(2)}, repair reserve $${reserveUsd.toFixed(2)} (QA_CORE_REPAIR_RESERVE)`
      : `Cost ceiling: $${maxUsd.toFixed(2)} (no repair reserve)`,
  });
  // Both env names are honored: QA_CORE_EXPLORER_MODEL (documented) and the
  // older QA_CORE_MODEL_EXPLORE. Default unchanged.
  const model = opts.model ?? process.env.QA_CORE_EXPLORER_MODEL ?? process.env.QA_CORE_MODEL_EXPLORE ?? 'claude-opus-4-7';
  const price = priceFor(model);

  const client = new Anthropic({ apiKey });
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Step 1 — Planner (Haiku). Cheap, gives Explorer a guide.
  // Three paths through this stage:
  //   a) fromPlan supplied  → skip Planner entirely, use the approved list
  //   b) skipPlan set       → no plan at all (Explorer wanders on its own)
  //   c) default            → run Planner, then either pause (review) or continue
  let planResult: { scenarios: PlannedScenario[]; usd: number; fillableFields: number } = {
    scenarios: opts.fromPlan ?? [],
    usd: 0,
    // A resumed/skip-plan run has no fresh snapshot, so the form-aware term is 0
    // and the budget falls back to the scenario-count base. That is correct: with
    // no page scan we have no field count to scale by.
    fillableFields: 0,
  };

  // ── Checkpoint state ─────────────────────────────────────────────────────
  // Mutable snapshot of everything a resume needs. saveCheckpoint() writes it
  // atomically after every completed scenario and at each phase boundary; it
  // is deleted (by the CLI) only when the framework was actually written.
  const restoredCompleted: Scenario[] = opts.resume ? [...opts.resume.completedScenarios] : [];
  const cpState = {
    phase: 'discovery' as CheckpointPhase,
    plan: opts.resume?.plan ?? ([] as PlannedScenario[]),
    fillableFields: opts.resume?.fillableFields ?? 0,
    discovery: opts.resume?.discovery as RunReport['discovery'],
    completed: [...restoredCompleted],
    verdicts: opts.resume?.verdicts as ScenarioVerdict[] | undefined,
    spend: opts.resume
      ? { ...opts.resume.spentUsd }
      : { planner: 0, explorer: 0, critic: 0, repair: 0 },
  };
  const runStartedAt = opts.resume?.startedAt ?? startedAt;
  const saveCheckpoint = (): string => writeCheckpoint(opts.outDir, {
    version: CHECKPOINT_VERSION,
    url: opts.url,
    flags: {
      lang: opts.language,
      pom: opts.checkpointFlags?.pom !== false,
      features: opts.features ?? [],
      ...(opts.checkpointFlags?.srsPath ? { srs: opts.checkpointFlags.srsPath } : {}),
      discover: Boolean(opts.discover),
      urls: opts.urls ?? [],
    },
    ...(cpState.discovery ? { discovery: cpState.discovery } : {}),
    ...(opts.requirements ? { requirementsMap: opts.requirements } : {}),
    plan: cpState.plan,
    fillableFields: cpState.fillableFields,
    completedScenarios: cpState.completed,
    ...(cpState.verdicts && cpState.verdicts.length > 0 ? { verdicts: cpState.verdicts } : {}),
    spentUsd: { ...cpState.spend },
    phase: cpState.phase,
    nextScenarioIndex: cpState.completed.length,
    startedAt: runStartedAt,
    updatedAt: new Date().toISOString(),
  });
  // SIGINT: save what we have and exit with the resume hint, so an
  // interrupted run never loses its completed scenarios.
  const onSigint = (): void => {
    try {
      const p = saveCheckpoint();
      process.stderr.write('\n' + stopMessage('interrupted (SIGINT)', p) + '\n');
    } catch { /* saving is best effort on the way out */ }
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  // Multi-page discovery activates ONLY when the caller asked for it via
  // --discover, --urls, or --srs. With none of the three, the single plan()
  // call below runs exactly as before, byte for byte. A resumed run restores
  // its recorded discovery instead of re-running it.
  const discoveryActive =
    !opts.resume && !opts.fromPlan && !opts.skipPlan &&
    Boolean(opts.discover || (opts.urls && opts.urls.length > 0) || opts.requirements);
  let discoveryInfo: RunReport['discovery'];
  // True when planning stopped at a scenario cap (per-page or global). Turns
  // derivation skips into 'budget' instead of 'no-matching-control'.
  let planCapHit = false;
  // Scenarios the page-fit pass dropped (they named a control the page
  // snapshot does not show). Never in the plan; the derivation report names
  // the category they would have filled as skipped for 'page-fit'.
  let pageFitRejected: PlannedScenario[] = [];

  if (opts.resume) {
    // ── Resume: restore instead of re-doing ─────────────────────────────────
    // Discovery, the requirements map, the plan, completed traces, and spend
    // all come from the checkpoint. Nothing completed is ever re-explored.
    const cp = opts.resume;
    planResult = { scenarios: cp.plan, usd: cp.spentUsd.planner, fillableFields: cp.fillableFields };
    discoveryInfo = cp.discovery;
    const toGo = remainingPlan(cp.plan, restoredCompleted);
    opts.onEvent?.({
      type: 'message',
      text: `Resuming: ${restoredCompleted.length} completed scenario(s) restored, continuing at scenario ${restoredCompleted.length + 1} of ${cp.plan.length}, spend so far $${priorSpend(cp.spentUsd).toFixed(4)}`,
    });
    if (toGo.length === 0) {
      opts.onEvent?.({ type: 'message', text: 'Resume: every planned scenario is already completed; skipping straight to review.' });
    }
    opts.onEvent?.({ type: 'plan_done', scenarios: cp.plan, usd: 0 });
  } else if (discoveryActive) {
    opts.onEvent?.({ type: 'plan_started' });
    const disc = await discoverPages({
      entryUrl: opts.url,
      requirements: opts.requirements,
      userUrls: opts.urls,
    });
    for (const w of disc.warnings) {
      opts.onEvent?.({ type: 'message', text: `discovery: ${w}` });
    }

    // Relevance filter — only the remote-discovered sets (sitemap/crawl) are
    // trimmed. SRS pages are stated requirements and user pages are explicit
    // intent; both pass through whole.
    // Every page the rung found, before the filter: recorded on the report and
    // in discovery.json so a reader can see what was seen and not picked.
    let candidates = disc.pages;
    let pages = disc.pages;
    let plannerUsd = 0;
    if (FILTERED_SOURCES.has(disc.method)) {
      const featureNames = opts.requirements
        ? opts.requirements.features.map((f) => f.name)
        : opts.features;
      const filtered = await filterPages({ pages, features: featureNames, apiKey, ...(opts.requirements ? { featureTokens: featureTokenMap(opts.requirements) } : {}) });
      plannerUsd += filtered.costUsd;
      // One plan per path template: the other members are recorded on the
      // candidates (discovery.json, the Discovery panel) and never planned.
      if (filtered.sameTemplate.length > 0) {
        const byUrl = new Map(filtered.sameTemplate.map((p) => [p.url, p.sameTemplateAs!]));
        candidates = candidates.map((p) => (byUrl.has(p.url) ? { ...p, sameTemplateAs: byUrl.get(p.url)! } : p));
        const describe = (u: string): string => { try { return new URL(u).pathname; } catch { return u; } };
        opts.onEvent?.({
          type: 'message',
          text: `discovery: ${filtered.sameTemplate.length} page(s) share a path template with a planned page and are not planned: ${filtered.sameTemplate.map((p) => `${describe(p.url)} (same template as ${describe(p.sameTemplateAs!)})`).join(', ')}`,
        });
      }
      if (filtered.method !== 'passthrough') {
        opts.onEvent?.({
          type: 'message',
          text: `discovery: ${pages.length} page(s) narrowed to ${filtered.pages.length} (${filtered.method === 'llm' ? 'relevance pick' : 'deterministic fallback'})`,
        });
      }
      pages = filtered.pages;
    } else if (pages.length > MAX_PAGES_WITH_FEATURES) {
      opts.onEvent?.({
        type: 'message',
        text: `discovery: ${pages.length} ${disc.method} page(s) kept in full; planning stops at the ${GLOBAL_PLAN_CAP}-scenario cap, so later pages may not be reached.`,
      });
    }
    opts.onEvent?.({ type: 'message', text: `discovery: ${pages.length} page(s) via ${disc.method}` });
    discoveryInfo = { method: disc.method, pages, candidates, warnings: disc.warnings };
    try {
      writeDiscoveryJson(opts.outDir, discoveryInfo);
    } catch (err) {
      opts.onEvent?.({ type: 'message', text: `discovery: could not write discovery.json (${(err as Error).message})` });
    }
    // Phase boundary: discovery done.
    cpState.discovery = discoveryInfo;
    cpState.phase = 'discovery';
    saveCheckpoint();

    // An SRS feature with rules but no page tagged for it can only report
    // not-planned; say so now, at plan time, and never invent a URL for it.
    for (const f of unreachableFeatures(opts.requirements, pages)) {
      opts.onEvent?.({ type: 'message', text: unreachableFeatureLine(f) });
    }

    // Per-page planning: up to PER_PAGE_SCENARIO_CAP scenarios per page,
    // GLOBAL_PLAN_CAP total. Cost is itemized per page. A page whose plan
    // fails is skipped with a message; the other pages still plan.
    let combined: PlannedScenario[] = [];
    const combinedDropped: Array<{ scenario: PlannedScenario; duplicateOf: PlannedScenario }> = [];
    const combinedRejected: Array<{ scenario: PlannedScenario; reason: string }> = [];
    const combinedCitationDrops: Array<{ scenario: string; ruleId: string; reason: string }> = [];
    const pageFeatureOf = (url: string | undefined): string | undefined => pages.find((p) => p.url === url)?.feature;
    let fillableMax = 0;
    for (const [idx, pg] of pages.entries()) {
      if (combined.length >= GLOBAL_PLAN_CAP) {
        planCapHit = true;
        opts.onEvent?.({
          type: 'message',
          text: `Planner: global cap of ${GLOBAL_PLAN_CAP} scenarios reached; ${pages.length - idx} page(s) not planned.`,
        });
        break;
      }
      let p: Awaited<ReturnType<typeof plan>>;
      try {
        p = await plan({
          url: pg.url,
          apiKey,
          features: pg.feature ? [pg.feature] : opts.features,
          requirements: subMapFor(opts.requirements, pg.feature),
          ...(pg.volatile ? { volatilePage: true } : {}),
        });
      } catch (err) {
        // Billing/credit exhaustion or a persistent API failure must not be
        // silently absorbed as a per-page skip (the loop would skip EVERY
        // page and bill nothing but noise). Save state, say how to resume,
        // stop cleanly.
        const cls = classifyRunError(err);
        if (cls.kind !== 'other') {
          cpState.plan = combined;
          cpState.spend.planner = plannerUsd;
          cpState.phase = 'planning';
          const cpFile = saveCheckpoint();
          opts.onEvent?.({ type: 'message', text: stopMessage(cls.reason, cpFile) });
          process.removeListener('SIGINT', onSigint);
          throw new Error(stopMessage(cls.reason, cpFile));
        }
        opts.onEvent?.({
          type: 'message',
          text: `Planner failed on ${pg.url} (${(err as Error).message}); page skipped.`,
        });
        continue;
      }
      let scen = p.scenarios.map((s): PlannedScenario => ({
        ...s,
        pageUrl: pg.url,
        ...(pg.volatile ? { volatilePage: true } : {}),
        ...(pg.feature && !s.feature ? { feature: pg.feature } : {}),
      }));
      // Page fit: each drop is named with its page, and the scenario never
      // reaches the plan, so the funnel stays balanced.
      for (const r of p.pageFitRejected) {
        opts.onEvent?.({ type: 'message', text: `Rejected page-fit scenario: "${r.scenario.name}" on ${pg.url}: ${r.reason}` });
        pageFitRejected.push({ ...r.scenario, pageUrl: pg.url, ...(pg.feature && !r.scenario.feature ? { feature: pg.feature } : {}) });
      }
      if (scen.length > PER_PAGE_SCENARIO_CAP) {
        planCapHit = true;
        opts.onEvent?.({
          type: 'message',
          text: `Planner: ${pg.url} planned ${scen.length} scenarios, trimmed to the per-page cap of ${PER_PAGE_SCENARIO_CAP}.`,
        });
        scen = scen.slice(0, PER_PAGE_SCENARIO_CAP);
      }
      const room = GLOBAL_PLAN_CAP - combined.length;
      if (scen.length > room) { planCapHit = true; scen = scen.slice(0, room); }
      // The same feature + category + intent planned on two pages is one
      // scenario: the copy on the page tagged for its feature wins, else the
      // first in ladder order. The dropped copy never reaches the plan.
      const cross = dedupeAcrossPages(combined, scen, pg, pageFeatureOf);
      for (const d of cross.dropped) {
        const keptOn = d.duplicateOf.pageUrl ?? pg.url;
        const droppedOn = d.scenario.pageUrl ?? pg.url;
        opts.onEvent?.({ type: 'message', text: `Rejected cross-page duplicate: "${d.scenario.name}" on ${droppedOn} (same feature, category and intent as the scenario kept on ${keptOn})` });
      }
      combined = cross.existing;
      scen = cross.incoming;
      // Names unique across pages: skip_scenario, verdict matching and the
      // funnel key on the name, so a genuinely different scenario that shares
      // a name with one from another page gets the feature or path appended.
      const unique = uniqueScenarioNames(combined, scen, pg);
      for (const r of unique.renames) {
        opts.onEvent?.({ type: 'message', text: `Renamed duplicate scenario: "${r.from}" -> "${r.to}" (the same name was planned on another page)` });
      }
      scen = unique.scenarios;
      combined.push(...scen);
      combinedDropped.push(...p.dropped);
      combinedRejected.push(...p.rejected);
      combinedCitationDrops.push(...p.citationDrops);
      fillableMax = Math.max(fillableMax, p.fillableFields);
      plannerUsd += p.costUsd;
      opts.onEvent?.({
        type: 'message',
        text: `Planner [${idx + 1}/${pages.length}] ${pg.url}: ${scen.length} scenario(s) · $${p.costUsd.toFixed(4)}`,
      });
    }

    if (combined.length === 0) {
      throw new Error(
        `Planner produced 0 scenarios across ${pages.length} discovered page(s) for ${opts.url}. ` +
          `Stopping the run rather than letting the Explorer improvise without a plan.`,
      );
    }
    planResult = { scenarios: combined, usd: plannerUsd, fillableFields: fillableMax };
    // Phase boundary: plan done.
    cpState.plan = combined;
    cpState.fillableFields = fillableMax;
    cpState.spend.planner = plannerUsd;
    cpState.phase = 'planning';
    saveCheckpoint();
    opts.onEvent?.({ type: 'plan_done', scenarios: combined, usd: plannerUsd });
    for (const d of combinedDropped) {
      opts.onEvent?.({
        type: 'message',
        text: `Dropped near-duplicate scenario: "${d.scenario.name}" (same value + relation as "${d.duplicateOf.name}")`,
      });
    }
    for (const r of combinedRejected) {
      opts.onEvent?.({
        type: 'message',
        text: `Rejected circular scenario: "${r.scenario.name}" — ${r.reason}`,
      });
    }
    for (const c of combinedCitationDrops) {
      opts.onEvent?.({ type: 'message', text: `Dropped rule citation ${c.ruleId} from "${c.scenario}": ${c.reason}` });
    }
    if (opts.review) {
      process.removeListener('SIGINT', onSigint);
      fs.mkdirSync(opts.outDir, { recursive: true });
      const planPath = path.join(opts.outDir, 'plan.csv');
      fs.writeFileSync(planPath, scenariosToCsv(opts.url, combined));
      opts.onEvent?.({ type: 'review_paused', planPath, scenarios: combined });
      return {
        paused: true,
        planPath,
        scenarios: combined,
        outDir: opts.outDir,
        url: opts.url,
        language: opts.language,
      };
    }
  } else if (!opts.fromPlan && !opts.skipPlan) {
    opts.onEvent?.({ type: 'plan_started' });
    // A planner failure in the default path is fatal. We do NOT swallow it and
    // fall back to a blind Explorer run — improvising without a plan is exactly
    // the expensive wandering this pipeline exists to prevent (a blind register
    // run burned the whole budget). Billing/API exhaustion additionally saves
    // the checkpoint and prints the resume hint before stopping.
    let p: Awaited<ReturnType<typeof plan>>;
    try {
      p = await plan({ url: opts.url, apiKey, features: opts.features, requirements: opts.requirements });
    } catch (err) {
      const cls = classifyRunError(err);
      if (cls.kind !== 'other') {
        const cpFile = saveCheckpoint();
        opts.onEvent?.({ type: 'message', text: stopMessage(cls.reason, cpFile) });
        process.removeListener('SIGINT', onSigint);
        throw new Error(stopMessage(cls.reason, cpFile));
      }
      process.removeListener('SIGINT', onSigint);
      throw err;
    }

    // A genuinely empty plan must also stop the run. Handing a blank plan to the
    // Explorer makes it design scenarios on the fly at full Opus cost. Fail loud
    // with the URL and the most likely reason instead of proceeding.
    if (p.scenarios.length === 0) {
      throw new Error(
        `Planner produced 0 scenarios for ${opts.url}. The page may not have rendered ` +
          `its content, or it has nothing testable. Stopping the run rather than letting ` +
          `the Explorer improvise without a plan.`,
      );
    }

    planResult = { scenarios: p.scenarios, usd: p.costUsd, fillableFields: p.fillableFields };
    pageFitRejected = p.pageFitRejected.map((r) => r.scenario);
    // Phase boundary: plan done.
    cpState.plan = p.scenarios;
    cpState.fillableFields = p.fillableFields;
    cpState.spend.planner = p.costUsd;
    cpState.phase = 'planning';
    saveCheckpoint();
    opts.onEvent?.({ type: 'plan_done', scenarios: p.scenarios, usd: p.costUsd });
    for (const r of p.pageFitRejected) {
      opts.onEvent?.({ type: 'message', text: `Rejected page-fit scenario: "${r.scenario.name}" on ${opts.url}: ${r.reason}` });
    }
    for (const d of p.dropped) {
      opts.onEvent?.({
        type: 'message',
        text: `Dropped near-duplicate scenario: "${d.scenario.name}" (same value + relation as "${d.duplicateOf.name}")`,
      });
    }
    for (const r of p.rejected) {
      opts.onEvent?.({
        type: 'message',
        text: `Rejected circular scenario: "${r.scenario.name}" — ${r.reason}`,
      });
    }
    for (const c of p.citationDrops) {
      opts.onEvent?.({ type: 'message', text: `Dropped rule citation ${c.ruleId} from "${c.scenario}": ${c.reason}` });
    }

    // Review mode — write the CSV and pause. The caller resumes via fromPlan.
    if (opts.review) {
      process.removeListener('SIGINT', onSigint);
      fs.mkdirSync(opts.outDir, { recursive: true });
      const planPath = path.join(opts.outDir, 'plan.csv');
      fs.writeFileSync(planPath, scenariosToCsv(opts.url, p.scenarios));
      opts.onEvent?.({ type: 'review_paused', planPath, scenarios: p.scenarios });
      return {
        paused: true,
        planPath,
        scenarios: p.scenarios,
        outDir: opts.outDir,
        url: opts.url,
        language: opts.language,
      };
    }
  }

  // Step 2 — Explorer (Opus). The tool-use loop.
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let scenarios: Scenario[] = [];
  let cascadeStats: Record<CascadeLevel, number> = { role: 0, label: 0, placeholder: 0, text: 0, alt: 0, title: 0, testid: 0, css: 0, xpath: 0 };
  let steps = 0;
  let cost: RunReport['cost'] = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    usd: 0, plannerUsd: planResult.usd,
  };
  let brokenByGate: Array<{ scenario: string; reason: string; attempts: number }> = [];
  let gateInjectionLog: Array<{ scenario: string; stepIndex: number; assertionType: string; detail: string }> = [];
  // Scenarios begun but never finalized — recorded explicitly so reconciliation
  // can account for them (planned = generated + dropped + incomplete) instead of
  // letting them vanish.
  let incomplete: Array<{ scenario: string; reason: string }> = [];
  // Scenarios where the expected outcome never occurred (retry cap tripped).
  // Real findings, not budget casualties. Surfaced loudly below.
  let findings: Array<{ scenario: string; category?: string; expected: string; url: string; messages: string[] }> = [];
  // In-run selector recoveries applied during exploration (a failed locator
  // re-resolved a different, stable way). Carried into the report for human
  // visibility. The field keeps its `heals` name for the dashboard.
  let heals: Array<{ scenario?: string; intent: string; from: string; to: string }> = [];
  // Planned scenarios the Explorer explicitly skipped via skip_scenario, each
  // with its reason. A separate reconciliation term, never a silent gap.
  let skipped: Array<{ scenario: string; reason: string }> = [];
  // Set when the cost ceiling stopped the Explorer: what was kept, what was
  // discarded, and which planned scenarios were never started. Flows into the
  // reconciliation funnel (as incomplete entries) and rule coverage.
  let ceilingSalvage: CostCeilingSalvage | undefined;
  // Carried into the repair pass so its re-recorded negatives get the same credential rule.
  let explorerCredentialContext: { knownAccounts: Set<string>; lockoutScenarioKeys: Set<string> } | undefined;
  // Set on any abnormal end (ceiling, billing, API failure). Carried on the
  // report so the CLI keeps the checkpoint instead of deleting it.
  let stopped: RunReport['stopped'];

  try {
    browser = await chromium.launch({ headless: true });
    const storageStatePath = path.join(process.cwd(), 'playwright', '.auth', 'user.json');
    context = await browser.newContext(
      fs.existsSync(storageStatePath) ? { storageState: storageStatePath } : undefined,
    );
    await installEvalShim(context);
    const page: Page = await context.newPage();

    // A resumed run explores only what the checkpoint does not account for.
    const toExplore = opts.resume
      ? remainingPlan(planResult.scenarios, restoredCompleted)
      : planResult.scenarios;

    // Resolve the effective budget now that the plan size is known. An override
    // (opts or env) always wins; otherwise scale to the plan AND the form
    // complexity so a long-form page does not run dry mid-fill.
    const formulaSteps = stepBudgetFor(toExplore.length, planResult.fillableFields);
    const maxSteps = stepBudgetWithFloor(formulaSteps, maxStepsOverride);
    opts.onEvent?.({
      type: 'message',
      text: `Step budget: ${maxSteps} (${toExplore.length} scenario(s), ${planResult.fillableFields} fillable field(s) on the page; formula ${formulaSteps}${maxStepsOverride !== undefined ? `, floor ${maxStepsOverride} from QA_CORE_MAX_STEPS` : ''})`,
    });

    // Prior spend counts against the SAME total ceiling on resume; the loop
    // gets whatever is left of the explorer share (the env ceiling read now
    // may be higher than at the original run, which is the top-up flow).
    const loopBudgetUsd = Math.max(0, explorerUsd - (opts.resume ? priorSpend(cpState.spend) : 0));

    const ctx = createContext(page, maxSteps);
    // Wrong-credential negatives: the real accounts the tool must not spend,
    // and the planned scenarios whose rule names a locked account (exempt).
    ctx.knownAccounts = new Set(knownAccountIdentifiers(opts.requirements));
    ctx.lockoutScenarioKeys = new Set(lockoutScenarioNames(toExplore, opts.requirements).map(scenarioNameKey));
    explorerCredentialContext = { knownAccounts: ctx.knownAccounts, lockoutScenarioKeys: ctx.lockoutScenarioKeys };
    const explorerLoop = toExplore.length === 0
      ? { cost: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0 }, endedReason: 'finished' as const }
      : await runAgentLoop({
          client, model, maxUsd: loopBudgetUsd, price, maxSteps,
          ctx, url: opts.url,
          plan: toExplore,
          onEvent: opts.onEvent,
          // Per-scenario checkpoint: crash-safe by construction, trivial cost.
          onScenarioComplete: (loopUsd) => {
            cpState.completed = [...restoredCompleted, ...ctx.scenarios];
            cpState.spend.explorer = (opts.resume?.spentUsd.explorer ?? 0) + loopUsd;
            cpState.phase = 'exploring';
            saveCheckpoint();
          },
        });
    const explorerCost = explorerLoop.cost;

    // The agent must call finish; if it didn't, decide what to do with the
    // scenario left in progress. Two distinct cases:
    //
    //   (a) Budget exhausted — the step/turn budget ran out mid-scenario. The
    //       scenario is unfinished and was never validated. Record it as
    //       INCOMPLETE with an explicit reason so reconciliation counts it.
    //       Do NOT salvage it: its assertions may be partial and Replay /
    //       Stability never saw it.
    //
    //   (b) Model stopped on its own — it may have done the real work and just
    //       forgotten to call end_scenario / finish. Salvage it if it is
    //       well-formed (has an assertion and passes the gate), otherwise mark
    //       it incomplete rather than dropping it silently. Without this, an
    //       abandoned empty scenario would pass Replay / Stability / Playwright
    //       vacuously and inflate failure rates.
    //   (c) Cost ceiling — stop cleanly and salvage. Every completed scenario
    //       is kept, ONLY the in-progress one is discarded, and each planned
    //       scenario that never started is recorded as incomplete so nothing
    //       vanishes from the funnel. The pipeline continues on the survivors.
    if (explorerLoop.endedReason === 'cost_ceiling' || explorerLoop.endedReason === 'run_stopped') {
      const begun = [
        ...ctx.scenarios.map((s) => s.name),
        ...ctx.brokenByGate.map((b) => b.scenario),
        ...ctx.incomplete.map((i) => i.scenario),
        ...ctx.findings.map((f) => f.scenario),
        ...ctx.skipped.map((s) => s.scenario),
        ...(ctx.current ? [ctx.current.name] : []),
      ];
      const stop = explorerLoop.endedReason === 'run_stopped' ? explorerLoop.stop : undefined;
      ceilingSalvage = salvageOnCostCeiling({
        planned: toExplore,
        begun,
        completed: ctx.scenarios.length,
        ...(ctx.current ? { current: ctx.current.name } : {}),
        costUsd: explorerLoop.cost.usd,
        ceilingUsd: loopBudgetUsd,
        ...(stop ? { cause: stop.reason } : {}),
      });
      ctx.incomplete.push(...ceilingSalvage.incomplete);
      ctx.current = null;
      opts.onEvent?.({ type: 'message', text: ceilingSalvage.summary });
      // 'other' never reaches here: the loop rethrows genuine bugs.
      stopped = stop && stop.kind !== 'other'
        ? { kind: stop.kind, reason: stop.reason }
        : {
            kind: 'cost_ceiling',
            reason: `cost ceiling hit ($${explorerLoop.cost.usd.toFixed(4)} against the explorer share); raise QA_CORE_COST_CEILING and resume`,
            // The closeout grace record: which scenario the grace closed (or
            // failed to close) and what it cost, so the run page can show it.
            ...(explorerLoop.closeout ? { closeout: explorerLoop.closeout } : {}),
          };
    } else if (ctx.current) {
      const budgetHit = explorerLoop.endedReason === 'budget' || ctx.steps >= maxSteps;
      if (budgetHit) {
        ctx.incomplete.push({ scenario: ctx.current.name, reason: 'step budget exhausted' });
        opts.onEvent?.({
          type: 'message',
          text: `Scenario "${ctx.current.name}" left INCOMPLETE: step budget exhausted (${ctx.steps}/${maxSteps} steps).`,
        });
      } else {
        const hasAssert = ctx.current.steps.some((s) => s.kind === 'assert');
        if (hasAssert) {
          // Gate also runs here so abandoned scenarios don't skip validation
          const { runGate } = await import('./gate.js');
          const gr = runGate(ctx.current);
          if (gr.violations.length === 0) {
            for (const inj of gr.injections) {
              ctx._gateInjectionLog.push({
                scenario: ctx.current.name,
                stepIndex: inj.stepIndex,
                assertionType: inj.assertionType,
                detail: inj.detail,
              });
            }
            ctx.scenarios.push(ctx.current);
          } else {
            const firstV = gr.violations[0]!;
            ctx.brokenByGate.push({ scenario: ctx.current.name, reason: gateBrokenReason(firstV.rule), attempts: 1 });
          }
        } else {
          ctx.incomplete.push({ scenario: ctx.current.name, reason: 'explorer stopped before finalizing (no assertion recorded)' });
        }
      }
    }
    // A resumed run's pipeline sees the UNION of restored and new scenarios,
    // exactly as a single run would.
    scenarios = opts.resume ? [...restoredCompleted, ...ctx.scenarios] : ctx.scenarios;
    cascadeStats = ctx.cascadeStats;
    steps = ctx.steps;
    cost = { ...explorerCost, plannerUsd: planResult.usd };
    if (opts.resume) {
      // Spend carries over: prior explorer + repair fold into the explorer
      // bucket; prior critic seeds criticUsd (the critic block accumulates).
      cost.usd += opts.resume.spentUsd.explorer + opts.resume.spentUsd.repair;
      if (opts.resume.spentUsd.critic > 0) cost.criticUsd = opts.resume.spentUsd.critic;
    }
    brokenByGate = ctx.brokenByGate;
    gateInjectionLog = ctx._gateInjectionLog;
    incomplete = ctx.incomplete;
    findings = ctx.findings;
    heals = ctx.heals;
    skipped = ctx.skipped;
    // Phase boundary: explorer done. On an abnormal stop this is the state a
    // resume continues from; print the hint alongside.
    cpState.completed = scenarios;
    cpState.spend.explorer = (opts.resume?.spentUsd.explorer ?? 0) + explorerCost.usd;
    cpState.phase = 'explored';
    const cpFileAfterExplore = saveCheckpoint();
    if (stopped) {
      opts.onEvent?.({ type: 'message', text: stopMessage(stopped.reason, cpFileAfterExplore) });
    }
  } finally {
    await context?.close();
    await browser?.close();
  }

  // Emit gate events so the CLI and gateway can surface them
  for (const inj of gateInjectionLog) {
    opts.onEvent?.({ type: 'gate_injection', scenario: inj.scenario, step: inj.stepIndex, assertionType: inj.assertionType, detail: inj.detail });
  }
  for (const broken of brokenByGate) {
    opts.onEvent?.({ type: 'gate_broken', scenario: broken.scenario, reason: broken.reason, attempts: broken.attempts });
  }
  // Surface findings loudly: the expected success signal never appeared, so the
  // scenario is a real finding, not a green test and not a silent drop.
  for (const f of findings) {
    const where = f.messages.length ? ` Page said: ${f.messages.join(' | ')}.` : ' No visible message on the page.';
    opts.onEvent?.({
      type: 'message',
      text: `Finding: "${f.scenario}" — expected ${f.expected}, but the page stayed at ${f.url}.${where} Recorded as a finding, not retried.`,
    });
  }

  // Step 3 — Critic (Sonnet). Reviews what the Explorer recorded. A resumed
  // run carries the verdicts the original run already paid for: only the
  // scenarios with no checkpoint verdict are reviewed, never a double spend.
  let review: RunReport['review'];
  if (!opts.skipCritic && scenarios.length > 0) {
    opts.onEvent?.({ type: 'critic_started' });
    try {
      const { toReview, carriedVerdicts } = splitCarriedVerdicts(scenarios, opts.resume?.verdicts ?? []);
      if (carriedVerdicts.length > 0) {
        opts.onEvent?.({
          type: 'message',
          text: `Resume: ${carriedVerdicts.length} verdict(s) carried from the original run; reviewing ${toReview.length} new scenario(s).`,
        });
      }
      if (toReview.length === 0) {
        review = { verdicts: carriedVerdicts, summary: 'All verdicts carried from the checkpoint; no new scenarios to review.' };
        opts.onEvent?.({ type: 'critic_done', verdicts: carriedVerdicts, usd: 0 });
      } else {
        const c = await critique({ scenarios: toReview, url: opts.url, apiKey });
        // Verdicts keyed by the recorded scenario name they match, so drops,
        // coverage and the run page all use one name per scenario.
        review = { verdicts: [...carriedVerdicts, ...alignVerdictNames(toReview.map((s) => s.name), c.verdicts)], summary: c.summary };
        for (const w of c.warnings) opts.onEvent?.({ type: 'message', text: `WARNING: ${w}` });
        if (c.unreviewed.length > 0) {
          opts.onEvent?.({
            type: 'message',
            text: `WARNING: the Critic returned no verdict for ${c.unreviewed.length} scenario(s); held as rework, never replayed unreviewed: ${c.unreviewed.map((n) => `"${n}"`).join(', ')}`,
          });
        }
        // Nothing parsed: keep the verbatim response on the report so the
        // cause is readable there, not reconstructed from memory.
        // Nothing parsed at all (every scenario held): keep the raw text.
        if (toReview.length > 0 && c.unreviewed.length === toReview.length && c.raw) review.rawResponse = c.raw;
        // Accumulate (a resumed run seeds criticUsd with the prior spend).
        cost.criticUsd = (cost.criticUsd ?? 0) + c.costUsd;
        opts.onEvent?.({ type: 'critic_done', verdicts: review.verdicts, usd: c.costUsd });
      }
      if (review.rawResponse !== undefined) {
        // The call succeeded and was paid for, but nothing parsed. That means
        // the response format drifted and the critic gate cannot act this run.
        // Say so loudly instead of printing "0 verdicts" as if it were normal.
        opts.onEvent?.({
          type: 'message',
          text: `Warning: Critic reviewed ${scenarios.length} scenario(s) but returned no parseable verdicts; every scenario is held as rework (none replays unreviewed). Check parseVerdicts in critic.ts against the response format.`,
        });
      }
    } catch (err) {
      // The pipeline continues either way (replay/stability are LLM-free),
      // but billing/API exhaustion marks the run stopped so the checkpoint
      // survives and the resume hint prints.
      const cls = classifyRunError(err);
      if (cls.kind !== 'other') {
        stopped ??= { kind: cls.kind, reason: cls.reason };
        cpState.phase = 'reviewing';
        const cpFile = saveCheckpoint();
        opts.onEvent?.({ type: 'message', text: stopMessage(cls.reason, cpFile) });
      }
      opts.onEvent?.({ type: 'message', text: `Critic skipped: ${(err as Error).message}` });
    }
  }

  // Gate on critic. 'reject' drops for good. 'rework' earns ONE repair pass:
  // the Explorer is re-invoked with only the rework scenarios, each carrying
  // the critic's reasons verbatim and its recorded steps as the starting
  // point; the critic re-reviews the repaired traces, and a second-time
  // rework or reject drops for real (no loops, structurally one pass).
  // 'pass' continues to Reality-Check (Step 4).
  let scenariosForReplay = scenarios;
  if (review && !opts.skipCritic) {
    const split = splitGate(scenarios, review.verdicts);
    if (split.rejected.length > 0) {
      opts.onEvent?.({
        type: 'message',
        text: `Critic rejected ${split.rejected.length} scenario(s), dropped: ${split.rejected.map((s) => `"${s.name}"`).join(', ')}`,
      });
    }
    let kept = split.kept;
    // The single entry decision for the repair pass. decideRepairPass returns
    // null only when NO rework verdicts exist; otherwise its line is ALWAYS
    // printed (run or skip, with the reason), so silent non-execution is
    // impossible. The budget is the full stated reserve, as promised at run
    // start, and the line states the per-scenario explorer cost observed in
    // this run against it.
    const ruleIdsByKey = new Map<string, string[]>();
    for (const p of planResult.scenarios) ruleIdsByKey.set(scenarioNameKey(p.name), p.ruleIds ?? []);
    const stepsByKey = new Map(scenarios.map((s) => [scenarioNameKey(s.name), s.steps.length]));
    const decision = decideRepairPass({
      scenarios,
      verdicts: review.verdicts,
      reserveUsd,
      // The budget is the whole ceiling minus what the run has spent at this
      // point (explorer, planner, critic), never below the reserve.
      ceilingUsd: maxUsd,
      spentUsd: cost.usd + (cost.plannerUsd ?? 0) + (cost.criticUsd ?? 0),
      explorerUsd: cost.usd - (cost.repairUsd ?? 0),
      recorded: scenarios.length,
      ruleIdsFor: (name) => ruleIdsByKey.get(scenarioNameKey(name)) ?? [],
      stepsFor: (name) => stepsByKey.get(scenarioNameKey(name)) ?? 1,
    });
    if (decision) {
      opts.onEvent?.({ type: 'message', text: decision.line });
      // Every unfunded rework is a repair_scenario event with its cause, so
      // the live Review panel and events.jsonl name why it was never repaired.
      for (const s of decision.unfunded) opts.onEvent?.({ type: 'repair_scenario', name: s.name, outcome: 'not re-recorded', reason: `not repaired: ${decision.fundsLabel}` });
      let secondVerdicts: Awaited<ReturnType<typeof critique>>['verdicts'] | null = null;
      let repairUsd = 0;
      if (decision.run) {
        opts.onEvent?.({ type: 'repair_started', count: decision.rework.length, budgetUsd: decision.budgetUsd });
        try {
          const repair = await repairPass({
            client, model, price, remainingUsd: decision.budgetUsd,
            url: opts.url,
            rework: decision.rework,
            verdicts: review.verdicts,
            onEvent: opts.onEvent,
            ...(explorerCredentialContext ? { credentials: explorerCredentialContext } : {}),
          });
          cost.inputTokens += repair.cost.inputTokens;
          cost.outputTokens += repair.cost.outputTokens;
          cost.cacheReadTokens += repair.cost.cacheReadTokens;
          cost.cacheCreationTokens += repair.cost.cacheCreationTokens;
          cost.usd += repair.cost.usd;
          cost.repairUsd = (cost.repairUsd ?? 0) + repair.cost.usd;
          // The per-call record and the cache share cover both loops; the
          // closeout grace spend adds up across them.
          cost.calls = [...(cost.calls ?? []), ...(repair.cost.calls ?? [])];
          cost.cachedInputShare = cachedInputShare(cost);
          if (repair.cost.closeoutGraceUsd) cost.closeoutGraceUsd = (cost.closeoutGraceUsd ?? 0) + repair.cost.closeoutGraceUsd;
          steps += repair.steps;
          cpState.spend.repair += repair.cost.usd;
          // Heals carry over (no funnel impact). The repair attempt's own
          // incomplete/finding entries are NOT merged: each rework scenario is
          // already accounted for once, by its FINAL verdict, and adding them
          // would double-count the funnel. They surface as messages instead.
          heals.push(...repair.heals);
          repairUsd = repair.cost.usd;
          for (const note of repair.notes) {
            opts.onEvent?.({ type: 'message', text: `repair: ${note}` });
          }
          for (const ev of repairScenarioEvents(decision.rework.map((s) => s.name), repair.scenarios.map((s) => s.name), repair.reasons)) opts.onEvent?.(ev);
          if (repair.scenarios.length > 0) {
            const c2 = await critique({ scenarios: repair.scenarios, url: opts.url, apiKey });
            cost.criticUsd = (cost.criticUsd ?? 0) + c2.costUsd;
            secondVerdicts = alignVerdictNames(repair.scenarios.map((s) => s.name), c2.verdicts);
            for (const w of c2.warnings) opts.onEvent?.({ type: 'message', text: `WARNING: ${w}` });
            if (c2.unreviewed.length > 0) {
              opts.onEvent?.({ type: 'message', text: `WARNING: the Critic returned no verdict for ${c2.unreviewed.length} repaired scenario(s); held as rework: ${c2.unreviewed.map((n) => `"${n}"`).join(', ')}` });
            }
            opts.onEvent?.({ type: 'critic_done', verdicts: c2.verdicts, usd: c2.costUsd });
          } else {
            secondVerdicts = [];
          }
          kept = [...kept, ...repair.scenarios.filter((s) => verdictFor(secondVerdicts ?? [], s.name)?.verdict === 'pass')];
        } catch (err) {
          const cls = classifyRunError(err);
          if (cls.kind !== 'other') {
            stopped ??= { kind: cls.kind, reason: cls.reason };
            cpState.phase = 'reviewing';
            const cpFile = saveCheckpoint();
            opts.onEvent?.({ type: 'message', text: stopMessage(cls.reason, cpFile) });
          }
          opts.onEvent?.({
            type: 'message',
            text: `Repair pass failed (${(err as Error).message}); rework scenario(s) dropped.`,
          });
          secondVerdicts = null;
        }
      }
      const merged = mergeRepairVerdicts(review.verdicts, secondVerdicts, decision.unfunded.length > 0 ? { names: decision.unfunded.map((s) => s.name), reason: decision.fundsLabel } : undefined);
      review = { verdicts: merged.final, summary: review.summary, repair: merged.history };
      for (const h of merged.history) {
        opts.onEvent?.({
          type: 'message',
          text: `Repair verdict: "${h.scenario}" rework -> ${h.second ?? (h.notRepaired ? `not repaired (${h.notRepaired})` : 'not re-recorded')} (${h.outcome})`,
        });
      }
      if (decision.run) opts.onEvent?.(repairDoneEvent(merged.history, repairUsd));
    }
    scenariosForReplay = kept;
  }

  // Step 4 — Reality check (replay). Re-execute every passing scenario in a fresh
  // Playwright context and drop the ones that fail. Survivors are what the
  // Transcriber emits. Zero LLM cost; this is just Playwright.
  let replayInfo: RunReport['replay'];
  let emittedScenarios = scenariosForReplay;
  if (!opts.skipReplay && scenariosForReplay.length > 0) {
    try {
      const storageStatePath = path.join(process.cwd(), 'playwright', '.auth', 'user.json');
      const r = await replay({
        scenarios: scenariosForReplay,
        storageStatePath,
        timeoutMs: opts.replayTimeoutMs,
        onEvent: (ev: ReplayEvent) => {
          switch (ev.type) {
            case 'replay_started':
              opts.onEvent?.({ type: 'replay_started', total: ev.total });
              return;
            case 'scenario_passed':
              opts.onEvent?.({ type: 'replay_scenario_passed', name: ev.name, durationMs: ev.durationMs });
              return;
            case 'scenario_failed':
              opts.onEvent?.({
                type: 'replay_scenario_failed',
                name: ev.name,
                failedStep: ev.failedStep,
                stepKind: ev.stepKind,
                error: ev.error,
              });
              return;
            case 'replay_done':
              opts.onEvent?.({
                type: 'replay_done',
                passed: ev.passed,
                failed: ev.failed,
                durationMs: ev.durationMs,
              });
              return;
            default:
              return;
          }
        },
      });
      emittedScenarios = r.emitted;
      replayInfo = {
        passed: r.emitted.length,
        failed: r.dropped.length,
        durationMs: r.durationMs,
        verdicts: r.verdicts,
      };
    } catch (err) {
      opts.onEvent?.({ type: 'message', text: `Replay skipped: ${(err as Error).message}` });
      replayInfo = { skipped: true, passed: 0, failed: 0, durationMs: 0, verdicts: [] };
    }
  } else if (opts.skipReplay) {
    replayInfo = { skipped: true, passed: 0, failed: 0, durationMs: 0, verdicts: [] };
  }

  // Step 5 — Stability iteration. Re-execute each replay survivor N times and
  // drop the ones that pass-then-fail. Only scenarios that pass every
  // iteration make it into the final emitted spec.
  let stabilityInfo: RunReport['stability'];
  if (!opts.skipStability && emittedScenarios.length > 0) {
    try {
      const storageStatePath = path.join(process.cwd(), 'playwright', '.auth', 'user.json');
      const s = await stability({
        scenarios: emittedScenarios,
        storageStatePath,
        iterations: opts.stabilityIterations,
        timeoutMs: opts.replayTimeoutMs,
        stabilize: opts.stabilize,
        stabilizerModel: opts.stabilizerModel,
        maxStabilizeAttempts: opts.maxStabilizeAttempts,
        onEvent: (ev: StabilityEvent) => {
          switch (ev.type) {
            case 'stability_started':
              opts.onEvent?.({ type: 'stability_started', total: ev.total, iterations: ev.iterations });
              return;
            case 'iteration_passed':
              opts.onEvent?.({
                type: 'stability_iteration_passed',
                name: ev.name,
                iteration: ev.iteration,
                durationMs: ev.durationMs,
              });
              return;
            case 'iteration_failed':
              opts.onEvent?.({
                type: 'stability_iteration_failed',
                name: ev.name,
                iteration: ev.iteration,
                failedStep: ev.failedStep,
                stepKind: ev.stepKind,
                error: ev.error,
              });
              return;
            case 'stability_done':
              opts.onEvent?.({
                type: 'stability_done',
                stable: ev.stable,
                flaked: ev.flaked,
                recovered: ev.recovered,
                iterations: ev.iterations,
                flakeRate: ev.flakeRate,
                durationMs: ev.durationMs,
                stabilizerCostUsd: ev.stabilizerCostUsd,
              });
              return;
            // Stabilizer events — forward as 'message' (no dedicated event
            // type in the runtime ExploreEvent enum; gateway + UI parse
            // these strings like other stability messages). Each event
            // includes attempt number so the user sees multi-attempt progress.
            case 'stabilize_started':
              opts.onEvent?.({ type: 'message', text: `  ↻ trying to recover flaky scenario: ${ev.name}` });
              return;
            case 'stabilize_proposed':
              opts.onEvent?.({
                type: 'message',
                text: `    attempt ${ev.attempt} — Stabilizer proposed: ${ev.proposalKind} — ${ev.reason} ($${ev.costUsd.toFixed(4)})`,
              });
              return;
            case 'stabilize_attempt_failed':
              opts.onEvent?.({
                type: 'message',
                text: `    attempt ${ev.attempt} didn't take (pattern ${ev.pattern}) — trying again with a different strategy`,
              });
              return;
            case 'stabilize_recovered':
              opts.onEvent?.({
                type: 'message',
                text: `  ✓ recovered ${ev.name} — stable after ${ev.attempts} attempt${ev.attempts === 1 ? '' : 's'} (${ev.winningStrategy})`,
              });
              return;
            case 'stabilize_unfixed':
              opts.onEvent?.({
                type: 'message',
                text: `  ✗ Stabilizer gave up on ${ev.name} after ${ev.attempts} attempt${ev.attempts === 1 ? '' : 's'} (tried: ${ev.triedStrategies.join(' → ') || 'nothing usable'})`,
              });
              return;
            default:
              return;
          }
        },
      });
      emittedScenarios = s.emitted;
      stabilityInfo = {
        iterations: s.iterations,
        passed: s.emitted.length,
        flaked: s.flaked.length,
        flaky: s.flaky.length,
        broken: s.broken.length,
        recovered: s.recovered.length,
        stabilizerCostUsd: s.stabilizerCostUsd,
        flakeRate: s.flakeRate,
        durationMs: s.durationMs,
        verdicts: s.verdicts,
        // Stabilizer spend with no attempt recorded is an inconsistency, never
        // shown as "none recorded": the report carries the warning.
        ...(s.warning ? { warning: s.warning } : {}),
      };
      if (s.warning) opts.onEvent?.({ type: 'message', text: `WARNING: ${s.warning}` });
    } catch (err) {
      opts.onEvent?.({ type: 'message', text: `Stability skipped: ${(err as Error).message}` });
      stabilityInfo = {
        skipped: true,
        iterations: opts.stabilityIterations ?? 3,
        passed: 0,
        flaked: 0,
        flakeRate: 0,
        durationMs: 0,
        verdicts: [],
      };
    }
  } else if (opts.skipStability) {
    stabilityInfo = {
      skipped: true,
      iterations: opts.stabilityIterations ?? 3,
      passed: 0,
      flaked: 0,
      flakeRate: 0,
      durationMs: 0,
      verdicts: [],
    };
  }

  const gateData: RunReport['gate'] = (brokenByGate.length > 0 || gateInjectionLog.length > 0)
    ? { broken: brokenByGate, injections: gateInjectionLog }
    : undefined;

  // SRS runs: carry each planned scenario's rule citations onto the emitted
  // scenario that fulfilled it (matched by name), so ruleIds land in the
  // RunReport and the emitted scenarios themselves.
  if (opts.requirements) {
    attachRuleIds(emittedScenarios, planResult.scenarios);
  }

  // Review boundary: final spend + verdict snapshot into the checkpoint (kept
  // on any abnormal end; the CLI deletes it only after the framework is
  // written). Carrying the FINAL verdicts means a resume never re-reviews a
  // scenario the original run already paid the critic for.
  cpState.spend.critic = cost.criticUsd ?? 0;
  if (review?.verdicts.length) cpState.verdicts = review.verdicts;
  cpState.phase = 'reviewing';
  saveCheckpoint();

  const report: RunReport = {
    url: opts.url,
    language: opts.language,
    ...(stopped ? { stopped } : {}),
    ...(discoveryInfo ? { discovery: discoveryInfo } : {}),
    scenarios: emittedScenarios,
    cascadeStats,
    cost,
    steps,
    startedAt,
    finishedAt: new Date().toISOString(),
    plan: planResult.scenarios.length > 0 ? planResult.scenarios : undefined,
    review,
    gate: gateData,
    replay: replayInfo,
    stability: stabilityInfo,
    incomplete: incomplete.length > 0 ? incomplete : undefined,
    findings: findings.length > 0 ? findings : undefined,
    heals: heals.length > 0 ? heals : undefined,
    skipped: skipped.length > 0 ? skipped : undefined,
  };

  // Reporting reconciliation — planned === generated + dropped, with every
  // dropped scenario named. Attached so the CLI, gateway, and run-report.json
  // all share one auditable funnel.
  // A name in two funnel buckets is a run problem said out loud, never a
  // "+1 added" that balances the identity by accident.
  report.reconciliation = reconcile(report, { onDuplicate: (m) => opts.onEvent?.({ type: 'message', text: `WARNING: ${m}` }) });

  // Rule coverage: classify every stated rule as covered, planned-but-dropped,
  // or not-planned. Attached to the report and written to its own file so the
  // "considered, not automated" list survives alongside run-report.json.
  if (opts.requirements) {
    report.ruleCoverage = {
      ...computeRuleCoverage({
        map: opts.requirements,
        planned: planResult.scenarios,
        scenarios: emittedScenarios,
        // Rules cited only by scenarios the ceiling prevented from starting
        // classify planned-not-explored, never planned-but-dropped.
        unexplored: ceilingSalvage?.unexplored,
        // The drop cause per scenario, so an uncovered rule says why its
        // citing scenario fell out ("rework, not repaired: reserve funds 2 of 14").
        dropReasons: new Map(report.reconciliation.dropped.map((d) => [d.name, d.reason])),
      }),
      // Derivation: which checklist categories produced scenarios per feature
      // and which were skipped, with the reason. The considered-not-automated
      // record alongside the rule list.
      derivation: computeDerivation({
        map: opts.requirements,
        planned: planResult.scenarios,
        budgetHit: planCapHit,
        pageFitRejected,
      }),
    };
    for (const line of renderRuleCoverage(report.ruleCoverage)) {
      opts.onEvent?.({ type: 'message', text: line });
    }
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(
    path.join(opts.outDir, 'run-report.json'),
    JSON.stringify(report, null, 2),
  );
  if (report.ruleCoverage) {
    fs.writeFileSync(
      path.join(opts.outDir, 'rule-coverage.json'),
      JSON.stringify(report.ruleCoverage, null, 2),
    );
  }

  // Persist what we learned for future runs against the same host.
  const resolvedIntents = collectResolvedIntents(scenarios);
  const summary: RunSummary = {
    url: opts.url,
    scenarios: scenarios.length,
    cost: (cost.usd ?? 0) + (cost.plannerUsd ?? 0) + (cost.criticUsd ?? 0),
    model,
    durationSec: Math.round((Date.now() - startMs) / 1000),
    cascadeStats,
    resolvedIntents,
  };
  try { saveRun(summary); } catch (err) {
    // Memory is best-effort, but silent failure is worse than a one-line warning.
    process.stderr.write(`[qa-core] memory save failed: ${(err as Error).message}\n`);
  }

  process.removeListener('SIGINT', onSigint);
  opts.onEvent?.({ type: 'done', scenarios: scenarios.length });
  return report;
}

/**
 * Convert planned scenarios to a reviewable CSV. A Page column is added only
 * when a scenario carries a pageUrl (multi-page discovery), so single-page
 * review CSVs keep their exact pre-discovery shape.
 */
function scenariosToCsv(url: string, scenarios: PlannedScenario[]): string {
  const header = `# QA-Core review plan for ${url}\n# Set Approve=no on any row you do not want to test, then resume with:\n#   npm run explore -- --from-plan <this-file>\n\n`;
  const multiPage = scenarios.some((s) => s.pageUrl);
  return header + writeCsv(
    scenarios.map((s, i) => ({
      '#': String(i + 1),
      Category: s.category,
      Scenario: s.name,
      Rationale: s.rationale,
      ...(multiPage ? { Page: s.pageUrl ?? '' } : {}),
      Approve: 'yes',
    })),
    multiPage
      ? ['#', 'Category', 'Scenario', 'Rationale', 'Page', 'Approve']
      : ['#', 'Category', 'Scenario', 'Rationale', 'Approve'],
  );
}

/** Walk every scenario's trace and collect the intent + cascade level each selector resolved at. */
function collectResolvedIntents(scenarios: Scenario[]): Array<{ intent: string; level: CascadeLevel }> {
  const out: Array<{ intent: string; level: CascadeLevel }> = [];
  for (const s of scenarios) {
    for (const step of s.steps) {
      if (step.kind === 'click' || step.kind === 'fill' || step.kind === 'press'
        || step.kind === 'select_option' || step.kind === 'set_checked' || step.kind === 'set_input_files') {
        out.push({ intent: step.target.intent, level: step.target.level });
      } else if (step.kind === 'assert') {
        const a = step.assertion;
        if (a.type !== 'toHaveURL') out.push({ intent: a.target.intent, level: a.target.level });
      } else if (step.kind === 'capture' || step.kind === 'assert_compare') {
        out.push({ intent: step.target.intent, level: step.target.level });
      } else if (step.kind === 'wait_for_state') {
        out.push({ intent: step.target.intent, level: step.target.level });
      }
    }
  }
  return out;
}

// Exported so smoke-cost-ceiling can drive the loop with a fake client and
// prove the ceiling breaks cleanly instead of throwing.
export async function runAgentLoop(args: {
  client: Anthropic;
  model: string;
  maxUsd: number;
  price: (typeof PRICE)[ModelId];
  maxSteps: number;
  ctx: ToolContext;
  url: string;
  plan: PlannedScenario[];
  /**
   * Repair-pass instructions appended as an extra system block: the critic's
   * reasons per scenario plus the recorded steps to start from. Absent on
   * normal exploration, so the standard prompt is untouched.
   */
  repairNote?: string;
  onEvent?: ExploreOptions['onEvent'];
  /**
   * Called after every tool round in which a scenario completed, with the
   * loop's cost so far. The runtime writes the checkpoint here, so a crash
   * loses at most the scenario in progress.
   */
  onScenarioComplete?: (loopCostUsd: number) => void;
  /** Closeout grace above maxUsd; defaults to COST_CLOSEOUT_GRACE_USD. 0 disables it. */
  closeoutGraceUsd?: number;
}): Promise<{
  cost: RunReport['cost'];
  endedReason: 'finished' | 'model_stop' | 'budget' | 'cost_ceiling' | 'run_stopped';
  /** Set when endedReason is 'run_stopped': why the API call could not continue. */
  stop?: StopClassification;
  /** Set when the cost closeout grace was used: the scenario, what the grace cost, and whether it closed. */
  closeout?: { scenario: string; usd: number; closed: boolean };
}> {
  const { client, model, maxUsd, price, maxSteps, ctx, url, onEvent } = args;

  // Plan enforcement: finish() consults this list and is rejected while any
  // planned scenario is neither explored nor skipped via skip_scenario.
  ctx.plannedNames = args.plan.map((p) => p.name);

  const cost: RunReport['cost'] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, usd: 0, calls: [] };

  // Build a system prompt with three cached blocks:
  //   1. Frozen behavior rules (EXPLORER_SYSTEM_PROMPT), never changes, max cache value
  //   2. Site memory — changes per host, still cacheable per host
  //   3. Plan — changes per run, but stable through the loop
  const memoryBlock = renderMemoryBlock(url);
  // Render the plan including each scenario's feature tag (when present) so the
  // Explorer can pass it back via begin_scenario.feature. Feature names from
  // the plan are authoritative — the agent should use them verbatim.
  // Multi-page runs: each scenario names the page it runs on; the Explorer
  // must start such a scenario by navigating to that URL. Single-page plans
  // carry no pageUrl, so this text stays byte-identical without discovery.
  const multiPage = args.plan.some((p) => p.pageUrl);
  const planText = args.plan.length > 0
    ? 'Planned scenarios (cover all of these unless a scenario is impossible from this page). ' +
      'When you call begin_scenario, set `feature` to the value in the first bracket — verbatim, kebab-case.\n' +
      (multiPage
        ? 'Scenarios marked "page:" run on that page. Begin each such scenario by navigating to its page URL (scenarios stay self-contained).\n'
        : '') +
      args.plan
        .map((p, i) => {
          const tag = p.feature ? `[${p.feature}][${p.category}]` : `[${p.category}]`;
          const pageNote = p.pageUrl
            ? p.volatilePage
              ? `\n     page: ${p.pageUrl} (VOLATILE generated-id URL — do NOT navigate to it directly; start from the entry/listing page and click through to the item by its visible name)`
              : `\n     page: ${p.pageUrl}`
            : '';
          return `  ${i + 1}. ${tag} ${p.name} — ${p.rationale}${pageNote}`;
        })
        .join('\n')
    : null;

  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: EXPLORER_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam,
  ];
  if (memoryBlock) {
    systemBlocks.push({ type: 'text', text: memoryBlock, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam);
  }
  if (planText) {
    systemBlocks.push({ type: 'text', text: planText } as Anthropic.TextBlockParam);
  }
  if (args.repairNote) {
    systemBlocks.push({ type: 'text', text: args.repairNote } as Anthropic.TextBlockParam);
  }

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `Explore the following URL and produce a Playwright test plan: ${url}` },
  ];

  // The conversation-turn cap must sit ABOVE the step budget, never below it.
  // The model emits roughly one tool call per turn, so a turn cap under the
  // step budget would (and previously did) bite first and abandon the run
  // silently before the step budget could nudge the model to finish(). The
  // margin covers the final finish() turn plus any thinking-only turns.
  const maxTurns = maxSteps + 8;
  let endedReason: 'finished' | 'model_stop' | 'budget' | 'cost_ceiling' | 'run_stopped' = 'budget';
  let stop: StopClassification | undefined;
  // Cost closeout grace state: set when the ceiling trips with a closable
  // scenario in progress. startUsd is the spend when the grace began.
  const graceUsd = args.closeoutGraceUsd ?? COST_CLOSEOUT_GRACE_USD;
  let closeout: { scenario: string; startUsd: number } | undefined;
  const closeoutResult = (): { scenario: string; usd: number; closed: boolean } | undefined => closeout
    ? { scenario: closeout.scenario, usd: cost.usd - closeout.startUsd, closed: ctx.scenarios.some((s) => s.name === closeout!.scenario) }
    : undefined;
  let completedSeen = ctx.scenarios.length;
  // How many 'heal' events have already been surfaced. In-run selector
  // recoveries are recorded on ctx by resolveAndRecord (deep inside a tool
  // call); we drain new ones after each tool runs so each shows up as its own
  // visible event in the run output.
  let emittedHeals = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (cost.usd > maxUsd) {
      // Do NOT throw: aborting here used to lose every completed scenario.
      // Stop the loop cleanly instead; the caller salvages the completed
      // scenarios and runs the rest of the pipeline on them.
      //
      // Closeout grace (COST_CLOSEOUT_GRACE_USD): a scenario in progress that
      // already holds a passed assertion is one or two cheap closing calls
      // from shipping, so it may keep closing while the spend stays within
      // ceiling + grace. Only the closing set runs (ctx._costCloseout, checked
      // in runTool); a scenario with no assertion is never salvaged.
      const closable = ctx.current != null
        && ctx.current.steps.some((s) => s.kind === 'assert' || s.kind === 'assert_compare')
        && graceUsd > 0
        && cost.usd <= maxUsd + graceUsd;
      if (!closable) {
        endedReason = 'cost_ceiling';
        onEvent?.({
          type: 'message',
          text: closeout
            ? `Cost ceiling closeout grace exhausted ($${cost.usd.toFixed(3)} > $${maxUsd} + $${graceUsd.toFixed(2)}); "${closeout.scenario}" did not close and is discarded.`
            : `Cost ceiling reached ($${cost.usd.toFixed(3)} > $${maxUsd}); stopping the Explorer and salvaging completed scenarios.`,
        });
        break;
      }
      if (!closeout) {
        closeout = { scenario: ctx.current!.name, startUsd: cost.usd };
        ctx._costCloseout = true;
        onEvent?.({
          type: 'message',
          text: `Cost ceiling reached ($${cost.usd.toFixed(3)} > $${maxUsd}); "${closeout.scenario}" already holds a passed assertion, so closing calls only are allowed under the $${graceUsd.toFixed(2)} grace.`,
        });
      }
    }

    onEvent?.({ type: 'thinking_started' });

    // Prompt cache: move the conversation breakpoint to the latest message so
    // this call reads the whole prior history from cache. See
    // placeCacheBreakpoints for the four-slot placement.
    placeCacheBreakpoints(systemBlocks, messages);
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model,
        max_tokens: 16000,
        system: systemBlocks,
        tools: TOOL_DEFS as unknown as Anthropic.Tool[],
        messages,
      });
    } catch (err) {
      // Billing exhaustion and persistent API failures (the SDK's own retries
      // are behind us if the error surfaced here) stop the loop CLEANLY so
      // the caller can salvage completed work and write the checkpoint. A
      // genuine bug still throws.
      const cls = classifyRunError(err);
      if (cls.kind === 'other') throw err;
      endedReason = 'run_stopped';
      stop = cls;
      onEvent?.({ type: 'message', text: `Explorer stopped: ${cls.reason}; salvaging completed scenarios.` });
      break;
    }

    const u = response.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    cost.inputTokens += u.input_tokens;
    cost.outputTokens += u.output_tokens;
    cost.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    cost.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
    cost.calls!.push({ input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheCreation: u.cache_creation_input_tokens ?? 0 });
    cost.usd =
      (cost.inputTokens * price.in +
        cost.outputTokens * price.out +
        cost.cacheReadTokens * price.cacheRead +
        cost.cacheCreationTokens * price.cacheWrite) / 1_000_000;
    onEvent?.({ type: 'usage', usd: cost.usd, tokens: cost.inputTokens + cost.outputTokens });

    // Surface any narration the model emits.
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        onEvent?.({ type: 'message', text: block.text });
      }
    }

    if (response.stop_reason !== 'tool_use') {
      // Agent stopped on its own without calling finish — accept what's there.
      endedReason = 'model_stop';
      break;
    }

    // Execute every tool_use block from this turn, then feed results back.
    const assistantContent: Anthropic.ContentBlock[] = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let finished = false;
    for (const block of assistantContent) {
      if (block.type !== 'tool_use') continue;
      onEvent?.({ type: 'tool_call', name: block.name, input: block.input });
      const result = await runTool(ctx, {
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
      onEvent?.({ type: 'tool_result', name: block.name, ok: result.ok, data: result.data, error: result.error });
      // Surface any selector recoveries that just happened, one distinct event each.
      while (emittedHeals < ctx.heals.length) {
        const h = ctx.heals[emittedHeals++]!;
        onEvent?.({ type: 'heal', from: h.from, to: h.to, intent: h.intent, scenario: h.scenario });
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        is_error: !result.ok,
        content: JSON.stringify(result.ok ? (result.data ?? { ok: true }) : { error: result.error }),
      });
      if (block.name === 'finish' && result.ok) finished = true;
    }

    messages.push({ role: 'user', content: toolResults });
    // Per-scenario checkpoint hook: fire once per round in which the
    // completed-scenario count grew.
    if (ctx.scenarios.length > completedSeen) {
      completedSeen = ctx.scenarios.length;
      args.onScenarioComplete?.(cost.usd);
    }
    // Under the closeout grace the ceiling has already tripped: the loop ends
    // as a ceiling stop the moment the scenario closes (or finish ran), never
    // as a normal finish, so the salvage bookkeeping and the checkpoint apply.
    if (closeout && (!ctx.current || finished)) {
      endedReason = 'cost_ceiling';
      const r = closeoutResult()!;
      onEvent?.({
        type: 'message',
        text: r.closed
          ? `Closeout grace: "${r.scenario}" closed for $${r.usd.toFixed(4)}; stopping at the cost ceiling.`
          : `Closeout grace: "${r.scenario}" did not close ($${r.usd.toFixed(4)} spent); stopping at the cost ceiling.`,
      });
      break;
    }
    if (finished) { endedReason = 'finished'; break; }
  }
  // If the for-loop ran to completion without a break, endedReason stays
  // 'budget' — the turn cap (which tracks the step budget) was reached.
  ctx._costCloseout = false;
  cost.cachedInputShare = cachedInputShare(cost);
  const closeoutOut = closeoutResult();
  if (closeoutOut) cost.closeoutGraceUsd = closeoutOut.usd;

  return { cost, endedReason, ...(stop ? { stop } : {}), ...(closeoutOut ? { closeout: closeoutOut } : {}) };
}
