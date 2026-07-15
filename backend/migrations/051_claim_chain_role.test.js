'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./051_claim_chain_role');

function freshDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE claims (id INTEGER PRIMARY KEY, data_tier TEXT)');
  return db;
}

test('051 adds chain_role to claims', () => {
  const db = freshDb();
  migrate(db);
  const cols = db.prepare('PRAGMA table_info(claims)').all().map(c => c.name);
  assert.ok(cols.includes('chain_role'));
  db.close();
});

test('051 is idempotent', () => {
  const db = freshDb();
  migrate(db);
  migrate(db);
  db.close();
});
