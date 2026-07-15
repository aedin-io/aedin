'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyTriple, isGarbage } = require('./globi-classify');

const plant = { id: 1, scientific_name: 'Zea mays', bio_category: 'plantae', family: 'Poaceae' };
const bug   = { id: 2, scientific_name: 'Ostrinia nubilalis', bio_category: 'invertebrate', family: 'Crambidae' };
const wasp  = { id: 3, scientific_name: 'Trichogramma sp.', bio_category: 'invertebrate', family: 'Trichogrammatidae' };

test('herbivory: invertebrate eats plant → harmful herbivory', () => {
  const r = classifyTriple(bug, plant, 'eats');
  assert.equal(r.category, 'herbivory');
  assert.equal(r.effect, 'harmful');
});

test('biocontrol: parasitoid of invertebrate → beneficial biocontrol', () => {
  const r = classifyTriple(wasp, bug, 'parasitoidOf');
  assert.equal(r.category, 'biocontrol');
  assert.equal(r.effect, 'beneficial');
});

test('neutral co-occurrence returns null (skip)', () => {
  assert.equal(classifyTriple(plant, plant, 'adjacentTo'), null);
});

test('hasVector: plant → animal is seed/pollen dispersal, NOT disease_vector', () => {
  const bat = { id: 4, scientific_name: 'Carollia perspicillata', bio_category: 'vertebrate', family: 'Phyllostomidae' };
  const ant = { id: 5, scientific_name: 'Formica fusca', bio_category: 'invertebrate', family: 'Formicidae' };
  // frugivore/nectarivore dispersal (bat) AND myrmecochory (ant) — both dispersal, not disease.
  assert.equal(classifyTriple(plant, bat, 'hasVector').category, 'seed_dispersal');
  assert.equal(classifyTriple(plant, ant, 'hasVector').category, 'seed_dispersal');
});

test('hasVector: pathogen → arthropod is a true disease_vector', () => {
  const virus = { id: 6, scientific_name: 'Zika virus', bio_category: 'microbe', family: null };
  const mosquito = { id: 7, scientific_name: 'Aedes aegypti', bio_category: 'invertebrate', family: 'Culicidae' };
  assert.equal(classifyTriple(virus, mosquito, 'hasVector').category, 'disease_vector');
});

test('isGarbage flags genus-only + accepts binomials', () => {
  assert.equal(isGarbage('Aphis'), true);
  assert.equal(isGarbage('Apis mellifera'), false);
});
