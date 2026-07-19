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

// ── hasHost + pollinator: the pollinator-as-pest artifact ────────────────────
// GloBI uses `hasHost` broadly. For a bee, its "host plant" is the plant it
// FORAGES on, not one it pests. Without a pollinator guard the generic
// "invertebrate has host plant -> pest_pressure" rule turned every bee->plant
// hasHost record into a harmful pest claim (the 410-claim artifact).
const bee = { id: 10, scientific_name: 'Lasioglossum zephyrus', bio_category: 'invertebrate', family: 'Halictidae', primary_role: 'pollinator' };
const beeUnclassified = { id: 11, scientific_name: 'Andrena nasonii', bio_category: 'invertebrate', family: 'Andrenidae', primary_role: 'unclassified' };

test('hasHost: pollinator -> plant is FORAGE (pollination/beneficial), never pest_pressure', () => {
  const r = classifyTriple(bee, plant, 'hasHost');
  assert.equal(r.category, 'pollination');
  assert.equal(r.effect, 'beneficial');
});

test('hasHost: bee recognised by FAMILY even when primary_role is unclassified', () => {
  // The family-floor role work left much of the corpus 'unclassified', so the
  // guard must not depend on primary_role alone.
  const r = classifyTriple(beeUnclassified, plant, 'hasHost');
  assert.equal(r.category, 'pollination');
  assert.equal(r.effect, 'beneficial');
});

test('hasHost: a GENUINE herbivore -> plant still maps to pest_pressure (no over-correction)', () => {
  const r = classifyTriple(bug, plant, 'hasHost');
  assert.equal(r.category, 'pest_pressure');
  assert.equal(r.effect, 'harmful');
});

test('hasHost: fungal pathogen -> plant still maps to pathogen_pressure', () => {
  const fungus = { id: 12, scientific_name: 'Puccinia graminis', bio_category: 'fungi', family: 'Pucciniaceae' };
  assert.equal(classifyTriple(fungus, plant, 'hasHost').category, 'pathogen_pressure');
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
