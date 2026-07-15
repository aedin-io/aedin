'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./069_foundational_crop_traits');
const { encodeTraitValue, validateTraitValue } = require('../lib/trait-value');

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

test('migration 069 registers all 27 foundational traits, plantae, with the right kinds', () => {
  const db = freshVocabDb();
  migrate(db);
  const rows = db.prepare(`SELECT * FROM traits_vocabulary`).all();
  assert.equal(rows.length, 27);
  const by = Object.fromEntries(rows.map(r => [r.trait_name, r]));
  // categorical + enums
  assert.equal(by['photosynthetic_pathway'].value_kind, 'categorical');
  assert.deepEqual(JSON.parse(by['photosynthetic_pathway'].enum_values), ['c3','c4','cam','c3_c4_intermediate']);
  assert.deepEqual(JSON.parse(by['life_cycle'].enum_values),
    ['ephemeral','annual','biennial','herbaceous_perennial','woody_perennial','monocarpic_perennial']);
  assert.deepEqual(JSON.parse(by['frost_hardiness'].enum_values),
    ['tender','semi_hardy','moderately_hardy','very_hardy']);
  // numeric + units
  assert.equal(by['rooting_depth_cm'].value_kind, 'numeric');
  assert.equal(by['rooting_depth_cm'].expected_unit, 'cm');
  assert.equal(by['n_removal_kg_t'].expected_unit, 'kg/t');
  assert.equal(by['chilling_requirement_hours'].expected_unit, 'hours');
  // spacing split into two numerics — NOT a range
  assert.equal(by['in_row_spacing_cm'].value_kind, 'numeric');
  assert.equal(by['between_row_spacing_cm'].value_kind, 'numeric');
  assert.equal(rows.some(r => r.value_kind === 'range'), false);
  // list + boolean
  assert.equal(by['edible_part'].value_kind, 'list');
  assert.ok(JSON.parse(by['edible_part'].enum_values).includes('tuber'));
  assert.equal(by['requires_rootstock'].value_kind, 'boolean');
  // all plantae
  for (const r of rows) assert.deepEqual(JSON.parse(r.applicable_bio_categories), ['plantae']);
});

test('migration 069 is idempotent (re-run updates, no error, still 27)', () => {
  const db = freshVocabDb();
  migrate(db);
  migrate(db);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM traits_vocabulary`).get().n, 27);
});

test('migration 069 extends deficiency_sensitivity enum + sharpens maximum_height_cm (existing rows)', () => {
  const db = freshVocabDb();
  db.prepare(`INSERT INTO traits_vocabulary (trait_name, value_kind, applicable_bio_categories, enum_values, description) VALUES (?,?,?,?,?)`)
    .run('deficiency_sensitivity', 'list', '["plantae"]',
      JSON.stringify(['calcium','boron','magnesium','manganese','zinc','iron']), 'orig');
  db.prepare(`INSERT INTO traits_vocabulary (trait_name, value_kind, applicable_bio_categories, description) VALUES (?,?,?,?)`)
    .run('maximum_height_cm', 'numeric', '["plantae"]', 'orig height desc');
  migrate(db);
  const e = JSON.parse(db.prepare(`SELECT enum_values FROM traits_vocabulary WHERE trait_name='deficiency_sensitivity'`).get().enum_values);
  assert.equal(e.length, 10);
  for (const m of ['molybdenum','copper','sulphur','potassium']) assert.ok(e.includes(m), `missing ${m}`);
  const mh = db.prepare(`SELECT description FROM traits_vocabulary WHERE trait_name='maximum_height_cm'`).get();
  assert.match(mh.description, /typical mature height/i);
});

test('value-typing round-trips for every kind in the batch (proves no engine change needed)', () => {
  const T = Object.fromEntries(migrate.TRAITS.map(t =>
    [t.trait_name, { trait_name: t.trait_name, value_kind: t.value_kind, enum_values: t.enum_values }]));
  // categorical
  assert.deepEqual(validateTraitValue(T['life_cycle'], 'annual'), { ok: true });
  assert.equal(validateTraitValue(T['life_cycle'], 'frobnicate').ok, false);
  assert.equal(encodeTraitValue(T['life_cycle'], 'annual').value_text, 'annual');
  // numeric
  assert.deepEqual(validateTraitValue(T['rooting_depth_cm'], 150), { ok: true });
  assert.equal(encodeTraitValue(T['rooting_depth_cm'], 150).value_numeric, 150);
  // list
  assert.deepEqual(validateTraitValue(T['edible_part'], ['root']), { ok: true });
  assert.equal(JSON.parse(encodeTraitValue(T['edible_part'], ['root']).value_json)[0], 'root');
  // boolean
  assert.deepEqual(validateTraitValue(T['requires_rootstock'], true), { ok: true });
  assert.equal(encodeTraitValue(T['requires_rootstock'], true).value_text, 'true');
});
