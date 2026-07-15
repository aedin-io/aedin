'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { backfillClaims, classifyClaim } = require('./postrag-backfill');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, merged_into_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER, review_status TEXT, entity_resolution_status TEXT)`);
  await db.exec(`CREATE TABLE entity_dedup_candidates (id INTEGER PRIMARY KEY, entity_a_id INTEGER, entity_b_id INTEGER, status TEXT)`);
  await db.run(`INSERT INTO entities (id) VALUES (1),(2),(3)`);
  return db;
}

test('classifyClaim: both ids present and not merge-candidates => verified', () => {
  assert.equal(classifyClaim({ subject_entity_id: 1, object_entity_id: 2 }, new Set(), new Set()), 'verified');
});

test('classifyClaim: a null entity id => unverified', () => {
  assert.equal(classifyClaim({ subject_entity_id: null, object_entity_id: 2 }, new Set(), new Set()), 'unverified');
});

test('classifyClaim: an entity in a pending merge-candidate => fuzzy_verified', () => {
  assert.equal(classifyClaim({ subject_entity_id: 1, object_entity_id: 2 }, new Set([1]), new Set()), 'fuzzy_verified');
});

test('classifyClaim: an already-tombstoned entity => unverified', () => {
  assert.equal(classifyClaim({ subject_entity_id: 1, object_entity_id: 2 }, new Set(), new Set([1])), 'unverified');
});

test('backfillClaims writes statuses; --dry-run writes nothing', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO claims (id, subject_entity_id, object_entity_id, review_status) VALUES (10,1,2,'ai_reviewed'), (11,1,NULL,'ai_reviewed')`);
  const dry = await backfillClaims(db, { dryRun: true });
  assert.equal((await db.get(`SELECT entity_resolution_status FROM claims WHERE id=10`)).entity_resolution_status, null);
  assert.ok(dry.histogram.verified >= 1 && dry.histogram.unverified >= 1);
  const live = await backfillClaims(db, { dryRun: false });
  assert.equal((await db.get(`SELECT entity_resolution_status FROM claims WHERE id=10`)).entity_resolution_status, 'verified');
  assert.equal((await db.get(`SELECT entity_resolution_status FROM claims WHERE id=11`)).entity_resolution_status, 'unverified');
  const again = await backfillClaims(db, { dryRun: false });
  assert.equal(again.updated, 0);
});
