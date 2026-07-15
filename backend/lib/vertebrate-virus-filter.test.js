const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isWildlifeVertebrateVirus } = require('./vertebrate-virus-filter');

// Wildlife host patterns (clear out-of-scope)
test('wildlife: Bat coronavirus → true', () => {
  assert.equal(isWildlifeVertebrateVirus('Bat coronavirus 1'), true);
});
test('wildlife: Bat MERS-like coronavirus → true', () => {
  assert.equal(isWildlifeVertebrateVirus('Bat MERS-like coronavirus'), true);
});
test('wildlife: Rhinolophus bat coronavirus → true (bat genus)', () => {
  assert.equal(isWildlifeVertebrateVirus('Rhinolophus bat coronavirus HKU2'), true);
});
test('wildlife: Murine coronavirus → true', () => {
  assert.equal(isWildlifeVertebrateVirus('Murine coronavirus'), true);
});

// Family-only patterns (vertebrate-only families)
test('family: Rabies lyssavirus → true', () => {
  assert.equal(isWildlifeVertebrateVirus('Rabies lyssavirus'), true);
});
test('family: Lassa mammarenavirus → true', () => {
  assert.equal(isWildlifeVertebrateVirus('Lassa mammarenavirus'), true);
});
test('family: Puumala orthohantavirus → true', () => {
  assert.equal(isWildlifeVertebrateVirus('Puumala orthohantavirus'), true);
});

// Plant/insect viruses MUST NOT be flagged
test('NOT wildlife: Tobacco mosaic virus → false (plant pathogen)', () => {
  assert.equal(isWildlifeVertebrateVirus('Tobacco mosaic virus'), false);
});
test('NOT wildlife: Citrus tristeza virus → false (plant)', () => {
  assert.equal(isWildlifeVertebrateVirus('Citrus tristeza virus'), false);
});
test('NOT wildlife: Helicoverpa armigera nucleopolyhedrovirus → false (entomopathogen)', () => {
  assert.equal(isWildlifeVertebrateVirus('Helicoverpa armigera nucleopolyhedrovirus'), false);
});
test('NOT wildlife: Begomovirus muntiflavi → false (plant pathogen)', () => {
  assert.equal(isWildlifeVertebrateVirus('Begomovirus muntiflavi'), false);
});

// Non-virus entities never match
test('NOT virus: Apis mellifera → false (not a virus name)', () => {
  assert.equal(isWildlifeVertebrateVirus('Apis mellifera'), false);
});
test('NOT virus: empty/null → false', () => {
  assert.equal(isWildlifeVertebrateVirus(''), false);
  assert.equal(isWildlifeVertebrateVirus(null), false);
});
