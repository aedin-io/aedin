'use strict';

/**
 * Migration 055 — revision_log: a general, queryable audit trail of every
 * programmatic modification to a GloBI item (entity OR claim) field.
 *
 * Why: AgroEco is a *citable* knowledge base. Bulk corrections (GBIF taxonomy
 * re-resolution, bio_category reclassification, rank-floor quarantine, future
 * dedup merges) previously recorded old→new only in loose JSON backup files,
 * invisible to consumers. This table makes the change history queryable and
 * surfaceable on the entity/claim page ("phylum Mollusca → Tracheophyta, GBIF
 * accepted-name match, 2026-06-07"). Required BEFORE the GloBI --all taxonomy
 * run so every mutation is captured from the first row.
 *
 * Mirrors the existing claim_remap_log convention (before/after value, source,
 * applied_at), generalised across entities + claims via target_type.
 *
 * Write via lib/revision-log.js::logRevisions. Idempotent migration.
 */

function runMigration(db) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='revision_log'"
  ).get();
  if (exists) { console.log('[migration-055] revision_log already present'); return; }
  db.exec(`
    CREATE TABLE revision_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type  TEXT NOT NULL,            -- 'entity' | 'claim'
      target_id    INTEGER NOT NULL,
      field        TEXT NOT NULL,            -- e.g. 'bio_category','phylum','taxon_class','gbif_key','review_status'
      before_value TEXT,
      after_value  TEXT,
      changed_by   TEXT NOT NULL,            -- script, e.g. 'resolve-ingested-taxonomy.js'
      method       TEXT,                     -- e.g. 'gbif_accepted_name_match','curated_genus','rank_floor_quarantine'
      reason       TEXT,                     -- human-readable detail (match type/confidence/hint, etc.)
      applied_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_revlog_target ON revision_log(target_type, target_id);
    CREATE INDEX idx_revlog_applied ON revision_log(applied_at);
  `);
  console.log('[migration-055] created revision_log');
}

module.exports = { runMigration };

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  runMigration(db);
  db.close();
}
