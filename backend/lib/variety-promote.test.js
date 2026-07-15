'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVarietyName, completenessOk, dedupDecision } = require('./variety-promote.js');

test('normalizeVarietyName trims, strips trademark marks, normalizes apostrophe', () => {
  assert.equal(normalizeVarietyName("  Sungold™ "), 'Sungold');
  assert.equal(normalizeVarietyName("O'Brien"), 'O’Brien');
  assert.equal(normalizeVarietyName('Better Boy®'), 'Better Boy');
});

test('completenessOk requires a finite maturity_days', () => {
  assert.equal(completenessOk({ maturity_days: 75 }), true);
  assert.equal(completenessOk({ maturity_days: null }), false);
  assert.equal(completenessOk({ maturity_days: '' }), false);
  assert.equal(completenessOk({ yield_notes: 'high' }), false);
});

test('dedupDecision: exact match -> update', () => {
  const existing = [{ id: 5, variety_name: 'Sungold' }];
  assert.deepEqual(dedupDecision(existing, 'sungold'), { action: 'update', targetId: 5 });
});

test('dedupDecision: near-dup -> create-flag (NEVER auto-merge)', () => {
  // "Mountain Fresh" vs "Mountain Magic" are distinct cultivars; dist 5 -> NOT near -> create.
  // Use a genuine typo-distance pair to exercise the flag band: dist 1, ratio small.
  const existing = [{ id: 9, variety_name: 'Brandywine' }];
  assert.deepEqual(dedupDecision(existing, 'brandywime'), { action: 'create-flag', targetId: 9 });
});

test('dedupDecision: dissimilar -> create', () => {
  const existing = [{ id: 9, variety_name: 'Brandywine' }];
  assert.deepEqual(dedupDecision(existing, 'cherokee purple'), { action: 'create' });
});

test('dedupDecision: distinct close-but-over-threshold cultivars -> create (not flagged)', () => {
  // 'Mountain Fresh' vs 'Mountain Magic': Levenshtein 5 > 2 -> create, not flagged.
  const existing = [{ id: 1, variety_name: 'Mountain Fresh' }];
  assert.deepEqual(dedupDecision(existing, 'mountain magic'), { action: 'create' });
});
