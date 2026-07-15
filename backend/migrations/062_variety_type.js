'use strict';
// Variety #2b: variety_type discriminator (nomenclatural rank) on variety entities.
module.exports = function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(entities)').all().map(c => c.name);
  if (!cols.includes('variety_type')) {
    db.exec('ALTER TABLE entities ADD COLUMN variety_type TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_entities_variety_type ON entities(variety_type)');
};

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  module.exports(db);
  db.close();
  console.log('migration 062 applied');
}
