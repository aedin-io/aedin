'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { resolveStagingRows } = require('./postrag-resolve');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, common_name TEXT, synonyms TEXT, genus TEXT)`);
  await db.exec(`CREATE TABLE extraction_staging (
    id INTEGER PRIMARY KEY, target_table TEXT, payload TEXT,
    entity_resolution_status TEXT, resolved_subject_entity_id INTEGER, resolved_object_entity_id INTEGER
  )`);
  await db.run(`INSERT INTO entities (id, scientific_name, common_name, synonyms, genus) VALUES
    (1,'Apis mellifera','Western honey bee',NULL,'Apis'),
    (2,'Solanum lycopersicum','Tomato',NULL,'Solanum')`);
  return db;
}

test('resolveStagingRows marks both-resolved row as verified', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload) VALUES (10, 'claims', ?)`,
    JSON.stringify({ subject_organism: 'Apis mellifera', object_organism: 'Solanum lycopersicum' }));
  await resolveStagingRows(db);
  const row = await db.get(`SELECT * FROM extraction_staging WHERE id=10`);
  assert.equal(row.entity_resolution_status, 'verified');
  assert.equal(row.resolved_subject_entity_id, 1);
  assert.equal(row.resolved_object_entity_id, 2);
});

test('a typo subject downgrades the row to fuzzy_verified', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload) VALUES (11, 'claims', ?)`,
    JSON.stringify({ subject_organism: 'Apis melliferae', object_organism: 'Solanum lycopersicum' }));
  await resolveStagingRows(db);
  const row = await db.get(`SELECT * FROM extraction_staging WHERE id=11`);
  assert.equal(row.entity_resolution_status, 'fuzzy_verified');
  assert.equal(row.resolved_subject_entity_id, 1);
});

test('an unknown object marks the row unverified', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload) VALUES (12, 'claims', ?)`,
    JSON.stringify({ subject_organism: 'Apis mellifera', object_organism: 'Drosophila suzukii' }));
  await resolveStagingRows(db);
  const row = await db.get(`SELECT * FROM extraction_staging WHERE id=12`);
  assert.equal(row.entity_resolution_status, 'unverified');
});

test('resolveStagingRows is idempotent (skips already-resolved rows)', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO extraction_staging (id, target_table, payload) VALUES (13, 'claims', ?)`,
    JSON.stringify({ subject_organism: 'Apis mellifera', object_organism: 'Solanum lycopersicum' }));
  const n1 = await resolveStagingRows(db);
  const n2 = await resolveStagingRows(db);
  assert.equal(n1, 1);
  assert.equal(n2, 0);
});
