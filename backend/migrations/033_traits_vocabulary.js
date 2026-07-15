'use strict';

const SEED = require('./033_traits_vocabulary.seed');

async function runMigration(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS traits_vocabulary (
      trait_name                TEXT PRIMARY KEY,
      value_kind                TEXT NOT NULL CHECK (value_kind IN ('numeric','categorical','range','list','boolean')),
      expected_unit             TEXT,
      applicable_bio_categories TEXT NOT NULL,  -- JSON array
      enum_values               TEXT,            -- JSON array (categorical only)
      description               TEXT NOT NULL,
      upstream_mappings         TEXT,            -- JSON object
      introduced_at             TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  for (const r of SEED) {
    await db.run(
      `INSERT OR IGNORE INTO traits_vocabulary
        (trait_name, value_kind, expected_unit, applicable_bio_categories, enum_values, description, upstream_mappings)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        r.trait_name,
        r.value_kind,
        r.expected_unit ?? null,
        JSON.stringify(r.applicable_bio_categories),
        r.enum_values ? JSON.stringify(r.enum_values) : null,
        r.description,
        JSON.stringify(r.upstream_mappings || {}),
      ]
    );
  }
  console.log(`[migration-033] traits_vocabulary seeded with ${SEED.length} rows.`);
}

module.exports = { runMigration };

if (require.main === module) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const { CORPUS_DB } = require('../lib/db-paths.cjs');
  (async () => {
    const db = await open({ filename: CORPUS_DB, driver: sqlite3.Database });
    await runMigration(db);
    await db.close();
  })().catch(err => { console.error('Fatal:', err); process.exit(1); });
}
