'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { traitToColumn, hasCacheColumn, ALL_CACHE_TRAITS } = require('./trait-to-column');

test('traitToColumn returns matching entities column for known trait', () => {
  assert.equal(traitToColumn('ph_min'), 'ph_min');
  assert.equal(traitToColumn('thermal_min'), 'thermal_min');
  assert.equal(traitToColumn('host_range'), 'host_range');
  assert.equal(traitToColumn('voltinism'), 'voltinism');
  assert.equal(traitToColumn('bloom_months'), 'bloom_months');
});

test('traitToColumn returns null for traits with no entities column', () => {
  assert.equal(traitToColumn('nitrogen_fixation_rate_kg_per_ha_per_yr'), null);
  assert.equal(traitToColumn('target_pest_range'), null);
});

test('hasCacheColumn returns true/false consistently', () => {
  assert.equal(hasCacheColumn('thermal_min'), true);
  assert.equal(hasCacheColumn('nitrogen_fixation_rate_kg_per_ha_per_yr'), false);
});

test('ALL_CACHE_TRAITS is non-empty array of strings', () => {
  assert.ok(Array.isArray(ALL_CACHE_TRAITS));
  assert.ok(ALL_CACHE_TRAITS.length > 20);
  for (const t of ALL_CACHE_TRAITS) assert.equal(typeof t, 'string');
});
