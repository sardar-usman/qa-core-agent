import type { Assertion, Scenario, SelectorRecord, TraceStep } from './trace.js';
import { ADAPTIVE_FLOOR_MS } from './adaptive-timeout.js';
import { generatedIdFragment } from './volatile-id.js';
import { currencyAmountIn } from './parse-number.js';

/**
 * Static validation gate — runs after the Explorer closes a scenario and
 * before Reality-Check. Enforces rules that prevent flakiness from reaching
 * the emitted spec:
 *
 *   RULE 1: No hard sleeps ({ kind: 'wait' } steps). Exception: stability_wait
 *           steps (tagged explicitly) between two reads are allowed up to 1000ms.
 *   RULE 2: Floor enforcement on async/animated assertions. Timeouts come from
 *           the page (the adaptive timeout measured during exploration), so the
 *           gate no longer injects a completion constant. It only raises a
 *           missing or below-floor timeout, so nothing ships with a too-short
 *           budget. An assertion recorded after an action is floored at
 *           10000 ms (run 44cb3d: the Critic reworked three assertions sitting
 *           at the old 5000 ms floor; a timeout only lengthens a failing
 *           check, so the higher floor costs nothing on a green run). A
 *           toHaveURL recorded before any action is untouched; another type
 *           recorded before any action in a scenario that has one keeps the
 *           5000 ms floor.
 *   RULE 3: No FRAGILE CSS-tier locator on animated or dynamically-changing
 *           elements. Stable selectors (unique ID, data-* attr, single semantic
 *           class) are always allowed, even on animated elements. Exception:
 *           inside a table, a positional address (nth-child / nth-of-type on a
 *           tr/td/th or a row/cell role) is allowed for capture/assert_compare —
 *           a cell's position IS its address there, and a sort test must read it.
 *           Positional selectors outside a table stay fragile and rejected.
 *   RULE 4: No intermediate numeric text assertion on a known-animated element.
 *           Asserting "50%" on a progress bar that is also the target of
 *           assert_freeze will almost certainly be flaky.
 *   RULE 6: No generated id embedded in any selector (a uuid, a 16+ hex run,
 *           a 20+ alphanumeric run with digits, the same shapes that make a
 *           discovered path volatile), on any action, capture, compare or
 *           assertion. Such ids rot when the data reseeds. The reason names
 *           the fragment and steers to a role, label, id-free testid or a
 *           table-scoped path.
 *   RULE 7: No literal catalogue value. A toHaveText / toContainText /
 *           toHaveValue with a literal on a product card, list item, table
 *           body cell or product-listing target, a price literal on any
 *           target, or a toHaveCount above 1, is rejected with the steer
 *           "capture the value, act, assert_compare". Messages, alerts,
 *           headings and fields the model filled itself are never catalogue
 *           data. Also applied in-run at assert time (tools.ts).
 *           A bare integer asserted as the text of a counter (a badge,
 *           quantity, qty, count or counter target, COUNTER_TARGET_RE) is a
 *           literal count too (run 44cb3d: "cart badge shows 1", three
 *           reworks); the steer is capture the counter's text, act,
 *           assert_compare.
 *   RULE 9: A counter is read by its text, never by its element count. A
 *           capture with source "count" on a counter target counts badge
 *           elements (0 before the add, 1 after) and proves the badge
 *           appeared, not that the number on it went up (run 44cb3d's repair).
 *           Judged on the locator only (isCounterSelector), never the intent:
 *           "product count before filter" on a product-name css is a list
 *           count, the working shape for a filter or search scenario.
 *   RULE 8: No currency amount in a locator name. A role name, label or text
 *           hint that carries a price ("Bolt Cutters ABCDE$48.41", the card's
 *           accessible name concatenating badge and price, run 51d535) pins
 *           a catalogue value into the locator itself. The steer: use the
 *           shortest distinguishing prefix of the name; never include a
 *           price.
 *   RULE 5: Unused captures are stripped. A capture whose varName no
 *           assert_compare ever reads is dead weight the Critic flags every
 *           run; nothing can reference it later (assert_compare is the only
 *           reader), so removing it is a safe deterministic fix. Applied
 *           in-place like RULE 2, logged as an injection.
 *
 * The gate is pure and synchronous: no network, no LLM. It reads and
 * optionally mutates the Scenario object that end_scenario is about to push
 * to ctx.scenarios.
 *
 * Record time. RULE 3, RULE 6 and RULE 8 are decidable from one selector, so
 * tools.ts checks them when a capture, assert, assert_compare or action is
 * recorded (generatedIdReason, fragileCompareReason, fragileAssertReason,
 * priceInNameReason, the same functions this gate calls) and returns
 * ok:false with the same message, recording nothing. Run 51d535 spent 15
 * calls on a sort scenario RULE 3 rejected at end_scenario. The end gate
 * stays as the backstop.
 */

export interface GateViolation {
  rule: 1 | 3 | 4 | 6 | 7 | 8 | 9;
  stepIndex: number;
  detail: string;
}

export interface GateInjection {
  stepIndex: number;
  assertionType: string;
  detail: string;
}

export interface GateResult {
  /**
   * RULE 1, RULE 3, RULE 4 and RULE 6 blocking violations. When non-empty the caller
   * must reject the scenario and give the Explorer a chance to regenerate.
   */
  violations: GateViolation[];
  /**
   * RULE 2 auto-injections that were applied in-place. Only populated when
   * violations is empty (i.e. the scenario was accepted). The caller should
   * add these to the run-level injection log so they appear in the report.
   */
  injections: GateInjection[];
}

// Floor only. The real timeout is the adaptive value measured from the page
// during exploration (see adaptive-timeout.ts). This is not a completion
// constant: it is the lowest budget the gate lets an async assertion ship
// with, so a missing or too-small timeout gets raised to the floor. An
// assertion after an action gets the higher floor: run 44cb3d's Critic
// reworked three assertions at 5000 ms (the contact success message, the
// empty-email error text, the cart line totals), and a timeout only
// lengthens a check that is failing anyway, so a green run pays nothing.
const ASYNC_TIMEOUT_FLOOR = ADAPTIVE_FLOOR_MS;
export const ASYNC_TIMEOUT_FLOOR_AFTER_ACTION = 10_000;
// Ceiling. A recorded timeout above this masks a performance regression and
// drew a rework on every scenario that carried one (run f3b41e: three 60000ms
// values, each the residue of a failed 60 s probe). Lowered, and logged.
export const ASYNC_TIMEOUT_CEILING = 15_000;
const DYNAMIC_TIMEOUT_THRESHOLD = 5_000;

// Positional pseudo-classes that make a selector fragile under DOM changes
const POSITIONAL_RE = /:nth-child|:nth-of-type|:first-child|:last-child|:nth-last/i;
// Known CSS-in-JS auto-generated class prefixes (css-1a2b3c, sc-9f2k, etc.)
const HASHED_CLASS_RE = /\.(css|sc|jss|styled)-[\w]+/i;

// Table structural elements as type selectors (matched at a selector boundary so
// "td" inside another word never trips it) and the ARIA table roles.
const TABLE_ELEMENT_RE = /(^|[\s>~+(,])(table|thead|tbody|tfoot|tr|td|th)([\s>~+:.[#)\],]|$)/i;
const TABLE_ROLE_RE = /\[\s*role\s*[~|^$*]?=\s*["']?(row|cell|columnheader|rowheader|gridcell|grid|table)\b/i;

/**
 * Run all gate rules on a completed Scenario.
 *
 * Mutations: RULE 2 injects timeouts directly onto assertion objects when
 * there are no violations. If the caller rejects the scenario, the mutated
 * object is abandoned (never pushed to ctx.scenarios), so the mutation is
 * harmless.
 */
export function runGate(scenario: Scenario, opts: { knownNames?: Iterable<string> } = {}): GateResult {
  const violations: GateViolation[] = [];

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;

    // RULE 1: any { kind: 'wait' } step emits page.waitForTimeout — forbidden.
    // { kind: 'stability_wait' } is explicitly tagged and allowed because it
    // sits between two reads in a stability comparison, not before a one-shot
    // assertion.
    if (step.kind === 'wait') {
      violations.push({
        rule: 1,
        stepIndex: i,
        detail: `step ${i + 1}: page.waitForTimeout(${step.ms}ms) is a hard sleep; use wait_for_text or a polling assertion with an explicit timeout instead`,
      });
    }

    // RULE 6: no generated id embedded in a selector, whatever the step. The
    // id is the catalogue row's key; it changes on the next reseed and the
    // locator goes with it. Role, label, an id-free testid or a table path
    // survive a reseed.
    for (const target6 of [targetOf(step), step.kind === 'assert_compare' ? step.readTarget ?? null : null]) {
      if (!target6) continue;
      const r6 = generatedIdReason(target6);
      if (r6) violations.push({ rule: 6, stepIndex: i, detail: `step ${i + 1}: ${r6}` });
      // RULE 8: no currency amount in a locator name, whatever the step.
      const r8 = priceInNameReason(target6);
      if (r8) violations.push({ rule: 8, stepIndex: i, detail: `step ${i + 1}: ${r8}` });
    }

    // RULE 7: no literal catalogue value (see catalogueLiteralReason).
    if (step.kind === 'assert') {
      const r7 = catalogueLiteralReason(step.assertion, scenario.steps.slice(0, i), opts.knownNames);
      if (r7) violations.push({ rule: 7, stepIndex: i, detail: `step ${i + 1}: ${r7}` });
    }

    // RULE 9: a counter captured as an element count (see counterCountCaptureReason).
    if (step.kind === 'capture') {
      const r9 = counterCountCaptureReason(step.target, step.source);
      if (r9) violations.push({ rule: 9, stepIndex: i, detail: `step ${i + 1}: ${r9}` });
    }

    // RULE 3a: capture / assert_compare on a FRAGILE CSS-tier locator.
    // Stable selectors (#id, data-*, single semantic class) are explicitly
    // allowed — they remain unique even as the value animates. Capture-and-
    // compare reads the same element twice, so a fragile selector that drifts
    // between reads would silently compare two different elements.
    // The compare's own re-read element (readTarget) is held to the same rule.
    const compareTargets = step.kind === 'capture' ? [step.target] : step.kind === 'assert_compare' ? [step.target, ...(step.readTarget ? [step.readTarget] : [])] : [];
    for (const ct of compareTargets) {
      const r3 = fragileCompareReason(ct, step.kind as 'capture' | 'assert_compare');
      if (r3) violations.push({ rule: 3, stepIndex: i, detail: `step ${i + 1}: ${r3}` });
    }

    // RULE 3b: fragile CSS-tier assertion on an element shown to be dynamic
    if (step.kind === 'assert' && 'target' in step.assertion && step.assertion.target.level === 'css') {
      const a = step.assertion;
      const existingTimeout = (a as { timeout?: number }).timeout ?? 0;
      const knownLong = existingTimeout >= DYNAMIC_TIMEOUT_THRESHOLD;
      const corroborated = hasDynamicCorroboration(scenario, i, String(a.target.arg));
      const r3b = fragileAssertReason(a, knownLong || corroborated);
      if (r3b) violations.push({ rule: 3, stepIndex: i, detail: `step ${i + 1}: ${r3b}` });
    }

    // RULE 4: no intermediate numeric text assertion on a known-animated element.
    // Asserting "25%" or "50%" on a progress bar that is also targeted by
    // assert_freeze will fail non-deterministically — the value is still moving.
    // Use wait_for_text to wait for the terminal state, or assert_freeze to
    // verify the animation stopped.
    if (step.kind === 'assert') {
      const a = step.assertion;
      if ((a.type === 'toHaveText' || a.type === 'toContainText') && 'target' in a && 'text' in a && !a.pattern) {
        const text = (a as { text: string }).text.trim();
        if (looksLikeIntermediateValue(text)) {
          const intent = (a as { target: SelectorRecord }).target.intent;
          if (hasDynamicCorroborationByIntent(scenario, i, intent)) {
            violations.push({
              rule: 4,
              stepIndex: i,
              detail: `step ${i + 1}: asserting "${text}" on an animated element looks like an intermediate value — use wait_for_text for the terminal state, or assert_freeze to verify the animation stopped`,
            });
          }
        }
      }
    }
  }

  // RULE 2: floor enforcement on async/animated assertions — only when the
  // scenario passes RULE 1 + RULE 3 + RULE 4 (no point touching a rejected one).
  // The timeout itself comes from the page (the adaptive value recorded during
  // exploration). The gate only steps in when a timeout is missing or below the
  // floor, raising it to the floor so nothing ships with a too-short budget.
  const injections: GateInjection[] = [];
  if (violations.length === 0) {
    // RULE 5 runs BEFORE the timeout pass so the timeout injections report
    // indices into the final (post-strip) step list.
    for (let i = scenario.steps.length - 1; i >= 0; i--) {
      const step = scenario.steps[i]!;
      if (step.kind !== 'capture') continue;
      const used = scenario.steps.some((s) => s.kind === 'assert_compare' && s.varName === step.varName);
      if (used) continue;
      scenario.steps.splice(i, 1);
      injections.push({
        stepIndex: i,
        assertionType: 'capture',
        detail: `step ${i + 1}: removed unused capture "${step.varName}" — a captured value must feed a later assert_compare, or not be captured at all`,
      });
    }
    injections.reverse(); // strips were collected back-to-front

    const hasAction = scenario.steps.some(isActionStep);
    let actionSeen = false;
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]!;
      if (isActionStep(step)) actionSeen = true;
      if (step.kind !== 'assert') continue;
      const a = step.assertion;
      const current = (a as { timeout?: number }).timeout;
      const t = rule2Timeout(a.type, current, actionSeen, hasAction);
      if (!t) continue;
      (a as { timeout?: number }).timeout = t.timeout;
      injections.push({ stepIndex: i, assertionType: a.type, detail: `step ${i + 1}: ${t.detail}` });
    }
  }

  return { violations, injections };
}

/**
 * RULE 2 for one assertion: the timeout it ships with when the gate changes
 * it, or null when the recorded value stands. Every timeout-bearing type is
 * floored, toBeHidden and toHaveCount included. After an action (navigate,
 * click, fill, press, select_option, set_checked, set_input_files) the floor
 * is ASYNC_TIMEOUT_FLOOR_AFTER_ACTION (10000 ms); a timeout only lengthens a
 * failing check, so it costs nothing on a green run, and run 44cb3d's Critic
 * reworked three assertions sitting at 5000 ms. Before any action the old
 * behavior stands: a toHaveURL there (the page the scenario opened on) is
 * left as it is (run 51d535 is why a URL after an action is floored at all:
 * "[no-timeout]" read as a one-shot check), another type keeps the 5000 ms
 * floor when the scenario has an action somewhere. The ceiling always
 * applies. Exported so scripts/rework-shapes.ts judges recorded calls with
 * this exact rule.
 */
export function rule2Timeout(type: Assertion['type'], current: number | undefined, actionSeen: boolean, hasAction: boolean): { timeout: number; detail: string } | null {
  const floor = actionSeen ? ASYNC_TIMEOUT_FLOOR_AFTER_ACTION : type !== 'toHaveURL' && hasAction ? ASYNC_TIMEOUT_FLOOR : null;
  if (floor !== null && (!current || current < floor)) {
    return { timeout: floor, detail: `raised timeout to the ${floor}ms floor on ${type} (was ${current ?? 'unset'})` };
  }
  if (current !== undefined && current > ASYNC_TIMEOUT_CEILING) {
    return { timeout: ASYNC_TIMEOUT_CEILING, detail: `lowered timeout to the ${ASYNC_TIMEOUT_CEILING}ms ceiling on ${type} (was ${current})` };
  }
  return null;
}

/**
 * Returns true when the text looks like an intermediate counter value:
 * 1%–99% (progress bars), or a bare integer 1–99 (countdown counters).
 * Terminal values (0%, 100%, 0) and non-numeric strings are excluded.
 */
function looksLikeIntermediateValue(text: string): boolean {
  // 1%–99% — intermediate for any progress bar
  if (/^([1-9]|[1-9]\d)%$/.test(text)) return true;
  // Bare integers 1–99 — intermediate for countdown/counter widgets
  if (/^[1-9]\d?$/.test(text)) return true;
  return false;
}

/**
 * Returns true when the CSS selector is stable enough to be allowed even on
 * animated elements. Stable selectors are unique and do not drift when the
 * DOM re-renders.
 *
 *   - Bare unique ID:            #progressBar, #foo-bar
 *   - Pure data-* attribute:     [data-testid="submit"], [data-cy]
 *   - Single semantic class:     .progress-bar, .container (no hashed prefix)
 */
export function isStableCssSelector(sel: string): boolean {
  if (/^#[\w-]+$/.test(sel)) return true;
  if (/^\[data-[\w-]+/.test(sel)) return true;
  // Single class with letters+hyphens only (e.g. .progress-bar), no hashed prefix
  if (/^\.[a-zA-Z][a-zA-Z-]*[a-zA-Z]$/.test(sel) && !HASHED_CLASS_RE.test(sel)) return true;
  // Single short class that may end with a digit (e.g. .h2, .mb4) but not a long numeric run
  if (/^\.[a-zA-Z][a-zA-Z0-9-]*$/.test(sel) && !/\d{3,}/.test(sel) && !HASHED_CLASS_RE.test(sel)) return true;
  return false;
}

/**
 * Returns true when the CSS selector is fragile — positional, auto-generated,
 * or a deep descendant chain that will break under DOM refactors.
 *
 * Fragile patterns:
 *   - Positional pseudo-classes (:nth-child, :first-child, …)
 *   - Auto-generated/hashed class names (css-1a2b3c, sc-9f2k, …)
 *   - Descendant chains deeper than 2 levels (.a .b .c or .a > .b > .c)
 *
 * Stable selectors are never fragile.
 */
/**
 * True when the CSS selector addresses an element inside a table — by table
 * structural element (tr/td/th/thead/tbody/tfoot/table) or by an ARIA table
 * role (row/cell/columnheader/rowheader/gridcell/grid/table).
 *
 * Position inside a table is a valid, stable address: "row 1, column 1" has no
 * role or id of its own because its content changes by design when you sort, and
 * proving the order changed is the whole point of a sort test. So RULE 3 allows
 * the positional pseudo-classes and deep table chains it rejects everywhere else.
 *
 * A hashed / auto-generated class is fragile even inside a table (it drifts on
 * every rebuild, not just on a sort), so this exception explicitly does NOT
 * cover those — they stay rejected.
 */
export function isTablePositionalSelector(sel: string): boolean {
  if (HASHED_CLASS_RE.test(sel)) return false;
  return TABLE_ELEMENT_RE.test(sel) || TABLE_ROLE_RE.test(sel);
}

export function isFragileCssSelector(sel: string): boolean {
  if (isStableCssSelector(sel)) return false;
  if (POSITIONAL_RE.test(sel)) return true;
  if (HASHED_CLASS_RE.test(sel)) return true;
  // Count selector parts by splitting on combinators/whitespace.
  // More than 2 parts = chain deeper than 2 levels = fragile.
  const parts = sel
    .replace(/\[[^\]]*\]/g, '[x]')            // collapse attribute selectors
    .replace(/:[a-zA-Z-]+(\([^)]*\))?/g, '')  // strip pseudo-classes/elements
    .split(/\s*[>~+]\s*|\s+/)
    .filter((p) => p.trim().length > 0);
  if (parts.length > 2) return true;
  return false;
}

/**
 * Returns true when the given CSS selector arg is the target of a
 * capture/assert_compare step or a long-timeout assertion step ELSEWHERE in the
 * scenario. Cross-step corroboration that the element is animated or its
 * value changes over time.
 */
function hasDynamicCorroboration(scenario: Scenario, excludeIdx: number, cssArg: string): boolean {
  return scenario.steps.some((s, idx) => {
    if (idx === excludeIdx) return false;
    if ((s.kind === 'capture' || s.kind === 'assert_compare') && String(s.target.arg) === cssArg) return true;
    if (
      s.kind === 'assert' &&
      'target' in s.assertion &&
      String(s.assertion.target.arg) === cssArg &&
      ((s.assertion as { timeout?: number }).timeout ?? 0) >= DYNAMIC_TIMEOUT_THRESHOLD
    ) return true;
    return false;
  });
}

/**
 * Returns true when the given intent is the target of a capture/assert_compare
 * step or a long-timeout toHaveText assertion ELSEWHERE in the scenario. Used
 * by RULE 4 to confirm the element is animated before flagging an intermediate
 * value assertion.
 */
function hasDynamicCorroborationByIntent(scenario: Scenario, excludeIdx: number, intent: string): boolean {
  return scenario.steps.some((s, idx) => {
    if (idx === excludeIdx) return false;
    if ((s.kind === 'capture' || s.kind === 'assert_compare') && s.target.intent === intent) return true;
    if (
      s.kind === 'assert' &&
      'target' in s.assertion &&
      s.assertion.type === 'toHaveText' &&
      (s.assertion as unknown as { target: SelectorRecord }).target.intent === intent &&
      ((s.assertion as { timeout?: number }).timeout ?? 0) >= DYNAMIC_TIMEOUT_THRESHOLD
    ) return true;
    return false;
  });
}

/** A state-changing step: what an assertion that follows one must wait for. */
export function isActionStep(s: Pick<TraceStep, 'kind'>): boolean {
  return s.kind === 'click' || s.kind === 'fill' || s.kind === 'press' || s.kind === 'navigate'
    || s.kind === 'select_option' || s.kind === 'set_checked' || s.kind === 'set_input_files';
}

/* ─────────────── Per-target rules shared with record time (tools.ts) ─────────────── */

/** RULE 6 reason for one selector record, or null. */
export function generatedIdReason(t: SelectorRecord): string | null {
  const text = selectorText(t);
  const fragment = generatedIdFragment(text);
  if (!fragment) return null;
  return `selector ${JSON.stringify(text)} embeds the generated id "${fragment}", which rots when the data reseeds; locate the element by role, label, or a testid that carries no id, or by a table-scoped path`;
}

/**
 * RULE 3a reason for a capture / assert_compare target, or null. Table
 * context exception: inside a table, a positional address (row 1, column 1)
 * is stable and correct, because that cell has no role or id of its own and
 * its content changes by design when you sort. Outside a table, and for
 * hashed classes even inside one, position stays fragile and rejected.
 */
export function fragileCompareReason(t: SelectorRecord, kind: 'capture' | 'assert_compare'): string | null {
  if (t.level !== 'css') return null;
  const sel = String(t.arg);
  if (isFragileCssSelector(sel) && !isTablePositionalSelector(sel)) {
    return `fragile CSS-tier selector "${sel}" used with ${kind} — switch to role/label tier, or use a stable #id or [data-*] selector`;
  }
  return null;
}

/**
 * RULE 3b reason for an assertion on a css target, or null. `knownDynamic`
 * is true when the element is shown to be dynamic: the recorded timeout is at
 * or above the dynamic threshold (every adaptive timeout is, since the floor
 * is 5000 ms) or another step captures or compares the same selector.
 */
export function fragileAssertReason(a: Assertion, knownDynamic: boolean): string | null {
  if (!('target' in a) || a.target.level !== 'css') return null;
  if (a.type !== 'toHaveText' && a.type !== 'toContainText' && a.type !== 'toHaveAttribute' && a.type !== 'toHaveValue' && a.type !== 'toBeVisible') return null;
  const sel = String(a.target.arg);
  if (!knownDynamic || !isFragileCssSelector(sel) || isTablePositionalSelector(sel)) return null;
  return `fragile CSS-tier selector "${sel}" on a dynamic element — switch to role/label tier, or use a stable #id or [data-*] selector`;
}

/** The steer every RULE 8 rejection carries. */
export const PRICE_IN_NAME_STEER = 'use the shortest distinguishing prefix of the name; never include a price';

/**
 * RULE 8 reason: a role name, label or text locator that carries a currency
 * amount, or null. Run 51d535: the Critic reworked three scenarios whose
 * role or label hint was the card's whole accessible name, badge and price
 * included ("Bolt Cutters ABCDE$48.41"), a volatile catalogue value pinned
 * into the locator. The amount is found by the same parser assert_compare
 * uses (currencyAmountIn).
 */
export function priceInNameReason(t: SelectorRecord): string | null {
  let name: string | null = null;
  if (t.level === 'role') name = (t.arg as { name?: string }).name ?? null;
  else if (t.level === 'label' || t.level === 'text' || t.level === 'placeholder' || t.level === 'alt' || t.level === 'title') name = String(t.arg);
  if (!name) return null;
  const amount = currencyAmountIn(name);
  if (!amount) return null;
  return `locator name ${JSON.stringify(name)} contains the price "${amount}", a catalogue value that changes when the data reseeds; ${PRICE_IN_NAME_STEER}`;
}

/** The step's locator record, for rules that inspect every selector. */
function targetOf(step: TraceStep): SelectorRecord | null {
  if (step.kind === 'assert') return 'target' in step.assertion ? step.assertion.target : null;
  if ('target' in step && step.target) return step.target;
  return null;
}

/** The text a selector record locates by: the css / testid / label / text argument, or the role plus name. */
function selectorText(t: SelectorRecord): string {
  if (t.level === 'role') {
    const a = t.arg as { role: string; name?: string };
    return a.name ? `${a.role} ${a.name}` : a.role;
  }
  return String(t.arg);
}

/** Console label for a blocking gate rule, shared by every rejection site. */
export function gateRuleLabel(rule: GateViolation['rule']): string {
  switch (rule) {
    case 1: return 'RULE 1 (no hard sleeps)';
    case 3: return 'RULE 3 (no CSS on animated elements)';
    case 4: return 'RULE 4 (intermediate value on animated element)';
    case 6: return 'RULE 6 (generated id in selector)';
    case 7: return 'RULE 7 (literal catalogue value)';
    case 8: return 'RULE 8 (price in locator name)';
    case 9: return 'RULE 9 (counter read as an element count)';
  }
}

/** Reason recorded on a scenario the gate dropped, shared by every rejection site. */
export function gateBrokenReason(rule: GateViolation['rule']): string {
  switch (rule) {
    case 1: return 'could not generate without hard sleep';
    case 3: return 'unstable locator on dynamic element';
    case 4: return 'intermediate value assertion on animated element';
    case 6: return 'selector embeds a generated id';
    case 7: return 'literal catalogue value asserted';
    case 8: return 'locator name carries a price';
    case 9: return 'counter captured as an element count';
  }
}

/* ─────────────────── RULE 7: literal catalogue values ─────────────────── */

// A target that shows catalogue data: a product card, a list item, a table
// body cell, a listing grid or row, a price or sku element.
// Markers that name catalogue content outright; a heading word next to one does not exempt.
const STRONG_CATALOGUE_RE = /product|\bcard\b|card[-_]|listing|catalog|\bsku\b/i;
const CATALOGUE_TARGET_RE = /product|\bcard\b|card[-_]|listing|catalog|\bgrid\b|tbody|\btd\b|\bli\b|listitem|gridcell|\bcell\b|\brow\b|\bsku\b|price|result/i;
// Targets that are never catalogue data: messages, alerts, headings, form fields.
const NON_CATALOGUE_RE = /alert|error|message|toast|notif|invalid|feedback|status|heading|\bh[1-6]\b|page-title|caption|banner|breadcrumb|no-results|empty|search-query|\bquery\b|\binput\b|textarea|\bselect\b|\bfield\b|textbox|combobox|checkbox/i;
// A price: a currency symbol with a number, or a number with two decimals.
const PRICE_LITERAL_RE = /^\s*(?:[$€£¥]\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*\.\d{2}\s?[$€£¥]?)\s*$/;

function targetWords(t: SelectorRecord): string {
  return `${selectorText(t)} ${t.intent}`;
}

/* ─────────────── Counters: a badge, a quantity, a count ─────────────── */

/**
 * A counter target: a selector or intent naming a badge, quantity, qty, count
 * or counter (a data-test segment counts: cart-quantity). Matched on whole
 * words only, so the text is split on non-letters (and camelCase) first:
 * "account", "discount", "country" and "counted" are not counters. Run
 * 44cb3d asserted the literal "1" on [data-test='cart-quantity'] three times
 * and the Critic reworked all three.
 */
export const COUNTER_TARGET_RE = /^(?:badge|badges|quantity|quantities|qty|count|counts|counter|counters)$/;

/** True when the text names a counter as a whole word (camelCase split first). */
function namesCounter(text: string): boolean {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .some((w) => COUNTER_TARGET_RE.test(w));
}

/** True when the selector or intent names a counter (whole words, see COUNTER_TARGET_RE). */
export function isCounterTarget(t: SelectorRecord): boolean {
  return namesCounter(targetWords(t));
}

/**
 * True when the LOCATOR alone names a counter: the css, the testid (data-test
 * segments included), a label or text argument, or a role and its name. The
 * intent is never read. RULE 9 decides on this, because a model writes
 * "product count" or "count of results" when it counts a list, and capture
 * count, act, assert_compare less is the working shape for a filter or a
 * search scenario.
 */
export function isCounterSelector(t: SelectorRecord): boolean {
  return namesCounter(selectorText(t));
}

/** The steer every counter literal refusal carries. */
export const COUNTER_LITERAL_STEER = "capture this counter's TEXT before the action, act, then assert_compare greater, less or equal; a literal count is never asserted";

/** The steer every counter count-capture refusal carries. */
export const COUNTER_COUNT_CAPTURE_STEER = 'a badge is one element; capture its text (source text), not its element count';

/**
 * Why a toHaveText / toContainText pins a literal count on a counter, or null.
 * A bare integer ("1") on a badge depends on what the cart held before the
 * test; the durable shape is the relation between two reads. A pattern is a
 * format, never a literal. Other targets are left to the rest of RULE 7.
 */
export function counterLiteralReason(a: Assertion): string | null {
  if (a.type !== 'toHaveText' && a.type !== 'toContainText') return null;
  if (a.pattern) return null;
  if (!/^\s*\d+\s*$/.test(a.text)) return null;
  if (!isCounterTarget(a.target)) return null;
  return `${JSON.stringify(a.text.trim())} on ${targetWords(a.target).trim()} is a literal count on a counter; ${COUNTER_LITERAL_STEER}`;
}

/**
 * RULE 9 reason for a capture, or null: a count capture on a counter selector
 * reads how many badge elements exist, not the number the badge shows. Judged
 * on the locator only (isCounterSelector), never the intent.
 */
export function counterCountCaptureReason(t: SelectorRecord, source: string): string | null {
  if (source !== 'count' || !isCounterSelector(t)) return null;
  return `count capture on ${selectorText(t).trim()} reads how many elements match, not the number shown; ${COUNTER_COUNT_CAPTURE_STEER}`;
}

/**
 * Why an assertion pins a literal catalogue value, or null. Deterministic
 * from the trace: the TARGET tells whether the literal is catalogue data
 * (run f3b41e: every literal the Critic rejected sat on a product-card
 * selector), a price literal is catalogue data on any target, and a count
 * above 1 is a catalogue count. Messages, alerts, headings and a field the
 * model filled itself are never catalogue data. Exported so tools.ts applies
 * it at assert time and smoke-gate locks it.
 */
export function catalogueLiteralReason(a: Assertion, priorSteps: TraceStep[], knownNames?: Iterable<string>): string | null {
  const steer = 'capture the value, act, assert_compare (changed, greater, less, before, after) or assert a heading, a message, a format (assert with regex), toHaveCount with atLeast 1, or count 0 or 1';
  if (a.type === 'toHaveCount') {
    // A minimum of one is the structural "at least one card" doctrine rule 6
    // names; a higher minimum on a catalogue target still pins the count.
    if (a.atLeast && a.count <= 1) return null;
    // A count of form controls, messages or headings is structural, not
    // catalogue data (three checkboxes in a form); a count of cards or rows is.
    const countWords = targetWords(a.target);
    const countExempt = NON_CATALOGUE_RE.test(countWords) && !STRONG_CATALOGUE_RE.test(countWords);
    if (a.count > 1 && !countExempt) return `count=${a.count} on ${countWords} is a literal catalogue count that changes when the data reseeds; ${steer}`;
    return null;
  }
  if (a.type !== 'toHaveText' && a.type !== 'toContainText' && a.type !== 'toHaveValue') return null;
  const counter = counterLiteralReason(a);
  if (counter) return counter;
  // A pattern is a format assertion (a price is rendered, a name-shaped
  // string is present): exactly the durable shape rule 6 asks for.
  if (a.type !== 'toHaveValue' && a.pattern) return null;
  const literal = a.type === 'toHaveValue' ? a.value : a.text;
  const words = targetWords(a.target);
  // A literal account or user name (run 5e4394: "Jane Doe" pinned after
  // login) rots when the test account changes, on any target.
  if (a.type !== 'toHaveValue') {
    const account = accountLiteralReason(literal, a.target, priorSteps, knownNames);
    if (account) return account;
  }
  if (a.type === 'toHaveValue') {
    // A value the model filled itself is test data, not catalogue data.
    const filled = priorSteps.some((s) => s.kind === 'fill' && sameElement(s.target, a.target));
    if (filled) return null;
  }
  // A product-card marker wins over an incidental heading word: the h5 inside
  // a product card is the product name, not a page heading.
  const strongCatalogue = STRONG_CATALOGUE_RE.test(words);
  const exempt = NON_CATALOGUE_RE.test(words) && !strongCatalogue;
  if (!exempt && PRICE_LITERAL_RE.test(literal)) return `${JSON.stringify(literal)} is a price literal, catalogue data that changes when the data reseeds; ${steer}`;
  if (!exempt && CATALOGUE_TARGET_RE.test(words)) return `${JSON.stringify(literal)} on ${words.trim()} is catalogue data that changes when the data reseeds; ${steer}`;
  return null;
}

// Fields whose typed value names an account: a username, an email, a display name.
const ACCOUNT_FIELD_RE = /user|e[\s_-]?mail|\bname\b|log[\s_-]?in|account|profile|nick|display|first|last/i;
// Targets that show the signed-in user: a greeting, a user menu, an avatar label.
const ACCOUNT_TARGET_RE = /user|account|profile|greeting|welcome|nav-menu|\bmenu\b|avatar|\bname\b|signed|logged/i;
const PASSWORD_FIELD_RE = /pass[\s_-]?word|\bpasswd\b|\bpwd\b/i;
// "Jane Doe", "Mary-Ann O'Neil": two or more capitalised words.
const NAME_SHAPED_RE = /^[A-Z][\p{L}'.-]+(?: [A-Z][\p{L}'.-]+)+$/u;

/**
 * Why a text literal is an account or user name, or null. Three signals: the
 * literal equals an account the run knows (the SRS-named ones, the happy
 * logins), it equals a value typed into a credential or profile field earlier
 * in the scenario, or it is a name-shaped string on a signed-in-user target
 * after a password fill. The steer is a name-shaped pattern, never the name.
 */
function accountLiteralReason(literal: string, target: SelectorRecord, priorSteps: TraceStep[], knownNames?: Iterable<string>): string | null {
  const lit = literal.trim();
  if (!lit) return null;
  const low = lit.toLowerCase();
  const steer = 'assert a name-shaped pattern (assert with regex, for example "^\\S+ \\S+$" or "\\S") instead of the account\'s literal name';
  for (const n of knownNames ?? []) {
    if (String(n).trim().toLowerCase() === low) return `${JSON.stringify(lit)} is an account this run signed in with or the SRS names; ${steer}`;
  }
  for (const s of priorSteps) {
    if (s.kind !== 'fill' || !s.value.trim()) continue;
    if (!ACCOUNT_FIELD_RE.test(`${s.target.intent} ${selectorText(s.target)}`)) continue;
    if (s.value.trim().toLowerCase() === low) return `${JSON.stringify(lit)} is the value typed into ${s.target.intent}, a credential or profile field; ${steer}`;
  }
  const loggedIn = priorSteps.some((s) => s.kind === 'fill' && PASSWORD_FIELD_RE.test(`${s.target.intent} ${selectorText(s.target)}`));
  if (loggedIn && NAME_SHAPED_RE.test(lit) && ACCOUNT_TARGET_RE.test(targetWords(target))) {
    return `${JSON.stringify(lit)} is a user's name shown after login, a literal account value; ${steer}`;
  }
  return null;
}

function sameElement(x: SelectorRecord, y: SelectorRecord): boolean {
  if (x.elementKey && y.elementKey) return x.elementKey === y.elementKey;
  return x.level === y.level && JSON.stringify(x.arg) === JSON.stringify(y.arg);
}
