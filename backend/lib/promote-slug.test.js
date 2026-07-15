'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

function baseDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY, scientific_name TEXT, common_name TEXT, variety_name TEXT,
      parent_entity_id INTEGER, bio_category TEXT, primary_role TEXT, source_table TEXT,
      scope_tier INTEGER, native_regions TEXT, needs_dedup INTEGER DEFAULT 0,
      variety_type TEXT, grin_accession TEXT, slug TEXT
    );
    CREATE TABLE revision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_type TEXT, target_id INTEGER, field TEXT,
      before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

test('promote-grin-varieties: a created variety gets a canonical slug', () => {
  const db = baseDb();
  db.exec("CREATE TABLE grin_varieties (grin_accession TEXT PRIMARY KEY, promoted_at TEXT)");
  db.prepare("INSERT INTO grin_varieties (grin_accession) VALUES ('PI 1')").run();
  db.prepare("INSERT INTO entities (id,scientific_name,parent_entity_id) VALUES (1,'Abelmoschus esculentus',NULL)").run();
  const { promoteOne } = require('../promote-grin-varieties.js');
  const res = promoteOne(db, { grin_accession: 'PI 1', plant_name: "'Clemson Spineless'", improvement_level: 'Cultivar', parent_entity_id: 1, promoted_at: null });
  assert.equal(res.action, 'create');
  assert.equal(db.prepare("SELECT slug FROM entities WHERE grin_accession='PI 1'").get().slug, 'abelmoschus-esculentus-clemson-spineless');
});

test('promote-extension-varieties: a created variety gets a canonical slug', () => {
  const db = baseDb();
  db.exec(`
    CREATE TABLE sources (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, url TEXT, source_type TEXT, slug TEXT);
    CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id INTEGER, trait_name TEXT, value_numeric REAL, source_id INTEGER, source_quote TEXT, regional_context TEXT, review_status TEXT);
  `);
  db.prepare("INSERT INTO entities (id,scientific_name,parent_entity_id) VALUES (1,'Solanum lycopersicum',NULL)").run();
  const { promoteOne } = require('../promote-extension-varieties.js');
  const res = promoteOne(db, { species_name: 'Solanum lycopersicum', variety_name: 'Brandywine', maturity_days: 80, source_name: 'Src', source_url: 'http://x', region: 'US', maturity_quote: '80 days' });
  assert.ok(['create', 'create-flag'].includes(res.action));
  assert.equal(db.prepare("SELECT slug FROM entities WHERE variety_name='Brandywine'").get().slug, 'solanum-lycopersicum-brandywine');
});
