'use strict';
/**
 * Migration 074 — ecosystem-service layer: (a) new entities scalar columns for
 * USDA-sourced soil/nutrient + plant soil-tolerance facts; (b) sim_ecosystem_service,
 * a derived per-plant categorical indicator table with the sim param_status envelope.
 * Idempotent; follows 073. Spec: docs/superpowers/specs/2026-07-04-sim-ecosystem-service-layer-design.md
 */
const NEW_ENTITY_COLS = ['cn_ratio','fertility_requirement','soil_texture_adaptation','anaerobic_tolerance','caco3_tolerance','salinity_tolerance','drought_tolerance','moisture_use'];
function has(db, table, col) { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); }
function migrate(db) {
  for (const col of NEW_ENTITY_COLS) if (!has(db, 'entities', col)) db.exec(`ALTER TABLE entities ADD COLUMN ${col} TEXT`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sim_ecosystem_service (
      id INTEGER PRIMARY KEY,
      entity_id INTEGER NOT NULL UNIQUE,
      nitrogen_fixation_class TEXT, residue_decomposition TEXT, nutrient_demand TEXT,
      rooting_niche TEXT, growth_strategy TEXT, ground_cover TEXT, life_cycle_class TEXT,
      biomass_contribution TEXT, soil_functions TEXT,
      param_status TEXT NOT NULL CHECK(param_status IN ('derived','designed','override')),
      derivation_method TEXT, model_ref TEXT, inputs_json TEXT,
      confidence TEXT CHECK(confidence IN ('high','medium','low')),
      generated_at TEXT NOT NULL DEFAULT (datetime('now')), generated_run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sim_ecosystem_service_entity ON sim_ecosystem_service(entity_id);
  `);
  console.log('[migration-074] entities soil/tolerance columns + sim_ecosystem_service ready');
}
migrate.down = function down(db) {
  db.exec(`DROP TABLE IF EXISTS sim_ecosystem_service`);
  for (const col of NEW_ENTITY_COLS) if (has(db, 'entities', col)) db.exec(`ALTER TABLE entities DROP COLUMN ${col}`);
};
module.exports = migrate;
if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB); migrate(db); db.close();
}
