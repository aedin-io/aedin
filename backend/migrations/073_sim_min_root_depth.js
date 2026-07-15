'use strict';
/**
 * Migration 073 — add sim_plant_growth.min_root_depth_cm so the simulator can
 * sample a rooting depth in [min, max]. min is sourced (USDA/Trefle minimum root
 * depth) where available, else a designed fraction of the designed max.
 * Idempotent; follows 072.
 * Spec: docs/superpowers/specs/2026-07-03-sim-trait-source-cascade-design.md
 */
function hasCol(db, t, c) { return db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c); }
function migrate(db) {
  if (!hasCol(db, 'sim_plant_growth', 'min_root_depth_cm')) {
    db.exec(`ALTER TABLE sim_plant_growth ADD COLUMN min_root_depth_cm REAL`);
  }
  console.log('[migration-073] sim_plant_growth.min_root_depth_cm ready');
}
migrate.down = function down(db) {
  if (hasCol(db, 'sim_plant_growth', 'min_root_depth_cm')) db.exec(`ALTER TABLE sim_plant_growth DROP COLUMN min_root_depth_cm`);
};
module.exports = migrate;
if (require.main === module) {
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  const Database = require('better-sqlite3');
  const db = new Database(CORPUS_DB); migrate(db); db.close();
}
