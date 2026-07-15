'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./migrations/072_sim_params_layer');
const { deriveAll, applyDerivation } = require('./derive-sim-params');

function seed() {
  const db = new Database(':memory:');
  migrate(db);
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, bio_category TEXT,
      scope_tier INTEGER, crop_type TEXT, edible INTEGER, primary_role TEXT,
      maximum_height_cm REAL, spread_cm REAL, growth_habit TEXT, diet_breadth TEXT, commercial_biocontrol INTEGER);
    CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER, trait_name TEXT,
      value_numeric REAL, value_text TEXT, review_status TEXT);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER,
      interaction_category TEXT, review_status TEXT);
    -- revision_log is written by applyDerivation via logRevisions (real corpus has it, migration 055)
    CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, field TEXT,
      before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT,
      applied_at TEXT DEFAULT (datetime('now')));
    -- a served crop with a sourced height (→ derived growth) + a designed-only crop
    INSERT INTO entities (id, scientific_name, bio_category, scope_tier, crop_type, edible, growth_habit) VALUES
      (1,'Solanum lycopersicum','plantae',0,'vegetable',1,'annual vine, fruit vegetable'),
      (2,'Malus domestica','plantae',0,'fruit',1,'deciduous tree'),
      (3,'Aphis gossypii','invertebrate',0,NULL,NULL,NULL),
      (4,'Coccinella septempunctata','invertebrate',0,NULL,NULL,NULL);
    UPDATE entities SET primary_role='predator' WHERE id=4;
    INSERT INTO entity_trait_claims (id, entity_id, trait_name, value_numeric, value_text, review_status) VALUES
      (10,1,'maximum_height_cm',180,NULL,'ai_reviewed'),
      (11,1,'days_to_harvest',80,NULL,'ai_reviewed');
    INSERT INTO claims (id, subject_entity_id, object_entity_id, interaction_category, review_status) VALUES
      (100,3,1,'pest_pressure','ai_reviewed'),   -- pest 3 → sim_pest_dynamics
      (101,4,3,'biocontrol','ai_reviewed');       -- enemy 4 → pest 3 → sim_biocontrol
  `);
  return db;
}

test('deriveAll: derived vs designed growth + populations', () => {
  const db = seed();
  const out = deriveAll(db);
  const tomato = out.growth.find((r) => r.entity_id === 1);
  const apple = out.growth.find((r) => r.entity_id === 2);
  assert.equal(tomato.param_status, 'derived');   // sourced height
  assert.equal(tomato.max_height_cm, 180);
  assert.equal(apple.param_status, 'designed');    // no facts
  assert.equal(apple.time_unit, 'years');
  assert.equal(out.visual.length, 2);
  assert.ok(out.pest.some((r) => r.entity_id === 3));
  assert.ok(out.biocontrol.some((r) => r.claim_id === 101 && r.control_magnitude === 0.35));
});

test('applyDerivation writes rows and is idempotent', () => {
  const db = seed();
  const s1 = applyDerivation(db, deriveAll(db), { runId: 'r1' });
  assert.equal(s1.sim_plant_growth, 2);
  const s2 = applyDerivation(db, deriveAll(db), { runId: 'r2' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sim_plant_growth').get().n, 2); // replaced, not doubled
  assert.equal(db.prepare(`SELECT generated_run_id FROM sim_plant_growth WHERE entity_id=1`).get().generated_run_id, 'r2');
});

test('applyDerivation preserves override rows', () => {
  const db = seed();
  applyDerivation(db, deriveAll(db), { runId: 'r1' });
  // human pins entity 1
  db.prepare(`UPDATE sim_plant_growth SET param_status='override', max_height_cm=999 WHERE entity_id=1`).run();
  applyDerivation(db, deriveAll(db), { runId: 'r2' });
  const pinned = db.prepare(`SELECT param_status, max_height_cm FROM sim_plant_growth WHERE entity_id=1`).get();
  assert.equal(pinned.param_status, 'override');
  assert.equal(pinned.max_height_cm, 999); // untouched by regeneration
});
