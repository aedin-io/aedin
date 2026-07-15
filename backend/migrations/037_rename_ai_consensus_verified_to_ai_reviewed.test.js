'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration } = require('./037_rename_ai_consensus_verified_to_ai_reviewed');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE claims (
      id INTEGER PRIMARY KEY,
      review_status TEXT
    );
    CREATE TABLE entity_trait_claims (
      id INTEGER PRIMARY KEY,
      review_status TEXT
    );
  `);
  return db;
}

test('migration 037 renames ai_consensus_verified → ai_reviewed in claims', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO claims (id, review_status) VALUES
    (1, 'ai_consensus_verified'),
    (2, 'ai_consensus_verified'),
    (3, 'human_verified'),
    (4, 'human_rejected'),
    (5, 'ai_vouched')`);
  await runMigration(db);
  const rows = await db.all(`SELECT id, review_status FROM claims ORDER BY id`);
  assert.equal(rows[0].review_status, 'ai_reviewed');
  assert.equal(rows[1].review_status, 'ai_reviewed');
  assert.equal(rows[2].review_status, 'human_verified',  'human_verified must be untouched');
  assert.equal(rows[3].review_status, 'human_rejected',  'human_rejected must be untouched');
  assert.equal(rows[4].review_status, 'ai_vouched',       'ai_vouched must be untouched');
});

test('migration 037 renames ai_consensus_verified → ai_reviewed in entity_trait_claims', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO entity_trait_claims (id, review_status) VALUES
    (1, 'ai_consensus_verified'),
    (2, 'ai_vouched'),
    (3, 'human_verified')`);
  await runMigration(db);
  const rows = await db.all(`SELECT id, review_status FROM entity_trait_claims ORDER BY id`);
  assert.equal(rows[0].review_status, 'ai_reviewed');
  assert.equal(rows[1].review_status, 'ai_vouched',    'ai_vouched must be untouched');
  assert.equal(rows[2].review_status, 'human_verified', 'human_verified must be untouched');
});

test('migration 037 skips missing tables gracefully', async () => {
  // DB with no claims tables at all
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await assert.doesNotReject(() => runMigration(db));
  await db.close();
});

test('migration 037 is idempotent', async () => {
  const db = await freshDb();
  await db.run(`INSERT INTO claims (id, review_status) VALUES (1, 'ai_consensus_verified')`);
  await runMigration(db);
  await runMigration(db); // second run must not throw or double-rename
  const row = await db.get(`SELECT review_status FROM claims WHERE id=1`);
  assert.equal(row.review_status, 'ai_reviewed');
});
