'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m037 } = require('./migrations/037_variety_dedup_log');
const { runMigration: m038 } = require('./migrations/038_variety_dedup_reversibility');
const { dedupOnce } = require('./dedup-varieties');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (
    id INTEGER PRIMARY KEY,
    scientific_name TEXT,
    common_name TEXT,
    variety_name TEXT,
    parent_entity_id INTEGER,
    bio_category TEXT,
    primary_role TEXT,
    grin_accession TEXT,
    needs_dedup INTEGER DEFAULT 0,
    merged_into_entity_id INTEGER,
    created_at TEXT
  )`);
  await db.exec(`CREATE TABLE claims (
    id INTEGER PRIMARY KEY,
    subject_entity_id INTEGER,
    object_entity_id INTEGER
  )`);
  await db.exec(`CREATE TABLE entity_trait_claims (
    id INTEGER PRIMARY KEY,
    entity_id INTEGER,
    trait_name TEXT
  )`);
  await m037(db);
  await m038(db);
  return db;
}

test('dedupOnce reports candidates without merging (human-gated)', async () => {
  const db = await setup(); // existing setup() in this file
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role) VALUES (100, 'Solanum lycopersicum', 'plantae', 'crop')`);
  await db.run(`INSERT INTO entities (id, scientific_name, variety_name, parent_entity_id, bio_category, needs_dedup, created_at) VALUES
    (200, 'Solanum lycopersicum', 'Solar Fire', 100, 'plantae', 1, '2026-01-01 10:00:00'),
    (201, 'Solanum lycopersicum', 'solar fire', 100, 'plantae', 1, '2026-01-02 10:00:00')`);
  const result = await dedupOnce(db, {});
  // No merge happened — both rows still present, not tombstoned.
  const remaining = await db.all(`SELECT id FROM entities WHERE parent_entity_id=100 AND merged_into_entity_id IS NULL`);
  assert.equal(remaining.length, 2);
  // It reported the candidate.
  assert.ok(result.candidates.some(g => g.parent.id === 100));
});

test('dedup does NOT merge across different parent_entity_id', async () => {
  const db = await setup();
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role) VALUES
    (100, 'Solanum lycopersicum', 'plantae', 'crop'),
    (101, 'Capsicum annuum', 'plantae', 'crop')`);
  await db.run(`INSERT INTO entities (id, scientific_name, variety_name, parent_entity_id, bio_category, needs_dedup, created_at) VALUES
    (200, 'Solanum lycopersicum', 'Solar Fire', 100, 'plantae', 1, '2026-01-01 10:00:00'),
    (210, 'Capsicum annuum', 'Solar Fire', 101, 'plantae', 1, '2026-01-02 10:00:00')`);
  await dedupOnce(db, { dryRun: false });
  const remaining = await db.all(`SELECT id FROM entities WHERE id IN (200, 210)`);
  assert.equal(remaining.length, 2);
});

test('dedupOnce reports GRIN+non-GRIN pair with correct suggested canonical (no merge)', async () => {
  const db = await setup();
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role) VALUES (100, 'Solanum lycopersicum', 'plantae', 'crop')`);
  await db.run(`INSERT INTO entities (id, scientific_name, variety_name, parent_entity_id, bio_category, grin_accession, needs_dedup, created_at) VALUES
    (200, 'Solanum lycopersicum', 'Solar Fire', 100, 'plantae', 'PI-12345', 0, '2026-01-01 10:00:00'),
    (201, 'Solanum lycopersicum', 'solar fire', 100, 'plantae', NULL, 1, '2026-01-02 10:00:00')`);
  const result = await dedupOnce(db, {});
  // No merge — both rows still present.
  const remaining = await db.all(`SELECT id FROM entities WHERE parent_entity_id = 100 AND merged_into_entity_id IS NULL ORDER BY id`);
  assert.equal(remaining.length, 2);
  // Pair is reported with GRIN-anchored entity as the suggested canonical.
  const group = result.candidates.find(g => g.parent.id === 100);
  assert.ok(group, 'group for parent 100 should be reported');
  const pair = group.pairs[0];
  assert.equal(pair.suggestedCanonicalId, 200, 'GRIN-anchored variety should be suggested canonical');
});

test('dedup dry-run does not modify the DB', async () => {
  const db = await setup();
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role) VALUES (100, 'Solanum lycopersicum', 'plantae', 'crop')`);
  await db.run(`INSERT INTO entities (id, scientific_name, variety_name, parent_entity_id, bio_category, needs_dedup, created_at) VALUES
    (200, 'Solanum lycopersicum', 'Solar Fire', 100, 'plantae', 1, '2026-01-01 10:00:00'),
    (201, 'Solanum lycopersicum', 'solar fire', 100, 'plantae', 1, '2026-01-02 10:00:00')`);
  await dedupOnce(db, { dryRun: true });
  const remaining = await db.all(`SELECT id FROM entities WHERE parent_entity_id = 100`);
  assert.equal(remaining.length, 2, 'dry-run should leave both rows in place');
  const logged = await db.all(`SELECT * FROM variety_dedup_log`);
  assert.equal(logged.length, 0, 'dry-run should not write log rows');
});

test('dedup does NOT merge distant pairs (distance > cap or ratio > 0.20)', async () => {
  const db = await setup();
  await db.run(`INSERT INTO entities (id, scientific_name, bio_category, primary_role) VALUES (100, 'Solanum lycopersicum', 'plantae', 'crop')`);
  await db.run(`INSERT INTO entities (id, scientific_name, variety_name, parent_entity_id, bio_category, needs_dedup, created_at) VALUES
    (200, 'Solanum lycopersicum', 'Solar Fire', 100, 'plantae', 1, '2026-01-01 10:00:00'),
    (201, 'Solanum lycopersicum', 'Beefsteak',  100, 'plantae', 1, '2026-01-02 10:00:00')`);
  await dedupOnce(db, { dryRun: false });
  const remaining = await db.all(`SELECT id FROM entities WHERE parent_entity_id = 100`);
  assert.equal(remaining.length, 2, 'distinct names should not merge');
});
