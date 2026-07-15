'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decideFromMatch, topGroup } = require('./gbif-resolve');

const PLANT = { matchType: 'EXACT', usageKey: 1, confidence: 98, kingdom: 'Plantae', phylum: 'Tracheophyta', class: 'Magnoliopsida' };
const ANIMAL = { matchType: 'EXACT', usageKey: 2, confidence: 99, kingdom: 'Animalia', phylum: 'Mollusca', class: 'Gastropoda' };
const FUNGUS = { matchType: 'EXACT', usageKey: 3, confidence: 99, kingdom: 'Fungi', phylum: 'Basidiomycota' };
const BACTERIUM = { matchType: 'EXACT', usageKey: 4, confidence: 99, kingdom: 'Bacteria', phylum: 'Firmicutes' };
const NEMATODE = { matchType: 'EXACT', usageKey: 5, confidence: 99, kingdom: 'Animalia', phylum: 'Nematoda' };

test('accepts a confident clean match and derives bio_category', () => {
  const r = decideFromMatch(PLANT, 'plantae');
  assert.equal(r.accept, true);
  assert.equal(r.bio_category, 'plantae');
  assert.equal(r.taxonomy.kingdom, 'Plantae');
  assert.equal(r.gbif_key, 1);
});

test('abstains on matchType NONE (genus-name collision)', () => {
  const r = decideFromMatch({ matchType: 'NONE', confidence: 100 }, 'plantae');
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'no_match');
});

test('COLLISION GUARD: a plant-hint entity that matches an animal kingdom abstains', () => {
  const r = decideFromMatch(ANIMAL, 'plantae');
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'hint_contradiction');
});

test('COLLISION GUARD: a fungus-hint entity that matches an animal kingdom abstains', () => {
  assert.equal(decideFromMatch(ANIMAL, 'fungi').accept, false);
});

test('hint AGREES with kingdom → accept', () => {
  assert.equal(decideFromMatch(FUNGUS, 'fungi').accept, true);
  assert.equal(decideFromMatch(BACTERIUM, 'microbe').accept, true);
  assert.equal(decideFromMatch(NEMATODE, 'animal').bio_category, 'invertebrate');
});

test('no hint + low confidence → abstain (never guess)', () => {
  const r = decideFromMatch({ ...PLANT, confidence: 70 }, null);
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'low_confidence');
});

test('no hint + FUZZY match → abstain even at high confidence', () => {
  assert.equal(decideFromMatch({ ...PLANT, matchType: 'FUZZY' }, null).accept, false);
});

test('no hint + confident EXACT → accept', () => {
  assert.equal(decideFromMatch(PLANT, null).accept, true);
});

test('abstains when kingdom maps to "other" (incertae sedis — never downgrade)', () => {
  const r = decideFromMatch({ matchType: 'EXACT', usageKey: 9, confidence: 95, kingdom: 'incertae sedis' }, 'microbe');
  assert.equal(r.accept, false);
  assert.equal(r.reason, 'unmappable_kingdom');
});

test('topGroup collapses invertebrate/vertebrate to animal', () => {
  assert.equal(topGroup('invertebrate'), 'animal');
  assert.equal(topGroup('vertebrate'), 'animal');
  assert.equal(topGroup('plantae'), 'plantae');
});
