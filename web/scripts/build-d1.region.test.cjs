'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { selectReadSubset } = require('./build-d1.cjs');

test('selectReadSubset includes claim_localities for exported claims', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, scope_tier INTEGER, slug TEXT, scientific_name TEXT,
      parent_entity_id INTEGER, bio_category TEXT, variety_type TEXT, needs_taxonomy_review INTEGER DEFAULT 0, merged_into_entity_id INTEGER);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER,
      data_tier TEXT, chain_role TEXT, review_status TEXT, interaction_count INTEGER, source_id INTEGER, staging_id INTEGER);
    CREATE TABLE sources (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE claim_critic_verdicts (staging_id INTEGER, critic_name TEXT, verdict TEXT);
    CREATE TABLE claim_localities (claim_id INTEGER, country TEXT, subdivision TEXT, PRIMARY KEY(claim_id,country,subdivision));
    CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER,
      trait_name TEXT, value_numeric REAL, value_text TEXT, value_json TEXT, unit TEXT,
      source_id INTEGER, staging_id INTEGER, source_quote TEXT, source_page INTEGER,
      regional_context TEXT, review_status TEXT);
    CREATE TABLE entity_common_names (id INTEGER PRIMARY KEY, entity_id INTEGER, name TEXT,
      language TEXT, source TEXT, source_ref TEXT, is_preferred INTEGER, confidence REAL,
      created_at TEXT, updated_at TEXT);
    CREATE TABLE revision_log (id INTEGER PRIMARY KEY, target_type TEXT, target_id INTEGER,
      field TEXT, before_value TEXT, after_value TEXT, changed_by TEXT, method TEXT, reason TEXT,
      applied_at TEXT, subject_entity_id INTEGER, object_entity_id INTEGER, subject_name TEXT,
      object_name TEXT, served INTEGER);
  `);
  db.prepare("INSERT INTO entities (id, scope_tier, slug, scientific_name) VALUES (1,0,'tomato','Solanum')").run();
  db.prepare("INSERT INTO claims (id, subject_entity_id, object_entity_id, data_tier, chain_role, review_status, interaction_count) VALUES (10,1,1,'tier2_globi','crop_interaction',NULL,5)").run();
  db.prepare("INSERT INTO claim_localities VALUES (10,'India',''),(10,'Brazil','')").run();

  const sub = selectReadSubset(db);
  assert.ok(Array.isArray(sub.localities), 'localities present on subset');
  assert.equal(sub.localities.length, 2);
  assert.deepEqual(sub.localities.map(l => l.country).sort(), ['Brazil', 'India']);
  db.close();
});
