'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runMigration } = require('./035_rename_severity_to_impact');

async function freshDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, severity_class TEXT)`);
  return db;
}

test('migration 035 renames severity_class → impact_class and adds audit column', async () => {
  const db = await freshDb();
  await runMigration(db);
  const cols = (await db.all(`PRAGMA table_info(claims)`)).map(c => c.name);
  assert.ok(cols.includes('impact_class'), 'expected impact_class');
  assert.ok(cols.includes('impact_class_raw'), 'expected impact_class_raw audit column');
  assert.ok(!cols.includes('severity_class'), 'severity_class should be gone');
});

test('migration 035 normalizes free-text values', async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`CREATE TABLE claims (id INTEGER PRIMARY KEY, severity_class TEXT)`);
  await db.run(`INSERT INTO claims (id, severity_class) VALUES
    (1, 'low'), (2, 'minor'), (3, 'severe'), (4, 'OUTBREAK'), (5, 'unknown_value'), (6, NULL)`);
  await runMigration(db);
  const rows = await db.all(`SELECT id, impact_class, impact_class_raw FROM claims ORDER BY id`);
  assert.equal(rows[0].impact_class, 'low');
  assert.equal(rows[1].impact_class, 'low');
  assert.equal(rows[2].impact_class, 'high');
  assert.equal(rows[3].impact_class, 'high');
  assert.equal(rows[4].impact_class, null);
  assert.equal(rows[4].impact_class_raw, 'unknown_value');
  assert.equal(rows[5].impact_class, null);
});

test('migration 035 is idempotent', async () => {
  const db = await freshDb();
  await runMigration(db);
  await runMigration(db);
});
