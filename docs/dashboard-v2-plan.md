# QA-Core Dashboard v2: Plan

Status: approved plan, September 2026. Source of truth for the dashboard rebuild.
Lives at docs/dashboard-v2-plan.md. Every Claude Code prompt for this work
references this file by path.

## 1. Why

The current qa-core-ui.html is a chat console with dashboard elements bolted on.
Three columns show the same runs, marketing copy sits next to live status, and the
"terminal" is a chat input. It served development; it cannot serve demos, clients,
or parallel work. The engine (CLI, gateway, run-reports) is mature; the surface is
not.

## 2. Goals

1. A product-shaped app: Projects, Runs, Terminals, Settings. A client or manager
   understands a project's state in ten seconds.
2. Parallel work: many terminals open at once, each one run, each pinned to a
   project.
3. History that scales: a database index over run-reports so projects, trends,
   findings, and costs are fast and searchable.
4. One process to run: the existing gateway serves the built app and a small REST
   API. Remote access unchanged (Tailscale URL).
5. Zero engine drift: the app consumes run-reports and events. It never computes a
   number the engine does not already produce.

## 3. Non-goals (v2)

- Multi-user auth and roles (single-operator app; token auth as today).
- Cloud hosting, Postgres, queues. SQLite and one process.
- Editing plans in the UI (the review CSV workflow stays in the CLI).
- Replacing the CLI. CLI, MCP, and the app all build runs through
  src/agent/explore-request.ts.

## 4. Architecture

```
qa-core-agent/
  src/agent/            engine (unchanged by this plan)
  src/server/           gateway: WebSocket (existing) + REST (new) + static serving (new)
  src/server/db/        SQLite schema, migrations, indexer
  dashboard/            Vite + React + TypeScript + Tailwind + shadcn/ui
  output/               run-reports and frameworks on disk (source of truth, unchanged)
  data/qa-core.sqlite   the index (gitignored)
```

Runtime: `npm run gateway` starts one process that serves the API, the WebSocket
event stream, and the built dashboard at http://127.0.0.1:18789/. Development runs
the Vite dev server against the same gateway.

Principle: files are truth, the database is an index. Deleting the database and
re-indexing output/ must rebuild every page exactly.

## 5. Data model (SQLite via better-sqlite3)

projects
- id, name, base_url, environment (staging | production | other), srs_path,
  created_at, updated_at, default_ceiling_usd, default_features, notes

runs
- id (matches output folder), project_id, started_at, ended_at,
  status (running | completed | stopped | empty | failed),
  source (cli | dashboard | mcp | telegram), url, flags_json,
  planned, generated, dropped, incomplete, findings, skipped,
  stable, flaky, broken, shipped, cost_total, cost_planner, cost_explorer,
  cost_critic, cost_repair, flake_rate, report_path, zip_path, checkpoint_path,
  stopped_reason

findings
- id, run_id, project_id, scenario, expected, observed, page_url,
  status (new | confirmed | not_a_bug | fixed), first_seen_run_id, last_seen_run_id,
  notes

rule_coverage
- run_id, rule_id, rule_text, feature, status (covered | not_planned |
  planned_but_dropped | planned_not_explored), scenarios_json

verdicts
- run_id, scenario, verdict (pass | rework | reject), journey_json, reasons_json

terminals
- id, project_id, run_id (nullable until started), title, created_at, closed_at

Run identity (prerequisite, fixed in PR A): today every run writes to
output/<site>-automation-framework/ and overwrites the previous run's report and
zip. History only survives in the gateway's record list. For the index to be
trustworthy, each run gets its own directory:
output/<project-slug>/<run-id>/ where run-id = <timestamp>-<short-hash>, holding
run-report.json, the zip, checkpoint.json when present, and requirements-map.json
and rule-coverage.json for SRS runs. A `latest` symlink per project points at the
newest completed run so existing habits (open the latest zip) keep working. The
CLI --out flag still overrides. Existing output folders are migrated once into
this layout by the indexer (one run per legacy folder, dated from the report).

Indexer: on gateway start and on every run completion, scan output/ for
run-report.json (and checkpoint.json), upsert runs and derived rows. A run is
assigned to a project by matching base_url host; unmatched runs go to an
"Unassigned" project the user can reassign from. Findings dedupe across runs on
(project_id, normalized scenario name, expected text).

## 6. Gateway changes

1. Parallel runs. Remove process.env mutation for per-run settings; pass an
   explicit RunSettings object (ceiling, reserve, max steps, models) through
   buildExploreOptions into the runtime. A run registry keyed by run id; each
   WebSocket event carries run_id; a terminal subscribes to its run id only.
2. REST endpoints (JSON):
   - GET /api/projects, POST /api/projects, PATCH /api/projects/:id
   - GET /api/projects/:id (summary: counts, trend series, open findings)
   - GET /api/runs?project_id&status&limit, GET /api/runs/:id (index row)
   - GET /api/runs/:id/report (the run-report, path-validated)
   - GET /api/runs/:id/zip (download)
   - POST /api/runs (start: same body shape as the CLI flags, returns run_id)
   - POST /api/runs/:id/resume, POST /api/runs/:id/transcribe
   - GET /api/findings?project_id&status, PATCH /api/findings/:id
   - GET /api/settings, PATCH /api/settings (ceilings, reserve, models; never keys)
   - POST /api/reindex
3. Static serving of dashboard/dist at / with the WebSocket at /ws. The legacy
   qa-core-ui.html stays reachable at /legacy until PR E removes it.
4. Token auth stays as today and also guards every /api route (Authorization
   header); the app stores the token in memory after connect.
5. Project credentials: the app never stores secrets in SQLite. A project holds
   the NAMES of the env vars its runs need (default QA_CORE_TEST_USER and
   QA_CORE_TEST_PASS); values live in the gateway host's .env. The UI shows
   present or missing per name, never values. Same rule for API keys.

## 7. Pages

### Projects (home)
Cards: name, environment, base URL, last run status and date, shipped tests
(lifetime), open findings, spend this month, coverage sparkline (rule coverage
percent per run when SRS runs exist). Empty state explains how to create the first
project. Header: session spend, gateway status, model chips.

### Project detail
Tabs:
- Overview: hero numbers (shipped tests, open findings, spend, last run), run
  timeline, coverage trend, latest framework download.
- Runs: table with status, shipped/planned, cost, flake rate, duration, source;
  row opens Run detail.
- Findings: backlog table with status control; each finding shows expected vs
  observed and which runs saw it.
- Coverage: latest rule coverage with "considered, not automated" reasons; requires
  an SRS on the project.
- Settings: base URL, environment, SRS upload, default features, ceilings,
  credentials status (present or missing; never displayed).

### Run detail
The six-stage view from PR #9, ported as components: stage rail, Discovery, Plan,
Explore (tool calls, cost meter), Review (verdict cards, repair journeys), Verify
(replay, stability), Summary (hero numbers, funnel with zero rows collapsed, cost
split, coverage, findings in violet, one download). Console log collapsible. Works
for live runs (WebSocket) and history (report).

### Terminals
A tab bar of open terminals. Each terminal: project selector, run composer (URL,
features, SRS, --discover, --urls, language, POM, ceiling, reserve, model
overrides) with the equivalent CLI command displayed and copyable, a Start button,
then the live console and a link to the Run detail. Terminals persist across
reloads (table above). Closing a terminal never stops its run; a running run is
shown as a pinned card until it ends.

### Settings
Workspace and key status (present or missing per key name, never values), default
ceilings and reserve, model per stage, output directory, reindex button, theme.

## 8. Design system

Carry over from PR #9: Inter, three sizes two weights, semantic tokens (pass green,
rework amber, reject red, finding violet labeled "Product behavior to review",
neutral grey), one cost accent, 4.5:1 contrast in both themes. shadcn/ui for
tables, tabs, dialogs, forms. No marketing copy inside the app.

## 9. Delivery: two focused days, five PRs

Day 1 (core, must land):

PR A: Foundation
- Per-run output directories and legacy migration (section 5).
- dashboard/ scaffold (Vite, React, TS, Tailwind, shadcn), served by the gateway
  at /, legacy UI at /legacy.
- SQLite schema, migrations, indexer over output/. GET endpoints for projects and
  runs. Projects page and Runs table (read-only). Reindex endpoint and command.
- Acceptance: delete the database, restart, every past run appears under the right
  project; numbers equal the run-reports.

PR B: Run detail
- Port the six-stage view to React components fed by /api/runs/:id/report, live
  events for a running run.
- Acceptance: for the three most recent runs, every number on screen matches the
  report (smoke compares component props to report fields).

Day 2 (product, must land):

PR C: Parallel runs and Terminals
- Gateway: explicit RunSettings, run registry, per-run event channels.
- Terminals page with composer, persistence, live console, multiple concurrent
  runs.
- Acceptance: two runs on two projects started ten seconds apart both complete with
  correct per-run cost and events never cross.

PR D: Projects and Findings
- Project create/edit, SRS upload to the project, findings backlog with status,
  coverage tab, Overview trends.
- Acceptance: a finding seen in two runs is one row with two run references.

Day 3 (if day 2 runs long; otherwise same day):

PR E: Settings, Resume, Transcribe, retire legacy
- Settings page, resume and transcribe from the UI, empty states everywhere, light
  and dark screenshots in docs/ui/, remove qa-core-ui.html and its smokes once the
  new app covers every existing UI smoke assertion.

Each PR: tsc clean, existing suite green, new smokes for the acceptance line,
screenshots for UI PRs, no engine behavior change beyond the output layout in A
and RunSettings plumbing in C. One PR at a time: review, merge, next.

Reality check on the two-day target: it assumes full working days with Claude
Code and reviews turned around within the hour. If PR C slips, D and E move to
day 3; the audit does not start until E is merged.

## 10. Verification budget

Everything above is verifiable at zero API cost from existing run-reports except
PR C's acceptance, which needs two cheap live runs (about one dollar each).

## 11. Sequencing with the audit

Decision (Sept 14): dashboard first, audit after. The audit begins the day PR E
merges. Reason: the audit's baseline runs should be recorded from the final run
layout and gateway, so nothing has to be re-recorded when the app lands. During
these days the engine (src/agent/) is frozen except for the output-layout change
in PR A, which is reviewed as an engine change.
