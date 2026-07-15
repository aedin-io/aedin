'use strict';

/**
 * Migration 038: staging_field_corrections table.
 *
 * Records partner per-field corrections on extraction_staging rows.
 * - action='correct'  → field is right as-is (positive signal)
 * - action='edited'   → field was wrong; corrected_value supplied
 * - action='rejected' → field was wrong; no correction (just flagged)
 *
 * UNIQUE(staging_id, field_path) lets us upsert — partner can change their
 * per-field decision without piling up duplicate rows.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
 */

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS staging_field_corrections (
      id INTEGER PRIMARY KEY,
      staging_id INTEGER NOT NULL REFERENCES extraction_staging(id),
      field_path TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('correct','edited','rejected')),
      original_value TEXT,
      corrected_value TEXT,
      note TEXT,
      reviewer_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(staging_id, field_path)
    );
    CREATE INDEX IF NOT EXISTS idx_sfc_staging ON staging_field_corrections(staging_id);
    CREATE INDEX IF NOT EXISTS idx_sfc_field ON staging_field_corrections(field_path);
  `);
  console.log('[migration-038] staging_field_corrections table + indexes ready');
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
