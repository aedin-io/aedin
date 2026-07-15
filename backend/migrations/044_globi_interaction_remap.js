'use strict';

/**
 * Migration 044: GloBI semantic-remap audit log + two new interaction categories.
 *
 * Phase B of the GloBI semantic cleanup (docs/globi-semantic-cleanup-plan.md +
 * docs/globi-interaction-audit.md). The correction RULES live in code
 * (lib/globi-interaction-remap.js) — this migration provides:
 *
 *   1. `claim_remap_log` — an audit trail so every correction Phase C applies
 *      is recorded (claim_id, rule_name, before/after category + direction,
 *      whether subject/object were flipped). Makes the whole sweep reversible
 *      and inspectable.
 *
 *   2. Two new interaction_category enum values, added to the conceptual enum
 *      documented in lib/interaction-vocabulary.js:
 *        - `predation`     — a predator preying on prey (preysOn was being
 *          mis-mapped to herbivory; predation is the correct category)
 *        - `gall_formation` — gall-inducing arthropods (Cynipidae, Cecidomyiidae)
 *          on plants; neither pollination nor generic herbivory
 *      The enum is not DB-enforced via CHECK (interaction_category is a plain
 *      TEXT column), so "adding" a value means updating the source-of-truth
 *      list in lib/interaction-vocabulary.js — done in the same commit. This
 *      migration just records the intent + verifies no stale CHECK constraint
 *      blocks the new values.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS; re-running is a no-op.
 */

function migrate(db) {
  const apply = db.transaction(() => {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS claim_remap_log (
        id INTEGER PRIMARY KEY,
        claim_id INTEGER NOT NULL,
        rule_name TEXT NOT NULL,
        action TEXT NOT NULL,                 -- 'recategorize' | 'flip' | 'unclassify'
        before_category TEXT,
        after_category TEXT,
        before_direction TEXT,
        after_direction TEXT,
        flipped INTEGER NOT NULL DEFAULT 0,   -- 1 if subject/object were swapped
        confidence_modifier REAL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`CREATE INDEX IF NOT EXISTS idx_claim_remap_log_claim ON claim_remap_log(claim_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_claim_remap_log_rule ON claim_remap_log(rule_name)`).run();

    console.log('[migration-044] created claim_remap_log + indexes');
  });
  apply();

  // Sanity: confirm claims.interaction_category has no CHECK constraint that
  // would reject 'predation' / 'gall_formation'. (It's a plain TEXT column.)
  const ddl = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='claims'`
  ).get();
  if (ddl && /interaction_category[^,]*CHECK/i.test(ddl.sql)) {
    console.warn('[migration-044] WARNING: claims.interaction_category appears to carry a CHECK constraint — ' +
      'new categories predation/gall_formation may be rejected. Inspect before running Phase C.');
  } else {
    console.log('[migration-044] verified: no CHECK constraint blocks new interaction_category values');
  }

  console.log('[migration-044] done. New categories predation/gall_formation registered in lib/interaction-vocabulary.js.');
}

module.exports = migrate;

if (require.main === module) {
  const { RAW_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(RAW_DB);
  migrate(db);
  db.close();
}
