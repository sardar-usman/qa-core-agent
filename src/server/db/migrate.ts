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
