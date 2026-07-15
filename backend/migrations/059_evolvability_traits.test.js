'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./059_evolvability_traits');

function freshVocab() {
  const db = new Database(':memory:');
  // Minimal traits_vocabulary shape (trait_name UNIQUE so ON CONFLICT works).
  db.exec(`CREATE TABLE traits_vocabulary (
    trait_name TEXT PRIMARY KEY,
    value_kind TEXT, expected_unit TEXT, applicable_bio_categories TEXT,
    enum_values TEXT, description TEXT, upstream_mappings TEXT, introduced_at TEXT
  )`);
  return db;
}

test('059 registers all 6 evolvability traits with correct shape', () => {
  const db = freshVocab();
  migrate(db);
  const names = db.prepare('SELECT trait_name FROM traits_vocabulary ORDER BY trait_name').all().map(r => r.trait_name);
  assert.deepEqual(names, [
    'generation_time', 'generations_per_year', 'hrac_group', 'irac_group',
    'reproductive_mode', 'resistance_evolution_risk',
  ]);

  const gt = db.prepare("SELECT * FROM traits_vocabulary WHERE trait_name='generation_time'").get();
  assert.equal(gt.value_kind, 'numeric');
  assert.equal(gt.expected_unit, 'years');
  assert.ok(JSON.parse(gt.applicable_bio_categories).includes('vertebrate'), 'generation_time is cross-taxon');

  const rm = db.prepare("SELECT * FROM traits_vocabulary WHERE trait_name='reproductive_mode'").get();
  assert.equal(rm.value_kind, 'categorical');
  assert.ok(JSON.parse(rm.enum_values).includes('cyclical_parthenogenetic'));

  const rer = db.prepare("SELECT * FROM traits_vocabulary WHERE trait_name='resistance_evolution_risk'").get();
  assert.deepEqual(JSON.parse(rer.enum_values), ['low', 'moderate', 'high']);
  // weeds (plantae) + pests + pathogens, not vertebrates
  const cats = JSON.parse(rer.applicable_bio_categories);
  assert.ok(cats.includes('plantae') && cats.includes('fungi') && !cats.includes('vertebrate'));

  db.close();
});

test('059 is idempotent (ON CONFLICT DO UPDATE)', () => {
  const db = freshVocab();
  migrate(db);
  migrate(db); // must not throw or duplicate
  const n = db.prepare("SELECT COUNT(*) c FROM traits_vocabulary").get().c;
  assert.equal(n, 6);
  db.close();
});

test('059 irac_group/hrac_group are taxon-scoped resistance siblings', () => {
  const db = freshVocab();
  migrate(db);
  const irac = db.prepare("SELECT applicable_bio_categories FROM traits_vocabulary WHERE trait_name='irac_group'").get();
  const hrac = db.prepare("SELECT applicable_bio_categories FROM traits_vocabulary WHERE trait_name='hrac_group'").get();
  assert.deepEqual(JSON.parse(irac.applicable_bio_categories), ['invertebrate']);
  assert.deepEqual(JSON.parse(hrac.applicable_bio_categories), ['plantae']);
  db.close();
});
