'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { classifyTaxonomicResolution } = require('./taxonomic-resolution');

test('binomial → species', () => {
  assert.equal(classifyTaxonomicResolution('Bactrocera dorsalis'), 'species');
  assert.equal(classifyTaxonomicResolution('Bemisia tabaci'), 'species');
  assert.equal(classifyTaxonomicResolution('Solanum lycopersicum'), 'species');
});

test('infraspecific ranks count as species-level (var./subsp./cultivar)', () => {
  assert.equal(classifyTaxonomicResolution('Solanum lycopersicum var. cerasiforme'), 'species');
  assert.equal(classifyTaxonomicResolution('Apis mellifera subsp. scutellata'), 'species');
  assert.equal(classifyTaxonomicResolution('Brassica oleracea var. capitata'), 'species');
});

test('Candidatus binomials are species-level', () => {
  assert.equal(classifyTaxonomicResolution('Candidatus Liberibacter asiaticus'), 'species');
});

test('"Genus sp." → genus_only', () => {
  assert.equal(classifyTaxonomicResolution('Bactrocera sp.'), 'genus_only');
  assert.equal(classifyTaxonomicResolution('Alternaria sp.'), 'genus_only');
  assert.equal(classifyTaxonomicResolution('Liriomyza sp'), 'genus_only'); // tolerate missing dot
});

test('bare single-token genus → genus_only', () => {
  assert.equal(classifyTaxonomicResolution('Phytophthora'), 'genus_only');
  assert.equal(classifyTaxonomicResolution('Fusarium'), 'genus_only');
});

test('explicit (genus) rank marker → genus_only', () => {
  assert.equal(classifyTaxonomicResolution('Drosophila (genus)'), 'genus_only');
});

test('"spp." → collective', () => {
  assert.equal(classifyTaxonomicResolution('Brassica spp.'), 'collective');
  assert.equal(classifyTaxonomicResolution('Bactrocera spp.'), 'collective');
});

test('explicit higher-rank parenthetical → collective', () => {
  assert.equal(classifyTaxonomicResolution('Coccinellidae (family)'), 'collective');
  assert.equal(classifyTaxonomicResolution('Coleoptera (order)'), 'collective');
  assert.equal(classifyTaxonomicResolution('Arthropoda (phylum)'), 'collective');
  assert.equal(classifyTaxonomicResolution('Angiospermae (division)'), 'collective');
  assert.equal(classifyTaxonomicResolution('Miletinae (subfamily)'), 'collective');
});

test('bare higher-rank names (suffix heuristic) → collective', () => {
  assert.equal(classifyTaxonomicResolution('Aphididae'), 'collective');   // -idae family
  assert.equal(classifyTaxonomicResolution('Fabaceae'), 'collective');    // -aceae family
  assert.equal(classifyTaxonomicResolution('Lepidoptera'), 'collective'); // -ptera order
  assert.equal(classifyTaxonomicResolution('Hymenoptera'), 'collective');
});

test('curated supra-genus names (no rank suffix) → collective', () => {
  assert.equal(classifyTaxonomicResolution('Arthropoda'), 'collective');
  assert.equal(classifyTaxonomicResolution('Insecta'), 'collective');
  assert.equal(classifyTaxonomicResolution('Mammalia'), 'collective');
  assert.equal(classifyTaxonomicResolution('Aves'), 'collective');
  assert.equal(classifyTaxonomicResolution('Mollusca'), 'collective');
  assert.equal(classifyTaxonomicResolution('Nematoda'), 'collective');
  assert.equal(classifyTaxonomicResolution('Plantae'), 'collective');
  assert.equal(classifyTaxonomicResolution('Gramineae'), 'collective'); // legacy family
  assert.equal(classifyTaxonomicResolution('Angiosperms'), 'collective');
});

test('genera that merely end in -a are NOT misfiled as collective', () => {
  assert.equal(classifyTaxonomicResolution('Salvia'), 'genus_only');
  assert.equal(classifyTaxonomicResolution('Russula'), 'genus_only');
  assert.equal(classifyTaxonomicResolution('Phytophthora'), 'genus_only');
});

test('empty / null → null (unclassifiable)', () => {
  assert.equal(classifyTaxonomicResolution(''), null);
  assert.equal(classifyTaxonomicResolution(null), null);
  assert.equal(classifyTaxonomicResolution(undefined), null);
});

test('whitespace is tolerated', () => {
  assert.equal(classifyTaxonomicResolution('  Bactrocera   dorsalis  '), 'species');
  assert.equal(classifyTaxonomicResolution('Alternaria  sp.'), 'genus_only');
});
