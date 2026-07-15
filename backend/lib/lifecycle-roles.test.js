const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inferLifecycleRoles } = require('./lifecycle-roles');

// Lepidoptera: caterpillar = herbivore, adult = nectarivore
// Biologically near-universal across moths AND butterflies; safe to apply broadly.

test('inferLifecycleRoles: Lepidoptera by taxonomy_path → herbivore + nectarivore', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Danaus plexippus',
    taxonomy_path: 'Animalia | Arthropoda | Insecta | Lepidoptera | Nymphalidae | Danaus | Danaus plexippus',
  });
  assert.deepEqual(r, { larval_role: 'herbivore', adult_role: 'nectarivore' });
});

test('inferLifecycleRoles: Lepidoptera case-insensitive taxonomy_path match', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'foo bar',
    taxonomy_path: 'animalia | arthropoda | insecta | lepidoptera | sphingidae',
  });
  assert.deepEqual(r, { larval_role: 'herbivore', adult_role: 'nectarivore' });
});

test('inferLifecycleRoles: non-Lepidoptera (beetle) returns null — too varied to guess', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Coccinella septempunctata',
    taxonomy_path: 'Animalia | Arthropoda | Insecta | Coleoptera | Coccinellidae',
  });
  assert.equal(r, null);
});

test('inferLifecycleRoles: Hymenoptera returns null — bees/wasps/ants too varied', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Apis mellifera',
    taxonomy_path: 'Animalia | Arthropoda | Insecta | Hymenoptera | Apidae | Apis | Apis mellifera',
  });
  assert.equal(r, null);
});

test('inferLifecycleRoles: plants return null', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Solanum lycopersicum',
    taxonomy_path: 'Plantae | Tracheophyta | Magnoliopsida | Solanales',
  });
  assert.equal(r, null);
});

test('inferLifecycleRoles: empty/missing fields handled', () => {
  assert.equal(inferLifecycleRoles({}), null);
  assert.equal(inferLifecycleRoles(null), null);
  assert.equal(inferLifecycleRoles({ scientific_name: 'X', taxonomy_path: '' }), null);
  assert.equal(inferLifecycleRoles({ scientific_name: 'X', taxonomy_path: null }), null);
});

// Family-only fallback: when taxonomy_path is missing but family is a known Lep family
test('inferLifecycleRoles: family-only fallback when taxonomy_path missing — Nymphalidae', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Vanessa cardui',
    taxonomy_path: null,
    family: 'Nymphalidae',
  });
  assert.deepEqual(r, { larval_role: 'herbivore', adult_role: 'nectarivore' });
});

test('inferLifecycleRoles: family-only fallback — Noctuidae (most diverse Lep family)', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Helicoverpa zea',
    taxonomy_path: null,
    family: 'Noctuidae',
  });
  assert.deepEqual(r, { larval_role: 'herbivore', adult_role: 'nectarivore' });
});

test('inferLifecycleRoles: family-only — non-Lep family returns null', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Whatever',
    taxonomy_path: null,
    family: 'Coccinellidae',
  });
  assert.equal(r, null);
});

// Saturniidae (silk moths) have non-feeding adults — surfaced by the
// agroecologist gate run as a critical correction to the blanket Lep default.
test('inferLifecycleRoles: Saturniidae adults are non-feeding (silk moths)', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Hyalophora cecropia',
    taxonomy_path: 'Animalia | Arthropoda | Insecta | Lepidoptera | Saturniidae',
    family: 'Saturniidae',
  });
  assert.deepEqual(r, { larval_role: 'herbivore', adult_role: 'non_feeding' });
});

test('inferLifecycleRoles: Bombycidae (Bombyx mori) adults non-feeding', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Bombyx mori',
    taxonomy_path: null,
    family: 'Bombycidae',
  });
  assert.deepEqual(r, { larval_role: 'herbivore', adult_role: 'non_feeding' });
});

test('inferLifecycleRoles: Lasiocampidae adults non-feeding', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Malacosoma americanum',
    taxonomy_path: null,
    family: 'Lasiocampidae',
  });
  assert.deepEqual(r.adult_role, 'non_feeding');
});

// Hymenoptera bee families: adults pollinator, larvae fed by adults
test('inferLifecycleRoles: Apidae (honey bees) → fed_by_adults / pollinator', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Apis mellifera',
    taxonomy_path: 'Animalia | Arthropoda | Insecta | Hymenoptera | Apidae',
    family: 'Apidae',
  });
  assert.deepEqual(r, { larval_role: 'fed_by_adults', adult_role: 'pollinator' });
});

test('inferLifecycleRoles: Megachilidae (leafcutter bees)', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Megachile rotundata',
    taxonomy_path: null,
    family: 'Megachilidae',
  });
  assert.deepEqual(r, { larval_role: 'fed_by_adults', adult_role: 'pollinator' });
});

test('inferLifecycleRoles: Halictidae (sweat bees)', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Halictus ligatus',
    taxonomy_path: null,
    family: 'Halictidae',
  });
  assert.deepEqual(r.adult_role, 'pollinator');
});

// Vespidae (wasps) are NOT in the bee set — should not be classified as bees.
test('inferLifecycleRoles: Vespidae (wasps) returns null — too varied to infer', () => {
  const r = inferLifecycleRoles({
    scientific_name: 'Vespula vulgaris',
    taxonomy_path: 'Animalia | Arthropoda | Insecta | Hymenoptera | Vespidae',
    family: 'Vespidae',
  });
  assert.equal(r, null);
});
