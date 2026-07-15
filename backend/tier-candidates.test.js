'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration: m045 } = require('./migrations/045_entity_dedup_candidates');
const { runMigration: m064 } = require('./migrations/064_entity_dedup_tier');
const { tierAllCandidates } = require('./tier-candidates');

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (
    id INTEGER PRIMARY KEY, scientific_name TEXT, gbif_key TEXT, scope_tier INTEGER,
    merged_into_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  await db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER)`);
  await m045(db); await m064(db);
  await db.run(`INSERT INTO entities (id, scientific_name, scope_tier) VALUES
    (1,'Citrus limon',0), (2,'Citrus × limon',3),
    (3,'Achilea milefolium',NULL), (4,'Achillea millefolium',NULL),
    (5,'Chorebus eros',NULL), (6,'Chorebus bres',NULL)`);
  await db.run(`INSERT INTO entity_dedup_candidates (entity_a_id, entity_b_id, genus, levenshtein_distance, match_basis) VALUES
    (1,2,'',0,'slug_collision'), (3,4,'Achillea',1,'species_epithet'), (5,6,'Chorebus',2,'species_epithet')`);
  return db;
}

test('tierAllCandidates writes tier + canonical for every candidate; histogram correct; idempotent', async () => {
  const db = await setup();
  const h = await tierAllCandidates(db);
  assert.deepEqual(h, { auto_safe: 1, needs_review: 1, domain: 1 });
  const byPair = {};
  for (const r of await db.all(`SELECT entity_a_id, tier, suggested_canonical_id FROM entity_dedup_candidates`)) byPair[r.entity_a_id] = r;
  assert.equal(byPair[1].tier, 'domain');         // ×-marker
  assert.equal(byPair[3].tier, 'auto_safe');      // distance-1 typo
  assert.equal(byPair[5].tier, 'needs_review');   // distance-2
  assert.equal(byPair[1].suggested_canonical_id, 1); // Citrus limon served tier-0
  const h2 = await tierAllCandidates(db);         // idempotent
  assert.deepEqual(h2, h);
});

test('tierAllCandidates skips non-pending candidates', async () => {
  const db = await setup();
  // mark the Chorebus pair (entity_a_id=5) as already merged with a stale tier
  await db.run(`UPDATE entity_dedup_candidates SET status='merged', tier='STALE' WHERE entity_a_id=5`);
  const h = await tierAllCandidates(db);
  // only the 2 pending candidates are counted now
  assert.equal(h.auto_safe + h.needs_review + h.domain, 2);
  // the merged row keeps its stale tier (was not recomputed)
  assert.equal((await db.get(`SELECT tier FROM entity_dedup_candidates WHERE entity_a_id=5`)).tier, 'STALE');
});
