'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bioCategoryFromLineage } = require('./bio-category-from-lineage');

test('kingdom-level categories', () => {
  assert.equal(bioCategoryFromLineage({ kingdom: 'Plantae' }), 'plantae');
  assert.equal(bioCategoryFromLineage({ kingdom: 'Fungi' }), 'fungi');
  assert.equal(bioCategoryFromLineage({ kingdom: 'Bacteria' }), 'microbe');
  assert.equal(bioCategoryFromLineage({ kingdom: 'Chromista' }), 'microbe');
  assert.equal(bioCategoryFromLineage({ kingdom: 'Viruses' }), 'microbe');
});
test('animalia splits vertebrate vs invertebrate', () => {
  assert.equal(bioCategoryFromLineage({ kingdom: 'Animalia', class: 'Mammalia' }), 'vertebrate');
  assert.equal(bioCategoryFromLineage({ kingdom: 'Animalia', class: 'Aves' }), 'vertebrate');
  assert.equal(bioCategoryFromLineage({ kingdom: 'Animalia', phylum: 'Chordata' }), 'vertebrate');
  assert.equal(bioCategoryFromLineage({ kingdom: 'Animalia', class: 'Insecta', phylum: 'Arthropoda' }), 'invertebrate');
});
test('unknown kingdom is other; missing fields safe', () => {
  assert.equal(bioCategoryFromLineage({ kingdom: 'Weird' }), 'other');
  assert.equal(bioCategoryFromLineage({}), 'other');
});
