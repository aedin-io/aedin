const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inferCategoryFromName } = require('./entity-name-classification');

test('inferCategoryFromName: plant virus suffix → microbe / phytopathogen_viral', () => {
  assert.deepEqual(
    inferCategoryFromName('Tobacco mosaic virus'),
    { bio_category: 'microbe', primary_role: 'phytopathogen_viral' }
  );
});

test('inferCategoryFromName: nucleopolyhedrovirus → entomopathogen_viral (insect biocontrol)', () => {
  assert.deepEqual(
    inferCategoryFromName('Helicoverpa armigera nucleopolyhedrovirus'),
    { bio_category: 'microbe', primary_role: 'entomopathogen_viral' }
  );
});

test('inferCategoryFromName: granulovirus → entomopathogen_viral', () => {
  assert.deepEqual(
    inferCategoryFromName('Artogeia rapae granulovirus'),
    { bio_category: 'microbe', primary_role: 'entomopathogen_viral' }
  );
});

test('inferCategoryFromName: rhabdovirus → phytopathogen_viral (plant pathogen, plant family Rhabdoviridae)', () => {
  assert.deepEqual(
    inferCategoryFromName('Cynara cardunculus rhabdovirus'),
    { bio_category: 'microbe', primary_role: 'phytopathogen_viral' }
  );
});

test('inferCategoryFromName: tobamovirus → phytopathogen_viral', () => {
  assert.deepEqual(
    inferCategoryFromName('Tobamovirus tabaci'),
    { bio_category: 'microbe', primary_role: 'phytopathogen_viral' }
  );
});

test('inferCategoryFromName: begomovirus → phytopathogen_viral', () => {
  assert.deepEqual(
    inferCategoryFromName('Begomovirus muntiflavi'),
    { bio_category: 'microbe', primary_role: 'phytopathogen_viral' }
  );
});

test('inferCategoryFromName: generic "Tobacco mosaic virus" → phytopathogen_viral', () => {
  assert.deepEqual(
    inferCategoryFromName('Tobacco mosaic virus'),
    { bio_category: 'microbe', primary_role: 'phytopathogen_viral' }
  );
});

test('inferCategoryFromName: ambiguous virus name (no known suffix) → generic pathogen_viral fallback', () => {
  assert.deepEqual(
    inferCategoryFromName('Foo bar virus'),
    { bio_category: 'microbe', primary_role: 'pathogen_viral' }
  );
});

test('inferCategoryFromName: bacteriophage suffix → microbe / pathogen_viral', () => {
  assert.deepEqual(
    inferCategoryFromName('Lambda bacteriophage'),
    { bio_category: 'microbe', primary_role: 'pathogen_viral' }
  );
});

test('inferCategoryFromName: phage at end → microbe / pathogen_viral', () => {
  assert.deepEqual(
    inferCategoryFromName('Escherichia coli phage T4'),
    { bio_category: 'microbe', primary_role: 'pathogen_viral' }
  );
});

test('inferCategoryFromName: viroid → microbe / pathogen_viral', () => {
  assert.deepEqual(
    inferCategoryFromName('Potato spindle tuber viroid'),
    { bio_category: 'microbe', primary_role: 'pathogen_viral' }
  );
});

test('inferCategoryFromName: insect species → null (no inference)', () => {
  assert.equal(inferCategoryFromName('Apis mellifera'), null);
});

test('inferCategoryFromName: plant species → null (no inference)', () => {
  assert.equal(inferCategoryFromName('Solanum lycopersicum'), null);
});

test('inferCategoryFromName: empty string → null', () => {
  assert.equal(inferCategoryFromName(''), null);
});

test('inferCategoryFromName: null/undefined → null', () => {
  assert.equal(inferCategoryFromName(null), null);
  assert.equal(inferCategoryFromName(undefined), null);
});

// Boundary guard: "virus" is only a virus when it's a complete word (or word-suffix).
// "Viruslike" lacks a word boundary after "virus" so should NOT match — otherwise we'd
// false-positive on "viruslike particle" or hypothetical genera.
test('inferCategoryFromName: "Viruslike" (no word boundary) → null', () => {
  assert.equal(inferCategoryFromName('Viruslike particle'), null);
});

// Detection should be case-insensitive.
test('inferCategoryFromName: "TOBACCO MOSAIC VIRUS" (uppercase) → microbe / phytopathogen_viral', () => {
  assert.deepEqual(
    inferCategoryFromName('TOBACCO MOSAIC VIRUS'),
    { bio_category: 'microbe', primary_role: 'phytopathogen_viral' }
  );
});
