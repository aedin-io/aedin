'use strict';

const NEW_COLUMNS = [
  // Consolidated environmental
  'optimal_temp_min REAL',
  'optimal_temp_max REAL',
  'tolerance_temp_min REAL',
  'tolerance_temp_max REAL',
  'optimal_humidity_min REAL',
  'optimal_humidity_max REAL',
  'optimal_precip_min REAL',
  'optimal_precip_max REAL',
  'optimal_ph_min REAL',
  'optimal_ph_max REAL',
  'optimal_soil_moisture INTEGER',
  'optimal_soil_texture INTEGER',
  'optimal_light INTEGER',
  'degree_days_base10 REAL',
  // New from IPM analysis
  'vulnerable_host_stage TEXT',
  'favorable_season TEXT',
  'known_natural_enemies TEXT',
  'favorable_soil_organic_matter TEXT',
  'wind_sensitivity TEXT',
  'leaf_wetness_hours REAL',
  'thermal_kill_point REAL',
];

// Old column → new column data migration map
const DATA_MIGRATION = [
  ['min_temp_c',            'optimal_temp_min'],
  ['max_temp_c',            'optimal_temp_max'],
  ['thermal_min',           'tolerance_temp_min'],
  ['thermal_max',           'tolerance_temp_max'],
  ['min_precipitation_mm',  'optimal_precip_min'],
  ['max_precipitation_mm',  'optimal_precip_max'],
  ['ph_min',                'optimal_ph_min'],
  ['ph_max',                'optimal_ph_max'],
  ['soil_texture',          'optimal_soil_texture'],
  ['soil_humidity',         'optimal_soil_moisture'],
  ['light_requirement',     'optimal_light'],
  ['degree_days',           'degree_days_base10'],
  ['favorable_temp_min',    'optimal_temp_min'],
  ['favorable_temp_max',    'optimal_temp_max'],
];

async function runMigration(db) {
  const existing = await db.all('PRAGMA table_info(entities)');
  const names = new Set(existing.map(c => c.name));

  let added = 0;
  for (const col of NEW_COLUMNS) {
    const colName = col.split(' ')[0];
    if (!names.has(colName)) {
      await db.run(`ALTER TABLE entities ADD COLUMN ${col}`);
      added++;
    }
  }

  if (added > 0) {
    console.log(`[migration-016] Added ${added} consolidated condition columns.`);

    // Migrate data from old columns to new (only where new column is still NULL)
    for (const [oldCol, newCol] of DATA_MIGRATION) {
      if (names.has(oldCol)) {
        const result = await db.run(
          `UPDATE entities SET ${newCol} = ${oldCol} WHERE ${oldCol} IS NOT NULL AND ${newCol} IS NULL`
        );
        if (result.changes > 0) {
          console.log(`[migration-016]   migrated ${result.changes} rows: ${oldCol} → ${newCol}`);
        }
      }
    }

    // Special case: atmospheric_humidity (0-10 scale) → optimal_humidity_min (approx RH %)
    if (names.has('atmospheric_humidity')) {
      const result = await db.run(
        `UPDATE entities SET optimal_humidity_min = atmospheric_humidity * 10
         WHERE atmospheric_humidity IS NOT NULL AND optimal_humidity_min IS NULL`
      );
      if (result.changes > 0) {
        console.log(`[migration-016]   migrated ${result.changes} rows: atmospheric_humidity → optimal_humidity_min (scaled)`);
      }
    }

    // Special case: favorable_humidity (text like "high") → optimal_humidity_min
    if (names.has('favorable_humidity')) {
      await db.run(
        `UPDATE entities SET optimal_humidity_min = 80
         WHERE favorable_humidity = 'high' AND optimal_humidity_min IS NULL`
      );
      await db.run(
        `UPDATE entities SET optimal_humidity_min = 40
         WHERE favorable_humidity = 'low' AND optimal_humidity_min IS NULL`
      );
    }
  } else {
    console.log('[migration-016] Consolidated condition columns already exist.');
  }

  // Indexes for climate matching queries (idempotent)
  await db.run(`CREATE INDEX IF NOT EXISTS idx_entities_opt_temp
    ON entities(optimal_temp_min, optimal_temp_max)
    WHERE parent_entity_id IS NULL`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_entities_opt_precip
    ON entities(optimal_precip_min, optimal_precip_max)
    WHERE parent_entity_id IS NULL`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_entities_role_temp
    ON entities(primary_role, optimal_temp_min, optimal_temp_max)
    WHERE parent_entity_id IS NULL`);

  console.log('[migration-016] Condition matching indexes ready.');
}

module.exports = { runMigration };
