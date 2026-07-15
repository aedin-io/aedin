'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { selectServedMerges, mergePatchSql, assertNoTombstoneCanon } = require('./gen-merge-d1-patch.cjs');

function seed() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, merged_into_entity_id INTEGER);
    CREATE TABLE entity_dedup_log (
      id INTEGER PRIMARY KEY, canonical_entity_id INTEGER, merged_entity_id INTEGER, undone_at TEXT);
  `);
  // canonical 100 (served), loser 200 (served, active merge) → reconcile
  db.prepare(`INSERT INTO entities (id, slug) VALUES (100, 'canon')`).run();
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (200, 'loser-typo', 100)`).run();
  db.prepare(`INSERT INTO entity_dedup_log (canonical_entity_id, merged_entity_id, undone_at) VALUES (100, 200, NULL)`).run();
  // loser 300 UNSERVED (no slug) → skip (no D1 page)
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (300, NULL, 100)`).run();
  db.prepare(`INSERT INTO entity_dedup_log (canonical_entity_id, merged_entity_id, undone_at) VALUES (100, 300, NULL)`).run();
  // loser 400 UNDONE (reversed) → skip
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (400, 'undone', NULL)`).run();
  db.prepare(`INSERT INTO entity_dedup_log (canonical_entity_id, merged_entity_id, undone_at) VALUES (100, 400, '2026-06-26')`).run();
  return db;
}

test('selectServedMerges picks only active + served losers', () => {
  const rows = selectServedMerges(seed());
  assert.deepEqual(rows, [{ loser: 200, canon: 100 }]);
});

test('mergePatchSql emits tombstone + claim(subject,object) + trait re-point per pair', () => {
  const sql = mergePatchSql([{ loser: 200, canon: 100 }]);
  assert.match(sql, /UPDATE entities SET merged_into_entity_id=100 WHERE id=200;/);
  assert.match(sql, /UPDATE claims SET subject_entity_id=100 WHERE subject_entity_id=200;/);
  assert.match(sql, /UPDATE claims SET object_entity_id=100 WHERE object_entity_id=200;/);
  assert.match(sql, /UPDATE entity_trait_claims SET entity_id=100 WHERE entity_id=200;/);
});

test('mergePatchSql is empty-safe', () => {
  assert.equal(mergePatchSql([]).includes('UPDATE'), false);
});

function seedChain() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, merged_into_entity_id INTEGER)`);
  // FLAT: loser 5 -> terminal 8 (8 is a live canonical, merged_into NULL)
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (8,'term',NULL)`).run();
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (5,'loser',8)`).run();
  return db;
}

function seedUnflattened() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, slug TEXT, merged_into_entity_id INTEGER)`);
  // CHAINED: 5 -> 6 -> 8 ; 6 is still a tombstone (merged_into not NULL)
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (8,'term',NULL)`).run();
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (6,'hop',8)`).run();
  db.prepare(`INSERT INTO entities (id, slug, merged_into_entity_id) VALUES (5,'loser',6)`).run();
  return db;
}

test('selectServedMerges sources canon from entities.merged_into (one row per served tombstone)', () => {
  assert.deepEqual(selectServedMerges(seedChain()), [{ loser: 5, canon: 8 }]);
});

test('assertNoTombstoneCanon passes when every canon is a live canonical', () => {
  const db = seedChain();
  const rows = selectServedMerges(db);
  assert.deepEqual(assertNoTombstoneCanon(db, rows), rows);
});

test('assertNoTombstoneCanon throws when a canon is itself a tombstone (un-flattened corpus)', () => {
  const db = seedUnflattened();
  const rows = selectServedMerges(db); // loser 5 -> canon 6, but 6 is a tombstone
  assert.throws(() => assertNoTombstoneCanon(db, rows), /tombstone canonical/i);
});
