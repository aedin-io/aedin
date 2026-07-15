'use strict';
/**
 * Migration 066 — entity_dedup_verdicts: one critic verdict per candidate from
 * the dedup review surface. Mirrors claim_critic_verdicts (025). The gate in
 * dedup-review-batch-import.js reads these to merge / reject / escalate.
 */
async function runMigration(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS entity_dedup_verdicts (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id           INTEGER NOT NULL REFERENCES entity_dedup_candidates(id),
      critic_name            TEXT NOT NULL,
      verdict                TEXT NOT NULL CHECK (verdict IN ('same','distinct','uncertain')),
      confidence             REAL,
      suggested_canonical_id INTEGER REFERENCES entities(id),
      reasoning              TEXT,
      model                  TEXT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (candidate_id, critic_name)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_edv_candidate ON entity_dedup_verdicts(candidate_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_edv_verdict ON entity_dedup_verdicts(verdict)`);
  console.log('[migration-066] entity_dedup_verdicts ready.');
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
