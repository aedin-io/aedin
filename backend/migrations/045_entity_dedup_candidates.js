'use strict';

/**
 * Migration 045 — Phase Grounding (entity dedup).
 *
 * entity_dedup_candidates: nightly sweep-entity-dedup.js flags typo-duplicate
 * pairs here (status='pending') for admin review. merge-entity.js applies an
 * approved merge and sets the loser's entities.merged_into_entity_id pointer
 * (tombstone — row retained for reversibility, read paths filter it out).
 */
async function runMigration(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS entity_dedup_candidates (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_a_id            INTEGER NOT NULL REFERENCES entities(id),
      entity_b_id            INTEGER NOT NULL REFERENCES entities(id),
      genus                  TEXT NOT NULL,
      levenshtein_distance   INTEGER NOT NULL,
      match_basis            TEXT NOT NULL,
      suggested_canonical_id INTEGER REFERENCES entities(id),
      status                 TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','merged')),
      flagged_at             TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at            TEXT,
      reviewer_id            TEXT,
      notes                  TEXT,
      UNIQUE (entity_a_id, entity_b_id)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_edc_status ON entity_dedup_candidates(status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_edc_genus ON entity_dedup_candidates(genus)`);

  const entityCols = (await db.all(`PRAGMA table_info(entities)`)).map(c => c.name);
  if (!entityCols.includes('merged_into_entity_id')) {
    await db.exec(`ALTER TABLE entities ADD COLUMN merged_into_entity_id INTEGER REFERENCES entities(id)`);
  }
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_merged_into ON entities(merged_into_entity_id)`);

  console.log('[migration-045] entity_dedup_candidates + entities.merged_into_entity_id ready.');
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
