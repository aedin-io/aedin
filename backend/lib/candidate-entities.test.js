'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractBinomials, renderCandidateBlock } = require('./candidate-entities');

const ENTITIES = [
  { id: 1, scientific_name: 'Apis mellifera', common_name: 'Western honey bee', bio_category: 'invertebrate', primary_role: 'pollinator', genus: 'Apis' },
  { id: 2, scientific_name: 'Solanum lycopersicum', common_name: 'Tomato', bio_category: 'plantae', primary_role: 'crop', genus: 'Solanum' },
];

test('extractBinomials pulls Genus species patterns from text', () => {
  const text = 'We observed Apis mellifera visiting Solanum lycopersicum flowers near the plot.';
  const found = extractBinomials(text);
  assert.ok(found.includes('Apis mellifera'));
  assert.ok(found.includes('Solanum lycopersicum'));
});

test('extractBinomials dedupes and ignores sentence-initial false positives', () => {
  const text = 'The bee foraged. Apis mellifera again, Apis mellifera again.';
  const found = extractBinomials(text);
  assert.equal(found.filter(x => x === 'Apis mellifera').length, 1);
});

test('renderCandidateBlock emits compact verified candidates, capped at limit', () => {
  const text = 'Apis mellifera and Solanum lycopersicum.';
  const md = renderCandidateBlock(text, ENTITIES, 15);
  assert.match(md, /Apis mellifera · Western honey bee · invertebrate · pollinator/);
  assert.match(md, /Solanum lycopersicum · Tomato · plantae · crop/);
});

test('renderCandidateBlock returns empty string when no candidates resolve', () => {
  assert.equal(renderCandidateBlock('No binomials here at all.', ENTITIES, 15), '');
});
