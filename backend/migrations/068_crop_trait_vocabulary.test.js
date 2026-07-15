'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./068_crop_trait_vocabulary');

function freshVocabDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE traits_vocabulary (
      trait_name TEXT PRIMARY KEY,
      value_kind TEXT NOT NULL CHECK (value_kind IN ('numeric','categorical','range','list','boolean')),
      expected_unit TEXT,
      applicable_bio_categories TEXT NOT NULL,
      enum_values TEXT,
      description TEXT,
      upstream_mappings TEXT,
      introduced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
  return db;
}

test('migration 068 registers all 13 traits, plantae, with the right kinds', () => {
  const db = freshVocabDb();
  migrate(db);
  const rows = db.prepare(`SELECT * FROM traits_vocabulary`).all();
  assert.equal(rows.length, 13);
  const by = Object.fromEntries(rows.map(r => [r.trait_name, r]));
  // produce/growth
  assert.equal(by['growth_determinacy'].value_kind, 'categorical');
  assert.deepEqual(JSON.parse(by['growth_determinacy'].enum_values), ['determinate','indeterminate','semi_determinate']);
  assert.equal(by['produce_weight_g'].value_kind, 'range');
  assert.equal(by['produce_weight_g'].expected_unit, 'g');
  assert.equal(by['produce_color'].value_kind, 'categorical');
  assert.ok(JSON.parse(by['produce_color'].enum_values).includes('bicolor'));
  // reproduction
  assert.equal(by['mating_system'].value_kind, 'categorical');
  assert.equal(by['pollination_vector'].value_kind, 'categorical');
  assert.deepEqual(JSON.parse(by['pollination_vector'].enum_values), ['biotic','wind','self','mixed']);
  // nutrient
  assert.equal(by['nutrient_demand'].value_kind, 'categorical');
  assert.equal(by['nitrogen_use_efficiency'].value_kind, 'numeric');
  assert.equal(by['deficiency_sensitivity'].value_kind, 'list');
  // all plantae
  for (const r of rows) assert.deepEqual(JSON.parse(r.applicable_bio_categories), ['plantae']);
});

test('migration 068 is idempotent (re-run updates, no error, still 13)', () => {
  const db = freshVocabDb();
  migrate(db);
  migrate(db);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM traits_vocabulary`).get().n, 13);
});
