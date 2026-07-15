const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  bioCategoryFromOrganismType,
  primaryRoleFromOrganismType,
} = require('./organism-type');

test('bioCategoryFromOrganismType: null → other', () => {
  assert.equal(bioCategoryFromOrganismType(null), 'other');
});

test('bioCategoryFromOrganismType: undefined → other', () => {
  assert.equal(bioCategoryFromOrganismType(undefined), 'other');
});

test('bioCategoryFromOrganismType: empty string → other', () => {
  assert.equal(bioCategoryFromOrganismType(''), 'other');
});

test('bioCategoryFromOrganismType: fungus → fungi', () => {
  assert.equal(bioCategoryFromOrganismType('fungus'), 'fungi');
});

test('bioCategoryFromOrganismType: bacterium → microbe', () => {
  assert.equal(bioCategoryFromOrganismType('bacterium'), 'microbe');
});

test('bioCategoryFromOrganismType: virus → microbe', () => {
  assert.equal(bioCategoryFromOrganismType('virus'), 'microbe');
});

test('bioCategoryFromOrganismType: insect → invertebrate', () => {
  assert.equal(bioCategoryFromOrganismType('insect'), 'invertebrate');
});

test('bioCategoryFromOrganismType: mite → invertebrate', () => {
  assert.equal(bioCategoryFromOrganismType('mite'), 'invertebrate');
});

test('bioCategoryFromOrganismType: nematode → invertebrate', () => {
  assert.equal(bioCategoryFromOrganismType('nematode'), 'invertebrate');
});

test('bioCategoryFromOrganismType: mollusk → invertebrate', () => {
  assert.equal(bioCategoryFromOrganismType('mollusk'), 'invertebrate');
});

test('bioCategoryFromOrganismType: unknown string → other', () => {
  assert.equal(bioCategoryFromOrganismType('dragon'), 'other');
});

test('bioCategoryFromOrganismType: case-sensitive (capitalised → other)', () => {
  // Locks in the current case-sensitive behaviour. If we add normalisation, update.
  assert.equal(bioCategoryFromOrganismType('Fungus'), 'other');
});

test('primaryRoleFromOrganismType: null → crop', () => {
  assert.equal(primaryRoleFromOrganismType(null), 'crop');
});

test('primaryRoleFromOrganismType: undefined → crop', () => {
  assert.equal(primaryRoleFromOrganismType(undefined), 'crop');
});

test('primaryRoleFromOrganismType: empty string → crop', () => {
  assert.equal(primaryRoleFromOrganismType(''), 'crop');
});

test('primaryRoleFromOrganismType: fungus → pathogen', () => {
  assert.equal(primaryRoleFromOrganismType('fungus'), 'pathogen');
});

test('primaryRoleFromOrganismType: bacterium → pathogen', () => {
  assert.equal(primaryRoleFromOrganismType('bacterium'), 'pathogen');
});

test('primaryRoleFromOrganismType: virus → pathogen', () => {
  assert.equal(primaryRoleFromOrganismType('virus'), 'pathogen');
});

test('primaryRoleFromOrganismType: nematode → pathogen', () => {
  assert.equal(primaryRoleFromOrganismType('nematode'), 'pathogen');
});

test('primaryRoleFromOrganismType: insect → pest', () => {
  assert.equal(primaryRoleFromOrganismType('insect'), 'pest');
});

test('primaryRoleFromOrganismType: mite → pest', () => {
  assert.equal(primaryRoleFromOrganismType('mite'), 'pest');
});

test('primaryRoleFromOrganismType: mollusk → pest', () => {
  assert.equal(primaryRoleFromOrganismType('mollusk'), 'pest');
});

test('primaryRoleFromOrganismType: unknown string → pest (catch-all)', () => {
  // Any non-empty, non-pathogen string falls through to 'pest'.
  // This is a permissive default — flag it if a strict mode is added.
  assert.equal(primaryRoleFromOrganismType('dragon'), 'pest');
});
