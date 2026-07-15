'use strict';
/**
 * Migration 057: predicted_interactions + predicted_interaction_evidence.
 *
 * The central object of the SBIR differentiator (schema-evolution roadmap item 1).
 * Predictions live in their OWN tables, never conflated with observed `claims` —
 * see docs/schema-evolution-for-prediction.md and docs/prediction-exposure-policy.md.
 *
 * predicted_interactions
 *   - the predicted edge (subject→object, category, region) + calibrated confidence
 *     with interval.
 *   - the GATE INPUTS that produced it (host_breadth_families, independent_regions,
 *     climate_match_score, taxonomic_distance, lifestage_compatible,
 *     negative_evidence_flag) are stored on the row so calibration can be re-fit
 *     WITHOUT regenerating predictions, and so each prediction is auditable.
 *   - `exposure` operationalizes the prediction-exposure policy in-schema:
 *       'public_demo' = a hand-curated Tier-1 demonstrator shown on the public site;
 *       'gated'       = Tier-2 paid-API bulk (default).
 *     Public surfaces filter `exposure='public_demo'`; the policy and the data can't
 *     drift. `data_tier='predicted'` marks the row as never-observed for any code
 *     that might union tiers.
 *
 * predicted_interaction_evidence
 *   - the generating evidence sub-graph: which observed claim_ids support each
 *     prediction, and in what role. Powers Tier-1 provenance display + the Tier-3
 *     one-click-to-evidence rule.
 *
 * Both tables ship EMPTY — the inference model is Phase I R&D. This migration only
 * lays the container so the model + serving gate can be built against a stable schema.
 *
 * Idempotent: CREATE TABLE / INDEX IF NOT EXISTS. Safe to re-run.
 */
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS predicted_interactions (
      id                     INTEGER PRIMARY KEY,
      subject_entity_id      INTEGER NOT NULL REFERENCES entities(id),
      object_entity_id       INTEGER NOT NULL REFERENCES entities(id),
      interaction_category   TEXT NOT NULL,
      region_scope           TEXT,
      data_tier              TEXT NOT NULL DEFAULT 'predicted',
      exposure               TEXT NOT NULL DEFAULT 'gated',   -- 'public_demo' | 'gated'
      confidence             REAL NOT NULL,
      confidence_lower       REAL,
      confidence_upper       REAL,
      model_version          TEXT NOT NULL,
      -- gate inputs (stored so calibration is auditable & re-fittable):
      host_breadth_families  INTEGER,
      independent_regions    INTEGER,
      climate_match_score    REAL,
      taxonomic_distance     REAL,
      lifestage_compatible   INTEGER,
      negative_evidence_flag INTEGER,
      generated_at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pi_subject  ON predicted_interactions(subject_entity_id);
    CREATE INDEX IF NOT EXISTS idx_pi_object   ON predicted_interactions(object_entity_id);
    CREATE INDEX IF NOT EXISTS idx_pi_exposure ON predicted_interactions(exposure);

    CREATE TABLE IF NOT EXISTS predicted_interaction_evidence (
      prediction_id  INTEGER NOT NULL REFERENCES predicted_interactions(id) ON DELETE CASCADE,
      claim_id       INTEGER NOT NULL,
      role           TEXT,                 -- 'host_link' | 'enemy_link' | 'cooccurrence'
      PRIMARY KEY (prediction_id, claim_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pie_prediction ON predicted_interaction_evidence(prediction_id);
  `);
  console.log('[migration-057] ensured predicted_interactions + predicted_interaction_evidence');
}

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
