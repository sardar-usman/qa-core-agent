# Diagnosis of run 51d535 (practicesoftwaretesting.com, 2026-09-24)

Run directory: `output/practicesoftwaretesting-com/20260924T152355Z-51d535/`. Files read in full: `run-report.json`, `events.jsonl`, `discovery.json`, `rule-coverage.json`, `requirements-map.json`, `run-meta.json`, and the framework zip unpacked to a temporary directory (`pages/*.ts`, `tests/**/*.spec.ts`). Source read where a finding needed it: `src/agent/pom.ts` (field naming, the beforeEach goto), `src/agent/tools.ts` (the assert tool's intent default), `src/agent/gate.ts`, `src/agent/planner.ts` (page fit), `src/agent/requirements.ts`. Compared against the run 591732 diagnosis. `run-meta.json` says the run came from the CLI with the same SRS as run 3 and no override beyond the $6 ceiling: the run 5 the STATE bar was set for, after PRs #25 to #29. Where a value is the operator's report of a check outside the run directory it is marked so. Where the files cannot answer, the section says so.

## 1. Numbers

| Measure | Run 5 (51d535) | Run 4 (591732) | Field |
|---|---|---|---|
| Pages found by the crawl | 14 | 14 | `discovery.json` `candidates` |
| Pages kept for planning | 8 (3 category siblings marked same template) | 7 | `report.discovery.pages` |
| Planned | 17 | 20 | `reconciliation.planned` |
| Explored (recorded by the Explorer) | 13 | 13 | first `critic_done` event |
| Critic first pass: pass / rework / reject | 3 / 9 / 1 of 13 | 5 / 6 / 2 of 13 | first `critic_done` event |
| Repair pass | 5 of 9 rework funded, 2 kept, $0.7607 | 2 of 7 funded, 1 kept | `review.repair`, the decision line at 15:38:36 |
| Replay pass | 5 of 5 | 5 of 5 | `replay` |
| Stability | 5 of 5 stable, 15 iterations green | 5 of 5 | `stability` |
| Shipped | 5 | 5 | `report.scenarios.length` |
| Rules covered | 4 of 14 | 5 of 14 | `ruleCoverage` |
| Total cost (four terms) | $6.03 | $4.57 | `cost.usd` + `plannerUsd` + `criticUsd` + `stability.stabilizerCostUsd` |
| Explorer cost without repair | $5.1490 | $4.0892 | `cost.usd` minus `cost.repairUsd` |
| Explorer cost per explored scenario | $0.3961 | $0.3146 | the decision line |
| Steps | 272 | 214 | `report.steps` |
| Wall time | 18 min 41 s | 16 min 46 s | `startedAt` to `finishedAt` |
| End | stopped at the explorer ceiling ($5.149 against the $5.10 share), framework written | completed | `report.stopped` |
| Framework executed | 3 failed of 6 on a clean install; 6 of 6 failed on a second run while the site refused connections | 6 of 6 green | the operator's checks outside the run directory; no artifact in it records this |

The three tests that failed on the clean install: the catalogue happy path (a price regex asserted against the page title), the contact happy path (a "Thanks" regex asserted against the error locator), and the account negative login (the test started on the registration page). None of the three had failed in 20 executions inside the pipeline, because the pipeline replays the RECORDED steps and never runs the emitted spec.

## 2. The bar and its verdict

The bar, set after run 4 (STATE.md): 8 or more shipped, 7 or more rules, same command.

Verdict: bar missed. 5 shipped against 8, 4 rules against 7. Cost $6.03 of the $6.00 ceiling, with the explorer stopped at its share mid-scenario. The shipped count equals run 4's, the rule count is one lower, and the framework that shipped fails on a clean install. The findings below are ranked by what they cost the bar; finding 1 is fixed in this PR (with a new stage that would have caught it), findings 2 to 9 are the next PR.

## Findings, ranked

### 1. The emitted framework fails after 20 green executions: field identity and the multi-page feature (fixed in this PR)

Artifact: `pages/contact-page.ts` line 18 in the zip: `this.element = page.locator("[data-test=\"message-help\"], .invalid-feedback, .alert-danger");`, one field named `element` used by both contact tests; `tests/contact/contact.spec.ts` asserts `expect(contactPage.element).toContainText(/[Tt]hank/, { timeout: 15000 })` for the happy path, which the Explorer recorded on `css: "body"` (the `assert` tool_call at 15:30:57: `{"type": "toContainText", "css": "body", "regex": "[Tt]hank", "timeout": 15000}`, no intent), and `expect(contactPage.element).toHaveCount(0, ...)`, recorded on `testid: "contact-submit"` (15:30:59, no intent). `pages/catalogue-page.ts` line 12: `this.element = page.getByText("Category: Hand Tools").first();` used by the price regex assertion recorded on `css: "a[data-testid^=\"product-\"]:first-of-type"` (15:27:24, no intent). `pages/account-page.ts` line 6: `readonly url = "https://practicesoftwaretesting.com/auth/register";` for a feature holding the registration test (first navigate `/auth/register`) and the login test (first navigate `/auth/login`), so the beforeEach `goto()` opened the wrong page for the login test. 79 of the run's `assert`, `capture` and `assert_compare` calls carried no intent; the tool defaulted each to "element", and `pom.ts` keyed fields by intent. Fix: a field is keyed by the locator's identity and named from a unique intent or the locator; the tools derive an intent from the hints and never record a placeholder; a feature whose scenarios begin on different URLs emits a goto per test; and a new final stage runs the emitted framework before the zip and drops a test that fails twice (invariants 62 and 63).

### 2. Four reworks from the toHaveURL no-timeout choice in PR #28 (next PR)

Artifact: the first `critic_done` at 15:38:36 reworked "rejected login with a wrong password" ('assert URL matches regex "/auth/login" [no-timeout]' is a timing rule 1 violation), "rejected registration with an already-used email address", "showed required-field error when submitting with empty first name" and "showed required-field error when submitting with empty email address" (each: 'assert URL matches regex "/auth/register" [no-timeout]' has no timeout), and named the same on "clicked a product and landed on its detail page". PR #28 left a `toHaveURL` with no model timeout as it is (invariant 36: it has no element and polls on its own), so the record reads `[no-timeout]` and the Critic reads that as a one-shot check. Three of the four were then unfunded reworks (budget funds 5 of 9), which cost R11 and R12. Fix: gate RULE 2 floors a `toHaveURL` with no timeout at 5000 ms like every other assertion, so the record and the spec state the poll the Critic asks for.

### 3. Two 60-second dead waits on data-testid against data-test, and no per-host memory of the attribute (next PR)

Artifact: the `assert` tool_call at 15:26:25 `{"type": "toHaveCount", "css": "a[data-testid^=\"product-\"]", "atLeast": 1}` returned `ok: false` at 15:27:24 (59 s), and 15:27:33 `{"css": "[data-testid^=\"product-\"]"}` returned at 15:28:32 (59 s); the site uses `data-test`, and the run 4 diagnosis (finding 7) had already recorded that. Two minutes of wall time and two tool rounds of Opus for a convention the previous run knew. Fix: `get_dom` reports the test-id attribute the page uses, the assert and capture tools rewrite a `data-testid` css hint to `data-test` when the DOM carries only that attribute, and the per-host memory (`.qa-core/sites/<host>.json`) records the attribute so the next run starts with it.

### 4. Gate RULE 3 and RULE 4 firing at end_scenario after 15 and 12 calls, and role/label hints carrying a currency amount (next PR)

Artifact: the `end_scenario` tool_result at 15:29:59: "Gate REJECTED attempt 1/2 (RULE 3 (no CSS on animated elements)): step 2: fragile CSS-tier selector "a.card:nth-of-type(1)" used with capture", after the sort scenario's 15 calls from 15:28:45; and at 15:36:57: "Gate REJECTED attempt 1/2 (RULE 4 (intermediate value on animated element)): step 5: asserting "1" on an animated element", after 12 calls. RULE 7 already refuses a literal at the tool call (15:35:06, 15:36:52); RULE 3 and RULE 4 wait for `end_scenario` and force a full re-record. The Critic also reworked three scenarios for a role or label hint whose accessible name carried a price ("Clicking product by literal name 'Bolt Cutters ABCDE$48.41' pins to a volatile catalogue value"), because the card's accessible name concatenates its badge and price. Fix: RULE 3 and RULE 4 are checked at the tool call the way RULE 7 is, and a role or label hint whose name carries a currency amount is trimmed to the words before the amount, with the trim logged.

### 5. Page-fit false positive on the forgot-password form name, 3 scenarios (next PR)

Artifact: three `Rejected page-fit scenario` lines at 15:26:00 on `/auth/forgot-password`, each "names password which the page snapshot does not show": "submitted forgot-password form with a valid email and received a confirmation message", "rejected forgot-password form with empty email field and showed required-field error", "rejected forgot-password form with an invalid email format and showed format error". The word "password" in "forgot-password form" names the form, not a password field, and the page planned 0 scenarios (`Planner [7/8] ... 0 scenario(s)`). Fix: the page-fit name-side match for a field control ignores the page's own feature words and the compound recovery names ("forgot-password", "reset password", "password reset") so a recovery scenario is judged on the email field it actually uses.

### 6. The requirements map is not deterministic across runs (next PR)

Artifact: `requirements-map.json` in run 4 holds five features (catalogue 5 rules, cart 4, login 1, registration 2, contact 2); the same SRS in run 5 holds four (catalogue 5, cart 4, account 3, contact 2): login and registration merged into "account", the same 14 rules. `discovery.json` then tagged `/auth/login`, `/auth/register` and `/auth/forgot-password` all `account`, the Planner planned two registration scenarios on the login page (skipped at 15:32:51: "plan items 8 and 9 (registration on /auth/login) can't be tested there"), and the emitter built one `account` class across two pages (finding 1's multi-page feature). Fix: the map builder asks for one feature per distinct form or page the rules name and runs at temperature 0, and the map is cached in the project folder by the SRS file's hash so a re-run against the same SRS reuses it.

### 7. The Critic's second-pass complaints differ from its first-pass required fixes (next PR)

Artifact: for "rejected an email address without an @ sign", the first `critic_done` (15:38:36) required "Replace the secondary visibility assertion on contact-submit with a falsifiable check: assert that the success/thank-you message is NOT present (count=0 with polling), or assert aria-invalid"; the repaired trace did that, and the second `critic_done` (15:41:07) reworked it for a new reason: "Many browsers block form submission natively for invalid email inputs ... so the regex body assertion may never match" and "page.locator("body:has-text(...)") is non-standard". For "added a product from its detail page", the first pass required the badge TEXT capture and a `greater` compare; the second pass complained about an intermediate visible assertion and the `/^\d+$/` regex. Two of the five funded repairs were dropped for complaints the first pass never made, $0.30 of the $0.76 repair spend. Fix: the second pass is scoped to the first pass's required fixes: pass when they are applied, rework only for a required fix that is not, and any new complaint is recorded as a note, never a verdict.

### 8. The happy login failed with no visible message while preflight passed before and after (next PR)

Artifact: the scenario from 15:31:55: `fill` email `customer@practicesoftwaretesting.com`, `fill` password, `click` login submit, then `assert toHaveURL "/account" timeout 15000` failed at 15:32:20; the `get_dom` at 15:32:23 shows the page still at `/auth/login` with no error text; the model skipped at 15:32:29 ("Standard demo credentials ... were rejected"). The operator reports that the same credentials passed a preflight login before and after the run; that check is outside the run directory. The account is the site's shared demo account, so another visitor's failed attempts or a session limit can reject it at any moment, and R10's happy path and the auth setup both depend on it. Fix: the run registers its own account at start (the backlog item) and uses it for the happy login and the storageState setup, so no shared account is in the loop.

### 9. A self-contradicting negative sort scenario cost R4 (next PR)

Artifact: `report.plan` holds "[catalogue][negative] sorted by price low-to-high and the list remained unsorted"; the Critic rejected it at 15:38:36 with five reasons, the first being "The scenario name says 'remained unsorted' but the test setup actually selects 'price,asc'", and `rule-coverage.json` reads `R4 not-planned` because the reject removed the only citing scenario and its citation. The scenario asserts the negation of the action it performs, so no recording could satisfy it. Fix: `rejectCircular` in the Planner gains a third shape, a scenario whose name asserts the negation of its own action ("sorted ... remained unsorted", "filtered ... showed every product"), dropped at plan time so the citation survives for a coherent scenario.

## Ranked fix list

1. Field identity, intent derivation, the multi-page feature, and the emitted-spec check (finding 1). Fixed in this PR; locked by `smoke-emitted-run`, `smoke-emitted-check`, `smoke-reconcile`.
2. A `toHaveURL` with no timeout is floored by the gate like every other assertion (finding 2). `gate.ts`. Lock: `smoke-gate`.
3. The test-id attribute is detected, rewritten and remembered per host (finding 3). `tools.ts`, `memory.ts`. Lock: `smoke-data-test-attribute`.
4. RULE 3 and RULE 4 at the tool call; currency trimmed from role and label names (finding 4). `tools.ts`, `gate.ts`. Lock: `smoke-gate`.
5. Page fit ignores the recovery form's own name (finding 5). `planner.ts`. Lock: `smoke-plan-page-fit`.
6. A deterministic, cached requirements map (finding 6). `requirements.ts`. Lock: `smoke-srs-parse`.
7. The Critic's second pass scoped to its first-pass fixes (finding 7). `critic.ts`. Lock: `smoke-repair-pass`.
8. The run registers its own account (finding 8). `runtime.ts`, `auth-emit.ts`. Lock: `smoke-auth-emit`.
9. A negated-action scenario rejected at plan time (finding 9). `planner.ts`. Lock: `smoke-circular`.
