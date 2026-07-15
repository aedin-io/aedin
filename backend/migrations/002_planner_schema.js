/**
 * Migration 002: Polyculture Planner Schema
 * Creates SQLite tables for the companion scoring pipeline.
 * Adapted from polyculture_planner_schema.sql (PostgreSQL → SQLite).
 *
 * Usage: node migrations/002_planner_schema.js
 */

const sqlite3 = require('sqlite3').verbose();
const { CORPUS_DB } = require('../lib/db-paths.cjs');

const db = new sqlite3.Database(CORPUS_DB);

console.log('Running migration 002_planner_schema...\n');

db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = OFF'); // decorative FKs, no enforcement needed

  // All taxa relevant to the planner (crops + partners)
  db.run(`
    CREATE TABLE IF NOT EXISTS planner_organisms (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      scientific_name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      common_name     TEXT,
      family          TEXT,
      primary_role    TEXT NOT NULL DEFAULT 'neutral',
      -- juvenile_role: non-NULL for organisms with ecologically distinct life stages
      -- e.g. Lepidoptera: primary_role='pollinator' (adult), juvenile_role='pest_insect' (caterpillar)
      -- e.g. Syrphidae:   primary_role='pollinator' (adult), juvenile_role='beneficial_predator' (larva)
      juvenile_role   TEXT,
      canopy_tier     TEXT,
      is_legume       INTEGER NOT NULL DEFAULT 0,
      is_brassica     INTEGER NOT NULL DEFAULT 0,
      is_allium       INTEGER NOT NULL DEFAULT 0,
      taxon_path      TEXT,
      agronomic_type  TEXT,   -- from verified_crops.type (e.g. 'Cereals & Grains', 'Legumes')
      created_at      TEXT DEFAULT (datetime('now'))
    )
  `, err => { if (err) console.error('planner_organisms:', err.message); else console.log('  + planner_organisms'); });

  // Extended crop properties
  db.run(`
    CREATE TABLE IF NOT EXISTS planner_crops (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      organism_id      INTEGER NOT NULL UNIQUE,
      nitrogen_demand  TEXT DEFAULT 'medium',
      pollination_type TEXT DEFAULT 'unknown',
      season           TEXT
    )
  `, err => { if (err) console.error('planner_crops:', err.message); else console.log('  + planner_crops'); });

  // GloBI interaction type → valence mapping (seeded by build-companion-scores.js)
  db.run(`
    CREATE TABLE IF NOT EXISTS interaction_type_rules (
      interaction_type    TEXT PRIMARY KEY COLLATE NOCASE,
      gliessman_type      TEXT NOT NULL,
      base_valence        TEXT NOT NULL,
      resolution_required INTEGER NOT NULL DEFAULT 0,
      scoring_weight      REAL NOT NULL DEFAULT 0.0,
      resolution_logic    TEXT
    )
  `, err => { if (err) console.error('interaction_type_rules:', err.message); else console.log('  + interaction_type_rules'); });

  // Curated pest-host relationships (can be seeded from EPPO/UC IPM data)
  db.run(`
    CREATE TABLE IF NOT EXISTS organism_pest_relationships (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      pest_organism_id INTEGER NOT NULL,
      host_crop_id     INTEGER NOT NULL,
      severity         TEXT,
      pest_type        TEXT,
      -- life_stage: which life stage causes the pest damage
      -- 'larval' for caterpillars, mites, nematodes; 'adult' for most sucking insects; 'all' if both stages
      life_stage       TEXT DEFAULT 'all',
      data_source      TEXT,
      UNIQUE (pest_organism_id, host_crop_id)
    )
  `, err => { if (err) console.error('organism_pest_relationships:', err.message); else console.log('  + organism_pest_relationships'); });

  // Curated beneficial relationships (pollinators, N-fixers, etc.)
  db.run(`
    CREATE TABLE IF NOT EXISTS organism_beneficial_relationships (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      beneficial_organism_id INTEGER NOT NULL,
      beneficiary_crop_id    INTEGER NOT NULL,
      benefit_type           TEXT NOT NULL,
      -- life_stage: which life stage provides the benefit
      -- 'adult' for most pollinators; 'larval' for predatory larvae (syrphid hover flies)
      life_stage             TEXT DEFAULT 'adult',
      data_source            TEXT,
      UNIQUE (beneficial_organism_id, beneficiary_crop_id, benefit_type)
    )
  `, err => { if (err) console.error('organism_beneficial_relationships:', err.message); else console.log('  + organism_beneficial_relationships'); });

  // Valence-assigned interactions (output of Stage 3 pipeline)
  db.run(`
    CREATE TABLE IF NOT EXISTS planner_processed_interactions (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      source_organism_id  INTEGER NOT NULL,
      target_organism_id  INTEGER NOT NULL,
      interaction_type    TEXT NOT NULL,
      system_valence      TEXT NOT NULL,
      valence_confidence  TEXT NOT NULL DEFAULT 'direct',
      applied_weight      REAL NOT NULL DEFAULT 0.0,
      resolution_path     TEXT,
      interaction_count   INTEGER NOT NULL DEFAULT 1
    )
  `, err => { if (err) console.error('planner_processed_interactions:', err.message); else console.log('  + planner_processed_interactions'); });

  // Junction: which processed interactions are relevant to each crop
  db.run(`
    CREATE TABLE IF NOT EXISTS processed_interaction_crops (
      processed_id INTEGER NOT NULL,
      crop_id      INTEGER NOT NULL,
      PRIMARY KEY (processed_id, crop_id)
    )
  `, err => { if (err) console.error('processed_interaction_crops:', err.message); else console.log('  + processed_interaction_crops'); });

  // Final scored companion pairings (queried by the Planner UI)
  db.run(`
    CREATE TABLE IF NOT EXISTS crop_companion_scores (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      primary_crop_id       INTEGER NOT NULL,
      companion_organism_id INTEGER NOT NULL,
      composite_score       REAL NOT NULL,
      score_breakdown       TEXT,
      total_interactions    INTEGER NOT NULL DEFAULT 0,
      dominant_valence      TEXT,
      top_interaction_types TEXT,
      structural_complement INTEGER NOT NULL DEFAULT 0,
      computed_at           TEXT DEFAULT (datetime('now')),
      UNIQUE (primary_crop_id, companion_organism_id)
    )
  `, err => { if (err) console.error('crop_companion_scores:', err.message); else console.log('  + crop_companion_scores'); });

  // Indexes
  db.run(`CREATE INDEX IF NOT EXISTS idx_planner_org_name   ON planner_organisms(scientific_name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_planner_org_role   ON planner_organisms(primary_role)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ppi_source         ON planner_processed_interactions(source_organism_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ppi_target         ON planner_processed_interactions(target_organism_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ppi_type           ON planner_processed_interactions(interaction_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pic_crop           ON processed_interaction_crops(crop_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ccs_crop           ON crop_companion_scores(primary_crop_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ccs_score          ON crop_companion_scores(primary_crop_id, composite_score DESC)`);

  db.run('SELECT 1', err => {
    if (!err) console.log('\nMigration 002 complete.');
    db.close();
  });
});
