'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildResistanceStagingPayload } = require('./grin-narrative-stage');

const base = {
  grin_accession: 'PI 1',
  parent_scientific_name: 'Solanum lycopersicum',
  variety_name: 'Walter',
  source_quote: 'resistance to the Fusarium wilt pathogen. Resistant to Fusarium Race 1 and Race 2',
};

test('resolvable pathogen attacker → disease_resistance payload, Global, beneficial', () => {
  const r = buildResistanceStagingPayload({
    ...base, claim_type: 'disease_resistance', attacker_name: 'Fusarium wilt',
    resistance_level: 'strong', coevolution_structure: 'gene_for_gene',
  });
  assert.equal(r.hold, false);
  assert.equal(r.payload.object_organism, 'Fusarium oxysporum');
  assert.equal(r.payload.interaction_type, 'disease_resistance');
  assert.equal(r.payload.subject_organism, 'Solanum lycopersicum');
  assert.equal(r.payload.subject_variety, 'Walter');
  assert.equal(r.payload.effect_direction, 'beneficial');
  assert.equal(r.payload.resistance_level, 'strong');
  assert.equal(r.payload.coevolution_structure, 'gene_for_gene');
  assert.equal(r.payload.regional_context, 'Global');
  assert.ok(r.payload.source_quote.includes('Fusarium'));
});

test('resolvable pest attacker → pest_resistance category from resolver', () => {
  const r = buildResistanceStagingPayload({
    ...base, claim_type: 'pest_resistance', attacker_name: 'whitefly', resistance_level: 'partial',
  });
  assert.equal(r.hold, false);
  assert.equal(r.payload.object_organism, 'Bemisia tabaci');
  assert.equal(r.payload.interaction_type, 'pest_resistance');
  assert.equal(r.payload.resistance_level, 'partial');
  assert.equal(r.payload.coevolution_structure, undefined); // none given
});

test('resolver category overrides a wrong extractor claim_type hint', () => {
  const r = buildResistanceStagingPayload({
    ...base, claim_type: 'pest_resistance', attacker_name: 'early blight', resistance_level: 'strong',
  });
  assert.equal(r.hold, false);
  assert.equal(r.payload.object_organism, 'Alternaria linariae'); // tomato early blight (host-qualified map, 2026-06-25)
  assert.equal(r.payload.interaction_type, 'disease_resistance'); // resolver wins
});

test('uncurated attacker → held, never built', () => {
  const r = buildResistanceStagingPayload({
    ...base, claim_type: 'disease_resistance', attacker_name: 'wibble blight', resistance_level: 'strong',
  });
  assert.equal(r.hold, true);
  assert.equal(r.reason, 'attacker_unresolved');
  assert.equal(r.attacker, 'wibble blight');
});

test('invalid resistance_level is nulled, claim still builds', () => {
  const r = buildResistanceStagingPayload({
    ...base, claim_type: 'disease_resistance', attacker_name: 'fusarium', resistance_level: 'banana',
  });
  assert.equal(r.hold, false);
  assert.equal(r.payload.resistance_level, null);
});
