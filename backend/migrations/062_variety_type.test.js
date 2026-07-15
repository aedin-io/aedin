'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./062_variety_type.js');

test('migration adds nullable variety_type column (idempotent)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT)');
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(entities)').all().map(c => c.name);
  assert.ok(cols.includes('variety_type'));
  migrate(db); // idempotent — no throw
  db.close();
});
