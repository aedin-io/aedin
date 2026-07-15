'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { sweepDedup, pickCanonical } = require('./sweep-entity-dedup');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (
    id INTEGER PRIMARY KEY, scientific_name TEXT, genus TEXT,
    grin_accession TEXT, gbif_key INTEGER, merged_into_entity_id INTEGER, bio_category TEXT
  )`);
  await db.exec(`CREATE TABLE entity_dedup_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity_a_id INTEGER, entity_b_id INTEGER, genus TEXT,
    levenshtein_distance INTEGER, match_basis TEXT, suggested_canonical_id INTEGER,
    status TEXT DEFAULT 'pending', flagged_at TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT, reviewer_id TEXT, notes TEXT, UNIQUE(entity_a_id, entity_b_id)
  )`);
  return db;
}

test('pickCanonical prefers the GBIF/GRIN-anchored entity', () => {
  const anchored = { id: 1, grin_accession: null, gbif_key: 5000 };
  const plain = { id: 2, grin_accession: null, gbif_key: null };
  assert.equal(pickCanonical(anchored, plain), 1);
  assert.equal(pickCanonical(plain, anchored), 1);
});

test('pickCanonical returns null when both anchored (force human pick)', () => {
  const a = { id: 1, grin_accession: 'PI 1', gbif_key: null };
  const b = { id: 2, grin_accession: null, gbif_key: 9 };
  assert.equal(pickCanonical(a, b), null);
});

test('sweepDedup flags the Apis melliferae/mellifera typo pair', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO entities (id, scientific_name, genus, gbif_key) VALUES
    (1,'Apis mellifera','Apis',5000), (2,'Apis melliferae','Apis',NULL)`);
  const n = await sweepDedup(db);
  assert.equal(n, 1);
  const cand = await db.get(`SELECT * FROM entity_dedup_candidates`);
  assert.equal(cand.genus, 'Apis');
  assert.equal(cand.levenshtein_distance, 1);
  assert.equal(cand.suggested_canonical_id, 1); // the GBIF-anchored one
});

test('sweepDedup does not flag distinct species in same genus', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO entities (id, scientific_name, genus) VALUES
    (1,'Apis mellifera','Apis'), (2,'Apis dorsata','Apis')`);
  const n = await sweepDedup(db);
  assert.equal(n, 0); // epithet distance > 2
});

test('sweepDedup is idempotent (INSERT OR IGNORE on the pair)', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO entities (id, scientific_name, genus, gbif_key) VALUES
    (1,'Apis mellifera','Apis',5000), (2,'Apis melliferae','Apis',NULL)`);
  await sweepDedup(db);
  await sweepDedup(db);
  const { c } = await db.get(`SELECT COUNT(*) c FROM entity_dedup_candidates`);
  assert.equal(c, 1);
});
