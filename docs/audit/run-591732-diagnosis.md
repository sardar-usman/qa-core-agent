# Diagnosis of run 591732 (practicesoftwaretesting.com, 2026-09-22)

Run directory: `output/practicesoftwaretesting-com/20260922T152127Z-591732/`. Files read in full: `run-report.json`, `events.jsonl`, `discovery.json`, `rule-coverage.json`, `requirements-map.json`, `run-meta.json`. Source read where a finding needed it: `src/agent/critic.ts` (describeStep, decideRepairPass), `src/agent/runtime.ts` (the repair decision), `src/agent/tools.ts` (skip_scenario), `src/agent/reconcile.ts`, `src/agent/trace.ts`. Compared against the three earlier diagnoses. `run-meta.json` says the run came from the dashboard with `QA_CORE_COST_CEILING=6`, the same SRS and no other override: the run 4 the STATE bar was set for, after PRs #23 to #26. Where a value is a live check against the site on 2026-09-22 it is marked live check. Where the files cannot answer, the section says so.

## 1. Numbers

| Measure | Run 4 (591732) | Run 3 (5e4394) | Field |
|---|---|---|---|
| Pages found by the crawl | 14 | 15 | `discovery.json` `candidates` |
| Pages kept for planning | 7 (3 category siblings marked same template) | 7 | `report.discovery.pages` |
| Planned | 20 | 20 | `reconciliation.planned` |
| Explored (recorded by the Explorer) | 13 | 16 | first `critic_done` event, `done.scenarios` |
| Critic first pass: pass / rework / reject | 5 / 6 / 2 of 13 | 1 / 14 / 1 of 16 | first `critic_done` event |
| Repair pass | 2 of 7 rework funded, 1 kept | 2 of 14 started, 0 kept | `review.repair`, the decision line |
| Replay pass | 5 of 5 | 1 of 1 | `replay` |
| Shipped | 5 | 1 | `report.scenarios.length` |
| Rules covered | 5 of 14 | 1 of 14 | `ruleCoverage` |
| Total cost (four terms) | $4.57 | $6.09 | `cost.usd` + `plannerUsd` + `criticUsd` + `stability.stabilizerCostUsd` |
| Explorer cost without repair | $4.0892 | $5.0751 | `cost.usd` minus `cost.repairUsd` |
| Explorer cost per explored scenario | $0.3146 | $0.3172 | the decision line |
| Steps | 214 | 274 | `report.steps` |
| Wall time | 16 min 46 s | 24 min 04 s | `startedAt` to `finishedAt` |
| Framework executed | 6 of 6 tests green in a clean install | not run | the run 4 verification outside the run directory; no artifact in it records this |

The rework verdicts: none of the six asked for a capability PR #23 added. They asked for a stronger outcome assertion, a timeout the Critic could not see, a generated value it took for a literal, and a duplicate email the credential guard replaced (findings 2 and 4).

## 2. The bar and its verdict

The bar, set before the run (STATE.md): 4 or more shipped and zero rework verdicts asking for a capability #23 added = hypothesis confirmed; 2 to 3 shipped with new rework reasons = partial; 0 to 1 shipped = the bottleneck is not the tool surface.

Verdict: hypothesis confirmed. 5 shipped, zero tool-capability reworks, the framework ran 6 of 6 in a clean install, cost $4.57 against the $6.00 ceiling with $1.43 unspent. What the funnel lost is now planning and process, not the tool surface: the eight findings below.

## Findings, ranked

### 1. The repair budget was the reserve, a cap, so 5 of 7 reworks were never repaired (fixed in this PR)

Artifact: the decision line in `events.jsonl` at 15:33:59: `repair pass: 2 of 7 rework scenario(s), budget $0.90 (the stated reserve); explorer cost this run $0.3146 per recorded scenario, so the reserve funds 2 of 7`. Code: `runtime.ts` passed `reserveUsd` to `decideRepairPass`, which set `budgetUsd = opts.reserveUsd` and `funds = floor(0.90 / 0.3146) = 2`. At that moment the run had spent $4.0892 exploring, $0.0297 planning and $0.0540 on the first Critic pass: $1.8271 of the $6.00 ceiling was unspent, and the pass was offered $0.90 of it. It spent $0.3818 on the two it started (one kept), and the run ended with $1.4327 unspent (`cost.usd` 4.4710 plus planner 0.0297 plus critic 0.0666). The old invariant 38 (commit 0ba6112) read "The budget check compares the TOTAL ceiling against actual spend and runs whenever it is positive"; PR #20 replaced it with "The budget is `reserveUsd` from `splitCeiling`, offered whole", and the code matched that text, which is the cap. Fix: the budget is the ceiling minus the spend at the decision, never below the reserve, and reworks are funded cheapest first by an estimate of half the explorer's per-scenario cost scaled by step count; with the run 4 numbers all 7 are funded.

### 2. The Critic could not see a count timeout, any URL timeout, or that a fill was generated

Artifact: the second `critic_done` at 15:36:19 reworked the repaired "filtered by eco-friendly checkbox" for "The assertion 'count=0' for non-ECO products is a one-shot read with no explicit timeout", while the `tool_call` at 15:35 that recorded it passed `timeout: 10000` (the count handler keeps the model's value on the step). The first `critic_done` at 15:33:57 reworked "registered with all required fields" for "The email 'qa.user.muctxhqd23em1vt@example.com' is a generated/specific email address" and "No timeout specified on the URL", while the fill's `tool_result` says `generated: "email"` (the step carries `generate: 'email'` and the emitted spec calls `uniqueEmail()`) and the `toHaveURL` call passed `timeout: 15000`. Code: `describeStep` in `critic.ts` renders `toHaveCount` as `count=N` with no timeout, renders `toHaveURL` with no timeout because the recorded `toHaveURL` assertion has no timeout field at all (`trace.ts`: `{ type: 'toHaveURL'; pattern: string }`, so the model's 15000 is never recorded), and renders a fill as `fill(<target>, "<value>")` with no mark for `generate`. Both dropped traces are gone from the report (backlog item on dropped traces), so the recorded timeout fields themselves cannot be read from the artifact; the tool calls and the code say what was recorded. Fix: describeStep renders the count timeout, the URL assertion records and renders its timeout, and a generated fill renders as `fill(<target>, uniqueEmail())`.

### 3. A skip of the scenario in progress left the trace open and one name landed in two buckets (fixed in this PR)

Artifact: `reconciliation.dropped[]` holds `{ name: "rejected registration when email was already registered", stage: "critic", reason: "critic reject: The scenario never clicks the submit button ... The only assertion is 'register submit button visible' ..." }` and `reconciliation.skipped[]` holds the same name with reason "The framework's PII guard auto-replaces the known existing customer email with a fresh unique fake email, so duplicate-email validation cannot be triggered reliably in a scenario." `reconciliation.note` reads "Explorer added 1 scenario(s) beyond the 20 planned (e.g. an a11y check). All 21 are named below, so the run still balances." No a11y scenario exists in the plan, the drops or the skips: the +1 is this double count. The sequence in `events.jsonl` from 15:29:17: `begin_scenario`, twelve fills, `get_dom`, `skip_scenario` on the open scenario at 15:29:38, then `begin_scenario` for the next one at 15:29:40; the skip left the trace open, so the model closed it with the vacuous assertion the Critic rejected. Fix: a skip naming the scenario in progress discards its open trace and records the skip once, and `reconcile` rejects a name in two buckets loudly.

### 4. The credential guard replaced the duplicate email the R11 test needs

Artifact: the skip reason above, and `rule-coverage.json`: `R11 planned-but-dropped`. The scenario typed `customer@practicesoftwaretesting.com` into the registration email field (the `fill` at 15:29:29 with intent "email input using existing customer email"), and `enforceFakeCredential` / the unique-data generator replaced it, so a duplicate-email rejection cannot be provoked. Rule R11 ("Registration with an already used email address is rejected with an error") is exactly the case the guard forbids. Fix: a negative registration scenario whose plan cites a duplicate-email rule keeps the literal it typed (the same exemption `lockoutScenarioNames` gives lockout rules), and the guard applies to login flows only.

### 5. Planning waste: three registration scenarios on the password-reset page, a duplicate login, and a cart feature with no page

Artifact: `report.plan[17..19]` are "created a new account with a valid email and password", "rejected registration when the email address was already in use" and "rejected registration when a required field was left empty", all with `pageUrl` `/auth/forgot-password` and feature `registration`, because `discovery.json` tags `/auth/forgot-password` as `registration` (the rule-content token map gives the registration feature the recovery words). `report.plan[15]` "logged in with valid credentials (page 2)" duplicates `plan[6]` on the entry page, which was tagged `login`. `rule-coverage.json` lists R6 to R9 (cart) as `not-planned`, and no cart page is among the 14 candidates: the site's cart is reached by adding a product, not by a link the crawl can follow. Nine of twenty planned scenarios were unusable or duplicated before exploration began. Fix: password-recovery tokens belong to a recovery feature, never to registration; the entry page is not planned as a second login page; a feature whose rules name a state reached by an action (cart) is planned on the page that starts the action.

### 6. The rentals scenario failed on a Planner assumption about the page, not on the site

Artifact: the finding at 15:33:58, "expected rentals product prices rendered to match at least 1 element(s), but the page stayed at https://practicesoftwaretesting.com/rentals", from the assert `toHaveCount` `[data-test='product-price']` `atLeast: 1` at 15:31; three rentals scenarios were then skipped as "Rentals page has no products in this environment". The `get_dom` result the model received on `/rentals` is kept only as a 200-character preview in `events.jsonl` (the trimming of invariant 47), which shows the title and the page heading, so whether it listed the three product names cannot be read from the artifact. Live check: `/rentals` renders three `div.card` cards named Excavator, Bulldozer and Crane with no price element; `/category/hand-tools` renders nine `a.card` cards each with a price, an ABCDE badge (the CO2 rating) and a pagination control. So "no products" was a model error built on a Planner assumption: the plan asked for "name, image, and price" on a listing whose cards carry no price (rental pricing is on the detail page), the price assertion failed, and the model read the failure as an empty page. Not a site defect, not a wrong URL. Fix: the Planner asserts what the snapshot shows (card count, a name, an image) and never a price the snapshot did not list; the get_dom preview in events.jsonl keeps the headings and the first links so a diagnosis can check the page shape.

### 7. testid hints are recorded as css because the site uses data-test

Artifact: in the five shipped scenarios (`report.scenarios[].steps[].target`) 13 targets are `level: 'css'` and all 13 are `[data-test="..."]` selectors; 0 are `level: 'testid'`. The model passed `testid: 'email'` and friends; the cascade's testid tier tries `getByTestId` (data-testid) first, misses, then `[data-test="..."]` as css. The emitted page objects therefore read `page.locator('[data-test="email"]')` rather than `getByTestId('email')`, and `cascadeStats` counts them as css. Fix: record the data-test hit at the testid level with the attribute name, and emit `getByTestId` under a `testIdAttribute: 'data-test'` in the generated Playwright config when the site uses that convention.

### 8. Explorer start-up waste

Artifact: the two `tool_call` events before the first `begin_scenario` (`navigate https://practicesoftwaretesting.com/`, `get_dom`) cost $0.1413 by the `usage` event that follows them, 3.5 percent of the explorer spend, before any planned scenario started; every scenario then navigates to its own page again. The plan already names each scenario's page. Fix: the Explorer starts at the first planned scenario's page and skips the orientation load of the entry page when the plan carries page URLs.

## Ranked fix list

1. Repair budget: ceiling minus spend, reserve as the floor, cheapest first (finding 1). Fixed in this PR; locked by `smoke-cost-ceiling`.
2. Critic rendering: count timeout, URL timeout recorded and rendered, generated fill marked (finding 2). `critic.ts`, `trace.ts`, `tools.ts`. Lock: `smoke-critic-parse`.
3. Skip in progress and the one-bucket rule (finding 3). Fixed in this PR; locked by `smoke-plan-enforcement` and `smoke-reconcile`.
4. Duplicate-email negatives keep their literal (finding 4). `tools.ts` `enforceFakeCredential`. Lock: `smoke-unique-data`.
5. Planning: recovery tokens off the registration feature, no second login page, cart planned from the action page (finding 5). `requirements.ts`, `page-filter.ts`, `planner.ts`. Lock: `smoke-page-filter`, `smoke-plan-rule-tags`.
6. Planner asserts the snapshot's shape, events keep a useful get_dom preview (finding 6). `planner.ts`, `src/server/events.ts`. Lock: `smoke-planner-parse`, `smoke-terminal`.
7. data-test recorded and emitted as a testid (finding 7). `selectors.ts`, `scaffold.ts`. Lock: `smoke-data-test-attribute`.
8. No orientation load when the plan carries page URLs (finding 8). `runtime.ts`. Lock: `smoke-step-budget`.
