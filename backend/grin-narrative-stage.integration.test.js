'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildResistanceStagingPayload } = require('./grin-narrative-stage');
const promote = require('./promote-staged-claims');
const { hasResolvableLocality } = require('./lib/region-normalize');
const fixture = require('./test-fixtures/grin-walter-extraction.json');

test('golden Walter narrative → resistance staging payload', () => {
  const built = buildResistanceStagingPayload(fixture[0]);
  assert.equal(built.hold, false);
  assert.equal(built.payload.object_organism, 'Fusarium oxysporum');
  assert.equal(built.payload.interaction_type, 'disease_resistance');
  assert.equal(built.payload.resistance_level, 'strong');
  assert.equal(built.payload.coevolution_structure, 'gene_for_gene');
});

test('staging payload flows through promote.mapPayloadToClaim unchanged', () => {
  const built = buildResistanceStagingPayload(fixture[0]);
  const claim = promote.mapPayloadToClaim({ target_table: 'interactions' }, built.payload);
  assert.ok(!claim.skip, `unexpected skip: ${claim.reason}`);
  assert.equal(claim.interactionCategory, 'disease_resistance');
  assert.equal(claim.effectDirection, 'beneficial');
  assert.equal(claim.resistanceLevel, 'strong');
  assert.equal(claim.coevolutionStructure, 'gene_for_gene');
});

test("regional_context 'Global' clears the promote-time locality gate", () => {
  const built = buildResistanceStagingPayload(fixture[0]);
  assert.equal(built.payload.regional_context, 'Global');
  assert.equal(hasResolvableLocality(built.payload.regional_context), true);
});
