import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * Versioned schema migrations for the dashboard index. `schema_version`
 * holds the applied versions; each migration runs once, in a transaction.
 * Version 1 is schema.sql (plan section 5). Later versions append here as
 * SQL strings or functions; never edit an applied migration in place.
 */

export const DEFAULT_DB_PATH = path.join('data', 'qa-core.sqlite');

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Migration {
  version: number;
  name: string;
  /**
   * A table rebuild (create new, copy, drop old, rename) on a table other
   * rows reference. The runner turns foreign keys OFF before the transaction
   * (the pragma is a no-op inside one), runs foreign_key_check after the
   * copy and fails loudly on any row, commits, then turns foreign keys ON.
   * Without this, dropping the old table fails with SQLITE_CONSTRAINT_FOREIGNKEY
   * on any database that has referencing rows.
   */
  rebuild?: boolean;
  up: (db: Database.Database) => void;
}

const schemaSql = (): string => fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: (db) => { db.exec(schemaSql()); },
  },
  {
    // runs.status gained 'legacy' and report_path became nullable for the
    // imported pre-v2 gateway records. SQLite cannot alter a CHECK, and the
    // index is rebuilt from disk anyway, so the derived tables are recreated
    // from the current schema.sql. terminals is kept (user data, none yet
    // reference runs that would vanish).
    version: 2,
    name: 'legacy run records',
    up: (db) => {
      db.exec('DROP TABLE IF EXISTS verdicts; DROP TABLE IF EXISTS rule_coverage; DROP TABLE IF EXISTS findings; DROP TABLE IF EXISTS runs;');
      db.exec(schemaSql());
    },
  },
  {
    // runs.shipped became nullable: a legacy record's scenario count is what
    // the run EXPLORED, so it lives in `generated` and shipped stays NULL.
    version: 3,
    name: 'legacy rows count explored, not shipped',
    up: (db) => {
      db.exec('DROP TABLE IF EXISTS verdicts; DROP TABLE IF EXISTS rule_coverage; DROP TABLE IF EXISTS findings; DROP TABLE IF EXISTS runs;');
      db.exec(schemaSql());
    },
  },
  {
    // projects.environment becomes nullable and loses its 'other' default:
    // the indexer never knew an environment, so the stored 'other' was a
    // label nobody set. Rows are kept; a stored 'other' becomes NULL. This
    // is a table rebuild: runs rows reference projects, so the runner wraps
    // it with foreign keys off (see Migration.rebuild). The order is the one
    // SQLite documents for a rebuild: create the new table under a temporary
    // name, copy, drop the old table, rename. Renaming the old table first
    // would rewrite the runs foreign key to point at the renamed table.
    version: 4,
    name: 'project environment nullable',
    rebuild: true,
    up: (db) => {
      db.exec(`CREATE TABLE projects_v4 (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT,
        environment TEXT CHECK (environment IS NULL OR environment IN ('staging', 'production', 'other')),
        srs_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, default_ceiling_usd REAL, default_features TEXT, notes TEXT
      )`);
      db.exec(`INSERT INTO projects_v4 SELECT id, name, base_url, CASE WHEN environment = 'other' THEN NULL ELSE environment END,
               srs_path, created_at, updated_at, default_ceiling_usd, default_features, notes FROM projects`);
      db.exec('DROP TABLE projects');
      db.exec('ALTER TABLE projects_v4 RENAME TO projects');
    },
  },
  {
    // findings.status becomes the dashboard's triage set (open / triaged /
    // fixed / wont-fix) and finding_runs records every run a finding was
    // seen in. Statuses and notes a person set are carried over: the old
    // values map onto the new set; nothing is reset.
    version: 5,
    name: 'finding triage statuses and finding_runs',
    rebuild: true,
    up: (db) => {
      db.exec(`CREATE TABLE findings_v5 (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), project_id TEXT NOT NULL REFERENCES projects(id),
        scenario TEXT NOT NULL, expected TEXT NOT NULL, observed TEXT, page_url TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'triaged', 'fixed', 'wont-fix')),
        first_seen_run_id TEXT NOT NULL, last_seen_run_id TEXT NOT NULL, notes TEXT
      )`);
      db.exec(`INSERT INTO findings_v5 SELECT id, run_id, project_id, scenario, expected, observed, page_url,
               CASE status WHEN 'new' THEN 'open' WHEN 'confirmed' THEN 'triaged' WHEN 'not_a_bug' THEN 'wont-fix' WHEN 'fixed' THEN 'fixed' ELSE 'open' END,
               first_seen_run_id, last_seen_run_id, notes FROM findings`);
      db.exec('DROP TABLE findings');
      db.exec('ALTER TABLE findings_v5 RENAME TO findings');
      db.exec('CREATE INDEX IF NOT EXISTS findings_project_status ON findings(project_id, status)');
      db.exec(`CREATE TABLE IF NOT EXISTS finding_runs (finding_id TEXT NOT NULL REFERENCES findings(id), run_id TEXT NOT NULL REFERENCES runs(id), PRIMARY KEY (finding_id, run_id))`);
      // Seed the run references we know about; the next index pass completes them.
      db.exec('INSERT OR IGNORE INTO finding_runs (finding_id, run_id) SELECT id, first_seen_run_id FROM findings');
      db.exec('INSERT OR IGNORE INTO finding_runs (finding_id, run_id) SELECT id, last_seen_run_id FROM findings');
    },
  },
  {
    // runs.source becomes nullable: a run that left no run-meta.json has an
    // unknown source and the indexer must never default it to 'cli'. Rows are
    // copied as they are; the next index pass rewrites each reported run's
    // source from its run-meta (or NULL) and legacy records become NULL.
    version: 6,
    name: 'run source nullable, never defaulted',
    rebuild: true,
    up: (db) => {
      db.exec(`CREATE TABLE runs_v6 (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), started_at TEXT, ended_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'stopped', 'empty', 'failed', 'legacy')),
        source TEXT CHECK (source IS NULL OR source IN ('cli', 'dashboard', 'mcp', 'telegram')),
        url TEXT, flags_json TEXT,
        planned INTEGER NOT NULL DEFAULT 0, generated INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, incomplete INTEGER NOT NULL DEFAULT 0,
        findings INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, stable INTEGER NOT NULL DEFAULT 0, flaky INTEGER NOT NULL DEFAULT 0, broken INTEGER NOT NULL DEFAULT 0,
        shipped INTEGER, cost_total REAL NOT NULL DEFAULT 0, cost_planner REAL NOT NULL DEFAULT 0, cost_explorer REAL NOT NULL DEFAULT 0, cost_critic REAL NOT NULL DEFAULT 0, cost_repair REAL NOT NULL DEFAULT 0,
        flake_rate REAL, report_path TEXT, zip_path TEXT, checkpoint_path TEXT, stopped_reason TEXT
      )`);
      db.exec(`INSERT INTO runs_v6 SELECT id, project_id, started_at, ended_at, status, source, url, flags_json, planned, generated, dropped, incomplete,
               findings, skipped, stable, flaky, broken, shipped, cost_total, cost_planner, cost_explorer, cost_critic, cost_repair, flake_rate, report_path, zip_path, checkpoint_path, stopped_reason FROM runs`);
      db.exec('DROP TABLE runs');
      db.exec('ALTER TABLE runs_v6 RENAME TO runs');
      db.exec('CREATE INDEX IF NOT EXISTS runs_project_started ON runs(project_id, started_at DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS runs_status ON runs(status)');
    },
  },
];

/** Open (creating the file and its directory if needed) and migrate. */
export function openDatabase(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Apply every migration newer than the recorded version. Returns the versions applied. */
export function migrate(db: Database.Database): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set((db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>).map((r) => r.version));
  const done: number[] = [];
  for (const m of MIGRATIONS.sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    const record = (): void => { db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString()); };
    if (m.rebuild) {
      // SQLite's table-rebuild procedure: foreign keys off OUTSIDE the
      // transaction, rebuild inside it, verify with foreign_key_check before
      // committing, foreign keys back on afterwards (also on failure).
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          m.up(db);
          const violations = db.pragma('foreign_key_check') as Array<Record<string, unknown>>;
          if (violations.length > 0) {
            throw new Error(`migration ${m.version} (${m.name}) left ${violations.length} foreign key violation(s): ${JSON.stringify(violations.slice(0, 5))}`);
          }
          record();
        })();
      } finally {
        db.pragma('foreign_keys = ON');
      }
    } else {
      db.transaction(() => { m.up(db); record(); })();
    }
    done.push(m.version);
  }
  return done;
}

export function schemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  return row.v ?? 0;
}
