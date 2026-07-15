'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { derivePathogenTransmission } = require('./transmission-traits');

function freshDb() {
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE entities (id INTEGER PRIMARY KEY, scientific_name TEXT, scope_tier INTEGER);
    CREATE TABLE claims (id INTEGER PRIMARY KEY, subject_entity_id INTEGER, object_entity_id INTEGER, interaction_category TEXT, review_status TEXT);
    CREATE TABLE entity_trait_claims (id INTEGER PRIMARY KEY, entity_id INTEGER, trait_name TEXT, value_text TEXT, value_json TEXT);
    INSERT INTO entities (id, scientific_name, scope_tier) VALUES
      (10,'cucumber mosaic virus',0), (11,'Myzus persicae',0), (12,'Aphis gossypii',0),
      (20,'Unserved virus',NULL), (30,'Tomato spotted wilt virus',0), (31,'Frankliniella occidentalis',0),
      (40,'Xylella fastidiosa',0), (41,'Graphocephala atropunctata',0);
    INSERT INTO claims (id, subject_entity_id, object_entity_id, interaction_category, review_status) VALUES
      (1,11,10,'disease_vector','ai_reviewed'),
      (2,12,10,'disease_vector','ai_reviewed'),
      (3,12,20,'disease_vector','ai_reviewed'),   -- unserved pathogen → skip
      (4,31,30,'disease_vector','staged'),        -- not ai_reviewed → skip
      (5,12,10,'pest_pressure','ai_reviewed'),    -- not disease_vector → skip
      (6,41,40,'disease_vector','ai_reviewed');   -- pathogen 40 has an edge...
    -- ...but 40 ALSO has a stored (extracted) transmission_vector → derive must skip it.
    INSERT INTO entity_trait_claims (id, entity_id, trait_name, value_text, value_json) VALUES
      (100, 40, 'transmission_vector', NULL, '["Graphocephala atropunctata"]');
  `);
  return d;
}

test('derives transmission_vector (sorted list) + vector_borne mode for served pathogens', () => {
  const out = derivePathogenTransmission(freshDb());
  const vec = out.find(r => r.entity_id === 10 && r.trait_name === 'transmission_vector');
  const mode = out.find(r => r.entity_id === 10 && r.trait_name === 'transmission_mode');
  assert.deepEqual(JSON.parse(vec.value_json), ['Aphis gossypii', 'Myzus persicae']); // sorted, distinct
  assert.equal(mode.value_text, 'vector_borne');
  assert.equal(vec.inherited_from_entity_id, null); // not variety-inherited
  assert.equal(vec.id, 10 * 1_000_000_000 + 1);     // collision-free synthetic id
  assert.equal(mode.id, 10 * 1_000_000_000 + 2);
});

test('skips unserved pathogens, non-ai_reviewed edges, and non-disease_vector edges', () => {
  const out = derivePathogenTransmission(freshDb());
  assert.ok(!out.some(r => r.entity_id === 20)); // unserved pathogen
  assert.ok(!out.some(r => r.entity_id === 30)); // only a staged disease_vector edge
});

test('reconcile: skips the transmission_vector of a pathogen that already has a STORED one (per-trait)', () => {
  const out = derivePathogenTransmission(freshDb());
  // pathogen 40 has a stored transmission_vector → no DERIVED transmission_vector for it
  assert.ok(!out.some(r => r.entity_id === 40 && r.trait_name === 'transmission_vector'));
  // ...but it still gets the vector_borne MODE (no stored mode) — correct, non-duplicative
  assert.ok(out.some(r => r.entity_id === 40 && r.trait_name === 'transmission_mode' && r.value_text === 'vector_borne'));
  // 10: vector + mode (2); 40: mode only (1) → 3 rows
  assert.equal(out.length, 3);
});
