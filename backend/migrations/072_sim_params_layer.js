'use strict';
/**
 * Migration 072 — create the sim-params layer: four typed tables the
 * polyculture/agroforestry simulator reads. DERIVED/DESIGNED modelling
 * artifacts, strictly separate from the provenance-gated corpus; every row
 * carries a param_status envelope. Populated by backend/derive-sim-params.js.
 * Idempotent; forward-only (migrate.down drops for manual reverse). Follows 071.
 * Spec: docs/superpowers/specs/2026-07-02-sim-params-layer-design.md
 */
const ENVELOPE = `
  param_status TEXT NOT NULL CHECK(param_status IN ('derived','designed','override')),
  derivation_method TEXT,
  model_ref TEXT,
  inputs_json TEXT,
  confidence TEXT CHECK(confidence IN ('high','medium','low')),
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  generated_run_id TEXT`;

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sim_plant_growth (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER NOT NULL UNIQUE,
      life_form TEXT,
      time_unit TEXT CHECK(time_unit IN ('days','years')),
      max_height_cm REAL, max_spread_cm REAL, max_root_depth_cm REAL, root_pattern TEXT,
      days_to_maturity REAL,
      height_curve_model TEXT, height_inflection REAL, height_rate_k REAL,
      spread_curve_model TEXT, spread_inflection REAL, spread_rate_k REAL,
      canopy_layer TEXT, seasonality TEXT, light_extinction_coeff REAL,
      ${ENVELOPE}
    );
    CREATE TABLE IF NOT EXISTS sim_pest_dynamics (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER NOT NULL UNIQUE,
      generations_per_year REAL, onset_season TEXT, onset_months TEXT,
      pressure_buildup_rate REAL, peak_pressure REAL, overwintering TEXT,
      ${ENVELOPE}
    );
    CREATE TABLE IF NOT EXISTS sim_biocontrol (
      id INTEGER PRIMARY KEY,
      claim_id INTEGER NOT NULL UNIQUE,
      enemy_entity_id INTEGER, pest_entity_id INTEGER,
      control_magnitude REAL, response_lag_days REAL, establishment TEXT, specificity TEXT,
      ${ENVELOPE}
    );
    CREATE TABLE IF NOT EXISTS sim_visual (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER NOT NULL UNIQUE,
      model_archetype TEXT, canopy_shape TEXT, foliage_color TEXT, produce_color TEXT,
      height_scale_cm REAL, spread_scale_cm REAL,
      ${ENVELOPE}
    );
    CREATE INDEX IF NOT EXISTS idx_sim_plant_growth_entity ON sim_plant_growth(entity_id);
    CREATE INDEX IF NOT EXISTS idx_sim_pest_dynamics_entity ON sim_pest_dynamics(entity_id);
    CREATE INDEX IF NOT EXISTS idx_sim_biocontrol_claim ON sim_biocontrol(claim_id);
    CREATE INDEX IF NOT EXISTS idx_sim_biocontrol_pest ON sim_biocontrol(pest_entity_id);
    CREATE INDEX IF NOT EXISTS idx_sim_visual_entity ON sim_visual(entity_id);
  `);
  console.log('[migration-072] sim-params layer: sim_plant_growth, sim_pest_dynamics, sim_biocontrol, sim_visual');
}

migrate.down = function down(db) {
  db.exec(`
    DROP TABLE IF EXISTS sim_plant_growth;
    DROP TABLE IF EXISTS sim_pest_dynamics;
    DROP TABLE IF EXISTS sim_biocontrol;
    DROP TABLE IF EXISTS sim_visual;
  `);
};

module.exports = migrate;

if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB);
  migrate(db);
  db.close();
}
