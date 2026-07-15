'use strict';

/**
 * Migration 030: extractor_corrections table.
 *
 * Captures human-corrected (claim, source_quote, etc.) overrides for
 * promoted claims. Each row pairs the original LLM-extracted value with
 * the human-corrected value for an audit trail and as future few-shot
 * fodder for re-running the extractor.
 *
 * Triggered by the Edit action in the admin review UI: when a partner
 * spots a claim whose interpretation is wrong (but the source quote is
 * right) they can fix the structured fields without re-extracting.
 *
 * Schema-shape rationale:
 *   - claim_id is FK to claims.id. We don't cascade delete because
 *     correction history is auditable (a deleted claim's corrections
 *     remain visible).
 *   - field is the column name being corrected (e.g.
 *     'interaction_type_globi', 'subject_entity_id', 'effect_direction').
 *   - original / corrected are stringified values. JSON for complex
 *     types if needed, but most fields are scalars.
 *   - reviewer_id is the same free-text identity field as
 *     claims.reviewer_id (no auth yet).
 */
async function runMigration(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS extractor_corrections (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      claim_id    INTEGER NOT NULL REFERENCES claims(id),
      field       TEXT    NOT NULL,
      original    TEXT,
      corrected   TEXT,
      reviewer_id TEXT,
      reasoning   TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_extractor_corrections_claim ON extractor_corrections(claim_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_extractor_corrections_field ON extractor_corrections(field)`);
  console.log('[migration-030] extractor_corrections table + 2 indexes ensured.');
}

module.exports = { runMigration };

if (require.main === module) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await runMigration(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
