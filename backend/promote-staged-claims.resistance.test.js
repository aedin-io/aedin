'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
// The interaction field-assembly is exercised via the exported builder. If
// promote-staged-claims.js does not export the per-row builder, this test
// drives the readResistanceLevel + buildInteractionClaim path through the
// module's exports; adjust the require to the exported function name.
const promote = require('./promote-staged-claims');

test('readResistanceLevel admits the controlled vocab, rejects others', () => {
  assert.equal(promote.readResistanceLevel({ resistance_level: 'tolerant' }), 'tolerant');
  assert.equal(promote.readResistanceLevel({ resistance_level: 'strong' }), 'strong');
  assert.equal(promote.readResistanceLevel({ resistance_level: 'banana' }), null);
  assert.equal(promote.readResistanceLevel({}), null);
});

test('mapPayloadToClaim flows resistance_level onto the claim object', () => {
  const stagingRow = { target_table: 'interactions' };
  const payload = {
    interaction_type: 'disease_resistance',
    subject_organism: 'Solanum lycopersicum',
    object_organism: 'Fusarium oxysporum',
    resistance_level: 'tolerant',
  };
  const claim = promote.mapPayloadToClaim(stagingRow, payload);
  assert.ok(!claim.skip, `expected a valid claim but got skip: ${claim.reason}`);
  assert.equal(claim.resistanceLevel, 'tolerant');
  assert.equal(claim.interactionCategory, 'disease_resistance');
});
