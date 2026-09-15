---
name: qa-core-ui-design
description: "Design and visually verify changes to the QA-Core dashboard (dashboard/, a Vite + React + Tailwind app the gateway serves at http://127.0.0.1:18789/). Use for any UI change: layout, colour tokens, a new page or panel, contrast, screenshots."
---

# QA-Core dashboard design

## When to use

- Editing anything under `dashboard/src/` (pages, components, tokens in `dashboard/src/index.css`)
- Checking a page visually in both themes before committing
- Producing screenshots for `docs/ui/`

## Ground rules

- Every number on every page comes from index rows or run-report files; the page computes nothing.
- Semantic tokens only: pass green, rework amber, reject red, findings violet ("Product behavior to review"), neutral grey, one cost accent. Both themes keep at least 4.5:1 contrast.
- Findings are product behavior to review, never test failures and never scenario rows.
- No em dashes, no double hyphens in copy.

## Workflow

1. `npm run dashboard:build` (or `npm run dashboard:dev` for hot reload against a running gateway).
2. Restart the gateway after any server change: `lsof -ti :18789 | xargs kill -9 2>/dev/null; sleep 1; npm run gateway`, then reload the dashboard tab.
3. Look at the page with the Playwright MCP (`mcp__playwright__browser_navigate` to `http://127.0.0.1:18789/<route>#token=<QA_CORE_GATEWAY_TOKEN>`), in dark and light (`localStorage['qa-core.theme']`).
4. Run the page's lock: `smoke-dashboard` (Projects, Runs), `smoke-run-detail` (Run Detail, stage view, contrast), `smoke-terminal` (Terminal, live view), `smoke-projects` (project page, findings, coverage, trends), `smoke-settings`, `smoke-resume-transcribe`. Screenshots land in `docs/ui/` when `QA_CORE_SMOKE_SHOTS=docs/ui` is set on `smoke-run-detail`.

## Invariants that bite

- Dashboard per-site math divides by `runsWithPass`, not total runs (`src/server/runs.ts`, `sitePassRates`). Do not revert.
- A legacy-only project shows n/a, never 0.
- The Summary panel owns the one download button.

## Files

- `dashboard/src/pages/` one file per route; `dashboard/src/components/` shared pieces (StageView, RunsTable, FindingsTable, CoverageTable, Trends).
- `dashboard/src/index.css` the design tokens; `dashboard/tailwind.config.ts` maps them to class names.
