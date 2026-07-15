'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m037 } = require('../migrations/037_variety_dedup_log');
const { runMigration: m038 } = require('../migrations/038_variety_dedup_reversibility');
const { mergeVariety, unmergeVariety } = require('./merge-variety');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (
    id INTEGER PRIMARY KEY, scientific_name TEXT, variety_name TEXT,
    parent_entity_id INTEGER, grin_accession TEXT, needs_dedup INTEGER DEFAULT 0,
    merged_into_entity_id INTEGER, created_at TEXT)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER)`);
  await m037(db); await m038(db);
  await db.run(`INSERT INTO entities (id, variety_name, parent_entity_id, needs_dedup, created_at) VALUES
    (200,'Solar Fire',100,1,'2026-01-01'), (201,'solar fire',100,1,'2026-01-02')`);
  // claim 1: object=201 (merged). claim 2: subject=201 AND object=200 (canonical on the other end!).
  await db.run(`INSERT INTO claims (id, subject_entity_id, object_entity_id) VALUES (1, 999, 201), (2, 201, 200)`);
  await db.run(`INSERT INTO entity_trait_claims (id, entity_id) VALUES (5, 201)`);
  return db;
}

test('mergeVariety redirects FKs, tombstones, records exact ids; unmerge restores', async () => {
  const db = await setup();
  const logId = await mergeVariety(db, 200, 201);
  // merged tombstoned, canonical flag cleared
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=201`)).merged_into_entity_id, 200);
  assert.equal((await db.get(`SELECT needs_dedup FROM entities WHERE id=200`)).needs_dedup, 0);
  // FKs redirected to canonical
  assert.equal((await db.get(`SELECT object_entity_id FROM claims WHERE id=1`)).object_entity_id, 200);
  assert.equal((await db.get(`SELECT subject_entity_id, object_entity_id FROM claims WHERE id=2`)).subject_entity_id, 200);
  assert.equal((await db.get(`SELECT entity_id FROM entity_trait_claims WHERE id=5`)).entity_id, 200);
  // log captured the per-field ids
  const log = await db.get(`SELECT * FROM variety_dedup_log WHERE id=?`, logId);
  assert.deepEqual(JSON.parse(log.redirected_claim_ids), { subject: [2], object: [1] });
  assert.deepEqual(JSON.parse(log.redirected_trait_claim_ids), [5]);

  await unmergeVariety(db, logId);
  // exact restoration: claim 2 subject back to 201, object STILL 200 (was canonical's own end)
  assert.equal((await db.get(`SELECT object_entity_id FROM claims WHERE id=1`)).object_entity_id, 201);
  assert.equal((await db.get(`SELECT subject_entity_id, object_entity_id FROM claims WHERE id=2`)).subject_entity_id, 201);
  assert.equal((await db.get(`SELECT object_entity_id FROM claims WHERE id=2`)).object_entity_id, 200);
  assert.equal((await db.get(`SELECT entity_id FROM entity_trait_claims WHERE id=5`)).entity_id, 201);
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=201`)).merged_into_entity_id, null);
  assert.equal((await db.get(`SELECT needs_dedup FROM entities WHERE id=201`)).needs_dedup, 1);
  assert.ok((await db.get(`SELECT undone_at FROM variety_dedup_log WHERE id=?`, logId)).undone_at);
});

test('unmergeVariety throws if already undone', async () => {
  const db = await setup();
  const logId = await mergeVariety(db, 200, 201);
  await unmergeVariety(db, logId);
  await assert.rejects(() => unmergeVariety(db, logId), /already undone/i);
});

const { computeCandidates, keepSeparate } = require('./merge-variety');

test('computeCandidates proposes within-parent near-dups, honours rails + canonical order', async () => {
  const db = await setup(); // from earlier: 200 'Solar Fire', 201 'solar fire', both parent 100, needs_dedup=1
  await db.run(`INSERT INTO entities (id, variety_name, parent_entity_id, grin_accession, needs_dedup) VALUES
    (202,'Brandywine',100,'PI 1',1), (203,'Brandywine',100,'PI 2',1)`); // distinct GRIN → never paired
  const groups = await computeCandidates(db);
  const g = groups.find(x => x.parent.id === 100);
  const pair = g.pairs.find(p => (p.a === 200 && p.b === 201) || (p.a === 201 && p.b === 200));
  assert.ok(pair, 'Solar Fire / solar fire should be a candidate');
  assert.equal(pair.suggestedCanonicalId, 200); // older created_at wins (neither has GRIN, both flagged)
  assert.ok(pair.aName, 'pair must include aName');
  assert.ok(pair.bName, 'pair must include bName');
  assert.ok(!g.pairs.some(p => (p.a === 202 || p.b === 202) && (p.a === 203 || p.b === 203)),
    'distinct-GRIN pair must not be proposed');
});

test('keepSeparate clears needs_dedup on both', async () => {
  const db = await setup();
  await keepSeparate(db, 200, 201);
  assert.equal((await db.get(`SELECT needs_dedup FROM entities WHERE id=200`)).needs_dedup, 0);
  assert.equal((await db.get(`SELECT needs_dedup FROM entities WHERE id=201`)).needs_dedup, 0);
  assert.equal((await computeCandidates(db)).length, 0); // pair no longer surfaces
});
