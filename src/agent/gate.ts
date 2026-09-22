import type { Assertion, Scenario, SelectorRecord, TraceStep } from './trace.js';
import { ADAPTIVE_FLOOR_MS } from './adaptive-timeout.js';
import { generatedIdFragment } from './volatile-id.js';

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
 *           missing or below-floor timeout up to the 5000 ms floor, so legacy or
 *           externally-built scenarios never ship with a too-short budget.
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
 *   RULE 5: Unused captures are stripped. A capture whose varName no
 *           assert_compare ever reads is dead weight the Critic flags every
 *           run; nothing can reference it later (assert_compare is the only
 *           reader), so removing it is a safe deterministic fix. Applied
 *           in-place like RULE 2, logged as an injection.
 *
 * The gate is pure and synchronous: no network, no LLM. It reads and
 * optionally mutates the Scenario object that end_scenario is about to push
 * to ctx.scenarios.
 */

export interface GateViolation {
  rule: 1 | 3 | 4 | 6 | 7;
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
// constant — it is the lowest budget the gate will let any async assertion ship
// with, so a missing or too-small timeout gets raised to the floor.
const ASYNC_TIMEOUT_FLOOR = ADAPTIVE_FLOOR_MS;
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
      const text6 = selectorText(target6);
      const fragment = generatedIdFragment(text6);
      if (fragment) {
        violations.push({
          rule: 6,
          stepIndex: i,
          detail: `step ${i + 1}: selector ${JSON.stringify(text6)} embeds the generated id "${fragment}", which rots when the data reseeds; locate the element by role, label, or a testid that carries no id, or by a table-scoped path`,
        });
      }
    }

    // RULE 7: no literal catalogue value (see catalogueLiteralReason).
    if (step.kind === 'assert') {
      const r7 = catalogueLiteralReason(step.assertion, scenario.steps.slice(0, i), opts.knownNames);
      if (r7) violations.push({ rule: 7, stepIndex: i, detail: `step ${i + 1}: ${r7}` });
    }

    // RULE 3a: capture / assert_compare on a FRAGILE CSS-tier locator.
    // Stable selectors (#id, data-*, single semantic class) are explicitly
    // allowed — they remain unique even as the value animates. Capture-and-
    // compare reads the same element twice, so a fragile selector that drifts
    // between reads would silently compare two different elements.
    // The compare's own re-read element (readTarget) is held to the same rule.
    const compareTargets = step.kind === 'capture' ? [step.target] : step.kind === 'assert_compare' ? [step.target, ...(step.readTarget ? [step.readTarget] : [])] : [];
    for (const ct of compareTargets) {
      if (ct.level !== 'css') continue;
      const sel = String(ct.arg);
      // Table-context exception: inside a table, a positional address (row 1,
      // column 1) is stable and correct — that cell HAS no role or id of its own
      // because its content changes by design when you sort. Position is exactly
      // what a sort test must read, so the gate allows it here. Outside a table,
      // and for hashed/auto-generated classes even inside one, position stays
      // fragile and rejected.
      if (isFragileCssSelector(sel) && !isTablePositionalSelector(sel)) {
        violations.push({
          rule: 3,
          stepIndex: i,
          detail: `step ${i + 1}: fragile CSS-tier selector "${sel}" used with ${step.kind} — switch to role/label tier, or use a stable #id or [data-*] selector`,
        });
      }
    }

    // RULE 3b: fragile CSS-tier assertion on an element shown to be dynamic
    if (step.kind === 'assert' && 'target' in step.assertion && step.assertion.target.level === 'css') {
      const a = step.assertion;
      if (a.type === 'toHaveText' || a.type === 'toContainText' || a.type === 'toHaveAttribute' || a.type === 'toHaveValue' || a.type === 'toBeVisible') {
        const sel = String(a.target.arg);
        if (isFragileCssSelector(sel) && !isTablePositionalSelector(sel)) {
          const existingTimeout = (a as { timeout?: number }).timeout ?? 0;
          const knownLong = existingTimeout >= DYNAMIC_TIMEOUT_THRESHOLD;
          const corroborated = hasDynamicCorroboration(scenario, i, sel);
          if (knownLong || corroborated) {
            violations.push({
              rule: 3,
              stepIndex: i,
              detail: `step ${i + 1}: fragile CSS-tier selector "${sel}" on a dynamic element — switch to role/label tier, or use a stable #id or [data-*] selector`,
            });
          }
        }
      }
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

    const hasAction = scenario.steps.some(
      (s) => s.kind === 'click' || s.kind === 'fill' || s.kind === 'press' || s.kind === 'navigate'
        || s.kind === 'select_option' || s.kind === 'set_checked' || s.kind === 'set_input_files',
    );
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]!;
      if (step.kind !== 'assert') continue;
      const a = step.assertion;
      // Every timeout-bearing assertion type is floored, including
      // toBeHidden (absence waits for the element to leave) and toHaveCount
      // (counts settle after async actions). toHaveURL has no element and
      // polls on its own, so a toHaveURL WITHOUT a timeout is left as it is;
      // one the model gave a timeout gets the same floor and cap as every
      // other type. The floor applies after an action; the ceiling applies
      // always.
      const current = (a as { timeout?: number }).timeout;
      if (a.type === 'toHaveURL' && current === undefined) continue;
      if (hasAction && (!current || current < ASYNC_TIMEOUT_FLOOR)) {
        (a as { timeout?: number }).timeout = ASYNC_TIMEOUT_FLOOR;
        injections.push({
          stepIndex: i,
          assertionType: a.type,
          detail: `step ${i + 1}: raised timeout to the ${ASYNC_TIMEOUT_FLOOR}ms floor on ${a.type} (was ${current ?? 'unset'})`,
        });
      } else if (current !== undefined && current > ASYNC_TIMEOUT_CEILING) {
        (a as { timeout?: number }).timeout = ASYNC_TIMEOUT_CEILING;
        injections.push({
          stepIndex: i,
          assertionType: a.type,
          detail: `step ${i + 1}: lowered timeout to the ${ASYNC_TIMEOUT_CEILING}ms ceiling on ${a.type} (was ${current})`,
        });
      }
    }
  }

  return { violations, injections };
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
