'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const U = require('./usda-normalize');
test('feet/inch conversions', () => {
  assert.equal(U.feetToCm(8.0), 243.8); assert.equal(U.inchesToCm(8), 20.3); assert.equal(U.feetToCm('x'), null);
});
test('parseHeightFeet rejects blank/zero/nonnumeric, sanity floor', () => {
  assert.equal(U.parseHeightFeet(''), null); assert.equal(U.parseHeightFeet('0'), null);
  assert.equal(U.parseHeightFeet('n/a'), null); assert.equal(U.parseHeightFeet('8.0'), 243.8);
  assert.equal(U.parseHeightFeet('0.05'), null);
});
test('parseRootDepthInches converts + guards', () => {
  assert.equal(U.parseRootDepthInches('8'), 20.3); assert.equal(U.parseRootDepthInches('0'), null);
});
test('composeGrowthHabit: first duration + first (primary) habit only', () => {
  assert.equal(U.composeGrowthHabit(['Annual'], ['Graminoid']), 'Annual Graminoid');
  assert.equal(U.composeGrowthHabit([], []), null);
  // USDA lists the primary habit first; a multi-habit forb+subshrub must read as a forb/herb, not a shrub
  assert.equal(U.composeGrowthHabit(['Annual', 'Perennial'], ['Forb/herb', 'Subshrub']), 'Annual Forb/herb');
});
test('binomial strips markup/author; varietal→species', () => {
  assert.equal(U.binomial('<i>Zea mays</i> L.'), 'zea mays');
  assert.equal(U.binomial('Apium graveolens var. dulce'), 'apium graveolens');
});
test('extractSimFields from real USDA record', () => {
  const recs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'usda-corn-characteristics.json'), 'utf8'));
  const f = U.extractSimFields(recs);
  assert.equal(f.maximum_height_cm, 243.8); assert.equal(f.min_root_depth_cm, 20.3);
});
test('matchAccepted exact/null-on-ambiguity', () => {
  const rows = [{ Plant: { Id: 1, AcceptedId: 1, ScientificName: '<i>Zea mays</i> L.', AcceptedScientificName: '<i>Zea mays</i> L.' } }];
  assert.equal(U.matchAccepted(rows, 'Zea mays').Id, 1);
  assert.equal(U.matchAccepted(rows, 'Zea perennis'), null);
  const amb = [
    { Plant: { Id: 2, AcceptedId: 2, ScientificName: 'Chloris gayana', AcceptedScientificName: 'Chloris gayana' } },
    { Plant: { Id: 3, AcceptedId: 3, ScientificName: 'Chloris gayana', AcceptedScientificName: 'Chloris gayana' } },
  ];
  assert.equal(U.matchAccepted(amb, 'Chloris gayana'), null);
});
test('matchAccepted prefers the bare species over infraspecific taxa (same binomial)', () => {
  // USDA returns AcceptedId=0 for all rows + species + its subspecies sharing the binomial.
  const rows = [
    { Plant: { Id: 1, AcceptedId: 0, ScientificName: '<i>Zea mays</i> L. ssp. <i>everta</i> (Sturtev.) Zhuk.' } },
    { Plant: { Id: 2, AcceptedId: 0, ScientificName: '<i>Zea mays</i> L.' } },
    { Plant: { Id: 3, AcceptedId: 0, ScientificName: '<i>Zea mays</i> L. ssp. <i>mays</i>' } },
  ];
  assert.equal(U.matchAccepted(rows, 'Zea mays').Id, 2); // the bare species
});
test('adapter.extract composes fields + habit', () => {
  const recs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'usda-corn-characteristics.json'), 'utf8'));
  const r = U.adapter.extract({ query_name: 'Zea mays', characteristics: recs, matched: { Durations: ['Annual'], GrowthHabits: ['Graminoid'] } });
  assert.equal(r.query_name, 'Zea mays');
  assert.equal(r.fields.maximum_height_cm, 243.8);
  assert.equal(r.fields.growth_habit, 'Annual Graminoid');
  assert.equal(U.adapter.name, 'usda');
});
test('extractServiceFields pulls categorical + pH from the real corn record', () => {
  const recs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'usda-corn-characteristics.json'), 'utf8'));
  const f = U.extractServiceFields(recs);
  assert.equal(f.nitrogen_fixation, 'none');
  assert.equal(f.cn_ratio, 'medium');
  assert.equal(f.growth_rate, 'rapid');
  assert.equal(f.fertility_requirement, 'high');
  assert.equal(f.anaerobic_tolerance, 'none');
  assert.equal(f.caco3_tolerance, 'medium');
  assert.equal(f.salinity_tolerance, 'low');
  assert.equal(f.drought_tolerance, 'low');
  assert.equal(f.moisture_use, 'high');
  assert.equal(f.soil_texture_adaptation, 'medium'); // only Medium=Yes
  assert.equal(f.optimal_ph_min, 5.5);
  assert.equal(f.optimal_ph_max, 7.5);
});
test('adapter.extract now includes the service + tolerance fields', () => {
  const recs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', 'usda-corn-characteristics.json'), 'utf8'));
  const r = U.adapter.extract({ query_name: 'Zea mays', characteristics: recs, matched: { Durations: ['Annual'], GrowthHabits: ['Graminoid'] } });
  assert.equal(r.fields.maximum_height_cm, 243.8); // existing still works
  assert.equal(r.fields.growth_rate, 'rapid');
  assert.equal(r.fields.cn_ratio, 'medium');
  assert.equal(r.fields.soil_texture_adaptation, 'medium');
});
