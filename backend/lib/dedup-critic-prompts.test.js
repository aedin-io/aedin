// backend/lib/dedup-critic-prompts.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { routeDedupCritic, composeDedupPrompt } = require('./dedup-critic-prompts');

test('routeDedupCritic routes by taxon / bio_category', () => {
  assert.equal(routeDedupCritic(
    { scientific_name: 'Bombus terrestris', bio_category: 'invertebrate', taxon_path: 'Animalia;Arthropoda' },
    { scientific_name: 'Bombus terestris', bio_category: 'invertebrate', taxon_path: '' }), 'entomologist');
  assert.equal(routeDedupCritic(
    { scientific_name: 'Puccinia graminis', bio_category: 'fungi', taxon_path: 'Fungi' },
    { scientific_name: 'Puccinia graminisi', bio_category: 'fungi', taxon_path: '' }), 'plant-pathologist');
  assert.equal(routeDedupCritic(
    { scientific_name: 'Citrus limon', bio_category: 'plantae', taxon_path: 'Plantae' },
    { scientific_name: 'Citrus × limon', bio_category: 'plantae', taxon_path: '' }), 'horticulturist');
  assert.equal(routeDedupCritic(
    { scientific_name: 'Passer domesticus', bio_category: 'vertebrate', taxon_path: 'Chordata' },
    { scientific_name: 'Passer domestica', bio_category: 'vertebrate', taxon_path: '' }), 'wildlife-ecologist');
  // unknown / non-plant fallback -> agroecologist (not horticulturist)
  assert.equal(routeDedupCritic(
    { scientific_name: 'Xxxx yyyy', bio_category: 'other', taxon_path: '' },
    { scientific_name: 'Xxxx yyyyz', bio_category: 'other', taxon_path: '' }), 'agroecologist');
});

test('composeDedupPrompt carries persona, the same-taxon question, the pair, and the JSON contract', () => {
  const p = composeDedupPrompt('horticulturist', {
    candidate_id: 157, a_id: 1, a_name: 'Rubus microphyllus', a_gbif: null, a_path: 'Plantae', a_claims: 3,
    b_id: 2, b_name: 'Rubus macrophyllus', b_gbif: null, b_path: 'Plantae', b_claims: 1, suggested_canonical_id: 1,
  });
  assert.equal(p.name, 'horticulturist');
  assert.match(p.systemPrompt, /horticulturist/i);
  assert.match(p.body, /same taxon or distinct/i);
  assert.match(p.body, /Rubus microphyllus/);
  assert.match(p.body, /Rubus macrophyllus/);
  assert.match(p.body, /micro-\/macro-/);                 // the meaningful-prefix caution
  assert.match(p.body, /"verdict":"same\|distinct\|uncertain"/);
  assert.match(p.body, /"candidate_id":157/);
  assert.ok(typeof p.model === 'string' && p.model.length);
});
