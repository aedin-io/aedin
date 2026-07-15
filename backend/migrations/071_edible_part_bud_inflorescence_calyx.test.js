'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./071_edible_part_bud_inflorescence_calyx');

function seed(initial) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE traits_vocabulary (
    trait_name TEXT PRIMARY KEY, value_kind TEXT, expected_unit TEXT,
    applicable_bio_categories TEXT, enum_values TEXT, description TEXT,
    upstream_mappings TEXT, introduced_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare(`INSERT INTO traits_vocabulary (trait_name, value_kind, applicable_bio_categories, enum_values, description) VALUES ('edible_part','list','["plantae"]',?,'orig')`)
    .run(JSON.stringify(initial));
  return db;
}

// Post-migration-070 baseline (12 values).
const BASE = ['root', 'tuber', 'bulb', 'corm', 'rhizome', 'stem', 'leaf', 'petiole', 'flower', 'fruit', 'seed', 'whole'];

test('migration 071 adds bud + inflorescence + calyx, keeps all prior values (15 total)', () => {
  const db = seed(BASE);
  migrate(db);
  const e = JSON.parse(db.prepare(`SELECT enum_values FROM traits_vocabulary WHERE trait_name='edible_part'`).get().enum_values);
  for (const t of ['bud', 'inflorescence', 'calyx']) assert.ok(e.includes(t), `missing ${t}`);
  for (const o of BASE) assert.ok(e.includes(o), `dropped ${o}`);
  assert.equal(e.length, 15);
});

test('migration 071 is idempotent + description mentions the new organs', () => {
  const db = seed(BASE);
  migrate(db);
  migrate(db);
  const r = db.prepare(`SELECT enum_values, description FROM traits_vocabulary WHERE trait_name='edible_part'`).get();
  assert.equal(JSON.parse(r.enum_values).length, 15);
  assert.match(r.description, /inflorescence/i);
  assert.match(r.description, /calyx/i);
});

test('migration 071 no-op-safe when edible_part absent', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE traits_vocabulary (trait_name TEXT PRIMARY KEY, value_kind TEXT, expected_unit TEXT, applicable_bio_categories TEXT, enum_values TEXT, description TEXT, upstream_mappings TEXT, introduced_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  migrate(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM traits_vocabulary').get().n, 0);
});
