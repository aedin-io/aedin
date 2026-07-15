'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./070_edible_part_corm_rhizome');

function seed() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE traits_vocabulary (
    trait_name TEXT PRIMARY KEY, value_kind TEXT, expected_unit TEXT,
    applicable_bio_categories TEXT, enum_values TEXT, description TEXT,
    upstream_mappings TEXT, introduced_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare(`INSERT INTO traits_vocabulary (trait_name, value_kind, applicable_bio_categories, enum_values, description) VALUES ('edible_part','list','["plantae"]',?,'orig')`)
    .run(JSON.stringify(['root', 'tuber', 'bulb', 'stem', 'leaf', 'petiole', 'flower', 'fruit', 'seed', 'whole']));
  return db;
}

test('migration 070 adds corm + rhizome to edible_part, keeps the originals (12 total)', () => {
  const db = seed();
  migrate(db);
  const e = JSON.parse(db.prepare(`SELECT enum_values FROM traits_vocabulary WHERE trait_name='edible_part'`).get().enum_values);
  assert.ok(e.includes('corm'), 'missing corm');
  assert.ok(e.includes('rhizome'), 'missing rhizome');
  for (const o of ['root', 'tuber', 'bulb', 'stem', 'leaf', 'petiole', 'flower', 'fruit', 'seed', 'whole']) {
    assert.ok(e.includes(o), `dropped ${o}`);
  }
  assert.equal(e.length, 12);
});

test('migration 070 sharpens the description (mentions corm + rhizome) + is idempotent', () => {
  const db = seed();
  migrate(db);
  migrate(db);
  const r = db.prepare(`SELECT enum_values, description FROM traits_vocabulary WHERE trait_name='edible_part'`).get();
  assert.equal(JSON.parse(r.enum_values).length, 12);
  assert.match(r.description, /corm/i);
  assert.match(r.description, /rhizome/i);
});

test('migration 070 is no-op-safe when edible_part is absent', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE traits_vocabulary (trait_name TEXT PRIMARY KEY, value_kind TEXT, expected_unit TEXT, applicable_bio_categories TEXT, enum_values TEXT, description TEXT, upstream_mappings TEXT, introduced_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  migrate(db); // must not throw
  assert.equal(db.prepare('SELECT COUNT(*) n FROM traits_vocabulary').get().n, 0);
});
