'use strict';
// Variety #4: GRIN-germplasm staging table (scrape target; provenance record).
module.exports = function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grin_varieties (
      grin_accession    TEXT PRIMARY KEY,
      parent_entity_id  INTEGER,
      plant_name        TEXT,
      origin            TEXT,
      improvement_level TEXT,
      narrative         TEXT,
      scraped_at        TEXT DEFAULT (datetime('now')),
      promoted_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_grin_parent   ON grin_varieties(parent_entity_id);
    CREATE INDEX IF NOT EXISTS idx_grin_promoted ON grin_varieties(promoted_at);
  `);
};

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  module.exports(db);
  db.close();
  console.log('migration 063 applied');
}
