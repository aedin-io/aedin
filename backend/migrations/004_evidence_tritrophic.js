/**
 * Migration 004: Evidence & Tri-Trophic Schema
 *
 * Adds:
 *   - planner_processed_interactions.locality_count
 *   - interaction_evidence table (pre-computed evidence aggregates)
 *   - tritrophic_chains table (pre-computed biocontrol chains)
 *
 * Idempotent: checks column/table existence before each change.
 *
 * Usage:
 *   node migrations/004_evidence_tritrophic.js
 */

'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

async function runMigration(db) {
  async function hasColumn(table, column) {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    return cols.some(c => c.name === column);
  }

  async function tableExists(table) {
    const row = await db.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [table]
    );
    return !!row;
  }

  console.log('Running migration 004_evidence_tritrophic...\n');

  // ── planner_processed_interactions: add locality_count ─────────────────────
  if (await tableExists('planner_processed_interactions')) {
    if (!await hasColumn('planner_processed_interactions', 'locality_count')) {
      await db.run(`ALTER TABLE planner_processed_interactions ADD COLUMN locality_count INTEGER DEFAULT 0`);
      console.log('  + planner_processed_interactions.locality_count');
    } else {
      console.log('  ~ planner_processed_interactions.locality_count (already exists)');
    }
  } else {
    console.log('  ! planner_processed_interactions table does not exist yet (run 002 first)');
  }

  // ── interaction_evidence table ─────────────────────────────────────────────
  await db.run(`
    CREATE TABLE IF NOT EXISTS interaction_evidence (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      source_organism_id  INTEGER NOT NULL,
      target_organism_id  INTEGER NOT NULL,
      interaction_type    TEXT NOT NULL,
      record_count        INTEGER NOT NULL DEFAULT 0,
      locality_count      INTEGER NOT NULL DEFAULT 0,
      UNIQUE (source_organism_id, target_organism_id, interaction_type)
    )
  `);
  console.log('  + interaction_evidence (CREATE IF NOT EXISTS)');

  await db.run(`CREATE INDEX IF NOT EXISTS idx_ie_source ON interaction_evidence(source_organism_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ie_target ON interaction_evidence(target_organism_id)`);
  console.log('  + idx_ie_source, idx_ie_target (CREATE IF NOT EXISTS)');

  // ── tritrophic_chains table ────────────────────────────────────────────────
  await db.run(`
    CREATE TABLE IF NOT EXISTS tritrophic_chains (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      crop_organism_id          INTEGER NOT NULL,
      pest_organism_id          INTEGER NOT NULL,
      beneficial_organism_id    INTEGER NOT NULL,
      pest_interaction_type     TEXT NOT NULL,
      control_interaction_type  TEXT NOT NULL,
      pest_record_count         INTEGER NOT NULL DEFAULT 0,
      control_record_count      INTEGER NOT NULL DEFAULT 0,
      pest_locality_count       INTEGER NOT NULL DEFAULT 0,
      control_locality_count    INTEGER NOT NULL DEFAULT 0,
      confidence_level          TEXT NOT NULL DEFAULT 'weak',
      sentence                  TEXT,
      UNIQUE (crop_organism_id, pest_organism_id, beneficial_organism_id)
    )
  `);
  console.log('  + tritrophic_chains (CREATE IF NOT EXISTS)');

  await db.run(`CREATE INDEX IF NOT EXISTS idx_ttc_crop ON tritrophic_chains(crop_organism_id)`);
  await db.run(`CREATE INDEX IF NOT EXISTS idx_ttc_pest ON tritrophic_chains(pest_organism_id)`);
  console.log('  + idx_ttc_crop, idx_ttc_pest (CREATE IF NOT EXISTS)');

  console.log('\nMigration 004 complete.');
}

// Run standalone if invoked directly
if (require.main === module) {
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await db.exec('PRAGMA journal_mode = WAL;');
    try {
      await runMigration(db);
    } finally {
      await db.close();
    }
  })().catch(err => { console.error('Migration 004 failed:', err); process.exit(1); });
}

module.exports = { runMigration };
