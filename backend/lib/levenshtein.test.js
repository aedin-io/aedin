'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { levenshtein } = require('./levenshtein');

test('identical strings → 0', () => {
  assert.equal(levenshtein('Solar Fire', 'Solar Fire'), 0);
});

test('single insertion → 1', () => {
  assert.equal(levenshtein('Solar Fire', 'Solar Fires'), 1);
});

test('single deletion → 1', () => {
  assert.equal(levenshtein('Solar Fires', 'Solar Fire'), 1);
});

test('single substitution → 1', () => {
  assert.equal(levenshtein('Solar Fire', 'Polar Fire'), 1);
});

test('two-char diff → 2', () => {
  assert.equal(levenshtein('Solar Fire', 'Solbr Fyre'), 2);
});

test('common variety-spelling diffs', () => {
  assert.equal(levenshtein('cherokee purple', 'Cherokee Purple'), 2);
  assert.equal(levenshtein('Solar Fire', 'Solar Fire F1'), 3);
});

test('cap=2 returns sentinel >cap for distance 3+', () => {
  const d = levenshtein('Solar Fire', 'Pluto Crystal', 2);
  assert.ok(d > 2, `expected >2 (cap), got ${d}`);
});

test('cap=5 returns full distance when within bound', () => {
  assert.equal(levenshtein('Solar Fire', 'Solbr Fyre', 5), 2);
});

test('empty strings', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('', 'abc'), 3);
});
