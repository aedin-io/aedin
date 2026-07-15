// backend/lib/entity-dedup-admin.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m045 } = require('../migrations/045_entity_dedup_candidates');
const { runMigration: m064 } = require('../migrations/064_entity_dedup_tier');
const { runMigration: m065 } = require('../migrations/065_entity_dedup_log');
const { runMigration: m066 } = require('../migrations/066_entity_dedup_verdicts');
const { getReviewQueue, approveMerge, keepSeparate, getEntityLog } = require('./entity-dedup-admin');
const { unmergeEntity } = require('../merge-entity');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, merged_into_entity_id INTEGER, parent_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER)`);
  await m045(db); await m064(db); await m065(db); await m066(db);
  await db.run(`INSERT INTO entities (id, scientific_name) VALUES (10,'Acer rubrum'),(11,'Acer rubru'),(20,'Quercus alba'),(21,'Quercus albus'),(30,'Mentha x'),(31,'Mentha y')`);
  await db.run(`INSERT INTO entity_dedup_candidates (id, entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id, tier, status) VALUES
    (100,10,11,'Acer',1,'species_epithet',10,'auto_safe','pending'),
    (101,20,21,'Quercus',1,'species_epithet',20,'needs_review','pending'),
    (102,30,31,'Mentha',0,'slug_collision',30,'domain','pending')`);
  // 100 has an uncertain verdict → needs human; 101 has a same-high verdict already (NOT shown — it'd be merged elsewhere)
  await db.run(`INSERT INTO entity_dedup_verdicts (candidate_id, critic_name, verdict, confidence, reasoning) VALUES
    (100,'horticulturist','uncertain',0.5,'unclear'),
    (101,'horticulturist','same',0.95,'typo')`);
  return db;
}

test('getReviewQueue returns only human-needed items (uncertain/low + held domain), not high-conf', async () => {
  const db = await setup();
  const q = await getReviewQueue(db);
  const ids = q.map(r => r.candidate_id).sort();
  assert.deepEqual(ids, [100, 102]); // uncertain(100) + held-domain-no-verdict(102); NOT 101 (same@0.95)
  const r100 = q.find(r => r.candidate_id === 100);
  assert.equal(r100.a_name, 'Acer rubrum');
  assert.equal(r100.verdict, 'uncertain');
});

test('approveMerge merges + logs; keepSeparate rejects; undo reverses', async () => {
  const db = await setup();
  const { logId } = await approveMerge(db, 100);
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=11`)).merged_into_entity_id, 10);
  assert.equal((await db.get(`SELECT status FROM entity_dedup_candidates WHERE id=100`)).status, 'merged');
  assert.equal((await getEntityLog(db)).length, 1);
  await keepSeparate(db, 102);
  assert.equal((await db.get(`SELECT status FROM entity_dedup_candidates WHERE id=102`)).status, 'rejected');
  await unmergeEntity(db, logId);
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=11`)).merged_into_entity_id, null);
});

test('approveMerge honors a canonical override', async () => {
  const db = await setup();
  await approveMerge(db, 100, 11); // override canonical to 11
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=10`)).merged_into_entity_id, 11);
});

test('getReviewQueue deduplicates candidate with two verdict rows (GROUP BY guard)', async () => {
  const db = await setup();
  // Candidate 102 (domain, no verdict) — add TWO verdict rows under different critics,
  // both 'uncertain', so both satisfy the WHERE clause without GROUP BY.
  await db.run(`INSERT INTO entity_dedup_verdicts (candidate_id, critic_name, verdict, confidence, reasoning) VALUES
    (102,'horticulturist','uncertain',0.4,'ambiguous common name'),
    (102,'entomologist','uncertain',0.3,'insufficient context')`);
  const q = await getReviewQueue(db);
  const hits = q.filter(r => r.candidate_id === 102);
  assert.equal(hits.length, 1, 'candidate 102 must appear exactly once despite two matching verdict rows');
});
