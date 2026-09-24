import Anthropic from '@anthropic-ai/sdk';
import { chromium, type Frame, type Page } from 'playwright';
import { installEvalShim } from './eval-shim.js';
import { renderRequirementsBlock, type RequirementsMap } from './requirements.js';
import { citationMismatchReason, scenarioNameKey } from './rule-coverage.js';

/**
 * Planner — Step 1 of the multi-agent pipeline.
 *
 * Cheap pre-pass on Haiku that opens the target URL once, captures the DOM
 * summary, and emits a numbered list of scenarios to cover. The Explorer
 * agent uses this list as a guide instead of deciding what to test on the fly.
 *
 * Why this exists: Opus tool-use loops are expensive. The Planner spends
 * pennies to give Opus a clear plan, which means Opus does less wandering
 * and produces a tighter set of scenarios.
 */

export interface PlannedScenario {
  name: string;
  category: 'happy' | 'negative' | 'edge' | 'a11y';
  rationale: string;
  /**
   * Optional feature tag (e.g. 'login', 'cart'). The Planner outputs this
   * when the caller passed a `features` list, OR when it can confidently
   * infer one from the scenario. Drives per-feature grouping downstream.
   */
  feature?: string;
  /**
   * Requirement rule ids this scenario verifies (e.g. ['R3','R7']), parsed
   * from the third bracket of the rule-driven plan format. An empty array
   * means the scenario was planned with a map present but matches no stated
   * rule ([-] in the plan). Absent entirely in the no-map format.
   */
  ruleIds?: string[];
  /**
   * The page this scenario runs on, set by multi-page discovery. The Explorer
   * begins the scenario by navigating here. Absent on single-page runs, so
   * the no-discovery plan shape is unchanged.
   */
  pageUrl?: string;
  /**
   * True when pageUrl carries a generated id that rots on reseed. The
   * Explorer reaches such a page by durable interaction (listing + click by
   * name), never by navigating to the GUID URL directly.
   */
  volatilePage?: boolean;
}

/**
 * Steering block appended when the planned page's URL carries a generated id.
 * The emitted spec replays whatever the Explorer records, so the durable path
 * (listing + click by visible name) must be planned in, not patched later.
 * Exported so the smoke locks its presence and wording.
 */
export const VOLATILE_PAGE_GUIDANCE = `This page's URL contains a GENERATED identifier (a product/catalog id). Such URLs rot when the site reseeds its data, so a test that navigates to this URL directly will break for reasons that are not regressions.
Plan every scenario on this page to reach it by DURABLE INTERACTION instead:
- Start from the site's entry or listing page.
- Click through to this item by its VISIBLE NAME (the product title, the link text), never by the generated id.
- Name the durable path in the scenario (e.g. "opened <item name> from the listing and ...").
Never plan a scenario that hardcodes this URL or asserts the generated id itself.`;

export interface PlanResult {
  scenarios: PlannedScenario[];
  pageTitle: string;
  /** Cost of the planning call in USD. */
  costUsd: number;
  /**
   * Number of fillable form controls on the snapshot (text inputs, textareas,
   * selects, checkboxes, radios, file inputs; not submit/hidden). Drives the
   * form-aware step budget so a long form gets more steps per scenario.
   */
  fillableFields: number;
  /**
   * Near-duplicate scenarios removed by `dedupePlan`. Each entry names the
   * dropped scenario and the kept one it duplicated. Surfaced in the run log so
   * the de-dup is never silent.
   */
  dropped: Array<{ scenario: PlannedScenario; duplicateOf: PlannedScenario }>;
  /**
   * Scenarios removed by `rejectCircular` — a captured value compared to itself
   * with no state-changing action in between, so the assertion can never fail.
   * Each entry names the scenario and why. Surfaced in the run log.
   */
  rejected: Array<{ scenario: PlannedScenario; reason: string }>;
  /**
   * Rule citations removed by `applyCitationChecks`: a happy scenario citing
   * a rejection rule, or a negative citing a rule that states no rejection.
   * The scenario stays; only the citation goes, so coverage cannot claim a
   * rule the scenario does not verify. Surfaced in the run log.
   */
  citationDrops: Array<{ scenario: string; ruleId: string; reason: string }>;
  /**
   * Scenarios removed by `rejectPageFit`: each names a control (a field, a
   * sort dropdown, a search box, a price) that the page snapshot does not
   * show, so the Explorer could only fail or thrash on it. Each entry names
   * the scenario and the missing control. Surfaced in the run log and in the
   * derivation report as the `page-fit` skip reason.
   */
  pageFitRejected: PageFitRejection[];
}

/** One scenario dropped by the page-fit pass, with the control it named. */
export interface PageFitRejection {
  scenario: PlannedScenario;
  /** The control the scenario named, as the vocabulary labels it (e.g. "first name", "sort", "price"). */
  control: string;
  reason: string;
}

/**
 * Credentials in wrong-credential negatives. A real account with a wrong
 * password locks after a few failed attempts on many sites, and every recorded
 * scenario is re-run at least four more times (replay plus three stability
 * runs) before it ships, so the account would be locked mid-verification and
 * the test would fail for a reason that is no regression (run ec8eff: the one
 * Critic-passed scenario died this way). Shared by the Planner SYSTEM prompt
 * and the per-page block (credentialSteeringFor), which names the rules that
 * are the exception.
 */
export const CREDENTIAL_STEERING = `Wrong-credential negatives use credentials that do not exist on the site (an invented username or email such as no-such-user-7f3k or nobody+7f3k@example.invalid, with any password), never a real account with a wrong password. Sites lock an account after a few failed attempts, and every recorded scenario is re-run at least four more times (one replay plus three stability runs) before it ships, so a real account would be locked mid-verification and the test would fail for a reason that is no regression. The one exception is a scenario whose point IS the lockout: when a stated rule names a locked or locked-out account, that scenario keeps the real account the rule names and cites the rule.`;

/**
 * The per-page credentials block: the steering above plus which stated rules
 * on this page name a locked account (those scenarios keep the real account)
 * or that none does. Deterministic, so smoke-plan-rule-tags locks it.
 */
export function credentialSteeringFor(map?: RequirementsMap): string {
  const lockRules = (map?.features ?? []).flatMap((f) => f.rules.filter((r) => /\block(ed|s|out|ing)?\b/i.test(r.text)).map((r) => r.id));
  const exception = lockRules.length > 0
    ? `Lockout rules on this page: ${lockRules.join(', ')}. The scenario for each of these keeps the real account the rule names; every other wrong-credential negative uses a non-existent account.`
    : 'No stated rule names a locked account here, so every wrong-credential negative uses a non-existent account.';
  return `Credentials in negative scenarios: ${CREDENTIAL_STEERING}\n${exception}`;
}

export const PLANNER_SYSTEM = `You are the Planner. Your job: look at a single web page and propose a focused list of test scenarios for a Playwright suite.

Constraints:
- Propose 3-6 scenarios total.
- At least one happy path, one negative case, one edge case.
- Each scenario name is past-tense and describes the OUTCOME, not the action (good: "rejects invalid password"; bad: "type wrong password").
- Categories: happy, negative, edge, a11y.
- Skip scenarios you cannot verify from a single page (e.g., end-to-end checkout if only the login page is visible).

Falsifiability — the most important rule. A test that passes even when the feature is broken is worthless.
- Every scenario must name the specific regression it would catch. The rationale (the text after the em dash) must read as "fails if X breaks", naming a concrete failure the test detects. Before you plan a scenario, ask: "what exact bug would turn this test red?" If you cannot name one, the scenario is vacuous. Do not plan it.
- Pick the ONE behavior that is the whole point of the page and build the scenario around proving it. The dynamic, stateful, or risky behavior is the signal. Static rendering is noise.

Banned as the PRIMARY assertion of a scenario (each passes whether or not the feature works):
- Visibility of an element that was already visible before the action.
- A bare "the URL did not change" check.
- An "element is still present" check.
- A captured value compared to itself: capture a value, reload the page or do nothing, then assert the value is unchanged. Reloading a static page reproduces the same value, so the assertion can never fail. An "unchanged" assertion is only valid when something happened that could plausibly have changed the value (a progress bar that stopped after animating, a field that stayed put while locked, a row pinned against a re-sort). If nothing could have changed the value, do not plan the scenario.
- The absence of a made-up identifier that never existed: asserting "a frame named nonexistent-frame-xyz is not present" or "a fake-id element is absent". Nothing on any version of the page was ever named that, so the check passes forever and catches no regression. A real absence test asserts that something which WAS there is gone after an action removed, hid, or filtered it. Assert the absence of a real thing after a real action, never the absence of an invented name.
These are fine as a secondary sanity check, never as the main point of a scenario. If the only thing a scenario proves is one of these, drop it or replace it with one that can fail.

No near-duplicate scenarios. Two scenarios are duplicates when they capture the same value and assert the same relation after a near-identical action. Example: "clicked the button, the id changed" and "reloaded the page, the id changed" both capture the id and prove it changed — a click and a reload are the same trigger here. Keep only the single strongest one. This does NOT collapse scenarios that assert a DIFFERENT relation on the same value: "the id changed" and "the old id is now absent after reload" catch different regressions, so keep both.

Match the assertion to what the feature actually does:
- If the behavior is "a value changes" (a regenerating id, a rotating token, an incrementing counter, a shuffled order), the scenario must capture the value before the action and prove it is different after. The regression it catches: the value stopped changing. Name the capture-then-compare in the scenario, e.g. "captured the button id, reloaded, the id changed".
- If the behavior is "a value stays stable" (a stopped progress bar, a locked field, a pinned row), the scenario must prove the value did not change. The regression it catches: the value drifted when it should have held.
- Negative scenarios assert the failure state itself (the error message, the rejected input), not a success URL.
- ${CREDENTIAL_STEERING}
- Happy-path success must be tied to a signal you can actually see on this page, not an assumed redirect. Do not write "lands on /dashboard" or "redirects to /login" unless the snapshot gives you real evidence the page navigates there (a link to it, a stated next step, copy that names it). If you cannot confirm where a successful submit goes, do not invent a destination URL. Assert a plausible on-page success signal instead (a success or confirmation message, the form clearing, a logged-in control appearing) and say in the rationale that the post-submit state should be reviewed. A made-up redirect makes the test impossible to pass, so the Explorer would thrash on it; an observable signal can actually go green or red. The Explorer records the real post-submit state either way, so a wrong guess surfaces as a finding instead of a silent failure.

a11y category guidance — only propose an a11y scenario when one of these is verifiable from the page:
- A keyboard-only flow: Tab through the form, Enter / Space to activate, assert the resulting state. Name it like "completed login using keyboard only".
- Semantic structure: critical content uses a proper role (main, alert, navigation) or accessible name. Name it like "error message is announced via role=alert".
- DO NOT propose an a11y scenario that is merely "page renders" or "heading is visible" — those are happy-path, not accessibility.

Iframes — content inside a frame is the feature, not the chrome around it.
- The snapshot may include a "frames" array: real content found INSIDE iframes on the page (headings, form fields, editors, buttons, a text sample). Treat it as testable content, the same as top-level content.
- When a frame carries meaningful content (any text, a form field, an editor, an interactive element), you MUST plan at least one scenario that reads or interacts with content INSIDE that frame, and you MUST name the iframe in that scenario (use the word "iframe" or "frame") so the Explorer scopes into it.
- Do NOT plan only around the surrounding page chrome (navbar, theme toggle, dropdown menu) when a content-bearing iframe is present. On such a page the iframe content is the whole point.

Return strictly in this format, nothing else. The square brackets are LITERAL — include them in your output exactly as shown:

<plan>
1. [login][happy] logged in with valid credentials — fails if the success path stops landing on the inventory page
2. [login][negative] rejected an invalid password — fails if a wrong password is accepted or the inline error stops appearing
3. [cart][happy] added item to cart and the badge count went up — fails if add-to-cart stops writing state the user can see
4. [identifier][edge] captured the generated id, reloaded, the id changed — fails if the id stops regenerating and becomes a stable value
</plan>

Notice scenario 4: the page's whole point is that the id regenerates, so the test captures the id, forces a fresh load, and proves the new id differs from the old one. A scenario that merely checked the button is visible would pass even if the id were frozen — useless. Always plan the assertion that can actually fail.

The first bracket is the FEATURE tag — a short, lowercase, kebab-case noun (e.g. login, cart, search, checkout, registration, forgot-password). Use the feature names the caller asked for verbatim when steering. When inferring on your own, pick the most natural feature name for that page (e.g. "login" for an authentication form).

The second bracket is the CATEGORY (happy, negative, edge, a11y) — same as before.`;

/**
 * Rule-driven planning instructions, appended as a second system block ONLY
 * when a requirements map is present. Adjusts the base constraints: rules
 * come first, scenarios cite rule ids in a third bracket, and the ceiling
 * becomes per-feature. The falsifiability doctrine is unchanged.
 */
const RULE_PLANNING = `Rule-driven planning — these adjust the base constraints when REQUIREMENTS are present:
- Derive scenarios from the STATED rules first, DOM evidence second. A stated rule you can verify from this page always beats a scenario invented from the page alone.
- Every scenario that verifies one or more rules MUST cite the rule ids in a THIRD bracket after the category, comma-separated. Example:
    1. [login][negative][R3,R7] rejected a 5-character password — fails if the length rule stops being enforced
- Cite EVERY rule the scenario actually verifies, not only the rule that inspired it. An empty-username scenario that asserts the required-field error verifies BOTH the required rule AND the error-message rule; cite both ids. Before writing the bracket, walk the rule list and ask of each rule: "would this scenario go red if THIS rule broke?" — cite every rule where the answer is yes.
- A scenario discovered from the page that matches NO stated rule uses [-] as the third bracket:
    2. [login][edge][-] password field masks input — fails if the field renders the password as plain text
- Scenario ceiling with a map: up to 4 scenarios per feature listed in REQUIREMENTS (this replaces the 3-6 total constraint). Still at least one happy, one negative, and one edge scenario for every feature whose rules support them; do not force a category a feature's rules give no basis for.
- Never invent rules, features, or URLs beyond the REQUIREMENTS block.
- Falsifiability is unchanged: every scenario must still name the concrete regression it catches, and all the banned vacuous shapes remain banned.

Derivation checklist — walk this per feature when its rules or the page's form controls give a basis. Derive systematically, not by improvisation:
1. Equivalence partitions: for each input a rule constrains, one scenario per meaningful class (one valid representative, one invalid representative). One representative per class, never exhaustive values.
2. Boundary values: when a rule states a length or range, test at the stated edge (minimum length, maximum length, the value just outside). Boundaries beat mid-range invalids.
3. Required-field omissions: one scenario per required field left empty, where the budget allows.
4. Format violations: when a rule states a format (email, phone, URL), one scenario with a value that breaks the format.
5. State transitions: when the rules name a state change (login to locked-out, cart to empty, session to expired), one scenario that drives the transition and asserts the resulting state.
When the scenario budget forces choices, prefer: one representative per equivalence class over exhaustive values, boundary values over mid-range invalids, and rules typed validation over rules typed navigation. Every derived scenario still obeys the falsifiability doctrine and cites its rule ids.`;

const PLANNER_PRICE = { in: 1.0, out: 5.0 }; // Haiku 4.5 default

/** Poll interval for the snapshot settle — same cadence as pollRelation in tools.ts. */
const SETTLE_POLL_MS = 200;
/** Hard cap on how long we wait for the page to render before giving up loudly. */
const SETTLE_CAP_MS = 8_000;
/**
 * The content the Planner actually plans against: form controls and headings.
 * Deliberately EXCLUDES buttons and links — a single-page app ships those in
 * its static shell before it hydrates (the practicesoftwaretesting shell has a
 * "Testing Guide" button and a link at `load`, count never zero), so counting
 * them would make the settle declare victory on the shell and snapshot a page
 * with no form. Form controls and headings only appear once the real content
 * renders, so they are the honest readiness signal.
 */
const SETTLE_CONTENT_SELECTOR = 'input, textarea, select, h1, h2, h3';
/**
 * The readiness selector used INSIDE iframes. A frame-only page (ui.vision and
 * the other frame demos) has a near-empty top document, so the settle signal has
 * to come from frame content or the poll times out as "empty page" even though
 * the snapshot can read the frames. Frames have no SPA-shell problem (that is a
 * top-document concern), so this is broader than SETTLE_CONTENT_SELECTOR — it
 * also counts buttons and contenteditable editors, the content frames carry.
 */
const FRAME_SETTLE_SELECTOR = 'input, textarea, select, h1, h2, h3, button, [contenteditable=""], [contenteditable="true"]';

/**
 * Count the content the settle-poll waits for: top-document content PLUS content
 * inside every child frame. Top and frame counts use different selectors on
 * purpose (see FRAME_SETTLE_SELECTOR). A read that races a frame mid-navigation
 * throws "execution context destroyed"; that frame counts as 0 for this poll and
 * is re-read on the next one.
 */
async function countSettleContent(page: Page): Promise<number> {
  const top = await page
    .evaluate((sel) => document.querySelectorAll(sel).length, SETTLE_CONTENT_SELECTOR)
    .catch(() => 0);
  let inFrames = 0;
  const main = page.mainFrame();
  for (const frame of page.frames()) {
    if (frame === main) continue;
    inFrames += await frame
      .evaluate((sel) => document.querySelectorAll(sel).length, FRAME_SETTLE_SELECTOR)
      .catch(() => 0);
  }
  return top + inFrames;
}

/**
 * Wait for a client-rendered page to actually render its content before
 * snapshotting. Single-page apps (Angular, React) fire the `load` event before
 * they render their form, so a snapshot taken at `load` is empty — this is the
 * exact bug behind the 0-scenario plan on practicesoftwaretesting.com/auth/register
 * (0 content elements at load, 13 once the page rendered).
 *
 * This reuses the settle principle already in the codebase (pollRelation in
 * tools.ts): a loop that polls at a fixed small interval, bounded by a deadline,
 * and resolves the instant its condition holds. The condition here is "the count
 * of content elements (top document plus every child frame, see
 * countSettleContent) is non-zero and has stopped growing" — two consecutive
 * equal reads. A frame-only page (ui.vision/demo/webtest/frames) has an empty top
 * document, so the frame count is what lets it settle instead of failing as
 * empty. It is adaptive (a server-rendered page
 * returns on the first stable pair in ~200ms; a client-rendered form returns the
 * moment it mounts, ~1.5s; neither waits the full cap) and capped (the deadline).
 * It is not a hidden fixed sleep, and it does not add a second timing mechanism.
 *
 * Returns settled=false when the deadline passes without any content appearing.
 * The caller turns that into a loud failure rather than planning against a blank
 * or half-rendered page.
 */
export async function settleForSnapshot(page: Page, capMs = SETTLE_CAP_MS): Promise<{ settled: boolean; count: number }> {
  const deadline = Date.now() + capMs;
  let prev = -1;
  for (;;) {
    const cur = await countSettleContent(page);
    // Non-zero and unchanged since the previous poll → content has rendered and
    // the DOM has stopped growing. This is the early exit; a ready page reaches
    // it on the first stable pair rather than after a fixed delay.
    if (cur > 0 && cur === prev) return { settled: true, count: cur };
    if (Date.now() >= deadline) return { settled: false, count: cur };
    prev = cur;
    await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
  }
}

/** One interactive element as the Planner sees it. */
export interface PickedEl {
  tag: string;
  role?: string;
  label?: string;
  type?: string;
  /** The element's id, when it has one (a reactive form often has an id and no name). */
  id?: string;
  /** The text of the element's associated <label>, when one exists and differs from `label`. */
  labelText?: string;
}

/** Content found INSIDE one iframe, with the selector chain to reach it. */
export interface FrameSnapshot {
  /** Selector chain from the top page to this frame, e.g. ['iframe#frame1']. */
  frameChain: string[];
  url: string;
  headings: PickedEl[];
  inputs: PickedEl[];
  buttons: PickedEl[];
  /** Count of contenteditable regions (rich-text editors live in frames). */
  editable: number;
  /** A short sample of the frame's visible text, so plain-text frames register. */
  textSample: string;
}

/** The page summary the Planner plans against (top document + iframe content). */
export interface PageSnapshot {
  title: string;
  url: string;
  headings: PickedEl[];
  inputs: PickedEl[];
  buttons: PickedEl[];
  fillableCount: number;
  /**
   * The first TOP_TEXT_SAMPLE_CHARS of the top document's visible text,
   * whitespace collapsed. The page-fit pass reads it as evidence (a "Sort"
   * label, a "$14.15" price, a "Filters" heading) and the Planner sees what a
   * visitor sees. Empty when the body has no text.
   */
  textSample: string;
  /**
   * The first 12 column headers (`th` or role=columnheader) on the page. A
   * sortable table's headers ARE its sort control, so a sort scenario on a
   * table page is page-fit even when the word "sort" appears nowhere.
   */
  tableHeaders: string[];
  /**
   * Page-wide evidence computed over the WHOLE document inside the snapshot's
   * page.evaluate, never over the text sample: a listing page's first price
   * can sit past 3000 characters of nav and filter text. The page-fit pass
   * reads these; the text sample is for Haiku.
   */
  flags: PageFlags;
  /** Content-bearing iframes on the page (empty when there are none). */
  frames: FrameSnapshot[];
}

/** Whole-document booleans for the controls whose evidence lives in page text or past the inputs cap. */
export interface PageFlags {
  /** A currency amount anywhere in the document text ($14.15, 12 EUR). */
  hasPrice: boolean;
  /** A sort word, an "order by", an aria-sort attribute or a table column header. */
  hasSort: boolean;
  /** A filter word or any checkbox input. */
  hasFilter: boolean;
  /** A pagination landmark or word, or a next/previous control. */
  hasPagination: boolean;
  /** A search input: type=search, a role=search landmark, or an input named/placeholdered "search". */
  hasSearch: boolean;
}

/**
 * How much of the top document's visible text the snapshot carries. Long
 * enough to reach past a listing page's filter sidebar to its first cards
 * (practicesoftwaretesting.com/category/hand-tools reaches its first price
 * at about 600 characters), short enough to cost a few hundred tokens.
 */
export const TOP_TEXT_SAMPLE_CHARS = 2000;

/** Max frame nesting we will descend into, matches selectors.ts MAX_FRAME_DEPTH. */
const MAX_FRAME_DEPTH = 3;
/** Cap on how many content-bearing frames we record, so a page full of ad iframes can't blow up the snapshot. */
const MAX_FRAMES = 8;

/**
 * Read the top document into a snapshot, then enumerate content inside iframes.
 *
 * The top-document read is the original Planner snapshot (headings, inputs,
 * buttons, fillable count). The frames pass is new: without it the Planner only
 * sees the page chrome and never plans for the content INSIDE a frame, which on
 * an iframe-centric page (letcode.in/frame, demoqa.com/frames) is the actual
 * feature. Exported so the iframe smoke test can drive it against fixtures.
 */
export async function snapshotPage(page: Page): Promise<PageSnapshot> {
  // Function declarations only — tsx injects `__name` wrappers for arrow
  // funcs assigned to consts, which break when serialized to page.evaluate.
  const top = await page.evaluate((sampleChars) => {
    function pick(el: Element): { tag: string; role?: string; label?: string; type?: string; id?: string; labelText?: string } {
      const r = el as HTMLElement;
      const label = (r.getAttribute('aria-label') ?? r.getAttribute('placeholder') ?? r.getAttribute('name') ?? (r.textContent ?? '').trim().slice(0, 80)) || undefined;
      // The associated <label for=...> text: the name a visitor reads for a
      // field whose markup carries no name or placeholder (Angular reactive
      // forms). Page fit reads it as evidence.
      const labels = (r as HTMLInputElement).labels;
      const labelText = labels && labels.length > 0 ? (labels[0]!.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) : '';
      return {
        tag: r.tagName.toLowerCase(),
        role: r.getAttribute('role') ?? undefined,
        label,
        type: (r as HTMLInputElement).type ?? undefined,
        ...(r.id ? { id: r.id } : {}),
        ...(labelText && labelText !== label ? { labelText } : {}),
      };
    }
    // Count the controls the Explorer will actually act on (fill / select /
    // check). Excludes hidden fields and the submit/button/reset/image inputs,
    // which are clicks, not fills. This drives the form-aware step budget, so
    // it counts ALL such controls, not the display-capped `inputs` list below.
    function isFillable(el: Element): boolean {
      const tag = el.tagName.toLowerCase();
      if (tag === 'textarea' || tag === 'select') return true;
      const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
      return !['hidden', 'submit', 'button', 'reset', 'image'].includes(type);
    }
    const fullText = document.body ? (document.body.innerText || '').replace(/\s+/g, ' ').trim() : '';
    const bodyText = fullText.slice(0, sampleChars);
    // Whole-document evidence for the page-fit pass. Read over the full text
    // and the full control set, so a price past the text sample or a search
    // box past the 25-input cap still counts.
    function attrHas(el: Element, word: string): boolean {
      const attrs = ['placeholder', 'aria-label', 'name', 'id', 'title'];
      return attrs.some((a) => (el.getAttribute(a) || '').toLowerCase().includes(word));
    }
    const flags = {
      hasPrice: /[$€£¥]\s?\d|\d\s?(usd|eur|gbp|chf|jpy)\b/i.test(fullText),
      hasSort:
        /\bsort(ed|ing|s)?\b|\border by\b/i.test(fullText) ||
        document.querySelector('th, [role="columnheader"], [aria-sort]') !== null,
      hasFilter:
        /\bfilter/i.test(fullText) ||
        document.querySelector('input[type="checkbox"]') !== null,
      hasPagination:
        /\bpaginat|\bnext\b|\bprevious\b|\bpage \d/i.test(fullText) ||
        document.querySelector('.pagination, [aria-label*="pagination" i], nav[aria-label*="page" i]') !== null,
      hasSearch:
        document.querySelector('input[type="search"], [role="search"]') !== null ||
        Array.from(document.querySelectorAll('input, textarea')).some((el) => attrHas(el, 'search')),
    };
    return {
      title: document.title,
      url: location.href,
      headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 8).map(pick),
      inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 25).map(pick),
      buttons: Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 25).map(pick),
      fillableCount: Array.from(document.querySelectorAll('input, textarea, select')).filter(isFillable).length,
      textSample: bodyText,
      tableHeaders: Array.from(document.querySelectorAll('th, [role="columnheader"]')).slice(0, 12).map((h) => (h.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)).filter((t) => t.length > 0),
      flags,
    };
  }, TOP_TEXT_SAMPLE_CHARS);

  const frames = await enumerateFrames(page);
  return { ...top, frames };
}

/**
 * Build the selector chain that reaches a frame from the top page, preferring an
 * id (`iframe#frame1`), then a name (`iframe[name="..."]`), then a positional
 * fallback (`iframe >> nth=i`) — the same precedence selectors.ts uses. Handles
 * both `<iframe>` and frameset `<frame>` elements, emitting the matching tag so
 * the chain drives frameLocator on a frameset page too. Returns null when the
 * chain is deeper than MAX_FRAME_DEPTH or a hop can't be read.
 */
async function frameChainFor(frame: Frame): Promise<string[] | null> {
  const chain: string[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    const handle = await f.frameElement();
    try {
      const tag = (await handle.evaluate((el) => (el as Element).tagName.toLowerCase())) === 'frame' ? 'frame' : 'iframe';
      const id = await handle.getAttribute('id');
      const name = await handle.getAttribute('name');
      if (id) chain.unshift(`${tag}#${id}`);
      else if (name) chain.unshift(`${tag}[name="${name}"]`);
      else {
        const idx = await handle.evaluate((el, t) => {
          const e = el as Element;
          return Array.from((e.ownerDocument || document).querySelectorAll(t)).indexOf(e);
        }, tag);
        chain.unshift(`${tag} >> nth=${idx < 0 ? 0 : idx}`);
      }
    } finally {
      await handle.dispose().catch(() => {});
    }
    f = f.parentFrame();
  }
  if (chain.length === 0 || chain.length > MAX_FRAME_DEPTH) return null;
  return chain;
}

/**
 * Read the content of every iframe on the page via Playwright's frame API, which
 * reaches frames regardless of origin (the same access path frameLocator uses).
 * Only content-bearing frames are kept, so tracking/ad iframes drop out.
 */
export async function enumerateFrames(page: Page): Promise<FrameSnapshot[]> {
  const out: FrameSnapshot[] = [];
  const main = page.mainFrame();
  for (const frame of page.frames()) {
    if (frame === main) continue;
    if (out.length >= MAX_FRAMES) break;
    let chain: string[] | null;
    try {
      chain = await frameChainFor(frame);
    } catch {
      continue; // frame detached or unreadable mid-walk
    }
    if (!chain) continue;
    try {
      // Give a still-loading frame a brief moment to render before reading it.
      await frame.waitForLoadState('domcontentloaded', { timeout: 2000 }).catch(() => {});
      const content = await frame.evaluate(() => {
        function pick(el: Element): { tag: string; role?: string; label?: string; type?: string } {
          const r = el as HTMLElement;
          return {
            tag: r.tagName.toLowerCase(),
            role: r.getAttribute('role') ?? undefined,
            label: (r.getAttribute('aria-label') ?? r.getAttribute('placeholder') ?? r.getAttribute('name') ?? (r.textContent ?? '').trim().slice(0, 80)) || undefined,
            type: (r as HTMLInputElement).type ?? undefined,
          };
        }
        const bodyText = document.body ? (document.body.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200) : '';
        return {
          url: location.href,
          headings: Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 8).map(pick),
          inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 25).map(pick),
          buttons: Array.from(document.querySelectorAll('button, [role="button"]')).slice(0, 25).map(pick),
          editable: document.querySelectorAll('[contenteditable=""], [contenteditable="true"]').length,
          textSample: bodyText,
        };
      });
      const snap: FrameSnapshot = { frameChain: chain, ...content };
      if (frameHasContent(snap)) out.push(snap);
    } catch {
      continue; // cross-origin evaluate blocked, or frame went away
    }
  }
  return out;
}

/**
 * A frame is worth planning against when it holds anything testable: a heading,
 * a form control, a button, an editor, or a meaningful run of text. Empty
 * tracking/ad frames (no headings, no controls, whitespace text) return false.
 */
export function frameHasContent(f: Pick<FrameSnapshot, 'headings' | 'inputs' | 'buttons' | 'editable' | 'textSample'>): boolean {
  return (
    f.headings.length > 0 ||
    f.inputs.length > 0 ||
    f.buttons.length > 0 ||
    f.editable > 0 ||
    f.textSample.trim().length >= 8
  );
}

/** A short human description of a frame's content, for the steering block. */
function describeFrame(f: FrameSnapshot): string {
  const bits: string[] = [];
  const labelled = f.headings.filter((h) => h.label).slice(0, 3).map((h) => JSON.stringify(h.label));
  if (labelled.length) bits.push(`heading(s): ${labelled.join(', ')}`);
  if (f.inputs.length) bits.push(`${f.inputs.length} input${f.inputs.length === 1 ? '' : 's'}`);
  if (f.buttons.length) bits.push(`${f.buttons.length} button${f.buttons.length === 1 ? '' : 's'}`);
  if (f.editable) bits.push(`${f.editable} editable region${f.editable === 1 ? '' : 's'}`);
  if (f.textSample) bits.push(`text: ${JSON.stringify(f.textSample.slice(0, 80))}`);
  return bits.join('; ') || 'content';
}

/**
 * Does a planned scenario already read or interact with content inside a frame?
 * The SYSTEM rule asks the model to name the iframe explicitly, so the presence
 * of "iframe" / "frame" in the name or rationale is the coverage marker.
 */
export function scenarioCoversFrame(s: PlannedScenario): boolean {
  return /\b(iframe|frames?|frame-?locator)\b/i.test(`${s.name} ${s.rationale}`);
}

/** Build one inside-frame scenario from a frame's content as a fallback. */
function synthFrameScenario(f: FrameSnapshot): PlannedScenario {
  const heading = f.headings.find((h) => h.label)?.label;
  const input = f.inputs.find((i) => i.label)?.label;
  if (input) {
    return {
      feature: 'iframe',
      category: 'happy',
      name: `filled "${input}" inside the iframe and the value stuck`,
      rationale: 'fails if the field inside the iframe cannot be reached via frameLocator, so typing into the frame regresses',
    };
  }
  if (heading) {
    return {
      feature: 'iframe',
      category: 'happy',
      name: `read "${heading}" inside the iframe`,
      rationale: 'fails if the iframe content cannot be read from inside the frame (a frameLocator regression) or the frame stops loading',
    };
  }
  return {
    feature: 'iframe',
    category: 'happy',
    name: 'read the content inside the iframe',
    rationale: 'fails if the iframe content cannot be reached from inside the frame (a frameLocator regression)',
  };
}

/**
 * Guarantee that a page with content-bearing iframes gets at least one scenario
 * that reads or interacts with content INSIDE a frame. If the model already
 * planned one (it named the iframe), nothing changes. Otherwise one inside-frame
 * scenario, synthesized from the first content frame, is prepended. When the
 * page has no content-bearing frame, the plan is returned untouched.
 */
export function ensureIframeCoverage(
  scenarios: PlannedScenario[],
  frames: FrameSnapshot[],
): { scenarios: PlannedScenario[]; injected: PlannedScenario | null } {
  const contentFrames = (frames ?? []).filter(frameHasContent);
  if (contentFrames.length === 0) return { scenarios, injected: null };
  if (scenarios.some(scenarioCoversFrame)) return { scenarios, injected: null };
  const injected = synthFrameScenario(contentFrames[0]!);
  return { scenarios: [injected, ...scenarios], injected };
}

export async function plan(opts: {
  url: string;
  model?: string;
  apiKey?: string;
  /**
   * Optional feature list (e.g. ['login', 'cart']). When present, the Planner
   * is steered to propose scenarios ONLY for these features instead of
   * inferring 2-3 highest-signal flows from the homepage. Empty array or
   * undefined → infer-from-homepage (legacy behaviour).
   */
  features?: string[];
  /**
   * Optional requirements map built from an SRS (--srs). When present, a
   * REQUIREMENTS system block lists every stated rule, planning becomes
   * rule-first (scenarios cite rule ids in a third bracket), and the scenario
   * ceiling rises to up to 4 per map feature. When absent, the Planner's
   * input and output format are byte-identical to the pre-SRS behaviour.
   */
  requirements?: RequirementsMap;
  /**
   * True when the page URL carries a generated id (multi-page discovery
   * marked it volatile). Appends VOLATILE_PAGE_GUIDANCE so every scenario
   * reaches the page by durable interaction, never the GUID URL.
   */
  volatilePage?: boolean;
}): Promise<PlanResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');
  // Both env names are honored: QA_CORE_PLANNER_MODEL (documented) and the
  // older QA_CORE_MODEL_PLANNER. Default unchanged.
  const model = opts.model ?? process.env.QA_CORE_PLANNER_MODEL ?? process.env.QA_CORE_MODEL_PLANNER ?? 'claude-haiku-4-5';
  const client = new Anthropic({ apiKey });

  // Take one snapshot — title + visible interactive elements.
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext();
    await installEvalShim(ctx);
    const page = await ctx.newPage();
    await page.goto(opts.url, { waitUntil: 'load' });
    // SPAs render their form after `load` fires. Wait for the DOM to populate
    // and stop growing before snapshotting, otherwise the Planner plans against
    // a blank page and returns nothing. If it never settles within the cap, that
    // is a loud failure with a reason, not a silent snapshot of a partial page.
    const settle = await settleForSnapshot(page);
    if (!settle.settled) {
      throw new Error(
        `Planner could not capture a stable snapshot of ${opts.url} within ${SETTLE_CAP_MS}ms. ` +
          `The page may not have rendered its content (saw ${settle.count} form control${settle.count === 1 ? '' : 's'}/heading${settle.count === 1 ? '' : 's'}). ` +
          `Confirm the URL loads in a browser, then try again.`,
      );
    }
    const snapshot = await snapshotPage(page);

    // When the caller passed a feature list, append explicit steering text so
    // the Planner produces scenarios ONLY for those features. This makes
    // `--features login,cart` actually change what the agent tests, instead
    // of just decorating the README.
    const features = (opts.features ?? []).filter((f) => f && f.trim().length > 0);
    const steeringBlock = features.length > 0
      ? `\n\nThe user has asked for scenarios covering THESE features ONLY:\n${features.map((f) => `  - ${f}`).join('\n')}\n\n` +
        `Rules when steering:\n` +
        `- Propose 1-3 scenarios per listed feature.\n` +
        `- Do NOT propose scenarios for other features visible on the page (e.g. don't add a search scenario if the user only asked for login).\n` +
        `- If a requested feature is not visible on this homepage snapshot (e.g., a checkout flow only reachable after login), STILL propose scenarios for it — the Explorer can navigate to find it.\n` +
        `- Across all listed features combined, stay within the 3-6 scenarios overall constraint.`
      : '';

    // When the page has content-bearing iframes, anchor the Planner on that
    // content explicitly. The SYSTEM rule already forbids planning only around
    // chrome, but listing the real frame content here makes Haiku act on it.
    const volatileBlock = opts.volatilePage ? `\n\n${VOLATILE_PAGE_GUIDANCE}` : '';
    // Credentials for wrong-credential negatives, with the lockout rules on
    // this page named as the exception (see CREDENTIAL_STEERING).
    const credentialBlock = `\n\n${credentialSteeringFor(opts.requirements)}`;

    const contentFrames = snapshot.frames.filter(frameHasContent);
    const iframeBlock = contentFrames.length > 0
      ? `\n\nThis page has ${contentFrames.length} content-bearing iframe${contentFrames.length === 1 ? '' : 's'}. ` +
        `The iframe content is the feature of this page, not the surrounding chrome. ` +
        `You MUST include at least one scenario that reads or interacts with content INSIDE an iframe, and name the iframe in that scenario. Frame contents:\n` +
        contentFrames.map((f, i) => `  frame ${i + 1} (${f.frameChain.join(' > ')}): ${describeFrame(f)}`).join('\n')
      : '';

    // Rule-driven planning: when a requirements map is present, a second system
    // block lists the stated rules and switches the constraints to rule-first.
    // It is appended AFTER the cached base SYSTEM block so the cache prefix is
    // untouched, and it is absent entirely without a map, so the no-SRS prompt
    // stays byte-identical to the pre-SRS behaviour.
    const systemBlocks: Anthropic.TextBlockParam[] = [
      { type: 'text', text: PLANNER_SYSTEM, cache_control: { type: 'ephemeral' } } as Anthropic.TextBlockParam,
    ];
    if (opts.requirements) {
      systemBlocks.push({ type: 'text', text: `${renderRequirementsBlock(opts.requirements)}\n\n${RULE_PLANNING}` } as Anthropic.TextBlockParam);
    }

    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: systemBlocks,
      messages: [
        {
          role: 'user',
          content: `URL: ${opts.url}\n\nPage snapshot:\n${JSON.stringify(snapshot, null, 2)}${steeringBlock}${iframeBlock}${volatileBlock}${credentialBlock}\n\nPropose scenarios.`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    const parsed = parsePlan(text);
    // Reject circular unchanged-assertions (capture a value, reload/no-op, assert
    // it equals itself) before de-dup, so a vacuous test never reaches the plan.
    const { kept: notCircular, rejected } = rejectCircular(parsed);
    const { kept: deduped, dropped } = dedupePlan(notCircular);
    // Page fit: a scenario that names a control the snapshot does not show (a
    // password field on a one-field reset form, a price on cards that carry
    // none) is dropped here, before the Explorer spends on it. Deterministic,
    // never a prompt nudge. Runs before the iframe injection so a synthesized
    // frame scenario (built from real frame content) is never judged.
    const { kept, rejected: pageFitRejected } = rejectPageFit(deduped, snapshot);
    // Guarantee iframe coverage deterministically. The SYSTEM rule + steering
    // block ask the model to plan an inside-frame scenario, but a prompt nudge
    // can miss. When the page has content-bearing iframes and the plan still
    // ignores them, synthesize one inside-frame scenario so the frameLocator
    // path is always exercised on such a page. Runs last so the injected
    // scenario is not dropped by dedup or rejected as circular.
    const { scenarios: covered, injected } = ensureIframeCoverage(kept, snapshot.frames);
    if (injected) {
      console.log(`Planner: injected an inside-frame scenario (no model scenario covered the iframe): ${injected.name}`);
    }
    // A citation is a claim that the scenario verifies the rule; drop the ones
    // the category makes impossible, so coverage never counts them.
    const { scenarios: cited, citationDrops } = applyCitationChecks(covered, opts.requirements);
    const u = response.usage;
    const costUsd = (u.input_tokens * PLANNER_PRICE.in + u.output_tokens * PLANNER_PRICE.out) / 1_000_000;

    return { scenarios: cited, pageTitle: snapshot.title, costUsd, dropped, rejected, citationDrops, pageFitRejected, fillableFields: snapshot.fillableCount };
  } finally {
    await browser.close();
  }
}

/**
 * Parse the Planner's response into scenarios. Accepts the rule-driven
 * three-bracket format, the v3.1 two-bracket format, and all four legacy
 * variants. Exported so smoke-plan-rule-tags locks the REAL parser (the older
 * smoke-planner-parse predates the export and tests a mirror).
 */
export function parsePlan(text: string): PlannedScenario[] {
  const m = text.match(/<plan>([\s\S]*?)<\/plan>/i);
  const body = m && m[1] ? m[1] : text;
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\d+[.)]/.test(l));
  const out: PlannedScenario[] = [];
  for (const raw of lines) {
    // First try the feature-tagged formats:
    //   v4 (rule-driven): "1. [feature][category][R1,R3] name — rationale"
    //                     "1. [feature][category][-] name — rationale"
    //   v3.1:             "1. [feature][category] name — rationale"
    // The third bracket is OPTIONAL: without a requirements map the model never
    // emits it and this regex parses the v3.1 lines exactly as before.
    const withFeature = raw.match(
      /^\d+[.)]\s*\[([a-z][a-z0-9-]*)\]\s*\[?(happy|negative|edge|a11y)\]?\s*(?:\[\s*(-|[Rr]\d+(?:\s*,\s*[Rr]\d+)*)\s*\])?\s*[:\-—–]?\s*(.+?)\s*[—–]+\s*(.+)$/i,
    );
    if (withFeature && withFeature[1] && withFeature[2] && withFeature[4] && withFeature[5]) {
      const ruleBracket = withFeature[3];
      const ruleIds = ruleBracket === undefined
        ? undefined
        : ruleBracket.trim() === '-'
          ? []
          : ruleBracket.split(',').map((r) => r.trim().toUpperCase()).filter((r) => /^R\d+$/.test(r));
      out.push({
        feature: withFeature[1].toLowerCase(),
        category: withFeature[2].toLowerCase() as PlannedScenario['category'],
        name: withFeature[4].trim(),
        rationale: withFeature[5].trim(),
        ...(ruleIds !== undefined ? { ruleIds } : {}),
      });
      continue;
    }
    // Forgiving fallback. Haiku has shown four distinct format variants across
    // older runs (kept for back-compat):
    //   "1. [happy] name — rationale"     ← what the prompt used to ask for
    //   "1. happy name — rationale"       ← drops the brackets
    //   "1. happy — name — rationale"     ← em-dash after the category
    //   "1. happy: name — rationale"      ← colon after the category
    // All carry the same meaning. We accept any of them. Hyphen is NOT allowed
    // as the name-rationale separator (it appears inside many real words like
    // "well-formed"); only em-dash / en-dash count.
    const match = raw.match(/^\d+[.)]\s*\[?(happy|negative|edge|a11y)\]?\s*[:\-—–]?\s*(.+?)\s*[—–]+\s*(.+)$/i);
    if (match && match[1] && match[2] && match[3]) {
      out.push({
        name: match[2].trim(),
        category: match[1].toLowerCase() as PlannedScenario['category'],
        rationale: match[3].trim(),
      });
    }
  }
  return out;
}

/**
 * The relation a capture-and-compare scenario asserts, read from the plan text.
 * Order matters: checked top to bottom, first match wins. `absent` comes before
 * the count relations so "no longer found" is not misread as "decreased", and
 * `changed` is last because its keyword set is the broadest.
 */
const RELATION_CLASSES: Array<{ cls: string; patterns: RegExp[] }> = [
  { cls: 'absent', patterns: [/\bno longer (?:match|exist|present|found|appear)/, /\bnot found\b/, /\bgone\b/, /\bdisappear/, /\babsent\b/] },
  { cls: 'increased', patterns: [/\bincreas/, /\bwent up\b/, /\bgreater\b/, /\bincrement/, /\bgrew\b/] },
  { cls: 'decreased', patterns: [/\bdecreas/, /\bwent down\b/, /\bfewer\b/, /\bdecrement/] },
  { cls: 'unchanged', patterns: [/\bunchanged\b/, /\bdid ?n.?t change\b/, /\bstays?\b/, /\bstayed\b/, /\bheld\b/, /\bremained\b/, /\bstable\b/, /\bfrozen\b/, /\bpinned\b/, /\blocked\b/] },
  { cls: 'changed', patterns: [/\bchanged\b/, /\bregenerat/, /\bdiffer/, /\brotat/, /\bshuffl/, /\bnew (?:id|value|token|order)\b/, /\bre-?render/] },
];

/** Concrete nouns that name the value a scenario captures. */
const VALUE_NOUNS = ['id', 'count', 'token', 'order', 'badge', 'total', 'price', 'quantity', 'qty', 'value', 'number', 'timestamp', 'nonce', 'position', 'index'];

/**
 * A signature for capture-and-compare scenarios: feature + relation + value
 * noun. Returns null when the scenario does not read as a capture-and-compare
 * (no relation or no value noun found), so non-capture scenarios are never
 * treated as duplicates of each other.
 */
function captureSignature(s: PlannedScenario): string | null {
  // Read the relation and value from the NAME only — the name states the
  // outcome the scenario asserts. The rationale states "fails if X", which
  // names the opposite relation (e.g. "fails if it becomes a stable value")
  // and would invert the signal.
  const hay = s.name.toLowerCase();
  let rel: string | null = null;
  for (const r of RELATION_CLASSES) {
    if (r.patterns.some((p) => p.test(hay))) { rel = r.cls; break; }
  }
  if (!rel) return null;
  let noun: string | null = null;
  for (const n of VALUE_NOUNS) {
    if (new RegExp(`\\b${n}\\b`).test(hay)) { noun = n; break; }
  }
  if (!noun) return null;
  const feat = (s.feature ?? '').toLowerCase() || '∅';
  return `${feat}|${rel}|${noun}`;
}

/**
 * The assertion reads "the value stayed the same" (unchanged / equal / persists).
 * Broader than the dedup `unchanged` class on purpose: it also catches "equals
 * itself", "same value", "identical", "no change" — the phrasings a circular
 * test uses.
 */
const UNCHANGED_RE = /\bunchanged\b|\bdid ?n.?t change\b|\bno change\b|\bstays?\b|\bstayed\b|\bheld\b|\bhold\b|\bremain\w*|\bstable\b|\bfrozen\b|\bpinned\b|\blocked\b|\bequals?\b|\bidentical\b|\bsame\b|\bmatches?\s+itself\b|\bpersist\w*/i;

/**
 * A context where a real force could plausibly have changed the value, so an
 * "unchanged" assertion is meaningful (it proves the value HELD against that
 * force). The progress bar that stopped, a field that is locked/read-only, a
 * row pinned against a re-sort, a value read during/after an animation.
 */
const DYNAMIC_HELD_RE = /\bprogress\b|\banimat\w*|\bspinner\b|\bcountdown\b|\btimer\b|\bstop(?:ped|ping|s)?\b|\bhalt\w*|\bsettl\w*|\bfroze\b|\bfrozen\b|\bfreez\w*|\bloading\b|\bpinned\b|\block(?:ed|s|ing)?\b|\bdisabl\w*|\breadonly\b|\bread-only\b|\battempt\w*|\btried?\b|\bwhile\b|\bduring\b/i;

/**
 * A trigger that reproduces the SAME value rather than changing it: a reload or
 * refresh of a static page, revisiting/re-opening the page, or phrasing that
 * literally compares the value to itself. Reloading a static page is not a
 * state-changing action.
 */
const RELOAD_NOOP_RE = /\breload\w*|\brefresh\w*|\bre-?visit\w*|\bre-?open\w*|\bre-?navigat\w*|\bnavigat\w*\s+back\b|\bequals?\s+itself\b|\bto\s+itself\b|\bagainst\s+itself\b|\bsame\s+(?:value|id|text|content|cell|row|count|number)\b/i;

/** A genuine state-changing action that could have altered the captured value. */
const MUTATING_ACTION_RE = /\bclick\w*|\bpress\w*|\bsubmit\w*|\bfill\w*|\bpopulat\w*|\btype\w*|\benter\w*|\bedit\w*|\bsort\w*|\bfilter\w*|\btoggl\w*|\bcheck\w*|\bunchecked?\b|\bselect\w*|\bdrag\w*|\bdrop\w*|\bdelete\w*|\bremov\w*|\badd\w*|\bupdat\w*|\bchang\w*|\bmodif\w*|\bsav\w*|\bupload\w*|\bclear\w*|\bresize\w*/i;

/** Nouns that mark a scenario as a value-capture (scopes the circular check to capture-compare tests). */
const CAPTURE_VALUE_NOUNS = [...VALUE_NOUNS, 'cell', 'text', 'content', 'row', 'field', 'attribute', 'amount'];

/**
 * Returns a reason string when the scenario is a circular unchanged-assertion:
 * it captures a value and asserts the value did not change, but nothing between
 * the capture and the compare could have changed it (a reload of a static value,
 * or no action at all). Such an assertion compares a value to itself, so it can
 * never fail and catches no regression. Returns null for a valid scenario.
 *
 * An "unchanged" assertion is valid when the scenario names a force that could
 * plausibly have changed the value (a stopped animation, a locked field, a row
 * pinned against a re-sort) or a real state-changing action other than a reload.
 */
export function circularUnchangedReason(s: PlannedScenario): string | null {
  const hay = s.name.toLowerCase();
  // Only a value-capture scenario can be circular in this sense.
  const hasValueNoun = CAPTURE_VALUE_NOUNS.some((n) => new RegExp(`\\b${n}\\b`).test(hay));
  if (!hasValueNoun) return null;
  // Only an unchanged/equality assertion can compare a value to itself.
  if (!UNCHANGED_RE.test(hay)) return null;
  // A real force could have changed it → the unchanged assertion is meaningful.
  if (DYNAMIC_HELD_RE.test(hay)) return null;
  const isReloadOrNoop = RELOAD_NOOP_RE.test(hay);
  const hasMutatingAction = MUTATING_ACTION_RE.test(hay) && !isReloadOrNoop;
  if (hasMutatingAction) return null;
  return 'circular unchanged-assertion: the captured value is compared to itself with no state-changing action in between (a reload of a static value or a no-op), so it can never fail';
}

/**
 * The assertion checks that something is NOT there: not present, not found, no
 * longer exists, absent, gone, removed.
 */
const ABSENCE_RE = /\bnot\s+(?:exist\w*|present|found|there|visible|displayed|render\w*)\b|\bdoes\s?n.?t\s+exist\b|\bdoes\s+not\s+exist\b|\bis\s?n.?t\s+(?:present|there|found|visible)\b|\bno\s+longer\b|\babsent\b|\bnot\s+found\b|\bdoes\s?n.?t\s+(?:appear|show|render)\b|\bnonexistent\b|\bnon-existent\b|\bgone\b|\bdisappear\w*/i;

/**
 * The target named in the scenario is an invented, never-real identifier: a
 * "nonexistent" / "fake" / "bogus" / "made-up" thing, or a junk literal nobody
 * expected to find (xyz, foobar, asdf). Asserting such a thing is absent can
 * never fail, because it was never there to begin with.
 */
const FAKE_IDENTIFIER_RE = /\bnonexistent\b|\bnon-existent\b|\bnon-?existing\b|\bdoes-?not-?exist\w*\b|\bfake\b|\bbogus\b|\bdummy\b|\bgarbage\b|\bmade-?up\b|\bmadeup\b|\bimaginary\b|\bnot-?real\b|\bnotreal\b|\bnonsense\b|\bfictional\b|\binvented\b|\brandom-?(?:name|id|frame|string|value|word|text)\b|\binvalid-?(?:name|id|frame|selector)\b|\bxyz\b|\bfoobar\b|\bfoo-?bar\b|\basdf\w*\b|\bqwerty\b|\bzzz+\b|\b\w*-xyz\b|\b\w*-?doesnotexist\b/i;

/**
 * An action that makes a REAL element go away: removed, deleted, hidden,
 * filtered out, cleared, dismissed, closed, logged out, collapsed, unchecked.
 * Narrower than the general mutating-action set so a verify verb ("check") or a
 * selector noun ("selector") is not read as a removal.
 */
const REMOVAL_ACTION_RE = /\bremov\w*|\bdelet\w*|\bhid\w*|\bhidden\b|\bfilter\w*|\bclear\w*|\bdismiss\w*|\bclos\w*|\blogged?\s?out\b|\bsigned?\s?out\b|\bcollaps\w*|\bcancel\w*|\bunchecked?\b|\buncheck\w*/i;

/**
 * Returns a reason when the scenario asserts the absence of a hardcoded fake
 * identifier that was never expected to exist. "the nonexistent-frame-xyz frame
 * does not exist" can never go red, because nothing on any version of the page
 * was ever named that, so the test catches no regression. Returns null for a
 * real absence test (something that existed and was removed, hidden, or filtered
 * out), which is a legitimate negative test.
 */
export function vacuousAbsenceReason(s: PlannedScenario): string | null {
  const hay = s.name.toLowerCase();
  if (!ABSENCE_RE.test(hay)) return null;
  if (!FAKE_IDENTIFIER_RE.test(hay)) return null;
  // A real thing that an action removed, hid, or filtered out is a valid absence
  // test, even if the scenario also uses a junk-looking word somewhere. The
  // removal is what makes the absence meaningful: it WAS there, then it went
  // away. This is narrower than the general mutating-action set on purpose, so a
  // verify verb ("check") or a selector noun ("selector") is not mistaken for a
  // real removal.
  if (REMOVAL_ACTION_RE.test(hay)) return null;
  return 'vacuous absence assertion: the scenario asserts a hardcoded fake identifier is absent, but it was never expected to exist, so the assertion can never fail and catches no regression';
}

/**
 * Remove unfalsifiable scenarios at plan time. Two shapes catch no regression:
 * a circular unchanged-assertion (capture a value, reload or do nothing, assert
 * it did not change) and a vacuous absence assertion (assert a hardcoded fake
 * identifier is absent when it never existed). The kept list preserves plan
 * order; rejected entries name why.
 */
export function rejectCircular(scenarios: PlannedScenario[]): {
  kept: PlannedScenario[];
  rejected: Array<{ scenario: PlannedScenario; reason: string }>;
} {
  const kept: PlannedScenario[] = [];
  const rejected: Array<{ scenario: PlannedScenario; reason: string }> = [];
  for (const s of scenarios) {
    const reason = circularUnchangedReason(s) ?? vacuousAbsenceReason(s);
    if (reason) rejected.push({ scenario: s, reason });
    else kept.push(s);
  }
  return { kept, rejected };
}

/**
 * Drop near-duplicate scenarios. Two scenarios are near-duplicates when they
 * capture the same value and assert the same relation under the same feature —
 * for example a click-regenerates-id and a reload-regenerates-id pair that both
 * prove the id changed. The first one in plan order is kept; later matches are
 * dropped. Scenarios that assert a different relation on the same value (changed
 * vs absent) have different signatures and both survive. Scenarios that are not
 * capture-and-compare (no signature) are never dropped.
 */
export function dedupePlan(scenarios: PlannedScenario[]): {
  kept: PlannedScenario[];
  dropped: Array<{ scenario: PlannedScenario; duplicateOf: PlannedScenario }>;
} {
  const kept: PlannedScenario[] = [];
  const dropped: Array<{ scenario: PlannedScenario; duplicateOf: PlannedScenario }> = [];
  const seen = new Map<string, PlannedScenario>();
  for (const s of scenarios) {
    const sig = captureSignature(s);
    if (sig && seen.has(sig)) {
      dropped.push({ scenario: s, duplicateOf: seen.get(sig)! });
      continue;
    }
    if (sig) seen.set(sig, s);
    kept.push(s);
  }
  return { kept, dropped };
}

/* ── Page fit ─────────────────────────────────────────────────────────────── */

/**
 * One control the page-fit vocabulary knows. `named` matches the NORMALIZED
 * scenario name when the scenario names the control; the evidence side says
 * what on the snapshot proves the page has it. Field controls are evidenced
 * by the snapshot's inputs only (a "Forgot Password" heading is not a password
 * field); controls that live in text (a Sort label, a Filters button, a price)
 * are evidenced by anything on the page.
 */
export interface PageFitTerm {
  /** The label the log line uses, e.g. "first name", "sort", "price". */
  control: string;
  /** Matches the normalized scenario name when the scenario names this control. */
  named: RegExp;
  /** Matches the normalized evidence text when the page shows the control. */
  evidence: RegExp;
  /** Where the evidence may come from: the inputs list only, or anything on the page. */
  from: 'inputs' | 'any';
  /** Input types or tags (`select`, `textarea`) that evidence the control on their own. */
  kinds?: string[];
  /** Evidence from N or more inputs of a type (two password fields evidence a confirm field). */
  atLeast?: [type: string, count: number];
  /** Evidence read from the RAW text sample, which keeps currency symbols the normalizer drops. */
  raw?: RegExp;
  /** Evidence from the presence of table column headers (a sortable table is a sort control). */
  tableHeaders?: boolean;
  /** The whole-document flag (PageFlags) that evidences the control on its own. */
  flag?: keyof PageFlags;
}

/**
 * A scenario that reaches something by navigation is judged only on the
 * controls its FIRST action needs on the planned page. "clicked a product
 * and landed on its detail page showing name and price" needs an item link,
 * which the snapshot cannot list, and the price lives on the page the click
 * reaches, so the price is never judged against the listing. The verbs:
 * clicked, click, opens, opened, landed, lands, navigates, navigated, goes
 * to, detail page. Exported for the smoke.
 */
export const NAV_VERB_RE = /\b(clicked|click|opens|opened|landed|lands|navigates|navigated|goes to|detail page)\b/;

/**
 * The controls a navigation scenario may still be judged on: what its first
 * action on the planned page needs when the name says so. Value kinds
 * (price, cost, quantity, total) are never among them.
 */
export const FIRST_ACTION_CONTROLS: ReadonlySet<string> = new Set(['search', 'sort', 'filter']);

/**
 * The page-fit vocabulary. Order matters only for which missing control the
 * log line names first. Matching is on normalized words (lowercase, camelCase
 * and snake_case split, punctuation dropped), never exact strings, and each
 * row carries its own small synonym set, so "first_name", "firstName",
 * "given name" and "First name" all evidence the first-name field.
 *
 * Words with an outcome sense are excluded on the name side: "error message"
 * and "success message" are results, not the message field; "email address"
 * is not a street address. Nouns the snapshot cannot evidence (a product
 * name, an image) and flow words (login, register, add to cart) are not in
 * the table on purpose: a scenario may click through to reach them.
 */
export const PAGE_FIT_TERMS: PageFitTerm[] = [
  { control: 'first name', from: 'inputs', named: /\b(first|given) ?name\b|\bforename\b/, evidence: /\b(first|given) ?name\b|\bforename\b|\bfname\b/ },
  { control: 'last name', from: 'inputs', named: /\b(last|family) ?name\b|\bsurname\b/, evidence: /\b(last|family) ?name\b|\bsurname\b|\blname\b/ },
  { control: 'username', from: 'inputs', named: /\buser ?name\b|\buser ?id\b|\blogin name\b/, evidence: /\buser ?name\b|\buser ?id\b|\blogin\b|\bhandle\b/ },
  { control: 'email', from: 'inputs', named: /\be ?mail\b/, evidence: /\be ?mail\b/, kinds: ['email'] },
  { control: 'confirm password', from: 'inputs', named: /\b(confirm|confirmation|repeat|retype|re ?enter)\w* (the |your )?(password|pwd)\b|\bpassword confirm\w*\b/, evidence: /\b(confirm|confirmation|repeat|retype|re ?enter)\w* (the |your )?(password|pwd)\b|\bpassword confirm\w*\b/, atLeast: ['password', 2] },
  { control: 'password', from: 'inputs', named: /\bpassword\b|\bpasswd\b/, evidence: /\bpassword\b|\bpasswd\b/, kinds: ['password'] },
  { control: 'phone', from: 'inputs', named: /\b(tele)?phone\b|\bmobile\b/, evidence: /\b(tele)?phone\b|\bmobile\b|\btel\b/, kinds: ['tel'] },
  { control: 'address', from: 'inputs', named: /(?<!e ?mail |ip |web |url )\baddress\b|\bstreet\b/, evidence: /(?<!e ?mail |ip |web |url )\baddress\b|\bstreet\b/ },
  { control: 'subject', from: 'inputs', named: /\bsubject\b/, evidence: /\bsubject\b|\btopic\b/ },
  { control: 'message', from: 'inputs', named: /(?<!(error|success|validation|confirmation|alert|warning|status|toast|inline|failure|flash|welcome|feedback|info|help|hint) )\bmessage\b/, evidence: /\bmessage\b|\bcomment\b/, kinds: ['textarea'] },
  { control: 'comment', from: 'inputs', named: /\bcomments?\b/, evidence: /\bcomments?\b/, kinds: ['textarea'] },
  { control: 'quantity', from: 'inputs', named: /\bquantity\b|\bqty\b/, evidence: /\bquantity\b|\bqty\b/, kinds: ['number'] },
  { control: 'search', from: 'inputs', named: /\bsearch(ed|es|ing)?\b/, evidence: /\bsearch\w*\b/, kinds: ['search'], flag: 'hasSearch' },
  { control: 'sort', from: 'any', named: /\bsort(ed|s|ing)?\b/, evidence: /\bsort\w*\b|\border by\b/, tableHeaders: true, flag: 'hasSort' },
  { control: 'filter', from: 'any', named: /\bfilter(ed|s|ing)?\b/, evidence: /\bfilter\w*\b/, kinds: ['checkbox'], flag: 'hasFilter' },
  { control: 'checkbox', from: 'inputs', named: /\bcheck ?box(es)?\b|\btick ?box(es)?\b/, evidence: /\bcheck ?box\w*\b/, kinds: ['checkbox'] },
  { control: 'radio', from: 'inputs', named: /\bradio\b/, evidence: /\bradio\b/, kinds: ['radio'] },
  { control: 'dropdown', from: 'inputs', named: /\bdrop ?down\b|\bcombo ?box\b|\bselect (menu|list|box)\b/, evidence: /\bdrop ?down\b|\bcombo ?box\b/, kinds: ['select', 'select-one', 'select-multiple'] },
  { control: 'slider', from: 'inputs', named: /\bslider\b|\brange (slider|input|control)\b/, evidence: /\bslider\b/, kinds: ['range'] },
  { control: 'file upload', from: 'inputs', named: /\bupload\w*\b|\battach\w*\b|\bfile (input|field|picker)\b/, evidence: /\bupload\w*\b|\battach\w*\b/, kinds: ['file'] },
  { control: 'date', from: 'inputs', named: /\bdate of birth\b|\bbirth ?da(te|y)\b|\bdob\b|\bdate (picker|field|input)\b/, evidence: /\bdate\b|\bdob\b|\bbirth\w*\b/, kinds: ['date', 'datetime-local'] },
  { control: 'country', from: 'inputs', named: /\bcountry\b/, evidence: /\bcountry\b|\bcountries\b/ },
  { control: 'city', from: 'inputs', named: /\bcity\b/, evidence: /\bcity\b|\btown\b/ },
  { control: 'postcode', from: 'inputs', named: /\bpost(al)? ?code\b|\bzip( code)?\b/, evidence: /\bpost(al)? ?code\b|\bzip\b|\bpostal\b/ },
  { control: 'company', from: 'inputs', named: /\bcompany\b/, evidence: /\bcompany\b|\borgani[sz]ation\b/ },
  { control: 'coupon', from: 'inputs', named: /\bcoupon\b|\bpromo( code)?\b|\bvoucher\b|\bdiscount code\b/, evidence: /\bcoupon\b|\bpromo\w*\b|\bvoucher\b|\bdiscount\b/ },
  { control: 'remember me', from: 'inputs', named: /\bremember me\b/, evidence: /\bremember\b/ },
  { control: 'terms', from: 'inputs', named: /\bterms (and )?conditions\b|\b(accept|agree)\w* (to )?(the )?terms\b|\bterms check ?box\b/, evidence: /\bterms\b|\bagree\w*\b|\baccept\w*\b/ },
  { control: 'newsletter', from: 'inputs', named: /\bnewsletter\b/, evidence: /\bnewsletter\b|\bsubscri\w*\b/ },
  { control: 'pagination', from: 'any', named: /\bpaginat\w*\b|\b(next|previous|prev) page\b|\bpage \d+\b/, evidence: /\bpaginat\w*\b|\bnext\b|\bprevious\b|\bpage \d+\b/, flag: 'hasPagination' },
  { control: 'price', from: 'any', named: /\bprices?\b|\bpriced\b/, evidence: /\bprices?\b|\bpriced\b|\bcost\b/, raw: /[$€£¥]\s?\d|\d\s?(usd|eur|gbp|chf|jpy)\b/i, flag: 'hasPrice' },
];

/**
 * Words as the page-fit pass compares them: camelCase and snake_case split,
 * lowercase, punctuation dropped, single spaces. "firstName", "first_name" and
 * "First name" all become "first name". Exported for the smoke.
 */
export function normalizeWords(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The cap on the snapshot's inputs list; past it the list is known to be incomplete. */
const SNAPSHOT_INPUTS_CAP = 25;

/** What the snapshot evidences, built once per plan and read by every term. */
interface PageEvidence {
  inputs: string;
  any: string;
  raw: string;
  kinds: Set<string>;
  typeCounts: Map<string, number>;
  tableHeaders: number;
  /** True when the inputs list hit its cap, so a field past it may exist unseen. */
  inputsCapped: boolean;
  /** The whole-document flags, when the snapshot carries them. */
  flags?: Partial<PageFlags>;
}

/** The evidence-side shape of a snapshot: the top document plus every content frame. */
export type PageFitSnapshot = Pick<PageSnapshot, 'inputs' | 'buttons' | 'headings' | 'textSample' | 'frames'> & Partial<Pick<PageSnapshot, 'tableHeaders'>> & { flags?: Partial<PageFlags> };

function elWords(el: PickedEl): string {
  return [el.label, el.labelText, el.id, el.type, el.tag].filter((x): x is string => !!x).join(' ');
}

function buildEvidence(snap: PageFitSnapshot): PageEvidence {
  const inputs: PickedEl[] = [...snap.inputs, ...snap.frames.flatMap((f) => f.inputs)];
  const others: PickedEl[] = [...snap.buttons, ...snap.headings, ...snap.frames.flatMap((f) => [...f.buttons, ...f.headings])];
  const rawText = [snap.textSample, ...snap.frames.map((f) => f.textSample)].join(' ');
  // Column headers count as field evidence: "sorted the table by last name"
  // names the Last Name column, which a table page has and an inputs list
  // does not.
  const inputText = normalizeWords([...inputs.map(elWords), ...(snap.tableHeaders ?? [])].join(' '));
  const anyText = normalizeWords([inputText, ...others.map(elWords), rawText].join(' '));
  const kinds = new Set<string>();
  const typeCounts = new Map<string, number>();
  for (const el of inputs) {
    kinds.add(el.tag);
    if (el.type) {
      kinds.add(el.type);
      typeCounts.set(el.type, (typeCounts.get(el.type) ?? 0) + 1);
    }
  }
  return {
    inputs: inputText,
    any: anyText,
    raw: rawText,
    kinds,
    typeCounts,
    tableHeaders: (snap.tableHeaders ?? []).length,
    inputsCapped: snap.inputs.length >= SNAPSHOT_INPUTS_CAP,
    ...(snap.flags ? { flags: snap.flags } : {}),
  };
}

function termEvidenced(t: PageFitTerm, ev: PageEvidence): boolean {
  // The whole-document flag is the primary evidence for the controls that
  // have one: it was read over the full text and the full control set.
  if (t.flag && ev.flags?.[t.flag] === true) return true;
  // A capped inputs list may hide the field; read the whole page then, so a
  // 30-field form is never judged on its first 25 controls.
  const hay = t.from === 'inputs' && !ev.inputsCapped ? ev.inputs : ev.any;
  if (t.evidence.test(hay)) return true;
  if (t.kinds?.some((k) => ev.kinds.has(k))) return true;
  if (t.atLeast && (ev.typeCounts.get(t.atLeast[0]) ?? 0) >= t.atLeast[1]) return true;
  if (t.raw && t.raw.test(ev.raw)) return true;
  if (t.tableHeaders && ev.tableHeaders > 0) return true;
  return false;
}

/**
 * The control a scenario names that the page snapshot does not show, or null
 * when every named control is evidenced (or none is named). Run 591732
 * planned three registration scenarios on a one-field password-reset form and
 * four rentals scenarios asserting a price on cards that carry none; each
 * would have failed or thrashed in the Explorer. Exported for the smoke.
 */
export function pageFitReason(s: PlannedScenario, snapshot: PageFitSnapshot): { control: string; reason: string } | null {
  const name = normalizeWords(s.name);
  const ev = buildEvidence(snapshot);
  // A navigation scenario is judged only on its first action's controls on
  // the planned page; what it reads after the click lives on another page.
  const navigates = NAV_VERB_RE.test(name);
  for (const t of PAGE_FIT_TERMS) {
    if (navigates && !FIRST_ACTION_CONTROLS.has(t.control)) continue;
    if (!t.named.test(name)) continue;
    if (termEvidenced(t, ev)) continue;
    return { control: t.control, reason: `names ${t.control} which the page snapshot does not show` };
  }
  return null;
}

/**
 * Drop every planned scenario that names a control the page snapshot does
 * not show. Runs after dedup and circular rejection, before the iframe
 * injection. The kept list preserves plan order; each rejection names the
 * scenario and the missing control.
 */
export function rejectPageFit(scenarios: PlannedScenario[], snapshot: PageFitSnapshot): {
  kept: PlannedScenario[];
  rejected: PageFitRejection[];
} {
  const kept: PlannedScenario[] = [];
  const rejected: PageFitRejection[] = [];
  for (const s of scenarios) {
    const hit = pageFitReason(s, snapshot);
    if (hit) rejected.push({ scenario: s, control: hit.control, reason: hit.reason });
    else kept.push(s);
  }
  return { kept, rejected };
}

/* ── Cross-page dedup ─────────────────────────────────────────────────────── */

/** The identity a scenario has across pages: feature, category and normalized intent. */
function crossPageKey(s: PlannedScenario): string {
  return `${(s.feature ?? '').toLowerCase()}|${s.category}|${scenarioNameKey(s.name)}`;
}

/**
 * The same feature + category + intent planned on two pages is one scenario,
 * not two. Run 591732 planned "logged in with valid credentials" on the login
 * page and again on the entry page, and the second shipped as "(page 2)". The
 * copy on the page whose feature tag names the scenario's feature wins; when
 * neither or both do, the first in ladder order wins. A name shared by
 * scenarios of a DIFFERENT feature or category is not a duplicate and still
 * goes through the rename in uniqueScenarioNames. Exported for the smoke.
 */
export function dedupeAcrossPages(
  existing: PlannedScenario[],
  incoming: PlannedScenario[],
  page: { url: string; feature?: string },
  pageFeatureOf: (url: string | undefined) => string | undefined,
): { existing: PlannedScenario[]; incoming: PlannedScenario[]; dropped: Array<{ scenario: PlannedScenario; duplicateOf: PlannedScenario }> } {
  const all: PlannedScenario[] = [...existing];
  const fromIncoming = new Set<PlannedScenario>();
  const dropped: Array<{ scenario: PlannedScenario; duplicateOf: PlannedScenario }> = [];
  for (const s of incoming) {
    const key = crossPageKey(s);
    const idx = all.findIndex((e) => crossPageKey(e) === key);
    if (idx < 0) {
      all.push(s);
      fromIncoming.add(s);
      continue;
    }
    const e = all[idx]!;
    const incomingOnItsPage = !!s.feature && page.feature === s.feature;
    const existingOnItsPage = !!e.feature && pageFeatureOf(e.pageUrl) === e.feature;
    if (incomingOnItsPage && !existingOnItsPage) {
      dropped.push({ scenario: e, duplicateOf: s });
      all.splice(idx, 1);
      all.push(s);
      fromIncoming.add(s);
    } else {
      dropped.push({ scenario: s, duplicateOf: e });
    }
  }
  return {
    existing: all.filter((s) => !fromIncoming.has(s)),
    incoming: all.filter((s) => fromIncoming.has(s)),
    dropped,
  };
}

/* ── Feature reachability ─────────────────────────────────────────────────── */

/**
 * SRS features with stated rules that no discovered page carries as its
 * feature tag. Their rules can only report not-planned, and the run should
 * say so at plan time instead of leaving it to the coverage report (run
 * 591732: cart, 4 rules, 0 scenarios). Never invents a URL. Exported for the
 * smoke.
 */
export function unreachableFeatures(map: RequirementsMap | undefined, pages: Array<{ feature?: string }>): Array<{ name: string; rules: number }> {
  if (!map) return [];
  const tagged = new Set(pages.map((p) => p.feature).filter((f): f is string => !!f));
  return map.features
    .filter((f) => f.rules.length > 0 && !tagged.has(f.name))
    .map((f) => ({ name: f.name, rules: f.rules.length }));
}

/** The one console line for an unreachable feature. */
export function unreachableFeatureLine(f: { name: string; rules: number }): string {
  return `Feature "${f.name}" has ${f.rules} rule${f.rules === 1 ? '' : 's'} and no discovered page; its rules will report not-planned`;
}

/**
 * Check every rule citation against the scenario that makes it: a happy
 * scenario may not cite a rule whose text states a rejection (error, reject,
 * invalid, required, locked), and a negative may not cite a rule with none of
 * those. A mismatched id is removed from the scenario and reported, so a
 * shipped test can never be counted as covering a rule it does not verify.
 * Without a map nothing is checked. Exported for smoke-plan-rule-tags.
 */
export function applyCitationChecks(
  scenarios: PlannedScenario[],
  map?: RequirementsMap,
): { scenarios: PlannedScenario[]; citationDrops: Array<{ scenario: string; ruleId: string; reason: string }> } {
  if (!map) return { scenarios, citationDrops: [] };
  const ruleText = new Map<string, string>();
  for (const f of map.features) for (const r of f.rules) ruleText.set(r.id.toUpperCase(), r.text);
  const citationDrops: Array<{ scenario: string; ruleId: string; reason: string }> = [];
  const out = scenarios.map((s) => {
    if (!s.ruleIds || s.ruleIds.length === 0) return s;
    const kept = s.ruleIds.filter((id) => {
      const text = ruleText.get(id.toUpperCase());
      if (text === undefined) return true;
      const reason = citationMismatchReason(s.category, text);
      if (!reason) return true;
      citationDrops.push({ scenario: s.name, ruleId: id, reason });
      return false;
    });
    return kept.length === s.ruleIds.length ? s : { ...s, ruleIds: kept };
  });
  return { scenarios: out, citationDrops };
}

const LOCK_RULE_RE = /\block(ed|s|out|ing)?\b/i;

/**
 * Planned scenarios whose cited rule names a locked account. These keep the
 * real account (their point IS the lockout); the tool-level credential
 * rewrite in tools.ts exempts them. Exported for smoke-plan-rule-tags.
 */
export function lockoutScenarioNames(plan: PlannedScenario[], map?: RequirementsMap): string[] {
  if (!map) return [];
  const lockIds = new Set(map.features.flatMap((f) => f.rules.filter((r) => LOCK_RULE_RE.test(r.text)).map((r) => r.id.toUpperCase())));
  if (lockIds.size === 0) return [];
  return plan.filter((s) => (s.ruleIds ?? []).some((id) => lockIds.has(id.toUpperCase()))).map((s) => s.name);
}

/**
 * Identifiers of real accounts the SRS names: e-mail addresses and snake_case
 * account names (standard_user, locked_out_user) anywhere in the rules,
 * feature descriptions or roles. Lowercased, deduped. Exported for the smoke.
 */
export function knownAccountIdentifiers(map?: RequirementsMap): string[] {
  if (!map) return [];
  const texts: string[] = [];
  for (const f of map.features) {
    texts.push(f.description ?? '');
    for (const r of f.rules) texts.push(r.text);
  }
  for (const role of map.roles ?? []) texts.push(String(role));
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []) out.add(m.toLowerCase());
    for (const m of t.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi) ?? []) out.add(m.toLowerCase());
  }
  return [...out];
}

/**
 * Scenario names unique across pages. Per-page planning can produce the same
 * name twice (run f3b41e: "rejected wrong password and stayed on login page"
 * on two pages), and skip_scenario, verdict matching and the funnel all key
 * on the name, so the second one was unreachable and the funnel lost a
 * scenario. A duplicate gets the page's feature appended when that tells the
 * two apart, else the page's path, then a counter. Exported for
 * smoke-plan-enforcement.
 */
export function uniqueScenarioNames(
  existing: PlannedScenario[],
  incoming: PlannedScenario[],
  page: { url: string; feature?: string },
): { scenarios: PlannedScenario[]; renames: Array<{ from: string; to: string }> } {
  const taken = new Map<string, PlannedScenario>();
  for (const s of existing) taken.set(scenarioNameKey(s.name), s);
  const renames: Array<{ from: string; to: string }> = [];
  const out: PlannedScenario[] = [];
  let pathTag = '';
  try { pathTag = new URL(page.url).pathname.replace(/^\/+|\/+$/g, ''); } catch { pathTag = ''; }
  for (const s of incoming) {
    const key = scenarioNameKey(s.name);
    const clash = taken.get(key);
    if (!clash) { taken.set(key, s); out.push(s); continue; }
    const featureTag = page.feature && page.feature !== clash.feature ? page.feature : '';
    const tag = featureTag || pathTag || 'page 2';
    let name = `${s.name} (${tag})`;
    let n = 2;
    while (taken.has(scenarioNameKey(name))) { name = `${s.name} (${tag} ${n})`; n++; }
    const renamed = { ...s, name };
    taken.set(scenarioNameKey(name), renamed);
    renames.push({ from: s.name, to: name });
    out.push(renamed);
  }
  return { scenarios: out, renames };
}
