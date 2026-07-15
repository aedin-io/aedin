/**
 * Migration 006: AgroEco Core Schema
 *
 * Creates the foundational tables for the LLM-extracted paper interaction
 * pipeline, replacing GLOBI as the primary data source. The crops table is
 * enriched with Trefle botanical fields so the app can reason about
 * compatibility from first principles (soil, pH, root depth, nitrogen fixation)
 * before any paper-extracted interactions are applied.
 *
 * Table hierarchy:
 *   crops              — canonical crop entities (Trefle-enriched)
 *   sources            — papers, bulletins, reports feeding the LLM pipeline
 *   interactions       — crop-to-crop relationships extracted from sources
 *   pests_pathogens    — pest and disease entities
 *   crop_vulnerabilities — crop ↔ pest relationships extracted from sources
 *
 * Usage:
 *   node migrations/006_agroeco_schema.js
 */

'use strict';

const sqlite3 = require('sqlite3').verbose();
const { CORPUS_DB, ATTACH_RAW_SQL } = require('../lib/db-paths.cjs');

const db      = new sqlite3.Database(CORPUS_DB);

console.log('Running migration 006: AgroEco core schema...\n');

db.serialize(() => {
  db.run(ATTACH_RAW_SQL);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = OFF'); // decorative FKs only — SQLite doesn't enforce without this ON

  // ─── crops ────────────────────────────────────────────────────────────────
  // Primary entity table. scientific_name is the stable unique key.
  // trefle_id allows re-syncing from Trefle without breaking downstream FKs.
  // All Trefle growth/soil fields are nullable — coverage varies by species,
  // especially for Pacific/tropical crops that are underrepresented in Trefle.
  db.run(`
    CREATE TABLE IF NOT EXISTS crops (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Identity
      trefle_id               INTEGER UNIQUE,          -- Trefle species ID for re-sync
      scientific_name         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      common_name             TEXT,
      slug                    TEXT,                    -- Trefle slug (human-readable URL key)
      family                  TEXT,
      family_common_name      TEXT,
      genus                   TEXT,
      synonyms                TEXT,                    -- JSON array of alternate scientific names

      -- Taxonomy / edibility
      duration                TEXT,                    -- JSON array: ["annual","perennial",...]
      edible_part             TEXT,                    -- JSON array: ["roots","leaves","seeds",...]
      edible                  INTEGER DEFAULT 1,       -- boolean
      vegetable               INTEGER DEFAULT 0,       -- boolean

      -- Growth characteristics (from Trefle growth object)
      days_to_harvest         REAL,
      growth_rate             TEXT,                    -- "slow" | "moderate" | "fast"
      growth_habit            TEXT,                    -- "forb/herb" | "graminoid" | "shrub" | "tree" | "vine"
      growth_form             TEXT,                    -- soil-stabilization classification
      ligneous_type           TEXT,                    -- "liana" | "subshrub" | "shrub" | "tree" | "parasite"
      shape_and_orientation   TEXT,
      average_height_cm       REAL,
      maximum_height_cm       REAL,
      growth_months           TEXT,                    -- JSON array of month strings
      bloom_months            TEXT,                    -- JSON array of month strings
      fruit_months            TEXT,                    -- JSON array of month strings
      row_spacing_cm          REAL,
      spread_cm               REAL,
      min_root_depth_cm       REAL,                   -- key polyculture signal: root layer competition

      -- Soil requirements (core compatibility signals for scoring)
      ph_min                  REAL,
      ph_max                  REAL,
      soil_texture            INTEGER,                 -- 0 (clay) to 10 (rock)
      soil_humidity           INTEGER,                 -- 0 (xerophile) to 10 (subaquatic)
      soil_nutriments         INTEGER,                 -- 0 (oligotrophic) to 10 (hypereutrophic)
      soil_salinity           INTEGER,                 -- 0 (intolerant) to 10 (hyperhaline)
      light_requirement       INTEGER,                 -- 0 (no light) to 10 (full sun)
      atmospheric_humidity    INTEGER,                 -- 0 to 10

      -- Climate tolerances
      min_temp_c              REAL,
      max_temp_c              REAL,
      min_precipitation_mm    REAL,
      max_precipitation_mm    REAL,

      -- Key polyculture signals
      nitrogen_fixation       TEXT,                    -- "none" | "low" | "medium" | "high" — critical companion signal
      toxicity                TEXT,                    -- "none" | "low" | "medium" | "high"

      -- Distribution (from Trefle, stored as JSON zone arrays)
      native_zones            TEXT,                    -- JSON array of TDWG zone codes
      introduced_zones        TEXT,                    -- JSON array of TDWG zone codes

      -- AgroEco classification (our own layer on top of Trefle taxonomy)
      crop_type               TEXT,                    -- "cereal" | "legume" | "root" | "tree_fruit" | "vegetable" | "herb" | "oilseed" | "fiber" | "forage" | "cover_crop"
      climate_zone            TEXT,                    -- "tropical" | "subtropical" | "temperate" | "arid" | "alpine"

      -- Image (from Trefle — optional, for UI)
      image_url               TEXT,

      -- Sync metadata
      trefle_synced_at        TEXT,                    -- ISO timestamp of last Trefle sync
      data_completeness       TEXT DEFAULT 'partial',  -- "full" | "partial" | "manual" — tracks how complete this record is
      created_at              TEXT DEFAULT (datetime('now')),
      updated_at              TEXT DEFAULT (datetime('now'))
    )
  `, err => {
    if (err) console.error('❌ crops:', err.message);
    else console.log('✅ crops table created');
  });

  // ─── sources ──────────────────────────────────────────────────────────────
  // Every interaction claim must trace back to a source row.
  // source_type drives the evidence_tier on interactions — peer-reviewed > extension > user.
  db.run(`
    CREATE TABLE IF NOT EXISTS sources (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,

      title           TEXT NOT NULL,
      authors         TEXT,                            -- free text, comma-separated
      publication     TEXT,                            -- journal name, institution, or "USDA", "FAO", etc.
      year            INTEGER,
      source_type     TEXT NOT NULL DEFAULT 'unknown', -- "peer_reviewed" | "extension_bulletin" | "usda_report" | "fao_document" | "book" | "user_contributed" | "unknown"
      access_level    TEXT DEFAULT 'open',             -- "open" | "paywalled" | "restricted"

      -- Location
      url             TEXT,
      doi             TEXT UNIQUE,
      file_path       TEXT,                            -- local path if ingested as PDF

      -- Extraction metadata
      ingested_at     TEXT,                            -- when LLM extraction was run
      extraction_model TEXT,                           -- e.g. "claude-sonnet-4-5-20251001"
      extraction_version INTEGER DEFAULT 1,            -- bump when prompt changes to allow re-extraction

      -- Coverage
      region_focus    TEXT,                            -- e.g. "Pacific", "Hawaii", "Guam", "Tropics", "Global"
      crop_focus      TEXT,                            -- JSON array of scientific names this paper primarily covers

      created_at      TEXT DEFAULT (datetime('now'))
    )
  `, err => {
    if (err) console.error('❌ sources:', err.message);
    else console.log('✅ sources table created');
  });

  // ─── interactions ─────────────────────────────────────────────────────────
  // Crop-to-crop relationships. The data_tier column implements the priority
  // stack: tier1_paper > tier2_globi > tier3_user. Query ORDER BY data_tier
  // to surface the highest-quality signal first.
  db.run(`
    CREATE TABLE IF NOT EXISTS raw.interactions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Relationship endpoints
      subject_crop_id     INTEGER NOT NULL REFERENCES crops(id),
      object_crop_id      INTEGER NOT NULL REFERENCES crops(id),
      source_id           INTEGER REFERENCES sources(id),

      -- Interaction classification
      interaction_type    TEXT NOT NULL,               -- "companion" | "allelopathic" | "nitrogen_transfer" | "pest_suppression" | "competition" | "pollinator_support" | "disease_break" | "trap_crop" | "shade_provision" | "ground_cover"
      effect_direction    TEXT NOT NULL,               -- "beneficial" | "harmful" | "neutral" | "context_dependent"
      mechanism           TEXT,                        -- "nitrogen fixation" | "allelopathy" | "physical barrier" | "habitat provision" | "root exudate" | "canopy shading" | etc.

      -- Evidence quality
      confidence_score    REAL DEFAULT 0.5,            -- 0.0–1.0, computed during extraction
      evidence_tier       TEXT DEFAULT 'inferred',     -- "direct" (paper explicitly tested this pair) | "inferred" (extrapolated from mechanism) | "observational" (field obs)
      data_tier           TEXT DEFAULT 'tier2_globi',  -- "tier1_paper" | "tier2_globi" | "tier3_user"

      -- Extracted content (citation-anchored)
      extracted_claim     TEXT,                        -- clean NL statement: "Cowpea fixes nitrogen that benefits maize"
      source_quote        TEXT,                        -- verbatim <15 word quote from source (copyright-safe)
      source_page         INTEGER,                     -- page number in source document

      -- Quantification (when paper provides it)
      effect_magnitude    TEXT,                        -- e.g. "40% reduction in FAW pressure"
      study_scale         TEXT,                        -- "field" | "greenhouse" | "lab" | "meta_analysis"
      study_duration      TEXT,                        -- e.g. "2 seasons", "3 years"

      -- Context
      regional_context    TEXT,                        -- e.g. "Hawaii", "West Africa", "Tropics" — from paper
      season_context      TEXT,                        -- e.g. "wet season", "cool season"
      soil_context        TEXT,                        -- any soil conditions noted in paper

      created_at          TEXT DEFAULT (datetime('now'))
    )
  `, err => {
    if (err) console.error('❌ interactions:', err.message);
    else console.log('✅ interactions table created');
  });

  // ─── pests_pathogens ──────────────────────────────────────────────────────
  // Separate entity table for pests, diseases, weeds.
  // Kept separate from crops because query patterns differ and attributes differ.
  db.run(`
    CREATE TABLE IF NOT EXISTS pests_pathogens (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,

      scientific_name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
      common_name         TEXT,
      organism_type       TEXT NOT NULL,               -- "insect" | "fungus" | "bacterium" | "virus" | "nematode" | "weed" | "mite" | "mollusk"
      taxonomy_path       TEXT,                        -- e.g. "Insecta > Lepidoptera > Noctuidae"

      -- Geographic presence
      native_regions      TEXT,                        -- JSON array
      invasive_regions    TEXT,                        -- JSON array

      created_at          TEXT DEFAULT (datetime('now'))
    )
  `, err => {
    if (err) console.error('❌ pests_pathogens:', err.message);
    else console.log('✅ pests_pathogens table created');
  });

  // ─── crop_vulnerabilities ─────────────────────────────────────────────────
  // Crop ↔ pest/pathogen relationships. Powers the monoculture analysis
  // feature: "here's what attacks your monoculture system, here's what
  // polyculture pairings address those specific pressures."
  db.run(`
    CREATE TABLE IF NOT EXISTS crop_vulnerabilities (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,

      crop_id             INTEGER NOT NULL REFERENCES crops(id),
      pest_id             INTEGER NOT NULL REFERENCES pests_pathogens(id),
      source_id           INTEGER REFERENCES sources(id),

      -- Characterization
      severity            TEXT DEFAULT 'moderate',     -- "low" | "moderate" | "high" | "devastating"
      damage_type         TEXT,                        -- "yield_loss" | "quality_degradation" | "plant_death" | "spread_vector"
      affected_part       TEXT,                        -- "roots" | "leaves" | "fruit" | "stem" | "whole_plant"

      -- Timing
      season              TEXT,                        -- "wet" | "dry" | "year_round" | "cool" | "warm"
      crop_growth_stage   TEXT,                        -- "seedling" | "vegetative" | "flowering" | "fruiting" | "all"

      -- Evidence
      confidence_score    REAL DEFAULT 0.5,
      evidence_tier       TEXT DEFAULT 'inferred',     -- "direct" | "inferred" | "observational"
      regional_context    TEXT,
      extracted_claim     TEXT,
      source_quote        TEXT,
      source_page         INTEGER,

      created_at          TEXT DEFAULT (datetime('now'))
    )
  `, err => {
    if (err) console.error('❌ crop_vulnerabilities:', err.message);
    else console.log('✅ crop_vulnerabilities table created');
  });

  // ─── indexes ──────────────────────────────────────────────────────────────
  const indexes = [
    // crops — primary lookup patterns
    ['idx_crops_scientific_name',      'crops(scientific_name)'],
    ['idx_crops_trefle_id',            'crops(trefle_id)'],
    ['idx_crops_crop_type',            'crops(crop_type)'],
    ['idx_crops_nitrogen_fixation',    'crops(nitrogen_fixation)'],
    ['idx_crops_climate_zone',         'crops(climate_zone)'],

    // sources — ingestion pipeline lookups
    ['idx_sources_doi',                'sources(doi)'],
    ['idx_sources_source_type',        'sources(source_type)'],
    ['idx_sources_year',               'sources(year)'],

    // interactions — the hot query path (raw DB table)
    ['raw.idx_interactions_subject',   'interactions(subject_crop_id)'],
    ['raw.idx_interactions_object',    'interactions(object_crop_id)'],
    ['raw.idx_interactions_pair',      'interactions(subject_crop_id, object_crop_id)'],
    ['raw.idx_interactions_data_tier', 'interactions(data_tier)'],
    ['raw.idx_interactions_effect',    'interactions(effect_direction)'],
    ['raw.idx_interactions_type',      'interactions(interaction_type)'],

    // crop_vulnerabilities — monoculture analysis query path
    ['idx_vuln_crop',                  'crop_vulnerabilities(crop_id)'],
    ['idx_vuln_pest',                  'crop_vulnerabilities(pest_id)'],
    ['idx_vuln_severity',              'crop_vulnerabilities(severity)'],

    // pests_pathogens
    ['idx_pest_scientific_name',       'pests_pathogens(scientific_name)'],
    ['idx_pest_organism_type',         'pests_pathogens(organism_type)'],
  ];

  for (const [name, cols] of indexes) {
    db.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${cols}`, err => {
      if (err && !err.message.includes('already exists')) {
        console.error(`❌ index ${name}:`, err.message);
      } else {
        console.log(`✅ index ${name}`);
      }
    });
  }

  // ─── verify ───────────────────────────────────────────────────────────────
  setTimeout(() => {
    db.all(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`, (err, tables) => {
      if (err) return console.error('❌ verify failed:', err.message);
      console.log('\n📊 Tables in database:');
      tables.forEach(t => console.log(`   ${t.name}`));

      db.all(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name`, (err2, idxs) => {
        if (err2) return;
        console.log('\n🔍 AgroEco indexes:');
        idxs.forEach(i => console.log(`   ${i.name}`));
        console.log('\n✨ Migration 006 complete.');
        db.close();
      });
    });
  }, 800);
});

// ── Promise-API export for server.js startup ──────────────────────────────────
/**
 * runMigration(db) — idempotent; uses the sqlite promise-API handle.
 * Called by server.js at startup before migration007.
 */
async function runMigration(db) {
  const _dbList = await db.all('PRAGMA database_list');
  if (!_dbList.some((r) => r.name === 'raw')) {
    await db.exec(ATTACH_RAW_SQL);
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS crops (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      trefle_id               INTEGER UNIQUE,
      scientific_name         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      common_name             TEXT,
      slug                    TEXT,
      family                  TEXT,
      family_common_name      TEXT,
      genus                   TEXT,
      synonyms                TEXT,
      duration                TEXT,
      edible_part             TEXT,
      edible                  INTEGER DEFAULT 1,
      vegetable               INTEGER DEFAULT 0,
      days_to_harvest         REAL,
      growth_rate             TEXT,
      growth_habit            TEXT,
      growth_form             TEXT,
      ligneous_type           TEXT,
      shape_and_orientation   TEXT,
      average_height_cm       REAL,
      maximum_height_cm       REAL,
      growth_months           TEXT,
      bloom_months            TEXT,
      fruit_months            TEXT,
      row_spacing_cm          REAL,
      spread_cm               REAL,
      min_root_depth_cm       REAL,
      ph_min                  REAL,
      ph_max                  REAL,
      soil_texture            INTEGER,
      soil_humidity           INTEGER,
      soil_nutriments         INTEGER,
      soil_salinity           INTEGER,
      light_requirement       INTEGER,
      atmospheric_humidity    INTEGER,
      min_temp_c              REAL,
      max_temp_c              REAL,
      min_precipitation_mm    REAL,
      max_precipitation_mm    REAL,
      nitrogen_fixation       TEXT,
      toxicity                TEXT,
      native_zones            TEXT,
      introduced_zones        TEXT,
      crop_type               TEXT,
      climate_zone            TEXT,
      image_url               TEXT,
      trefle_synced_at        TEXT,
      data_completeness       TEXT DEFAULT 'partial',
      created_at              TEXT DEFAULT (datetime('now')),
      updated_at              TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sources (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      authors         TEXT,
      publication     TEXT,
      year            INTEGER,
      source_type     TEXT NOT NULL DEFAULT 'unknown',
      access_level    TEXT DEFAULT 'open',
      url             TEXT,
      doi             TEXT UNIQUE,
      file_path       TEXT,
      ingested_at     TEXT,
      extraction_model TEXT,
      extraction_version INTEGER DEFAULT 1,
      region_focus    TEXT,
      crop_focus      TEXT,
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS raw.interactions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_crop_id     INTEGER NOT NULL REFERENCES crops(id),
      object_crop_id      INTEGER NOT NULL REFERENCES crops(id),
      source_id           INTEGER REFERENCES sources(id),
      interaction_type    TEXT NOT NULL,
      effect_direction    TEXT NOT NULL,
      mechanism           TEXT,
      confidence_score    REAL DEFAULT 0.5,
      evidence_tier       TEXT DEFAULT 'inferred',
      data_tier           TEXT DEFAULT 'tier2_globi',
      extracted_claim     TEXT,
      source_quote        TEXT,
      source_page         INTEGER,
      effect_magnitude    TEXT,
      study_scale         TEXT,
      study_duration      TEXT,
      regional_context    TEXT,
      season_context      TEXT,
      soil_context        TEXT,
      created_at          TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pests_pathogens (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      scientific_name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
      common_name         TEXT,
      organism_type       TEXT NOT NULL,
      taxonomy_path       TEXT,
      native_regions      TEXT,
      invasive_regions    TEXT,
      created_at          TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS crop_vulnerabilities (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      crop_id             INTEGER NOT NULL REFERENCES crops(id),
      pest_id             INTEGER NOT NULL REFERENCES pests_pathogens(id),
      source_id           INTEGER REFERENCES sources(id),
      severity            TEXT DEFAULT 'moderate',
      damage_type         TEXT,
      affected_part       TEXT,
      season              TEXT,
      crop_growth_stage   TEXT,
      confidence_score    REAL DEFAULT 0.5,
      evidence_tier       TEXT DEFAULT 'inferred',
      regional_context    TEXT,
      extracted_claim     TEXT,
      source_quote        TEXT,
      source_page         INTEGER,
      created_at          TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_crops_scientific_name   ON crops(scientific_name);
    CREATE INDEX IF NOT EXISTS idx_crops_trefle_id         ON crops(trefle_id);
    CREATE INDEX IF NOT EXISTS idx_crops_crop_type         ON crops(crop_type);
    CREATE INDEX IF NOT EXISTS idx_crops_nitrogen_fixation ON crops(nitrogen_fixation);
    CREATE INDEX IF NOT EXISTS idx_crops_climate_zone      ON crops(climate_zone);

    CREATE INDEX IF NOT EXISTS idx_sources_doi             ON sources(doi);
    CREATE INDEX IF NOT EXISTS idx_sources_source_type     ON sources(source_type);
    CREATE INDEX IF NOT EXISTS idx_sources_year            ON sources(year);

    CREATE INDEX IF NOT EXISTS raw.idx_interactions_subject    ON interactions(subject_crop_id);
    CREATE INDEX IF NOT EXISTS raw.idx_interactions_object     ON interactions(object_crop_id);
    CREATE INDEX IF NOT EXISTS raw.idx_interactions_pair       ON interactions(subject_crop_id, object_crop_id);
    CREATE INDEX IF NOT EXISTS raw.idx_interactions_data_tier  ON interactions(data_tier);
    CREATE INDEX IF NOT EXISTS raw.idx_interactions_effect     ON interactions(effect_direction);
    CREATE INDEX IF NOT EXISTS raw.idx_interactions_type       ON interactions(interaction_type);

    CREATE INDEX IF NOT EXISTS idx_vuln_crop               ON crop_vulnerabilities(crop_id);
    CREATE INDEX IF NOT EXISTS idx_vuln_pest               ON crop_vulnerabilities(pest_id);
    CREATE INDEX IF NOT EXISTS idx_vuln_severity           ON crop_vulnerabilities(severity);

    CREATE INDEX IF NOT EXISTS idx_pest_scientific_name    ON pests_pathogens(scientific_name);
    CREATE INDEX IF NOT EXISTS idx_pest_organism_type      ON pests_pathogens(organism_type);
  `);
}

module.exports = { runMigration };
