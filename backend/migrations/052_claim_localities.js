'use strict';
/**
 * Migration 052: claim_localities — junction of a claim to each country/subdivision
 * it was reported in. Populated for tier2_globi claims by load-globi-scoped.js
 * (one claim aggregates occurrences across many countries). Literature claims keep
 * their single regional_context. Idempotent.
 */
function migrate(db) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='claim_localities'"
  ).get();
  if (exists) {
    console.log('[migration-052] claim_localities already present');
    return;
  }
  db.exec(`
    CREATE TABLE claim_localities (
      claim_id     INTEGER NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      country      TEXT NOT NULL,
      subdivision  TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (claim_id, country, subdivision)
    );
    CREATE INDEX idx_cl_country ON claim_localities(country, subdivision);
    CREATE INDEX idx_cl_claim   ON claim_localities(claim_id);
  `);
  console.log('[migration-052] created claim_localities');
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
