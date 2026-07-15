'use strict';

/**
 * Migration 031: sources.added_by (uploader tracking).
 *
 * Phase-4 admin Ingest sub-tabs need to show "who added this source"
 * alongside the date in the source-picker dropdown subtext. Adds a
 * nullable TEXT column. Existing rows stay NULL — they were all
 * CLI-ingested by the owner pre-2026-05-07; the admin UI renders
 * NULL as "owner" for those.
 *
 * Future Upload UI (next chunk) will populate this column from the
 * Reviewer field at upload time.
 */
async function runMigration(db) {
  const cols = await db.all(`PRAGMA table_info(sources)`);
  const has = cols.some(c => c.name === 'added_by');
  if (!has) {
    await db.exec(`ALTER TABLE sources ADD COLUMN added_by TEXT`);
    console.log('[migration-031] sources.added_by column added.');
  } else {
    console.log('[migration-031] sources.added_by already exists — skipping ALTER.');
  }
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
