'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration } = require('./037_variety_dedup_log');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT)`);
  return db;
}

test('migration 037 creates variety_dedup_log table with all columns', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(variety_dedup_log)`)).map(c => c.name);
  for (const required of [
    'id', 'canonical_entity_id', 'merged_entity_id', 'merged_variety_name',
    'canonical_variety_name', 'parent_entity_id', 'levenshtein_distance',
    'claims_updated', 'entity_trait_claims_updated', 'merged_at', 'notes',
  ]) {
    assert.ok(cols.includes(required), `missing column: ${required}`);
  }
});

test('migration 037 creates required indexes', async () => {
  const db = await freshDb();
  await runMigration(db);
  const idx = (await db.all(
    `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='variety_dedup_log'`
  )).map(i => i.name);
  assert.ok(idx.includes('idx_vdl_canonical'));
  assert.ok(idx.includes('idx_vdl_parent'));
});

test('migration 037 is idempotent', async () => {
  const db = await freshDb();
  await runMigration(db);
  await runMigration(db); // must not throw
});

test('inserting a sample row works', async () => {
  const db = await freshDb();
  await runMigration(db);
  await db.run(`INSERT INTO entities (id, scientific_name) VALUES (1, 'Solanum lycopersicum'), (2, 'Solanum lycopersicum'), (3, 'Solanum lycopersicum')`);
  await db.run(
    `INSERT INTO variety_dedup_log
      (canonical_entity_id, merged_entity_id, merged_variety_name,
       canonical_variety_name, parent_entity_id, levenshtein_distance,
       claims_updated, entity_trait_claims_updated)
     VALUES (2, 3, 'solar fire', 'Solar Fire', 1, 2, 4, 1)`
  );
  const row = await db.get(`SELECT * FROM variety_dedup_log WHERE id = 1`);
  assert.equal(row.merged_variety_name, 'solar fire');
  assert.equal(row.canonical_variety_name, 'Solar Fire');
  assert.equal(row.levenshtein_distance, 2);
});
