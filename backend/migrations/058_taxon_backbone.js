'use strict';
/**
 * Migration 058: taxon_backbone — a clean, normalized GBIF taxonomic backbone.
 *
 * Schema-evolution roadmap item 4. The link-prediction model leans on "taxonomic
 * distance governs transitive inference", but entities.phylum / taxon_class carry
 * documented corruption from genus-name collisions (Ficus→Mollusca,
 * Cyathus→Arthropoda — see CLAUDE.md "Corrupt entities.phylum" follow-on). A bad
 * backbone → a bad distance prior → wrong predictions. This table is the trustworthy
 * source of truth for higher taxonomy + ancestry, keyed to GBIF accepted-name usage
 * keys, so taxonomic distance is a computed lookup over parent_key (or a prefix-diff
 * over the materialized rank_path) rather than a string comparison against the
 * possibly-wrong entities columns.
 *
 *   gbif_key   — GBIF accepted-name usageKey (PK)
 *   rank       — kingdom..species
 *   parent_key — parent usageKey (self-FK); NULL at kingdom root
 *   canonical  — canonical scientific name at this node
 *   rank_path  — materialized ancestor chain (e.g. "Animalia>Arthropoda>Insecta>...")
 *                for O(1) distance via longest-common-prefix
 *
 * entities.gbif_key already exists (the FK hook); NO ALTER on entities here. The
 * backfill (entities.gbif_key → taxon_backbone) + distance helper are the heavier
 * follow-on jobs (GBIF re-resolution under the heavy-job-safety harness) and are NOT
 * part of this container migration. Ships EMPTY.
 *
 * Idempotent: CREATE ... IF NOT EXISTS. Safe to re-run.
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS taxon_backbone (
      gbif_key    INTEGER PRIMARY KEY,
      rank        TEXT NOT NULL,
      parent_key  INTEGER REFERENCES taxon_backbone(gbif_key),
      canonical   TEXT NOT NULL,
      rank_path   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tb_parent    ON taxon_backbone(parent_key);
    CREATE INDEX IF NOT EXISTS idx_tb_canonical ON taxon_backbone(canonical);
  `);
  console.log('[migration-058] ensured taxon_backbone');
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
