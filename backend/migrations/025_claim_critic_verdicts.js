'use strict';

/**
 * Migration 025: claim_critic_verdicts (Phase 2.5)
 *
 * Adds the per-critic verdict table that the multi-critic consensus pipeline
 * (docs/phased-roadmap-ai-only.md "Phase 2.5") writes to and that
 * promote-staged-claims.js (lines 195-200) already JOINs against.
 *
 * One row per (staged_claim, critic) pair. The aggregator computes consensus
 * over these rows (≥2 'plausible', 0 'implausible' → 'ai_reviewed'
 * promotion gate). Re-running vouching is idempotent thanks to the UNIQUE
 * (staging_id, critic_name) constraint — the dispatcher uses INSERT OR REPLACE
 * so a later, better verdict can overwrite an earlier one for the same critic.
 *
 * Schema-shape rationale:
 *   - staging_id is FK to extraction_staging.id (the claim being vouched).
 *   - critic_name is one of: 'extractor-vouch' (Haiku first-pass, also written
 *     here for cross-critic agreement-matrix calibration), 'agroecologist',
 *     'entomologist', 'plant-pathologist', 'soil-scientist', 'horticulturist',
 *     'wildlife-ecologist'. (verdict column is free-text TEXT — no CHECK
 *     constraint, so adding a critic needs no schema change.)
 *   - verdict is the same 4-class vocabulary as ai_vouch_status:
 *     plausible | implausible | uncertain | out_of_scope.
 *   - model captures which Anthropic model produced the verdict (e.g.
 *     'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'). Useful for the
 *     calibration matrix and post-hoc cost accounting.
 *   - reasoning carries the one-sentence rationale from the critic. Bounded by
 *     the prompt contract to ~30 words; not enforced at the schema level.
 */
async function runMigration(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS claim_critic_verdicts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      staging_id  INTEGER NOT NULL REFERENCES extraction_staging(id) ON DELETE CASCADE,
      critic_name TEXT    NOT NULL,
      verdict     TEXT    NOT NULL CHECK (verdict IN ('plausible','implausible','uncertain','out_of_scope')),
      reasoning   TEXT,
      model       TEXT,
      vouched_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE (staging_id, critic_name)
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_ccv_staging ON claim_critic_verdicts(staging_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_ccv_critic  ON claim_critic_verdicts(critic_name)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_ccv_verdict ON claim_critic_verdicts(verdict)`);

  console.log('[migration-025] claim_critic_verdicts created with 3 indexes.');
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
