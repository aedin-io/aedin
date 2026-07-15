'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildInteractionTuple } = require('./globi-row-map');

// A GloBI CSV row with a location and full citation metadata.
const baseRow = {
  sourceTaxonName: 'Apis mellifera',
  sourceTaxonPathNames: 'Animalia | Arthropoda',
  targetTaxonName: 'Zea mays',
  targetTaxonPathNames: 'Plantae | Poaceae',
  interactionTypeName: 'visitsFlowersOf',
  decimalLatitude: '40.1',
  decimalLongitude: '-88.2',
  localityName: 'Illinois, USA',
  referenceCitation: 'Smith, J. (1999). Bee foraging. J. Apic. 12:3.',
  referenceDoi: '10.1234/abc',
  referenceUrl: 'https://doi.org/10.1234/abc',
  sourceCitation: 'USDA Pollinator Dataset',
};

test('captures citation fields into the tuple (29 fields)', () => {
  const t = buildInteractionTuple(baseRow);
  assert.ok(t, 'expected a tuple');
  assert.equal(t.length, 29);
  // 0-11: [sName, sPath, tName, tPath, iType, lat, lng, loc, refCit, refDoi, refUrl, srcCit]
  assert.equal(t[0], 'Apis mellifera');
  assert.equal(t[2], 'Zea mays');
  assert.equal(t[4], 'visitsFlowersOf');
  assert.equal(t[8], 'Smith, J. (1999). Bee foraging. J. Apic. 12:3.');
  assert.equal(t[9], '10.1234/abc');
  assert.equal(t[10], 'https://doi.org/10.1234/abc');
  assert.equal(t[11], 'USDA Pollinator Dataset');
});

test('drops refuted interactions (argumentTypeId contains refute)', () => {
  const refuted = { ...baseRow, argumentTypeId: 'https://en.wiktionary.org/wiki/refute' };
  assert.equal(buildInteractionTuple(refuted), null);
  // supports / absent argumentTypeId is kept
  assert.ok(buildInteractionTuple({ ...baseRow, argumentTypeId: 'https://en.wiktionary.org/wiki/support' }));
  assert.ok(buildInteractionTuple(baseRow));
});

test('captures taxon IDs, life stage, event date, and pre-split lineage', () => {
  const rich = {
    ...baseRow,
    sourceTaxonIds: 'GBIF:1346127 | NCBI:2610089 | WD:Q10803783',
    targetTaxonIds: 'GBIF:2705176',
    sourceLifeStageName: 'post-juvenile adult stage',
    targetLifeStageName: 'seedling',
    eventDate: '2005-11-01T00:00:00Z',
    sourceTaxonGenusName: 'Apis', sourceTaxonFamilyName: 'Apidae',
    sourceTaxonOrderName: 'Hymenoptera', sourceTaxonClassName: 'Insecta',
    sourceTaxonPhylumName: 'Arthropoda', sourceTaxonKingdomName: 'Animalia',
    targetTaxonGenusName: 'Zea', targetTaxonFamilyName: 'Poaceae',
    targetTaxonOrderName: 'Poales', targetTaxonClassName: 'Liliopsida',
    targetTaxonPhylumName: 'Tracheophyta', targetTaxonKingdomName: 'Plantae',
  };
  const t = buildInteractionTuple(rich);
  // 12-16: taxon ids (source,target), life stage (source,target), event date
  assert.equal(t[12], 'GBIF:1346127 | NCBI:2610089 | WD:Q10803783');
  assert.equal(t[13], 'GBIF:2705176');
  assert.equal(t[14], 'post-juvenile adult stage');
  assert.equal(t[15], 'seedling');
  assert.equal(t[16], '2005-11-01T00:00:00Z');
  // 17-22: source genus/family/order/class/phylum/kingdom
  assert.deepEqual(t.slice(17, 23), ['Apis', 'Apidae', 'Hymenoptera', 'Insecta', 'Arthropoda', 'Animalia']);
  // 23-28: target genus/family/order/class/phylum/kingdom
  assert.deepEqual(t.slice(23, 29), ['Zea', 'Poaceae', 'Poales', 'Liliopsida', 'Tracheophyta', 'Plantae']);
});

test('new fields default to null when absent', () => {
  const t = buildInteractionTuple(baseRow);
  for (let i = 12; i < 29; i++) assert.equal(t[i], null, `field ${i} should be null`);
});

test('returns null when source or target name missing/no name', () => {
  assert.equal(buildInteractionTuple({ ...baseRow, sourceTaxonName: '' }), null);
  assert.equal(buildInteractionTuple({ ...baseRow, targetTaxonName: 'no name' }), null);
});

test('accepts biocontrol types even without a location', () => {
  const noLoc = { ...baseRow, interactionTypeName: 'parasiteOf',
    decimalLatitude: '', decimalLongitude: '', localityName: '' };
  assert.ok(buildInteractionTuple(noLoc), 'biocontrol type should be kept without location');
});

test('skips non-biocontrol rows that have no location', () => {
  const noLoc = { ...baseRow, decimalLatitude: '', decimalLongitude: '', localityName: '' };
  assert.equal(buildInteractionTuple(noLoc), null);
});

test('missing citation fields become null, not undefined', () => {
  const t = buildInteractionTuple({ ...baseRow, referenceDoi: undefined, referenceUrl: '' });
  assert.equal(t[9], null);
  assert.equal(t[10], null);
});
