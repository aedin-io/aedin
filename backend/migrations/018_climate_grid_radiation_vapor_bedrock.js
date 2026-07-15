'use strict';

/**
 * Adds radiation, vapor pressure, and soil depth-to-bedrock columns to climate_grid.
 *
 * Sources:
 *   WorldClim v2.1 srad  — monthly solar radiation (kJ m⁻² day⁻¹)
 *   WorldClim v2.1 vapr  — monthly water vapor pressure (kPa)
 *   WorldClim v2.1 elev  — elevation (m) — populates existing elevation_m column
 *   SoilGrids bdticm     — absolute depth to bedrock (cm)
 *
 * The existing monthly_humidity column (added in migration 015) will be populated
 * from vapr + monthly_temp_{high,low} using the Tetens saturation-pressure formula.
 *
 * New columns:
 *   monthly_solar_radiation     — JSON array of 12 monthly means (kJ m⁻² day⁻¹)
 *   mean_solar_radiation        — annual mean (kJ m⁻² day⁻¹)
 *   monthly_vapor_pressure      — JSON array of 12 monthly means (kPa)
 *   mean_vapor_pressure         — annual mean (kPa)
 *   mean_relative_humidity      — annual mean (%) derived from vapr + temp
 *   soil_depth_bedrock_cm       — absolute depth to bedrock (cm)
 */
async function runMigration(db) {
  const cols = await db.all('PRAGMA table_info(climate_grid)');
  const existing = new Set(cols.map(c => c.name));

  const newCols = [
    ['monthly_solar_radiation', 'TEXT'],
    ['mean_solar_radiation', 'REAL'],
    ['monthly_vapor_pressure', 'TEXT'],
    ['mean_vapor_pressure', 'REAL'],
    ['mean_relative_humidity', 'REAL'],
    ['soil_depth_bedrock_cm', 'REAL'],
  ];

  let added = 0;
  for (const [name, type] of newCols) {
    if (!existing.has(name)) {
      await db.exec(`ALTER TABLE climate_grid ADD COLUMN ${name} ${type}`);
      added++;
    }
  }

  if (added > 0) {
    console.log(`[migration-018] Added ${added} radiation/vapor/bedrock columns to climate_grid.`);
  } else {
    console.log('[migration-018] Radiation/vapor/bedrock columns already present.');
  }
}

module.exports = { runMigration };
