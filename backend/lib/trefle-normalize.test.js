'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const T = require('./trefle-normalize');
test('composeGrowthHabit: duration + habit|form', () => {
  assert.equal(T.composeGrowthHabit('Annual', 'Graminoid', 'Single Stem'), 'Annual Graminoid');
  assert.equal(T.composeGrowthHabit(null, null, 'Single Stem'), 'Single Stem');
  assert.equal(T.composeGrowthHabit(null, null, null), null);
});
test('extractFromSpecies: real Trefle record → habit, no height/root (both null there)', () => {
  const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'trefle-zea-mays.json'), 'utf8'));
  const f = T.extractFromSpecies(d);
  assert.equal(f.growth_habit, 'Graminoid');
  assert.equal(f.maximum_height_cm, undefined);
  assert.equal(f.min_root_depth_cm, undefined);
});
test('extractFromSpecies: synthetic record with cm height + root', () => {
  const f = T.extractFromSpecies({ duration: 'Perennial',
    specifications: { growth_habit: 'Tree', maximum_height: { cm: 800 }, average_height: { cm: 600 } },
    growth: { minimum_root_depth: { cm: 90 } } });
  assert.equal(f.maximum_height_cm, 800);
  assert.equal(f.min_root_depth_cm, 90);
  assert.equal(f.growth_habit, 'Perennial Tree');
});
test('extractFromSpecies: out-of-range values dropped', () => {
  const f = T.extractFromSpecies({ specifications: { maximum_height: { cm: 99999 } }, growth: { minimum_root_depth: { cm: 0 } } });
  assert.equal(f.maximum_height_cm, undefined);
  assert.equal(f.min_root_depth_cm, undefined);
});
test('matchSpecies: exact binomial or null', () => {
  const rows = [{ id: 1, scientific_name: 'Zea mays' }, { id: 2, scientific_name: 'Zea perennis' }];
  assert.equal(T.matchSpecies(rows, 'Zea mays').id, 1);
  assert.equal(T.matchSpecies(rows, 'Zea nicaraguensis'), null);
});
test('adapter shape', () => {
  assert.equal(T.adapter.name, 'trefle');
  assert.equal(T.adapter.cacheDir, 'trefle-sim-cache');
  const r = T.adapter.extract({ query_name: 'Zea mays', matched: { specifications: { growth_habit: 'Graminoid' } } });
  assert.equal(r.query_name, 'Zea mays');
  assert.equal(r.fields.growth_habit, 'Graminoid');
});
