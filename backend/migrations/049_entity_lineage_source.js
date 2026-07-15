'use strict';

/**
 * Migration 049 — Phase GloBI-Taxonomy (Workstream A).
 * Adds entities.lineage_source ('globi' | 'gbif_api' | null) recording where an
 * entity's lineage + gbif_key came from. Additive; leaves taxonomic_resolution untouched.
 */
async function runMigration(db) {
  const cols = (await db.all(`PRAGMA table_info(entities)`)).map(c => c.name);
  if (!cols.includes('lineage_source')) {
    await db.exec(`ALTER TABLE entities ADD COLUMN lineage_source TEXT`);
  }
  console.log('[migration-049] entities.lineage_source ready.');
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
