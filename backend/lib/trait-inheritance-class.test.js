'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inheritanceClass } = require('./trait-inheritance-class.js');

test('plant: envelope conserved, phenology/organ divergent', () => {
  assert.equal(inheritanceClass('plantae', 'ph_min'), 'conserved');
  assert.equal(inheritanceClass('plantae', 'optimal_temp_min'), 'conserved');
  assert.equal(inheritanceClass('plantae', 'nitrogen_fixation'), 'conserved');
  assert.equal(inheritanceClass('plantae', 'days_to_harvest'), 'divergent');
  assert.equal(inheritanceClass('plantae', 'toxicity'), 'divergent');
});
test('universal: host_range divergent in every kingdom', () => {
  assert.equal(inheritanceClass('plantae', 'host_range'), 'divergent');
  assert.equal(inheritanceClass('fungi', 'host_range'), 'divergent');
  assert.equal(inheritanceClass('microbe', 'host_range'), 'divergent');
});
test('fungi: growth-temp + role conserved, fungicide/host divergent', () => {
  assert.equal(inheritanceClass('fungi', 'optimal_temp_min'), 'conserved');
  assert.equal(inheritanceClass('fungi', 'primary_role'), 'conserved');
  assert.equal(inheritanceClass('fungi', 'pest_mobility'), 'divergent'); // not listed conserved -> fail-closed
});
test('fail-closed: deferred kingdom + unknown trait -> divergent', () => {
  assert.equal(inheritanceClass('vertebrate', 'optimal_temp_min'), 'divergent'); // deferred column
  assert.equal(inheritanceClass('plantae', 'some_uncurated_trait'), 'divergent'); // unknown -> divergent
});
