# QA-Core — File-by-file reference

This document explains the purpose of every file in the repository, organized by directory. For the high-level architecture and product story, see `DOCUMENTATION.md`. This file is intended for engineers who need to understand what each module does and how the pieces fit together.

Generated: 2026-06-10 (v2 hardening pass complete).

---

## Top-level files

| File | Purpose |
|---|---|
| `package.json` | Node project manifest. Defines the four runtime scripts (`explore`, `generate`, `heal`, `eval`) plus the gateway and MCP server entry points. Dependencies pin Anthropic SDK, Playwright, MCP SDK, axe-core, zod, ws, dotenv. |
| `tsconfig.json` | TypeScript compiler config. Targets ESM modules with strict type-checking. Used only for `tsc --noEmit` validation; runtime execution happens through `tsx`. |
| `playwright.config.ts` | Playwright runner config used by `npm test` and by the eval harness when it re-executes generated specs. Defines the chromium project and the auth-setup project. |
| `setup.sh` | One-shot bootstrapping script. Installs deps, runs `playwright install chromium`, and copies `.env.example` to `.env` if it doesn't exist. |
| `.env.example` | Template for the environment variables QA-Core reads at startup. Copy to `.env` and fill in `ANTHROPIC_API_KEY` at minimum. |
| `README.md` | Public-facing README for GitHub visitors. Quick start, commands, model routing, eval table. |

---

## `src/agent/` — the agent core

The 5-stage pipeline lives here. Each stage is one module. Shared types (trace, scenario, run report) sit in `trace.ts`.

| File | Stage | Purpose |
|---|---|---|
| `runtime.ts` | orchestrator | The main `explore()` function. Wires together Planner → Explorer → Critic → Replay → Stability. Holds the system prompt for the Explorer, places the prompt-cache breakpoints on every call (`placeCacheBreakpoints`: system prompt, memory, plan or repair note, latest message; four at most), sums costs including the per-call record and cached share, manages the cost ceiling and its closeout grace (`COST_CLOSEOUT_GRACE_USD`), and writes the final `run-report.json`. Every CLI / gateway / MCP / eval call ultimately invokes this. |
| `explore-request.ts` | surfaces | The one description of an explore run shared by the CLI, the gateway and the MCP server: the `ExploreRequest` type, the flag parser (`parseExploreTokens` / `parseExploreArgv`), the `EXPLORE_FLAGS` registry (every flag with its MCP argument and dashboard reach), the per-run setting allowlist (`RUN_ENV_SETTINGS`, `validateEnvOverride`, `readRunSettings`), resume conflict checks, and `buildExploreOptions`, the single mapping to the runtime's `ExploreOptions`. |
| `output-layout.ts` | output | The per-run layout: `projectSlug` (the URL host, www dropped, dots and other separators as hyphens: `www.saucedemo.com` becomes `saucedemo-com`), `newRunId`, `runDirFor`, the `latest` pointer (`setLatest` / `readLatest` / `finalizeRunDir`), `run-meta.json`, `listRunDirs` (both layouts, never follows the symlink), and the one-time legacy migration (`migrateOutput`, dry-run capable). |
| `framework-dir.ts` | emit | `slimFrameworkDir`: after the zip is written, reduce the framework directory to the report files (`run-report.json`, `requirements-map.json`, `rule-coverage.json`, `checkpoint.json`). Shared by every surface so they leave the same footprint. |
| `planner.ts` | 1 — Planner | Cheap Haiku pre-pass. Loads the target URL, snapshots the visible DOM, asks Haiku to propose 3–6 scenarios formatted as `[category] name — rationale`, and parses the response with a forgiving regex that accepts four known format variants. Output: `PlannedScenario[]`. |
| `tools.ts` | 2 — Explorer | The tool surface Opus uses to drive the browser. Defines `begin_scenario`, `navigate`, `click`, `fill`, `press`, `wait`, `get_dom`, `assert`, `end_scenario`, `finish`. `runTool()` dispatches each call, enforces budgets, and records trace steps. Also installs console + network listeners that attach errors to each scenario. |
| `critic.ts` | 3 — Critic | Single Sonnet call after exploration. Sends the recorded scenario list (names + step kinds + assertion shapes) and asks for a per-scenario verdict: `pass` / `rework` / `reject` plus reasons and required fixes. `parseVerdicts` extracts the verdict array with a bracket-depth scan; `gateByVerdicts` drops non-pass scenarios before Reality-Check. Does NOT drive a browser. |
| `replay.ts` | 4 — Reality-Check | Zero-LLM stage. Re-executes every recorded scenario once in a fresh Playwright context. Drops scenarios that fail the independent re-run. Exports `replayScenarioOnce` and `baseLocator` for reuse by Stability and tools. |
| `stability.ts` | 5 — Stability | Zero-LLM stage. Re-runs each replay-survivor N times (default 3) in fresh contexts. Classifies each as `stable` / `flaky` / `broken` and reports `flake_rate`. Drops anything that pass-then-fails. |
| `selectors.ts` | shared | The selector cascade. `resolve()` tries role → label → testid → CSS, requires `count === 1` to claim a level, and marks ambiguous matches with `ambiguous: true`. `emitLocatorCall()` and `baseLocator` use the recorded `SelectorRecord` to produce a Playwright-flavored call. Also exports `escapeRegex` for safe `toHaveURL` patterns. |
| `trace.ts` | shared | Type definitions only. `TraceStep`, `Scenario`, `SelectorRecord`, `Assertion`, and `RunReport`. The shape every other agent module reads or writes. |
| `transcriber.ts` | spec output | Deterministic (no LLM) conversion of the verified trace into a single inline Playwright spec file. Emits `beforeEach` that clears cookies + storage. Emits `.first()` only when the cascade marked the record ambiguous. |
| `pom.ts` | spec output | Same role as `transcriber.ts`, but produces a Page Object Model framework: `pages/BasePage.ts`, one page class per feature, fields keyed by the locator's identity (never by intent) and named from a unique intent or the locator, action-method synthesis for repeated step sequences, a shared `beforeEach` goto only when every scenario in the feature starts on one URL, dedicated `tests/` directory, and an auto-injected a11y check. The default `/explore` output. |
| `emitted-check.ts` | final stage | The emitted-spec check, run by the CLI and the gateway after `scaffold` and before the zip: the written framework runs once with Playwright (chromium, one worker, JSON reporter) against the live site through a symlink to the agent repo's own `node_modules` (no npm install), a failed test is retried once, a test that fails twice is dropped into the `emitted_failed` reconciliation bucket with its error and the framework is re-scaffolded, and a site that is down leaves the stage inconclusive with the framework whole. `--no-emitted-check` skips it. |
| `generate.ts` | story → spec | The `/generate` command. A single LLM call that converts a user story into a Playwright spec marked UNVERIFIED in the file header. Does not drive a browser. |
| `doctrine.ts` | shared | `ASSERTION_DOCTRINE`, the assertion doctrine shared word for word by the Explorer prompt (`runtime.ts`) and the Critic prompt (`critic.ts`) so the two cannot drift. Locked by `smoke-critic-parse.ts`. |
| `volatile-id.ts` | shared | The generated-id shapes (uuid, 16+ hex, 20+ alphanumeric with digits): `isVolatilePath` for discovered pages and `generatedIdFragment` for the gate's RULE 6. |
| `actual-state.ts` | shared | `captureActualState(page)`: the URL plus visible alert / validation / toast / status text. Used by the Explorer for a finding (`tools.ts`) and by replay and stability for the observed state on a failed re-run (`replay.ts`). |
| `selector-recovery.ts` | shared | In-run selector recovery (NOT the healer, which is the qa-core-heal package). `recoverResolve()` re-resolves a selector that failed during exploration by its semantic intent alone, dropping the stale hint that suppressed the ladder's match. Called from `resolveAndRecord` in `tools.ts`; each recovery is recorded on `ctx.heals` and surfaced as a `heal` event. Locked by `smoke-selector-recovery.ts`. |
| `memory.ts` | persistence | Per-host fingerprints stored under `.qa-core/sites/<host>.json` (cascade stats, known intents, auth hints) plus a global `.qa-core/memory.json`. Renders a cacheable system-prompt block injected by `runtime.ts`. Failures during save log to stderr. |
| `csv.ts` | utility | Tiny CSV reader and writer used by the `--review` flow (Planner exports `plan.csv`, user edits Approve column, run resumes from the CSV). |
| `eval-shim.ts` | utility | Installs a no-op `globalThis.__name` shim into every browser context via `addInitScript`. Fixes the `tsx` keepNames helper that breaks `page.evaluate()` serialization. Called from `runtime.ts`, `planner.ts`, `replay.ts` immediately after every `browser.newContext()`. |

---

## `src/cli/` — terminal interfaces

Three thin command-line front-ends. Each parses argv, calls the appropriate `src/agent/` function, and streams progress to the terminal. None of them contain business logic — they format I/O only.

| File | Command | Purpose |
|---|---|---|
| `explore.ts` | `npm run explore -- <url>` | Drives the 5-stage pipeline against a URL. Flag parsing lives in `src/agent/explore-request.ts` (shared with the gateway and MCP). Flags: `--lang ts\|js`, `--features`, `--srs`, `--urls`, `--discover`, `--resume`, `--name <basename>`, `--out <dir>`, `--review`, `--from-plan <plan.csv>`, `--no-pom`, `--no-replay`, `--no-stability`, `--stability N`, `--no-stabilize`, `--stabilize-attempts N`, and the per-run setting flags `--ceiling`, `--repair-reserve`, `--max-steps`, `--planner-model`, `--explorer-model`, `--critic-model`, `--env NAME=VALUE`. |
| `migrate-output.ts` | `npm run migrate-output [-- --dry-run]` | Moves legacy `output/<brand>-automation-framework/` folders (and their sibling zips) into `output/<project-slug>/<run-id>/`, one run per folder dated from its report. Idempotent. |
| `transcribe.ts` | `npm run transcribe -- <run-report.json>` | Re-emits the framework and zip from an existing run report. No browser, no model call. |
| `generate.ts` | `npm run generate -- "<story>"` | Single-shot story → spec. Flags: `--lang ts\|js`, `--name <basename>`, `--out <dir>`. |
| `heal.ts` | `npm run heal -- <spec-path>` | Thin wrapper around the published qa-core-heal npm package, which owns all healing logic. Parses argv, forwards to the package's `heal()` (deep import `qa-core-heal/dist/heal.js`; the package ships no `main`/`exports`), and prints the report. Also re-exports `heal` for the gateway and MCP server, so every heal path goes through the same package integration. Flags: `--base-url <url>`, `--dry-run`. |

---

## `src/server/` — the WebSocket gateway

| File | Purpose |
|---|---|
| `gateway.ts` | The HTTP and WebSocket gateway: the REST API, the built dashboard at `/`, and the run stream the dashboard follows. Listens on `ws://127.0.0.1:18789` by default. Hands each chat message to `commands.ts`, runs explore / resume / transcribe through `run-explore.ts`, and streams structured messages back: `settings` (the env-driven run settings), `run_started`, one `event` per `AgentEvent`, `run_report` (the RunReport minus traces), `framework_zip`, and `runs` (history from `runs.ts`). Accepts per-run setting overrides (`env`) and an uploaded SRS (`srs`) on the message. |
| `commands.ts` | Pure parser for the dashboard's slash commands: `/explore` with every CLI flag plus a natural-language feature hint, `/resume`, `/transcribe`, `/generate`, `/heal`, `/eval`, paste hints for pasted `npm run` lines, and the usage and help texts. No I/O, so `smoke-gateway-commands` drives it offline. |
| `run-explore.ts` | The explore run the gateway and the MCP server share: prepare (URL validation, checkpoint load + conflicts + reachability, SRS ingestion), run `explore()` through `buildExploreOptions`, emit (scaffold in a temporary directory, zip rooted at the framework name, only the zip written into the run directory; run-meta.json at start and every end), and `runTranscribeRequest`, the one transcribe behind the CLI, the gateway's Regenerate and MCP `qa_transcribe`: it scaffolds into a temporary directory, zips it rooted at `<brand>-automation-framework/`, atomically replaces only the zip in the run directory (never writing, slimming or zipping the run's own files) and appends a `transcribe` note to events.jsonl. `withEnvOverrides` applies per-run settings to `process.env` for the run only. |
| `api.ts` | REST API over the index (GET projects / runs / report / zip, POST reindex), token-guarded like the socket; report and zip files are served only from inside the project root. |
| `run-detail.ts` | `buildRunDetail`: one run from its stored artifacts (run-report, events.jsonl, files present, index row) for `/api/runs/:id/detail`; per-scenario Critic verdict, repair status, replay and stability as recorded, shipped from the emitted list, findings apart; loud 404 naming the path when the report is missing; `runArtifactFile` serves files from the run directory only. |
| `static.ts` | Serves `dashboard/dist` at `/` (SPA fallback); a build hint when dist is missing. |
| `db/schema.sql` | The index schema (plan section 5): projects, runs, findings, rule_coverage, verdicts, terminals. |
| `run-explore.ts` (SRS upload) | `validateSrsUpload` / `saveSrsUpload`: an SRS attached to a dashboard command is saved into the run directory under its original name (four types, 2 MB cap) and becomes `--srs`; held out of the framework zip and restored after slimming. |
| `db/migrate.ts` | Versioned migrations (`schema_version`), `openDatabase`. A migration marked `rebuild` (a table other rows reference is recreated) runs with foreign keys off outside the transaction, is verified with `foreign_key_check` before commit, and turns foreign keys back on. |
| `db/indexer.ts` | Scans `output/` and upserts the index: `runRowFromReport` (every number copied from the report), project assignment by host with an Unassigned fallback, findings dedupe on (project, normalized scenario, expected), verdicts and rule coverage rows, removal of vanished runs, and the import of pre-v2 gateway records from `.qa-core/sites/*.json` as summary-only `legacy` rows (never shadowing a report). |
| `events.ts` | `appendRunEvent` / `readRunEvents`: the per-run `events.jsonl` timeline every surface writes next to the report. `eventForUi`: trims tool payloads in the event stream the gateway forwards to the dashboard. Every other event, `critic_done` included, passes through as the runtime emitted it, and this runs after the critic response was parsed. |
| `runs.ts` | Run history from disk (`listRunsFromDisk`): every `run-report.json` under `output/` and `eval-results/` as a `DiskRun` with status (`completed` / `stopped` with checkpoint / `empty`), checkpoint and report paths, reconciliation, rule coverage and repair journeys. `reportForUi` strips per-step traces from a report before it is sent to the dashboard; `loadReportForUi` serves the history view's `get_report` (path-validated to a `run-report.json` under the project root). |

---

## `src/mcp/` — Model Context Protocol server

| File | Purpose |
|---|---|
| `server.ts` | Exposes QA-Core's workflows as MCP tools (`qa_explore`, `qa_resume`, `qa_transcribe`, `qa_generate`, `qa_heal`) over stdio JSON-RPC. Explore, resume and transcribe run through `src/server/run-explore.ts`, the same path the gateway uses. All logging goes to stderr to keep stdout reserved for the MCP wire protocol. |
| `tools.ts` | Pure tool schemas (zod) with every argument documented against its CLI flag, and the mappers from tool arguments onto the shared `ExploreRequest` (`exploreRequestFromToolArgs`, `resumeRequestFromToolArgs`). Imported by `smoke-surface-parity` without starting the server. |

---

## `scripts/` — eval harness, debug tools, and smoke tests

This directory is mixed: the eval harness is production code, the smoke tests are CI/regression protection, the render scripts are docs generators, and the debug scripts are throwaway diagnostic tools kept for posterity.

### Production

| File | Purpose |
|---|---|
| `eval.ts` | The `npm run eval` harness. Runs `/explore` against the three baseline target sites (saucedemo, the-internet, practice-todo), executes the generated specs through Playwright, and writes `eval-results/<timestamp>/{results.json,summary.md}` with per-site metrics including the v2 columns (Replay pass/fail, Stable/Flaky/Broken, flake_rate). |

### Smoke tests (regression protection)

These run with `npx tsx scripts/<name>.ts`. They are deterministic and fast. Each one locks in a specific bug fix from the v2 hardening pass so future changes don't silently regress it.

| File | What it locks in |
|---|---|
| `smoke-tools.ts` | `get_dom` surfaces `required` + `disabled` + `validation` form-state fields. Runs against real Chromium. |
| `smoke-finish.ts` | `finish()` drops abandoned assert-less scenarios but keeps complete ones. |
| `smoke-hascount.ts` | `toHaveCount(N)` succeeds on multi-match selectors. Recorded step has `ambiguous` flag stripped so transcribed spec emits without `.first()`. |
| `smoke-planner-parse.ts` | Five known Haiku output formats (with/without brackets, em-dash vs colon after category, hyphen-in-name edge case) all parse correctly. |
| `smoke-emitted-check.ts` | The emitted-spec check against a local fixture site: one passing scenario ships, one whose assertion fails deterministically is retried once and dropped into `emitted_failed` with its Playwright error while the funnel stays balanced and the re-scaffolded spec no longer holds it, every test failing (a11y included) or a refused connection leaves the stage inconclusive with the framework kept, `--no-emitted-check` skips with the reason on the report, and a stopped run is not run. |
| `smoke-plan-page-fit.ts` | The plan-time page-fit pass on the live shapes of the run 591732 pages: a password-reset snapshot rejects a first-name and a password registration scenario and keeps an unknown-email one, a rentals snapshot with no price text rejects a price scenario and keeps a name-and-image one, a hand-tools snapshot keeps sort, price, filter and pagination; a navigation scenario (clicked, opened, landed, ...) is judged only on its first action's controls; the whole-document flags are computed in headless Chromium so a price past the text sample and a search box past the inputs cap still count; matching is on normalized words with synonyms; a cross-page duplicate login collapses to one on the feature's page; the funnel balances after the drops; derivation reports `page-fit`; an SRS feature with rules and no page prints its line. |
| `smoke-abandoned.ts` | The runtime's exit-path force-push drops in-progress scenarios with no assertions. |
| `smoke-stability-lockout.ts` | A local page that locks after the first attempt, real Chromium, a fake Stabilizer: the first failure carries the observed text at the target and the visible alert, every Stabilizer attempt is on the verdict with its outcome, broken means gaveUp, and cost without attempts warns. |
| `smoke-prompt-cache.ts` | Prompt caching of the Explorer conversation with a fake client: the latest message carries `cache_control` on every call, the previous marker is removed, the frozen system prompt and the last system block keep theirs, never more than four breakpoints per request, and `cost.calls` plus `cost.cachedInputShare` expose the cached share. |
| `smoke-gateway-commands.ts` | The dashboard command parser accepts every explore flag, `/resume`, `/transcribe`, quoted paths, npm-style leftovers, and paste hints for the new flags; refuses `--out`, `--review`, unknown flags, and settings outside the per-run allowlist. |
| `smoke-surface-parity.ts` | The CLI, the gateway and the MCP server build identical `ExploreRequest`s and identical runtime options for the same ask (fresh and resume); every row of `EXPLORE_FLAGS` parses, has its MCP argument with a description naming the CLI flag, is accepted by `/explore`, or states why parity is impossible; tool names stay stable. |
| `smoke-gateway-critic.ts` | The critic parse through the gateway's `runExploreRequest` path with a fake client: the saucedemo-shaped response (a regex quoted inside a reason) parses to 3 verdicts, the per-run critic model override is applied at call time and restored, the dashboard model chip never reaches the critic, the CLI path yields byte-identical verdicts, `eventForUi` forwards `critic_done` untouched, and an unparseable response keeps its raw text. |
| `smoke-output-layout.ts` | Per-run directories, run ids, the latest pointer, `--out` override, legacy migration (dry run, idempotence), transcribe into a run directory. |
| `smoke-index.ts` | The SQLite index over a fixture tree: row counts, every runs row equals its report, host projects and Unassigned, findings dedupe, verdicts and coverage rows, delete-and-reindex identical. |
| `smoke-api.ts` | REST routes: token required, responses equal the index, path validation, reindex, static serving at `/`. |
| `smoke-acceptance.ts` | PR A acceptance: delete the database, index again, every run under the right project with report numbers. `--real` runs it against this repo's output/. |
| `smoke-dashboard.ts` | Boots a real gateway on a spare port over a fixture tree and drives the built dashboard: Projects cards and Runs table equal the API, filters, empty states, header from the socket, both themes; writes the docs screenshots. |
| `smoke-run-detail.ts` | Run Detail endpoint and page: seeded verdicts (pass shipped, rework repaired, reject dropped) and one finding come back exactly as stored; the finding is never a scenario row; unknown or vanished report is a 404 naming the path; legacy returns `legacy: true` without scenarios; artifacts only from the run directory; the page renders the finding under "Product behavior to review", "No findings recorded" for a quiet run, the legacy notice, and the back link. |
| `smoke-ui-pipeline.ts` | The live run view renders from a realistic event sequence, then from a fixture run-report: funnel counts equal the reconciliation arrays' lengths, verdict journeys match `review.repair`, the cost split sums the report's fields, rule coverage lists considered-not-automated rules with reasons; history shows Resume only with a checkpoint and Regenerate only on a completed run; both themes keep 4.5:1 contrast. |
| `smoke-dashboard-math.ts` | Compares the old (buggy) vs new (fixed) per-site dashboard math against real on-disk runs. Confirms the fix produces sensible numbers, not just "different" numbers. |

---

## `tests/` — Playwright auth setup

| File | Purpose |
|---|---|
| `auth.setup.ts` | Authenticates once and saves the storage state to `playwright/.auth/user.json`. Reads `QA_CORE_AUTH_URL` / `QA_CORE_AUTH_USER` / `QA_CORE_AUTH_PASS` from env. Skipped cleanly if those env vars are missing. The Explorer, Replay, and Stability stages all pick up this storage state automatically when present. |

---

## `skills/` — OpenClaw skill definitions

Markdown files that describe QA-Core's commands to the OpenClaw skill router. Each one is a small frontmatter + body describing what the skill does, what arguments it takes, and the local command to run.

| File | Skill |
|---|---|
| `explore-url.md` | `/explore` — give it a URL, get a Playwright suite. |
| `generate-tests.md` | `/generate` — give it a user story, get a spec. |

---

## `docs/` — documentation and assets

| File | Purpose |
|---|---|
| `DOCUMENTATION.md` | The high-level product / architecture documentation. Start here. |
| `CODEBASE.md` | This file — file-by-file reference for engineers. |
| `MCP.md` | Setup guide for using QA-Core's MCP server with Claude Desktop / Cursor / Cline / Continue / Zed. |
| `architecture.html` | Editable HTML source for the architecture diagram. |
| `architecture.png` / `architecture.svg` | Rendered architecture diagrams. Used in the README. |
| `linkedin-card.svg` | LinkedIn share card image. |
| `linkedin-drafts.md` | Drafts of LinkedIn posts (v1, v2, video script). |
| `claude_desktop_config.example.json` | Example MCP server config to paste into Claude Desktop's settings. |

---

## Runtime data directories (gitignored)

| Path | Created by | Purpose |
|---|---|---|
| `output/<timestamp>-<host>/` | `explore.ts` and `gateway.ts` | One directory per `/explore` run. Contains `run-report.json` plus the generated spec (or the POM framework subdirectories). |
| `eval-results/<timestamp>/<site>/` | `eval.ts` | One directory per eval run, one subdirectory per target site. Contains `run-report.json`, the generated spec, `pw-results.json` from the Playwright execution, plus the eval-wide `results.json` and `summary.md` at the root. |
| `playwright/.auth/user.json` | `tests/auth.setup.ts` | Persisted storage state from a successful login. Reused by every subsequent agent context that finds this file. |
| `.qa-core/sites/<host>.json` | `memory.ts` | Per-host fingerprint. Cascade distribution, known intents, auth hints. Read at the start of a run, refreshed at the end. |
| `.qa-core/memory.json` | `memory.ts` | Project-wide memory: recent runs, prevailing cascade distribution, any user-pinned overrides. |
| `node_modules/` | npm | Dependencies. |
| `test-results/` | Playwright runner | Per-test artifacts (traces, videos, screenshots) when the runner is invoked directly. |

---

## How a single `/explore` request flows through the codebase

For new contributors, this is the call stack from a user pressing Enter to the final spec landing on disk:

1. User starts `/explore https://example.com/` from the dashboard's Terminal page.
2. UI sends a WebSocket message to `gateway.ts`.
3. `gateway.ts` parses the slash command and calls `explore()` from `runtime.ts`.
4. `runtime.ts` calls `installEvalShim()` (`eval-shim.ts`) on the browser context.
5. **Stage 1 — Planner** (`planner.ts`): opens the URL, snapshots the DOM, asks Haiku for scenarios, parses with the forgiving regex.
6. **Stage 2 — Explorer** (`runtime.ts` + `tools.ts`): Opus drives the browser through the tool surface. Each tool call records a step in the trace. State is reset between scenarios.
7. **Stage 3 — Critic** (`critic.ts`): Sonnet reviews each recorded scenario and produces a `pass` / `rework` / `reject` verdict. Non-pass scenarios are dropped before replay and named in the reconciliation funnel.
8. **Stage 4 — Reality-Check Replay** (`replay.ts`): every scenario is re-executed in a fresh context. Failures get dropped.
9. **Stage 5 — Stability** (`stability.ts`): replay-survivors run 3 more times. Anything that pass-then-fails is dropped as flaky.
10. `runtime.ts` builds the final `RunReport` and writes `run-report.json`.
11. `transcriber.ts` (or `pom.ts` if POM mode) consumes the verified scenarios and writes the runnable spec.
12. `memory.ts` updates the per-host fingerprint.
13. `gateway.ts` sends the final `Done.` message and the spec contents back over the WebSocket.
14. UI renders the response, persists the run to localStorage, updates the dashboard.

---

## Key invariants the codebase relies on

These are the rules anyone modifying the agent should preserve. Every smoke test enforces one of these.

1. **Every emitted scenario contains at least one assertion.** Enforced in `tools.ts` (`end_scenario`, `finish`) and `runtime.ts` (force-push guard). Tested by `smoke-finish.ts` and `smoke-abandoned.ts`.
2. **The selector cascade only claims a level when it resolves to exactly one element.** When ambiguous, the `ambiguous` flag is set on the `SelectorRecord` and `.first()` is honestly emitted by both replay and the transcriber. Enforced in `selectors.ts`. Tested implicitly by spec-runs.
3. **`toHaveCount` uses the multi-match locator, not the `.first()`-wrapped one.** Enforced in `tools.ts` (uses `baseLocator` from `replay.ts`). Tested by `smoke-hascount.ts`.
4. **`page.evaluate` calls work under tsx.** Enforced by `eval-shim.ts` installed in every browser context. Tested by `smoke-tools.ts` and `smoke-ui.ts`.
5. **Every scenario starts from a clean state.** `begin_scenario` clears cookies + storage. The transcribed spec emits a matching `beforeEach`. Enforced in `tools.ts`, `transcriber.ts`, and `pom.ts`.
6. **Planner parser accepts any of the four known Haiku format variants.** Enforced in `planner.ts`. Tested by `smoke-planner-parse.ts`.
7. **Dashboard per-site math divides by `runsWithPass`, not total runs.** Enforced in `src/server/runs.ts` (`sitePassRates`). Tested by `smoke-dashboard-math.ts`.

---

## How to run the smoke suite

```bash
# All seven
for s in smoke-tools smoke-finish smoke-hascount smoke-planner-parse \
         smoke-abandoned smoke-ui smoke-dashboard-math; do
  echo "=== $s ==="
  npx tsx scripts/$s.ts
done

# Or just typecheck the whole project
npx tsc --noEmit
```

All seven should print `OK:` on the last line. `tsc --noEmit` should print nothing.

---

## Footnote on what's NOT in this codebase

For clarity — features that are listed in the LinkedIn v3 roadmap but are not yet built:

- **PR-aware test selection** — would read a git diff and propose which existing scenarios to re-run vs extend.
- **Multi-role auth** — single `playwright/.auth/user.json` exists today; a multi-role scheme (`admin.json`, `user.json`, `guest.json` with CLI flag) is not yet implemented.
- **Visual regression** — `expect(page).toHaveScreenshot()` is not emitted by the transcriber.
- **Network mocking** — the Explorer's tool surface has no `route()` tool.
- **GitHub Action** — no workflow file ships with the repo today.

These belong to the v3 surface and will be added in their own scoped passes.
