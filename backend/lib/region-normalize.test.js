'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRegion, hasResolvableLocality } = require('./region-normalize');

test('canonical scope -> scopes:[it]', () => {
  assert.deepEqual(normalizeRegion('Asia'), { scopes: ['Asia'], country: null, subdivision: null, raw: 'Asia' });
});
test('coarse region -> parent canonical scopes', () => {
  assert.deepEqual(normalizeRegion('Mediterranean').scopes, ['Europe','Africa','Asia']);
  assert.deepEqual(normalizeRegion('Middle East').scopes, ['Asia']);
});
test('country -> country + scopesForCountry', () => {
  const r = normalizeRegion('Japan');
  assert.equal(r.country, 'Japan'); assert.deepEqual(r.scopes, ['Asia']); assert.equal(r.subdivision, null);
});
test('Guam territory override -> Pacific scopes', () => {
  const r = normalizeRegion('Guam');
  assert.equal(r.country, 'Guam');
  assert.deepEqual(new Set(r.scopes), new Set(['Oceania','Pacific Islands','Micronesia']));
});
test('US subdivision -> country + subdivision + scopes', () => {
  const r = normalizeRegion('California');
  assert.equal(r.country, 'United States'); assert.equal(r.subdivision, 'California');
  assert.deepEqual(r.scopes, ['North America']);
});
test('Global is recognized but filter-inert (empty scopes) and passes the gate', () => {
  assert.deepEqual(normalizeRegion('Global'), { scopes: [], country: null, subdivision: null, raw: 'Global' });
  assert.equal(hasResolvableLocality('Global'), true);
});
test('gate: coarse + country pass; gibberish fails', () => {
  assert.equal(hasResolvableLocality('Mediterranean'), true);
  assert.equal(hasResolvableLocality('Japan'), true);
  assert.equal(hasResolvableLocality('United States and east Africa'), true);
  assert.equal(hasResolvableLocality('qwerty nowhere'), false);
});
test('unrecognized -> all empty', () => {
  assert.deepEqual(normalizeRegion('qwerty'), { scopes: [], country: null, subdivision: null, raw: 'qwerty' });
});
