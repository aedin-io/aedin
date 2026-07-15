'use strict';

/**
 * Migration 037: rename review_status='ai_consensus_verified' → 'ai_reviewed'
 * in the two live claim tables: claims + entity_trait_claims.
 *
 * Staging-side statuses (pending/approved/rejected/flagged/promoted) are
 * unchanged. 'ai_vouched' (single-critic state on entity_trait_claims) is
 * unchanged — it is a different, earlier state in the pipeline.
 *
 * Idempotent: the WHERE clause only matches the old string, so re-running
 * after the rename is already complete is a no-op (0 rows changed).
 */

async function runMigration(db) {
  const tables = ['claims', 'entity_trait_claims'];
  let total = 0;
  for (const t of tables) {
    // Tables may not exist in older test databases — guard.
    const exists = await db.get(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`, t
    );
    if (!exists) {
      console.log(`[migration-037] ${t}: table not found, skipping`);
      continue;
    }
    const result = await db.run(
      `UPDATE ${t} SET review_status='ai_reviewed' WHERE review_status='ai_consensus_verified'`
    );
    total += result.changes;
    console.log(`[migration-037] ${t}: renamed ${result.changes} rows`);
  }
  console.log(`[migration-037] total renamed: ${total}`);
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
