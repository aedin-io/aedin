'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickDomainCritic } = require('./critic-router');

test('disease_resistance routes to plant-pathologist', () => {
  assert.equal(pickDomainCritic({ interaction_category: 'disease_resistance', subject_organism: 'Solanum lycopersicum', object_organism: 'Fusarium oxysporum' }), 'plant-pathologist');
});
test('pest_resistance routes to entomologist', () => {
  assert.equal(pickDomainCritic({ interaction_category: 'pest_resistance', subject_organism: 'Solanum lycopersicum', object_organism: 'Bemisia tabaci' }), 'entomologist');
});
