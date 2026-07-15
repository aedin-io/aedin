'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration } = require('./049_entity_lineage_source');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT)`);
  return db;
}

test('migration 049 adds lineage_source to entities', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(entities)`)).map(c => c.name);
  assert.ok(cols.includes('lineage_source'));
});

test('migration 049 is idempotent', async () => {
  const db = await freshDb();
  await runMigration(db);
  await runMigration(db);
});
