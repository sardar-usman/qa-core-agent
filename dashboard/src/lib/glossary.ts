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

  // Source: src/server/api.ts projectCard (last_run.shipped: the newest run's shipped column; shipped: SUM of shipped over runs WHERE report_path IS NOT NULL); CLAUDE.md pipeline table (stages 3 to 5) and invariant 63 (the emitted-spec check).
  latestShipped: { term: 'Verified tests', text: 'Tests in the latest run that passed the Critic, one fresh replay, three stability re-runs and the emitted-spec check, and shipped in the framework zip. The total beneath sums the same count over every run with a report; pre-v2 records never recorded one.' },

  // Source: CLAUDE.md pipeline table (stage 1, Planner) and invariants 31 and 63 (the reconciliation identity); src/server/db/indexer.ts runRowFromReport (planned = reconciliation.planned).
  planned: { term: 'Planned', text: 'Scenarios the Planner listed for the run before exploration began. Each one ends in exactly one bucket: shipped, dropped, incomplete, finding, skipped or emitted failed.' },

  // Source: src/server/db/indexer.ts runRowFromLegacyRecord (the record\'s scenarios count is what the run explored, stored as generated; shipped stays null); STATE.md standing decisions (legacy runs show explored counts, never shipped counts).
  explored: { term: 'Explored', text: 'Scenarios the Explorer recorded in the browser. A pre-v2 record kept only this count, written before replay and stability dropped anything, so it is never a shipped count.' },

  // Source: src/server/api.ts projectCard (COUNT of findings WHERE status IN open, triaged); CLAUDE.md invariant 50 (finding statuses) and invariant 13 (a finding is product behavior, never a test failure).
  unresolvedFindings: { term: 'To review', text: 'Findings with status open or triaged, waiting for a person to look at them. A finding is product behavior the agent saw that differed from what the scenario expected; it is never a test failure.' },

  // Source: src/server/api.ts projectCard and monthStart (SUM of cost_total over runs started since the first day of the current UTC month); src/agent/cost-total.ts totalCost (API cost only).
  spendMonth: { term: 'Spent', text: 'Model spend this month, API cost only, summed over this project\'s runs started since the first day of the current month (UTC). The number is rounded to cents and its tooltip holds the exact stored value.' },

  // Source: src/server/api.ts projectCard coverage_series (covered and total per SRS run from the rule_coverage rows, percent computed from the same two counts); CLAUDE.md invariant 26 (rule-coverage.json).
  coverage: { term: 'Requirements covered', text: 'How many rules of the requirements document the latest SRS run covered, out of all its rules, read from that run\'s rule-coverage file. The bar shows the same two numbers as a share.' },

  // Source: src/server/api.ts projectCard (COUNT of runs for the project, reported and legacy).
  runs: { term: 'Runs', text: 'Every run indexed for this project, whether it has a report or is a pre-v2 record.' },

  // Source: src/server/db/indexer.ts importLegacyRecords and runRowFromLegacyRecord (.qa-core/sites records imported with status legacy); STATE.md standing decisions.
  legacy: { term: 'Summary only (pre-v2)', text: 'A record from before runs had their own folder. The gateway kept only the count explored, the cost, the model and the duration: there is no report, no zip and no shipped count.' },

  // Source: src/server/api.ts projectCard (last_run: ORDER BY started_at DESC LIMIT 1).
  lastRun: { term: 'Last run', text: 'The project\'s most recent run by start time, with its status and when it started.' },

  // Source: dashboard/src/pages/Projects.tsx splitProjects (the grouping rule) over src/server/api.ts projectCard (reported_runs, legacy_runs, runs).
  earlierExperiments: { term: 'Earlier experiments', text: 'Projects whose runs are all pre-v2 summaries, projects with no runs yet, and the Unassigned record. They have no verified-test count to show, so they are listed in a table instead of cards; nothing is deleted.' },

  // Source: CLAUDE.md invariants 47 and 50 (every number comes from the run report or the index built from the files; the index is rebuildable); src/server/api.ts listProjects.
  projectsPage: { term: 'Projects', text: 'One card per website the agent has tested. Every number on this page is read from the run index, which is built from the run reports on disk; the page computes nothing.' },

  // Source: src/server/api.ts projectCoverage (runs_covered and runs_reported per rule, counted over the rule_coverage rows); CLAUDE.md invariant 26 (rule-coverage.json per SRS run).
  runsCovered: { term: 'Runs covered', text: 'How many of this project\'s SRS runs covered the rule, over how many SRS runs reported it. Counted from the rule-coverage file of each run.' },

  // Source: CLAUDE.md invariant 52 (the project SRS is kept under output/<slug>/srs/, earlier uploads renamed with their upload time, a copy in every run that uses it); src/server/project-srs.ts storeProjectSrs.
  requirementsDocument: { term: 'Requirements document (SRS)', text: 'The project\'s current requirements file, kept in the project folder and copied into every run that uses it, so a run always has the exact document it was planned from. Earlier uploads are kept, renamed with their upload time.' },

  // Source: src/server/api.ts projectCard (reported_runs: runs WHERE report_path IS NOT NULL); CLAUDE.md invariant 50 (a legacy row has report_path null).
  reportedRuns: { term: 'With a report', text: 'Runs whose run-report.json is on disk. Pre-v2 summaries have no report, so they are counted in runs but not here.' },

  /* ─── new project dialog ─── */

  // Source: CLAUDE.md invariant 50 (the project id is the host slug, base_url is identity and read-only, a second project for the same host is a 409 naming the existing one); src/server/api.ts createProject and patchProject.
  projectBaseUrl: { term: 'Base URL', text: 'The site\'s address. Its host becomes the project\'s identity: a later run against that host lands here, it cannot be changed afterwards, and a second project for the same host is refused with the existing one named.' },

  // Source: src/server/api.ts createProject (name || brandSlug(baseUrl)); src/agent/scaffold.ts brandSlug (www and the TLD dropped).
  projectName: { term: 'Name', text: 'What the project is called on the cards. Left empty, it defaults to the host name without www and the ending, so shop.example becomes shop.' },

  // Source: CLAUDE.md invariant 50 (environment is NULL until a person sets it, never a default label); src/server/api.ts environmentFrom and PROJECT_ENVIRONMENTS.
  projectEnvironment: { term: 'Environment', text: 'An optional label: staging, production or other. Nothing is assumed when it is left unset, and the badge only appears once a person sets it.' },

  // Source: src/server/api.ts createProject (POST /api/projects: 201 with the project, 400 for a bad URL or environment, 409 when the host already has a project); CLAUDE.md invariant 50.
  createProject: { term: 'Create', text: 'Saves the project in the index. The API checks the URL and the environment, and refuses a host that already has a project by naming it.' },

  /* ─── findings table ─── */

  // Source: src/server/db/indexer.ts indexRunDir (findings rows copy f.expected from the run report); CLAUDE.md invariant 13 (a finding records what the scenario expected and the real page state).
  findingExpected: { term: 'Expected', text: 'What the scenario expected to see, as the run report recorded it. The finding exists because the page showed something else.' },

  // Source: src/server/db/indexer.ts indexRunDir (page_url = f.url, the URL at the time); CLAUDE.md invariant 13 (captureActualState reads the real URL).
  findingPage: { term: 'Page', text: 'Where the page was when the finding was recorded, shown as the path because the host is the project\'s. The full address is in the tooltip.' },

  // Source: src/server/api.ts listFindings (times_seen = the finding_runs rows; first and last seen from the runs' start times); src/server/db/schema.sql finding_runs.
  findingSeen: { term: 'Seen', text: 'How many runs recorded this same finding, with the date of the latest one. The first and last dates are in the tooltip.' },

  // Source: src/server/api.ts patchFinding and FINDING_STATUSES (open, triaged, fixed, wont-fix); CLAUDE.md invariant 50 (set only by a person, kept across every re-index).
  findingStatus: { term: 'Status', text: 'Your triage state for the finding: open, triaged, fixed or wont-fix. Only a person changes it, and it survives every rebuild of the index.' },

  // Source: src/server/db/indexer.ts indexRunDir (a new finding is inserted with status open); src/server/api.ts projectCard (open counts as unresolved).
  findingStatusOpen: { term: 'Open', text: 'Nobody has looked at it yet; this is the state a new finding gets when it is indexed. It counts as unresolved.' },

  // Source: src/server/api.ts projectCard (status IN open, triaged counts as unresolved); CLAUDE.md invariant 50.
  findingStatusTriaged: { term: 'Triaged', text: 'Someone has looked at it and it is still being dealt with. It still counts as unresolved.' },

  // Source: src/server/api.ts projectCard (fixed is excluded from unresolved); CLAUDE.md invariant 50.
  findingStatusFixed: { term: 'Fixed', text: 'The product behaviour was fixed. The finding stays on record but no longer counts as unresolved.' },

  // Source: src/server/api.ts projectCard (wont-fix is excluded from unresolved); CLAUDE.md invariant 50.
  findingStatusWontFix: { term: 'Wont-fix', text: 'A decision not to change the product. The finding stays on record but no longer counts as unresolved.' },

  // Source: src/server/api.ts patchFinding (notes: a string up to 4000 characters or null, saved on PATCH); CLAUDE.md invariant 50 (kept across re-indexes).
  findingNotes: { term: 'Notes', text: 'Free text for your own record, up to 4000 characters, saved when you leave the field. It survives every rebuild of the index.' },

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
