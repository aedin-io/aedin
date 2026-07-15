'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { resolveVarietyTraits } = require('./variety-traits.js');

function db0() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, parent_entity_id INTEGER,
    bio_category TEXT, variety_type TEXT, needs_taxonomy_review INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER,
    trait_name TEXT, value_numeric REAL, value_text TEXT, review_status TEXT)`);
  return db;
}
const ins = (db, id, eid, tn, val, rs='ai_reviewed') =>
  db.prepare(`INSERT INTO entity_trait_claims (id,entity_id,trait_name,value_numeric,review_status) VALUES (?,?,?,?,?)`).run(id,eid,tn,val,rs);

test('variety overrides one trait, inherits another, keeps its unique trait', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id,parent_entity_id,bio_category) VALUES (10,1,'plantae'),(1,NULL,'plantae')").run();
  ins(db, 100, 1, 'days_to_harvest', 90);   // parent (divergent — not inherited)
  ins(db, 101, 1, 'ph_min', 6.0);           // parent (conserved — inherited)
  ins(db, 200, 10, 'days_to_harvest', 60);  // variety overrides
  ins(db, 201, 10, 'plant_height', 30);     // variety unique
  const r = resolveVarietyTraits(db, 10);
  const byTrait = Object.fromEntries(r.map(x => [x.trait_name, x]));
  assert.equal(byTrait.days_to_harvest.value_numeric, 60);
  assert.equal(byTrait.days_to_harvest.source, 'variety_specific');
  assert.equal(byTrait.days_to_harvest.inherited_from_entity_id, null);
  assert.equal(byTrait.plant_height.source, 'variety_specific');
  assert.equal(byTrait.ph_min.value_numeric, 6.0);
  assert.equal(byTrait.ph_min.source, 'inherited');
  assert.equal(byTrait.ph_min.inherited_from_entity_id, 1);
  assert.equal(byTrait.ph_min.entity_id, 10);   // re-keyed to the variety
  db.close();
});

test('trait-name override suppresses ALL parent rows for that trait', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id,parent_entity_id,bio_category) VALUES (10,1,'plantae'),(1,NULL,'plantae')").run();
  ins(db, 100, 1, 'days_to_harvest', 90);   // parent row A
  ins(db, 101, 1, 'days_to_harvest', 95);   // parent row B (different source)
  ins(db, 200, 10, 'days_to_harvest', 60);  // variety
  const r = resolveVarietyTraits(db, 10).filter(x => x.trait_name === 'days_to_harvest');
  assert.equal(r.length, 1);                // only the variety's, both parent rows suppressed
  assert.equal(r[0].value_numeric, 60);
  db.close();
});

test('only ai_reviewed claims participate', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id,parent_entity_id,bio_category) VALUES (10,1,'plantae'),(1,NULL,'plantae')").run();
  ins(db, 100, 1, 'hardiness_zone', 7, 'unreviewed');   // parent, NOT reviewed -> ignored
  ins(db, 101, 1, 'ph_min', 6.0);                       // parent, reviewed, conserved -> inherited
  const r = resolveVarietyTraits(db, 10);
  assert.deepEqual(r.map(x => x.trait_name).sort(), ['ph_min']);
  db.close();
});

test('no parent -> own only; no own -> all parent inherited', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id,parent_entity_id,bio_category) VALUES (10,1,'plantae'),(1,NULL,'plantae'),(20,NULL,'plantae')").run();
  ins(db, 100, 1, 'ph_min', 6.0);   // parent (conserved -> inherited by variety)
  ins(db, 300, 20, 'x', 1);         // a non-variety with its own trait
  // variety 10 has no own traits -> inherits all conserved parent traits
  const inh = resolveVarietyTraits(db, 10);
  assert.equal(inh.length, 1);
  assert.equal(inh[0].source, 'inherited');
  // entity 20 has no parent -> own only, no inheritance
  const own = resolveVarietyTraits(db, 20);
  assert.equal(own.length, 1);
  assert.equal(own[0].source, 'variety_specific');
  db.close();
});

// --- Task 5: kingdom-aware gate + 3 corruption-amplifier guards ---

function gdb() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, parent_entity_id INTEGER, bio_category TEXT,
    variety_type TEXT, needs_taxonomy_review INTEGER DEFAULT 0)`);
  db.exec(`CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER, trait_name TEXT,
    value_numeric REAL, review_status TEXT)`);
  const trait = (id, eid, name) => db.prepare("INSERT INTO entity_trait_claims (id,entity_id,trait_name,review_status) VALUES (?,?,?,'ai_reviewed')").run(id, eid, name);
  return { db, trait };
}

test('gate: plant cultivar inherits conserved (ph_min) but NOT divergent (days_to_harvest)', () => {
  const { db, trait } = gdb();
  db.prepare("INSERT INTO entities (id,parent_entity_id,bio_category,variety_type) VALUES (10,100,'plantae','cultivar')").run();
  db.prepare("INSERT INTO entities (id,bio_category) VALUES (100,'plantae')").run();
  trait(1, 100, 'ph_min'); trait(2, 100, 'days_to_harvest');
  const names = resolveVarietyTraits(db, 10).map(r => r.trait_name).sort();
  assert.deepEqual(names, ['ph_min']); // days_to_harvest divergent -> blocked
  db.close();
});

test('Guard A: cross-kingdom parent -> inherit nothing', () => {
  const { db, trait } = gdb();
  db.prepare("INSERT INTO entities (id,parent_entity_id,bio_category,variety_type) VALUES (10,100,'fungi','f')").run();
  db.prepare("INSERT INTO entities (id,bio_category) VALUES (100,'plantae')").run(); // parent is a plant!
  trait(1, 100, 'optimal_temp_min');
  assert.equal(resolveVarietyTraits(db, 10).length, 0);
  db.close();
});

test('Guard B: needs_taxonomy_review parent -> inherit nothing', () => {
  const { db, trait } = gdb();
  db.prepare("INSERT INTO entities (id,parent_entity_id,bio_category,variety_type) VALUES (10,100,'plantae','var')").run();
  db.prepare("INSERT INTO entities (id,bio_category,needs_taxonomy_review) VALUES (100,'plantae',1)").run();
  trait(1, 100, 'ph_min');
  assert.equal(resolveVarietyTraits(db, 10).length, 0);
  db.close();
});

test('Guard C: hybrid inherits nothing; own claim still returned', () => {
  const { db, trait } = gdb();
  db.prepare("INSERT INTO entities (id,parent_entity_id,bio_category,variety_type) VALUES (10,100,'plantae','hybrid')").run();
  db.prepare("INSERT INTO entities (id,bio_category) VALUES (100,'plantae')").run();
  trait(1, 100, 'ph_min'); trait(2, 10, 'growth_habit'); // own
  const names = resolveVarietyTraits(db, 10).map(r => r.trait_name);
  assert.deepEqual(names, ['growth_habit']); // own only, no inheritance
  db.close();
});

test('own divergent claim overrides + is kept even though class is divergent', () => {
  const { db, trait } = gdb();
  db.prepare("INSERT INTO entities (id,parent_entity_id,bio_category,variety_type) VALUES (10,100,'plantae','cultivar')").run();
  db.prepare("INSERT INTO entities (id,bio_category) VALUES (100,'plantae')").run();
  trait(1, 10, 'days_to_harvest'); // own divergent -> always kept
  trait(2, 100, 'days_to_harvest'); // parent -> suppressed by own
  const rows = resolveVarietyTraits(db, 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].inherited_from_entity_id, null); // it's the OWN row
  db.close();
});
