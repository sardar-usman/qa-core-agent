# QA-Core STATE

Updated: 2026-10-23. Update this file at the end of every working day.
It is the first thing to read in any new thread.

## What QA-Core is

An autonomous QA agent (repo sardar-usman/qa-core-agent, main branch is truth).
Pipeline: Planner (Haiku) plans scenarios, Explorer (Opus 4.7) drives a real
browser and records steps, Critic (Sonnet 4.6) grades every scenario pass /
rework / reject with a one-pass repair for rework, Replay re-runs everything
headlessly, Stability re-runs survivors 3x, the transcriber emits a
client-ready Playwright framework (POM, datasets, storageState auth, CI-ready)
as a zip, and an emitted-spec check runs that framework once against the live
site before the zip is written (PR #30). Healing of broken specs is delegated
to the separate qa-core-heal npm package (own repo, own thread).

Surfaces: CLI (npm run explore / transcribe / heal), gateway with a dashboard
served at http://127.0.0.1:18789/, MCP server. All three build runs through
src/agent/explore-request.ts.

Verification: npx tsc --noEmit, then npm run smoke (the suite is discovered
from scripts/, 97 smokes, 2 of them live and skipped unless
QA_CORE_LIVE_SMOKES=1 is set; smoke-all reports "97 smokes, 95 passed, 0
failed, 2 skipped (live)").
Before any live run: npx tsx scripts/preflight-site.ts <url> --login (every run now makes the same login preflight itself before any spend, invariant 70).

## Maturity pass: complete (Phases 1 to 5 merged, Sept 3 to 14)

1. Heal moved to the qa-core-heal package; in-run selector recovery kept.
   POM strict-mode (.first) bug fixed; filter({hasText}) disambiguation.
2. SRS ingestion (--srs md/txt/pdf/docx) into a requirements map; rule-driven
   planning with rule-id citations; rule-coverage.json with
   "considered, not automated" reasons.
3. Discovery ladder: SRS URLs, --urls, sitemap/robots, polite fetch crawl,
   browser crawl for SPAs, entry-only fallback (loud). Page relevance filter.
   Checklist-driven scenario derivation. Volatile-id pages reached by clicking
   from listings, never by GUID URL.
4. Critic gate actually enforced (it had been silently dead for two months).
   Repair pass with a reserved budget (QA_CORE_REPAIR_RESERVE, default 15%).
   Assertion doctrine in the Explorer prompt. Cost ceiling salvage (completed
   scenarios survive a ceiling stop). Checkpoint on every abnormal end
   (ceiling, billing, API, SIGINT) with --resume; verdicts carried on resume.
5. Emitted frameworks: JSON datasets per feature, storageState auth setup,
   credential values never emitted (value-based substitution), dotenv loaded,
   run-report redacted in the zip. Transcribe from an existing run-report.
   Dashboard and MCP parity with every CLI option.

Model benchmark (Sept 9, same site, same $6): Opus explorer shipped 2 stable
tests; Sonnet explorer shipped 0 with weaker assertions. Decision: Explorer
stays on Opus. Models are overridable via QA_CORE_PLANNER_MODEL /
QA_CORE_EXPLORER_MODEL / QA_CORE_CRITIC_MODEL.

## Dashboard v2: code complete Sept 15 (plan in docs/dashboard-v2-plan.md)

- PR A foundation (PR #10): MERGED Sept 14. Per-run output layout
  output/<host>/<run-id>/, SQLite index, token-guarded REST, Projects page
  and Runs table. Legacy gateway records imported as "summary only (pre-v2)"
  rows (30 rows, 8 hosts), explored counts only; missing counts render n/a.
- PR B run detail (PR #11): MERGED Sept 14. Scenarios table, findings,
  artifacts, events status, tolerant verdict matching via assignVerdicts,
  four-term cost total, schema v4.
- PR B2 stage view (PR #12): MERGED Sept 14. Six panels from run-report.
- PR C terminal + live run view (PR #13): MERGED Sept 14. Single-terminal
  composer through explore-request.ts, SRS attach, live stage view. First
  dashboard-started run: saucedemo SRS, 4 planned, 4 shipped, $0.6187.
  Parallel-run plumbing deferred to after the audit.
- PR D projects/findings/coverage/trends (PR #14): MERGED Sept 15.
- PR E1 settings/resume/transcribe/projects/SRS (PR #15): MERGED Sept 15.
- PR E2 retire legacy UI + polish (PR #16): MERGED Sept 15.
- Fix: stopped runs keep run-meta, SRS copy, repair events (PR #17):
  MERGED Sept 16.
- PR F design pass: AFTER the audit report. Brief first at
  docs/dashboard-design.md, then page by page, numbers untouched.

## Engine hardening phase (from Oct 6)

Goal: fix the audit's open items (docs/audit-2026-09.md section 10) in
ranked order, $0 per PR, then ONE live confirmation run graded against a
bar written here first. Order, exit bar and budget CONFIRMED by the owner
Oct 6.
1. engine/rework-rate: DONE, PR #42 merged Oct 8.
2. Dropped traces kept on the report, redacted, under the plan's canonical
   name (audit items 5 and 8): DONE, PR #43 merged Oct 8.
3. Test credentials (audit item 1, D7; decided Oct 8): the client supplies
   a dedicated test account through the host .env; self-registration is
   not the login source. Brief first (docs/design/test-credentials.md),
   then PR. DONE, PR #45 merged Oct 14 (main ab085f6) (invariant 70: the
   fill marker, the login preflight before any spend, the wrong-password
   cap, no account value under output/, QA_CORE_AUTH_* retired, session
   files kept out of every zip by path). The saucedemo regression run
   20261013T135013Z-4b0e43 ($0.41) met its bar on all six lines. Recheck of
   that run ($0, scripts/recheck-run.ts): emitted check 6 of 6, zip 23
   entries, no session or report folder.
4. Action-first discovery rung for state-dependent pages (item 3).
   Brief: docs/design/state-dependent-pages.md (PR #46). DONE, PR #47
   merged Oct 14 (main 29d20d9); click action only; login action
   designed, not built (invariant 71: the state probe, the revealed page
   recorded as reached by action, the never-navigate refusal, not-revealed
   coverage; $0, proven on a fixture site, no live run).
5. Console honesty: D8 plus the critique seam reaching the repair block
   (item 9). DONE, PR #48 merged Oct 15 (main 666d49e) (invariant 72: one rule-coverage print
   after the emitted-spec check, the closing Critic paragraph from the
   final verdicts, the repair budget named and rounded, the no-page
   warning only when true, no console message dropped, the real skip
   reason, runnable "Run the framework" steps, a ceiling cut never a drop,
   page-fit rule ids, the critique seam; $0, locked by
   smoke-console-honesty and smoke-repair-block, no live run).
6. Small engine items: D9, getByTestId with testIdAttribute (item 10),
   orientation load waste (item 11). DONE, PR #49 merged Oct 16 (main
   b131acd) (invariant 73: RULE 7
   judges a heading by its locator, never the intent; an all-data-test
   recording ships getByTestId with testIdAttribute in the config; a
   multi-page plan starts at scenario 1 with orientationCalls recorded and
   printed; toHaveAttribute, toBeChecked and toHaveValue probes fail at
   10 s; reworded cross-page duplicates citing the same rules collapse at a
   0.75 name overlap; the cost line says when and why the total went over
   the ceiling; $0, locked by smoke-gate, smoke-emitted-run,
   smoke-orientation, smoke-compare-poll, smoke-plan-page-fit and
   smoke-cost-ceiling, no live run).
7. Model pricing honesty ($0): one price table keyed by model id; every
   stage (Planner, Explorer, Critic, Stabilizer, requirements map, page
   filter, feature parser) priced by the model it actually called; an
   unknown model id refuses to start. Found Oct 8: priceFor falls back to
   Opus 4.7 prices, the Critic and Planner prices are fixed constants, the
   Stabilizer prices Opus at 15/75. DONE, PR #50 merged Oct 16 (main
   1e27c25) (invariant 74: one price
   table in src/agent/pricing.ts keyed by exact model id, costOf prices all
   four usage fields; every stage priced by the model it called and
   resolved in stage-models.ts; an unknown id refuses the run on the CLI,
   the gateway and MCP before any call; cost.models on the report;
   scripts/pricing-history.ts for the erratum decision; $0, locked by
   smoke-pricing, no live run).
8. Live confirmation run (Toolshop, same SRS, $6 ceiling, about $6) on the
   current models (Haiku 4.5, Opus 4.7, Sonnet 4.6), logged in with a
   dedicated account the owner registered by hand (values in .env only),
   graded against the bar below. Run 7 done Oct 23, bar missed; diagnosis
   docs/audit/run-59540f-diagnosis.md. Next: fix PR for D1 to D4 and D5's
   cause, then run 8 with a new bar written first.
Exit bar (written Oct 6, before the run): rework rate under 35 percent on
the first Critic pass; shipped and rules covered reported, not targeted;
emitted-spec check green for every shipped test; zero shipped tests whose
name claims more than the recording proves; the happy login survives
replay.
Live budget: one Toolshop run at the $6 ceiling, plus a saucedemo
regression run (about $0.60) because item 3 touches login.
Proposed, pending the owner: one A/B Toolshop run after item 8 with only
the Explorer on Opus 5.5, Critic held fixed (about $6). Planned in
"Opus 5.5 comparison" below.

### Run 7 bar (written Oct 16, before the run)

a. Command. Run 6's command, read from
output/practicesoftwaretesting-com/20261001T122557Z-44cb3d/console.log
line 3 (npm's echo of the script it ran):
`tsx src/cli/explore.ts https://practicesoftwaretesting.com/ --srs output/practicesoftwaretesting-com/20260918T163858Z-5e4394/toolshop-srs.md --ceiling 6 --lang ts --pom --replay --stability 3 --stabilize --stabilize-attempts 3`.
Run 7 uses the same flags, the same SRS file and the $6.00 ceiling,
nothing added or removed:

```bash
cd /Users/osman/Projects/Openclaw/qa-core-agent && npm run explore -- https://practicesoftwaretesting.com/ --srs output/practicesoftwaretesting-com/20260918T163858Z-5e4394/toolshop-srs.md --ceiling 6 --lang ts --pom --replay --stability 3 --stabilize --stabilize-attempts 3
```

Every flag exists today under the same name (EXPLORE_FLAGS in
src/agent/explore-request.ts), so no flag changed. `npm run explore --`
is the npm form of line 3; the `--` passes the flags to the script. The
emitted-spec check runs by default, as it did in run 6 (run-meta.json
`flags.emittedCheck` true). The SRS file is byte-identical to the project
copy (output/practicesoftwaretesting-com/srs/toolshop-srs.md) and its
requirements map is cached under srs/ac278ddf17eb, so the map is reused
and costs $0. Models are the defaults: Planner, requirements map, page
filter and feature parser claude-haiku-4-5; Explorer claude-opus-4-7;
Critic and Stabilizer claude-sonnet-4-6. No model env override may be
set, in the shell or in .env: QA_CORE_PLANNER_MODEL,
QA_CORE_MODEL_PLANNER, QA_CORE_EXPLORER_MODEL, QA_CORE_MODEL_EXPLORE,
QA_CORE_CRITIC_MODEL, QA_CORE_MODEL_CRITIC, QA_CORE_MODEL_STABILIZER.
Today .env line 10 sets QA_CORE_MODEL_EXPLORE=claude-opus-4-7 (the
default value, so the model is the same); the owner comments that line
out before the run. Also unset, so run 6's defaults hold:
QA_CORE_REPAIR_RESERVE (run 6: 0.15, events.jsonl line 1),
QA_CORE_MAX_STEPS (run 6: the formula, 406, console.log line 60),
QA_CORE_WRONG_PASSWORD_CAP (default 10). `--ceiling 6` wins over
QA_CORE_MAX_USD=2.00 in .env. After the run, `cost.models` on
run-report.json must read exactly these models; any other value voids
the run as run 7.

b. Preconditions.

- Login preflight: LOGIN OK on Oct 16 with the host-scoped Toolshop
  account (QA_CORE_TEST_USER_PRACTICESOFTWARETESTING_COM /
  QA_CORE_TEST_PASS_PRACTICESOFTWARETESTING_COM, owner-run). Run it again
  right before the run; anything but LOGIN OK means no run:
  `cd /Users/osman/Projects/Openclaw/qa-core-agent && npx tsx scripts/preflight-site.ts https://practicesoftwaretesting.com/ --login`
- main at 1e27c25 or later, `git status` clean (no local changes).
- `grep -n '^QA_CORE_.*MODEL' .env; env | grep '^QA_CORE_.*MODEL'` prints
  only QA_CORE_MODEL_TRANSCRIBE (/generate, not an explore stage) and
  QA_CORE_MODEL_ROUTER (read by nothing under src/).

c. The bar (confirmed by the owner Oct 6). Each line names where it is
measured; every file is in the run 7 folder under
output/practicesoftwaretesting-com/.

1. Rework rate under 35 percent on the FIRST Critic pass. Numerator: the
   first-pass rework verdicts, which is the number of `review.repair`
   entries in run-report.json (one per first-pass rework, `first:
   "rework"`, funded or not; a scenario held as rework for "no verdict
   returned" counts). Denominator: the scenarios the first pass judged,
   the length of `verdicts` in the FIRST `critic_done` event in
   events.jsonl (equal to `review.verdicts.length`). Cross-check: the
   `verdict: "rework"` count in that event equals `review.repair.length`.
   Run 6: 10 of 16, 62.5 percent. Strictly under 35 percent to pass.
2. Shipped count and rules covered: reported, not targeted. Shipped is
   `reconciliation.generated` (equal to `scenarios.length`); rules
   covered is `ruleCoverage.covered` over all rules (rule-coverage.json,
   and the one `Rule coverage:` console line). Run 6: 12 shipped, 10 of
   14 rules.
3. Emitted-spec check green for every shipped test: every
   `emittedRun.tests` entry for a shipped test has status `passed`, and
   `emittedRun.inconclusive` is not true (an inconclusive check is
   recorded with its `reason` and the line is not graded met). Reported
   beside it, the honest measure: tests with status `passed` over every
   entry in `emittedRun.tests`, drops and the a11y spec included (a
   failed test is also in `emittedFailed`). Run 6: 13 of 14.
4. Zero shipped tests whose name claims more than the recording proves.
   Graded by hand by the advisor, test by test, from the zip's
   tests/**/*.spec.ts against the scenario's `steps`, `pageUrl` and
   cited rules in run-report.json. Run 6: two (the rental-titled test
   recorded on hand tools, D2; the wrong-password test that submitted a
   generated non-existent account, D7).
5. The happy login survives replay: the `replay.verdicts` entry whose
   `name` is the happy login scenario (category happy, its password fill
   marked `credential: "pass"`) has `passed: true` and no `refused`. No
   such entry (skipped, dropped before replay) means the line is missed.
   Run 6: "logged in with valid credentials", `passed: false`.

d. Measured and recorded, not graded.

- Cart state probe (invariant 71): the `State probe "cart"` line and
  the `State probe "cart" rule split:` line on the console;
  `discovery.stateProbes` in run-report.json and discovery.json
  (`outcome`, `revealed`, `rulesSplit`). For each of R6 to R9: planned
  or not (`plan[].ruleIds`), on which page (`plan[].pageUrl` and
  `reachedBy`), and covered or why not (`ruleCoverage`).
- `orientationCalls` on run-report.json and the `Orientation:` console
  line (invariant 73).
- RULE 7 refusals of a heading literal right after a click on a nav link
  (the known false positive from the PR #49 review), counted from
  events.jsonl: a `tool_result` with `ok: false` and an `error` that
  begins `RULE 7 (literal catalogue value) rejected this`, whose
  `tool_call` targets a heading and whose previous action in the same
  scenario is a `click` on a role link. Also record the total RULE 7
  refusals for scale.
- For every covered rule, whether its citing test actually exercises it,
  checked by hand (run 6's eco-friendly test cited R3 without exercising
  the category filter).
- `cost.models` per stage; cost per stage (`cost.requirementsUsd`,
  `cost.plannerUsd`, `cost.usd` minus `cost.repairUsd` for the Explorer,
  `cost.repairUsd`, `cost.criticUsd`, `stability.stabilizerCostUsd`);
  the Explorer's cache spend from `cost.cacheReadTokens` and
  `cost.cacheCreationTokens`. The non-Explorer stages' cache read and
  cache write spend is inside their stage dollars (costOf prices all four
  fields since PR #50) but their token split is not on the report: read
  it from the Anthropic Console usage for the qa-core workspace over the
  run's window, by model, and label it as such. This is the first run
  that prices it; it decides the one-sentence audit note.
- Total cost (`totalCost`, the `Cost:` console line) against the $6.00
  ceiling (`cost.ceilingUsd`), with the over-ceiling text if it prints.
- Wall time: `startedAt` to `finishedAt` on run-report.json (the
  pipeline), and to `writtenAt` in run-meta.json (the end, the emitted
  check and the zip included). Run 6: 19 min 32 s for the pipeline.

e. Rules for the run. One run. A missed bar is recorded as missed, never
re-run to improve the number (standing decision). If the run stops
before the Critic (a crash, a billing error, a preflight stop), it is
not graded, the cause is diagnosed at $0, and the owner decides whether
a second attempt counts as run 7.

Run 7 verdict: bar missed on lines 1, 4 and 5, met on line 3. Run
20261023T122053Z-59540f, $2.01, 9 min 6 s; `cost.models` matched part a,
so it counts as run 7. Diagnosis: docs/audit/run-59540f-diagnosis.md.

1. Missed: 4 reworks of 8 on the first pass, 50 percent (run 6: 62.5);
   both catalogue scenarios dropped on required fixes the Critic based
   on misread compare lines (D3), and three of the four reworks hit a
   secondary check that doctrine rule 8 allows (D7d).
2. Reported: 5 shipped, 4 of 14 rules (run 6: 12, 10 of 14).
3. Met: the emitted-spec check passed 6 of 6, nothing dropped, not
   inconclusive.
4. Missed: one shipped test overclaims; "search for term filtered list to
   only matching product names" checks that the count fell and that the
   first card contains "pliers", not that every card matches (D5).
5. Missed: no login scenario was planned, so no replay verdict exists.

Main cause (D1): discovery stopped at the site's new 3-URL sitemap
(/, /contact, /privacy), so the run planned 9 scenarios on 3 pages with
no category, product, login or cart page. The site's robots.txt, changed
since run 6, now disallows /auth and /checkout, so fixing D1 brings back
the catalogue pages but not login, registration or the cart page (D7a);
line 5 needs an owner decision on `--urls` for the /auth pages.

### Opus 5.5 comparison (planned; runs only if the owner approves)

The run 7 command with only QA_CORE_EXPLORER_MODEL=claude-opus-5-5 set
(in the price table, so it is not refused), same $6.00 ceiling, same SRS,
same preconditions, the same main commit as run 7, run after run 7 is
graded:

```bash
cd /Users/osman/Projects/Openclaw/qa-core-agent && QA_CORE_EXPLORER_MODEL=claude-opus-5-5 npm run explore -- https://practicesoftwaretesting.com/ --srs output/practicesoftwaretesting-com/20260918T163858Z-5e4394/toolshop-srs.md --ceiling 6 --lang ts --pom --replay --stability 3 --stabilize --stabilize-attempts 3
```

`cost.models.explorer` must read claude-opus-5-5 and every other stage
the run 7 models. No pass or fail bar: a side-by-side table of every line
in parts c and d for both runs, plus cost per shipped test (`totalCost`
over `reconciliation.generated`; run 6: $6.09 over 12). Both runs are
reported, whichever looks better.

## Audit fix PRs, all MERGED

- #18 cache history (Sept 17).
- #19 critic sees selectors, shared doctrine, lockout (Sept 17).
- #20 audit remainder (Sept 18).
- #21 assertion gate: RULE 7 catalogue literals, timeout cap, Critic sized
  to scenario count with one retry, fake credentials at the fill (Sept 18).
- #22 planning and discovery: page feature tags, unique names, anchor
  baseline (Sept 18).
- #23 tool surface: cross-element compares, currency parsing, pattern and
  toBeChecked assertions, minimum counts, circular compares refused,
  smoke-emitted-run executes the emitted framework in TS and JS (Sept 19).
- #24 plan scope: one plan per path template, rule-content feature matching
  (Sept 19).
- #25 smoke suite discovered from disk (12 smokes had never run), live
  smokes opt-in, zero-cost site preflight with --login, invariant 59 for the
  text tier (Sept 22).
- #26 resolver: intent-derived tiers only for hint-less calls, explicit hints
  that miss return null (a missing element could resolve to the Login button
  and pass), message intents never guess a control, recovery accepts named
  matches only (Sept 22).
- #27 repair budget = max(reserve, ceiling minus spend), funded cheapest
  first; skip_scenario mid-scenario discards the open trace; a name may sit
  in one funnel bucket only, loud otherwise (Sept 23).
- #28 Critic sees the record: toHaveURL carries a timeout end to end,
  describeStep renders every timeout and <generated:*> values, events.jsonl
  keeps full get_dom results (Sept 24).
- #29 planner page-fit: a scenario naming a control the snapshot does not
  show is dropped before the Explorer (navigation scenarios exempt from
  value kinds, page-wide evidence from the full document), cross-page dedup,
  not-reachable coverage reason (Sept 24).
- #30 emitter: page-object fields keyed by locator identity, never intent
  (79 intent-less calls had collapsed into one field per feature);
  multi-page features get per-test gotos; the emitted-spec check stage runs
  the framework once before the zip, drops a test that fails twice into
  emitted_failed, stays inconclusive when the site is down, passes recorded
  credentials to the child env in memory only (Sept 30).
- #31 gate and cost: toHaveURL after an action floored by RULE 2; count and
  absence probes fail fast at LIVE_PROBE_TIMEOUT_MS; per-host memory of the
  test-id attribute, printed first by get_dom; RULE 3, 6 and the new RULE 8
  (price in a locator name) refused at the tool call; page-fit strips the
  page's own form-name phrase (Oct 1).
- #32 planning and critic: requirements map cached by SRS content hash
  (--rebuild-srs-map); contradiction scenarios dropped at plan time with
  one capped retry per uncited rule; the Critic's second pass judges the
  first pass's required fixes (all applied keeps with notes, one unapplied
  drops, no judgement returned keeps unjudged with a warning); replay
  membership comes from repairOutcome, never the raw second vote; 23
  unchecked end_scenario results across six smokes now checked (Oct 1).

## Toolshop runs, same site, same SRS, same $6 ceiling

| Run | Date | After | Pages | Planned | Explored | Shipped | Cost | End | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| 1 ec8eff | Sept 15 | baseline | 3 | 10 | 6 | 0 | $6.08 | stopped at ceiling | docs/audit/run-ec8eff-diagnosis.md |
| 2 f3b41e | Sept 18 | #18 to #20 | 7 | 18 | 15 | 1 | $4.97 | completed | docs/audit/run-f3b41e-diagnosis.md |
| 3 5e4394 | Sept 18 | #21, #22 | 7 | 20 | 16 | 1 | $6.09 | completed | docs/audit/run-5e4394-diagnosis.md |
| 4 591732 | Sept 22 | #23 to #26 | 7 | 20 | 13 | 5 | $4.57 | completed | docs/audit/run-591732-diagnosis.md |
| 5 51d535 | Sept 24 | #25 to #29 | 8 | 17 | 13 | 5 | $6.03 | stopped at ceiling, framework written | docs/audit/run-51d535-diagnosis.md |
| 6 44cb3d | Oct 1 | #30 to #32 | 8 | 20 | 16 | 12 | $6.09 | completed, repair stopped at its budget | docs/audit/run-44cb3d-diagnosis.md |
| 7 59540f | Oct 23 | #42 to #50 | 3 (sitemap) | 9 | 8 | 5 | $2.01 | completed | docs/audit/run-59540f-diagnosis.md |

Run 4 verdict: hypothesis confirmed (the tool surface was the bottleneck;
zero reworks asked for a missing capability). Framework ran 6 of 6.

Run 5 verdict: bar missed (5 shipped against 8, 4 rules against 7). The
emitted framework failed 3 of 6 on a clean install after every scenario
passed replay and 3x stability: a field-identity defect in the POM emitter,
fixed in #30 with the emitted-spec check stage. The other run 5 findings are
fixed in #31 and #32. The own-account design (finding 8) is the next PR
after the audit report.

Run 6 verdict: bar missed on the rework rate (62.5 percent against under
50; run 5: 69) and met on the other three lines: explorer cost $0.274 per
explored scenario on the main pass ($0.371 including the repair pass), no
rework for a missing URL timeout (the gate floored six at end_scenario), and
the emitted-spec check green for every shipped test, which cannot fail by
construction; the honest measure is 13 of 14, one emitter divergence (an
unwaited count capture) caught and dropped before the zip. 12 shipped, 10 of
14 rules, $6.09, and the zip ran 13 of 13 on a clean install (owner-run).
Two shipped tests carry names that claim more than the recording proves:
the rental-titled test runs on a hand-tools product (D2), and the
wrong-password login test submits a generated non-existent account (D7).
Defects D1 to D9 are in the diagnosis; D1 to D7 are in the backlog below.

Run 6 bar, set before the run: rework rate under 50 percent (run 5: 69),
explorer cost per explored scenario under $0.35 (run 5: $0.40), zero
reworks whose only reason is a missing URL timeout, emitted-spec check
green for every shipped test. Shipped count is reported, not targeted.

Run 3: twelve of fourteen reworks asked for tool capabilities that did not
exist (assert_compare ignored its target hints; numeric relations could not
parse currency; no pattern, toBeChecked or minimum-count assertions).

saucedemo proof runs: Sept 14 $0.6187 4 shipped; Sept 17 after #18 $0.4536
3 shipped, 95.8 percent cache; Sept 17 after #19 $0.3437 4 shipped, 0 rework.
Oct 1 after #32 $0.5961, 4 shipped, 2 reworks repaired, emitted 6 of 6 with
credentials. That run was the regression check for #25 to #32.

Live spend on Toolshop to date: $35.84 over seven runs.

## The audit plan

The audit is the five runs, their diagnosis files, and the fixes landed
with an invariant and a lock each. The audit REPORT is docs/audit-2026-09.md,
using the qa-core-heal evaluation report as the template.

- Oct 1 or 2: run 6 (up to $6), then the saucedemo proof run (about $0.50),
  then the run 6 diagnosis and this table via one $0 PR.
- Oct 4: report drafting started (one day late); D8 moved to after the
  report.
- Oct 6: report drafted. Oct 8: reviewed and merged.
- Report sections: scope and method (one site, one SRS, one ceiling, every
  number from a run-report); the runs table and trajectory; engine defects
  the audit found and fixed, each with the run that exposed it, the PR and
  the lock (dead critic gate, false-pass resolver, repair budget cap, funnel
  double count, Critic blind to timeouts and generated values, emitter field
  collapse, gate firing after the spend); site findings with their
  classification; what the engine does today and what it does not (shared
  account dependency, state-dependent pages, dropped traces not on the
  report, rework rate); cost per run and per shipped test; open items ranked.
- After the report, in order: own-account design (brief first), PR F
  dashboard design pass, demo video, launch post.

## Audit backlog (open)

- D1 (run 6): FIXED (PR #35, Oct 2): the emitted count capture reads once
  with no wait, unlike replay; a too-early 0 passes a greater compare for
  the wrong reason. docs/audit/run-44cb3d-diagnosis.md. Locked by
  smoke-emitted-run and smoke-capture-compare.
- D2 (run 6): FIXED (PR #34, Oct 2): a planned page abandoned by the
  Explorer (empty /rentals) shipped a hand-tools test under the rental name
  with no finding recorded. docs/audit/run-44cb3d-diagnosis.md. Locked by
  smoke-planned-page; whether the Explorer records the empty page as a
  finding is untested live.
- D3 (run 6): ADDRESSED (PR #42, engine/rework-rate, Oct 6, not merged):
  two unjustified Critic reworks (a success message the site never shows; a
  timeout already at the gate floor) and cart verdicts that took a badge
  element count for the badge's value. docs/audit/run-44cb3d-diagnosis.md.
  Record-time fixes: a literal count on a counter refused (RULE 7) and a
  count capture on one refused (RULE 9); a well-formed email generated in a
  negative or edge creation flow; the RULE 2 floor after an action raised to
  10000 ms; doctrine rules 9 (success signals from the recordings) and 10 (a
  timeout at the floor is no rework reason). Locked by smoke-gate,
  smoke-tools, smoke-unique-data, smoke-compare-poll, smoke-critic-parse and
  smoke-emitted-run; scripts/rework-shapes.ts maps runs 5 and 6. The honest
  count: run 6 had 10 first-pass reworks in 10 scenarios; the new rules
  apply to 9; the eco-filter rework (it asked for an extra assertion) is not
  addressed by #42. Second commit (Oct 7): RULE 9 judges the selector only
  (a list count whose intent says "count" is the working filter shape); with
  a plan in the run, a recorded name that claims no planned name keeps the
  email literal and logs one line; a negative that names the email keeps it
  literal; rework-shapes lists the passed scenarios the new rules would
  refuse or rewrite (none in runs 5 and 6). The rework rate itself is
  unmeasured until the next live run.
- D4 (run 6): FIXED (PR #36, Oct 2): a repair stopped by its budget is
  filed as a critic drop with the first-pass reasons.
  docs/audit/run-44cb3d-diagnosis.md. Locked by smoke-repair-pass and
  smoke-reconcile.
- D5 (run 6): FIXED (PR #36, Oct 2): the printed cost total excludes the
  requirements map cost on both sites. docs/audit/run-44cb3d-diagnosis.md.
  Locked by smoke-srs-parse and smoke-index. Runs 1 to 6 predate the field;
  their totals exclude the map build cost.
- D6 (run 6): FIXED (PR #36, Oct 2): the findings key is omitted when empty
  (top level absent, reconciliation.findings []).
  docs/audit/run-44cb3d-diagnosis.md. Locked by smoke-reconcile.
- D7 (run 6): fake-credential substitution on both sites: saucedemo's
  wrong-password username was rewritten on the first fill and not the
  second; Toolshop's wrong-password test submits a generated non-existent
  account under a name that claims a wrong password for a known one, and
  Toolshop R11 (duplicate email) cannot be automated; belongs to the
  own-account design. docs/audit/run-44cb3d-diagnosis.md.
- D8 (run 6): ADDRESSED (PR #48, engine/console-honesty, Oct 14, not
  merged): console contradictions (two rule-coverage totals, a stale
  first-pass Critic paragraph, the repair budget printed as a ceiling stop,
  a wrong no-discovered-page warning, the repair decision line cut by the
  240-character cap). docs/audit/run-44cb3d-diagnosis.md section 3, D8.
  Invariant 72; locked by smoke-console-honesty and smoke-repair-block.
- D1 (run 7): ADDRESSED (PR #53, engine/discovery-seed, not merged).
  Discovery returned at the sitemap rung when it yielded any page;
  Toolshop's new sitemap lists 3 URLs, so the crawl never ran and no
  category or product page was planned. Now the sitemap is a seed: unless
  every feature is carried by a sitemap page by page evidence, the crawl
  runs and merges ("sitemap+crawl"), with one warning line naming the case
  (invariant 75). The site's robots.txt still keeps /auth and /checkout out
  of every remote rung (D7a, reported now, not changed).
  docs/audit/run-59540f-diagnosis.md, D1. Locked by smoke-discovery-ladder.
- D7a (run 7), reporting: ADDRESSED (PR #53, engine/discovery-seed, not
  merged). Robots skips were silent. Now every skipped path and its rule is
  on discovery.robotsSkipped (report and discovery.json), a feature only a
  skipped path carries prints one line and one warning, and its uncited
  rules read robots-disallowed in coverage, the rule table and the run page
  (schema v8). Decided Oct 23: no --urls past robots.txt on the public
  site; run 8 moves to a self-hosted Toolshop. Locked by
  smoke-discovery-ladder, smoke-index, smoke-projects, smoke-run-detail and
  smoke-console-log.
- D7e (run 7): ADDRESSED (PR #53, engine/discovery-seed, not merged). The
  per-page cap cut R3's only citer silently. Now a rule's only citer is
  kept first, the line names every cut with its rules, the cuts are on the
  report as planTrimmed, and a rule only a cut scenario cited reads
  cut-by-page-cap. Locked by smoke-page-cap.
- D7i (run 7): ADDRESSED (PR #53, engine/discovery-seed, not merged). The
  run folder had no console.log. Now the CLI writes every console line to
  console.log in the run folder on every end, credential-masked, never in
  the zip. Gateway and MCP runs still keep events.jsonl only. Locked by
  smoke-console-log.
- D2 (run 7): OPEN. The state probe looks for a trigger only on candidate
  pages and never hops from a listing into an item, so "Add to cart" on a
  product page is never found from /. docs/audit/run-59540f-diagnosis.md,
  D2.
- D3 (run 7): ADDRESSED (PR #54, engine/critic-compare, not merged).
  Critic errors: a compare after select_option called vacuous, "greater"
  read in the wrong direction, the capture's locator read as the polling
  source, and a "$" demanded on a price the page renders as "14.15"; both
  catalogue scenarios dropped on fixes that could not be applied. Now the
  compare line names only the element re-read and the relation in words
  ("re-read X must be GREATER THAN captured cap_y"), and the Critic prompt
  says to look for the action between capture and compare, to read the
  relation as re-read RELATION captured, and never to require a format a
  recorded value contradicts (invariant 76). Locked by smoke-critic-parse.
  scripts/critic-input.ts prints any run's Critic input at $0.
  docs/audit/run-59540f-diagnosis.md, D3.
- D4 (run 7): ADDRESSED (PR #54, engine/critic-compare, not merged).
  assert_compare equal compared raw text: "$14.15" against "14.15" failed
  while greater and less parse the number, so R5's "same price" could not
  be recorded. Now equal, unchanged and changed compare two plain numbers
  by value through one sameValue, in the tool, replay and both emitters
  (helpers/same-value in the framework); other text compares exactly
  (invariant 76). Locked by smoke-capture-compare and smoke-emitted-run.
  docs/audit/run-59540f-diagnosis.md, D4.
- D7d (run 7): ADDRESSED (PR #54, engine/critic-compare, not merged).
  The Critic's flagging rule 2 reworked any check of something already true
  before the action, while doctrine rule 8 allows it as a secondary sanity
  check; three of the four first-pass reworks hit such a check. Now one
  rule, word for word in the Critic prompt and the repair review: such a
  check is a rework reason only as the primary outcome assertion, never a
  required fix beside a real one (invariant 76). This changes what counts
  as a rework; run 8's bar is written after this merges. Locked by
  smoke-prompt-agreement. docs/audit/run-59540f-diagnosis.md, D7d.
- D7g (run 7): ADDRESSED (PR #54, engine/critic-compare, not merged).
  The Explorer tried both compare directions because the assert_compare
  tool description never said which side is which. Now it states "re-read
  RELATION captured", greater as re-read > captured and less as re-read <
  captured (invariant 76). Locked by smoke-prompt-agreement.
  docs/audit/run-59540f-diagnosis.md, D7g.
- D5 (run 7): ADDRESSED (PR #NN, engine/emitter-assertions, not merged).
  A shipped test name claims "only matching" while the recording checks
  the first card only; the Critic passed it. Now the assert tool records
  allItemsMatch: the items that do not match the value the scenario typed
  number 0 (filter hasNotText, count 0), then at least 1 item, in the tool,
  replay and both emitters; RULE 7 refuses a pattern the scenario did not
  type; doctrine rule 11 and the Critic's flagging rule 6 rework a name
  with a universal word (only, all, every, each, none, no) that has neither
  an all-items nor a count-0 assertion (invariant 77). Locked by
  smoke-all-items, smoke-critic-parse and smoke-prompt-agreement. The new
  Critic rule can raise the first-pass rework count; run 8's bar is written
  with it in place. docs/audit/run-59540f-diagnosis.md, D5.
- D7b (run 7): ADDRESSED (PR #NN, engine/emitter-assertions, not merged).
  The R14 data case asserted toContainText(c.errorText ?? '') with no
  errorText (its pattern assertion was dropped) and used the happy case's
  subject. Now a data error case carries every check its own recording made
  on its own error element (visibility, a literal or a pattern with flags)
  and every select value; a case that cannot be carried is left out with
  one line and ships as its own test; no emitter writes an empty text
  expectation (invariant 77). Locked by smoke-dataset-errors,
  smoke-datasets, smoke-param-emit and smoke-emitted-run.
- D7c (run 7): ADDRESSED (PR #NN, engine/emitter-assertions, not merged).
  A count-0 check on getByTestId("contact-submit") matched nothing on a
  data-test site and could never fail. Now an absence on a testid hint
  reads the host's test-id attribute (css [data-test=...]), keeps testid
  on a data-testid host, and is refused before any get_dom (invariant 77).
  Locked by smoke-absence-testid.
- D7h (run 7): ADDRESSED (PR #NN, engine/emitter-assertions, not merged).
  A text probe given 15000 waited 60 s. Now toHaveText and toContainText
  probes wait the model's timeout below the ceiling, the ceiling without
  one (invariant 77). Locked by smoke-compare-poll.
- D6 (run 7): reporting part ADDRESSED (PR #53, engine/discovery-seed, not
  merged), cause still OPEN. The contact first-name negative dropped at
  replay: the page showed the success message in a fresh context after the
  Explorer saw the error twice. Now the drop reason appends what the page
  showed ("; the page showed: ..."), so it no longer reads as a bare
  locator timeout (smoke-reconcile). Why the site accepted the submit is
  still unknown; reproduced on the self-hosted Toolshop before run 8
  (advisor decision Oct 23). docs/audit/run-59540f-diagnosis.md, D6.
- OPEN: the global 20-scenario plan cap in planAcrossPages cuts without
  naming what it cut (found in PR #53).
- OPEN: a run that planned nothing deletes its folder and its console.log;
  the run that most needs its console keeps none (found in the PR #53
  review).
- OPEN: gateway and MCP runs keep no console copy; their prepare notes and
  end summary go only to the client (found in PR #53).
- OPEN: sameValue reads "007" and "7" as the same value (leading zeros);
  kept on purpose, revisit if an id compare needs it (PR #54 review).
- ADDRESSED (PR #NN, engine/emitter-assertions, not merged): The repair
  review has no rule for a listed fix the page cannot satisfy (run 7 D3 b);
  only the first-pass prompt does (PR #54). Now a fix a passing assertion in
  the repair recording contradicts is judged applied, "not satisfiable: the
  page renders ..." (invariant 77). Locked by smoke-prompt-agreement.
- OPEN (found in PR #NN): pom.ts names a synthesized fill-and-click method
  after the click's first intent word; when that equals a page-object field
  name ("search submit button" next to the "search input" field), the field
  shadows the method and the spec throws "cataloguePage.search is not a
  function".
- OPEN (found in PR #NN): pom.ts, in a feature whose scenarios start on
  different URLs, emits the synthesized action method call before the
  test's own page.goto, so the method acts on a blank page.
- Test credentials: superseded Oct 8 by phase item 3 (client-supplied
  account through .env).
- A login-preflight stop lists as Empty run on the dashboard; the report
  carries stopped.kind login_preflight (Runs page PR).
- Run Detail keys rows by exact name; a replay or stability drop whose
  recorded name differs from the plan name shows as two rows (found in the
  #43 review).
- ADDRESSED (PR #47, merged Oct 14): Design
  item, state-dependent page: on practicesoftwaretesting.com the cart link
  renders only after an add-to-cart, so no crawl of a fresh session finds
  it. Now the state probe reveals such a page by the action, plans its
  rules from the post-action snapshot and refuses a navigate to it
  (invariant 71, click action). Untested live until the confirmation run.
- Login action for authenticated pages (brief section 7), after the
  confirmation run.
- ADDRESSED (engine/dropped-traces, Oct 8, not merged): Dropped scenarios
  keep only their name and verdict on the run-report; their recorded steps
  are lost, so a drop cannot be diagnosed from the artefact alone. Now
  run-report.droppedTraces keeps every drop's trace, credential-redacted in
  every copy (invariant 69). Locked by smoke-dropped-traces.
- ADDRESSED (engine/dropped-traces, Oct 8, not merged):
  reconciliation.dropped carries the Critic's echo of a scenario name (one
  run 3 drop lost its quotation marks); identity fields must carry the
  plan's canonical name (standing rule 1). Now every drop and emitted_failed
  entry is filed under the planned name with recordedName kept, and a drop
  with no planned match is a loud line; scripts/dropped-traces-check.ts maps
  27 of 27 drops of runs 3, 5 and 6.
- ADDRESSED (PR #48, engine/console-honesty, Oct 14, not merged):
  runtime passes the critique client seam through, so the repair block can
  be driven with a fixture Critic (found in #32). Now ExploreOptions.critique
  (and explorerClient) reach the first review and the repair review;
  smoke-repair-block drives the whole block at $0.
- ADDRESSED (PR #49, engine/small-items, Oct 15, not merged): testid hints
  recorded as css because the site uses data-test; emit getByTestId with
  testIdAttribute in the config instead. Now an all-data-test recording
  (no step at level testid) emits getByTestId and the config line; mixed
  attributes emit as before; a prefix selector stays css (invariant 73).
- ADDRESSED (PR #49, engine/small-items, Oct 15, not merged): Explorer
  start-up waste: an orientation load of the entry page before the first
  planned scenario although the plan names each page. Now the first message
  of a multi-page plan starts at scenario 1, and report.orientationCalls
  plus one console line make the waste measurable (invariant 73). Untested
  live until the confirmation run.
- ADDRESSED (PR #53, engine/discovery-seed, not merged): the dashboard's
  rule table showed not-reachable and not-revealed as not planned (no index
  column). Now the index keeps the precise reason and detail (schema v8)
  and the table shows them. Locked by smoke-projects.
- Enumerate every cap, truncation, filter, and catch in the pipeline; each is
  made loud or proven harmless (eight silent-failure bugs found since Sept).
- Doctrine decision on absence-as-count-zero assertions.
- SIGINT listener leak in the long-lived gateway process.
- CODEBASE.md is stale and lists missing doc files.
- The 0.3.5 packaging fixes for qa-core-heal (exports, peer deps, engines).
- run-report records its own budgets (step budget, explorer sub-ceiling,
  repair-pass budget, per-page planner cost) so the dashboard can show spend
  against limit.
- runtime emits discovery events (rung, page count, filter result) so the
  live Discovery panel has numbers.
- The smoke suite takes about 10 minutes because four smokes wait out a 60s
  timeout each.
- Authenticated pages beyond the login form (an account page, checkout,
  order history): the Planner has no "needs login" tag, so such a scenario
  logs in through its own recorded steps. Owner decision A (Oct 9): no new
  tag in PR #45; design it with the action-first discovery rung (phase
  item 4).
- ADDRESSED (PR #49, engine/small-items, Oct 15, not merged): RULE 7
  refused the "Products" page title (.title) as catalogue data, a heading
  false positive (phase item 6, D9). Now the strong catalogue marker is read
  off the locator only and a heading locator is exempt unless the locator
  carries it (invariant 73).
- ADDRESSED (PR #49, engine/small-items, Oct 15, not merged): the other D9
  items (run 6): cross-page dedup missed two reworded duplicate-email
  negatives (now one scenario at a 0.75 name overlap with the same feature,
  category and rule ids); a toHaveAttribute probe waited 60 s (now the 10 s
  live cap); the total ran over the ceiling with nothing on the cost line
  to say why (now the line names the overrun, the terms outside the
  explorer budget and the closeout grace). Invariant 73.
- A product name literal on css .inventory_item_name (saucedemo) is allowed
  by RULE 7 today: the selector carries no catalogue marker (found in
  PR #49).
- Known gap: a product clicked by a nameless css, then another click (add
  to cart), then a literal product name on the heading is allowed; (b) only
  reads the most recent click.
- Whole-run hard ceiling (planner, map and Critic inside the stated
  ceiling), after the confirmation run.
- Rule citation not exercised by the recording (run 6: the eco-friendly
  filter scenario cited R3, the category filter). Deferred until after the
  confirmation run, because the fix changes the Critic's duties and would
  confound the rework rate measurement. Checked by hand when grading run 7.
- ADDRESSED (PR #48, engine/console-honesty, Oct 14, not merged): The
  console printed 'Feature "login" has 4 rules and no discovered page' on
  saucedemo, then 4 of 4 covered. Now the line prints after planning and
  only when the plan does not carry the feature either.
- ADDRESSED (PR #48, engine/console-honesty, Oct 14, not merged): The
  skip reason "test credentials not provided" is wrong when credentials
  were set but no login page was found. Now "no login page found; test
  credentials were set", at plan time and at a marked fill.
- ADDRESSED (PR #48, engine/console-honesty, Oct 14, not merged): The
  console line "Run the framework: cd <run dir> && npm install" is
  misleading: the run folder holds only the zip. Now the steps unzip the
  real zip and cd into the extracted folder first.
- CI only type-checks; the smoke suite in CI is backlog.
- Run 7c78fc (saucedemo, Oct 1): its zip holds a playwright/.auth session
  file from the public demo account, made before the PR #45 guard. Keep the
  folder (the audit appendix references it); never share that zip.
- CLAUDE.md "Quick orientation for new conversations" section is stale
  (says no .git, 7 smokes, an old repo URL).
- recheck-run.ts spends one wrong-password submit against the account's cap
  per recheck.
- ADDRESSED (PR #48, engine/console-honesty, Oct 14, not merged): Run
  5 R9: ruleCoverage reads planned-but-dropped with no detail while the
  scenario is in reconciliation.incomplete (cost ceiling mid-scenario); a
  ceiling cut must never read as a drop (standing rule 2). Now
  planned-not-explored with "cost ceiling hit mid-scenario".
- ADDRESSED (PR #48, engine/console-honesty, Oct 14, not merged): The
  page-fit rejection line carries no rule ids, so a rejected scenario's
  citations cannot be traced from the artifact. Now it ends with
  "(cited R4, R5)" or "(cited no rule)".
- RULE 7 false positives (PR #49 review): click role link Contact then
  heading Contact is refused by (a); a clicked css with li or row words is
  read as a catalogue item by (b). The fix needs the page URL after a click
  (urlAfter on click steps). After the confirmation run.
- Haiku 5.5 is priced by prompt size; add it to pricing.ts with its tiers
  before any stage uses it.
- Exemption for signed-out gated-URL negatives (from PR #46): not planned
  today; revisit after the confirmation run if a client needs it.

## Then: go to market

Offer: "QA Coverage Sprint", fixed price, one week: staging URL + SRS in,
verified Playwright framework + rule-coverage report + findings report out.
Channels: Upwork and LinkedIn first. Proof asset: one recorded end-to-end demo.
Pitching starts the day the audit report exists.

## Standing decisions

- Findings are product bugs the agent discovered, never test failures. Violet
  in the UI, labeled "Product behavior to review".
- Legacy (pre-v2) runs show explored counts, never shipped counts.
- Browser-side legacy history (localStorage) is not imported. June dev noise.
- Old single-file UI is deleted (PR E2).
- Telegram control, if wanted, is a native surface in qa-core after the audit,
  not through OpenClaw. QA-Core does not depend on OpenClaw.
- Merges are always a human action; Claude Code opens PRs and never merges.
- A run bar is written here before the run and graded afterwards; a missed
  bar is recorded as missed, never re-run to improve the number.
- The audit report is written after run 6 with no run after it.

## Standing engineering rules (earned the hard way)

1. Never match model-echoed text by exact string; normalize and claim.
2. Never let a failure path return a value that looks legitimate (empty
   array, zero count, dropped line). Loud or proven harmless.
3. Every number on any surface comes from the run-report or events; no UI-side
   arithmetic.
4. Compiled is not executed: emitted frameworks get run, not just type-checked.
   Since #30 the pipeline runs the emitted framework itself.
5. Every behavioral fix lands with an invariant in CLAUDE.md and a smoke lock.
6. Any change under src/server/db/ is verified against a copy of the real
   data/qa-core.sqlite, not only a fixture. The v4 migration passed its
   fixture and crashed on the real file.
7. A smoke checks the result of every tool call it drives. 23 end_scenario
   results across six smokes were discarded until #32; a gate rejection
   passed silently inside a lock.
8. A lock whose assertions change is explained in the PR summary (which pin,
   what it said, why the merged invariant replaced it), never loosened in
   silence.

## Environment and cost

- Anthropic Console: separate workspaces for qa-core and openclaw, each
  capped. Claude Code runs on the Max subscription, not the API.
- OpenClaw on the VPS is on Sonnet, Telegram bound to agent main, unrelated to
  running QA-Core.
- Typical costs: single-page run about $0.50 to $1; multi-page discovery run
  $6 ceiling. Verify at $0 whenever possible (smokes, fixtures, transcribe,
  history views).
- Shell note: a grep pattern containing ! goes in single quotes (zsh history
  expansion); prefix git diff and git log with --no-pager.