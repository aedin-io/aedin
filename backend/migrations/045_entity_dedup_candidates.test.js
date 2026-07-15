'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration } = require('./045_entity_dedup_candidates');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT)`);
  return db;
}

test('migration 045 creates entity_dedup_candidates with required columns', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(entity_dedup_candidates)`)).map(c => c.name);
  for (const c of ['id','entity_a_id','entity_b_id','genus','levenshtein_distance','match_basis','suggested_canonical_id','status','flagged_at','reviewed_at','reviewer_id','notes']) {
    assert.ok(cols.includes(c), `missing ${c}`);
  }
});

test('migration 045 adds merged_into_entity_id to entities', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(entities)`)).map(c => c.name);
  assert.ok(cols.includes('merged_into_entity_id'));
});

test('migration 045 enforces status CHECK', async () => {
  const db = await freshDb();
  await runMigration(db);
  await assert.rejects(
    db.run(`INSERT INTO entity_dedup_candidates (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id, status) VALUES (1,2,'Apis',1,'species_epithet',1,'bogus')`),
    /CHECK/
  );
});

test('migration 045 enforces UNIQUE on the ordered pair', async () => {
  const db = await freshDb();
  await runMigration(db);
  await db.run(`INSERT INTO entity_dedup_candidates (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id) VALUES (1,2,'Apis',1,'species_epithet',1)`);
  await assert.rejects(
    db.run(`INSERT INTO entity_dedup_candidates (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id) VALUES (1,2,'Apis',1,'species_epithet',1)`),
    /UNIQUE/
  );
});

test('migration 045 is idempotent', async () => {
  const db = await freshDb();
  await runMigration(db);
  await runMigration(db);
});
