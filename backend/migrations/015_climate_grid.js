'use strict';

async function runMigration(db) {
  const exists = await db.get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='climate_grid'"
  );
  if (exists) {
    console.log('[migration-015] climate_grid table already exists.');
    return;
  }

  await db.exec(`
    CREATE TABLE climate_grid (
      id            INTEGER PRIMARY KEY,
      lat           REAL NOT NULL,
      lon           REAL NOT NULL,
      elevation_m   REAL,

      monthly_temp_high   TEXT,
      monthly_temp_low    TEXT,
      monthly_precip_mm   TEXT,
      monthly_humidity    TEXT,

      bio1_annual_mean_temp       REAL,
      bio2_mean_diurnal_range     REAL,
      bio3_isothermality          REAL,
      bio4_temp_seasonality       REAL,
      bio5_max_temp_warmest       REAL,
      bio6_min_temp_coldest       REAL,
      bio7_temp_annual_range      REAL,
      bio8_mean_temp_wettest_q    REAL,
      bio9_mean_temp_driest_q     REAL,
      bio10_mean_temp_warmest_q   REAL,
      bio11_mean_temp_coldest_q   REAL,
      bio12_annual_precip         REAL,
      bio13_precip_wettest_month  REAL,
      bio14_precip_driest_month   REAL,
      bio15_precip_seasonality    REAL,
      bio16_precip_wettest_q      REAL,
      bio17_precip_driest_q       REAL,
      bio18_precip_warmest_q      REAL,
      bio19_precip_coldest_q      REAL,

      frost_free_days       INTEGER,
      growing_degree_days   REAL,
      first_frost_doy       INTEGER,
      last_frost_doy        INTEGER,
      koppen_zone           TEXT,
      hardiness_zone        TEXT,

      soil_ph_surface       REAL,
      soil_clay_pct         REAL,
      soil_sand_pct         REAL,
      soil_organic_carbon   REAL,
      soil_moisture_index   REAL
    );

    CREATE UNIQUE INDEX idx_climate_grid_latlon ON climate_grid(lat, lon);
    CREATE INDEX idx_climate_grid_koppen ON climate_grid(koppen_zone);
    CREATE INDEX idx_climate_grid_hardiness ON climate_grid(hardiness_zone);
  `);

  console.log('[migration-015] climate_grid table created with indexes.');
}

module.exports = { runMigration };
