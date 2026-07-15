'use strict';

/**
 * Migration 040: entities.agronomic_uses — JSON-array column of controlled-
 * vocabulary tags describing what each plant is used for.
 *
 * Source: Wikidata P366 ("has use"), pulled by sync-wikidata-uses.js. The
 * Wikidata label is mapped to our controlled vocabulary in
 * lib/agronomic-uses.js. Multi-valued (e.g. ["vegetable", "medicinal"]
 * for lavender) — agronomic + ornamental + medicinal categories cannot
 * be flattened to a single primary tag without losing ecological truth.
 *
 * Consumers:
 *   - /crop-web side panel (priority-ordered Crop/Ornamental/Medicinal/Wild tiers)
 *   - build-atlas-data.js (per-plant tags exposed in atlas.json)
 *   - Future ingestion: extractor.md may set this when literature explicitly
 *     describes a plant's use.
 *
 * Idempotent: PRAGMA-checked column add + CREATE INDEX IF NOT EXISTS.
 */

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(entities)').all();
  const has = cols.some(c => c.name === 'agronomic_uses');
  if (!has) {
    db.exec(`ALTER TABLE entities ADD COLUMN agronomic_uses TEXT`);
    console.log('[migration-040] added entities.agronomic_uses column');
  } else {
    console.log('[migration-040] entities.agronomic_uses already exists');
  }
  // Functional index on JSON path — speeds up `WHERE agronomic_uses LIKE '%medicinal%'`
  // style queries until SQLite JSON1 queries land in our query layer.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_agronomic_uses ON entities(agronomic_uses)`);
  console.log('[migration-040] index ready');
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
