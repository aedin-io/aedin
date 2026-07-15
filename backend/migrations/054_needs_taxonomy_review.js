'use strict';

/**
 * Migration 054 — entities.needs_taxonomy_review flag.
 *
 * Set to 1 by resolve-ingested-taxonomy.js when the hardened GBIF resolver
 * ABSTAINS on an entity (genus-name collision / low confidence) rather than
 * writing a guessed taxonomy. Distinguishes "tried, couldn't safely resolve"
 * from "never tried" (gbif_synced_at IS NULL), so the residue is queryable for
 * later Wikidata / manual resolution. Mirrors the existing needs_dedup flag.
 *
 * Idempotent. Runnable standalone: node migrations/054_needs_taxonomy_review.js
 */

function runMigration(db) {
  const cols = db.prepare('PRAGMA table_info(entities)').all().map(c => c.name);
  if (cols.includes('needs_taxonomy_review')) {
    console.log('[migration-054] needs_taxonomy_review already present');
    return;
  }
  db.exec('ALTER TABLE entities ADD COLUMN needs_taxonomy_review INTEGER');
  console.log('[migration-054] added entities.needs_taxonomy_review');
}

module.exports = { runMigration };

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  runMigration(db);
  db.close();
}
