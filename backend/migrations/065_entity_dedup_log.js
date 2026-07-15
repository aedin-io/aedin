// backend/migrations/065_entity_dedup_log.js
'use strict';
/**
 * Migration 065 — entity_dedup_log: reversibility record for entity merges
 * (merge-entity.js::mergeCandidate). Mirrors variety_dedup_log (037/038): the
 * exact per-field redirected FK ids make unmergeEntity faithful. Tombstone +
 * these ids = a clean undo.
 */
async function runMigration(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS entity_dedup_log (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id              INTEGER,
      canonical_entity_id       INTEGER NOT NULL,
      merged_entity_id          INTEGER NOT NULL,
      canonical_scientific_name TEXT,
      merged_scientific_name    TEXT,
      match_basis               TEXT,
      tier                      TEXT,
      redirected_claim_ids      TEXT,   -- JSON {subject:[ids], object:[ids]}
      redirected_trait_claim_ids TEXT,  -- JSON [ids]
      redirected_child_ids      TEXT,   -- JSON [ids]  (parent_entity_id re-points)
      claims_updated            INTEGER,
      trait_claims_updated      INTEGER,
      merged_at                 TEXT NOT NULL DEFAULT (datetime('now')),
      undone_at                 TEXT,
      notes                     TEXT
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_edl_merged ON entity_dedup_log(merged_entity_id)`);
  console.log('[migration-065] entity_dedup_log ready.');
}

module.exports = { runMigration };

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await runMigration(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
