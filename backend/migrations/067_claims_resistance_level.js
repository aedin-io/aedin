'use strict';
/**
 * Migration 067 — claims.resistance_level: the controlled level for a
 * disease_resistance / pest_resistance claim (complete | strong | partial |
 * tolerant). NULL for every other claim. SQLite has no "ADD COLUMN IF NOT
 * EXISTS", so probe pragma_table_info first (idempotent).
 */
async function runMigration(db) {
  const cols = new Set((await db.all(`PRAGMA table_info(claims)`)).map(c => c.name));
  if (!cols.has('resistance_level')) await db.exec(`ALTER TABLE claims ADD COLUMN resistance_level TEXT`);
  console.log('[migration-067] claims.resistance_level ready.');
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
