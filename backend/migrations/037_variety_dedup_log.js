'use strict';

/**
 * Migration 037: variety_dedup_log (audit log for dedup-varieties.js).
 *
 * Append-only ledger of every variety merge. Preserves a paper trail so
 * a wrong merge can be detected and unwound, and so admins can see "this
 * canonical row was the result of merging N spellings."
 *
 * Companion to Phase Variety (spec 2026-05-11). dedup-varieties.js runs
 * nightly and writes to this table when it merges near-duplicate variety
 * entities within the same parent_entity_id.
 */
async function runMigration(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS variety_dedup_log (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_entity_id         INTEGER NOT NULL REFERENCES entities(id),
      merged_entity_id            INTEGER NOT NULL,
      merged_variety_name         TEXT NOT NULL,
      canonical_variety_name      TEXT NOT NULL,
      parent_entity_id            INTEGER NOT NULL REFERENCES entities(id),
      levenshtein_distance        INTEGER NOT NULL,
      claims_updated              INTEGER NOT NULL,
      entity_trait_claims_updated INTEGER NOT NULL,
      merged_at                   TEXT NOT NULL DEFAULT (datetime('now')),
      notes                       TEXT
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_vdl_canonical ON variety_dedup_log(canonical_entity_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_vdl_parent ON variety_dedup_log(parent_entity_id)`);
  console.log('[migration-037] variety_dedup_log created with 2 indexes.');
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
