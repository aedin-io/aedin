/**
 * Migration 003: Stacking Schema Patch
 *
 * Adds:
 *   - planner_organisms.pest_mobility
 *   - planner_processed_interactions.mechanism
 *   - planner_processed_interactions.severity_class
 *   - planner_processed_interactions.stacking_regime
 *   - crop_companion_scores.has_threshold_warning
 *   - system_stacking_risks table (for polyculture guild-level risk)
 *
 * Idempotent: checks column existence before each ALTER TABLE.
 *
 * Usage:
 *   node migrations/003_stacking_schema.js
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

  // Check if a table exists at all before calling PRAGMA table_info
  async function tableExists(table) {
    const row = await db.get(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [table]
    );
    return !!row;
  }

  console.log('Running migration 003_stacking_schema...\n');

  // ── planner_organisms: add pest_mobility ──────────────────────────────────
  if (await tableExists('planner_organisms')) {
    if (!await hasColumn('planner_organisms', 'pest_mobility')) {
      await db.run(`ALTER TABLE planner_organisms ADD COLUMN pest_mobility TEXT`);
      console.log('  + planner_organisms.pest_mobility');
    } else {
      console.log('  ~ planner_organisms.pest_mobility (already exists)');
    }
  } else {
    console.log('  ! planner_organisms table does not exist yet (run 002 first)');
  }

  // ── planner_processed_interactions: add mechanism, severity_class, stacking_regime ─
  if (await tableExists('planner_processed_interactions')) {
    if (!await hasColumn('planner_processed_interactions', 'mechanism')) {
      await db.run(`ALTER TABLE planner_processed_interactions ADD COLUMN mechanism TEXT`);
      console.log('  + planner_processed_interactions.mechanism');
    } else {
      console.log('  ~ planner_processed_interactions.mechanism (already exists)');
    }

    if (!await hasColumn('planner_processed_interactions', 'severity_class')) {
      await db.run(`ALTER TABLE planner_processed_interactions ADD COLUMN severity_class TEXT`);
      console.log('  + planner_processed_interactions.severity_class');
    } else {
      console.log('  ~ planner_processed_interactions.severity_class (already exists)');
    }

    if (!await hasColumn('planner_processed_interactions', 'stacking_regime')) {
      await db.run(`ALTER TABLE planner_processed_interactions ADD COLUMN stacking_regime TEXT`);
      console.log('  + planner_processed_interactions.stacking_regime');
    } else {
      console.log('  ~ planner_processed_interactions.stacking_regime (already exists)');
    }
  } else {
    console.log('  ! planner_processed_interactions table does not exist yet (run 002 first)');
  }

  // ── crop_companion_scores: add has_threshold_warning ──────────────────────
  if (await tableExists('crop_companion_scores')) {
    if (!await hasColumn('crop_companion_scores', 'has_threshold_warning')) {
      await db.run(
        `ALTER TABLE crop_companion_scores ADD COLUMN has_threshold_warning INTEGER NOT NULL DEFAULT 0`
      );
      console.log('  + crop_companion_scores.has_threshold_warning');
    } else {
      console.log('  ~ crop_companion_scores.has_threshold_warning (already exists)');
    }
  } else {
    console.log('  ! crop_companion_scores table does not exist yet (run 002 first)');
  }

  // ── system_stacking_risks table ───────────────────────────────────────────
  await db.run(`
    CREATE TABLE IF NOT EXISTS system_stacking_risks (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      selection_key         TEXT NOT NULL,
      intermediate_org_id   INTEGER NOT NULL,
      organism_name         TEXT NOT NULL,
      organism_role         TEXT NOT NULL,
      stacking_regime       TEXT NOT NULL,
      mechanism             TEXT NOT NULL,
      affected_crop_ids     TEXT NOT NULL,
      affected_crop_count   INTEGER NOT NULL,
      base_penalty          REAL NOT NULL,
      computed_penalty      REAL NOT NULL,
      risk_tier             TEXT NOT NULL,
      computed_at           TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('  + system_stacking_risks (CREATE IF NOT EXISTS)');

  await db.run(`CREATE INDEX IF NOT EXISTS idx_ssr_key ON system_stacking_risks(selection_key)`);
  console.log('  + idx_ssr_key (CREATE IF NOT EXISTS)');

  console.log('\nMigration 003 complete.');
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
  })().catch(err => { console.error('Migration 003 failed:', err); process.exit(1); });
}

module.exports = { runMigration };
