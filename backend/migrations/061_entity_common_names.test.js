'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./061_entity_common_names');

test('061 creates entity_common_names, drops species_common_names, adds resume marker — idempotently', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY, common_name TEXT)');
  db.exec('CREATE TABLE species_common_names (id INTEGER PRIMARY KEY, scientific_name TEXT UNIQUE)');

  migrate(db);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  assert.ok(tables.includes('entity_common_names'));
  assert.ok(!tables.includes('species_common_names'));   // vestigial dropped

  const ecnCols = db.prepare('PRAGMA table_info(entity_common_names)').all().map(c => c.name);
  for (const col of ['entity_id', 'name', 'language', 'source', 'source_ref', 'is_preferred', 'confidence']) {
    assert.ok(ecnCols.includes(col), `missing ${col}`);
  }
  const entCols = db.prepare('PRAGMA table_info(entities)').all().map(c => c.name);
  assert.ok(entCols.includes('common_names_synced_at'));

  // unique dedupe index enforces (entity_id, language, name COLLATE NOCASE)
  db.prepare("INSERT INTO entity_common_names (entity_id, name, language, source) VALUES (1,'Garlic','en','gbif')").run();
  assert.throws(() =>
    db.prepare("INSERT INTO entity_common_names (entity_id, name, language, source) VALUES (1,'garlic','en','wikidata')").run());

  migrate(db); // idempotent
  db.close();
});
