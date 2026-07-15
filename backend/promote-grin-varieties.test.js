'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { promoteOne } = require('./promote-grin-varieties.js');

function db0() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, common_name TEXT, variety_name TEXT,
    parent_entity_id INTEGER, bio_category TEXT, primary_role TEXT, source_table TEXT, scope_tier INTEGER,
    needs_dedup INTEGER DEFAULT 0, variety_type TEXT, grin_accession TEXT, native_regions TEXT)`);
  db.exec(`CREATE TABLE grin_varieties (grin_accession TEXT PRIMARY KEY, parent_entity_id INTEGER, plant_name TEXT,
    origin TEXT, improvement_level TEXT, narrative TEXT, scraped_at TEXT, promoted_at TEXT)`);
  db.exec(`CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER, field TEXT,
    before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT, applied_at TEXT DEFAULT (datetime('now')))`);
  db.prepare("INSERT INTO entities (id,scientific_name) VALUES (100,'Solanum lycopersicum')").run();
  return db;
}
const stage = (db, acc, name, level, parent=100) => db.prepare(
  "INSERT INTO grin_varieties (grin_accession,parent_entity_id,plant_name,origin,improvement_level) VALUES (?,?,?,?,?)"
).run(acc, parent, name, 'Italy', level);
const row = (db, acc) => db.prepare('SELECT * FROM grin_varieties WHERE grin_accession=?').get(acc);

test('Cultivar -> create served variety entity (variety_type, grin_accession, no native_regions from origin)', () => {
  const db = db0(); stage(db, 'PI 1', "'Goliath'", 'Cultivar');
  const r = promoteOne(db, row(db, 'PI 1'));
  assert.equal(r.action, 'create');
  const e = db.prepare("SELECT * FROM entities WHERE grin_accession='PI 1'").get();
  assert.equal(e.scientific_name, "Solanum lycopersicum 'Goliath'");
  assert.equal(e.variety_type, 'cultivar');
  assert.equal(e.scope_tier, 0);
  assert.equal(e.source_table, 'grin');
  assert.equal(e.native_regions, null); // origin NOT used as native_regions
  assert.equal(db.prepare("SELECT promoted_at FROM grin_varieties WHERE grin_accession='PI 1'").get().promoted_at != null, true);
  db.close();
});

test('Landrace -> variety_type=landrace', () => {
  const db = db0(); stage(db, 'PI 2', "'Cuore di Toro'", 'Landrace');
  promoteOne(db, row(db, 'PI 2'));
  assert.equal(db.prepare("SELECT variety_type FROM entities WHERE grin_accession='PI 2'").get().variety_type, 'landrace');
  db.close();
});

test('name-hygiene + improvement gate -> skip (no entity, stays staged)', () => {
  const db = db0(); stage(db, 'PI 3', 'T1118', 'Cultivar'); stage(db, 'PI 4', "'X'", 'Breeding material');
  assert.equal(promoteOne(db, row(db, 'PI 3')).reason, 'code_name');
  assert.equal(promoteOne(db, row(db, 'PI 4')).action, 'skip');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entities WHERE parent_entity_id=100').get().n, 0);
  db.close();
});

test('exact sibling name -> enrich existing with grin_accession (no duplicate)', () => {
  const db = db0();
  db.prepare("INSERT INTO entities (id,variety_name,parent_entity_id) VALUES (5,'Goliath',100)").run();
  stage(db, 'PI 5', "'Goliath'", 'Cultivar');
  const r = promoteOne(db, row(db, 'PI 5'));
  assert.equal(r.action, 'enrich');
  assert.equal(db.prepare('SELECT grin_accession FROM entities WHERE id=5').get().grin_accession, 'PI 5');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entities WHERE parent_entity_id=100').get().n, 1);
  db.close();
});

test('idempotent: re-promote a promoted accession -> skip, no new entity', () => {
  const db = db0(); stage(db, 'PI 6', "'Bellstar'", 'Cultivar');
  promoteOne(db, row(db, 'PI 6'));
  const before = db.prepare('SELECT COUNT(*) n FROM entities').get().n;
  const r2 = promoteOne(db, row(db, 'PI 6'));
  assert.equal(r2.action, 'skip');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entities').get().n, before);
  db.close();
});
