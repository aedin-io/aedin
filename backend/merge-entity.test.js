// backend/merge-entity.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m045 } = require('./migrations/045_entity_dedup_candidates');
const { runMigration: m064 } = require('./migrations/064_entity_dedup_tier');
const { runMigration: m065 } = require('./migrations/065_entity_dedup_log');
const { mergeCandidate, unmergeEntity } = require('./merge-entity');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (
    id INTEGER PRIMARY KEY, scientific_name TEXT, merged_into_entity_id INTEGER,
    parent_entity_id INTEGER, needs_dedup INTEGER DEFAULT 0)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER)`);
  await m045(db); await m064(db); await m065(db);
  // canonical 100 'Citrus limon'; loser 101 'Citrus × limon'; child variety 102 -> parent 101.
  await db.run(`INSERT INTO entities (id, scientific_name, parent_entity_id, needs_dedup) VALUES
    (100,'Citrus limon',NULL,1), (101,'Citrus × limon',NULL,1), (102,"Citrus × limon 'Eureka'",101,0)`);
  // claim 1: object=101 (loser). claim 2: subject=101 AND object=100 (canonical on the other end).
  await db.run(`INSERT INTO claims (id, subject_entity_id, object_entity_id) VALUES (1, 999, 101), (2, 101, 100)`);
  await db.run(`INSERT INTO entity_trait_claims (id, entity_id) VALUES (5, 101)`);
  await db.run(`INSERT INTO entity_dedup_candidates (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id, tier)
    VALUES (100, 101, '', 0, 'slug_collision', 100, 'auto_safe')`);
  return db;
}

test('mergeCandidate redirects FKs incl. children, logs exact ids; unmergeEntity restores', async () => {
  const db = await setup();
  const candId = (await db.get(`SELECT id FROM entity_dedup_candidates`)).id;
  const r = await mergeCandidate(db, candId, { reviewer_id: 'test' });
  assert.equal(r.canonical_id, 100);
  assert.equal(r.merged_id, 101);
  // FKs moved to canonical
  assert.equal((await db.get(`SELECT object_entity_id FROM claims WHERE id=1`)).object_entity_id, 100);
  assert.equal((await db.get(`SELECT subject_entity_id FROM claims WHERE id=2`)).subject_entity_id, 100);
  assert.equal((await db.get(`SELECT entity_id FROM entity_trait_claims WHERE id=5`)).entity_id, 100);
  assert.equal((await db.get(`SELECT parent_entity_id FROM entities WHERE id=102`)).parent_entity_id, 100);
  // loser tombstoned, candidate merged
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=101`)).merged_into_entity_id, 100);
  assert.equal((await db.get(`SELECT status FROM entity_dedup_candidates WHERE id=?`, candId)).status, 'merged');
  // log captured the exact ids
  const log = await db.get(`SELECT * FROM entity_dedup_log WHERE id=?`, r.logId);
  assert.deepEqual(JSON.parse(log.redirected_claim_ids), { subject: [2], object: [1] });
  assert.deepEqual(JSON.parse(log.redirected_trait_claim_ids), [5]);
  assert.deepEqual(JSON.parse(log.redirected_child_ids), [102]);

  await unmergeEntity(db, r.logId);
  assert.equal((await db.get(`SELECT object_entity_id FROM claims WHERE id=1`)).object_entity_id, 101);
  assert.equal((await db.get(`SELECT subject_entity_id, object_entity_id FROM claims WHERE id=2`)).subject_entity_id, 101);
  assert.equal((await db.get(`SELECT object_entity_id FROM claims WHERE id=2`)).object_entity_id, 100); // canonical's own end untouched
  assert.equal((await db.get(`SELECT entity_id FROM entity_trait_claims WHERE id=5`)).entity_id, 101);
  assert.equal((await db.get(`SELECT parent_entity_id FROM entities WHERE id=102`)).parent_entity_id, 101);
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=101`)).merged_into_entity_id, null);
  assert.equal((await db.get(`SELECT status FROM entity_dedup_candidates WHERE id=?`, candId)).status, 'pending');
  assert.ok((await db.get(`SELECT undone_at FROM entity_dedup_log WHERE id=?`, r.logId)).undone_at);
});

test('unmergeEntity throws if already undone', async () => {
  const db = await setup();
  const candId = (await db.get(`SELECT id FROM entity_dedup_candidates`)).id;
  const r = await mergeCandidate(db, candId, { reviewer_id: 'test' });
  await unmergeEntity(db, r.logId);
  await assert.rejects(() => unmergeEntity(db, r.logId), /already undone/i);
});

test('mergeCandidate forwards earlier losers that pointed at the merged entity', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (
    id INTEGER PRIMARY KEY, scientific_name TEXT, merged_into_entity_id INTEGER,
    parent_entity_id INTEGER, needs_dedup INTEGER DEFAULT 0)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER)`);
  await m045(db); await m064(db); await m065(db);
  // canonical 1; loser 2; entity 3 was previously merged INTO entity 2 (the loser-to-be): 3 -> 2.
  await db.run(`INSERT INTO entities (id, scientific_name, merged_into_entity_id) VALUES (1, 'Citrus limon', NULL), (2, 'Citrus limon var', NULL), (3, 'Apis melliferra', 2)`);
  await db.run(`INSERT INTO entity_dedup_candidates (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id, tier)
    VALUES (1, 2, '', 0, 'slug_collision', 1, 'auto_safe')`);
  // Now merge candidate: loser 2 -> canonical 1. Entity 3 must be forwarded 2 -> 1.
  const candId = (await db.get(`SELECT id FROM entity_dedup_candidates`)).id;
  await mergeCandidate(db, candId, { reviewer_id: 'test' });
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=3`)).merged_into_entity_id, 1);
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=2`)).merged_into_entity_id, 1);
});

test('mergeCandidate resolves stale canonical (tombstoned) to terminal before merging', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (
    id INTEGER PRIMARY KEY, scientific_name TEXT, merged_into_entity_id INTEGER,
    parent_entity_id INTEGER, needs_dedup INTEGER DEFAULT 0)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER)`);
  await m045(db); await m064(db); await m065(db);
  // entity 1: live terminal canonical.
  // entity 2: live, will be the loser.
  // entity 7: tombstone — was previously merged into entity 1 (merged_into_entity_id = 1).
  await db.run(`INSERT INTO entities (id, scientific_name, merged_into_entity_id) VALUES
    (1, 'Apis mellifera', NULL),
    (2, 'Apis melliferra', NULL),
    (7, 'Apis mellifora', 1)`);
  // Candidate: entity_a=7 (the stale "canonical"), entity_b=2 (the loser), suggested_canonical_id=7.
  // After terminal resolution: canonical_id 7 → 1; merged_id = entity_b_id = 2.
  await db.run(`INSERT INTO entity_dedup_candidates (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id, tier)
    VALUES (7, 2, 'Apis', 1, 'levenshtein', 7, 'auto_safe')`);
  const candId = (await db.get(`SELECT id FROM entity_dedup_candidates`)).id;
  const r = await mergeCandidate(db, candId, { reviewer_id: 'test' });
  // canonical_id in return value must be the terminal (1), not the stale tombstone (7).
  assert.equal(r.canonical_id, 1);
  assert.equal(r.merged_id, 2);
  // Loser (2) must point at the terminal canonical (1), NOT the tombstone (7).
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=2`)).merged_into_entity_id, 1);
});
