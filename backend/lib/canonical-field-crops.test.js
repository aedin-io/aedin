const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isFieldCrop, fieldCropCategory, CANONICAL_FIELD_CROPS } = require('./canonical-field-crops');

test('isFieldCrop: Triticum aestivum (bread wheat) → true', () => {
  assert.equal(isFieldCrop('Triticum aestivum'), true);
});

test('isFieldCrop: Oryza sativa (rice) → true', () => {
  assert.equal(isFieldCrop('Oryza sativa'), true);
});

test('isFieldCrop: Glycine max (soybean) → true', () => {
  assert.equal(isFieldCrop('Glycine max'), true);
});

test('isFieldCrop: Helianthus annuus (sunflower) → true', () => {
  assert.equal(isFieldCrop('Helianthus annuus'), true);
});

test('isFieldCrop: Manihot esculenta (cassava) → true', () => {
  assert.equal(isFieldCrop('Manihot esculenta'), true);
});

test('isFieldCrop: variety / subspecies match via genus+species prefix', () => {
  assert.equal(isFieldCrop('Triticum aestivum subsp. compactum'), true);
});

test('isFieldCrop: Solanum lycopersicum (tomato — vegetable, not field crop) → false', () => {
  assert.equal(isFieldCrop('Solanum lycopersicum'), false);
});

test('isFieldCrop: Apis mellifera (not a plant) → false', () => {
  assert.equal(isFieldCrop('Apis mellifera'), false);
});

test('isFieldCrop: empty/null → false', () => {
  assert.equal(isFieldCrop(''), false);
  assert.equal(isFieldCrop(null), false);
});

// fieldCropCategory: returns the sub-category (cereal, legume, oilseed, root_tuber, fiber)
test('fieldCropCategory: Triticum aestivum → cereal', () => {
  assert.equal(fieldCropCategory('Triticum aestivum'), 'cereal');
});

test('fieldCropCategory: Glycine max → legume', () => {
  assert.equal(fieldCropCategory('Glycine max'), 'legume');
});

test('fieldCropCategory: Helianthus annuus → oilseed', () => {
  assert.equal(fieldCropCategory('Helianthus annuus'), 'oilseed');
});

test('fieldCropCategory: Manihot esculenta → root_tuber', () => {
  assert.equal(fieldCropCategory('Manihot esculenta'), 'root_tuber');
});

test('fieldCropCategory: Gossypium hirsutum → fiber', () => {
  assert.equal(fieldCropCategory('Gossypium hirsutum'), 'fiber');
});

test('fieldCropCategory: not in canon → null', () => {
  assert.equal(fieldCropCategory('Solanum lycopersicum'), null);
});

test('CANONICAL_FIELD_CROPS contains at least 25 species', () => {
  assert.ok(CANONICAL_FIELD_CROPS.size >= 25, `expected ≥25, got ${CANONICAL_FIELD_CROPS.size}`);
});
