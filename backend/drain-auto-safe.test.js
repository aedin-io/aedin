'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m045 } = require('./migrations/045_entity_dedup_candidates');
const { runMigration: m064 } = require('./migrations/064_entity_dedup_tier');
const { runMigration: m065 } = require('./migrations/065_entity_dedup_log');
const { emitReviewArtifacts, drainAutoSafe } = require('./drain-auto-safe');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT,
    merged_into_entity_id INTEGER, parent_entity_id INTEGER, needs_dedup INTEGER DEFAULT 0)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER)`);
  await db.exec(`CREATE TABLE revision_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT, target_id INTEGER, field TEXT, before_value TEXT, after_value TEXT,
    changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')))`);
  await m045(db); await m064(db); await m065(db);
  await db.run(`INSERT INTO entities (id, scientific_name) VALUES
    (1,'Achillea millefolium'), (2,'Achilea milefolium'),
    (3,'Mentha piperita'), (4,'Mentha × piperita'),
    (5,'Chorebus eros'), (6,'Chorebus bres')`);
  await db.run(`INSERT INTO claims (id, subject_entity_id, object_entity_id) VALUES (10, 2, 999)`);
  await db.run(`INSERT INTO entity_dedup_candidates (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis, suggested_canonical_id, tier) VALUES
    (1,2,'Achillea',1,'species_epithet',1,'auto_safe'),
    (3,4,'Mentha',0,'slug_collision',3,'domain'),
    (5,6,'Chorebus',2,'species_epithet',5,'needs_review')`);
  return db;
}

test('emitReviewArtifacts returns all domain pairs + an auto_safe sample', async () => {
  const db = await setup();
  const { domain, sample } = await emitReviewArtifacts(db, { sampleSize: 40 });
  assert.equal(domain.length, 1);
  assert.equal(domain[0].a_id, 3);
  assert.equal(sample.length, 1); // only one auto_safe candidate exists
  assert.equal(sample[0].a_id, 1);
});

test('drainAutoSafe merges only auto_safe; dry-run mutates nothing; --apply moves FKs + logs', async () => {
  const db = await setup();
  const dry = await drainAutoSafe(db, { apply: false });
  assert.equal(dry.merged, 1);
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=2`)).merged_into_entity_id, null, 'dry-run mutates nothing');

  const res = await drainAutoSafe(db, { apply: true });
  assert.equal(res.merged, 1);
  assert.deepEqual(res.losers, [2]);
  assert.equal((await db.get(`SELECT merged_into_entity_id FROM entities WHERE id=2`)).merged_into_entity_id, 1);
  assert.equal((await db.get(`SELECT subject_entity_id FROM claims WHERE id=10`)).subject_entity_id, 1);
  // domain + needs_review untouched
  assert.equal((await db.get(`SELECT status FROM entity_dedup_candidates WHERE entity_a_id=3`)).status, 'pending');
  assert.equal((await db.get(`SELECT status FROM entity_dedup_candidates WHERE entity_a_id=5`)).status, 'pending');
  // revision_log row written for the loser
  const rl = await db.get(`SELECT * FROM revision_log WHERE target_id=2`);
  assert.equal(rl.field, 'merged_into_entity_id');
  assert.equal(rl.after_value, '1');
  assert.equal(rl.method, 'entity_dedup_merge');
});
