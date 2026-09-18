# Diagnosis of run 5e4394 (practicesoftwaretesting.com, 2026-09-18)

Run directory: `output/practicesoftwaretesting-com/20260918T163858Z-5e4394/`. Files read in full: `run-report.json`, `events.jsonl` (921 events), `discovery.json`, `rule-coverage.json`, `requirements-map.json`, `run-meta.json`, `toolshop-srs.md`. Source read: `src/agent/tools.ts`, `src/agent/replay.ts`, `src/agent/gate.ts`, plus `src/agent/critic.ts` (describeStep), `src/agent/reconcile.ts`, `src/server/run-detail.ts` and `src/agent/page-filter.ts` where a question needed them. Compared against `docs/audit/run-ec8eff-diagnosis.md` and `docs/audit/run-f3b41e-diagnosis.md`. Nothing in the run directory was modified. `run-meta.json` says the run came from the dashboard with `QA_CORE_COST_CEILING=6` and no other override, so it repeats the f3b41e setup after PR #21 and PR #22 merged.

How numbers were obtained: every `usage` event carries the cumulative explorer spend of its phase, so a scenario's cost is the difference between the last usage before its `begin_scenario` and the last usage before the next `begin_scenario`, `skip_scenario` or `finish` (the same method as the earlier diagnoses). Tool call counts are `tool_call` events between the same markers. Where the files cannot answer, the section says so.

## 1. Three runs

| Measure | ec8eff (Sept 15) | f3b41e (Sept 18, 13:23) | 5e4394 (Sept 18, 16:39) | Field |
|---|---|---|---|---|
| Pages found by the crawl | 15 (console line only) | 11 | 15 | `discovery.json` `candidates` |
| Pages kept for planning | 3 | 7 | 7 | `report.discovery.pages` |
| Planned | 10 | 18 | 20 | `reconciliation.planned` |
| Explored (recorded by the Explorer) | 6 | 15 | 16 | `done.scenarios` event; `generated` + drops at critic, replay, stability |
| Critic first pass: pass / rework / reject | 1 / 5 / 0 of 6 | 2 / 12 / 0 of 14 (15 scenarios) | 1 / 14 / 1 of 16 | first `critic_done` event |
| Replay pass | 1 of 1 | 1 of 4 | 1 of 1 | `replay.passed` / verdict count |
| Shipped | 0 | 1 | 1 | `report.scenarios.length` |
| Rules covered | 0 of 14 | 1 of 14 (R2) | 1 of 14 (R13) | `ruleCoverage.covered` |
| Total cost (four terms) | $6.0812 | $4.9671 | $6.0888 | `cost.usd` + `plannerUsd` + `criticUsd` + `stability.stabilizerCostUsd` |
| Explorer cost without repair | $5.1483 | $3.9514 | $5.0751 | `cost.usd` minus `cost.repairUsd` |
| Explorer cost per explored scenario | $0.8581 | $0.2634 | $0.3172 | derived; the repair decision line prints the same figure |
| Repair pass | $0.8643, 0 re-recorded | $0.9090, 6 re-recorded, 1 kept | $0.9072, 1 re-recorded, 0 kept | `cost.repairUsd`, `review.repair` |
| Cache share | 0.3873 (derived) | 0.9866 | 0.9881 | `cost.cachedInputShare` |
| Steps | 84 | 223 | 274 | `report.steps` |
| API calls | 64 | 184 | 201 | `cost.calls.length` (usage events for ec8eff) |
| Wall time | 8 min 28 s | 21 min 06 s | 24 min 04 s | `startedAt` to `finishedAt` |

Reading: the cache fix holds (98.8 percent of prompt tokens from cache), exploration is 2.7 times cheaper per scenario than on Sept 15, the run explored more than either earlier run, and the funnel still ends at 1 shipped test for $6.09. The shipped test is the same shape as in f3b41e: one negative contact-form scenario whose assertion is a message element. Every catalogue scenario was dropped, all 15 drops at the Critic (14 rework never repaired or repaired to rework, 1 reject). Sections 2 to 6 show that the Critic asked, in 10 of 14 rework verdicts, for an assertion shape the Explorer's tools cannot record, so the repair pass could not have succeeded at any budget.

## 2. assert_compare numeric relations

Both the live tool and replay compare with the same code. `relationHolds` (tools.ts, near the `pollRelation` helper) and `compareHolds` (replay.ts) read:

```ts
case 'greater':
  return Number.isFinite(Number(current)) && Number.isFinite(Number(captured)) && Number(current) > Number(captured);
case 'less':
  return Number.isFinite(Number(current)) && Number.isFinite(Number(captured)) && Number(current) < Number(captured);
```

The captured and current values are the trimmed `textContent` of the element (`readBySource` in tools.ts, `readStepValue` in replay.ts) or the attribute string, or `String(count)`. There is no digit extraction. `Number("$4.92")` is `NaN`, `Number.isFinite(NaN)` is false, so `greater` and `less` are false for any currency-formatted text whatever the numbers are. Both emitters write the same test: `expect.poll(async () => Number(<read>)).toBeGreaterThan(Number(<captured>))` (transcriber.ts and pom.ts, the `greater` and `less` cases), so a spec with a price compare would fail on replay and in the shipped framework for the same reason. The `before` and `after` relations use `localeCompare` on the raw strings; for "$4.92" against a captured "$48.41", `before` holds (punctuation sorts before a digit), `after` does not.

What the events show. Every failed compare returns the captured and current values in its error, so the pair is on record:

| Phase, scenario | Relation | Captured, now | Held |
|---|---|---|---|
| explore, sorted hand-tools by price | less | "$14.15", "$4.92" | no (NaN) |
| explore, sorted hand-tools by price | before | "$4.92", "$4.92" | no (same element re-read, section 3) |
| repair, sorted hand-tools by price | less (three calls with second-card hints) | "$4.92", "$4.92" | no (same element re-read) |
| repair, sorted hand-tools by price | changed (second-card hints) | "$4.92", "$4.92" | no (same element re-read) |
| repair, sorted hand-tools by price | less | "$48.41", "$4.92" | no (NaN) |
| repair, sorted hand-tools by price | greater | "$48.41", "$4.92" | no (NaN) |
| repair, sorted hand-tools by price | after | "$48.41", "$4.92" | no (localeCompare) |
| repair, sorted hand-tools by price | changed | "$48.41", "$4.92" | yes |

So "$48.41" against "$4.92" failed both numeric relations at 17:01, as the code says it must. The model's own log line at that point reads the failure as a parse problem and falls back to `changed`, which proves a reorder but not a direction, which is exactly the rework reason the Critic gave all three sort scenarios in the first pass ("a name change only proves a shuffle").

What the sort scenarios cost across the three category pages that have products (hand-tools, power-tools, other; special-tools has no products and its sort became a locator finding):

| Scenario | Phase | Calls | Cost | Compare calls on price text |
|---|---|---|---|---|
| sorted hand-tools by price | explore | 12 | $0.1779 | 2 failed |
| sorted power-tools by price | explore | 10 | $0.1839 | 0 (name `changed` only) |
| sorted other by price | explore | 8 | $0.1848 | 0 (name `changed` only) |
| sorted hand-tools by price | repair | 27 | $0.5985 | 7 failed, 1 held |
| total | | 57 | $1.1451 | |

The compare calls themselves cost $0.2147 (3 in exploration, 8 in repair, measured as the usage delta of the call that follows each). The rest is the surrounding navigation, sorting and re-reading. R4 ended `planned-but-dropped`. Across the whole run 19 compare calls failed, $0.4260 of explorer spend.

## 3. assert_compare target

The handler (tools.ts, `case 'assert_compare'`) reads `call.input.name` and `call.input.relation` and nothing else from the input. It looks up `ctx.captures.get(name)` and calls `pollRelation(ctx.page, entry, relation, 5000)`, which calls `readBySource(page, entry)`: `baseLocator(page, entry.target)` for a count, `baseLocator(page, entry.target).first().textContent()` or `.getAttribute()` otherwise. `entry.target` is the `SelectorRecord` resolved at capture time. The input schema declares `intent`, `role`, `label`, `testid`, `css` and `text`, and the tool description says "pass the SAME element hints you captured from so it re-reads the same place", but no code path reads those properties. The `attribute` input is declared and also unused (the capture's attribute is used). Replay is the same: `readStepValue(page, step.source, step.target, step.attribute)` with `step.target` copied from the capture. So there is no argument that lets a compare read a different locator than the capture, live or on replay.

Two consequences visible in the events:

1. On the product-detail scenarios the model captured `a.card:first-of-type h5` on the listing ("Sheet Sander"), clicked through, and compared with `css: "h1"` and later `testid: "product-name"`, `h1[data-test='product-name']`, `role: heading`. Every compare re-read `a.card:first-of-type h5` on the detail page, which is the first related-product card, and returned "Random Orbit Sander" seven times in one scenario and "Safety Helmet Face Shield" once in the other. The model's log lines call this "bizarre" and conclude the tool "re-uses the ORIGINAL selector", which is correct. The price compare in the same scenario waited the full 30 s Playwright default on `a.card:first-of-type .card-footer`, a selector the detail page does not render, because `readBySource` passes no timeout to `textContent()`. Those two scenarios cost $0.7186 (52 calls, two attempts) and $0.4768 (29 calls, two attempts) and both ended with only a URL assertion, which is what the Critic reworked them for. R5 cannot be verified with the current tools at any budget: gate RULE 7 correctly rejects the literal "Sheet Sander" on the detail heading (the events show that rejection at 16:47), and the compare that doctrine rule 2 prescribes cannot cross elements.
2. In the repair of the hand-tools sort, the model captured the first price after sorting and passed second-card hints to `less` four times, expecting a first-against-second comparison. Each call re-read the first card: "$4.92" against "$4.92".

RULE 5 (gate.ts) strips a capture whose `varName` no `assert_compare` step reads. The run has 11 `gate_injection` events: 2 are timeout ceilings (16070 and 16097 ms lowered to 15000 on `toBeVisible`) and 9 are capture strips. What each stripped capture was for, from the capture inputs and the compares that followed:

| Stripped capture | Scenario | Captured for | Class |
|---|---|---|---|
| cap_handToolsCount, _2, _3 | viewed hand-tools | a count, then `greater` with no action (9 against 9) | count against a threshold; the tool has no literal to compare to |
| cap_firstPriceBefore | sorted hand-tools | first price before the sort, `less` after | same element, currency text (section 2) |
| cap_firstPriceNow | sorted hand-tools | first price after the sort, `before` against the third card | cross-element |
| cap_firstProductBefore | toggled eco-friendly | never compared | dead |
| cap_listingName | clicked a product (power-tools) | listing name against the detail heading | cross-element |
| cap_detailNow | clicked a product (power-tools) | detail heading against the listing name | cross-element |
| cap_listingName | clicked a product (other) | listing name against the detail heading | cross-element |

Four of nine stripped captures were taken for a comparison between two elements, which the tool cannot express. The repair of the sort captured three more for the same purpose (secondPriceAsc, secondCardPrice, newFirstPrice); RULE 5 never saw them because the ceiling discarded that scenario.

## 4. The assert tool's types and value forms

The `assert` tool enum (tools.ts) is `toBeVisible`, `toBeHidden`, `toHaveText`, `toContainText`, `toHaveURL`, `toHaveCount`, `toHaveAttribute`, `toHaveValue`. Value inputs are `text` (string), `pattern` (string, documented as "URL substring (literal, no regex required)"), `count` (number, exact), `attribute` and `value` (strings). The only pattern in the pipeline is `toHaveURL`, and the handler escapes the substring into a `RegExp` itself, so the model cannot pass one. `toHaveText` and `toContainText` call Playwright with the string as given, `toHaveAttribute` calls `expect(loc).toHaveAttribute(attribute, value)` with the string, so a value of "/\\S+/" is compared as those six characters. There is no `toBeChecked`, no minimum count, no pattern form for text or attribute. The `Assertion` union in trace.ts has the same eight members with string fields, so replay and both emitters could not carry a pattern either.

Rework verdicts whose required fix names one of these shapes (`review.verdicts` on the report):

| Scenario | Asked for | Available? |
|---|---|---|
| viewed hand-tools | `toHaveCount` greater than 0; `toHaveText` matching `/\S+/`; `toHaveText` matching a currency pattern | no, no, no |
| toggled eco-friendly (hand-tools) | `toBeChecked` on the filter checkbox | no |
| filtered by eco-friendly (power-tools) | `toBeChecked` | no |
| loaded power-tools | non-empty `toHaveText`, or a non-empty `src` | no |
| browsed the Other category | `toHaveText` `/\S+/`; `toHaveAttribute('src', /\S+/)` | no |
| listed rental products | non-empty name text; non-empty image src | no |
| logged in | `toHaveText(/[A-Za-z]+ [A-Za-z]+/)` | no |
| sorted (three pages) | capture two prices and compare with `less` | relation exists; fails on "$" (section 2) |
| clicked a product (two pages) | capture the listing name, assert the detail heading equals it | compare cannot cross elements (section 3) |
| rejected an email without @ | `toHaveAttribute('aria-invalid', 'true')` scoped to the alert | yes |
| submitted the contact form | timeout on a count 0; `toContainText` on the alert | yes |

Seven verdicts asked for a pattern, a checked state or a minimum count the tool has no form for; three asked for a numeric price compare that the parser cannot hold; two asked for a cross-element compare. That is 12 of 14 rework verdicts asking for something the recorded tools cannot do, and 10 of those 12 are structural (the two contact-form verdicts are the ones that could have been repaired). The repair pass shows the consequence: on the hand-tools re-record the model tried `toHaveText "/\\S+/"` (RULE 7 rejected it as a literal), `toHaveAttribute src "/\\S+/"` (Playwright compared the literal string and failed), `toHaveAttribute src "assets/img/products/"` (strict equality, failed), then four `toHaveCount 9` (RULE 7 rejected each), and settled on the five circular compares of section 6. The doctrine both prompts share tells the Critic to demand "a format" (Critic prompt rule 5, doctrine rule 6) while the Explorer has no tool that records one.

## 5. describeStep and the compare timeout

`describeStep` (critic.ts) renders an `assert_compare` step as:

```
assert_compare <readVar> <relation> vs captured <varName> at <locator>
```

with no timeout, while every `assert` case appends `[timeout:Nms]` or `[no-timeout]`. The compare step carries no timeout field (`TraceStep` for `assert_compare` in trace.ts has none); replay polls it with `DEFAULT_TIMEOUT_MS` (10000, replay.ts) and both emitters write `expect.poll(..., { timeout: 10000 })` (`COMPARE_POLL_TIMEOUT_MS`). The Critic never sees that number, and its prompt rule 1 marks any async assertion without a timeout as rework. In this run two verdicts give the missing poll as a reason (both eco-friendly filters: "the assert_compare on count after set_checked needs an explicit timeout"), and three more require "assert_compare ... with timeout 10000ms" in their fixes (the three sorts). Five of fourteen rework verdicts carry a demand the recorded step already satisfies and the rendering hides.

## 6. Circular compares at the tool

The handler records `equal` or `unchanged` whenever the re-read equals the captured value. It does not look at the steps between the capture and the compare, so a compare with no action since the capture is accepted and recorded. (The plan-time check in planner.ts, `rejectCircular`, only reads scenario names.) In this run five such compares were recorded, all in the repair of "viewed hand-tools category": three `equal` on `cap_cardCount` (captured 9, re-read 9 with no action; the model passed `a.card h5`, `img.card-img-top` and `.card-footer` hints, which the tool ignored, so all three re-read `a.card`), then `unchanged` on `cap_firstTitleText` and on `cap_firstPriceText`, both immediately after their capture. The second Critic pass named exactly those five as rule 8 failures and returned rework, so the only scenario the repair pass re-recorded ($0.2446, 22 calls) was spent on assertions the tool should have refused. In exploration no circular compare was recorded: the one attempt (`greater` on a count with no action) was refused because 9 is not greater than 9, not because of a circularity check.

## 7. Planning duplication

`discovery.json` lists 15 candidates and 7 kept pages. Four kept pages share the path template `/category/{slug}` (hand-tools, power-tools, other, special-tools); `/rentals` is a fifth listing page with the same card layout; `/contact` and `/auth/login` stand alone. The Planner ran once per page with the same map and the same checklist, so the four category pages produced the same intents:

| Intent | Pages planned on | Scenarios | Explored | Explorer cost beyond the first page |
|---|---|---|---|---|
| listing shows name, image, price | hand-tools, power-tools, other, rentals | 4 | 4 | $0.5266 |
| sort by price low to high | all four categories | 4 | 4 (special-tools became a finding) | $0.4992 |
| eco-friendly filter narrows the list | hand-tools, power-tools, special-tools | 3 | 3 (special-tools rejected) | $0.3640 |
| click a product, detail matches listing | power-tools, other, rentals | 3 | 2 (rentals skipped) | $0.4768 |
| search a term with no match | other, special-tools | 2 | 1 finding, 1 skipped | $0 |
| total | | 16 of 20 planned | | $1.8666 |

Per-scenario costs behind the table (exploration only): listing $0.2275, $0.0870, $0.1097, $0.3299; sort $0.1779, $0.1839, $0.1848, $0.1305; eco $0.1215, $0.1437, $0.2203; click $0.7186, $0.4768; search $0.2500. Ten of the twenty planned scenarios repeated an intent already planned on another page of the same template, and $1.87 of the $5.08 exploration spend (37 percent) went to the repeats. None of the repeats could ship for the reasons in sections 2 to 4, so the duplication multiplied a zero. The rename from PR #22 worked as designed (two log lines, `(category/power-tools)` and `(category/other)` suffixes) and made the duplication visible; it does not merge it. The two search scenarios also show a planning problem the files record: the search input on category pages is covered by the site's "Testing Guide" overlay, the model recorded one locator finding and skipped the other, and R2 was never verifiable from a category page.

Why `/auth/register` was not kept: it was never a candidate. The 15 candidates are the entry, four categories, rentals, contact, login and seven volatile `/product/<id>` pages. `walkCrawl` (discovery.ts) stops at `CRAWL_PAGE_CAP` (15), and the breadth-first frontier from the entry page reached seven product links before the register link, which sits one level down behind `/auth/login`. The 15 volatile product pages then count toward the cap while the filter keeps at most one of them. The feature-name hypothesis is secondary but real: the map's feature is named `account`, `tokensFor('account')` returns `account` and `profile`, and the registration token set is keyed on `registration` and `register`, so `plainFeatureMatches` would not have kept `/auth/register` either; it would have depended on the Haiku pick. R11 and R12 are `not-planned` for both reasons.

## 8. Repair pass

The decision line printed once:

```
repair pass: 14 scenario(s), budget $0.90 (the stated reserve); explorer cost this run $0.3172 per recorded scenario, so the reserve funds about 2 of 14
```

`repair_started` carries `count 14, budgetUsd 0.90`. Two scenarios started: "viewed hand-tools category" was re-recorded ($0.2446, 22 calls) and returned rework again (section 6); "sorted hand-tools by price" was mid-repair when the ceiling hit ($0.5985, 27 calls, the last three under the closeout grace) and was discarded. Twelve were "never re-explored: the repair budget ran out first". `repair_done`: $0.9072 spent, 0 kept, 14 dropped. Spend per started scenario: $0.4536, above the $0.3172 per-scenario figure the decision line used. The line was accurate about the arithmetic (about 2 of 14) and the pass ran anyway; given sections 2 to 4, a pass that funded all 14 would have kept 2 at most (the contact-form verdicts).

## 9. The 16 versus 19 recorded, and "+1 unplanned"

Two different numbers on the run page both say "recorded":

- The Explore rail stat (`buildStages` in run-detail.ts) reads `16 recorded · 1 shipped · 274 steps · $5.9823`. Recorded is `reconciliation.generated` (1) plus the 15 drops at the critic stage. This matches `done.scenarios` (16) and the 16 verdicts.
- The Scenarios table subtitle (`RunDetail.tsx`, `{detail.scenarios.length} recorded`) reads 19. The rows are built in `buildRunDetail` from the plan (20 names, minus the 2 findings, which are removed from the rows) plus every name in scenarios, replay, stability, dropped, incomplete and skipped. The drop for the Other-category listing is recorded under the Critic's echo of the name, `browsed products in the Other category ...` without the quotation marks the plan has around "Other", so it matches nothing in the plan and adds a 19th row. `gateByVerdicts` writes the drop under the verdict's name, not the plan name the tolerant matcher paired it with.

What they should read: the stat is right at 16. The table subtitle should not say recorded; it lists planned, dropped and skipped rows, so "19 scenarios" or "18 planned" is what the rows are, and the drop should be recorded under the plan name so the row count is 18.

The funnel term: `reconciliation.accountedFor` is 21 against 20 planned, `added` is 1, and `note` says the Explorer added a scenario beyond the plan, "e.g. an a11y check", which is not what happened. The scenario "searched for a term that matches no products and the list became empty" is counted twice: once in `findings` (the search input could not be resolved after 2 attempts) and once in `skipped` (the model then called `skip_scenario` on it, and the handler checks `ctx.skipped` for a repeat but not `ctx.findings`). The identity `planned === generated + dropped + incomplete + findings + skipped` reads 20 = 1 + 15 + 0 + 2 + 3 = 21, and `balanced` is true because a surplus is treated as extra coverage. It should read 20 = 1 + 15 + 0 + 2 + 2 with no `added` term: a scenario already recorded as a finding is not skippable, and reconciliation should count each name once across its terms rather than accept any surplus.

## Ranked fix list

Shipped per dollar today: 1 test for $6.09 on this run, 1 for $4.97 on f3b41e, 0 for $6.08 on ec8eff. Each entry states what this run spent that the fix removes or unlocks; no projection.

1. **assert_compare can compare two elements, and its hints are honored.** Finding: the compare re-reads only the capture's own target, the hints in its schema are ignored, and the tool description says the opposite (section 3). Files: `src/agent/tools.ts` (handler: resolve the hints when given and record a `readTarget`; refuse hints that resolve to the capture's own element only when the relation is `equal`), `src/agent/trace.ts` (`readTarget` on the compare step), `src/agent/replay.ts` (`readStepValue` from `readTarget`), `src/agent/pom.ts` and `src/agent/transcriber.ts` (emit the read from the second locator), `src/agent/critic.ts` (describeStep shows both locators). Also cap the read with a timeout so an absent target does not wait 30 s. In this run: R5 on two scenarios, $1.1954 and 81 calls, ended with a URL assertion only; the sort repair's second-card compares ($0.5985) had no way to work. Lock: `smoke-capture-compare` (capture on A, act, compare on B; hints ignored today must be read; a compare whose hints resolve to the capture element with no action is refused).
2. **greater and less parse a number out of formatted text.** Finding: `Number("$4.92")` is NaN in the tool, in replay and in the emitted spec, so no currency, percentage or thousands-separated value can satisfy either relation (section 2). Files: one shared `numericValue()` in `src/agent/tools.ts` and `src/agent/replay.ts` (strip everything except digits, sign and one decimal point; refuse when no digit remains), the same expression emitted by `src/agent/pom.ts` and `src/agent/transcriber.ts`. In this run: three sort scenarios, $1.1451, 57 calls, R4 uncovered. Lock: `smoke-compare-poll` and `smoke-capture-compare` (a "$14.15" then "$4.92" pair holds `less` live, on replay and in the emitted spec).
3. **The assert tool records the shapes the doctrine demands, or the doctrine stops demanding them.** Finding: seven rework verdicts asked for a text or attribute pattern, a checked state or a minimum count that no tool records (section 4), and gate RULE 7 rejects the literal that is the only alternative. Files: `src/agent/tools.ts` and `src/agent/trace.ts` (`toBeChecked`; `pattern` on `toHaveText`, `toContainText`, `toHaveAttribute`; `atLeast` on `toHaveCount`), `src/agent/replay.ts`, `src/agent/pom.ts`, `src/agent/transcriber.ts` (emit `new RegExp(...)` and `toBeChecked`), `src/agent/gate.ts` (RULE 7 lets a pattern through and keeps rejecting a literal), `src/agent/doctrine.ts` and `src/agent/critic.ts` (name the tool forms, not "a regex"). In this run: seven rework verdicts and the whole re-recorded repair ($0.2446) circled these shapes. Lock: `smoke-gate` (pattern passes, literal still rejected), `smoke-critic-parse` (describeStep renders a pattern as a pattern).
4. **One plan per path template.** Finding: four `/category/{slug}` pages and `/rentals` were planned separately with the same checklist; 10 of 20 scenarios were repeats and $1.87 of $5.08 exploration went to them (section 7). Files: `src/agent/discovery.ts` (tag candidates with a path template: same segment count, one differing slug), `src/agent/runtime.ts` (plan the template once on its shallowest page; the combine loop drops a scenario whose intent key already exists on another page of the same template instead of renaming it), `src/agent/planner.ts` (per-template steering that names the sibling pages). Lock: `smoke-page-filter` (template detection on the f3b41e and 5e4394 URL sets) and `smoke-plan-dedup` (a repeated intent across sibling pages collapses to one).
5. **A compare with no action since its capture is refused at the tool.** Finding: five `equal` and `unchanged` compares were recorded with nothing between capture and compare, and the Critic then reworked the only re-recorded repair for them (section 6). Files: `src/agent/tools.ts` (in the handler, scan `ctx.current.steps` after the capture step for a click, fill, press, navigate, select_option, set_checked or set_input_files; refuse `equal` and `unchanged` when none, with the steer to act first or to use the second-element form from fix 1). In this run: $0.2446 and 22 calls. Lock: `smoke-circular` (tool-level refusal, and `unchanged` after a reload plus a real action still records).
6. **describeStep shows the compare poll.** Finding: the Critic cannot see that a compare polls for 10 s and asked for a timeout on five verdicts (section 5). Files: `src/agent/critic.ts` (render `[polls 10000ms]` from the replay constant, exported from `src/agent/replay.ts`, and state in the Critic prompt that every compare polls). In this run: five of fourteen rework verdicts carried the demand. Lock: `smoke-critic-parse` (the rendered line carries the poll, and the Critic prompt states it).
7. **A name is counted once in the funnel, and drops carry the plan name.** Finding: one scenario is both a finding and a skip, so the funnel reads 21 of 20 with a false "+1 unplanned"; one drop is keyed by the Critic's echo of a name, so the run page counts 19 rows against 16 recorded (section 9). Files: `src/agent/tools.ts` (`skip_scenario` refuses a name in `ctx.findings`), `src/agent/reconcile.ts` (dedupe names across terms before summing, and stop treating a surplus as balanced without naming the extra), `src/agent/critic.ts` (`gateByVerdicts` records the drop under the matched scenario name), `dashboard/src/pages/RunDetail.tsx` (the table subtitle names what the rows are). Lock: `smoke-plan-enforcement` (skip after finding refused), `smoke-reconcile` (a name in two terms is one), `smoke-run-detail` (the stat and the table agree on this run's shape).
8. **Volatile pages do not consume the crawl cap.** Finding: seven `/product/<id>` pages filled the 15-page cap before `/auth/register` was reached, and the filter keeps at most one volatile page anyway (section 7). Files: `src/agent/discovery.ts` (`walkCrawl` counts a volatile path toward its own small cap, say 2, not the page cap, and queues stable paths first). In this run: R11 and R12 not planned, the account feature planned one scenario. Lock: `smoke-discovery-ladder` (a fixture site with eight generated-id links and a register link two levels down; register is a candidate).
9. **The repair pass funds only verdicts the tools can act on.** Finding: the pass started two of fourteen with $0.90 and neither could have passed (sections 4, 6, 8). Once fixes 1 to 3 land, most reasons become actionable; until then, the decision line should also say how many of the rework verdicts ask for a shape the tools have, and start those first. Files: `src/agent/critic.ts` (`decideRepairPass` classifies required fixes against the tool vocabulary). Lock: `smoke-repair-pass`.
10. **The assert_compare description matches its behaviour.** Subsumed by fix 1; if fix 1 is delayed, the description in `src/agent/tools.ts` must stop telling the model to pass hints it ignores, and `attribute` should leave the schema. Lock: `smoke-tools` (schema and description agree with the handler).

Fixes 1, 2 and 3 are the ones that change shipped per dollar: they cover 12 of the 14 rework verdicts on this run. Fix 4 changes the dollar side by the same amount on every multi-category site. Fixes 5 to 7 remove wasted repair spend and wrong numbers; 8 to 10 are correctness.
