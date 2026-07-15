'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildTraitStagingPayload } = require('./grin-narrative-stage');
const { encodeTraitValue } = require('./lib/trait-value');
const { TRAITS } = require('./migrations/068_crop_trait_vocabulary');
const fixture = require('./test-fixtures/grin-bellstar-traits.json');

// Build a vocab map (loadVocabulary shape) from the migration's TRAITS + days_to_harvest.
const VOCAB = Object.fromEntries([
  ...TRAITS,
  { trait_name: 'days_to_harvest', value_kind: 'numeric', expected_unit: 'days', enum_values: null, applicable_bio_categories: ['plantae'] },
].map(t => [t.trait_name, t]));

test('golden Bellstar fixture → 3 valid trait payloads', () => {
  const built = fixture.map(c => buildTraitStagingPayload(c, VOCAB));
  assert.ok(built.every(b => b.hold === false), `unexpected hold: ${JSON.stringify(built.filter(b=>b.hold))}`);
  const byTrait = Object.fromEntries(built.map(b => [b.payload.trait_name, b.payload]));
  assert.equal(byTrait['growth_determinacy'].value_text, 'determinate');
  assert.equal(byTrait['days_to_harvest'].value_numeric, 70);
  assert.deepEqual(byTrait['produce_weight_g'].value_json, { min: 113, max: 142 });
});

test('staged payloads encode to entity_trait_claims columns the way promoteEntityTraitRow reads them', () => {
  for (const c of fixture) {
    const { payload } = buildTraitStagingPayload(c, VOCAB);
    const v = VOCAB[payload.trait_name];
    // mirror promoteEntityTraitRow's value selection by value_kind
    let raw;
    if (v.value_kind === 'numeric') raw = payload.value_numeric;
    else if (v.value_kind === 'categorical') raw = payload.value_text;
    else if (v.value_kind === 'range' || v.value_kind === 'list') raw = payload.value_json;
    const enc = encodeTraitValue(v, raw);
    if (v.value_kind === 'numeric') assert.equal(enc.value_numeric, 70);
    if (v.value_kind === 'categorical') assert.equal(enc.value_text, 'determinate');
    if (v.value_kind === 'range') assert.equal(enc.value_json, JSON.stringify({ min: 113, max: 142 }));
  }
});
