'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  INTERACTION_CATEGORIES,
  ATTRACTOR_CATEGORIES,
  IMPACT_CLASSES,
  globiPredicateFor,
  isAttractorCategory,
  renderInteractionVocabularyMarkdown,
  reconcileVectorCategory,
} = require('./interaction-vocabulary');

test('INTERACTION_CATEGORIES contains existing + new attractor values', () => {
  for (const c of [
    'facilitation', 'mutualism', 'pollination', 'biocontrol',
    'herbivory', 'pest_pressure', 'pathogen_pressure', 'parasitism',
    'allelopathy', 'mycorrhizal', 'disease_vector',
    // new attractor categories
    'attracts_natural_enemy', 'nectar_provision', 'pollen_provision',
    'provides_alternative_prey', 'provides_refuge', 'provides_oviposition_site',
  ]) {
    assert.ok(INTERACTION_CATEGORIES.has(c), `missing category: ${c}`);
  }
});

test('ATTRACTOR_CATEGORIES is a subset of INTERACTION_CATEGORIES', () => {
  for (const c of ATTRACTOR_CATEGORIES) {
    assert.ok(INTERACTION_CATEGORIES.has(c));
  }
  assert.ok(ATTRACTOR_CATEGORIES.size === 6);
});

test('IMPACT_CLASSES = {low, moderate, high}', () => {
  assert.deepEqual([...IMPACT_CLASSES].sort(), ['high', 'low', 'moderate']);
});

test('globiPredicateFor returns canonical predicate per attractor category', () => {
  assert.equal(globiPredicateFor('nectar_provision'), 'visitsFlowersOf');
  assert.equal(globiPredicateFor('pollen_provision'), 'visitsFlowersOf');
  assert.equal(globiPredicateFor('provides_alternative_prey'), 'eatenBy');
  assert.equal(globiPredicateFor('attracts_natural_enemy'), 'mutualistOf');
  assert.equal(globiPredicateFor('provides_refuge'), 'coOccursWith');
  assert.equal(globiPredicateFor('provides_oviposition_site'), 'interactsWith');
});

test('isAttractorCategory true for new categories, false for old', () => {
  assert.equal(isAttractorCategory('nectar_provision'), true);
  assert.equal(isAttractorCategory('biocontrol'), false);
});

test('renderInteractionVocabularyMarkdown contains a row per category', () => {
  const md = renderInteractionVocabularyMarkdown();
  for (const c of INTERACTION_CATEGORIES) assert.match(md, new RegExp(c));
});

test('resistance categories are in the vocabulary', () => {
  assert.ok(INTERACTION_CATEGORIES.has('disease_resistance'));
  assert.ok(INTERACTION_CATEGORIES.has('pest_resistance'));
});

test('vocabulary markdown lists the resistance categories', () => {
  const md = renderInteractionVocabularyMarkdown();
  assert.match(md, /disease_resistance/);
  assert.match(md, /pest_resistance/);
});

test('reconcileVectorCategory: vectorOf force-fit to pathogen_pressure → disease_vector', () => {
  assert.equal(reconcileVectorCategory('pathogen_pressure', 'vectorOf'), 'disease_vector');
});

test('reconcileVectorCategory: vectorOf force-fit to pest_pressure → disease_vector', () => {
  assert.equal(reconcileVectorCategory('pest_pressure', 'vectorOf'), 'disease_vector');
});

test('reconcileVectorCategory: already disease_vector stays disease_vector', () => {
  assert.equal(reconcileVectorCategory('disease_vector', 'vectorOf'), 'disease_vector');
});

test('reconcileVectorCategory: non-vectorOf term leaves category untouched', () => {
  assert.equal(reconcileVectorCategory('pathogen_pressure', 'pathogenOf'), 'pathogen_pressure');
  assert.equal(reconcileVectorCategory('pathogen_pressure', null), 'pathogen_pressure');
  assert.equal(reconcileVectorCategory('pathogen_pressure', undefined), 'pathogen_pressure');
});

test('reconcileVectorCategory: vectorOf with an unrelated category is untouched', () => {
  assert.equal(reconcileVectorCategory('pollination', 'vectorOf'), 'pollination');
});
