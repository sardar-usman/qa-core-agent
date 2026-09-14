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
    // label nobody set. Rows are kept; a stored 'other' becomes NULL.
    version: 4,
    name: 'project environment nullable',
    up: (db) => {
      db.exec(`CREATE TABLE projects_v4 (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT,
        environment TEXT CHECK (environment IS NULL OR environment IN ('staging', 'production', 'other')),
        srs_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, default_ceiling_usd REAL, default_features TEXT, notes TEXT
      )`);
      db.exec(`INSERT INTO projects_v4 SELECT id, name, base_url, CASE WHEN environment = 'other' THEN NULL ELSE environment END,
               srs_path, created_at, updated_at, default_ceiling_usd, default_features, notes FROM projects`);
      db.exec('PRAGMA foreign_keys = OFF; DROP TABLE projects; ALTER TABLE projects_v4 RENAME TO projects; PRAGMA foreign_keys = ON;');
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
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    })();
    done.push(m.version);
  }
  return done;
}

export function schemaVersion(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null };
  return row.v ?? 0;
}
