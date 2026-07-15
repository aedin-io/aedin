'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  expectedKingdomForGenus, phylumKingdom, detectCorruptionCandidate,
} = require('./phylum-validator');

test('expectedKingdomForGenus reads the curated genus, kingdom-agnostic of case', () => {
  assert.equal(expectedKingdomForGenus('Ficus variegata'), 'plantae');
  assert.equal(expectedKingdomForGenus('Cyathus striatus'), 'fungi');
  assert.equal(expectedKingdomForGenus('Bacillus thuringiensis'), 'bacteria');
  assert.equal(expectedKingdomForGenus('Aulacophora indica'), null, 'uncurated genus → null');
});

test('phylumKingdom maps stored phylum to its kingdom group', () => {
  assert.equal(phylumKingdom('Mollusca'), 'animal');
  assert.equal(phylumKingdom('Arthropoda'), 'animal');
  assert.equal(phylumKingdom('Tracheophyta'), 'plantae');
  assert.equal(phylumKingdom('Ascomycota'), 'fungi');
  assert.equal(phylumKingdom('Whoknowsophyta'), null);
});

test('documented corruption cases are raised as candidates', () => {
  // Ficus the fig stored in the gastropod phylum.
  assert.deepEqual(
    detectCorruptionCandidate({ scientific_name: 'Ficus variegata', phylum: 'Mollusca' }),
    { expectedKingdom: 'plantae', storedKingdom: 'animal', genus: 'ficus' }
  );
  // Cyathus the bird's-nest fungus stored in Arthropoda.
  assert.equal(detectCorruptionCandidate({ scientific_name: 'Cyathus striatus', phylum: 'Arthropoda' }).expectedKingdom, 'fungi');
  // Uredo the rust stored in a plant phylum (the documented reverse case).
  assert.equal(detectCorruptionCandidate({ scientific_name: 'Uredo abietina', phylum: 'Tracheophyta' }).storedKingdom, 'plantae');
});

test('correct taxonomy is NOT a candidate', () => {
  assert.equal(detectCorruptionCandidate({ scientific_name: 'Rhizophagus irregularis', phylum: 'Glomeromycota' }), null);
  assert.equal(detectCorruptionCandidate({ scientific_name: 'Trichoderma harzianum', phylum: 'Ascomycota' }), null);
  assert.equal(detectCorruptionCandidate({ scientific_name: 'Ficus carica', phylum: 'Tracheophyta' }), null);
});

test('collision FALSE POSITIVE is raised by the name (context must filter it downstream)', () => {
  // Rhizophagus is in FUNGAL_GENERA, but Rhizophagus dispar is a real BEETLE.
  // The lib raises it (expected fungi vs stored animal); the report-script context
  // check (animal-role claims present) is what downgrades it. Asserting the lib's
  // intended behavior so the inversion contract is explicit.
  const c = detectCorruptionCandidate({ scientific_name: 'Rhizophagus dispar', phylum: 'Arthropoda' });
  assert.equal(c.expectedKingdom, 'fungi');
  assert.equal(c.storedKingdom, 'animal');
});

test('unknown genus or unrecognized phylum → not a candidate', () => {
  assert.equal(detectCorruptionCandidate({ scientific_name: 'Aulacophora indica', phylum: 'Arthropoda' }), null);
  assert.equal(detectCorruptionCandidate({ scientific_name: 'Ficus variegata', phylum: null }), null);
});
