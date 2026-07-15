'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveEntity } = require('./entity-resolver');

// A small in-memory taxonomy slice (what a caller passes after genus/letter blocking).
const SLICE = [
  { id: 1, scientific_name: 'Apis mellifera', common_name: 'Western honey bee', synonyms: 'Apis mellifica' },
  { id: 2, scientific_name: 'Solanum lycopersicum', common_name: 'Tomato', synonyms: 'Lycopersicon esculentum' },
  { id: 3, scientific_name: 'Bombus terrestris', common_name: 'Buff-tailed bumblebee', synonyms: null },
];

test('exact scientific_name match is verified', () => {
  const r = resolveEntity('Apis mellifera', { entities: SLICE });
  assert.equal(r.status, 'verified');
  assert.equal(r.entity_id, 1);
  assert.equal(r.matched_on, 'scientific_name');
  assert.equal(r.distance, 0);
});

test('normalized match (trademark/curly quote) is verified', () => {
  const r = resolveEntity('Tomato™', { entities: SLICE });
  assert.equal(r.status, 'verified');
  assert.equal(r.entity_id, 2);
  assert.equal(r.matched_on, 'common_name');
});

test('common_name match is verified', () => {
  const r = resolveEntity('Western honey bee', { entities: SLICE });
  assert.equal(r.status, 'verified');
  assert.equal(r.entity_id, 1);
  assert.equal(r.matched_on, 'common_name');
});

test('synonym list match is verified', () => {
  const r = resolveEntity('Lycopersicon esculentum', { entities: SLICE });
  assert.equal(r.status, 'verified');
  assert.equal(r.entity_id, 2);
  assert.equal(r.matched_on, 'synonym');
});

test('typo within Levenshtein<=2 + length-ratio<=0.20 is fuzzy_verified', () => {
  // 'Apis melliferae' -> 'Apis mellifera' is distance 1
  const r = resolveEntity('Apis melliferae', { entities: SLICE });
  assert.equal(r.status, 'fuzzy_verified');
  assert.equal(r.entity_id, 1);
  assert.equal(r.distance, 1);
});

test('the A. melliferra backlog typo is fuzzy_verified', () => {
  const r = resolveEntity('Apis melliferra', { entities: SLICE });
  assert.equal(r.status, 'fuzzy_verified');
  assert.equal(r.entity_id, 1);
});

test('far miss is unverified but records best candidate', () => {
  const r = resolveEntity('Apis dorsata', { entities: SLICE });
  assert.equal(r.status, 'unverified');
  assert.equal(r.entity_id, null);
  assert.equal(r.candidate_id, 1); // nearest by edit distance
});

test('empty / null input is unverified with no candidate', () => {
  assert.equal(resolveEntity('', { entities: SLICE }).status, 'unverified');
  assert.equal(resolveEntity(null, { entities: SLICE }).candidate_id, null);
});

test('length-ratio guard rejects short-string coincidences', () => {
  // 'cat' vs 'cot' is distance 1 but on a 3-char string ratio=0.33 > 0.20 -> not fuzzy
  const tiny = [{ id: 9, scientific_name: 'cot', common_name: null, synonyms: null }];
  const r = resolveEntity('cat', { entities: tiny });
  assert.equal(r.status, 'unverified');
});

test('matches against a pipe-delimited synonym list', () => {
  const ents = [{ id: 5, scientific_name: 'Brassica oleracea', common_name: 'Cabbage', synonyms: 'Brassica capitata | Brassica sabauda' }];
  const r = resolveEntity('Brassica sabauda', { entities: ents });
  assert.equal(r.status, 'verified');
  assert.equal(r.entity_id, 5);
  assert.equal(r.matched_on, 'synonym');
});

test('a long input fuzzy-matches a long entity name (max-len denominator)', () => {
  // 'Solanum lycopersicom' (20) vs 'Solanum lycopersicum' (20), distance 1 -> ratio 0.05 <= 0.20
  const ents = [{ id: 6, scientific_name: 'Solanum lycopersicum', common_name: null, synonyms: null }];
  const r = resolveEntity('Solanum lycopersicom', { entities: ents });
  assert.equal(r.status, 'fuzzy_verified');
  assert.equal(r.entity_id, 6);
});
