'use strict';

/**
 * Migration 038 — Phase Provenance.
 *
 * Creates extractor_runs (per-extraction-event identity) and
 * extractor_lessons (corrections-feedback table). Adds run_id FK to
 * extraction_staging and critic_prompt_sha column to claim_critic_verdicts.
 */
async function runMigration(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS extractor_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id           INTEGER NOT NULL REFERENCES sources(id),
      extractor_md_sha    TEXT NOT NULL,
      prompt_bundle_sha   TEXT NOT NULL,
      extraction_model    TEXT NOT NULL,
      started_at          TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at        TEXT,
      status              TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','complete','failed')),
      rows_staged         INTEGER NOT NULL DEFAULT 0,
      notes               TEXT
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_extractor_runs_source ON extractor_runs(source_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_extractor_runs_md_sha ON extractor_runs(extractor_md_sha)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_extractor_runs_bundle ON extractor_runs(prompt_bundle_sha)`);

  const stagingCols = (await db.all(`PRAGMA table_info(extraction_staging)`)).map(c => c.name);
  if (!stagingCols.includes('run_id')) {
    await db.exec(`ALTER TABLE extraction_staging ADD COLUMN run_id INTEGER REFERENCES extractor_runs(id)`);
  }
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_extraction_staging_run ON extraction_staging(run_id)`);

  const ccvCols = (await db.all(`PRAGMA table_info(claim_critic_verdicts)`)).map(c => c.name);
  if (!ccvCols.includes('critic_prompt_sha')) {
    await db.exec(`ALTER TABLE claim_critic_verdicts ADD COLUMN critic_prompt_sha TEXT`);
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS extractor_lessons (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      field                TEXT NOT NULL,
      original_pattern     TEXT,
      corrected_pattern    TEXT NOT NULL,
      frequency            INTEGER NOT NULL DEFAULT 1,
      last_seen_at         TEXT NOT NULL DEFAULT (datetime('now')),
      status               TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','approved','rejected','manual','graduated')),
      graduated_at         TEXT,
      auto_approved_at     TEXT,
      reviewer_override_at TEXT,
      reviewer_override_by TEXT,
      notes                TEXT,
      UNIQUE (field, original_pattern, corrected_pattern)
    )
  `);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_extractor_lessons_field ON extractor_lessons(field)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_extractor_lessons_status ON extractor_lessons(status)`);

  console.log('[migration-038] extractor_runs + extractor_lessons + 2 column adds ready.');
}

module.exports = { runMigration };

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await runMigration(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
