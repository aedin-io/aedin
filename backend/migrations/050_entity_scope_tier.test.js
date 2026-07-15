'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./050_entity_scope_tier');

function freshDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT)');
  return db;
}

test('050 adds scope_tier to entities', () => {
  const db = freshDb(); migrate(db);
  const cols = db.prepare('PRAGMA table_info(entities)').all().map(c => c.name);
  assert.ok(cols.includes('scope_tier'));
  db.close();
});

test('050 is idempotent', () => {
  const db = freshDb(); migrate(db); migrate(db); db.close();
});
