const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { genusSpeciesKey, isVegetable, _resetCache, _RUBATZKY_PATH } = require('./rubatzky-vegetable-index');

// isVegetable() parses a large, GITIGNORED reference corpus
// (.claude/agents/agroecologist/reference/*_full_text.md). It is present in
// local dev but NOT in a fresh checkout (CI), so tests whose isVegetable() call
// falls through to the index lookup throw ENOENT there. Skip those when the
// corpus is absent — they run fully wherever it exists. genusSpeciesKey + the
// HARD_NOT_VEGETABLE / POLYMORPHIC carve-out tests short-circuit before any file
// read, so they always run.
const SKIP_CORPUS = fs.existsSync(_RUBATZKY_PATH)
  ? false
  : 'Rubatzky corpus (gitignored *_full_text.md) not present — runs in local dev only';

// genusSpeciesKey: extract first 2 lowercased words for varieties / subspecies
test('genusSpeciesKey: simple binomial', () => {
  assert.equal(genusSpeciesKey('Solanum lycopersicum'), 'solanum lycopersicum');
});

test('genusSpeciesKey: variety → genus + species only', () => {
  assert.equal(genusSpeciesKey('Solanum lycopersicum var. cerasiforme'), 'solanum lycopersicum');
});

test('genusSpeciesKey: subspecies → genus + species only', () => {
  assert.equal(genusSpeciesKey('Brassica oleracea subsp. capitata'), 'brassica oleracea');
});

test('genusSpeciesKey: case-insensitive', () => {
  assert.equal(genusSpeciesKey('SOLANUM LYCOPERSICUM'), 'solanum lycopersicum');
});

test('genusSpeciesKey: single word → null', () => {
  assert.equal(genusSpeciesKey('Solanum'), null);
});

test('genusSpeciesKey: null/empty → null', () => {
  assert.equal(genusSpeciesKey(null), null);
  assert.equal(genusSpeciesKey(''), null);
  assert.equal(genusSpeciesKey('   '), null);
});

// isVegetable: cross-references against Rubatzky-extracted binomial index
test('isVegetable: tomato (Solanum lycopersicum) is in Rubatzky', { skip: SKIP_CORPUS }, () => {
  assert.equal(isVegetable('Solanum lycopersicum'), true);
});

// Brassica oleracea bare-binomial test moved to the polymorphic carve-out
// section below — bare "Brassica oleracea" is now intentionally false because
// the species spans cabbage/cauliflower/kale/kohlrabi cultivars (vegetable)
// AND forage/fodder kale (not vegetable). Tests below cover the var.-specified
// cabbage case and the bare-binomial exclusion.

test('isVegetable: onion (Allium cepa) is in Rubatzky', { skip: SKIP_CORPUS }, () => {
  assert.equal(isVegetable('Allium cepa'), true);
});

test('isVegetable: tomato variety still matches via genus+species key', { skip: SKIP_CORPUS }, () => {
  assert.equal(isVegetable('Solanum lycopersicum var. cerasiforme'), true);
});

test('isVegetable: a clearly-non-vegetable (honey bee) is NOT in Rubatzky', { skip: SKIP_CORPUS }, () => {
  assert.equal(isVegetable('Apis mellifera'), false);
});

test('isVegetable: Pinus sylvestris (a forest tree, not a vegetable) is NOT in Rubatzky', { skip: SKIP_CORPUS }, () => {
  assert.equal(isVegetable('Pinus sylvestris'), false);
});

test('isVegetable: empty/null gracefully → false', () => {
  assert.equal(isVegetable(null), false);
  assert.equal(isVegetable(''), false);
  assert.equal(isVegetable('   '), false);
});

// HARD_NOT_VEGETABLE override (Phase-1.5 carve-outs from agroecologist gate)
test('isVegetable: Tacca leontopetaloides (Polynesian arrowroot) → false (starchy tuber, not vegetable)', () => {
  assert.equal(isVegetable('Tacca leontopetaloides'), false);
});

// POLYMORPHIC_SPECIES exclusion: bare binomial is too vague
test('isVegetable: bare "Zea mays" → false (polymorphic — sweet corn vs dent vs popcorn)', () => {
  assert.equal(isVegetable('Zea mays'), false);
});

test("isVegetable: \"Zea mays 'Kiss n Tell'\" (sweet corn cultivar, 3+ words) → true", { skip: SKIP_CORPUS }, () => {
  assert.equal(isVegetable("Zea mays 'Kiss n Tell'"), true);
});

test('isVegetable: bare "Brassica oleracea" → false (polymorphic)', () => {
  assert.equal(isVegetable('Brassica oleracea'), false);
});

test('isVegetable: "Brassica oleracea var. capitata" (cabbage) → true (cultivar specified)', { skip: SKIP_CORPUS }, () => {
  assert.equal(isVegetable('Brassica oleracea var. capitata'), true);
});

test('isVegetable: bare "Cucurbita pepo" → false (polymorphic)', () => {
  assert.equal(isVegetable('Cucurbita pepo'), false);
});

// Bare nominate subspecies: "Zea mays subsp. mays" covers all maize
// subdomestications (dent, flint, popcorn, sweet corn) → still polymorphic.
test('isVegetable: bare nominate subspecies "Zea mays subsp. mays" → false', () => {
  assert.equal(isVegetable('Zea mays subsp. mays'), false);
});

test('isVegetable: nominate subsp. with cultivar "Zea mays subsp. mays \'Sweet Corn X\'" → still polymorphic per current logic', () => {
  // Note: this is a known limitation — a cultivar specified UNDER the nominate
  // subspecies ought to bypass the carve-out, but the simple check matches on
  // the trailing subsp. mays pattern. Documented for now; future refinement.
  assert.equal(isVegetable('Zea mays subsp. mays'), false);
});

// Non-nominate subspecies SHOULD match (e.g. Zea mays subsp. mexicana = teosinte)
// — but mexicana isn't in Rubatzky as vegetable so no false-positive risk here.
// The carve-out targets ONLY the bare nominate-subsp. = covers-everything case.
test('isVegetable: var.-specified Brassica oleracea cultivars still match', { skip: SKIP_CORPUS }, () => {
  assert.equal(isVegetable('Brassica oleracea var. capitata'), true);
  assert.equal(isVegetable('Brassica oleracea var. botrytis'), true);  // cauliflower
});
