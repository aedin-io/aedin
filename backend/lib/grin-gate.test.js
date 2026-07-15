'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { grinGate, stripQuotes } = require('./grin-gate.js');

test('stripQuotes removes surrounding straight + curly single quotes', () => {
  assert.equal(stripQuotes("'Goliath'"), 'Goliath');
  assert.equal(stripQuotes('‘Bellstar’'), 'Bellstar');
  assert.equal(stripQuotes('Cuore di Toro'), 'Cuore di Toro');
});
test('Cultivar -> promote cultivar; Landrace -> promote landrace; Cultivated material -> cultivar', () => {
  assert.deepEqual(grinGate({ plant_name: "'Goliath'", improvement_level: 'Cultivar' }), { promote: true, variety_type: 'cultivar', name: 'Goliath' });
  assert.deepEqual(grinGate({ plant_name: "'Cuore di Toro'", improvement_level: 'Landrace' }), { promote: true, variety_type: 'landrace', name: 'Cuore di Toro' });
  assert.equal(grinGate({ plant_name: "'Old Type'", improvement_level: 'Cultivated material' }).variety_type, 'cultivar');
});
test('Breeding material / blank / Uncertain / Wild -> skip', () => {
  assert.equal(grinGate({ plant_name: "'X'", improvement_level: 'Breeding material' }).promote, false);
  assert.equal(grinGate({ plant_name: "'Y'", improvement_level: '' }).promote, false);
  assert.equal(grinGate({ plant_name: "'Z'", improvement_level: 'Uncertain improvement status' }).promote, false);
  assert.equal(grinGate({ plant_name: "'W'", improvement_level: 'Wild material' }).promote, false);
});
test('name-hygiene rejects accession codes EVEN when Cultivar-tagged', () => {
  assert.equal(grinGate({ plant_name: 'T1118', improvement_level: 'Cultivar' }).reason, 'code_name');
  assert.equal(grinGate({ plant_name: 'LYC1743', improvement_level: 'Cultivar' }).reason, 'code_name');
  assert.equal(grinGate({ plant_name: 'T533', improvement_level: 'Cultivar' }).promote, false);
  assert.equal(grinGate({ plant_name: "'A'", improvement_level: 'Cultivar' }).reason, 'no_name'); // too short after strip
});
test('name-hygiene rejects HYPHENATED accession codes (EC-329392)', () => {
  assert.equal(grinGate({ plant_name: 'EC-329392', improvement_level: 'Cultivar' }).reason, 'code_name');
  assert.equal(grinGate({ plant_name: 'PI-12345', improvement_level: 'Cultivar' }).promote, false);
});
test('name-hygiene PRESERVES legitimate digit/hyphen-bearing cultivar names', () => {
  assert.equal(grinGate({ plant_name: "'Clemson Spineless 80'", improvement_level: 'Cultivar' }).promote, true);
  assert.equal(grinGate({ plant_name: "'Pusa A-4'", improvement_level: 'Cultivar' }).promote, true);
  assert.equal(grinGate({ plant_name: "'Annie Oakley II'", improvement_level: 'Cultivar' }).promote, true);
});
