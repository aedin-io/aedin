import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

// Build-only: which SQLite file the static prerender reads. Default is the live
// working DB; a deploy (AEDIN_USE_PUBLISHED=1) reads the frozen snapshot from
// `npm run freeze-db` so a code deploy can't pick up a concurrent session's
// in-progress edits. Mirrors web/scripts/lib/resolve-build-db.cjs (db.ts is
// inlined to avoid pulling a CJS helper through Vite). This module is build-only
// — the edge worker serves entities from D1 via queries-d1.ts, not from here.
function resolveDbPath(): string {
  const root = path.join(process.cwd(), '..');
  const live = path.join(root, 'backend', 'aedin.sqlite');
  if (process.env.AEDIN_USE_PUBLISHED !== '1') return live;
  const snap = process.env.AEDIN_DB_PATH || path.join(root, 'backend', 'aedin-published.sqlite');
  if (!fs.existsSync(snap)) {
    throw new Error(
      `[db] AEDIN_USE_PUBLISHED=1 but no published snapshot at ${snap}. ` +
        'Run `npm run freeze-db` after your D1 data publish, then build for deploy.',
    );
  }
  return snap;
}

const DB_PATH = resolveDbPath();

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  // No journal_mode pragma: this is a read-only connection (journal mode governs
  // writes only). Setting WAL was a silent no-op on the already-WAL live DB, but
  // throws "attempt to write a readonly database" on a non-WAL file such as the
  // frozen DELETE-mode snapshot. Reads work regardless of the file's mode.
  _db.pragma('busy_timeout = 5000');
  return _db;
}
