# Diagnosis of run ec8eff (practicesoftwaretesting.com, 2026-09-15)

Run directory: `output/practicesoftwaretesting-com/20260915T174318Z-ec8eff/`. Files read in full: `run-report.json`, `events.jsonl` (321 events), `checkpoint.json`, `rule-coverage.json`, `requirements-map.json`. Comparison run: `output/saucedemo-com/20260914T173105Z-1050ef/`. Nothing in either directory was modified.

Outcome in one line: 10 planned, 6 recorded, 1 passed the Critic, 1 passed replay, 0 survived stability, 0 shipped, $6.0687 spent (`cost.usd` 6.01262175 + `cost.plannerUsd` 0.013972 + `cost.criticUsd` 0.042387 + `stability.stabilizerCostUsd` 0.012228). `reconciliation.balanced` is true: 10 = 0 generated + 6 dropped + 4 incomplete.

How numbers below were obtained. Each `usage` event carries the cumulative explorer USD and the cumulative `inputTokens + outputTokens` (runtime.ts line 1714). Per-call and per-scenario figures are differences between consecutive `usage` events, attributed to the scenario whose tool calls follow the event. The files do not record per-scenario input versus output tokens, per-scenario cache reads, or the byte size of any tool result (`events.ts` trims results to a 200-character preview; the checkpoint stores steps only). Where a value is derived by arithmetic from recorded numbers it is marked derived. Where I ran a live read-only check against the site on 2026-09-17 it is marked live check and is not evidence of what the page looked like on 2026-09-15.

## 1. Cost per scenario

Explorer phase (from the first `usage` after `plan_done` to `critic_started`): 49 API calls, 65 tool calls, 936,175 input+output tokens, $5.14834425 (`checkpoint.spentUsd.explorer`).

| Scenario | API calls | Tool calls | Tool mix | in+out tokens | USD |
|---|---|---|---|---|---|
| 1. listed products in hand-tools | 5 | 8 | begin, navigate, get_dom, assert x4, end | 18,096 | 0.1973 |
| 2. sorted products by price | 7 | 10 | begin, navigate, capture x2, select_option, wait_for_text (failed), assert_compare, assert x2, end | 53,416 | 0.3292 |
| 3. non-matching search | 10 | 12 | begin, navigate x2, get_dom x2, fill x3 (2 failed), click, assert x2, end | 139,153 | 0.7730 |
| 4. category filter toggle | 8 | 10 | begin, navigate, capture, set_checked x2, assert_compare (failed), get_dom, assert x2, end | 181,570 | 0.9753 |
| 5. happy login | 6 | 8 | begin, navigate, fill x2, click, assert x2, end | 163,985 | 0.8682 |
| 6. wrong password | 6 | 8 | begin, navigate, fill x2, click, assert x2, end | 170,617 | 0.9015 |
| 7. empty password (in progress) | 7 | 9 | begin, navigate, fill, click x2, get_dom, assert x3 | 209,338 | 1.1038 |
| Total | 49 | 65 | | 936,175 | 5.1483 |

Scenario 7 is the in-progress one. All three of its assertions passed (`tool_result` ok at 17:47:03.377, 17:47:03.396, 17:47:05.793). It was one `end_scenario` call from completion when the ceiling check at the top of the next turn stopped the loop ("Cost ceiling reached ($5.148 > $5.1)"). It is recorded in `incomplete` as "cost ceiling hit mid-scenario; in-progress work discarded". The $1.10 it cost is the largest single-scenario spend in the run.

Cache tokens (derived). `cost.cacheCreationTokens` is 10,877 and `cost.cacheReadTokens` is 685,251, which is exactly 63 x 10,877. The run made 64 API calls (49 explorer + 15 repair). So the cached prefix (system prompt plus tool definitions) was written once and read on every later call. Per scenario, cache reads are API calls x 10,877 (scenario 1: 4 reads and the one write). Nothing else was ever cached: the plan block, the repair note and the whole conversation history were sent as plain input on every call.

Input versus output. `cost.inputTokens` 1,073,328 and `cost.outputTokens` 9,415 cover explorer plus repair together; the per-scenario split is not recorded. At the PRICE table in runtime.ts (Opus 4.7: $5 in, $25 out, $0.50 cache read, $6.25 cache write per million) the report's `cost.usd` reproduces exactly: (1,073,328 x 5 + 9,415 x 25 + 685,251 x 0.5 + 10,877 x 6.25) / 1e6 = 6.01262175. Plain input is $5.37 of the $6.01.

Which tool calls dominate. The per-call input grows every turn because the history is re-sent uncached; the sequence of per-call in+out tokens over the 49 explorer calls is 1,509 at the first call and 31,273 at the last. Five rounds contained a `get_dom`, and the per-call figure jumped by 4,785, 4,407, 5,553, 5,614 and 1,399 tokens on the call that first carried each result (calls 4, 16, 20, 28, 48). Every other round added between 84 (navigate) and 273 (two fills) tokens. Derived: the five get_dom results make up 21,758 of the final 31,273 tokens per call (69.6%), and because each result is re-sent on every later call, get_dom content accounts for 662,844 of the 936,175 explorer tokens (70.8%). The 26 calls that carried 20,000 or more tokens cost $3.7405 of the $5.1483. There is no screenshot tool in `TOOL_DEFS`, so none was called. Fills and asserts are cheap per call; their cost is the history they drag along.

Largest get_dom result per page. Not recorded in the files. Live check (running `runTool(ctx, {name: 'get_dom'})` from tools.ts on 2026-09-17, sizes in characters of the JSON the model receives, tokens not measurable because api.anthropic.com is unreachable from this sandbox):

| Page | At settle (as the crawler and planner read it) | 2.5 s after the async product and filter lists rendered |
|---|---|---|
| / (home) | 3,133 (17 links, 3 inputs) | 8,516 (26 links, 24 inputs) |
| /category/hand-tools | 2,963 | 6,534 |
| /auth/login | 2,527 | 2,527 |
| /contact | 2,992 | 2,992 |
| saucedemo.com login page | 560 | 560 |

The run's get_dom calls came 1.5 s or more after navigate, so they saw the rendered lists; 24 inputs on the home page is also where the planner's "24 fillable field(s)" came from. The saucedemo run for comparison: 0 get_dom calls in its `events.jsonl`, 28 tool calls, per-call input rising only from 1,028 to 4,777 tokens, $0.6033 for four shipped scenarios.

## 2. The repair pass

Reserve: "Cost ceiling: $6.00 total, explorer $5.10, repair reserve $0.90" (first `message` event). Budget actually offered: "repair pass: 5 scenario(s), budget $0.81" (`decideRepairPass` in critic.ts subtracts all spend from the total ceiling: 6.00 minus 5.14834425 explorer, 0.013972 planner and 0.028866 first Critic call = 0.80881775, which is the "$0.8088177500000002" in the ceiling message). Spent: `cost.repairUsd` 0.8642775, 15 API calls, 19 tool calls, 146,568 in+out tokens. Step budget for the pass: `stepBudgetFor(5, 0)` = 76, so the step cap was nowhere near.

The checkpoint carries no repair entries (`completedScenarios` holds the six original traces, `phase` is "reviewing", `spentUsd.repair` is 0.8642775). Everything below is from `events.jsonl` after the "repair pass:" line and `review.repair` on the report.

| Scenario | API calls | Tool calls | in+out tokens | USD | How it ended |
|---|---|---|---|---|---|
| orientation (no scenario) | 2 | 2 (navigate, get_dom) | 7,341 | 0.0507 | n/a |
| 1. listed products | 7 | 10 (begin, navigate, capture, assert_compare failed, assert x5, end) | 70,153 | 0.4160 | completed; second Critic verdict rework (`review.repair[0]`: first rework, second rework, dropped) |
| 2. sorted products | 6 | 7 (begin, navigate, capture, select_option, assert_compare ok, capture x2) | 69,074 | 0.3976 | cost ceiling: "was mid-repair when the cost ceiling hit; the in-progress work is discarded" |
| 3. search | 0 | 0 | 0 | 0 | never started: "rework -> not re-recorded (dropped)" |
| 4. filter | 0 | 0 | 0 | 0 | never started |
| 5. happy login | 0 | 0 | 0 | 0 | never started |

None ended on the step cap, a model give-up or an error; the cause for 2 to 5 is the budget. The repair pass's first call already cost 3,632 tokens (the repair note restates the recorded steps and Critic reasons, uncached), and its per-call cost rose from $0.0259 to $0.0722 over 15 calls, because the repair history is uncached exactly like the explorer's.

Would any have completed at any reserve size? Scenario 1 did complete inside this reserve and still drew rework; a bigger reserve would not have changed that verdict. The files show one completed repair at $0.4160 and an unfinished one at $0.3976 for 7 calls. Five repairs at no less than the cheapest completed one is $2.08, above both the $0.90 reserve and the $0.81 offered, before counting that later scenarios cost more than earlier ones. What scenarios 3 to 5 would have cost is not in the files. The reserve as a fraction cannot be sized from this run; the per-scenario repair cost is set by the uncached history, which is what fix 1 below removes.

## 3. Critic verdicts

Recorded assertions come from `checkpoint.completedScenarios`; the model's tool inputs come from `tool_call` events. "Doctrine" means the ASSERTION DOCTRINE block in the runtime.ts SYSTEM prompt (rules 1 to 7); "Rules" means the older ASSERTION RULES block (1 to 9) in the same prompt.

**Scenario 1, listed products (first verdict, `critic_done` at 17:47:38; final verdict on the report is the repair verdict).** Recorded: toHaveCount 9 on `a[data-test^="product-"]`, toContainText "Combination Pliers", toContainText "$14.15", toHaveCount 9 on the images. The model passed `timeout: 15000` on all four; the two toHaveCount steps were recorded with no timeout and the gate floored them to 5000 (`gate.injections`), because the toHaveCount handler in tools.ts passes `assertTimeout` to expect but never writes it on the step; the two text assertions were recorded with the adaptive value (13,436 and 13,457 ms), not the model's 15,000. First verdict: duplicate count, count 9 is brittle, no image visibility, price pinned. No doctrine rule bans an exact count or an exact price; doctrine 6 says "Prefer text content, counts". This rework is the Critic's own reseed judgement, not a doctrine breach. Final verdict (on the repaired trace, which is not in the files): three bare toBeVisible on the first card (Rules 7, falsifiability; Critic flagging rule 2), toContainText "$" (Rules 4 forbids a bare unit substring; flagging rule 2), "Pliers" pinned, no count, timeouts up to 30 s. The repaired timeouts are adaptive values the model did not choose.

**Scenario 2, sort by price.** Recorded: capture text of the first h5 (css, ambiguous), select_option price,asc, assert_compare changed, toHaveText "$4.92" (timeout 40,346), toHaveText "Phillips Screwdriver" (40,371); the gate stripped the unused `cap_firstPrice`. Doctrine 2 says exactly "The first item changed proves a shuffle, not an order", so the assert_compare is the banned shape. Doctrine 2 then allows "or assert the known expected first item", which is what the two toHaveText steps do, and the Critic rejected those as volatile catalogue values. The doctrine's permitted alternative is what the Critic rejects. The 40 s timeouts: `observedSettleMs` (tools.ts line 1615) measures from `ctx.lastActionAt`, the select_option at 17:44:30.70; the assert ran at 17:44:57.6 after a 15 s failed wait_for_text and model latency, 26.9 s x 1.5 = 40.3 s. The adaptive timeout measured the model's thinking time, not the page.

**Scenario 3, non-matching search.** Recorded: navigate x2, fill, click, toHaveCount 0 (timeout 5,343), toBeVisible on `[data-test="no-results"]` (5,393). Doctrine 3 is satisfied (a user-visible no-results element). Critic: "the locator and what element is expected to be visible are unspecified". `describeStep` in critic.ts renders `assert ${intent} visible` and the intent defaulted to "element" (tools.ts: `intent: input.intent ?? 'element'`), so the Critic saw "assert element visible [timeout:5393ms]" and never the selector. A rendering gap, not a doctrine breach. The double navigate is real: two fills failed on the category page ("Could not resolve element: search input"), costing two calls, before the model navigated home.

**Scenario 4, category filter.** Recorded: set_checked on `[data-test="category-01M2K06AWQJ6XZEYHJEKD7E8JV"]`, toHaveCount 3 on `[aria-label^="Page-"]`, set_checked off, toHaveCount 5; capture `cap_totalCount` stripped because its assert_compare(less) failed (per-page count stayed 9). Doctrine 6 is breached outright: the selector is a generated catalogue id. The gate did not catch it (`isStableCssSelector` accepts any `[data-*` selector) and the Critic could not (it saw the intent "first category checkbox filter", which it called ambiguous). Doctrine 5: both toHaveCount timeouts lost (same handler gap as scenario 1). Critic: hard-coded 3 and 5.

**Scenario 5, happy login.** Recorded: fill x2, click, toHaveURL "/account", toBeVisible on `[data-test="nav-menu"]` (6,179). Critic: "no locator context is provided", the same `describeStep` gap as scenario 3. The "/account" prefix concern is the Critic's own; no doctrine rule covers it.

**Scenario 6, wrong password: pass.** toBeVisible on `[data-test="login-error"]` then toContainText "Invalid email or password".

Doctrine rules stated in the prompt but not enforced by gate.ts: rule 2 (a comparable relation for a sort), rule 3 (a user-visible failure signal on a negative), rule 6 (no generated catalogue ids in selectors), rule 7 (no direct navigation to a generated-id URL). Rules 1 and 5 are enforced only as the 5,000 ms floor of RULE 2 (the doctrine asks for 10,000 to 15,000). Rule 4 is enforced (RULE 5 strips unused captures). Two of the five reworks (3 and 5) were caused by the Critic not seeing selectors, and the Critic's flagging rule 5 (volatile ids) cannot fire for the same reason.

## 4. Stability

Replay passed in 3,003 ms. Stability pattern P-F-F: `stability.verdicts[0].firstFailure` is iteration 2, `failedStep` 5, `stepKind` assert, error `toContainText: expected text containing "Invalid email or password"`. Iteration 3 failed with the identical message (`stability_iteration_failed` at 17:49:20). `failedStep` is the 0-based step index (replay.ts line 149), so step 5 is the toContainText; step 4, toBeVisible on `[data-test="login-error"]`, passed on every failing iteration. The error element rendered, with text that did not contain the expected string. The replay message is built from the expectation only (replay.ts line 386) and never records the text actually seen, so the files cannot name it.

What the site does (read from the toolshop's public source, sprint5 `UserController.php`, not from the run files): `MAX_LOGIN_ATTEMPTS = 3`, after which login answers HTTP 423 with "Account locked, too many failed attempts. Please contact the administrator." Wrong-password attempts against `customer@practicesoftwaretesting.com` in this run: exploration (17:46:42), replay (17:48:50), stability iteration 1 (17:48:53 to 17:48:56), all returning the invalid-password text; iteration 2 at 17:49:08 was the fourth attempt. Every one of the 8 later attempts failed the same way, including with a 25 s timeout. That rules out a timing race (8 of 8 with 25 s), a selector (step 4 found the element), and shows no rate-limit evidence (no HTTP status is recorded for stability runs). It is an assertion that depends on server-side state: the account's lockout counter. Consequence for the pipeline: a wrong-password test against a real account with a lockout threshold of 3 can never pass 1 replay plus 3 stability iterations, whatever its assertions look like.

Stabilizer ($0.012228 = 0.0037 + 0.0040 + 0.0045 from the three "attempt N" message lines): attempt 1 proposed timeout_raise to 10,000 ms, re-ran F-F-F; attempt 2 timeout_raise to 25,000 ms, F-F-F; attempt 3 returned kind "broken" with the guess "the error message ... never appears, likely the app shows a different error text", which was right. Where it is recorded: only as `message` text lines in `events.jsonl` (runtime.ts lines 1339 to 1370 convert every `stabilize_*` event to text). The report's verdict has no attempt count, no strategies and no `gaveUp`: stability.ts sets `gaveUp` only when the classification was not already "broken", and the "broken" proposal sets `classification = 'broken'` directly, so the flag stays unset. The dashboard's StageView computes "stabilizer attempts" from `recovered + gave_up`, both 0 here, hence "none recorded" for a scenario the stabilizer worked on three times.

## 5. Steps

`steps: 84` on the report is `ctx.steps` from the explorer (65 tool calls) plus `repair.steps` (19) (runtime.ts line 1183). `ctx.steps` is incremented on every `runTool` call including rejected ones (tools.ts line 1006).

`QA_CORE_MAX_STEPS`: read once in `explore()` as `maxStepsOverride` (env or `opts.maxSteps`). When set it replaces the adaptive formula as `ctx.maxSteps`, enforced in `runTool` (`ctx.steps > ctx.maxSteps` rejects every call except finish and the closeout grace) and as the turn cap `maxTurns = maxSteps + 8` in `runAgentLoop`. It was not set for this run: the line "Step budget: 326 (10 scenario(s), 24 fillable field(s) on the page)" is printed only when there is no override. The repair pass ignores the override in any case (`stepBudgetFor(args.rework.length, 0)` = 76).

Formula: `stepBudgetFor(10, 24)` = max(40, 6 + max(14, 8 + 24) x 10) = 326. The `6 + 14n` in CLAUDE.md gives 146 and applies only while fillable fields stay at 6 or fewer; here the field term (32 per scenario) won.

Which governed: neither. The explorer used 65 of 326 and the repair 19 of 76; the cost ceiling stopped both. The Settings page lists "Max explorer steps / QA_CORE_MAX_STEPS" with the placeholder "default 40" (`RUN_ENV_SETTINGS.defaultValue` in explore-request.ts, echoed by `GET /api/settings`), and the CLAUDE.md env table says "Hard ceiling on Explorer tool calls per run, default 40". 40 is only `STEP_BUDGET_FLOOR`; the effective default is the adaptive budget, 326 for this plan. The page describes the override and misstates its default; it does not describe the budget that would govern, nor that the cost ceiling is what actually stops runs of this size.

## 6. Planner rule citations

From `report.plan[].ruleIds` against `requirements-map.json`:

| Scenario | Cited | Rule text | Fit |
|---|---|---|---|
| logged in with valid email and password (happy) | R10 | wrong password shows an error, user stays on login | does not fit: a happy login cannot go red if R10 breaks |
| attempted login with empty password field (edge) | R10 | as above | does not fit: R10 says nothing about an empty password |
| submitted contact form with valid ... (happy) | R13, R14 | form rejects empty message; rejects email without @ | does not fit: both are rejection rules |
| listed products in hand-tools (happy) | R1 | the home page lists products ... | partial: runs on /category/hand-tools, not the home page |
| sort, search, filter, empty message, bad email | R4, R2, R3, R13, R14 | | fit |

What the planner receives that lets it mis-cite:

- Per page, `subMapFor(map, pg.feature)` (runtime.ts line 404) narrows the map to the one feature the page filter tagged. The login page's planner call saw only feature `login` with R10; the contact page saw R13 and R14. The SRS "Account" section was split by the requirements builder into `login` (R10) and `registration` (R11, R12), so R11 and R12 never reached any page.
- `RULE_PLANNING` (planner.ts line 147) then demands "at least one happy, one negative, and one edge scenario for every feature whose rules support them" and "cite EVERY rule the scenario actually verifies", with `[-]` reserved for a scenario matching no rule. With one rule available and three categories demanded, Haiku attached the one rule to all three login scenarios. The derivation checklist's item 1, "one valid representative, one invalid representative" per constrained input, invites a happy path to be derived from a validation rule and cite it.
- Nothing after `parsePlan` checks a citation: no rule that a happy scenario cannot cite a rule typed `validation` whose text begins "rejects", and no check that the same single rule is not cited by every category of its feature.
- `rule-coverage.ts` marks a rule covered when any surviving scenario cites it. Had the happy login shipped, R10 would have been reported covered by a test that never sends a wrong password. In this run R10 is planned-but-dropped only because the real R10 scenario died at stability.

Also visible in `ruleCoverage.derivation`: catalogue planned 4 scenarios citing 4 of 5 rules (R5, the product detail page, fell outside the per-page cap of 4); cart 0 of 4 and registration 0 of 2 because no page carried those features (section 7).

## 7. Discovery

The crawl did not stop at 3 pages. Events: the fetch crawl found nothing ("crawl: found no additional same-origin pages beyond the entry"), then "discovery: 15 page(s) narrowed to 3 (relevance pick)" and "3 page(s) via browser-crawl". 15 equals `CRAWL_PAGE_CAP`, so the browser crawl ran to the page cap (depth cap 2 also applied). Robots did not restrict it: `/robots.txt` on this site returns the SPA's HTML with HTTP 200 (live check), which `parseRobotsTxt` reads as a file with no Disallow lines. The narrowing to 3 was `filterPages` (page-filter.ts): with the map's five features (catalogue, cart, login, registration, contact) the cap was 8 and the Haiku pick returned 3, one page each for catalogue, login and contact. Which 15 pages the crawl found is not recorded anywhere: `discovery.pages` holds only the 3 chosen, and the candidate list is not written to the report, the checkpoint or the events.

Live check, replaying the browser crawl's rules on 2026-09-17 (entry `/`, depth 2, cap 15, same origin, links read from the rendered DOM right after `settleForSnapshot`): 11 pages, all stable-path: `/`, four `/category/...`, `/rentals`, `/contact`, `/auth/login`, `/privacy`, `/auth/register`, `/auth/forgot-password`, frontier exhausted. Why the run found 15 and this replica 11 cannot be determined from the files.

Reachability of the missing rules from the pages it did find:

- Product detail pages (R5): the product cards are `<a href="/product/<ULID>">` anchors, but they render after the settle poll returns (live check: 0 product anchors at settle, 9 after `waitForSelector`). The crawler's collector reads links at settle, so it never sees them; the explorer's get_dom 1.5 s after navigate did. Their paths are volatile (26-character ULID segments match `LONG_ID_SEGMENT_RE`), so even when seen at most one survives `capVolatile`.
- Cart (R6 to R9): no page's navigation carries a cart or checkout link (live check on all four pages: 0 such links). The cart link appears only after an item is added, a state change the crawler does not make. So R6 to R9 were unreachable by link discovery on this site, the `cart` feature had no page, and the planner never saw those rules (derivation: cart 0 scenarios, 0 of 4 cited).
- Registration (R11, R12): `/auth/register` is linked from `/auth/login` (depth 2) and was in today's replica set; whether it was among the run's 15 and why the pick skipped it is not recorded.

## 8. Stop path (run-meta.json and the SRS copy)

Present on saucedemo 1050ef: `run-meta.json` (source "dashboard") and `saucedemo-srs.md`. Absent here. This run went through the gateway's `runExploreRequest`: `checkpoint.flags.srs` is `output/practicesoftwaretesting-com/20260915T174318Z-ec8eff/toolshop-srs.md`, the run-folder path `saveSrsUpload` produces, and the project-level SRS at `output/practicesoftwaretesting-com/srs/toolshop-srs.md` (`srs.json`: uploaded 2026-09-15T17:39:41Z, four minutes before the run) is the document it copied from.

Cause, from `git show 1e60d9e^` (the parent of the fix):

- `src/agent/framework-dir.ts`: `slimFrameworkDir(dir)` removed the whole run directory and rewrote only `SLIM_KEEP` = run-report.json, requirements-map.json, rule-coverage.json, checkpoint.json, run-meta.json, events.jsonl. An SRS `.md` is not in the list.
- `src/cli/explore.ts` (pre-fix): `writeRunMeta` was called only at the two success ends (lines 443 and 457); the empty-run branch (line 363) called `slimFrameworkDir(outDir)` and returned. So on an empty run the SRS copy was deleted and run-meta was never written.
- `src/server/run-explore.ts` (pre-fix): the same shape; `writeRunMeta` at lines 346 and 365 after the zip, `slimFrameworkDir` at line 304 in the empty-run branch. The success path held the uploaded SRS aside and restored it (lines 333 to 343); the empty-run path did not.
- This run was an empty run (0 emitted, `diagnoseEmptyRun` cause replay-dropped-all because stability dropped the last survivor), so the empty-run branch ran. The files left behind are exactly `SLIM_KEEP` minus run-meta, which matches.

Fix in commit 1e60d9e (PR #17, merged 2026-09-16): both `src/cli/explore.ts` and `src/server/run-explore.ts` write run-meta the moment the run directory is known and again at every end including the empty-run branch; the `slimFrameworkDir` import is removed from both (only the definition remains in framework-dir.ts); emission scaffolds into a temporary directory and writes only the zip into the run directory atomically; `RUN_ARTIFACTS` in zip-framework.ts excludes run files at zip time. The CLI's `--srs` reads the user's own file (`loadSrsText(args.srs)`) and never copied it into the run directory, so the SRS loss was gateway-only; the run-meta loss was on both paths, and the fix covers both. Locked in the same commit by additions to `smoke-checkpoint`, `smoke-index`, `smoke-repair-pass` and `smoke-terminal`.

## Ranked fix list

Effects are stated against this run's recorded numbers. Where an effect is a projection it says so.

1. **Cache the conversation history.** Finding: section 1. Only the system prompt and tools are cached (`cache_control` on the two system blocks, runtime.ts lines 1633 to 1636); the plan block, the repair note and every message are re-sent as plain input on all 64 calls, 1,073,328 tokens, $5.37 of $6.01. File: `src/agent/runtime.ts`, `runAgentLoop` (add `cache_control: {type: 'ephemeral'}` to the last content block of the last message before each call, and to the plan block). Effect, projection from the recorded counts at the PRICE table: the same tokens read from cache cost $0.54 instead of $5.37, plus one write per new chunk (about 43,000 tokens across both phases, $0.27), so the explorer that stopped after 6 scenarios would have had budget for all 10 and the repair pass. Lock: `smoke-prompt-cache`, a fake client asserting that every request after the first marks the latest message block for caching and that the plan block is cached.

2. **Show the Critic the selector.** Finding: section 3, scenarios 3 and 5 reworked for "no locator context" on assertions with recorded `[data-test=...]` selectors; flagging rule 5 cannot see the generated id in scenario 4. File: `src/agent/critic.ts`, `describeStep` (render `via ${level} ${arg}` and the frame chain for every targeted assertion, capture and compare). Effect: 2 of the 5 reworks here were caused by this alone; each rework costs at least a $0.40 repair. Lock: extend `smoke-critic-parse` with a fixture whose intent is "element" and whose selector is a data-test attribute; the rendered line must contain the selector.

3. **Closeout grace for the cost ceiling.** Finding: section 1, scenario 7 had all three assertions passed and needed one `end_scenario` when the ceiling discarded $1.10 of work. File: `src/agent/runtime.ts`, `runAgentLoop` and `salvageOnCostCeiling`: on ceiling with a scenario in progress that already holds an assertion, run the gate on it and keep it (the same rule `finish()` applies to an abandoned scenario in tools.ts), or allow one closing turn. Effect: one more scenario reaches the Critic for the cost of at most one call ($0.16 here). Lock: extend `smoke-cost-ceiling` with an in-progress scenario that has a passed assertion.

4. **Record the model's timeout on toHaveCount and stop the adaptive timeout measuring model latency.** Finding: section 3. The toHaveCount handler drops `assertTimeout` (four steps floored to 5,000 despite `timeout: 15000` in the call); `observedSettleMs` measures from `lastActionAt`, so a failed 15 s wait plus thinking produced 40,346 ms that the Critic then flagged. File: `src/agent/tools.ts` (pushStep in the toHaveCount branch; `observedSettleMs` should measure the probe alone, or be capped at the model's requested timeout). Effect: removes a recurring Critic complaint and the silent floor; no direct scenario count change. Lock: extend `smoke-gate` (a toHaveCount recorded with the caller's timeout) and `smoke-compare-poll` (a probe after a long idle records the probe duration, not the idle).

5. **Negative-login tests and the lockout counter.** Finding: section 4. The only Critic-passed scenario died because the fourth wrong-password attempt locked the demo account, and the report cannot say so. Three parts: (a) `src/agent/replay.ts` `pollUntil` for text assertions records the last text seen in the error ("expected ... containing X, saw Y"); (b) `src/agent/stability.ts` writes `attempts`, the tried strategies and the final proposal kind on the verdict and sets `gaveUp` when the proposal is "broken", so the dashboard stops saying "none recorded"; (c) the planner and explorer prompts steer a wrong-credential negative to a non-existent account (a fresh `uniqueEmail()`) so no lockout counter exists, keeping the wrong-password-on-a-real-account case as an explicit, single-execution scenario. Effect: the one scenario that passed the Critic here would have shipped (0 to 1 shipped for the same spend). Lock: `smoke-stability-lockout` (a fixture page that locks after three attempts: the recorded error names the observed text and the verdict carries the attempts) and `smoke-run-detail` for the new fields.

6. **Enforce doctrine 6 in the gate.** Finding: section 3, scenario 4 selected `[data-test="category-01M2K06AWQJ6XZEYHJEKD7E8JV"]`, a generated id the doctrine bans, and the gate accepted it because any `[data-*` selector counts as stable. File: `src/agent/gate.ts`, a RULE 6 that rejects a selector whose attribute value has a segment matching the discovery module's `isVolatilePath` shapes (UUID, 16+ hex, 20+ alphanumerics with digits). Effect: converts a guaranteed reseed failure into an in-run re-resolve; no change to this run's count. Lock: `smoke-gate`.

7. **Align the doctrine and the Critic on exact catalogue values.** Finding: section 3, three of the five reworks (1, 2, 4) were exact counts, prices and product names, which doctrine 2 ("or assert the known expected first item") and doctrine 6 ("prefer text content, counts") currently recommend and the Critic rejects as reseed-brittle. File: `src/agent/runtime.ts` SYSTEM (doctrine 2 and 6: for list data, capture and compare relations or a format regex, never a literal item) and `src/agent/critic.ts` SYSTEM (flagging rule 5 stating the same). Effect: removes the axis behind 3 of 5 reworks; each avoided rework saves at least a $0.40 repair. Lock: the doctrine's worked examples rendered through `describeStep` are added as fixtures to `smoke-critic-parse` so a prompt edit that reintroduces a literal-item example fails.

8. **Sanity-check rule citations after parsing.** Finding: section 6. File: `src/agent/planner.ts` after `parsePlan` (drop a citation when the scenario is happy and the rule is typed validation or its text starts with "rejects"/"shows an error"; require `[-]` when the feature's only rule is cited by all three categories) and `src/agent/rule-coverage.ts` (covered only when the citing scenario's category is consistent with the rule type). Effect: none on shipped count; prevents false coverage claims such as R10 by a happy login. Lock: `smoke-plan-rule-tags` and `smoke-rule-coverage`.

9. **Let the crawler see rendered lists and keep the candidate set.** Finding: section 7. File: `src/agent/discovery.ts` `defaultRenderedCollector` (after settle, wait briefly for anchors to stop changing before reading links; record the full candidate list on `DiscoveryResult` so the report can answer which pages were seen) and `src/agent/page-filter.ts` (when the map names a feature and a candidate path plainly matches it, such as `/auth/register` for registration, the pick must not skip it). Effect: R5 becomes plannable through a click-by-name scenario, R11 and R12 through the register page; R6 to R9 still need a stateful add-to-cart step discovery does not perform. Lock: `smoke-discovery-ladder` (a collector whose links appear only after a delay) and `smoke-page-filter`.

10. **Describe the real step budget.** Finding: section 5. File: `src/agent/explore-request.ts` `RUN_ENV_SETTINGS` (label and default text for QA_CORE_MAX_STEPS name the adaptive formula and the 40 floor), the Settings page, and the CLAUDE.md env table. Effect: none on shipped count. Lock: `smoke-settings`.

11. **Offer the repair pass the stated reserve.** Finding: section 2, the reserve was $0.90 but $0.81 was offered because planner and Critic spend are deducted from the total. File: `src/agent/critic.ts` `decideRepairPass` (budget = reserve, or state the deduction in the console line). Effect: small on its own ($0.09 here, under one repair call sequence); listed last because fix 1 changes the repair economics far more.

Fix for section 8 (run-meta and the SRS copy) is already merged as PR #17 and needs no further action.
