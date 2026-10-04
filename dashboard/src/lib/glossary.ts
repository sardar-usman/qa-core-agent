/**
 * The glossary: every tooltip the dashboard shows, one entry per term.
 *
 * Rules (locked by scripts/smoke-glossary.ts):
 *   - Each entry is preceded by a `// Source:` comment naming where the term
 *     is defined: the invariant number in CLAUDE.md, or the file and function.
 *     A definition is read from the code or CLAUDE.md, never guessed.
 *   - Plain English, one or two short sentences, no jargon, no em dashes, no
 *     double hyphens.
 *   - A page refers to an entry by key (<Term term="shipped">); the key type
 *     makes a missing entry a compile error and the smoke a lock.
 *
 * No `@/` imports here so the smoke can load this file directly under tsx.
 */

export interface GlossaryEntry {
  /** The short label the tooltip opens with. */
  term: string;
  /** The definition, one or two sentences. */
  text: string;
}

export const GLOSSARY = {
  /* ─── header chips ─── */

  // Source: dashboard/src/lib/gateway.ts connectGateway (socket state from the WebSocket's own open, close and error events); CLAUDE.md invariant 47 (the chip is derived from the live socket's readyState).
  gateway: { term: 'Gateway status', text: 'Whether this tab has a live connection to the gateway: connecting, connected or offline. It is read from the browser socket itself, so a stale socket can never show as connected.' },

  // Source: dashboard/src/lib/gateway.ts reportCost and sessionSpend (the run_report message's cost_total, summed per tab); CLAUDE.md invariant 47 (the Session chip sums this browser session's finished run costs).
  session: { term: 'Session', text: 'Model spend of the runs that finished while this tab was open, summed from each run\'s reported total. It starts at zero again when the tab reloads.' },

  // Source: CLAUDE.md pipeline table (stage 1, Planner) and the configuration defaults table (QA_CORE_PLANNER_MODEL); src/agent/explore-request.ts RUN_ENV_SETTINGS.
  modelPlan: { term: 'Planner model', text: 'The model the Planner uses to turn one page snapshot into the numbered scenario list. Set by QA_CORE_PLANNER_MODEL on the gateway, else the built-in default.' },

  // Source: CLAUDE.md pipeline table (stage 2, Explorer) and the configuration defaults table (QA_CORE_EXPLORER_MODEL); src/agent/explore-request.ts RUN_ENV_SETTINGS.
  modelExplore: { term: 'Explorer model', text: 'The model that drives the browser and records each scenario\'s steps. Set by QA_CORE_EXPLORER_MODEL on the gateway, else the built-in default.' },

  // Source: CLAUDE.md pipeline table (stage 3, Critic) and the configuration defaults table (QA_CORE_CRITIC_MODEL); src/agent/explore-request.ts RUN_ENV_SETTINGS.
  modelReview: { term: 'Critic model', text: 'The model that reviews every recorded scenario and grades it pass, rework or reject. Set by QA_CORE_CRITIC_MODEL on the gateway, else the built-in default.' },

  // Source: src/server/api.ts (POST /api/reindex) and src/server/db/indexer.ts indexOutput; CLAUDE.md invariant 50 (files are truth, the index is rebuildable).
  reindex: { term: 'Rebuild the index', text: 'Re-reads every run folder under output/ and rebuilds the dashboard\'s index from those files. Nothing on disk changes.' },

  // Source: dashboard/src/lib/theme.ts (applyTheme, the qa-core.theme key).
  theme: { term: 'Theme', text: 'Switches between dark and light. The choice is kept in this browser under qa-core.theme.' },

  /* ─── counts ─── */

  // Source: CLAUDE.md pipeline table (stages 3 to 5: Critic, one fresh replay, three stability re-runs) and invariant 63 (the emitted-spec check runs before the zip and drops a test that fails twice); src/server/db/indexer.ts runRowFromReport (shipped = scenarios.length, the report's emitted list).
  shipped: { term: 'Shipped', text: 'A scenario that passed the Critic, one fresh replay and three stability re-runs, then the emitted-spec check, and is in the framework zip. Counted from the run report\'s scenario list.' },

  // Source: src/server/api.ts projectCard (SUM of shipped over runs WHERE report_path IS NOT NULL; null when the project has no reported run); CLAUDE.md invariant 50.
  testsShipped: { term: 'Tests shipped', text: 'Shipped scenarios summed over this project\'s runs that have a report. Pre-v2 records are left out because they never recorded a shipped count.' },

  // Source: src/server/api.ts projectCard (last_run: the newest run by start time, its shipped column).
  latestShipped: { term: 'Tests in the latest run', text: 'The shipped count of this project\'s most recent run, read from that run\'s index row.' },

  // Source: CLAUDE.md pipeline table (stage 1, Planner) and invariants 31 and 63 (the reconciliation identity); src/server/db/indexer.ts runRowFromReport (planned = reconciliation.planned).
  planned: { term: 'Planned', text: 'Scenarios the Planner listed for the run before exploration began. Each one ends in exactly one bucket: shipped, dropped, incomplete, finding, skipped or emitted failed.' },

  // Source: src/server/db/indexer.ts runRowFromLegacyRecord (the record\'s scenarios count is what the run explored, stored as generated; shipped stays null); STATE.md standing decisions (legacy runs show explored counts, never shipped counts).
  explored: { term: 'Explored', text: 'Scenarios the Explorer recorded in the browser. A pre-v2 record kept only this count, written before replay and stability dropped anything, so it is never a shipped count.' },

  // Source: src/server/api.ts projectCard (COUNT of findings WHERE status IN open, triaged); CLAUDE.md invariant 50 (finding statuses) and invariant 13 (a finding is product behavior, never a test failure).
  unresolvedFindings: { term: 'Unresolved findings', text: 'Findings with status open or triaged. A finding is product behavior the agent observed that differed from what the scenario expected; it is never a test failure.' },

  // Source: src/server/api.ts projectCard and monthStart (SUM of cost_total over runs started since the first day of the current UTC month); src/agent/cost-total.ts totalCost (API cost only).
  spendMonth: { term: 'Spend this month', text: 'Model spend, API cost only, summed over this project\'s runs started since the first day of the current month (UTC).' },

  // Source: src/server/api.ts projectCard coverage_series (covered rules over all rules per SRS run, rounded to a whole percent); CLAUDE.md invariant 26 (rule-coverage.json).
  coverage: { term: 'Coverage', text: 'The share of SRS rules a run covered, from its rule-coverage file: covered rules over all rules, rounded to a whole percent. The line shows each SRS run in order; the number is the latest.' },

  // Source: src/server/api.ts projectCard (COUNT of runs for the project, reported and legacy).
  runs: { term: 'Runs', text: 'Every run indexed for this project, whether it has a report or is a pre-v2 record.' },

  // Source: src/server/api.ts projectCoverage (srs_runs: runs that recorded rule coverage); CLAUDE.md invariant 26 (--srs).
  srsRuns: { term: 'SRS runs', text: 'Runs given a requirements document (the srs option). Only those record rule coverage.' },

  // Source: src/server/db/indexer.ts importLegacyRecords and runRowFromLegacyRecord (.qa-core/sites records imported with status legacy); STATE.md standing decisions.
  legacy: { term: 'Summary only (pre-v2)', text: 'A record from before runs had their own folder. The gateway kept only the count explored, the cost, the model and the duration: there is no report, no zip and no shipped count.' },

  // Source: src/server/api.ts projectCard (last_run: ORDER BY started_at DESC LIMIT 1).
  lastRun: { term: 'Last run', text: 'The project\'s most recent run by start time, with its status and when it started.' },

  // Source: src/server/api.ts projectCard (shipped and unresolved_findings are null when reported_runs is 0); the design skill\'s invariant that a legacy-only project shows n/a, never 0.
  notAvailable: { term: 'n/a', text: 'Not known, never 0. This project has no run with a report: only pre-v2 records, which never recorded a shipped count or findings, or no runs yet.' },

  // Source: dashboard/src/pages/Projects.tsx splitProjects (the grouping rule) over src/server/api.ts projectCard (reported_runs, legacy_runs, runs).
  earlierExperiments: { term: 'Earlier experiments (pre-v2)', text: 'Projects whose runs are all pre-v2 records, projects with no runs yet, and the Unassigned record. Nothing is deleted; they sit here with their count.' },

  /* ─── run status values ─── */

  // Source: src/server/db/indexer.ts runRowFromReport (status: completed when a report exists with scenarios and no checkpoint).
  statusCompleted: { term: 'Completed', text: 'The run wrote its report, shipped at least one scenario and left no checkpoint.' },

  // Source: src/server/db/indexer.ts runRowFromReport (status: stopped when checkpoint.json sits next to the report); CLAUDE.md invariants 30 and 40 (cost ceiling salvage; checkpoint on every abnormal end, resumable).
  statusStopped: { term: 'Stopped', text: 'The run ended early at the cost ceiling, on a billing or API failure, or on Ctrl-C. Completed scenarios were kept, the checkpoint stays, and the run can be resumed.' },

  // Source: src/server/db/indexer.ts runRowFromReport (status: empty when the report has zero scenarios); CLAUDE.md invariant 33 (an empty run names the stage that emptied the funnel).
  statusEmpty: { term: 'Empty', text: 'The run wrote a report but shipped no scenario. The report names the stage that emptied the funnel.' },

  // Source: src/server/db/schema.sql (the status CHECK constraint); src/server/db/indexer.ts runRowFromReport never yields it, and indexRunDir skips a folder with no report.
  statusFailed: { term: 'Failed', text: 'Reserved in the index for a run that ended without a report. The indexer does not write it today: a run that stops abnormally keeps its checkpoint and shows as stopped, and a folder with no report is not indexed.' },

  // Source: src/server/db/schema.sql (the status CHECK constraint); CLAUDE.md invariant 47 (a live run is followed on its run page from the gateway\'s event stream).
  statusRunning: { term: 'Running', text: 'Reserved in the index for a run in progress. The indexer does not write it today; a live run is followed on its run page from the gateway\'s event stream.' },

  /* ─── run table columns ─── */

  // Source: src/server/db/indexer.ts runRowFromReport (shipped and planned columns; a legacy row carries explored in generated and shipped null).
  shippedPlanned: { term: 'Shipped / planned', text: 'Shipped scenarios over planned scenarios for the run, both from the run report. A pre-v2 record shows its explored count instead.' },

  // Source: src/agent/cost-total.ts totalCost (explorer including the repair pass, planner, critic, stabilizer and requirements map); CLAUDE.md invariant 50 (the one place a total is summed).
  cost: { term: 'Cost', text: 'Model spend for the run, API cost only: the explorer (repair pass included), planner, critic, stabilizer and requirements map lines, summed in one place. Browser time and your own machine are not counted.' },

  // Source: src/agent/stability.ts (flakeRate = flaked.length / total, over the scenarios that reached stability); src/server/db/indexer.ts runRowFromReport (null when stability did not run).
  flakeRate: { term: 'Flake rate', text: 'The share of scenarios that failed at least one of the three stability re-runs, over all scenarios that reached stability. A pre-v2 record has none.' },

  // Source: src/server/db/indexer.ts (started_at and ended_at from the report; a legacy record\'s start is its finish minus durationSec); dashboard/src/lib/utils.ts duration (the formatting).
  duration: { term: 'Duration', text: 'The time between the run\'s recorded start and finish. For a pre-v2 record the start is the finish time minus the duration the record kept.' },

  // Source: CLAUDE.md invariant 49 (run-meta.json names the surface; the indexer never defaults a missing source); src/server/db/indexer.ts indexRunDir (meta.source).
  source: { term: 'Source', text: 'The surface that started the run, from its run-meta.json: cli, dashboard, mcp or telegram. A run that left no run-meta shows unknown; nothing is guessed.' },

  // Source: src/server/db/indexer.ts runRowFromReport (started_at = the report\'s startedAt, else the time in the run id); dashboard/src/lib/utils.ts fmtDate (today shows the time, older runs the day).
  date: { term: 'Date', text: 'When the run started, from the report. Today\'s runs show the time, older runs the day; the full timestamp is in the tooltip.' },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;
