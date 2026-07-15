'use strict';

/**
 * Migration 050: entities.scope_tier — crop-anchored chain depth.
 * 0=crop, 1=crop interactor, 2=biocontrol, 3=attractor, NULL=out of scope.
 * Populated by load-globi-scoped.js. Idempotent.
 */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(entities)').all().map(c => c.name);
  if (!cols.includes('scope_tier')) {
    db.exec('ALTER TABLE entities ADD COLUMN scope_tier INTEGER');
    console.log('[migration-050] added entities.scope_tier');
  } else {
    console.log('[migration-050] entities.scope_tier already present');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_entities_scope_tier ON entities(scope_tier)');
}
module.exports = migrate;
if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db); db.close();
}
