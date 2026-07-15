'use strict';
// Multilingual common-names asset (entity_common_names) + retire the vestigial,
// wrongly-keyed species_common_names + add a resume marker for the backfill.
module.exports = function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_common_names (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id    INTEGER NOT NULL,
      name         TEXT NOT NULL,
      language     TEXT NOT NULL,
      source       TEXT NOT NULL,
      source_ref   TEXT,
      is_preferred INTEGER NOT NULL DEFAULT 0,
      confidence   REAL DEFAULT 0.8,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ecn_dedupe ON entity_common_names(entity_id, language, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_ecn_entity   ON entity_common_names(entity_id);
    CREATE INDEX IF NOT EXISTS idx_ecn_language ON entity_common_names(language);
    CREATE INDEX IF NOT EXISTS idx_ecn_name     ON entity_common_names(name COLLATE NOCASE);
    DROP TABLE IF EXISTS species_common_names;
  `);
  const cols = db.prepare('PRAGMA table_info(entities)').all().map(c => c.name);
  if (!cols.includes('common_names_synced_at')) {
    db.exec('ALTER TABLE entities ADD COLUMN common_names_synced_at TEXT');
  }
};

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  module.exports(db);
  db.close();
}
