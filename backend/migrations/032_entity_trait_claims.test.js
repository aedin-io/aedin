'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration } = require('./032_entity_trait_claims');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT)`);
  await db.exec(`CREATE TABLE sources (id INTEGER PRIMARY KEY, title TEXT)`);
  return db;
}

test('migration 032 creates entity_trait_claims table with required columns', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = await db.all(`PRAGMA table_info(entity_trait_claims)`);
  const names = cols.map(c => c.name);
  for (const required of [
    'id', 'entity_id', 'trait_name',
    'value_numeric', 'value_text', 'value_json', 'unit',
    'source_id', 'source_quote', 'source_page', 'regional_context',
    'review_status', 'reviewer_id', 'reviewed_at',
    'ai_vouch_status', 'ai_vouch_note', 'ai_vouched_by', 'ai_vouched_at',
    'staging_id', 'superseded_by', 'created_at',
  ]) {
    assert.ok(names.includes(required), `missing column: ${required}`);
  }
});

test('migration 032 creates required indexes', async () => {
  const db = await freshDb();
  await runMigration(db);
  const idx = await db.all(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entity_trait_claims'`);
  const names = idx.map(i => i.name);
  for (const required of ['idx_etc_entity_trait', 'idx_etc_review', 'idx_etc_source']) {
    assert.ok(names.includes(required), `missing index: ${required}`);
  }
});

test('migration 032 enforces UNIQUE(entity_id, trait_name, source_id, source_quote)', async () => {
  const db = await freshDb();
  await runMigration(db);
  await db.run(`INSERT INTO entities (id, scientific_name) VALUES (1, 'Plutella xylostella')`);
  await db.run(`INSERT INTO sources (id, title) VALUES (1, 'Pedigo 2021')`);
  await db.run(`INSERT INTO entity_trait_claims (entity_id, trait_name, value_numeric, source_id, source_quote)
                VALUES (1, 'thermal_min', 7.3, 1, 'Lower threshold 7.3°C')`);
  await assert.rejects(
    db.run(`INSERT INTO entity_trait_claims (entity_id, trait_name, value_numeric, source_id, source_quote)
            VALUES (1, 'thermal_min', 7.3, 1, 'Lower threshold 7.3°C')`),
    /UNIQUE/
  );
});

test('migration 032 is idempotent', async () => {
  const db = await freshDb();
  await runMigration(db);
  await runMigration(db); // must not throw
});
