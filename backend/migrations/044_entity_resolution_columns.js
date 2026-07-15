'use strict';

/**
 * Migration 044 — Phase Grounding (PostRAG).
 *
 * Adds entity-resolution columns written by postrag-resolve.js (staging,
 * forward path) and postrag-backfill.js (claims, retroactive audit).
 * Additive only — no existing data touched.
 */
async function runMigration(db) {
  const stagingCols = (await db.all(`PRAGMA table_info(extraction_staging)`)).map(c => c.name);
  if (!stagingCols.includes('entity_resolution_status')) {
    await db.exec(`ALTER TABLE extraction_staging ADD COLUMN entity_resolution_status TEXT`);
  }
  if (!stagingCols.includes('resolved_subject_entity_id')) {
    await db.exec(`ALTER TABLE extraction_staging ADD COLUMN resolved_subject_entity_id INTEGER REFERENCES entities(id)`);
  }
  if (!stagingCols.includes('resolved_object_entity_id')) {
    await db.exec(`ALTER TABLE extraction_staging ADD COLUMN resolved_object_entity_id INTEGER REFERENCES entities(id)`);
  }

  const claimsCols = (await db.all(`PRAGMA table_info(claims)`)).map(c => c.name);
  if (!claimsCols.includes('entity_resolution_status')) {
    await db.exec(`ALTER TABLE claims ADD COLUMN entity_resolution_status TEXT`);
  }

  console.log('[migration-044] entity resolution columns added to extraction_staging + claims.');
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
