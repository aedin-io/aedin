/**
 * Migration 019: Persist raw_score and ceiling_hit on companion_scores
 *
 * Adds two columns so downstream consumers can distinguish a pair that just
 * crossed +1.0 from a pair that hit a wide ceiling (e.g. raw 1.4 clamped to 1.0).
 *
 *   raw_score    REAL    — pre-clamp composite (e.g. 1.4)
 *   ceiling_hit  INTEGER — 1 if abs(raw_score) > 1, else 0
 *
 * Usage:
 *   node migrations/019_score_raw_and_ceiling.js
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

const NEW_COLUMNS = [
  ['raw_score',   'REAL'],
  ['ceiling_hit', 'INTEGER DEFAULT 0'],
];

async function runMigration(db) {
  console.log('Running migration 019_score_raw_and_ceiling...\n');

  const existing = await db.all('PRAGMA table_info(companion_scores)');
  const existingNames = new Set(existing.map(c => c.name));

  let added = 0;
  for (const [name, type] of NEW_COLUMNS) {
    if (existingNames.has(name)) continue;
    await db.exec(`ALTER TABLE companion_scores ADD COLUMN ${name} ${type}`);
    added++;
  }
  console.log(`  + ${added} new columns added to companion_scores`);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cs_ceiling_hit ON companion_scores(ceiling_hit);
  `);
  console.log('  + ceiling_hit index');

  console.log('\nMigration 019 complete.');
}

if (require.main === module) {
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL;');
    try {
      await runMigration(db);
    } finally {
      await db.close();
    }
  })().catch(err => { console.error('Migration 019 failed:', err); process.exit(1); });
}

module.exports = { runMigration };
