'use strict';

/**
 * Adds additional soil properties to climate_grid from SoilGrids v2.0.
 *
 * New columns:
 *   soil_silt_pct              — silt percentage (completes sand/silt/clay triangle)
 *   soil_cec                   — cation exchange capacity (mmol(c)/kg) — nutrient holding
 *   soil_nitrogen              — total nitrogen (cg/kg)
 *   soil_bulk_density          — bulk density (cg/cm³) — compaction indicator
 *   soil_coarse_fragments_pct  — coarse fragments vol % (rock/gravel content)
 *   soil_water_field_capacity  — water content at 33 kPa (0.1 vol %) — field capacity
 *   soil_water_wilting_point   — water content at 1500 kPa (0.1 vol %) — permanent wilting
 *   soil_available_water       — derived: field capacity − wilting point (0.1 vol %)
 */
async function runMigration(db) {
  const cols = await db.all('PRAGMA table_info(climate_grid)');
  const existing = new Set(cols.map(c => c.name));

  const newCols = [
    ['soil_silt_pct', 'REAL'],
    ['soil_cec', 'REAL'],
    ['soil_nitrogen', 'REAL'],
    ['soil_bulk_density', 'REAL'],
    ['soil_coarse_fragments_pct', 'REAL'],
    ['soil_water_field_capacity', 'REAL'],
    ['soil_water_wilting_point', 'REAL'],
    ['soil_available_water', 'REAL'],
  ];

  let added = 0;
  for (const [name, type] of newCols) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE climate_grid ADD COLUMN ${name} ${type}`);
      added++;
    }
  }

  if (added > 0) {
    console.log(`[migration-017] Added ${added} soil columns to climate_grid.`);
  } else {
    console.log('[migration-017] Extended soil columns already present.');
  }
}

module.exports = { runMigration };
