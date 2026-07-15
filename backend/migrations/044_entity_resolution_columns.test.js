'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration } = require('./044_entity_resolution_columns');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE extraction_staging (id INTEGER PRIMARY KEY, payload TEXT)`);
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER)`);
  return db;
}

test('migration 044 adds resolution columns to extraction_staging', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(extraction_staging)`)).map(c => c.name);
  for (const c of ['entity_resolution_status', 'resolved_subject_entity_id', 'resolved_object_entity_id']) {
    assert.ok(cols.includes(c), `missing ${c}`);
  }
});

test('migration 044 adds entity_resolution_status to claims', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(claims)`)).map(c => c.name);
  assert.ok(cols.includes('entity_resolution_status'));
});

test('migration 044 is idempotent', async () => {
  const db = await freshDb();
  await runMigration(db);
  await runMigration(db); // must not throw on duplicate ADD COLUMN
});
