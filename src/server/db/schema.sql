-- QA-Core dashboard index (dashboard v2 plan, section 5).
-- Files are truth; this database is an index rebuilt from output/ at any time.

CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  base_url            TEXT,
  environment         TEXT NOT NULL DEFAULT 'other' CHECK (environment IN ('staging', 'production', 'other')),
  srs_path            TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  default_ceiling_usd REAL,
  default_features    TEXT,
  notes               TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  started_at      TEXT,
  ended_at        TEXT,
  -- 'legacy': a pre-v2 gateway record (.qa-core/sites/<host>.json recentRuns) with no report on disk.
  status          TEXT NOT NULL CHECK (status IN ('running', 'completed', 'stopped', 'empty', 'failed', 'legacy')),
  source          TEXT NOT NULL CHECK (source IN ('cli', 'dashboard', 'mcp', 'telegram')),
  url             TEXT,
  flags_json      TEXT,
  planned         INTEGER NOT NULL DEFAULT 0,
  generated       INTEGER NOT NULL DEFAULT 0,
  dropped         INTEGER NOT NULL DEFAULT 0,
  incomplete      INTEGER NOT NULL DEFAULT 0,
  findings        INTEGER NOT NULL DEFAULT 0,
  skipped         INTEGER NOT NULL DEFAULT 0,
  stable          INTEGER NOT NULL DEFAULT 0,
  flaky           INTEGER NOT NULL DEFAULT 0,
  broken          INTEGER NOT NULL DEFAULT 0,
  -- NULL for a legacy record: those carried scenarios EXPLORED (kept in generated), never a shipped count.
  shipped         INTEGER,
  cost_total      REAL NOT NULL DEFAULT 0,
  cost_planner    REAL NOT NULL DEFAULT 0,
  cost_explorer   REAL NOT NULL DEFAULT 0,
  cost_critic     REAL NOT NULL DEFAULT 0,
  cost_repair     REAL NOT NULL DEFAULT 0,
  flake_rate      REAL,
  report_path     TEXT,
  zip_path        TEXT,
  checkpoint_path TEXT,
  stopped_reason  TEXT
);
CREATE INDEX IF NOT EXISTS runs_project_started ON runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS findings (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(id),
  project_id        TEXT NOT NULL REFERENCES projects(id),
  scenario          TEXT NOT NULL,
  expected          TEXT NOT NULL,
  observed          TEXT,
  page_url          TEXT,
  status            TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'not_a_bug', 'fixed')),
  first_seen_run_id TEXT NOT NULL,
  last_seen_run_id  TEXT NOT NULL,
  notes             TEXT
);
CREATE INDEX IF NOT EXISTS findings_project_status ON findings(project_id, status);

CREATE TABLE IF NOT EXISTS rule_coverage (
  run_id         TEXT NOT NULL REFERENCES runs(id),
  rule_id        TEXT NOT NULL,
  rule_text      TEXT,
  feature        TEXT,
  status         TEXT NOT NULL CHECK (status IN ('covered', 'not_planned', 'planned_but_dropped', 'planned_not_explored')),
  scenarios_json TEXT,
  PRIMARY KEY (run_id, rule_id)
);

CREATE TABLE IF NOT EXISTS verdicts (
  run_id       TEXT NOT NULL REFERENCES runs(id),
  scenario     TEXT NOT NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('pass', 'rework', 'reject')),
  journey_json TEXT,
  reasons_json TEXT,
  PRIMARY KEY (run_id, scenario)
);

CREATE TABLE IF NOT EXISTS terminals (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id     TEXT REFERENCES runs(id),
  title      TEXT,
  created_at TEXT NOT NULL,
  closed_at  TEXT
);
