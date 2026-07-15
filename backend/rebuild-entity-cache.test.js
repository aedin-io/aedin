'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m032 } = require('./migrations/032_entity_trait_claims');
const { runMigration: m033 } = require('./migrations/033_traits_vocabulary');
const { rebuildCache } = require('./rebuild-entity-cache');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, bio_category TEXT,
      ph_min REAL, ph_max REAL, thermal_min REAL, voltinism TEXT, host_range TEXT,
      bloom_months TEXT);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, title TEXT, source_type TEXT);
  `);
  await m032(db);
  await m033(db);
  return db;
}

test('rebuildCache picks human_verified over api_sync over consensus', async () => {
  const db = await setup();
  await db.run(`INSERT INTO sources (id, title, source_type) VALUES (1,'Trefle','api_sync'),(2,'Pedigo','book'),(3,'Reviewer','human_verified')`);
  await db.run(`INSERT INTO entities (id, scientific_name) VALUES (1, 'Plutella xylostella')`);
  await db.run(`INSERT INTO entity_trait_claims (entity_id, trait_name, value_numeric, source_id, review_status) VALUES
    (1,'thermal_min',5.0,1,'ai_reviewed'),
    (1,'thermal_min',7.3,2,'ai_reviewed'),
    (1,'thermal_min',6.5,3,'human_verified')`);
  await rebuildCache(db);
  const e = await db.get(`SELECT thermal_min FROM entities WHERE id = 1`);
  assert.equal(e.thermal_min, 6.5);
});

test('rebuildCache JSON-serializes list traits', async () => {
  const db = await setup();
  await db.run(`INSERT INTO sources (id, title, source_type) VALUES (1, 'X', 'api_sync')`);
  await db.run(`INSERT INTO entities (id, scientific_name) VALUES (1, 'X sp.')`);
  await db.run(`INSERT INTO entity_trait_claims (entity_id, trait_name, value_json, source_id, review_status) VALUES
    (1,'host_range','["Brassica oleracea","Brassica napus"]',1,'ai_reviewed')`);
  await rebuildCache(db);
  const e = await db.get(`SELECT host_range FROM entities WHERE id = 1`);
  assert.deepEqual(JSON.parse(e.host_range), ['Brassica oleracea','Brassica napus']);
});

test('rebuildCache skips traits without entities column', async () => {
  const db = await setup();
  await db.run(`INSERT INTO sources (id, title, source_type) VALUES (1, 'X', 'api_sync')`);
  await db.run(`INSERT INTO entities (id, scientific_name) VALUES (1, 'X sp.')`);
  await db.run(`INSERT INTO entity_trait_claims (entity_id, trait_name, value_numeric, source_id, review_status) VALUES
    (1,'nitrogen_fixation_rate_kg_per_ha_per_yr',150.0,1,'ai_reviewed')`);
  await rebuildCache(db);
  // no error; entity row unchanged
  const e = await db.get(`SELECT * FROM entities WHERE id = 1`);
  assert.ok(e);
});
