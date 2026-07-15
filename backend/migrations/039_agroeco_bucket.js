'use strict';

/**
 * Migration 039: entities.agroeco_bucket derived column.
 *
 * Adds a coarse agroecology-canonical bucket on top of the ~20 primary_role
 * values that already exist. Used by /atlas (web/src/pages/atlas.astro) as
 * one of the three combinable filter axes (bio_category × agroeco_bucket ×
 * primary_role). Mapping authority is backend/lib/agroeco-bucket.js — this
 * migration reads from there so the two never drift.
 *
 * Idempotent:
 *  - ALTER TABLE adds the column only if missing (checked via PRAGMA).
 *  - UPDATE overwrites — safe to re-run when BUCKET_MAP changes.
 *
 * Coverage at the time of writing: 7 buckets, ~180K of 194K entities mapped
 * (~92.5%). Unmapped roles (unclassified, neutral) get NULL agroeco_bucket
 * and fall outside the agroeco-bucket filter — still reachable via
 * bio_category or primary_role chips.
 */

const { BUCKET_MAP } = require('../lib/agroeco-bucket');

function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(entities)').all();
  const hasCol = cols.some(c => c.name === 'agroeco_bucket');
  if (!hasCol) {
    db.exec(`ALTER TABLE entities ADD COLUMN agroeco_bucket TEXT`);
    console.log('[migration-039] added entities.agroeco_bucket column');
  } else {
    console.log('[migration-039] entities.agroeco_bucket already exists; will backfill anyway');
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_agroeco_bucket ON entities(agroeco_bucket)`);

  const tx = db.transaction(() => {
    db.exec(`UPDATE entities SET agroeco_bucket = NULL`);
    const update = db.prepare(`UPDATE entities SET agroeco_bucket = ? WHERE primary_role = ?`);
    let touched = 0;
    for (const [role, bucket] of Object.entries(BUCKET_MAP)) {
      const r = update.run(bucket, role);
      touched += r.changes;
    }
    return touched;
  });
  const touched = tx();
  console.log(`[migration-039] backfilled agroeco_bucket on ${touched} rows`);

  const summary = db.prepare(`
    SELECT agroeco_bucket, COUNT(*) AS n
    FROM entities
    GROUP BY agroeco_bucket
    ORDER BY n DESC
  `).all();
  console.log('[migration-039] distribution:');
  for (const row of summary) {
    console.log(`  ${(row.agroeco_bucket || '(null)').padEnd(12)} ${row.n}`);
  }
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
