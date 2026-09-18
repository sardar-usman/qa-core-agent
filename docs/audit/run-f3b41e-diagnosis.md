# Diagnosis of run f3b41e (practicesoftwaretesting.com, 2026-09-18)

Run directory: `output/practicesoftwaretesting-com/20260918T132313Z-f3b41e/`. Files read in full: `run-report.json`, `events.jsonl` (772 events), `discovery.json`, `rule-coverage.json`, `requirements-map.json`, `run-meta.json`. Before-run: `output/practicesoftwaretesting-com/20260915T174318Z-ec8eff/` and its diagnosis `docs/audit/run-ec8eff-diagnosis.md`. Nothing in either directory was modified. `run-meta.json` says the run came from the dashboard with `QA_CORE_COST_CEILING=6` and no other override.

How numbers were obtained: per-scenario cost is the difference between consecutive `usage` events, attributed to the scenario whose tool calls follow the event, the same method as the first diagnosis. Where a value is a live check against the site on 2026-09-18 it is marked live check. Where the files cannot answer, the section says so.

## 1. Before and after

| Measure | ec8eff (Sept 15) | f3b41e (Sept 18) | Field |
|---|---|---|---|
| Pages found by the crawl | 15 (not recorded; console line only) | 11 | `discovery.json` `candidates` |
| Pages kept for planning | 3 | 7 | `report.discovery.pages` |
| Planned | 10 | 18 | `reconciliation.planned` |
| Explored (recorded by the Explorer) | 6 | 15 | `done.scenarios` event; `reconciliation.generated` + dropped at critic, replay, stability |
| Critic pass / rework (first pass) | 1 / 5 of 6 | 2 / 12 of 14 verdicts (15 scenarios) | first `critic_done` event |
| Replay pass | 1 of 1 | 1 of 4 | `replay.passed` |
| Shipped | 0 | 1 | `reconciliation.generated` |
| Rules covered | 0 of 14 | 1 of 14 | `ruleCoverage.covered` |
| Total cost (four terms) | $6.0812 | $4.9671 | `cost.usd` + `plannerUsd` + `criticUsd` + `stability.stabilizerCostUsd` |
| Explorer cost (without repair) | $5.1483 | $3.9514 | `cost.usd` minus `cost.repairUsd` |
| Explorer cost per explored scenario | $0.8581 (6) | $0.2634 (15) | derived; the repair decision line prints the same figure |
| Repair pass | $0.8643, 0 re-recorded | $0.9090, 6 re-recorded, 1 kept | `cost.repairUsd`, `review.repair` |
| Cache share | 0.3873 | 0.9866 | `cost.cachedInputShare` (derived for ec8eff, which predates the field) |
| Steps | 84 (65 + 19) | 223 (174 + 49) | `report.steps`; tool_call events per phase |
| API calls | 64 | 184 | `cost.calls.length` (f3b41e); usage events (ec8eff) |
| Wall time | 8 min 28 s | 21 min 06 s | `startedAt` to `finishedAt` |

The first diagnosis quoted $6.0687 for ec8eff; that figure left out the $0.0122 stabilizer line. The four-term total the dashboard shows is $6.0812.

What changed: 2.5 times the exploration for 77 percent of the explorer spend, so exploration is 3.3 times cheaper per scenario. What did not change: the funnel still ends at 1 shipped. 14 of 15 recorded scenarios were dropped, 11 at the Critic and 3 at replay.

## 2. Rework reasons, classified

The first Critic pass (`critic_done` at 13:37:03, `usd` 0.053247) returned 14 verdicts for 15 recorded scenarios: 2 pass, 12 rework, and no verdict at all for "rejected submission when email lacked @ sign". `review.summary` is the empty string, which is the signature of a response cut at the Critic's 3000-token `max_tokens` before the summary: the 15th verdict was lost. That scenario went to replay unreviewed and failed there (section 4). The report's final list has 11 rework because the search happy path became pass on repair. The 12 first-pass rework verdicts, classified by the shapes asked for, with the doctrine rule number the Critic cited:

| # | Scenario | Shape(s) | Rule cited |
|---|---|---|---|
| 1 | submitted valid email and received confirmation message | other: asserts the success element is absent in a happy path | none |
| 2 | rejected malformed email address | vacuous ("URL did not change"); other: repeated steps | 3 |
| 3 | displayed hand-tool products with name, image, and price | literal catalogue value (count=9); other: "$" unit-only substring | 6, 2 |
| 4 | sorted products by Name (A - Z) and verified order changed | other: `changed` is not a directional relation; timeout missing | 2, 1 |
| 5 | filtered by eco_friendly checkbox and product list updated | literal catalogue value (count=9); `changed` on a name; timeout missing | 6, 1 |
| 6 | searched for a product name and results showed only matching items | literal catalogue value ("Pliers" on the first card) | 6, 1 |
| 7 | searched for a term with no matches and received empty results | escaped locator (`data-test=\"product-\"`); timeout above 15000 (60000) | none |
| 8 | searched for a single character ... | literal catalogue value (count=9); vacuous visibility | 6, 2 |
| 9 | selected a category and product list narrowed to that category | literal catalogue value ("Sander", count=8) | 6, 6 |
| 10 | applied the category filter, then toggled the eco_friendly checkbox ... | literal catalogue state ("no products found" as a fixture); timeout low | 1 |
| 11 | submitted form with valid first name ... | other: weak substring ("Thanks"); timeout low | 1 |
| 12 | rejected submission when message field was empty | vacuous visibility (submit button); brittle class string; timeout above 15000 (60000) | 2, 1 |

Count per shape (a verdict may carry more than one): literal catalogue value 6 (3, 5, 6, 8, 9, 10); vacuous visibility 3 (2, 8, 12); timeout above 15000 2 (7, 12); escaped or unnamed locator 1 (7; the second pass added an unnamed `getByRole("textbox")` on scenario 2); brittle class string 1 (12); other 5 (1, 2, 4, 11, and the "$" substring on 3). Timeout missing or low, which is not one of the asked shapes, appears on 6 verdicts (4, 5, 6, 10, 11, 12).

Two observations on the citations. The Critic writes "doctrine rule 2" for vacuous visibility and for the "$" substring (verdicts 3, 8, 12); doctrine rule 2 is the sort rule, and vacuous visibility is banned by ASSERTION RULES 7 in the Explorer prompt, which the Critic does not see. The three 60000 ms timeouts (verdicts 7, 12, and the price assertion in the repair of 3) each follow a failed 60 s probe in the same scenario: the "no results" text probe at 13:28:47 waited the full 60 s, the aria-invalid probe at 13:33:22 waited 60 s, and the "$" `toHaveText` probe at 13:38:05 waited 60 s. `observedSettleMs` now counts page time only, but a failed probe's 60 s is page time, so the next assertion in the scenario records 60 s times 1.5, capped at the 60000 ceiling. Fix 1 below.

## 3. Literal-value assertions and where the literal came from

`events.jsonl` keeps a 200-character preview of each `get_dom` result, so whether a literal appears verbatim in a get_dom result cannot be read from the files. What the files do show is the tool result that carried the value before the assertion (a capture result or an assertion failure message), and a live check of `get_dom` on the same pages today shows the DOM region each literal lives in.

| Literal assertion (phase, scenario) | Value seen in a tool result earlier in the scenario? | DOM region (live check) |
|---|---|---|
| toContainText "Pliers" on the cards (exploration, hand-tools, first attempt) | no result carried it; get_dom preceded it | product card: link label `Combination Pliers ABCDE$14.15` |
| toContainText "$" on a card (exploration, hand-tools, twice) | no | product card link label |
| toHaveCount 9 on `a[data-test^="product-"]` (exploration: hand-tools, eco filter, single character) | no | the number of product-card links in get_dom |
| toHaveText page-title "Category: Hand Tools" / "Category: Power Tools" | get_dom preview shows the h2 label | heading (`h2`, testid page-title); durable |
| toContainText "Pliers" on the first card and on the caption (exploration, search) | it is the typed search term | product card label; search caption |
| toContainText no-results "no products found" (exploration, no matches; category+eco) | yes: the failed probe returned `Received string: "There are no products found."` | alert-like message element; not a get_dom region |
| toContainText "Sander" on the first card; toHaveCount 8 (exploration, category) | yes: capture result `"Sheet Sander"` at 13:30:29 | product card label `Sheet Sander ABCDE$58.48` |
| toContainText "Thanks" (exploration, contact happy) | no; get_dom after submit listed no inputs | alert after submit; not a get_dom region |
| toHaveAttribute class "form-control ng-untouched ng-pristine ng-invalid is-invalid" (exploration, empty message) | the model wrote "Textarea shows class is-invalid" after a get_dom | form state of the textarea (get_dom inputs region) |
| toHaveAttribute class "form-control ng-invalid ng-dirty ng-touched is-invalid" (exploration, email without @) | no get_dom in that scenario after the click; source not in the files | form state of the input |
| toContainText "$14.15" (repair, hand-tools) | yes: the failed `toHaveText "$"` probe printed the received text | product card price span |
| toHaveText "Adjustable Wrench" (repair, sort) | yes: `assert_compare(less)` failure printed `now "Adjustable Wrench"` | product card name (h5) |

Decision on a deterministic gate: the literal itself is not needed. Every catalogue literal above was asserted on a target whose selector names a product card (`a[data-test^="product-"]`, `.card`, `product-price`, `product-name`, `.card-title`). A gate rule keyed on the target selector can reject a literal text or a non-zero literal count on such a target without seeing the DOM, and it leaves the durable ones alone: a heading (page-title), a message element (no-results, the alert), a field value, and count 0 for absence. That is deterministic from the trace alone. Fix 2.

## 4. Replay failures

Rate limiting: no event carries a 429, "too many", "captcha", or "rate" text (the only "429" in the file is inside a timestamp). Dropped scenarios do not carry their console and network errors on the report, so the login endpoint's responses during replay are not in the files.

| Scenario | Observed (PR #19 record) | Timeout used | Elapsed at the failing step: exploration / replay | Verdict |
|---|---|---|---|---|
| logged in with valid credentials | `observed.url` /auth/login; `observed.messages` ["Account locked, too many failed attempts. Please contact the administrator."]; `observed.target` null (toHaveURL has no target) | toHaveURL carries no timeout on the trace; replay polls its default 10000 ms | 16 ms (13:25:16.184 to .200) / scenario 15,555 ms | account state (lockout), not timing, not a brittle assertion |
| rejected login with a valid email format but wrong password | same URL and message; `observed.target` null | 5000 ms (the Critic's rendering of the recorded step) | 15 ms (13:25:32.850 to .865) / scenario 13,889 ms | account state (lockout) |
| rejected submission when email lacked @ sign | `observed.url` /contact; `observed.target` "" (the input's text); `observed.messages` ["Email format is invalid"] | 10000 requested; the recorded adaptive value is not in the files (the trace was dropped and never rendered) | 16 ms (13:35:53.088 to .104) / scenario 64,947 ms | brittle assertion: the validation fired (the message is there) but the exact Angular class string differed |

The lockout counter does not add up from this run alone: the happy login passed at 13:25:16 (so the account was not locked then), the run made exactly one wrong-password attempt (13:25:28), the repair pass made no login attempt, and replay at 13:42:30 found the account locked. The toolshop locks after 3 failed attempts (`MAX_LOGIN_ATTEMPTS = 3` in its public source, quoted in the first diagnosis). The other attempts came from outside this run; `customer@practicesoftwaretesting.com` is a shared public demo account. The files cannot say who made them. The credential steering shipped in PR #19 asks for a non-existent account on wrong-credential negatives, and the Explorer still used the real one (`fill` at 13:25:26 with the real email). Fix 7.

## 5. Repair pass

Decision line (`message` at 13:37:03): `repair pass: 12 scenario(s), budget $0.90 (the stated reserve); explorer cost this run $0.2634 per recorded scenario, so the reserve funds about 3 of 12`. `repair_started.budgetUsd` 0.8999999999999999. The pass re-recorded 6, not 3: a repair scenario is cheaper than the explorer average because the repair note already carries the steps.

| Re-explored scenario | Spend | Second verdict | Same shape as the first? |
|---|---|---|---|
| submitted valid email and received confirmation message | $0.1488 | rework | no: first "asserts the success element absent"; second "asserts the email textbox visible, vacuous" |
| rejected malformed email address | $0.0876 | rework | no: first repeated steps and a vacuous URL check; second an unnamed `getByRole("textbox")` locator |
| displayed hand-tool products with name, image, and price | $0.1710 | rework | yes: literal catalogue value both times (count=9 and "$", then "$14.15"), plus a 60000 timeout |
| sorted products by Name (A - Z) and verified order changed | $0.1570 | rework | yes: `changed` both times, plus the literal "Adjustable Wrench" |
| filtered by eco_friendly checkbox and product list updated | $0.1646 | rework | no: first literal count and `changed`; second a vacuous pre-condition and the `less` relation without a poll |
| searched for a product name and results showed only matching items | $0.1800 | pass | kept |

Total $0.9090 (`cost.repairUsd`); the ceiling message at 13:42:02 reads `Cost ceiling reached ($0.909 > $0.8999999999999999)`. Six scenarios were never re-explored (`repair_scenario` events, reason "never re-explored: the repair budget ran out first"). Two things the events show about the repair itself: `assert_compare(greater)` and `assert_compare(less)` on product names both failed at 13:40:44 and 13:40:55 because the relations are numeric only (`captured "Combination Pliers", now "Adjustable Wrench"`), so the directional compare the doctrine demands for a name sort cannot be recorded; and `assert_compare(greater)` on a count against itself failed twice (13:37:53, 13:41:48), the model reaching for "count > 0" through a compare of a value with itself. Fix 9.

## 6. Discovery

`discovery.json` `candidates` (11, all `browser-crawl`): `/`, `/category/hand-tools`, `/category/power-tools`, `/category/other`, `/category/special-tools`, `/rentals`, `/contact`, `/auth/login`, `/privacy`, `/auth/register`, `/auth/forgot-password`. `pages` kept 7. Dropped 4: `/category/other`, `/category/special-tools`, `/rentals`, `/privacy`. The filter's reason is not recorded: the console line says `11 page(s) narrowed to 7 (relevance pick)`, and the Haiku pick returns URLs with no reasons. The kept set shows two mechanisms: `/auth/login`, `/auth/register` and `/auth/forgot-password` all carry `feature: "login"`, which is `plainFeatureMatches` in page-filter.ts matching the `auth` token listed under `login` in `FEATURE_PATH_TOKENS` (PR #20); the other four carry names Haiku invented (`product-listing`, `product-search`, `category-filter`, `contact-form`).

No product detail URL and no cart URL is among the 11 candidates. The files do not contain the DOM the crawl read. What they do show: the Explorer's own `capture` on the hand-tools page at 13:27:42 returned `"Combination Pliers"` from `a[data-test^="product-"]`, so the product anchors were present about a second after navigation. Live check today: the product anchors carry `href="/product/<ulid>"`, they render after the nav anchors, and the nav has no cart or checkout link (the cart link appears once an item is added). `waitForAnchors` returns as soon as the anchor count has held for two polls (400 ms) with at least one anchor; the nav's anchors satisfy that before the product list arrives, so the crawl read the links too early. Fix 6.

## 7. The Explore rail stat "1 recorded"

`run-detail.ts` builds the stat from `shipped = report.scenarios` (line 375) as `${shipped.length} recorded` (line 398) and copies the same number to `scenarios_recorded`. `report.scenarios` is the emitted list, so the stat reads the shipped count under the word "recorded". The Explorer recorded 15 (`done.scenarios` 15 in the events; `finish` returned `"scenarios":15`). On the report that number is `reconciliation.generated` (1) plus the `reconciliation.dropped` entries whose stage is critic (11), replay (3) or stability (0), which is 15. The stat should read that sum as "recorded" and show `report.scenarios.length` as "shipped". Fix 8.

## 8. The two skipped scenarios

`reconciliation.skipped` holds "logged in with valid email and password" and "rejected wrong password and stayed on login page", both planned for `/auth/register`, both skipped by the Explorer at 13:25:41 with the reason that the page is the registration form and has no login flow. What the Planner received for that page, per the runtime's per-page call: `features: ["login"]` because discovery tagged `/auth/register` as `login` (section 6), which appends the steering block "The user has asked for scenarios covering THESE features ONLY: login ... If a requested feature is not visible on this homepage snapshot ... STILL propose scenarios for it"; and `requirements: subMapFor(map, "login")`, the map narrowed to the one rule R10 ("Login with a wrong password shows an error"). Shown a registration form, told to plan login only, told to plan it even if not visible, and given only the wrong-password rule, the Planner produced two login scenarios. The same tagging gave `/auth/forgot-password` three login scenarios, one of them a second "rejected wrong password and stayed on login page" with the same name as the register one; `skip_scenario` refused the duplicate ("is already skipped", 13:25:52), it was never explored, and `reconciliation.balanced` is false with the note "1 planned scenario(s) vanished". The map's own feature for that page, `user-registration` (R11, R12), never reached any page: `tokensFor("user-registration")` has no entry and `register` is not a substring match of it, so `/auth/register` was claimed by `login` first. Fix 4 and fix 5.

## Ranked fix list

1. **Failed probes inflate the recorded timeout.** Finding: section 2, three 60000 ms timeouts each follow a failed 60 s probe. File: `src/agent/tools.ts` (`runTool` should not add a failed assertion's duration to `_pageMsSinceAction`, or the next passing probe should record its own settle only). Effect: removes the "excessive timeout" reason from 3 of 12 first-pass reworks and from 1 of 5 second-pass ones. Lock: `smoke-compare-poll` (a failed 2 s probe followed by a passing one records under 2 s).
2. **Catalogue-literal gate keyed on the target.** Finding: section 3, all 6 literal-value reworks assert a literal text or a non-zero literal count on a product-card selector. File: `src/agent/gate.ts` (RULE 7: literal text or non-zero count on a target matching `[data-test^="product-"]`, `.card`, `product-price`, `product-name` is rejected with a steer to capture-then-compare or a format check; count 0, headings and message elements stay allowed). Effect: 6 of 12 reworks become in-run restarts, roughly $0.15 each instead of a $0.15 to $0.18 repair that failed again. Lock: `smoke-gate`.
3. **A scenario with no Critic verdict is not reviewed, so it does not pass.** Finding: section 2, 14 verdicts for 15 scenarios, `review.summary` empty, the 15th scenario replayed unreviewed and failed. File: `src/agent/critic.ts` (`max_tokens` sized to the scenario count, or review in batches) and `gateByVerdicts` (a scenario with no verdict is held as rework, with a loud warning naming it). Effect: no unreviewed scenario reaches replay; one fewer replay failure here. Lock: `smoke-critic-parse`.
4. **`auth` is not `login`, and `user-registration` must match `/auth/register`.** Finding: sections 6 and 8. File: `src/agent/page-filter.ts` (`FEATURE_PATH_TOKENS`: drop `auth` from login; add `registration` tokens under `user-registration`, `signup`, `register`; match the map's feature name by its words, not only by the whole string). Effect: the register page plans registration scenarios (R11, R12 are not-planned today), the forgot-password page stops receiving login-only steering, 5 of 18 planned scenarios stop being unplannable. Lock: `smoke-page-filter`.
5. **Plan names unique across pages.** Finding: section 8, a duplicate name broke `skip_scenario` and unbalanced the funnel. File: `src/agent/runtime.ts` (qualify a duplicate planned name with its page, or key `skip_scenario` and plan enforcement by name plus page). Effect: the funnel balances; no scenario vanishes. Lock: `smoke-plan-enforcement`.
6. **`waitForAnchors` returns on the shell's nav.** Finding: section 6, no product URL among the candidates while the Explorer saw the cards a second later. File: `src/agent/discovery.ts` (require the count to grow past the first reading before accepting steady, or a minimum wait of about 1.5 s before the steady test). Effect: product detail pages enter the candidate set, so R5 becomes plannable. Lock: `smoke-discovery-ladder` (anchors rendering in two waves).
7. **Wrong-credential negatives still use the real account.** Finding: section 4, the prompt steering did not change the Explorer's fill. File: `src/agent/planner.ts` (the scenario name states "with a non-existent account") and `src/agent/tools.ts` (in a negative login scenario, a fill of the email field with the happy scenario's credential is refused with a steer to `uniqueEmail()`). Effect: the two login scenarios survive replay regardless of who else locks the demo account. Lock: `smoke-plan-rule-tags`, `smoke-unique-data`.
8. **"recorded" reads the shipped count.** Finding: section 7. File: `src/server/run-detail.ts`. Effect: the rail says 15 recorded, 1 shipped. Lock: `smoke-run-detail`.
9. **String relations for assert_compare.** Finding: section 5, `greater` and `less` are numeric only, so a name sort cannot record the directional compare doctrine rule 2 demands. File: `src/agent/tools.ts`, `src/agent/replay.ts`, both emitters (compare strings with `localeCompare` when either side is not numeric). Effect: the sort scenario can satisfy the Critic without a literal. Lock: `smoke-capture-compare`.
10. **The Critic's rule numbers.** Finding: section 2, "doctrine rule 2" cited for vacuous visibility. File: `src/agent/doctrine.ts` (fold the falsifiability ban from ASSERTION RULES 7 into the shared block as its own numbered rule so both sides cite one numbering). Effect: repair notes name the right rule. Lock: `smoke-critic-parse`.
