/**
 * Migration 009: Claims Pipeline Tables
 *
 * Creates the unified claims table (subject_entity_id → object_entity_id),
 * companion_scores (replaces crop_companion_scores), and recreates
 * tritrophic_chains with entity FKs.
 *
 * Usage:
 *   node migrations/009_claims_table.js
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

async function runMigration(db) {
  console.log('Running migration 009_claims_table...\n');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS claims (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_entity_id     INTEGER NOT NULL REFERENCES entities(id),
      object_entity_id      INTEGER NOT NULL REFERENCES entities(id),
      source_id             INTEGER REFERENCES sources(id),
      data_tier             TEXT NOT NULL DEFAULT 'tier2_globi',
      interaction_type_raw  TEXT NOT NULL,
      interaction_category  TEXT NOT NULL,
      effect_direction      TEXT NOT NULL,
      confidence_score      REAL DEFAULT 0.5,
      applied_weight        REAL DEFAULT 0.0,
      evidence_tier         TEXT DEFAULT 'inferred',
      valence_confidence    TEXT DEFAULT 'direct',
      resolution_path       TEXT,
      mechanism             TEXT,
      severity_class        TEXT,
      interaction_count     INTEGER DEFAULT 1,
      locality_count        INTEGER DEFAULT 0,
      extracted_claim       TEXT,
      source_quote          TEXT,
      source_page           INTEGER,
      effect_magnitude      TEXT,
      study_scale           TEXT,
      study_duration        TEXT,
      country               TEXT NOT NULL DEFAULT '',
      subdivision           TEXT NOT NULL DEFAULT '',
      regional_context      TEXT,
      season_context        TEXT,
      soil_context          TEXT,
      reference_citation    TEXT,
      created_at            TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_claims_subject    ON claims(subject_entity_id);
    CREATE INDEX IF NOT EXISTS idx_claims_object     ON claims(object_entity_id);
    CREATE INDEX IF NOT EXISTS idx_claims_pair       ON claims(subject_entity_id, object_entity_id);
    CREATE INDEX IF NOT EXISTS idx_claims_data_tier  ON claims(data_tier);
    CREATE INDEX IF NOT EXISTS idx_claims_category   ON claims(interaction_category);
    CREATE INDEX IF NOT EXISTS idx_claims_effect     ON claims(effect_direction);
    CREATE INDEX IF NOT EXISTS idx_claims_type_raw   ON claims(interaction_type_raw);
    CREATE INDEX IF NOT EXISTS idx_claims_country    ON claims(country, subdivision);
  `);
  console.log('  + claims table + indexes');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS companion_scores (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      crop_entity_id          INTEGER NOT NULL REFERENCES entities(id),
      companion_entity_id     INTEGER NOT NULL REFERENCES entities(id),
      composite_score         REAL NOT NULL,
      score_breakdown         TEXT,
      total_claims            INTEGER,
      dominant_valence        TEXT,
      top_interaction_types   TEXT,
      structural_complement   INTEGER DEFAULT 0,
      has_threshold_warning   INTEGER DEFAULT 0,
      computed_at             TEXT DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_pair      ON companion_scores(crop_entity_id, companion_entity_id);
    CREATE INDEX IF NOT EXISTS idx_cs_crop             ON companion_scores(crop_entity_id);
    CREATE INDEX IF NOT EXISTS idx_cs_companion        ON companion_scores(companion_entity_id);
    CREATE INDEX IF NOT EXISTS idx_cs_score            ON companion_scores(composite_score);
  `);
  console.log('  + companion_scores table + indexes');

  // Drop old tritrophic_chains (FK'd to planner_organisms) and recreate with entity FKs
  const ttcExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='tritrophic_chains'");
  if (ttcExists) {
    await db.exec('DROP TABLE tritrophic_chains');
    console.log('  - dropped old tritrophic_chains');
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS tritrophic_chains (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      crop_entity_id           INTEGER NOT NULL REFERENCES entities(id),
      pest_entity_id           INTEGER NOT NULL REFERENCES entities(id),
      beneficial_entity_id     INTEGER NOT NULL REFERENCES entities(id),
      pest_interaction_type    TEXT,
      control_interaction_type TEXT,
      pest_record_count        INTEGER,
      control_record_count     INTEGER,
      pest_locality_count      INTEGER DEFAULT 0,
      control_locality_count   INTEGER DEFAULT 0,
      confidence_level         TEXT,
      sentence                 TEXT,
      computed_at              TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tc_crop ON tritrophic_chains(crop_entity_id);
  `);
  console.log('  + tritrophic_chains table (entity FKs) + indexes');

  // Drop tables replaced by claims + entities + companion_scores
  const tablesToDrop = [
    'crop_companion_scores',
    'planner_processed_interactions',
    'processed_interaction_crops',
    'organism_beneficial_relationships',
    'organism_pest_relationships',
    'interaction_type_rules',
    'interaction_evidence',
    'planner_crops',
    'system_stacking_risks',
    'taxon_role_overrides',
    'taxon_classification_flags',
    'planner_organisms',
    'crop_vulnerabilities',
    'pests_pathogens',
    'crops',
  ];

  for (const table of tablesToDrop) {
    try {
      const exists = await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table);
      if (exists) {
        await db.exec(`DROP TABLE ${table}`);
        console.log(`  - dropped ${table}`);
      }
    } catch (err) {
      console.warn(`  ⚠ could not drop ${table}: ${err.message}`);
    }
  }

  console.log('\nMigration 009 complete.');
}

// Run standalone
if (require.main === module) {
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL;');
    try {
      await runMigration(db);
    } finally {
      await db.close();
    }
  })().catch(err => { console.error('Migration 009 failed:', err); process.exit(1); });
}

module.exports = { runMigration };
