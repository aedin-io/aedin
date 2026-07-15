// backend/lib/classify-taxon-role.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ct = require('../classify-taxon');

test('applyPathRules no longer asserts a kingdom/class role default', () => {
  // A fungus path with no family-rule match must NOT come back pathogen_fungal.
  const r = ct.applyPathRules('Eukaryota | Fungi | Ascomycota | Sordariomycetes');
  assert.ok(r === null || r.primary_role !== 'pathogen_fungal',
    'fungi path must not default to pathogen_fungal');
});

test('applyPathRules still matches genuine family rules', () => {
  // Coccinellidae (predatory ladybirds) is a FAMILY_RULES entry and must survive.
  const r = ct.applyPathRules('Animalia | Arthropoda | Insecta | Coleoptera | Coccinellidae');
  assert.ok(r && r.primary_role, 'family-rank role rule should still match');
});

test('getBioCategory is unchanged (taxonomic, not role)', () => {
  assert.equal(ct.getBioCategory('Eukaryota | Fungi | Ascomycota'), 'fungi');
  assert.equal(ct.getBioCategory('Plantae | Tracheophyta'), 'plantae');
});
