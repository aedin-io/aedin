'use strict';

/**
 * Adds two derived soil-classification columns to climate_grid for
 * Trefle-compatibility plant matching.
 *
 *   soil_texture_class    — USDA 12-class string (e.g. "sandy loam", "clay")
 *                           derived from soil_clay_pct / soil_sand_pct / soil_silt_pct.
 *   soil_nutriments_0_10  — Trefle-scale 0-10 nutrient richness proxy,
 *                           derived from soil_nitrogen + soil_cec + soil_organic_carbon.
 *
 * Both are derivation-only — no new external data. Populated by
 * derive-soil-classes.js.
 */
async function runMigration(db) {
  const cols = await db.all('PRAGMA table_info(climate_grid)');
  const existing = new Set(cols.map(c => c.name));

  const newCols = [
    ['soil_texture_class', 'TEXT'],
    ['soil_nutriments_0_10', 'REAL'],
  ];

  let added = 0;
  for (const [name, type] of newCols) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE climate_grid ADD COLUMN ${name} ${type}`);
      added++;
    }
  }

  if (added > 0) {
    console.log(`[migration-020] Added ${added} derived soil columns to climate_grid.`);
  } else {
    console.log('[migration-020] Derived soil columns already present.');
  }
}

module.exports = { runMigration };
