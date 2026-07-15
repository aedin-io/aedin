'use strict';

/**
 * Migration 028: claims.interaction_type_globi (GloBI vocabulary alignment)
 *
 * Adds a new column holding the formal GloBI Relations Ontology term for
 * each claim (e.g. `pollinates`, `pathogenOf`, `parasitoidOf`, `preysOn`,
 * `eats`, `mutualistOf`, `interactsWith`, ...). This is the field that
 * gets exported when we eventually push claims back to GloBI; the
 * existing `interaction_type_raw` / `interaction_category` columns stay
 * unchanged for app-internal consumers.
 *
 * Backfill script: backend/backfill-globi-interaction-type.js applies a
 * heuristic mapping from our 8 coarse buckets to GloBI terms using subject
 * and object bio_category as disambiguation context. See
 * docs/globi-trefle-alignment.md for the full mapping table.
 *
 * Future extractions: the extractor.md prompt now requires the LLM to
 * output `interaction_type_globi` directly; promote-staged-claims.js
 * will need a small update (TODO) to copy the field from the staging
 * payload into this column. Until that update lands, future claims will
 * have NULL in this column and will need a re-run of the backfill.
 */
async function runMigration(db) {
  const cols = await db.all(`PRAGMA table_info(claims)`);
  const has = cols.some(c => c.name === 'interaction_type_globi');
  if (!has) {
    await db.exec(`ALTER TABLE claims ADD COLUMN interaction_type_globi TEXT`);
    console.log('[migration-028] claims.interaction_type_globi column added.');
  } else {
    console.log('[migration-028] claims.interaction_type_globi already exists — skipping ALTER.');
  }
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_claims_globi_type ON claims(interaction_type_globi) WHERE interaction_type_globi IS NOT NULL`);
  console.log('[migration-028] idx_claims_globi_type ensured.');
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
