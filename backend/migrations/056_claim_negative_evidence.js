'use strict';
/**
 * Migration 056: negative / absence evidence on claims.
 *
 * Adds two columns to `claims`:
 *   - observed_absence INTEGER NOT NULL DEFAULT 0
 *       1 = the interaction was looked for / tested and NOT observed (a true
 *       negative: non-host result, resistant cultivar, no-choice-trial rejection,
 *       field survey absence). 0 = positive presence (every existing row).
 *   - absence_basis TEXT
 *       How the absence was established. Controlled vocab (lenient — unrecognized
 *       values are nulled at promote time, not rejected):
 *         no_choice_trial | choice_trial | field_survey_absent |
 *         explicit_non_host | resistance_screen
 *
 * Why: the prediction layer (SBIR Phase I) needs a negative class to calibrate
 * against — a presence-only corpus cannot produce calibrated uncertainty. The
 * IPM/biocontrol literature already being ingested states many negatives
 * ("cultivar X resistant to Y", "parasitoid did not accept host Z"); this lets
 * the extractor record them faithfully instead of dropping them.
 *
 * Absences are force-set to applied_weight=0 at promote time so they never leak
 * into positive-interaction serving views (which filter applied_weight != 0).
 *
 * Idempotent: checks PRAGMA table_info before each ALTER. Safe to re-run.
 * See docs/schema-evolution-for-prediction.md item 2.
 */
function migrate(db) {
  const cols = db.prepare("PRAGMA table_info(claims)").all().map(c => c.name);

  if (!cols.includes('observed_absence')) {
    db.exec("ALTER TABLE claims ADD COLUMN observed_absence INTEGER NOT NULL DEFAULT 0");
    console.log('[migration-056] added claims.observed_absence');
  } else {
    console.log('[migration-056] claims.observed_absence already present');
  }

  if (!cols.includes('absence_basis')) {
    db.exec("ALTER TABLE claims ADD COLUMN absence_basis TEXT");
    console.log('[migration-056] added claims.absence_basis');
  } else {
    console.log('[migration-056] claims.absence_basis already present');
  }

  // Partial-style index for the prediction layer to pull negatives cheaply.
  // (SQLite has no IF NOT EXISTS issue here — CREATE INDEX IF NOT EXISTS is idempotent.)
  db.exec("CREATE INDEX IF NOT EXISTS idx_claims_absence ON claims(observed_absence)");
  console.log('[migration-056] ensured idx_claims_absence');
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
