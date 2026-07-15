'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migrate = require('./057_predicted_interactions');

test('057 creates predicted_interactions with gate-input + exposure cols, idempotently', () => {
  const db = new Database(':memory:');
  // entities is referenced by FK; create a minimal stub so the schema is coherent.
  db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY)');
  migrate(db);

  const cols = db.prepare('PRAGMA table_info(predicted_interactions)').all().map(c => c.name);
  for (const expected of [
    'subject_entity_id', 'object_entity_id', 'interaction_category', 'region_scope',
    'data_tier', 'exposure', 'confidence', 'confidence_lower', 'confidence_upper',
    'model_version', 'host_breadth_families', 'independent_regions',
    'climate_match_score', 'taxonomic_distance', 'lifestage_compatible',
    'negative_evidence_flag', 'generated_at',
  ]) {
    assert.ok(cols.includes(expected), `missing column ${expected}`);
  }

  const idx = db.prepare('PRAGMA index_list(predicted_interactions)').all().map(i => i.name);
  assert.ok(idx.includes('idx_pi_exposure'), 'exposure index drives the public-demo query');

  migrate(db); // idempotent: second run must not throw
  db.close();
});

test('057 defaults: data_tier=predicted, exposure=gated (never public by accident)', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO entities (id) VALUES (1),(2)').run();
  migrate(db);

  db.prepare(`INSERT INTO predicted_interactions
    (subject_entity_id, object_entity_id, interaction_category, confidence, model_version, generated_at)
    VALUES (1, 2, 'herbivory', 0.71, 'v0-test', '2026-06-13')`).run();

  const row = db.prepare('SELECT data_tier, exposure FROM predicted_interactions WHERE id = 1').get();
  assert.equal(row.data_tier, 'predicted');
  assert.equal(row.exposure, 'gated', 'a new prediction must default to gated, not public');
  db.close();
});

test('057 evidence join table cascades and keys on (prediction_id, claim_id)', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY)');
  db.prepare('INSERT INTO entities (id) VALUES (1),(2)').run();
  migrate(db);

  db.prepare(`INSERT INTO predicted_interactions
    (id, subject_entity_id, object_entity_id, interaction_category, confidence, model_version, generated_at)
    VALUES (10, 1, 2, 'herbivory', 0.71, 'v0-test', '2026-06-13')`).run();
  db.prepare(`INSERT INTO predicted_interaction_evidence (prediction_id, claim_id, role)
    VALUES (10, 555, 'host_link')`).run();

  // ON DELETE CASCADE removes the evidence row when the prediction is deleted.
  db.prepare('DELETE FROM predicted_interactions WHERE id = 10').run();
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM predicted_interaction_evidence').get();
  assert.equal(remaining.n, 0, 'evidence rows cascade-delete with their prediction');
  db.close();
});
