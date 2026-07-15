/**
 * Migration 005: Taxon Classification Schema
 *
 * Adds:
 *   - planner_organisms.secondary_role
 *   - taxon_role_overrides table (manual corrections, checked before rule engine)
 *   - taxon_classification_flags table (organisms needing future data enrichment)
 *
 * Idempotent: checks column/table existence before each change.
 *
 * Usage:
 *   node migrations/005_taxon_classification.js
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

  console.log('Running migration 005_taxon_classification...\n');

  // 1. Add secondary_role to planner_organisms
  if (await tableExists('planner_organisms')) {
    if (await hasColumn('planner_organisms', 'secondary_role')) {
      console.log('  ~ planner_organisms.secondary_role (already exists)');
    } else {
      await db.run(`ALTER TABLE planner_organisms ADD COLUMN secondary_role TEXT`);
      console.log('  + planner_organisms.secondary_role');
    }
  } else {
    console.log('  ! planner_organisms table does not exist yet (run 002 first)');
  }

  // 2. taxon_role_overrides — manual corrections, checked before rule engine
  await db.run(`
    CREATE TABLE IF NOT EXISTS taxon_role_overrides (
      scientific_name  TEXT PRIMARY KEY COLLATE NOCASE,
      primary_role     TEXT NOT NULL,
      secondary_role   TEXT,
      reason           TEXT,
      added_at         TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('  + taxon_role_overrides (CREATE IF NOT EXISTS)');

  // 3. taxon_classification_flags — organisms needing future data enrichment
  await db.run(`
    CREATE TABLE IF NOT EXISTS taxon_classification_flags (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      scientific_name  TEXT NOT NULL,
      taxon_path       TEXT,
      current_role     TEXT,
      flag_reason      TEXT NOT NULL,
      resolved         INTEGER DEFAULT 0,
      flagged_at       TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('  + taxon_classification_flags (CREATE IF NOT EXISTS)');

  console.log('\nMigration 005 complete.');
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
  })().catch(err => { console.error('Migration 005 failed:', err); process.exit(1); });
}

module.exports = { runMigration };
