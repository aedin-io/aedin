'use strict';

/**
 * Migration 029: claims.staging_id (link from promoted claims back to
 * their originating extraction_staging row).
 *
 * Why: claim_critic_verdicts is keyed by staging_id (per migration 025).
 * Without a back-link from claims, the multi-critic verdict trail can't
 * be displayed alongside a promoted claim. The admin review UI needs
 * this trail to give partners signal about WHY a claim was promoted
 * (which 2 critics ran, what they said).
 *
 * Backfill via content match (backend/backfill-claim-staging-link.js).
 * Future promotions: promote-staged-claims.js needs an update to write
 * staging_id directly when creating a claim row (TODO).
 */
async function runMigration(db) {
  const cols = await db.all(`PRAGMA table_info(claims)`);
  const has = cols.some(c => c.name === 'staging_id');
  if (!has) {
    await db.exec(`ALTER TABLE claims ADD COLUMN staging_id INTEGER`);
    console.log('[migration-029] claims.staging_id column added.');
  } else {
    console.log('[migration-029] claims.staging_id already exists — skipping ALTER.');
  }
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_staging_id ON claims(staging_id) WHERE staging_id IS NOT NULL`);
  console.log('[migration-029] idx_claims_staging_id ensured.');
}

module.exports = { runMigration };

if (require.main === module) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await runMigration(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
