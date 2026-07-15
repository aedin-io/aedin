'use strict';

/**
 * Migration 048: GloBI source-citation columns on claims.
 *
 * GloBI ships per-record citation metadata (referenceCitation / referenceDoi /
 * referenceUrl). sync-globi.js now persists these into `interactions`, and
 * load-globi-claims.js collapses each deduplicated triple into a representative
 * citation. This migration adds the destination columns on `claims`:
 *   - reference_doi  TEXT   representative DOI
 *   - reference_url  TEXT   representative URL
 *   - source_count   INTEGER distinct underlying GloBI sources for the triple
 * (`reference_citation` already exists on claims — reused for the representative
 * citation text.)
 *
 * Idempotent: each ADD COLUMN is guarded by a PRAGMA check.
 */
function migrate(db) {
  const cols = db.prepare(`PRAGMA table_info(claims)`).all().map((c) => c.name);
  const add = (name, type) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE claims ADD COLUMN ${name} ${type}`);
      console.log(`[migration-048] added claims.${name}`);
    } else {
      console.log(`[migration-048] claims.${name} already present`);
    }
  };
  add('reference_doi', 'TEXT');
  add('reference_url', 'TEXT');
  add('source_count', 'INTEGER');
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
