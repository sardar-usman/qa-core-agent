# QA-Core STATE

Updated: 2026-10-01. Update this file at the end of every working day.
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
from scripts/, 86 smokes; QA_CORE_LIVE_SMOKES=1 adds the two live ones).
Before any live run: npx tsx scripts/preflight-site.ts <url> --login.

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

Live spend on Toolshop to date: $33.83 over six runs.

## The audit plan

The audit is the five runs, their diagnosis files, and the fixes landed
with an invariant and a lock each. The audit REPORT is docs/audit-2026-09.md,
using the qa-core-heal evaluation report as the template.

- Oct 1 or 2: run 6 (up to $6), then the saucedemo proof run (about $0.50),
  then the run 6 diagnosis and this table via one $0 PR.
- Oct 3: report writing starts, whatever run 6 says. No run 7 before the
  report. A missed bar is reported as missed.
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

- D1 (run 6): the emitted count capture reads once with no wait, unlike
  replay; a too-early 0 passes a greater compare for the wrong reason.
  docs/audit/run-44cb3d-diagnosis.md.
- D2 (run 6): a planned page abandoned by the Explorer (empty /rentals)
  shipped a hand-tools test under the rental name with no finding recorded.
  docs/audit/run-44cb3d-diagnosis.md.
- D3 (run 6): two unjustified Critic reworks (a success message the site
  never shows; a timeout already at the gate floor) and cart verdicts that
  took a badge element count for the badge's value.
  docs/audit/run-44cb3d-diagnosis.md.
- D4 (run 6): a repair stopped by its budget is filed as a critic drop with
  the first-pass reasons. docs/audit/run-44cb3d-diagnosis.md.
- D5 (run 6): the printed cost total excludes the requirements map cost on
  both sites. docs/audit/run-44cb3d-diagnosis.md.
- D6 (run 6): the findings key is omitted when empty (top level absent,
  reconciliation.findings []). docs/audit/run-44cb3d-diagnosis.md.
- D7 (run 6): fake-credential substitution on both sites: saucedemo's
  wrong-password username was rewritten on the first fill and not the
  second; Toolshop's wrong-password test submits a generated non-existent
  account under a name that claims a wrong password for a known one, and
  Toolshop R11 (duplicate email) cannot be automated; belongs to the
  own-account design. docs/audit/run-44cb3d-diagnosis.md.
- Own account (run 5 finding 8): the happy registration scenario's generated
  account becomes the run's login and the duplicate-email seed, so no run
  depends on the shared demo account. Run 5's happy login failed with no
  visible message while a preflight passed before and after. Brief first,
  then PR, after the report.
- Design item, state-dependent page: on practicesoftwaretesting.com the cart
  link renders only after an add-to-cart, so no crawl of a fresh session
  finds it and the cart rules report not-reachable (run 5 reached them by
  action). Needs an action-first rung: plan the feature on the page that
  starts the action and record the reached page as reached-by-action, never
  by URL. Crawl caps and politeness rules stay.
- Dropped scenarios keep only their name and verdict on the run-report;
  their recorded steps are lost, so a drop cannot be diagnosed from the
  artefact alone. Decide whether to keep dropped traces (redacted).
- reconciliation.dropped carries the Critic's echo of a scenario name (one
  run 3 drop lost its quotation marks); identity fields must carry the
  plan's canonical name (standing rule 1).
- runtime passes the critique client seam through, so the repair block can
  be driven with a fixture Critic (found in #32; today the seam is
  unreachable from the pipeline and only repairOutcome is locked).
- testid hints recorded as css because the site uses data-test; emit
  getByTestId with testIdAttribute in the config instead.
- Explorer start-up waste: an orientation load of the entry page before the
  first planned scenario although the plan names each page.
- The dashboard's rule table shows not-reachable as not planned (no index
  column); the report and console carry the precise reason.
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