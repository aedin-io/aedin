/**
 * Migration 011: Add non-plant organism data fields
 *
 * Adds columns for invertebrate, fungi, microbe, and vertebrate entities
 * to support data from GBIF, EPPO, IUCN, and paper extraction.
 *
 * Usage:
 *   node migrations/011_organism_fields.js
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

const NEW_COLUMNS = [
  // ── Universal (all non-plant entities) ──────────────────────────
  ['activity_months',         'TEXT'],    // JSON array of active months
  ['habitat_type',            'TEXT'],    // crop_canopy / soil_surface / soil_dwelling / aquatic / aerial
  ['conservation_status',     'TEXT'],    // IUCN: LC, NT, VU, EN, CR, DD, NE
  ['iucn_id',                 'INTEGER'], // IUCN Red List taxon ID
  ['gbif_key',                'INTEGER'], // GBIF species key
  ['gbif_synced_at',          'TEXT'],    // last GBIF sync timestamp
  ['eppo_code',               'TEXT'],    // EPPO code (e.g., MELGMY)
  ['eppo_synced_at',          'TEXT'],    // last EPPO sync timestamp
  ['iucn_synced_at',          'TEXT'],    // last IUCN sync timestamp

  // ── Invertebrate-specific ───────────────────────────────────────
  ['life_cycle_type',         'TEXT'],    // holometabolous / hemimetabolous
  ['voltinism',               'TEXT'],    // univoltine / bivoltine / multivoltine
  ['diet_breadth',            'TEXT'],    // monophagous / oligophagous / polyphagous
  ['thermal_min',             'REAL'],    // min development temp (°C)
  ['thermal_max',             'REAL'],    // max development temp (°C)
  ['degree_days',             'REAL'],    // accumulated degree-days per generation
  ['dispersal_range',         'TEXT'],    // low / moderate / high / migratory
  ['commercial_biocontrol',   'INTEGER'], // 1 if sold commercially

  // ── Fungi-specific ──────────────────────────────────────────────
  ['disease_name',            'TEXT'],    // common disease name
  ['transmission_mode',       'TEXT'],    // soilborne / airborne / seedborne / vector / waterborne
  ['favorable_temp_min',      'REAL'],    // disease development min (°C)
  ['favorable_temp_max',      'REAL'],    // disease development max (°C)
  ['favorable_humidity',      'TEXT'],    // low / moderate / high
  ['survival_structure',      'TEXT'],    // sclerotia / spores / chlamydospores / oospores
  ['soil_persistence_years',  'REAL'],    // years without host
  ['frac_group',              'TEXT'],    // fungicide resistance group code

  // ── Microbe-specific ────────────────────────────────────────────
  ['transmission_vector',     'TEXT'],    // vector organism name
  ['pathogen_subtype',        'TEXT'],    // bacterium / virus / viroid / phytoplasma
  ['seed_borne',              'INTEGER'], // 1 if seed-borne
  ['soil_health_function',    'TEXT'],    // N_fixation / P_solubilization / growth_promotion

  // ── Vertebrate-specific ─────────────────────────────────────────
  ['diet_type',               'TEXT'],    // herbivore / granivore / insectivore / omnivore / carnivore
  ['crop_damage_type',        'TEXT'],    // fruit_feeding / seed_predation / bark_stripping / root_damage
  ['migration_pattern',       'TEXT'],    // resident / migratory / seasonal_visitor
  ['activity_pattern',        'TEXT'],    // diurnal / nocturnal / crepuscular
];

async function runMigration(db) {
  console.log('Running migration 011_organism_fields...\n');

  const existing = await db.all('PRAGMA table_info(entities)');
  const existingNames = new Set(existing.map(c => c.name));

  let added = 0;
  for (const [name, type] of NEW_COLUMNS) {
    if (existingNames.has(name)) continue;
    await db.exec(`ALTER TABLE entities ADD COLUMN ${name} ${type}`);
    added++;
  }
  console.log(`  + ${added} new columns added to entities`);

  // Indexes for sync lookups
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entities_gbif_key  ON entities(gbif_key);
    CREATE INDEX IF NOT EXISTS idx_entities_eppo_code ON entities(eppo_code);
    CREATE INDEX IF NOT EXISTS idx_entities_iucn_id   ON entities(iucn_id);
  `);
  console.log('  + sync lookup indexes');

  console.log('\nMigration 011 complete.');
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
  })().catch(err => { console.error('Migration 011 failed:', err); process.exit(1); });
}

module.exports = { runMigration };
