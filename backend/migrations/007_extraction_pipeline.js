/**
 * Migration 007: LLM Extraction Pipeline
 *
 * Creates three tables supporting automated extraction, staging review,
 * and the Trefle enrichment contribution loop.
 *
 * Usage:
 *   node migrations/007_extraction_pipeline.js
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

async function runMigration(db) {
  console.log('Running migration 007_extraction_pipeline...\n');

  // 1. extraction_queue — items to be extracted via LLM
  await db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      url           TEXT,
      file_path     TEXT,
      source_type   TEXT NOT NULL DEFAULT 'unknown',
      priority      INTEGER DEFAULT 5,
      status        TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      source_id     INTEGER REFERENCES sources(id),
      added_at      TEXT DEFAULT (datetime('now')),
      started_at    TEXT,
      completed_at  TEXT,
      CHECK (url IS NOT NULL OR file_path IS NOT NULL)
    )
  `);
  console.log('  + extraction_queue (CREATE IF NOT EXISTS)');

  // 2. extraction_staging — staged claims awaiting review
  await db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_staging (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      queue_id       INTEGER NOT NULL REFERENCES extraction_queue(id),
      source_id      INTEGER REFERENCES sources(id),
      target_table   TEXT NOT NULL,
      payload        TEXT NOT NULL,
      review_status  TEXT NOT NULL DEFAULT 'pending',
      review_note    TEXT,
      reviewed_at    TEXT,
      created_at     TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('  + extraction_staging (CREATE IF NOT EXISTS)');

  // 3. pending_crops — Trefle enrichment contribution loop
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pending_crops (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      scientific_name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
      common_name         TEXT,
      region_context      TEXT,
      source_id           INTEGER REFERENCES sources(id),
      enrichment_payload  TEXT,
      trefle_submitted    INTEGER DEFAULT 0,
      created_at          TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('  + pending_crops (CREATE IF NOT EXISTS)');

  // Indexes for query performance
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_eq_status ON extraction_queue(status);
    CREATE INDEX IF NOT EXISTS idx_eq_url    ON extraction_queue(url);
    CREATE INDEX IF NOT EXISTS idx_es_review ON extraction_staging(review_status);
    CREATE INDEX IF NOT EXISTS idx_es_queue  ON extraction_staging(queue_id);
    CREATE INDEX IF NOT EXISTS idx_pc_name   ON pending_crops(scientific_name)
  `);
  console.log('  + indexes (extraction_queue, extraction_staging, pending_crops)');

  console.log('\nMigration 007 complete.');
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
  })().catch(err => { console.error('Migration 007 failed:', err); process.exit(1); });
}

module.exports = { runMigration };
