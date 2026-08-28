'use strict';
/**
 * Migration 077: entities.ott_id + entities.ott_status.
 *
 * WHY: AEDIN has no taxonomic tree — only six denormalized rank columns per
 * entity, with no parent-child edges. These two columns are the join to the
 * Open Tree Taxonomy backbone (backend/ott.sqlite), which supplies the tree.
 *
 * This migration adds columns ONLY. The resolution pass that fills them writes
 * nothing else; the existing taxonomy columns are left untouched by design
 * (see docs/superpowers/specs/2026-08-21-ott-taxonomic-backbone-design.md §3).
 *
 * ott_status vocabulary:
 *   resolved_local      matched against the pinned OTT 3.7 dump — reproducible
 *   resolved_tnrs       matched via the live TNRS API — NOT reproducible offline
 *   unmatched           no candidate in either taxonomy.tsv or synonyms.tsv
 *   ambiguous           several candidates, curated genus lists could not decide
 *   hint_contradiction  the single candidate contradicts a curated genus hint
 *
 * Idempotent: checks PRAGMA table_info before each ADD COLUMN.
 */
function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(entities)').all().map(c => c.name));
  let added = 0;
  if (!cols.has('ott_id')) {
    db.exec('ALTER TABLE entities ADD COLUMN ott_id INTEGER');
    added++;
  }
  if (!cols.has('ott_status')) {
    db.exec('ALTER TABLE entities ADD COLUMN ott_status TEXT');
    added++;
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_entities_ott_id ON entities(ott_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_entities_ott_status ON entities(ott_status)');
  console.log(`[migration-077] added ${added} column(s) + 2 indexes`);
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(process.env.AEDIN_CORPUS_DB || CORPUS_DB);
  migrate(db);
  db.close();
}
