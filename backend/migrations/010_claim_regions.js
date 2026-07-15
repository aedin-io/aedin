/**
 * Migration 010: Add country/subdivision columns to claims
 *
 * Region data is now populated directly on claims by load-globi-claims.js
 * (one claim per subject/object/type/country/subdivision).
 *
 * This migration adds the columns for databases created before the schema change.
 *
 * Usage:
 *   node migrations/010_claim_regions.js
 */
'use strict';

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { CORPUS_DB } = require('../lib/db-paths.cjs');

async function runMigration(db) {
  console.log('Running migration 010_claim_regions...\n');

  const cols = await db.all('PRAGMA table_info(claims)');
  const hasCountry = cols.some(c => c.name === 'country');

  if (hasCountry) {
    console.log('  country/subdivision columns already exist — nothing to do.');
  } else {
    await db.exec("ALTER TABLE claims ADD COLUMN country TEXT NOT NULL DEFAULT ''");
    await db.exec("ALTER TABLE claims ADD COLUMN subdivision TEXT NOT NULL DEFAULT ''");
    console.log('  + country, subdivision columns on claims');
  }

  await db.exec('CREATE INDEX IF NOT EXISTS idx_claims_country ON claims(country, subdivision)');
  console.log('  + idx_claims_country index');

  console.log('\nMigration 010 complete.');
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
  })().catch(err => { console.error('Migration 010 failed:', err); process.exit(1); });
}

module.exports = { runMigration };
