# QA-Core STATE

Updated: 2026-09-19. Update this file at the end of every working day.
It is the first thing to read in any new thread.

## What QA-Core is

An autonomous QA agent (repo sardar-usman/qa-core-agent, main branch is truth).
Pipeline: Planner (Haiku) plans scenarios, Explorer (Opus 4.7) drives a real
browser and records steps, Critic (Sonnet 4.6) grades every scenario pass /
rework / reject with a one-pass repair for rework, Replay re-runs everything
headlessly, Stability re-runs survivors 3x, then the transcriber emits a
client-ready Playwright framework (POM, datasets, storageState auth, CI-ready)
as a zip. Healing of broken specs is delegated to the separate qa-core-heal npm
package (own repo, own thread).

Surfaces: CLI (npm run explore / transcribe / heal), gateway with a dashboard
served at http://127.0.0.1:18789/ (legacy UI at /legacy), MCP server. All three
build runs through src/agent/explore-request.ts.

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

## Dashboard v2 (in progress): plan in docs/dashboard-v2-plan.md

Schedule: two focused days, then the audit.
- PR A foundation (PR #10): MERGED Sept 14 (final commit dd1f0db). Per-run
  output layout output/<host>/<run-id>/, SQLite index, token-guarded REST,
  Projects page and Runs table. Legacy gateway records imported as "summary
  only (pre-v2)" rows (30 rows, 8 hosts), showing explored counts only;
  missing counts render n/a, never 0. Unset environment renders no badge.
- PR B run detail (PR #11): MERGED Sept 14 (merge f7a001c). Scenarios
  table, findings, artifacts, events status (absent vs empty), tolerant
  verdict matching via assignVerdicts, four-term cost total (usd + planner
  + critic + stabilizer), schema v4 (environment nullable, no default).
- PR B2 stage view (PR #12): MERGED Sept 14. Six panels from run-report
  only; live events land in PR C.
- PR C terminal + live run view (PR #13): MERGED Sept 14. Single-terminal
  composer through explore-request.ts, SRS attach into the run folder,
  live stage view converging on the history view via run-report. First
  dashboard-started run: saucedemo SRS, 4 planned, 4 shipped, 4 of 4
  rules, $0.6187. Parallel-run plumbing deferred to after the audit.
- PR D projects/findings/coverage/trends (PR #14): MERGED Sept 15.
  Project page, findings triage (open / triaged / fixed / wont-fix,
  persists across reindex), coverage across runs, trends from index rows,
  legacy-only cards show n/a, schema v5 (finding_runs).
- PR E1 settings/resume/transcribe/projects/SRS (PR #15): MERGED Sept 15.
  Settings page (defaults from process, per-tab session overrides), Resume
  and Regenerate on Run Detail, project create/edit, project-level SRS
  with versioning under output/<slug>/srs/, MCP srsText into the run
  folder, observed text without inference. Fix found in verification:
  transcribe wrote into the run folder and zipped it; now writes only the
  zip. Also found: every explore zip since the per-run layout was rooted
  at the run id, not <brand>-automation-framework/; fixed.
- PR E2 retire legacy UI + polish (PR #16): MERGED Sept 15. Single-file
  UI and /legacy route deleted; legacy smokes ported (download, brand
  label, per-site math) or retired with reasons; composer three tiers with
  real placeholders and a preview showing the exact command; trends
  anchored at zero; Regenerate confirmation; Unassigned wording.
- PR F design pass: after the $6 run, before the audit. Brief first at
  docs/dashboard-design.md, then page by page, numbers untouched.
- Dashboard v2 code complete as of Sept 15. Next: run 4, then STATE table
  update, then PR F design pass (brief first at docs/dashboard-design.md),
  then the audit write-up docs/audit-2026-09.md, then the demo video and
  the launch post.
- Fix: stopped runs keep run-meta, SRS copy, repair events (PR #17):
  MERGED Sept 16. run-meta written at start and every end; no
  hold-and-restore, run files are never rewritten; runs.source nullable
  (schema v6), never defaulted; repair pass emits events.
- Audit fix PRs, all MERGED: #18 cache history (Sept 17), #19 critic sees
  selectors + shared doctrine + lockout (Sept 17), #20 audit remainder
  (Sept 18), #21 assertion gate: RULE 7 catalogue literals, timeout cap,
  Critic sized to scenario count with one retry, fake credentials at the
  fill (Sept 18), #22 planning and discovery: page feature tags, unique
  names, anchor baseline (Sept 18), #23 tool surface: cross-element
  compares, currency parsing, pattern and toBeChecked assertions, minimum
  counts, circular compares refused, smoke-emitted-run executes the
  emitted framework in TS and JS (Sept 19), #24 plan scope: one plan per
  path template, rule-content feature matching, repair pass funds only
  what the reserve covers (Sept 19).

Cut line if the schedule slips: the Terminals page cannot move after the
audit, it is the only way to start a run from the new dashboard and the
demo needs it. If PR C runs long, ship a single-terminal composer in PR C
and move the parallel-run plumbing (RunSettings, registry, concurrent
terminals) to after the audit.

Toolshop runs, same site, same SRS, same $6 ceiling:

| Run | Date | After | Pages | Planned | Explored | Shipped | Cost | End | Diagnosis |
|---|---|---|---|---|---|---|---|---|---|
| 1 ec8eff | Sept 15 | baseline | 3 | 10 | 6 | 0 | $6.08 | stopped at ceiling | docs/audit/run-ec8eff-diagnosis.md |
| 2 f3b41e | Sept 18 | #18 to #20 | 7 | 18 | 15 | 1 | $4.97 | completed | docs/audit/run-f3b41e-diagnosis.md |
| 3 5e4394 | Sept 18 | #21, #22 | 7 | 20 | 16 | 1 | $6.09 | completed | docs/audit/run-5e4394-diagnosis.md |
| 4 | NEXT | #23, #24 | | | | | | same command | first run where the tools can do what the doctrine asks |

Run 3: twelve of fourteen reworks asked for tool capabilities that did not
exist (assert_compare ignored its target hints; numeric relations could not
parse currency; no pattern, toBeChecked or minimum-count assertions).

saucedemo proof runs: Sept 14 $0.6187 4 shipped; Sept 17 after #18 $0.4536
3 shipped, 95.8 percent cache; Sept 17 after #19 $0.3437 4 shipped, 0 rework.

## After the dashboard: the audit

Structured evaluation of the engine producing an evidence report, using the
qa-core-heal evaluation report as the template. Backlog items for it, gathered
during the maturity pass:

Findings from the three diagnoses are tracked in the diagnosis files; every
item ranked there is either merged (see the PR list above) or listed below.

- Enumerate every cap, truncation, filter, and catch in the pipeline; each is
  made loud or proven harmless (six silent-failure bugs were found this month).
- Doctrine decision on absence-as-count-zero assertions.
- SIGINT listener leak in the long-lived gateway process.
- CODEBASE.md is stale and lists missing doc files.
- The 0.3.5 packaging fixes for qa-core-heal (exports, peer deps, engines).
- run-report records its own budgets (step budget, explorer sub-ceiling,
  repair-pass budget, per-page planner cost) so the dashboard can show spend
  against limit; today those four are not recorded.
- runtime emits discovery events (rung, page count, filter result) so the
  live Discovery panel has numbers.
- shared demo account lockout on practicesoftwaretesting.com: the happy
  login can be locked by outside traffic; decide whether the run registers
  its own account.

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
- Old single-file UI is deleted in PR E.
- Telegram control, if wanted, is a native surface in qa-core after the audit,
  not through OpenClaw. QA-Core does not depend on OpenClaw.
- Merges are always a human action; Claude Code opens PRs and never merges.

## Standing engineering rules (earned the hard way)

1. Never match model-echoed text by exact string; normalize and claim.
2. Never let a failure path return a value that looks legitimate (empty
   array, zero count, dropped line). Loud or proven harmless.
3. Every number on any surface comes from the run-report or events; no UI-side
   arithmetic.
4. Compiled is not executed: emitted frameworks get run, not just type-checked.
5. Every behavioral fix lands with an invariant in CLAUDE.md and a smoke lock.
6. Any change under src/server/db/ is verified against a copy of the real
   data/qa-core.sqlite, not only a fixture. The v4 migration passed its
   fixture and crashed on the real file.

## Environment and cost

- Anthropic Console: separate workspaces for qa-core and openclaw, each
  capped. Claude Code runs on the Max subscription, not the API.
- OpenClaw on the VPS is on Sonnet, Telegram bound to agent main, unrelated to
  running QA-Core.
- Typical costs: single-page run about $0.50 to $1; multi-page discovery run
  $6 ceiling. Verify at $0 whenever possible (smokes, fixtures, transcribe,
  history views).
