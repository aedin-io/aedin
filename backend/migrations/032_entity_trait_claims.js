'use strict';

/**
 * Migration 032: entity_trait_claims (atomic env / biology readings).
 *
 * One row per assertion that organism X has trait Y = value Z, sourced from W.
 * Same shape as `claims` for interactions, but keyed on (entity, trait) instead
 * of (subject, object). Three value_* columns are typed-on-read via the
 * traits_vocabulary.value_kind for that trait_name.
 *
 * source_quote / source_page are NULL only for source_type='api_sync' rows
 * (the API record itself is the citation). Multi-critic gate writes
 * ai_vouch_status; review_status carries forward into the served corpus.
 */
async function runMigration(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS entity_trait_claims (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_id       INTEGER NOT NULL REFERENCES entities(id),
      trait_name      TEXT    NOT NULL,
      value_numeric   REAL,
      value_text      TEXT,
      value_json      TEXT,
      unit            TEXT,
      source_id       INTEGER NOT NULL REFERENCES sources(id),
      source_quote    TEXT,
      source_page     INTEGER,
      regional_context TEXT,
      review_status   TEXT DEFAULT 'unreviewed',
      reviewer_id     TEXT,
      reviewed_at     TEXT,
      ai_vouch_status TEXT,
      ai_vouch_note   TEXT,
      ai_vouched_by   TEXT,
      ai_vouched_at   TEXT,
      staging_id      INTEGER,
      superseded_by   INTEGER REFERENCES entity_trait_claims(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (entity_id, trait_name, source_id, source_quote)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_etc_entity_trait ON entity_trait_claims(entity_id, trait_name)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_etc_review       ON entity_trait_claims(review_status)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_etc_source       ON entity_trait_claims(source_id)`);
  console.log('[migration-032] entity_trait_claims created with 3 indexes.');
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
