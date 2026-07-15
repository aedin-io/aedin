'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('../migrations/061_entity_common_names');
const { upsertName } = require('./common-name-upsert');

function freshDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY, common_name TEXT)');
  migrate(db);
  return db;
}

test('upsertName inserts, dedupes case-insensitively, and merges source', () => {
  const db = freshDb();
  upsertName(db, 1, { name: 'Garlic', language: 'en', source: 'gbif', source_ref: 'CoL', is_preferred: 0 });
  upsertName(db, 1, { name: 'garlic', language: 'en', source: 'wikidata', source_ref: 'Q23400', is_preferred: 1 });
  const rows = db.prepare('SELECT name, language, source, is_preferred FROM entity_common_names WHERE entity_id=1').all();
  assert.equal(rows.length, 1);                          // deduped
  assert.equal(rows[0].source, 'gbif,wikidata');         // merged
  assert.equal(rows[0].is_preferred, 1);                 // preferred wins
  db.close();
});

test('upsertName keeps distinct names and languages separate', () => {
  const db = freshDb();
  upsertName(db, 1, { name: 'garlic', language: 'en', source: 'gbif', source_ref: null, is_preferred: 0 });
  upsertName(db, 1, { name: 'ajo', language: 'es', source: 'gbif', source_ref: null, is_preferred: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entity_common_names WHERE entity_id=1').get().n, 2);
  db.close();
});
