'use strict';
/**
 * Migration 051: claims.chain_role — the edge's role in the crop-anchored chain.
 * 'crop_interaction' | 'biocontrol' | 'attractant' (NULL for non-scoped claims).
 * Set by load-globi-scoped.js. Idempotent.
 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(claims)').all().map(c => c.name);
  if (!cols.includes('chain_role')) {
    db.exec('ALTER TABLE claims ADD COLUMN chain_role TEXT');
    console.log('[migration-051] added claims.chain_role');
  } else {
    console.log('[migration-051] claims.chain_role already present');
  }
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
