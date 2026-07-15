'use strict';
/**
 * Migration 064 — add entity_dedup_candidates.tier (auto_safe|needs_review|domain),
 * populated by tier-candidates.js via lib/dedup-tier.js. SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so probe pragma_table_info first (idempotent).
 */
async function runMigration(db) {
  const cols = new Set((await db.all(`PRAGMA table_info(entity_dedup_candidates)`)).map(c => c.name));
  if (!cols.has('tier')) await db.exec(`ALTER TABLE entity_dedup_candidates ADD COLUMN tier TEXT`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_edc_tier ON entity_dedup_candidates(tier)`);
  console.log('[migration-064] entity_dedup_candidates.tier ready.');
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
