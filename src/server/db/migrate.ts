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

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up: (db) => { db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8')); },
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
