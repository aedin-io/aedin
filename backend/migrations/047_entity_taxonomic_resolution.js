'use strict';

/**
 * Migration 047: entity taxonomic-resolution flag.
 *
 * Adds `entities.taxonomic_resolution` ('species' | 'genus_only' | 'collective'
 * | NULL) so the deliberate "Genus sp." fallback (extractor species-resolution
 * precedence rules 2 & 3) becomes FILTERABLE rather than graph noise. See
 * docs/common-name-species-resolution.md → "Follow-up C" + the mitigation
 * decision: keep the rule, but let consumers include/exclude genus-level
 * evidence and let the query layer roll it up under a species' genus.
 *
 * The classification is a pure function of scientific_name
 * (lib/taxonomic-resolution.js) — this migration backfills every existing
 * entity and the value is recomputed for new entities at write time by the
 * callers that create entities (promote-staged-claims.js / sync paths).
 *
 * Idempotent: column add is guarded by a PRAGMA check; the backfill is a
 * deterministic UPDATE that can be re-run safely.
 */

const { classifyTaxonomicResolution } = require('../lib/taxonomic-resolution');

function migrate(db) {
  const cols = db.prepare(`PRAGMA table_info(entities)`).all().map((c) => c.name);
  if (!cols.includes('taxonomic_resolution')) {
    db.exec(`ALTER TABLE entities ADD COLUMN taxonomic_resolution TEXT`);
    console.log('[migration-047] added entities.taxonomic_resolution');
  } else {
    console.log('[migration-047] entities.taxonomic_resolution already present');
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_taxonomic_resolution
           ON entities(taxonomic_resolution)`);

  // Backfill every entity from its scientific_name.
  const rows = db.prepare(`SELECT id, scientific_name FROM entities`).all();
  const upd = db.prepare(`UPDATE entities SET taxonomic_resolution = ? WHERE id = ?`);
  const tally = { species: 0, genus_only: 0, collective: 0, null: 0 };
  const run = db.transaction((all) => {
    for (const r of all) {
      const klass = classifyTaxonomicResolution(r.scientific_name);
      upd.run(klass, r.id);
      tally[klass === null ? 'null' : klass]++;
    }
  });
  run(rows);

  console.log(`[migration-047] backfilled ${rows.length} entities:`,
    JSON.stringify(tally));
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
