// backend/lib/coarse-rank-audit.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isCoarseRoleRule, COARSE_TAXA } = require('./coarse-rank-audit');

test('bio_category_default rows are always coarse', () => {
  for (const v of ['fungi', 'invertebrate', 'plantae', 'microbe', 'vertebrate']) {
    assert.equal(isCoarseRoleRule({ rule_type: 'bio_category_default', match_value: v }), true);
  }
});

test('coarse taxonomy_class rows (kingdom/phylum/class/order) are coarse', () => {
  for (const v of ['fungi', 'mycota', 'oomycota', 'plantae', 'viridiplantae', 'insecta',
    'hexapoda', 'lepidoptera', 'diptera', 'coleoptera', 'hemiptera', 'araneae', 'acari',
    'arachnida', 'nematoda', 'bacteria', 'mammalia', 'aves', 'vertebrata']) {
    assert.equal(isCoarseRoleRule({ rule_type: 'taxonomy_class', match_value: v }), true, v);
  }
});

test('genuine family-rank taxonomy_class row (formicidae) is KEPT', () => {
  assert.equal(isCoarseRoleRule({ rule_type: 'taxonomy_class', match_value: 'formicidae' }), false);
});

test('specific rules (species/genus/family/biocontrol_family) are never coarse', () => {
  assert.equal(isCoarseRoleRule({ rule_type: 'taxonomy_genus', match_value: 'trichoderma' }), false);
  assert.equal(isCoarseRoleRule({ rule_type: 'taxonomy_family', match_value: 'coccinellidae' }), false);
  assert.equal(isCoarseRoleRule({ rule_type: 'biocontrol_family', match_value: 'aphelinidae' }), false);
  assert.equal(isCoarseRoleRule({ rule_type: 'taxonomy_species', match_value: 'apis mellifera' }), false);
});

test('COARSE_TAXA excludes formicidae', () => {
  assert.equal(COARSE_TAXA.has('formicidae'), false);
});
