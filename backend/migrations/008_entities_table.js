// backend/migrations/008_entities_table.js
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

async function runMigration(db) {
  console.log('Running migration 008_entities_table...\n');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      -- Identity
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      scientific_name       TEXT NOT NULL UNIQUE,
      common_name           TEXT,
      family                TEXT,
      family_common_name    TEXT,
      genus                 TEXT,
      taxonomy_path         TEXT,
      synonyms              TEXT,

      -- Classification
      bio_category          TEXT NOT NULL,
      primary_role          TEXT NOT NULL,
      agroeco_functions     TEXT,
      data_completeness     TEXT DEFAULT 'minimal',

      -- Plant-specific (nullable for non-plants)
      crop_type             TEXT,
      climate_zone          TEXT,
      duration              TEXT,
      edible                INTEGER,
      vegetable             INTEGER,
      edible_part           TEXT,
      days_to_harvest       REAL,
      growth_rate           TEXT,
      growth_habit          TEXT,
      growth_form           TEXT,
      ligneous_type         TEXT,
      shape_and_orientation TEXT,
      average_height_cm     REAL,
      maximum_height_cm     REAL,
      spread_cm             REAL,
      row_spacing_cm        REAL,
      min_root_depth_cm     REAL,
      ph_min                REAL,
      ph_max                REAL,
      soil_texture          INTEGER,
      soil_humidity         INTEGER,
      soil_nutriments       INTEGER,
      soil_salinity         INTEGER,
      light_requirement     INTEGER,
      atmospheric_humidity  INTEGER,
      min_temp_c            REAL,
      max_temp_c            REAL,
      min_precipitation_mm  REAL,
      max_precipitation_mm  REAL,
      nitrogen_fixation     TEXT,
      toxicity              TEXT,
      native_zones          TEXT,
      introduced_zones      TEXT,
      growth_months         TEXT,
      bloom_months          TEXT,
      fruit_months          TEXT,
      image_url             TEXT,

      -- Non-plant-specific (nullable for plants)
      organism_type         TEXT,
      pest_mobility         TEXT,
      host_range            TEXT,
      native_regions        TEXT,
      invasive_regions      TEXT,

      -- Provenance
      trefle_id             INTEGER UNIQUE,
      trefle_synced_at      TEXT,
      source_table          TEXT,
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('  + entities table');

  await db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_scientific_name ON entities(scientific_name);
    CREATE INDEX IF NOT EXISTS idx_entities_primary_role ON entities(primary_role);
    CREATE INDEX IF NOT EXISTS idx_entities_bio_category ON entities(bio_category);
    CREATE INDEX IF NOT EXISTS idx_entities_family ON entities(family);
    CREATE INDEX IF NOT EXISTS idx_entities_crop_type ON entities(crop_type);
    CREATE INDEX IF NOT EXISTS idx_entities_trefle_id ON entities(trefle_id);
    CREATE INDEX IF NOT EXISTS idx_entities_common_name ON entities(common_name);
  `);
  console.log('  + entities indexes');

  console.log('\nMigration 008 complete.');
}

if (require.main === module) {
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL;');
    try {
      await runMigration(db);
    } finally {
      await db.close();
    }
  })().catch(err => { console.error('Migration 008 failed:', err); process.exit(1); });
}

module.exports = { runMigration };
