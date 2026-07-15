'use strict';

/**
 * Migration 038: reversibility columns for variety_dedup_log.
 *
 * #2c makes variety merges human-gated AND reversible. A faithful Undo needs
 * the exact redirected FK ids (per field), not just counts. SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so we probe pragma_table_info first (idempotent).
 */
async function runMigration(db) {
  const cols = new Set((await db.all(`PRAGMA table_info(variety_dedup_log)`)).map(c => c.name));
  const add = async (name, decl) => {
    if (!cols.has(name)) await db.exec(`ALTER TABLE variety_dedup_log ADD COLUMN ${name} ${decl}`);
  };
  await add('redirected_claim_ids', 'TEXT');        // JSON {subject:[ids], object:[ids]}
  await add('redirected_trait_claim_ids', 'TEXT');  // JSON [ids]
  await add('undone_at', 'TEXT');                    // set when a merge is reversed
  console.log('[migration-038] variety_dedup_log reversibility columns ensured.');
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
