'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('./region-vocab');

test('CANONICAL_SCOPES has the 13 approved scopes, no fuzzy/dropped ones', () => {
  assert.equal(V.CANONICAL_SCOPES.length, 13);
  for (const s of ['Europe','Asia','Africa','North America','South America','Central America',
    'Oceania','Southeast Asia','sub-Saharan Africa','Northern Europe','Micronesia','Pacific Islands','Caribbean'])
    assert.ok(V.CANONICAL_SCOPES.includes(s), `missing ${s}`);
  for (const s of ['Mediterranean','Latin America','Middle East','Sahel','European Union','West Africa'])
    assert.ok(!V.CANONICAL_SCOPES.includes(s), `should be pruned: ${s}`);
});

test('SCOPE_COUNTRIES keys are exactly the canonical scopes', () => {
  assert.deepEqual(new Set(Object.keys(V.SCOPE_COUNTRIES)), new Set(V.CANONICAL_SCOPES));
});

test('COARSE_REGION_TO_SCOPES targets are all canonical', () => {
  for (const [coarse, parents] of Object.entries(V.COARSE_REGION_TO_SCOPES)) {
    assert.ok(parents.length, `${coarse} maps to nothing`);
    for (const p of parents) assert.ok(V.CANONICAL_SCOPES.includes(p), `${coarse}->${p} not canonical`);
  }
});

test('scopesForCountry returns every canonical scope a country belongs to', () => {
  assert.deepEqual(new Set(V.scopesForCountry('Guam')), new Set(['Oceania','Pacific Islands','Micronesia']));
  assert.deepEqual(V.scopesForCountry('Japan'), ['Asia']);
  assert.deepEqual(V.scopesForCountry('Nowhereland'), []);
});
