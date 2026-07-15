// backend/grin-narrative-stage.traits.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTraitStagingPayload } = require('./grin-narrative-stage');

// Minimal vocab map mirroring loadVocabulary's shape for the tested traits.
const VOCAB = {
  days_to_harvest: { trait_name: 'days_to_harvest', value_kind: 'numeric', expected_unit: 'days', enum_values: null, applicable_bio_categories: ['plantae'] },
  growth_determinacy: { trait_name: 'growth_determinacy', value_kind: 'categorical', expected_unit: null, enum_values: ['determinate','indeterminate','semi_determinate'], applicable_bio_categories: ['plantae'] },
  produce_weight_g: { trait_name: 'produce_weight_g', value_kind: 'range', expected_unit: 'g', enum_values: null, applicable_bio_categories: ['plantae'] },
  produce_color: { trait_name: 'produce_color', value_kind: 'categorical', expected_unit: null, enum_values: ['red','orange','bicolor'], applicable_bio_categories: ['plantae'] },
  deficiency_sensitivity: { trait_name: 'deficiency_sensitivity', value_kind: 'list', expected_unit: null, enum_values: ['calcium'], applicable_bio_categories: ['plantae'] },
};
const base = { parent_scientific_name: 'Solanum lycopersicum', variety_name: 'Bellstar', source_quote: 'q' };

test('numeric trait → value_numeric', () => {
  const r = buildTraitStagingPayload({ ...base, trait_name: 'days_to_harvest', value: 70 }, VOCAB);
  assert.equal(r.hold, false);
  assert.equal(r.payload.value_numeric, 70);
  assert.equal(r.payload.value_text, null);
  assert.equal(r.payload.value_json, null);
  assert.equal(r.payload.scientific_name, 'Solanum lycopersicum');
  assert.equal(r.payload.variety_name, 'Bellstar');
});

test('categorical trait → value_text, lowercased', () => {
  const r = buildTraitStagingPayload({ ...base, trait_name: 'growth_determinacy', value: 'Determinate' }, VOCAB);
  assert.equal(r.hold, false);
  assert.equal(r.payload.value_text, 'determinate');
});

test('range trait → value_json {min,max}, unit g', () => {
  const r = buildTraitStagingPayload({ ...base, trait_name: 'produce_weight_g', value: { min: 113, max: 142 }, unit: 'g' }, VOCAB);
  assert.equal(r.hold, false);
  assert.deepEqual(r.payload.value_json, { min: 113, max: 142 });
  assert.equal(r.payload.unit, 'g');
});

test('list trait → value_json array', () => {
  const r = buildTraitStagingPayload({ ...base, trait_name: 'deficiency_sensitivity', value: ['calcium'] }, VOCAB);
  assert.equal(r.hold, false);
  assert.deepEqual(r.payload.value_json, ['calcium']);
});

test('off-enum categorical → held', () => {
  const r = buildTraitStagingPayload({ ...base, trait_name: 'produce_color', value: 'deep-red' }, VOCAB);
  assert.equal(r.hold, true);
  assert.match(r.reason, /enum/);
});

test('unit mismatch → held', () => {
  const r = buildTraitStagingPayload({ ...base, trait_name: 'produce_weight_g', value: { min: 4, max: 5 }, unit: 'oz' }, VOCAB);
  assert.equal(r.hold, true);
});

test('unknown trait → held', () => {
  const r = buildTraitStagingPayload({ ...base, trait_name: 'flavor', value: 'sweet' }, VOCAB);
  assert.equal(r.hold, true);
  assert.match(r.reason, /unknown_trait/);
});
